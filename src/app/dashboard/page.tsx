// src/app/dashboard/page.tsx
'use client';

import { useState, useEffect } from 'react';
import { supabase } from '@/lib/supabase';
import { Task, Schedule, ScheduleItem } from '@/types';
import { format, addDays, subDays, startOfWeek, isWeekend, isToday } from 'date-fns';

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
  } | null>(null);

  useEffect(() => {
    // Get current user
    supabase.auth.getSession().then(({ data: { session } }) => {
      setUser(session?.user);
    });

    // Subscribe to auth changes
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
      loadScheduleForDate(selectedDate);
    }
  }, [user, selectedDate]);

  // Auto-rollover incomplete tasks from past days
  useEffect(() => {
    if (user) {
      checkAndRollover();
    }
  }, [user]);

  const checkAndRollover = async () => {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    // Check the past 7 days for incomplete scheduled tasks
    const rolledTasks: { id: string; title: string }[] = [];

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
        (item: any) => item.item_type === 'task' && !item.completed && item.task_id && item.task?.status === 'scheduled'
      );

      for (const item of incompleteItems) {
        rolledTasks.push({ id: item.task_id!, title: item.task?.title || item.title });
      }
    }

    if (rolledTasks.length === 0) return;

    // Mark tasks as pending so they reappear in the task list
    const taskIds = rolledTasks.map(t => t.id);
    await supabase
      .from('tasks')
      .update({ status: 'pending' })
      .in('id', taskIds);

    setRolloverNotification({
      count: rolledTasks.length,
      taskTitles: rolledTasks.map(t => t.title),
      rolledBackIds: taskIds,
    });

    await loadPendingTasks();
  };

  const handleUndoRollover = async () => {
    if (!rolloverNotification) return;

    await supabase
      .from('tasks')
      .update({ status: 'scheduled' })
      .in('id', rolloverNotification.rolledBackIds);

    setRolloverNotification(null);
    await loadPendingTasks();
  };

  const loadPendingTasks = async () => {
    const { data } = await supabase
      .from('tasks')
      .select('*')
      .in('status', ['pending', 'rolled_over', 'scheduled'])
      .order('priority', { ascending: false })
      .order('created_at', { ascending: true });

    setTasks(data || []);
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

  const parseTasksWithClaude = async (input: string) => {
    const response = await fetch('/api/claude', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 4000,
        messages: [{
          role: 'user',
          content: `Parse these tasks into a JSON array. Each task should have: title (string), description (optional string), priority ('high'|'medium'|'low'), due_date (optional string in YYYY-MM-DD format or null), category ('deep_focus'|'admin'|'quick'), estimated_minutes (number).

Today's date is ${format(new Date(), 'yyyy-MM-dd')} (${format(new Date(), 'EEEE')}).

RULES:
- Preserve the EXACT original wording for the title. Do not paraphrase, shorten, or rewrite task titles. Strip any deadline phrase from the title (e.g. "Review PRs by Wednesday" → title: "Review PRs", due_date: next Wednesday).
- Extract due dates from natural language: "by Wednesday", "due Friday", "before March 5", "tomorrow", etc.
- Resolve relative dates (e.g. "Wednesday" means the NEXT upcoming Wednesday relative to today).
- If no deadline is mentioned, set due_date to null.

CATEGORY RULES:
- deep_focus: coding, writing, design, research, anything requiring sustained concentration
- admin: emails, Slack, meetings, approvals, status updates, scheduling
- quick: reviews, follow-ups, small fixes, replies — anything under ~15 min

ESTIMATED_MINUTES: Your best guess at duration. Use values like 5, 10, 15, 30, 45, 60, 90, 120.

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

      // Check for duplicates
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

      // Insert tasks
      const { data: createdTasks, error } = await supabase
        .from('tasks')
        .insert(
          tasksToAdd.map((task: any) => ({
            user_id: user.id,
            title: task.title,
            description: task.description || null,
            priority: task.priority || 'medium',
            category: task.category || null,
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

    // Delete schedule items first
    await supabase
      .from('schedule_items')
      .delete()
      .eq('task_id', taskId);

    // Delete task
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
  };

  const handleDueDateChange = async (taskId: string, newDate: string) => {
    await supabase
      .from('tasks')
      .update({ due_date: newDate || null })
      .eq('id', taskId);

    await loadPendingTasks();
  };

  const handleTitleEdit = async (taskId: string, newTitle: string) => {
    if (!newTitle.trim()) return;
    await supabase
      .from('tasks')
      .update({ title: newTitle.trim() })
      .eq('id', taskId);
    setEditingTaskId(null);
    await loadPendingTasks();
  };

  const handleCategoryChange = async (taskId: string, category: 'deep_focus' | 'admin' | 'quick') => {
    await supabase
      .from('tasks')
      .update({ category })
      .eq('id', taskId);
    await loadPendingTasks();
  };

  const handleEstimatedMinutesChange = async (taskId: string, minutes: number) => {
    await supabase
      .from('tasks')
      .update({ estimated_minutes: minutes })
      .eq('id', taskId);
    await loadPendingTasks();
  };

  const handleCompleteTask = async (itemId: string, taskId: string | null, currentlyCompleted: boolean) => {
    // Toggle completion status
    await supabase
      .from('schedule_items')
      .update({ completed: !currentlyCompleted })
      .eq('id', itemId);

    // If checking as complete AND it has a task, mark task as completed
    if (!currentlyCompleted && taskId) {
      await supabase
        .from('tasks')
        .update({
          status: 'completed',
          completed_at: new Date().toISOString()
        })
        .eq('id', taskId);
    }

    // If unchecking AND it has a task, mark task back to pending
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

  const handleWorkHoursChange = async (dateStr: string, newHours: number) => {
    setWorkHours({ ...workHours, [dateStr]: newHours });

    // Check if this date already has a schedule
    const { data: existingSchedule } = await supabase
      .from('schedules')
      .select('id')
      .eq('schedule_date', dateStr)
      .eq('user_id', user.id)
      .single();

    if (!existingSchedule) return;

    const tasksToSchedule = tasks.length > 0 ? tasks : [];
    if (tasksToSchedule.length === 0) return;

    setLoading(true);
    try {
      // Delete old schedule items
      await supabase
        .from('schedule_items')
        .delete()
        .eq('schedule_id', existingSchedule.id);

      // Regenerate with new hours
      const taskDescriptions = tasksToSchedule.map(t =>
        `${t.title} [Priority: ${t.priority}]${t.category ? ` [Category: ${t.category}]` : ''}${t.estimated_minutes ? ` [Est: ${t.estimated_minutes}min]` : ''}${t.due_date ? ` [Due: ${t.due_date}]` : ''}`
      );

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

STRUCTURE THE DAY AS FOLLOWS:
1. DEEP FOCUS block(s) — morning, uninterrupted 60-120min blocks for deep_focus tasks
2. ADMIN/MOTION block — batch admin tasks together, typically mid-day or after lunch
3. QUICK FOLLOW-UPS block — group quick tasks into a single sweep block (15-30min total)
4. Include 30min lunch break around midday
5. Include 5-10min breaks between themed blocks

RULES:
- Total work time: ${newHours} hours
- Start: 9:00 AM
- Use each task's estimated duration for block sizing
- Tasks with imminent due dates should be prioritized
- DO NOT combine tasks — each task gets its own time slot within its block
- Quick tasks can share a themed block but each gets its own line item
- Use EXACT task titles from the list above (without the [Priority], [Category], [Est], or [Due] tags)
- For break blocks between themed sections, use title format: "Break — [next section type]" e.g. "Break — Admin block"

Return ONLY valid JSON:
{
  "blocks": [
    {"start_time": "09:00", "end_time": "10:30", "type": "task", "title": "exact task name", "category": "deep_focus", "estimated_duration": 90},
    {"start_time": "10:30", "end_time": "10:40", "type": "break", "title": "Break — Admin block", "estimated_duration": 10},
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
      setLoading(false);
    }
  };

  const handleGenerateSchedule = async () => {
    if (tasks.length === 0) {
      alert('Please add some tasks first!');
      return;
    }

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

      // Separate tasks by due date presence
      const todayStr = format(today, 'yyyy-MM-dd');
      const tasksWithDueDate = tasks.filter(t => t.due_date);
      const tasksWithoutDueDate = tasks.filter(t => !t.due_date);

      const tasksPerDay: Task[][] = remainingDates.map(() => []);
      const remainingDateStrs = remainingDates.map(d => format(d, 'yyyy-MM-dd'));

      // Assign tasks WITH due dates to the latest available weekday <= their due date
      const sortByPriority = (a: Task, b: Task) => {
        const order = { high: 0, medium: 1, low: 2 };
        return order[a.priority] - order[b.priority];
      };
      tasksWithDueDate.sort(sortByPriority);

      for (const task of tasksWithDueDate) {
        const dueDate = task.due_date!;
        let assignedIndex = -1;

        if (dueDate <= todayStr) {
          // Due today or past — assign to earliest available day
          assignedIndex = 0;
        } else {
          // Find the latest remaining day that is <= due date
          for (let j = remainingDateStrs.length - 1; j >= 0; j--) {
            if (remainingDateStrs[j] <= dueDate) {
              assignedIndex = j;
              break;
            }
          }
          // If due date is before all remaining days, assign to earliest
          if (assignedIndex === -1) assignedIndex = 0;
        }

        tasksPerDay[assignedIndex].push(task);
      }

      // Distribute tasks WITHOUT due dates round-robin, priority-sorted
      const sortedNoDue = [...tasksWithoutDueDate].sort(sortByPriority);
      sortedNoDue.forEach((task, index) => {
        const dayIndex = index % remainingDates.length;
        tasksPerDay[dayIndex].push(task);
      });

      // Sort each day's tasks by priority
      for (const dayTasks of tasksPerDay) {
        dayTasks.sort(sortByPriority);
      }

      // Generate schedule for each day
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
      setLoading(false);
    }
  };

  const generateScheduleForDay = async (date: string, dayTasks: Task[], hours: number) => {
    // Delete any existing schedule for this date first
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
      `${t.title} [Priority: ${t.priority}]${t.category ? ` [Category: ${t.category}]` : ''}${t.estimated_minutes ? ` [Est: ${t.estimated_minutes}min]` : ''}${t.due_date ? ` [Due: ${t.due_date}]` : ''}`
    );

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

STRUCTURE THE DAY AS FOLLOWS:
1. DEEP FOCUS block(s) — morning, uninterrupted 60-120min blocks for deep_focus tasks
2. ADMIN/MOTION block — batch admin tasks together, typically mid-day or after lunch
3. QUICK FOLLOW-UPS block — group quick tasks into a single sweep block (15-30min total)
4. Include 30min lunch break around midday
5. Include 5-10min breaks between themed blocks

RULES:
- Total work time: ${hours} hours
- Start: 9:00 AM
- Use each task's estimated duration for block sizing
- Tasks with imminent due dates should be prioritized
- DO NOT combine tasks — each task gets its own time slot within its block
- Quick tasks can share a themed block but each gets its own line item
- Use EXACT task titles from the list above (without the [Priority], [Category], [Est], or [Due] tags)
- For break blocks between themed sections, use title format: "Break — [next section type]" e.g. "Break — Admin block"

Return ONLY valid JSON:
{
  "blocks": [
    {"start_time": "09:00", "end_time": "10:30", "type": "task", "title": "exact task name", "category": "deep_focus", "estimated_duration": 90},
    {"start_time": "10:30", "end_time": "10:40", "type": "break", "title": "Break — Admin block", "estimated_duration": 10},
    {"start_time": "12:00", "end_time": "12:30", "type": "lunch", "title": "Lunch break", "estimated_duration": 30}
  ]
}`
        }]
      })
    });

    const data = await response.json();
    const text = data.content[0].text.replace(/```json\n?|\n?```/g, '').trim();
    const schedule = JSON.parse(text);

    // Create schedule
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

    // Create schedule items
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
    high: { dot: 'bg-[#c49286]', text: 'text-[#c49286]', label: 'High', border: 'border-l-[#c49286]' },
    medium: { dot: 'bg-[#b8a078]', text: 'text-[#b8a078]', label: 'Medium', border: 'border-l-[#b8a078]' },
    low: { dot: 'bg-[#8a967e]', text: 'text-[#8a967e]', label: 'Low', border: 'border-l-[#8a967e]' },
  };

  const categoryConfig = {
    deep_focus: { color: '#c49286', label: 'Deep Focus', bg: 'bg-[#c49286]/10', text: 'text-[#c49286]', border: 'border-[#c49286]/20' },
    admin: { color: '#b8a078', label: 'Admin', bg: 'bg-[#b8a078]/10', text: 'text-[#b8a078]', border: 'border-[#b8a078]/20' },
    quick: { color: '#8a967e', label: 'Quick', bg: 'bg-[#8a967e]/10', text: 'text-[#8a967e]', border: 'border-[#8a967e]/20' },
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

  return (
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
            const isSelected = format(selectedDate, 'yyyy-MM-dd') === dateStr;
            const isTodayDate = isToday(date);

            return (
              <div key={dateStr} className="flex flex-col items-center gap-2 min-w-0">
                <button
                  onClick={() => setSelectedDate(date)}
                  className={`relative px-5 py-3 rounded-lg transition-all duration-150 min-w-[100px] ${
                    isSelected
                      ? 'bg-white text-black'
                      : 'bg-white/[0.03] border border-white/[0.06] text-slate-500 hover:bg-white/[0.06] hover:text-slate-300'
                  }`}
                >
                  <div className="text-xs font-medium uppercase tracking-wider">{format(date, 'EEE')}</div>
                  <div className="text-lg font-bold mt-0.5">{format(date, 'MMM d')}</div>
                  {isTodayDate && (
                    <div className={`absolute -top-1 -right-1 w-2 h-2 rounded-full ${isSelected ? 'bg-black ring-2 ring-white' : 'bg-white'}`} />
                  )}
                </button>
                <div className="flex items-center gap-0.5">
                  {[4, 5, 6, 7, 8].map(h => (
                    <button
                      key={h}
                      onClick={() => handleWorkHoursChange(dateStr, h)}
                      className={`w-7 h-7 rounded text-xs font-medium transition-all duration-150 ${
                        (workHours[dateStr] || 6) === h
                          ? 'bg-white/10 text-white'
                          : 'text-slate-600 hover:text-slate-400'
                      }`}
                    >
                      {h}h
                    </button>
                  ))}
                </div>
              </div>
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
                    const cc = task.category ? categoryConfig[task.category as keyof typeof categoryConfig] : null;
                    const isOverdue = task.due_date && task.due_date < format(new Date(), 'yyyy-MM-dd');
                    const isDueToday = task.due_date && task.due_date === format(new Date(), 'yyyy-MM-dd');
                    const isEditing = editingTaskId === task.id;
                    return (
                      <div
                        key={task.id}
                        className={`group bg-white/[0.02] border border-white/[0.05] border-l-2 ${pc.border} rounded-lg pl-3.5 pr-3 py-2.5 card-hover`}
                      >
                        <div className="flex justify-between items-start gap-2">
                          <div className="flex-1 min-w-0">
                            {isEditing ? (
                              <input
                                autoFocus
                                value={editingTitle}
                                onChange={(e) => setEditingTitle(e.target.value)}
                                onBlur={() => handleTitleEdit(task.id, editingTitle)}
                                onKeyDown={(e) => {
                                  if (e.key === 'Enter') handleTitleEdit(task.id, editingTitle);
                                  if (e.key === 'Escape') setEditingTaskId(null);
                                }}
                                className="w-full font-medium text-slate-200 text-sm leading-snug bg-white/[0.05] border border-white/[0.1] rounded px-1.5 py-0.5 focus:outline-none focus:ring-1 focus:ring-white/20"
                              />
                            ) : (
                              <div
                                className="font-medium text-slate-200 text-sm leading-snug cursor-text hover:text-white transition-colors"
                                onClick={() => { setEditingTaskId(task.id); setEditingTitle(task.title); }}
                              >
                                {task.title}
                              </div>
                            )}
                            {task.description && (
                              <div className="text-xs text-slate-600 mt-0.5 line-clamp-1">
                                {task.description}
                              </div>
                            )}
                          </div>
                          <button
                            onClick={() => handleDeleteTask(task.id)}
                            className="p-1 rounded text-slate-700 hover:text-slate-400 transition-colors opacity-0 group-hover:opacity-100 flex-shrink-0"
                          >
                            <svg xmlns="http://www.w3.org/2000/svg" className="h-3.5 w-3.5" viewBox="0 0 20 20" fill="currentColor">
                              <path fillRule="evenodd" d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z" clipRule="evenodd" />
                            </svg>
                          </button>
                        </div>
                        <div className="flex gap-1.5 items-center mt-2 flex-wrap">
                          <select
                            value={task.priority}
                            onChange={(e) => handleChangePriority(task.id, e.target.value as any)}
                            className={`text-[11px] px-1.5 py-0.5 rounded bg-white/[0.03] border border-white/[0.06] ${pc.text} cursor-pointer focus:outline-none transition-all`}
                          >
                            <option value="high">High</option>
                            <option value="medium">Medium</option>
                            <option value="low">Low</option>
                          </select>
                          <select
                            value={task.category || ''}
                            onChange={(e) => handleCategoryChange(task.id, e.target.value as any)}
                            className={`text-[11px] px-1.5 py-0.5 rounded bg-white/[0.03] border border-white/[0.06] ${cc ? cc.text : 'text-slate-600'} cursor-pointer focus:outline-none transition-all`}
                          >
                            <option value="">Category</option>
                            <option value="deep_focus">Deep Focus</option>
                            <option value="admin">Admin</option>
                            <option value="quick">Quick</option>
                          </select>
                          <select
                            value={task.estimated_minutes || ''}
                            onChange={(e) => handleEstimatedMinutesChange(task.id, parseInt(e.target.value))}
                            className="text-[11px] px-1.5 py-0.5 rounded bg-white/[0.03] border border-white/[0.06] text-slate-500 cursor-pointer focus:outline-none transition-all"
                          >
                            <option value="">Est.</option>
                            {[5, 10, 15, 30, 45, 60, 90, 120].map(m => (
                              <option key={m} value={m}>{m}m</option>
                            ))}
                          </select>
                          {task.due_date ? (
                            <label className={`relative text-[11px] px-1.5 py-0.5 rounded cursor-pointer transition-all ${
                              isOverdue
                                ? 'bg-[#c49286]/10 text-[#c49286] border border-[#c49286]/20'
                                : isDueToday
                                ? 'bg-[#b8a078]/10 text-[#b8a078] border border-[#b8a078]/20'
                                : 'bg-white/[0.03] text-slate-500 border border-white/[0.06] hover:border-white/10'
                            }`}>
                              {isOverdue ? 'Overdue' : isDueToday ? 'Today' : format(new Date(task.due_date + 'T00:00:00'), 'MMM d')}
                              <input
                                type="date"
                                value={task.due_date}
                                onChange={(e) => handleDueDateChange(task.id, e.target.value)}
                                className="absolute inset-0 opacity-0 cursor-pointer [color-scheme:dark]"
                              />
                            </label>
                          ) : (
                            <label className="relative text-[11px] px-1.5 py-0.5 rounded bg-white/[0.02] text-slate-700 border border-white/[0.04] cursor-pointer hover:text-slate-500 hover:border-white/[0.08] transition-all">
                              + date
                              <input
                                type="date"
                                value=""
                                onChange={(e) => handleDueDateChange(task.id, e.target.value)}
                                className="absolute inset-0 opacity-0 cursor-pointer [color-scheme:dark]"
                              />
                            </label>
                          )}
                        </div>
                      </div>
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
                    {currentSchedule?.items?.length || 0} scheduled items
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
                <div className="text-center py-16 animate-fade-in">
                  <p className="text-slate-600 text-sm">No schedule yet</p>
                  <p className="text-xs text-slate-700 mt-1">Add tasks and generate a schedule to get started</p>
                </div>
              ) : (
                <div className="space-y-3">
                  {(() => {
                    // Group items into blocks separated by breaks/lunch
                    const items = currentSchedule.items || [];
                    const groups: { tasks: ScheduleItem[]; separator?: ScheduleItem }[] = [];
                    let currentGroup: ScheduleItem[] = [];

                    items.forEach((item) => {
                      if (item.item_type === 'break' || item.item_type === 'lunch') {
                        if (currentGroup.length > 0) {
                          groups.push({ tasks: currentGroup, separator: item });
                          currentGroup = [];
                        } else {
                          groups.push({ tasks: [], separator: item });
                        }
                      } else {
                        currentGroup.push(item);
                      }
                    });
                    if (currentGroup.length > 0) {
                      groups.push({ tasks: currentGroup });
                    }

                    // Infer category for a group from its tasks
                    const inferGroupCategory = (groupTasks: ScheduleItem[]) => {
                      for (const item of groupTasks) {
                        if (item.task?.category) return item.task.category;
                      }
                      return null;
                    };

                    return groups.map((group, groupIndex) => {
                      const groupCategory = group.tasks.length > 0 ? inferGroupCategory(group.tasks) : null;
                      const gc = groupCategory ? categoryConfig[groupCategory as keyof typeof categoryConfig] : null;

                      return (
                        <div key={groupIndex}>
                          {/* Task block */}
                          {group.tasks.length > 0 && (
                            <div className="bg-white/[0.03] border border-white/[0.06] rounded-xl overflow-hidden">
                              {/* Category header */}
                              {gc && (
                                <div className={`px-4 py-1.5 border-b border-white/[0.04] ${gc.bg}`}>
                                  <span className={`text-[11px] font-semibold uppercase tracking-wider ${gc.text}`}>
                                    {gc.label}
                                  </span>
                                </div>
                              )}
                              {group.tasks.map((item, itemIndex) => {
                                const priority = item.task?.priority || 'low';
                                const pc = priorityConfig[priority as keyof typeof priorityConfig] || priorityConfig.low;

                                return (
                                  <div
                                    key={item.id}
                                    className={`flex items-center gap-3 px-4 py-3 transition-all duration-150 hover:bg-white/[0.02] ${
                                      itemIndex > 0 || gc ? 'border-t border-white/[0.04]' : ''
                                    } ${item.completed ? 'opacity-40' : ''}`}
                                  >
                                    {/* Priority dot */}
                                    <div className={`w-2 h-2 rounded-full ${pc.dot} flex-shrink-0`} />

                                    {/* Content */}
                                    <div className="flex-1 min-w-0">
                                      <div className={`text-sm font-medium ${
                                        item.completed ? 'line-through text-slate-600' : 'text-slate-200'
                                      }`}>
                                        {item.title}
                                      </div>
                                      <div className="flex items-center gap-1.5 mt-0.5">
                                        <span className="text-[11px] text-slate-600 font-mono">{item.start_time} - {item.end_time}</span>
                                        <span className={`text-[11px] ${pc.text}`}>{pc.label}</span>
                                      </div>
                                    </div>

                                    {/* Checkbox */}
                                    <input
                                      type="checkbox"
                                      checked={item.completed}
                                      onChange={() => handleCompleteTask(item.id, item.task_id || null, item.completed)}
                                      className="custom-checkbox flex-shrink-0"
                                    />
                                  </div>
                                );
                              })}
                            </div>
                          )}

                          {/* Break / Lunch block */}
                          {group.separator && (
                            <div className={`rounded-xl px-4 py-3 border ${
                              group.separator.item_type === 'lunch'
                                ? 'bg-[#b8a078]/[0.04] border-[#b8a078]/10'
                                : 'bg-white/[0.02] border-white/[0.04]'
                            }`}>
                              <div className="flex items-center justify-between">
                                <div className="flex items-center gap-2">
                                  <span className={`text-sm font-medium ${
                                    group.separator.item_type === 'lunch' ? 'text-[#b8a078]' : 'text-slate-500'
                                  }`}>
                                    {group.separator.title}
                                  </span>
                                </div>
                                <span className="text-[11px] text-slate-600 font-mono">
                                  {group.separator.start_time} - {group.separator.end_time}
                                </span>
                              </div>
                            </div>
                          )}
                        </div>
                      );
                    });
                  })()}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
