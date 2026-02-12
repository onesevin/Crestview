// src/app/dashboard/page.tsx
'use client';

import { useState, useEffect, useRef } from 'react';
import { supabase } from '@/lib/supabase';
import { Task, Schedule, ScheduleItem } from '@/types';
import { format, addDays, subDays, startOfWeek, isWeekend, isToday } from 'date-fns';
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  useSensor,
  useSensors,
  pointerWithin,
  type DragStartEvent,
  type DragEndEvent,
} from '@dnd-kit/core';
import { SortableContext, arrayMove, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { TASK_LIST_ITEM, SCHEDULE_ITEM, SCHEDULE_DROP_ZONE, WEEK_DAY_PREFIX } from '@/lib/dnd-constants';
import TaskCard from '@/components/TaskCard';
import ScheduleItemCard from '@/components/ScheduleItemCard';
import WeekDayButton from '@/components/WeekDayButton';
import ScheduleDropZone from '@/components/ScheduleDropZone';
import DragOverlayContent from '@/components/DragOverlayContent';

export default function Dashboard() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [currentSchedule, setCurrentSchedule] = useState<Schedule | null>(null);
  const [selectedDate, setSelectedDate] = useState(new Date());
  const [taskInput, setTaskInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [user, setUser] = useState<any>(null);
  const [workHours, setWorkHours] = useState<Record<string, number>>({});
  const [editingTaskId, setEditingTaskId] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState('');
  const [rolloverNotification, setRolloverNotification] = useState<{
    count: number;
    taskTitles: string[];
    rolledBackIds: string[];
    autoAdded: number;
    autoAddedItemIds: string[];
  } | null>(null);
  const [patterns, setPatterns] = useState<any[]>([]);
  const [activeItem, setActiveItem] = useState<{
    type: string;
    task?: Task;
    item?: ScheduleItem;
  } | null>(null);

  const busyRef = useRef(false);

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 8 },
    })
  );

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      setUser(session?.user);
    });

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, session) => {
      setUser(session?.user);
    });

    return () => subscription.unsubscribe();
  }, []);

  useEffect(() => {
    if (user) {
      loadPendingTasks();
      loadPatterns();
      loadScheduleForDate(selectedDate);
    }
  }, [user, selectedDate]);

  useEffect(() => {
    if (user) {
      checkAndRollover();
    }
  }, [user]);

  // --- Data loading ---

  const loadPendingTasks = async () => {
    const { data } = await supabase
      .from('tasks')
      .select('*')
      .in('status', ['pending', 'rolled_over', 'scheduled'])
      .order('priority', { ascending: false })
      .order('created_at', { ascending: true });

    setTasks(data || []);
  };

  const loadPatterns = async () => {
    if (!user) return;
    const { data } = await supabase
      .from('task_patterns')
      .select('*')
      .eq('user_id', user.id);
    setPatterns(data || []);
  };

  const loadScheduleForDate = async (date: Date) => {
    if (isWeekend(date)) return;

    const dateStr = format(date, 'yyyy-MM-dd');
    const { data } = await supabase
      .from('schedules')
      .select(`
        *,
        items:schedule_items(
          *,
          task:tasks(*)
        )
      `)
      .eq('schedule_date', dateStr)
      .single();

    setCurrentSchedule(data);
  };

  // --- Rollover ---

  const checkAndRollover = async () => {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const todayStr = format(today, 'yyyy-MM-dd');

    const rolledTasks: { id: string; title: string; estimated_minutes?: number }[] = [];

    for (let i = 1; i <= 7; i++) {
      const pastDate = subDays(today, i);
      if (isWeekend(pastDate)) continue;

      const dateStr = format(pastDate, 'yyyy-MM-dd');
      const { data: schedule } = await supabase
        .from('schedules')
        .select(`
          *,
          items:schedule_items(
            *,
            task:tasks(*)
          )
        `)
        .eq('schedule_date', dateStr)
        .eq('user_id', user.id)
        .single();

      if (!schedule?.items) continue;

      const incompleteItems = schedule.items.filter(
        (item: any) => item.item_type === 'task' && !item.completed && item.task_id && item.task && item.task.status !== 'completed'
      );

      for (const item of incompleteItems) {
        // Deduplicate — same task may appear on multiple past days
        if (rolledTasks.some(t => t.id === item.task_id)) continue;
        rolledTasks.push({
          id: item.task_id!,
          title: item.task?.title || item.title,
          estimated_minutes: item.task?.estimated_minutes || undefined,
        });
      }
    }

    if (rolledTasks.length === 0) return;

    const taskIds = rolledTasks.map(t => t.id);
    await supabase
      .from('tasks')
      .update({ status: 'pending' })
      .in('id', taskIds);

    let autoAdded = 0;
    let autoAddedItemIds: string[] = [];

    const { data: todaySchedule } = await supabase
      .from('schedules')
      .select(`
        *,
        items:schedule_items(
          *,
          task:tasks(*)
        )
      `)
      .eq('schedule_date', todayStr)
      .eq('user_id', user.id)
      .single();

    if (todaySchedule) {
      const existingItems = todaySchedule.items || [];
      let lastEndTime = '09:00';
      for (const item of existingItems) {
        if (item.end_time > lastEndTime) {
          lastEndTime = item.end_time;
        }
      }

      // Skip tasks already on today's schedule
      const existingTaskIds = new Set(existingItems.filter((i: any) => i.task_id).map((i: any) => i.task_id));
      const tasksToAdd = rolledTasks.filter(t => !existingTaskIds.has(t.id));

      if (tasksToAdd.length === 0) {
        // All rolled tasks are already on today's schedule — just notify
        setRolloverNotification({
          count: rolledTasks.length,
          taskTitles: rolledTasks.map(t => t.title),
          rolledBackIds: taskIds,
          autoAdded: 0,
          autoAddedItemIds: [],
        });
        await loadPendingTasks();
        await loadScheduleForDate(selectedDate);
        return;
      }

      const newItems = tasksToAdd.map(task => {
        const duration = task.estimated_minutes || 30;
        const [h, m] = lastEndTime.split(':').map(Number);
        const startMinutes = h * 60 + m;
        const endMinutes = startMinutes + duration;
        const startTime = formatTime(startMinutes);
        const endTime = formatTime(endMinutes);
        lastEndTime = endTime;

        return {
          schedule_id: todaySchedule.id,
          task_id: task.id,
          start_time: startTime,
          end_time: endTime,
          item_type: 'task' as const,
          title: task.title,
          completed: false,
        };
      });

      const { data: insertedItems } = await supabase
        .from('schedule_items')
        .insert(newItems)
        .select();

      if (insertedItems) {
        autoAdded = insertedItems.length;
        autoAddedItemIds = insertedItems.map(i => i.id);

        await supabase
          .from('tasks')
          .update({ status: 'scheduled' })
          .in('id', taskIds);
      }
    }

    setRolloverNotification({
      count: rolledTasks.length,
      taskTitles: rolledTasks.map(t => t.title),
      rolledBackIds: taskIds,
      autoAdded,
      autoAddedItemIds,
    });

    await loadPendingTasks();
    await loadScheduleForDate(selectedDate);
  };

  const handleUndoRollover = async () => {
    if (!rolloverNotification) return;

    if (rolloverNotification.autoAddedItemIds.length > 0) {
      await supabase
        .from('schedule_items')
        .delete()
        .in('id', rolloverNotification.autoAddedItemIds);
    }

    await supabase
      .from('tasks')
      .update({ status: 'scheduled' })
      .in('id', rolloverNotification.rolledBackIds);

    setRolloverNotification(null);
    await loadPendingTasks();
    await loadScheduleForDate(selectedDate);
  };

  // --- Time helpers ---

  const formatTime = (totalMinutes: number) => {
    return `${String(Math.floor(totalMinutes / 60)).padStart(2, '0')}:${String(totalMinutes % 60).padStart(2, '0')}`;
  };

  const getMinutes = (timeStr: string) => {
    const [h, m] = timeStr.split(':').map(Number);
    return h * 60 + m;
  };

  // --- DnD helpers ---

  const recalculateTimeSlots = (items: ScheduleItem[]): ScheduleItem[] => {
    let currentTime = 9 * 60; // 09:00

    return items.map(item => {
      const duration = getMinutes(item.end_time) - getMinutes(item.start_time);
      const newStartTime = formatTime(currentTime);
      currentTime += duration;
      const newEndTime = formatTime(currentTime);

      return { ...item, start_time: newStartTime, end_time: newEndTime };
    });
  };

  const persistReorderedItems = async (items: ScheduleItem[]) => {
    for (const item of items) {
      await supabase
        .from('schedule_items')
        .update({ start_time: item.start_time, end_time: item.end_time })
        .eq('id', item.id);
    }
  };

  const addTaskToDay = async (task: Task, dateStr: string, insertAtItemId?: string) => {
    // Remove any existing schedule_items for this task (prevents duplicates across days)
    await supabase
      .from('schedule_items')
      .delete()
      .eq('task_id', task.id);

    // Find or create schedule for the date
    let { data: schedule } = await supabase
      .from('schedules')
      .select('*, items:schedule_items(*)')
      .eq('schedule_date', dateStr)
      .eq('user_id', user.id)
      .single();

    if (!schedule) {
      const { data: newSchedule } = await supabase
        .from('schedules')
        .insert({
          user_id: user.id,
          schedule_date: dateStr,
          schedule_data: { total_hours: 6, work_blocks: 1, break_blocks: 0 },
        })
        .select()
        .single();

      schedule = { ...newSchedule, items: [] };
    }

    const duration = task.estimated_minutes || 30;

    // Insert with placeholder times (will be recalculated)
    const { data: newItem } = await supabase
      .from('schedule_items')
      .insert({
        schedule_id: schedule.id,
        task_id: task.id,
        start_time: '00:00',
        end_time: formatTime(duration),
        item_type: 'task',
        title: task.title,
        completed: false,
      })
      .select()
      .single();

    if (!newItem) return;

    // Build ordered list — insert at position or append at end
    const existingItems = schedule.items || [];
    let orderedItems: any[];

    if (insertAtItemId) {
      const insertIndex = existingItems.findIndex((i: any) => i.id === insertAtItemId);
      orderedItems = [...existingItems];
      if (insertIndex !== -1) {
        orderedItems.splice(insertIndex, 0, newItem);
      } else {
        orderedItems.push(newItem);
      }
    } else {
      orderedItems = [...existingItems, newItem];
    }

    // Recalculate all times sequentially from 09:00
    const recalculated = recalculateTimeSlots(orderedItems);
    await persistReorderedItems(recalculated);

    await supabase
      .from('tasks')
      .update({ status: 'scheduled' })
      .eq('id', task.id);

    await loadPendingTasks();
    await loadScheduleForDate(selectedDate);
  };

  const moveScheduleItemToDay = async (item: ScheduleItem, sourceDateStr: string, targetDateStr: string) => {
    // Delete from source
    await supabase
      .from('schedule_items')
      .delete()
      .eq('id', item.id);

    // Recalculate source schedule times
    if (currentSchedule?.items) {
      const remaining = currentSchedule.items.filter(i => i.id !== item.id);
      const recalculated = recalculateTimeSlots(remaining);
      setCurrentSchedule({ ...currentSchedule, items: recalculated });
      await persistReorderedItems(recalculated);
    }

    // Find or create target schedule
    let { data: targetSchedule } = await supabase
      .from('schedules')
      .select('*, items:schedule_items(*)')
      .eq('schedule_date', targetDateStr)
      .eq('user_id', user.id)
      .single();

    if (!targetSchedule) {
      const { data: newSchedule } = await supabase
        .from('schedules')
        .insert({
          user_id: user.id,
          schedule_date: targetDateStr,
          schedule_data: { total_hours: 6, work_blocks: 1, break_blocks: 0 },
        })
        .select()
        .single();

      targetSchedule = { ...newSchedule, items: [] };
    }

    // Find last end_time in target
    const targetItems = targetSchedule.items || [];
    let lastEndTime = '09:00';
    for (const ti of targetItems) {
      if (ti.end_time > lastEndTime) lastEndTime = ti.end_time;
    }

    const duration = getMinutes(item.end_time) - getMinutes(item.start_time);
    const startMinutes = getMinutes(lastEndTime);
    const endMinutes = startMinutes + duration;

    await supabase.from('schedule_items').insert({
      schedule_id: targetSchedule.id,
      task_id: item.task_id || null,
      start_time: formatTime(startMinutes),
      end_time: formatTime(endMinutes),
      item_type: item.item_type,
      title: item.title,
      completed: false,
    });

    await loadScheduleForDate(selectedDate);
  };

  // --- DnD handlers ---

  const handleDragStart = (event: DragStartEvent) => {
    const { active } = event;
    const data = active.data.current;
    if (data?.type === TASK_LIST_ITEM) {
      setActiveItem({ type: TASK_LIST_ITEM, task: data.task });
    } else if (data?.type === SCHEDULE_ITEM) {
      setActiveItem({ type: SCHEDULE_ITEM, item: data.item });
    }
  };

  const handleDragEnd = async (event: DragEndEvent) => {
    const { active, over } = event;
    setActiveItem(null);

    if (!over) return;

    const activeType = active.data.current?.type;
    const overId = String(over.id);

    // Task list → Schedule or Week Day
    if (activeType === TASK_LIST_ITEM) {
      const task = active.data.current?.task as Task;

      if (overId.startsWith(WEEK_DAY_PREFIX)) {
        const dateStr = overId.replace(WEEK_DAY_PREFIX, '');
        await addTaskToDay(task, dateStr);
      } else if (overId === SCHEDULE_DROP_ZONE) {
        await addTaskToDay(task, format(selectedDate, 'yyyy-MM-dd'));
      } else if (over.data.current?.type === SCHEDULE_ITEM) {
        await addTaskToDay(task, format(selectedDate, 'yyyy-MM-dd'), String(over.id));
      }
      return;
    }

    // Schedule item → reorder or cross-day move
    if (activeType === SCHEDULE_ITEM) {
      const item = active.data.current?.item as ScheduleItem;
      const sourceDateStr = active.data.current?.dateStr as string;

      if (overId.startsWith(WEEK_DAY_PREFIX)) {
        const targetDateStr = overId.replace(WEEK_DAY_PREFIX, '');
        if (targetDateStr !== sourceDateStr) {
          await moveScheduleItemToDay(item, sourceDateStr, targetDateStr);
        }
      } else if (over.data.current?.type === SCHEDULE_ITEM && active.id !== over.id) {
        // Reorder within same schedule
        if (!currentSchedule?.items) return;

        const items = [...currentSchedule.items];
        const activeIndex = items.findIndex(i => i.id === String(active.id));
        const overIndex = items.findIndex(i => i.id === String(over.id));

        if (activeIndex === -1 || overIndex === -1) return;

        const reordered = arrayMove(items, activeIndex, overIndex);
        const recalculated = recalculateTimeSlots(reordered);

        // Optimistic update
        setCurrentSchedule({ ...currentSchedule, items: recalculated });
        await persistReorderedItems(recalculated);
      }
      return;
    }
  };

  // --- Task CRUD ---

  const parseTasksWithClaude = async (input: string) => {
    const response = await fetch('/api/claude', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 4000,
        messages: [{
          role: 'user',
          content: `Parse these tasks into a JSON array. Each task should have: title (string), description (optional string), priority ('high'|'medium'|'low'), due_date (optional string in YYYY-MM-DD format or null), estimated_minutes (number).

Today's date is ${format(new Date(), 'yyyy-MM-dd')} (${format(new Date(), 'EEEE')}).

RULES:
- Preserve the EXACT original wording for the title. Do not paraphrase, shorten, or rewrite task titles. Strip any deadline phrase from the title (e.g. "Review PRs by Wednesday" → title: "Review PRs", due_date: next Wednesday).
- Extract due dates from natural language: "by Wednesday", "due Friday", "before March 5", "tomorrow", etc.
- Resolve relative dates (e.g. "Wednesday" means the NEXT upcoming Wednesday relative to today).
- If no deadline is mentioned, set due_date to null.

DURATION ESTIMATION:
${patterns.length > 0 ? `Use these historical patterns from the user's completed tasks to estimate duration:\n${patterns.map(p => `- Tasks matching '${p.task_keywords.join(', ')}' typically take ${p.average_duration}min`).join('\n')}\nIf no pattern matches, use your best guess.` : 'Use your best guess at duration.'}
Use values like 5, 10, 15, 30, 45, 60, 90, 120.

Input:
${input}

Return ONLY valid JSON array, no markdown, no explanation.`
        }]
      })
    });

    const data = await response.json();
    const text = data.content[0].text;
    return JSON.parse(text);
  };

  const handleAddTasks = async () => {
    if (!taskInput.trim() || !user) {
      alert('Please log in to add tasks');
      return;
    }

    setLoading(true);
    try {
      const parsedTasks = await parseTasksWithClaude(taskInput);

      const existingTasks = tasks;
      const duplicates: any[] = [];
      const uniqueTasks: any[] = [];

      parsedTasks.forEach((newTask: any) => {
        const isDuplicate = existingTasks.some(existing =>
          existing.title.toLowerCase() === newTask.title.toLowerCase()
        );

        if (isDuplicate) {
          const existingTask = existingTasks.find(e =>
            e.title.toLowerCase() === newTask.title.toLowerCase()
          );
          duplicates.push({ newTask, existingTask });
        } else {
          uniqueTasks.push(newTask);
        }
      });

      let tasksToAdd = uniqueTasks;

      if (duplicates.length > 0) {
        const duplicateList = duplicates
          .map((d, i) =>
            `${i + 1}. "${d.newTask.title}" (similar to: "${d.existingTask.title}")`
          )
          .join('\n');

        const addDuplicates = confirm(
          `Found ${duplicates.length} potential duplicate(s):\n\n${duplicateList}\n\nAdd anyway?`
        );

        if (addDuplicates) {
          tasksToAdd = [...uniqueTasks, ...duplicates.map(d => d.newTask)];
        } else if (uniqueTasks.length === 0) {
          alert('No unique tasks to add.');
          setLoading(false);
          return;
        }
      }

      const { data: createdTasks, error } = await supabase
        .from('tasks')
        .insert(
          tasksToAdd.map((task: any) => ({
            user_id: user.id,
            title: task.title,
            description: task.description || null,
            priority: task.priority || 'medium',
            estimated_minutes: task.estimated_minutes || null,
            due_date: task.due_date || null,
            status: 'pending'
          }))
        )
        .select();

      if (error) throw error;

      setTaskInput('');
      await loadPendingTasks();
      alert(`Successfully added ${createdTasks.length} task(s)!`);

    } catch (error) {
      console.error('Error adding tasks:', error);
      alert('Failed to add tasks');
    } finally {
      setLoading(false);
    }
  };

  const handleDeleteTask = async (taskId: string) => {
    if (!confirm('Are you sure you want to delete this task?')) return;

    await supabase
      .from('schedule_items')
      .delete()
      .eq('task_id', taskId);

    await supabase
      .from('tasks')
      .delete()
      .eq('id', taskId);

    await loadPendingTasks();
    await loadScheduleForDate(selectedDate);
  };

  const handleChangePriority = async (taskId: string, priority: 'high' | 'medium' | 'low') => {
    await supabase
      .from('tasks')
      .update({ priority })
      .eq('id', taskId);

    await loadPendingTasks();
    await loadScheduleForDate(selectedDate);
  };

  const handleDueDateChange = async (taskId: string, newDate: string) => {
    await supabase
      .from('tasks')
      .update({ due_date: newDate || null })
      .eq('id', taskId);

    await loadPendingTasks();
    await loadScheduleForDate(selectedDate);
  };

  const handleTitleEdit = async (taskId: string, newTitle: string) => {
    if (!newTitle.trim()) return;
    const trimmed = newTitle.trim();
    await supabase
      .from('tasks')
      .update({ title: trimmed })
      .eq('id', taskId);

    await supabase
      .from('schedule_items')
      .update({ title: trimmed })
      .eq('task_id', taskId);

    setEditingTaskId(null);
    await loadPendingTasks();
    await loadScheduleForDate(selectedDate);
  };

  const handleEstimatedMinutesChange = async (taskId: string, value: string) => {
    const minutes = parseInt(value);
    const newMinutes = isNaN(minutes) ? null : minutes;

    await supabase
      .from('tasks')
      .update({ estimated_minutes: newMinutes })
      .eq('id', taskId);

    // Adjust the schedule block duration if this task is on the current schedule
    if (newMinutes && currentSchedule?.items) {
      const item = currentSchedule.items.find(i => i.task_id === taskId);
      if (item) {
        const startMin = getMinutes(item.start_time);
        const updatedItems = currentSchedule.items.map(i =>
          i.id === item.id
            ? { ...i, end_time: formatTime(startMin + newMinutes) }
            : i
        );
        const recalculated = recalculateTimeSlots(updatedItems);
        setCurrentSchedule({ ...currentSchedule, items: recalculated });
        await persistReorderedItems(recalculated);
      }
    }

    await loadPendingTasks();
    await loadScheduleForDate(selectedDate);
  };

  const handleCompleteTask = async (
    itemId: string,
    taskId: string | null,
    currentlyCompleted: boolean,
    startTime?: string,
    endTime?: string,
    taskTitle?: string
  ) => {
    await supabase
      .from('schedule_items')
      .update({ completed: !currentlyCompleted })
      .eq('id', itemId);

    if (!currentlyCompleted && taskId) {
      await supabase
        .from('tasks')
        .update({
          status: 'completed',
          completed_at: new Date().toISOString()
        })
        .eq('id', taskId);

      if (startTime && endTime && taskTitle) {
        try {
          const [startH, startM] = startTime.split(':').map(Number);
          const [endH, endM] = endTime.split(':').map(Number);
          const actualMinutes = (endH * 60 + endM) - (startH * 60 + startM);

          const commonWords = new Set(['the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for', 'of', 'with', 'by', 'is', 'it', 'up']);
          const keywords = taskTitle
            .toLowerCase()
            .split(/\s+/)
            .map(w => w.replace(/[^\w]/g, ''))
            .filter(w => w.length > 3 && !commonWords.has(w))
            .slice(0, 5);

          if (keywords.length > 0 && actualMinutes > 0) {
            const matchingPattern = patterns.find(p =>
              p.task_keywords.some((kw: string) => keywords.includes(kw))
            );

            if (matchingPattern) {
              const newTimesScheduled = matchingPattern.times_scheduled + 1;
              const newTimesCompleted = matchingPattern.times_completed + 1;
              const newAvgDuration = Math.round(
                (matchingPattern.average_duration * matchingPattern.times_scheduled + actualMinutes) / newTimesScheduled
              );
              await supabase
                .from('task_patterns')
                .update({
                  average_duration: newAvgDuration,
                  times_scheduled: newTimesScheduled,
                  times_completed: newTimesCompleted,
                  completion_rate: newTimesCompleted / newTimesScheduled,
                  updated_at: new Date().toISOString()
                })
                .eq('id', matchingPattern.id);
            } else {
              await supabase
                .from('task_patterns')
                .insert({
                  user_id: user.id,
                  task_keywords: keywords,
                  average_duration: actualMinutes,
                  times_scheduled: 1,
                  times_completed: 1,
                  completion_rate: 1.0
                });
            }
            await loadPatterns();
          }
        } catch (err) {
          console.error('Failed to update task pattern:', err);
        }
      }
    }

    if (currentlyCompleted && taskId) {
      await supabase
        .from('tasks')
        .update({
          status: 'pending',
          completed_at: null
        })
        .eq('id', taskId);
    }

    await loadScheduleForDate(selectedDate);
    await loadPendingTasks();
  };

  // --- Schedule generation ---

  const handleWorkHoursChange = async (dateStr: string, newHours: number) => {
    // Synchronous guard — prevents concurrent regeneration from rapid clicks
    if (busyRef.current) return;

    setWorkHours({ ...workHours, [dateStr]: newHours });

    const { data: existingSchedule } = await supabase
      .from('schedules')
      .select('id')
      .eq('schedule_date', dateStr)
      .eq('user_id', user.id)
      .single();

    if (!existingSchedule) return;

    // Get the tasks that were on THIS day's schedule (not all tasks)
    const { data: existingItems } = await supabase
      .from('schedule_items')
      .select('*, task:tasks(*)')
      .eq('schedule_id', existingSchedule.id);

    const dayTasks = (existingItems || [])
      .filter((item: any) => item.task_id && item.task)
      .map((item: any) => item.task as Task);

    // Deduplicate by task id
    const seen = new Set<string>();
    const tasksToSchedule = dayTasks.filter(t => {
      if (seen.has(t.id)) return false;
      seen.add(t.id);
      return true;
    });

    if (tasksToSchedule.length === 0) return;

    busyRef.current = true;
    setLoading(true);
    try {
      await supabase
        .from('schedule_items')
        .delete()
        .eq('schedule_id', existingSchedule.id);

      const taskDescriptions = tasksToSchedule.map(t =>
        `${t.title} [Priority: ${t.priority}]${t.estimated_minutes ? ` [Est: ${t.estimated_minutes}min]` : ''}${t.due_date ? ` [Due: ${t.due_date}]` : ''}`
      );

      const patternsBlock = patterns.length > 0
        ? `\nHISTORICAL PATTERNS (use to validate/adjust time block sizes):\n${patterns.map(p => `- Tasks like '${p.task_keywords.join(', ')}' typically take ${p.average_duration}min (completed ${p.times_completed} times)`).join('\n')}\n`
        : '';

      const response = await fetch('/api/claude', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'claude-sonnet-4-20250514',
          max_tokens: 4000,
          messages: [{
            role: 'user',
            content: `Generate a ${newHours}-hour work schedule for ${dateStr}.

TASKS:
${taskDescriptions.map((t, i) => `${i + 1}. ${t}`).join('\n')}
${patternsBlock}
RULES:
- Total work time: ${newHours} hours, start 9:00 AM
- Use each task's estimated duration for block sizing
- Cross-reference with historical patterns — if a pattern suggests different duration, prefer the pattern
- High-priority and imminent-deadline tasks in the morning
- Include 30min lunch break around midday
- Include 5-10min breaks every 60-90min
- Each task gets its own block
- Use EXACT task titles from the list above (without the [Priority], [Est], or [Due] tags)

Return ONLY valid JSON:
{
  "blocks": [
    {"start_time": "09:00", "end_time": "10:30", "type": "task", "title": "exact task name", "estimated_duration": 90},
    {"start_time": "10:30", "end_time": "10:40", "type": "break", "title": "Break", "estimated_duration": 10},
    {"start_time": "12:00", "end_time": "12:30", "type": "lunch", "title": "Lunch break", "estimated_duration": 30}
  ]
}`
          }]
        })
      });

      const data = await response.json();
      const text = data.content[0].text.replace(/```json\n?|\n?```/g, '').trim();
      const schedule = JSON.parse(text);

      await supabase
        .from('schedules')
        .update({
          schedule_data: {
            total_hours: newHours,
            work_blocks: schedule.blocks.filter((b: any) => b.type === 'task').length,
            break_blocks: schedule.blocks.filter((b: any) => b.type !== 'task').length
          }
        })
        .eq('id', existingSchedule.id);

      const items = schedule.blocks.map((block: any) => {
        const matchingTask = tasksToSchedule.find(t =>
          block.title.toLowerCase().includes(t.title.toLowerCase()) ||
          t.title.toLowerCase().includes(block.title.toLowerCase())
        );
        return {
          schedule_id: existingSchedule.id,
          task_id: matchingTask?.id || null,
          start_time: block.start_time,
          end_time: block.end_time,
          item_type: block.type,
          title: block.title,
          completed: false
        };
      });

      await supabase.from('schedule_items').insert(items);

      if (format(selectedDate, 'yyyy-MM-dd') === dateStr) {
        await loadScheduleForDate(selectedDate);
      }
    } catch (error) {
      console.error('Error regenerating schedule:', error);
    } finally {
      busyRef.current = false;
      setLoading(false);
    }
  };

  const handleGenerateSchedule = async () => {
    if (busyRef.current) return;
    if (tasks.length === 0) {
      alert('Please add some tasks first!');
      return;
    }

    busyRef.current = true;
    setLoading(true);
    try {
      const weekDates = getWeekDates();
      const today = new Date();
      today.setHours(0, 0, 0, 0);

      const remainingDates = weekDates.filter(date => {
        const d = new Date(date);
        d.setHours(0, 0, 0, 0);
        return d >= today;
      });

      if (remainingDates.length === 0) {
        alert('No remaining days in this week!');
        setLoading(false);
        return;
      }

      const todayStr = format(today, 'yyyy-MM-dd');
      const tasksWithDueDate = tasks.filter(t => t.due_date);
      const tasksWithoutDueDate = tasks.filter(t => !t.due_date);

      const tasksPerDay: Task[][] = remainingDates.map(() => []);
      const remainingDateStrs = remainingDates.map(d => format(d, 'yyyy-MM-dd'));

      const sortByPriority = (a: Task, b: Task) => {
        const order = { high: 0, medium: 1, low: 2 };
        return order[a.priority] - order[b.priority];
      };
      tasksWithDueDate.sort(sortByPriority);

      for (const task of tasksWithDueDate) {
        const dueDate = task.due_date!;
        let assignedIndex = -1;

        if (dueDate <= todayStr) {
          assignedIndex = 0;
        } else {
          for (let j = remainingDateStrs.length - 1; j >= 0; j--) {
            if (remainingDateStrs[j] <= dueDate) {
              assignedIndex = j;
              break;
            }
          }
          if (assignedIndex === -1) assignedIndex = 0;
        }

        tasksPerDay[assignedIndex].push(task);
      }

      const sortedNoDue = [...tasksWithoutDueDate].sort(sortByPriority);
      sortedNoDue.forEach((task, index) => {
        const dayIndex = index % remainingDates.length;
        tasksPerDay[dayIndex].push(task);
      });

      for (const dayTasks of tasksPerDay) {
        dayTasks.sort(sortByPriority);
      }

      for (let i = 0; i < remainingDates.length; i++) {
        const date = remainingDates[i];
        const dateStr = format(date, 'yyyy-MM-dd');
        const hours = workHours[dateStr] || 6;
        const dayTasks = tasksPerDay[i];

        if (dayTasks.length === 0) continue;

        await generateScheduleForDay(dateStr, dayTasks, hours);
      }

      await loadScheduleForDate(selectedDate);
      await loadPendingTasks();
      alert('Generated schedules from today through Friday!');

    } catch (error) {
      console.error('Error:', error);
      alert('Failed to generate schedules');
    } finally {
      busyRef.current = false;
      setLoading(false);
    }
  };

  const generateScheduleForDay = async (date: string, dayTasks: Task[], hours: number) => {
    const { data: existing } = await supabase
      .from('schedules')
      .select('id')
      .eq('schedule_date', date)
      .eq('user_id', user.id)
      .single();

    if (existing) {
      await supabase.from('schedule_items').delete().eq('schedule_id', existing.id);
      await supabase.from('schedules').delete().eq('id', existing.id);
    }

    const taskDescriptions = dayTasks.map(t =>
      `${t.title} [Priority: ${t.priority}]${t.estimated_minutes ? ` [Est: ${t.estimated_minutes}min]` : ''}${t.due_date ? ` [Due: ${t.due_date}]` : ''}`
    );

    const patternsBlock = patterns.length > 0
      ? `\nHISTORICAL PATTERNS (use to validate/adjust time block sizes):\n${patterns.map(p => `- Tasks like '${p.task_keywords.join(', ')}' typically take ${p.average_duration}min (completed ${p.times_completed} times)`).join('\n')}\n`
      : '';

    const response = await fetch('/api/claude', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 4000,
        messages: [{
          role: 'user',
          content: `Generate a ${hours}-hour work schedule for ${date}.

TASKS:
${taskDescriptions.map((t, i) => `${i + 1}. ${t}`).join('\n')}
${patternsBlock}
RULES:
- Total work time: ${hours} hours, start 9:00 AM
- Use each task's estimated duration for block sizing
- Cross-reference with historical patterns — if a pattern suggests different duration, prefer the pattern
- High-priority and imminent-deadline tasks in the morning
- Include 30min lunch break around midday
- Include 5-10min breaks every 60-90min
- Each task gets its own block
- Use EXACT task titles from the list above (without the [Priority], [Est], or [Due] tags)

Return ONLY valid JSON:
{
  "blocks": [
    {"start_time": "09:00", "end_time": "10:30", "type": "task", "title": "exact task name", "estimated_duration": 90},
    {"start_time": "10:30", "end_time": "10:40", "type": "break", "title": "Break", "estimated_duration": 10},
    {"start_time": "12:00", "end_time": "12:30", "type": "lunch", "title": "Lunch break", "estimated_duration": 30}
  ]
}`
        }]
      })
    });

    const data = await response.json();
    const text = data.content[0].text.replace(/```json\n?|\n?```/g, '').trim();
    const schedule = JSON.parse(text);

    const { data: scheduleData, error: schedError } = await supabase
      .from('schedules')
      .insert({
        user_id: user.id,
        schedule_date: date,
        schedule_data: {
          total_hours: hours,
          work_blocks: schedule.blocks.filter((b: any) => b.type === 'task').length,
          break_blocks: schedule.blocks.filter((b: any) => b.type !== 'task').length
        }
      })
      .select()
      .single();

    if (schedError) throw schedError;

    const items = schedule.blocks.map((block: any) => {
      const matchingTask = dayTasks.find(t =>
        block.title.toLowerCase().includes(t.title.toLowerCase()) ||
        t.title.toLowerCase().includes(block.title.toLowerCase())
      );

      return {
        schedule_id: scheduleData.id,
        task_id: matchingTask?.id || null,
        start_time: block.start_time,
        end_time: block.end_time,
        item_type: block.type,
        title: block.title,
        completed: false
      };
    });

    await supabase.from('schedule_items').insert(items);
  };

  const handleSignOut = async () => {
    await supabase.auth.signOut();
  };

  const getWeekDates = () => {
    const start = startOfWeek(new Date(), { weekStartsOn: 1 });
    return Array.from({ length: 5 }, (_, i) => addDays(start, i));
  };

  const priorityConfig = {
    high: { dot: 'bg-[#e8705e]', text: 'text-[#e8705e]', label: 'High', border: 'border-l-[#e8705e]', tint: 'bg-[#e8705e]/[0.06]' },
    medium: { dot: 'bg-[#d4a54a]', text: 'text-[#d4a54a]', label: 'Medium', border: 'border-l-[#d4a54a]', tint: 'bg-[#d4a54a]/[0.05]' },
    low: { dot: 'bg-[#7dab6e]', text: 'text-[#7dab6e]', label: 'Low', border: 'border-l-[#7dab6e]', tint: 'bg-[#7dab6e]/[0.04]' },
  };

  if (!user) {
    return (
      <div className="min-h-screen bg-[#050507] flex items-center justify-center">
        <div className="text-center animate-fade-in">
          <div className="inline-block mb-6">
            <div className="w-10 h-10 border-2 border-white/20 border-t-white rounded-full animate-spin-slow" />
          </div>
          <h1 className="text-2xl text-white mb-4">Please sign in</h1>
          <a href="/" className="text-slate-400 hover:text-white transition-colors">
            Go to login
          </a>
        </div>
      </div>
    );
  }

  const weekDates = getWeekDates();
  const scheduleItems = currentSchedule?.items || [];
  const selectedDateStr = format(selectedDate, 'yyyy-MM-dd');

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={pointerWithin}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
    >
      <div className="min-h-screen bg-[#050507] text-white">
        {/* Loading overlay */}
        {loading && (
          <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-center justify-center">
            <div className="glass-card p-8 flex flex-col items-center gap-4 animate-fade-in">
              <div className="w-10 h-10 border-2 border-white/20 border-t-white rounded-full animate-spin-slow" />
              <p className="text-slate-400 text-sm">Processing...</p>
            </div>
          </div>
        )}

        <div className="max-w-7xl mx-auto p-6">
          {/* Header */}
          <div className="flex justify-between items-center mb-8">
            <h1 className="text-2xl font-semibold text-white tracking-tight">
              TaskFlow
            </h1>
            <button
              onClick={handleSignOut}
              className="px-3 py-1.5 rounded-lg text-slate-500 hover:text-slate-300 transition-colors text-sm"
            >
              Sign Out
            </button>
          </div>

          {/* Rollover notification */}
          {rolloverNotification && (
            <div className="mb-6 bg-white/[0.03] border border-white/[0.06] rounded-xl px-4 py-3 flex items-center justify-between animate-fade-in">
              <div className="flex-1 min-w-0">
                <p className="text-sm text-slate-300">
                  {rolloverNotification.count} incomplete {rolloverNotification.count === 1 ? 'task' : 'tasks'} rolled over from previous days
                  {rolloverNotification.autoAdded > 0 && (
                    <span className="text-[#d4a54a]"> — {rolloverNotification.autoAdded} added to today&apos;s schedule</span>
                  )}
                </p>
                <p className="text-xs text-slate-600 mt-0.5 truncate">
                  {rolloverNotification.taskTitles.join(', ')}
                </p>
              </div>
              <div className="flex items-center gap-2 ml-4 flex-shrink-0">
                <button
                  onClick={handleUndoRollover}
                  className="text-xs text-slate-500 hover:text-slate-300 transition-colors px-2 py-1"
                >
                  Undo
                </button>
                <button
                  onClick={() => setRolloverNotification(null)}
                  className="text-slate-600 hover:text-slate-400 transition-colors p-1"
                >
                  <svg xmlns="http://www.w3.org/2000/svg" className="h-3.5 w-3.5" viewBox="0 0 20 20" fill="currentColor">
                    <path fillRule="evenodd" d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z" clipRule="evenodd" />
                  </svg>
                </button>
              </div>
            </div>
          )}

          {/* Week Navigation */}
          <div className="flex gap-2 mb-8 overflow-x-auto pb-2">
            {weekDates.map((date) => {
              const dateStr = format(date, 'yyyy-MM-dd');
              const isSelected = selectedDateStr === dateStr;

              return (
                <WeekDayButton
                  key={dateStr}
                  date={date}
                  dateStr={dateStr}
                  isSelected={isSelected}
                  onClick={() => setSelectedDate(date)}
                  workHours={workHours[dateStr] || 6}
                  onWorkHoursChange={handleWorkHoursChange}
                />
              );
            })}
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            {/* Left Column */}
            <div className="space-y-6">
              {/* Add Tasks */}
              <div className="glass-card p-5 animate-fade-in">
                <h2 className="text-sm font-medium text-slate-400 mb-3">Add Tasks</h2>
                <textarea
                  value={taskInput}
                  onChange={(e) => setTaskInput(e.target.value)}
                  placeholder="Describe your tasks naturally...&#10;e.g. Review PRs (high priority)&#10;Write documentation&#10;Fix login bug by Friday"
                  className="w-full p-3 bg-white/[0.03] border border-white/[0.06] text-white rounded-lg mb-3 h-28 resize-none placeholder-slate-600 focus:outline-none focus:ring-1 focus:ring-white/15 focus:border-white/10 transition-all duration-200 text-sm"
                  disabled={loading}
                />
                <button
                  onClick={handleAddTasks}
                  disabled={loading || !taskInput.trim()}
                  className="btn-primary w-full py-2.5 rounded-lg text-sm"
                >
                  Add Tasks
                </button>
              </div>

              {/* Pending Tasks */}
              <div className="glass-card p-5 animate-fade-in">
                <div className="flex items-center justify-between mb-3">
                  <h2 className="text-sm font-medium text-slate-400">Tasks</h2>
                  <span className="text-xs text-slate-600">
                    {tasks.length}
                  </span>
                </div>
                <div className="space-y-1.5 max-h-96 overflow-y-auto pr-1">
                  {tasks.length === 0 ? (
                    <div className="text-center py-8">
                      <p className="text-sm text-slate-600">No tasks yet</p>
                    </div>
                  ) : (
                    tasks.map((task) => {
                      const pc = priorityConfig[task.priority as keyof typeof priorityConfig] || priorityConfig.medium;
                      return (
                        <TaskCard
                          key={task.id}
                          task={task}
                          pc={pc}
                          isEditing={editingTaskId === task.id}
                          editingTitle={editingTitle}
                          onEditingTitleChange={setEditingTitle}
                          onTitleEdit={handleTitleEdit}
                          onStartEditing={(id, title) => { setEditingTaskId(id); setEditingTitle(title); }}
                          onCancelEditing={() => setEditingTaskId(null)}
                          onDelete={handleDeleteTask}
                          onChangePriority={handleChangePriority}
                          onEstimatedMinutesChange={handleEstimatedMinutesChange}
                          onDueDateChange={handleDueDateChange}
                        />
                      );
                    })
                  )}
                </div>
              </div>
            </div>

            {/* Right Column - Schedule */}
            <div className="lg:col-span-2">
              <div className="glass-card p-6 animate-fade-in">
                <div className="flex justify-between items-center mb-6">
                  <div>
                    <h2 className="text-lg font-semibold text-white">
                      {format(selectedDate, 'EEEE, MMMM d')}
                    </h2>
                    <p className="text-xs text-slate-600 mt-0.5">
                      {scheduleItems.length} scheduled items
                    </p>
                  </div>
                  <button
                    onClick={handleGenerateSchedule}
                    disabled={loading || tasks.length === 0}
                    className="btn-primary px-4 py-2 rounded-lg text-sm"
                  >
                    Generate Schedule
                  </button>
                </div>

                {!currentSchedule ? (
                  <ScheduleDropZone>
                    <div className="text-center py-16 animate-fade-in">
                      <p className="text-slate-600 text-sm">No schedule yet</p>
                      <p className="text-xs text-slate-700 mt-1">Add tasks and generate a schedule, or drag tasks here</p>
                    </div>
                  </ScheduleDropZone>
                ) : (
                  <ScheduleDropZone>
                    <SortableContext
                      items={scheduleItems.map(item => item.id)}
                      strategy={verticalListSortingStrategy}
                    >
                      {scheduleItems.map((item) => {
                        const priority = item.task?.priority || (item.item_type === 'task' ? 'low' : 'medium');
                        const pc = priorityConfig[priority as keyof typeof priorityConfig] || priorityConfig.low;

                        return (
                          <ScheduleItemCard
                            key={item.id}
                            item={item}
                            pc={pc}
                            onComplete={handleCompleteTask}
                            dateStr={selectedDateStr}
                          />
                        );
                      })}
                    </SortableContext>
                  </ScheduleDropZone>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>

      <DragOverlay>
        {activeItem ? (
          <DragOverlayContent activeItem={activeItem} priorityConfig={priorityConfig} />
        ) : null}
      </DragOverlay>
    </DndContext>
  );
}
