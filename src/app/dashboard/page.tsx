// src/app/dashboard/page.tsx
'use client';

import { useState, useEffect } from 'react';
import { supabase } from '@/lib/supabase';
import { Task, Schedule } from '@/types';
import { format, addDays, startOfWeek, isWeekend, isToday } from 'date-fns';

export default function Dashboard() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [currentSchedule, setCurrentSchedule] = useState<Schedule | null>(null);
  const [selectedDate, setSelectedDate] = useState(new Date());
  const [taskInput, setTaskInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [user, setUser] = useState<any>(null);
  const [workHours, setWorkHours] = useState<Record<string, number>>({});

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
          content: `Parse these tasks into a JSON array. Each task should have: title (string), description (optional string), priority ('high'|'medium'|'low'), due_date (optional string in YYYY-MM-DD format or null).

Today's date is ${format(new Date(), 'yyyy-MM-dd')} (${format(new Date(), 'EEEE')}).

RULES:
- Preserve the EXACT original wording for the title. Do not paraphrase, shorten, or rewrite task titles. Strip any deadline phrase from the title (e.g. "Review PRs by Wednesday" → title: "Review PRs", due_date: next Wednesday).
- Extract due dates from natural language: "by Wednesday", "due Friday", "before March 5", "tomorrow", etc.
- Resolve relative dates (e.g. "Wednesday" means the NEXT upcoming Wednesday relative to today).
- If no deadline is mentioned, set due_date to null.

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

    if (existingSchedule) {
      // Schedule exists, ask if they want to regenerate
      const shouldRegenerate = confirm(
        `This day already has a schedule. Regenerate with ${newHours} hours?`
      );

      if (shouldRegenerate) {
        setLoading(true);
        try {
          // Delete old schedule items
          const { error: deleteItemsError } = await supabase
            .from('schedule_items')
            .delete()
            .eq('schedule_id', existingSchedule.id);

          if (deleteItemsError) {
            console.error('Error deleting schedule items:', deleteItemsError);
            throw deleteItemsError;
          }

          // Get tasks to schedule
          const tasksToSchedule = tasks.length > 0 ? tasks : [];

          if (tasksToSchedule.length === 0) {
            alert('No tasks available to schedule');
            setLoading(false);
            return;
          }

          // Generate new schedule with AI
          const taskDescriptions = tasksToSchedule.map(t =>
            `${t.title}${t.description ? ` - ${t.description}` : ''} [Priority: ${t.priority}]`
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

REQUIREMENTS:
- Total work time: ${newHours} hours
- Start: 9:00 AM
- Include 30min lunch break around midday
- Include 5-10min breaks every 60-90min
- High-priority tasks in morning
- DO NOT combine tasks - each task gets its own block
- Use EXACT task titles from the list above

Return ONLY valid JSON:
{
  "blocks": [
    {"start_time": "09:00", "end_time": "10:30", "type": "task", "title": "exact task name", "estimated_duration": 90},
    {"start_time": "10:30", "end_time": "10:40", "type": "break", "title": "Short break", "estimated_duration": 10},
    {"start_time": "12:00", "end_time": "12:30", "type": "lunch", "title": "Lunch break", "estimated_duration": 30}
  ]
}`
              }]
            })
          });

          const data = await response.json();
          const text = data.content[0].text.replace(/```json\n?|\n?```/g, '').trim();
          const schedule = JSON.parse(text);

          // Update existing schedule with new data
          const { error: updateError } = await supabase
            .from('schedules')
            .update({
              schedule_data: {
                total_hours: newHours,
                work_blocks: schedule.blocks.filter((b: any) => b.type === 'task').length,
                break_blocks: schedule.blocks.filter((b: any) => b.type !== 'task').length
              }
            })
            .eq('id', existingSchedule.id);

          if (updateError) {
            console.error('Error updating schedule:', updateError);
            throw updateError;
          }

          // Create new schedule items
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

          const { error: insertError } = await supabase
            .from('schedule_items')
            .insert(items);

          if (insertError) {
            console.error('Error inserting schedule items:', insertError);
            throw insertError;
          }

          // Reload schedule
          if (format(selectedDate, 'yyyy-MM-dd') === dateStr) {
            await loadScheduleForDate(selectedDate);
          }

          alert(`Schedule regenerated with ${newHours} hours!`);
        } catch (error) {
          console.error('Error regenerating schedule:', error);
          alert('Failed to regenerate schedule');
        } finally {
          setLoading(false);
        }
      }
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
    const taskDescriptions = dayTasks.map(t =>
      `${t.title}${t.description ? ` - ${t.description}` : ''} [Priority: ${t.priority}]${t.due_date ? ` [Due: ${t.due_date}]` : ''}`
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

REQUIREMENTS:
- Total work time: ${hours} hours
- Start: 9:00 AM
- Include 30min lunch break around midday
- Include 5-10min breaks every 60-90min
- High-priority tasks in morning
- Tasks with imminent due dates should be prioritized even over other high-priority tasks
- DO NOT combine tasks - each task gets its own block
- Use EXACT task titles from the list above (without the [Priority] or [Due] tags)

Return ONLY valid JSON:
{
  "blocks": [
    {"start_time": "09:00", "end_time": "10:30", "type": "task", "title": "exact task name", "estimated_duration": 90},
    {"start_time": "10:30", "end_time": "10:40", "type": "break", "title": "Short break", "estimated_duration": 10},
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
    high: { dot: 'bg-red-400', text: 'text-red-400', label: 'High', border: 'border-l-red-400' },
    medium: { dot: 'bg-amber-400', text: 'text-amber-400', label: 'Medium', border: 'border-l-amber-400' },
    low: { dot: 'bg-sky-400', text: 'text-sky-400', label: 'Low', border: 'border-l-sky-400' },
  };

  if (!user) {
    return (
      <div className="min-h-screen bg-[#050507] flex items-center justify-center">
        <div className="text-center animate-fade-in">
          <div className="inline-block mb-6">
            <div className="w-10 h-10 border-2 border-indigo-500 border-t-transparent rounded-full animate-spin-slow" />
          </div>
          <h1 className="text-2xl text-white mb-4">Please sign in</h1>
          <a href="/" className="text-indigo-400 hover:text-indigo-300 transition-colors">
            Go to login
          </a>
        </div>
      </div>
    );
  }

  const weekDates = getWeekDates();

  return (
    <div className="min-h-screen bg-[#050507] text-white relative">
      {/* Background gradients */}
      <div className="fixed inset-0 bg-[radial-gradient(ellipse_at_top_left,_rgba(99,102,241,0.08)_0%,_transparent_50%)] pointer-events-none" />
      <div className="fixed inset-0 bg-[radial-gradient(ellipse_at_bottom_right,_rgba(139,92,246,0.06)_0%,_transparent_50%)] pointer-events-none" />

      {/* Loading overlay */}
      {loading && (
        <div className="fixed inset-0 z-50 bg-black/50 backdrop-blur-sm flex items-center justify-center">
          <div className="glass-card p-8 flex flex-col items-center gap-4 animate-fade-in">
            <div className="w-10 h-10 border-2 border-indigo-500 border-t-transparent rounded-full animate-spin-slow" />
            <p className="text-slate-300 text-sm">Processing...</p>
          </div>
        </div>
      )}

      <div className="relative z-10 max-w-7xl mx-auto p-6">
        {/* Header */}
        <div className="flex justify-between items-center mb-8">
          <h1 className="text-3xl font-bold bg-gradient-to-r from-indigo-400 to-violet-400 bg-clip-text text-transparent">
            TaskFlow
          </h1>
          <button
            onClick={handleSignOut}
            className="px-4 py-2 rounded-lg border border-white/10 text-slate-300 hover:text-white hover:border-white/20 hover:bg-white/5 transition-all duration-200 text-sm"
          >
            Sign Out
          </button>
        </div>

        {/* Week Navigation */}
        <div className="flex gap-3 mb-8 overflow-x-auto pb-2">
          {weekDates.map((date) => {
            const dateStr = format(date, 'yyyy-MM-dd');
            const isSelected = format(selectedDate, 'yyyy-MM-dd') === dateStr;
            const isTodayDate = isToday(date);

            return (
              <div key={dateStr} className="flex flex-col items-center gap-2 min-w-0">
                <button
                  onClick={() => setSelectedDate(date)}
                  className={`relative px-5 py-3 rounded-xl transition-all duration-200 min-w-[100px] ${
                    isSelected
                      ? 'gradient-btn text-white shadow-lg shadow-indigo-500/20'
                      : 'bg-white/5 border border-white/8 text-slate-400 hover:bg-white/10 hover:text-white'
                  }`}
                >
                  <div className="text-xs font-medium uppercase tracking-wider">{format(date, 'EEE')}</div>
                  <div className="text-lg font-bold mt-0.5">{format(date, 'MMM d')}</div>
                  {isTodayDate && (
                    <div className="absolute -top-1 -right-1 w-2.5 h-2.5 bg-emerald-400 rounded-full shadow-lg shadow-emerald-400/50" />
                  )}
                </button>
                {/* Styled hour selector */}
                <div className="flex items-center gap-1">
                  {[4, 5, 6, 7, 8].map(h => (
                    <button
                      key={h}
                      onClick={() => handleWorkHoursChange(dateStr, h)}
                      className={`w-7 h-7 rounded-md text-xs font-medium transition-all duration-200 ${
                        (workHours[dateStr] || 6) === h
                          ? 'bg-indigo-500/30 text-indigo-300 border border-indigo-500/40'
                          : 'text-slate-500 hover:text-slate-300 hover:bg-white/5'
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
            <div className="glass-card p-6 animate-fade-in">
              <h2 className="text-lg font-semibold text-white mb-4">Add Tasks</h2>
              <textarea
                value={taskInput}
                onChange={(e) => setTaskInput(e.target.value)}
                placeholder="Describe your tasks naturally...&#10;e.g. Review PRs (high priority)&#10;Write documentation&#10;Fix login bug"
                className="w-full p-3.5 bg-white/5 border border-white/10 text-white rounded-lg mb-4 h-32 resize-none placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/50 focus:border-indigo-500/50 transition-all duration-200 text-sm"
                disabled={loading}
              />
              <button
                onClick={handleAddTasks}
                disabled={loading || !taskInput.trim()}
                className="gradient-btn w-full text-white py-3 rounded-lg font-medium text-sm"
              >
                Add Tasks
              </button>
            </div>

            {/* Pending Tasks */}
            <div className="glass-card p-6 animate-fade-in">
              <div className="flex items-center justify-between mb-4">
                <h2 className="text-lg font-semibold text-white">Pending Tasks</h2>
                <span className="text-xs text-slate-400 bg-white/5 px-2.5 py-1 rounded-full">
                  {tasks.length} tasks
                </span>
              </div>
              <div className="space-y-2.5 max-h-96 overflow-y-auto pr-1">
                {tasks.length === 0 ? (
                  <div className="text-center py-8 text-slate-500">
                    <svg className="w-8 h-8 mx-auto mb-2 opacity-50" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
                    </svg>
                    <p className="text-sm">No tasks yet</p>
                  </div>
                ) : (
                  tasks.map((task) => {
                    const pc = priorityConfig[task.priority as keyof typeof priorityConfig] || priorityConfig.medium;
                    const isOverdue = task.due_date && task.due_date < format(new Date(), 'yyyy-MM-dd');
                    const isDueToday = task.due_date && task.due_date === format(new Date(), 'yyyy-MM-dd');
                    return (
                      <div
                        key={task.id}
                        className={`group bg-white/[0.03] border border-white/[0.06] border-l-2 ${pc.border} rounded-lg pl-3.5 pr-3 py-3 glow-border`}
                      >
                        <div className="flex justify-between items-start gap-2">
                          <div className="flex-1 min-w-0">
                            <div className="font-medium text-white text-sm leading-snug">{task.title}</div>
                            {task.description && (
                              <div className="text-xs text-slate-500 mt-0.5 line-clamp-1">
                                {task.description}
                              </div>
                            )}
                          </div>
                          <button
                            onClick={() => handleDeleteTask(task.id)}
                            className="p-1 rounded-md text-slate-600 hover:text-red-400 hover:bg-red-400/10 transition-all duration-200 opacity-0 group-hover:opacity-100 flex-shrink-0"
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
                            className={`text-[11px] px-1.5 py-0.5 rounded-full bg-white/5 border border-white/10 ${pc.text} cursor-pointer focus:outline-none focus:ring-1 focus:ring-indigo-500/50 transition-all`}
                          >
                            <option value="high">High</option>
                            <option value="medium">Medium</option>
                            <option value="low">Low</option>
                          </select>
                          {task.due_date ? (
                            <label className={`relative text-[11px] px-1.5 py-0.5 rounded-full cursor-pointer transition-all ${
                              isOverdue
                                ? 'bg-red-500/10 text-red-400 border border-red-500/20'
                                : isDueToday
                                ? 'bg-amber-500/10 text-amber-400 border border-amber-500/20'
                                : 'bg-white/5 text-slate-400 border border-white/10 hover:border-white/20'
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
                            <label className="relative text-[11px] px-1.5 py-0.5 rounded-full bg-white/5 text-slate-600 border border-white/[0.06] cursor-pointer hover:text-slate-400 hover:border-white/10 transition-all">
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
                  <p className="text-xs text-slate-400 mt-0.5">
                    {currentSchedule?.items?.length || 0} scheduled items
                  </p>
                </div>
                <button
                  onClick={handleGenerateSchedule}
                  disabled={loading || tasks.length === 0}
                  className="gradient-btn-green px-5 py-2.5 rounded-lg text-white text-sm font-medium"
                >
                  Generate Schedule
                </button>
              </div>

              {!currentSchedule ? (
                <div className="text-center py-16 animate-fade-in">
                  <svg className="w-12 h-12 mx-auto mb-4 text-slate-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1} d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
                  </svg>
                  <p className="text-slate-400 font-medium">No schedule yet</p>
                  <p className="text-sm text-slate-500 mt-1">Add tasks and generate a schedule to get started</p>
                </div>
              ) : (
                <div className="relative">
                  {/* Timeline line */}
                  <div className="absolute left-[23px] top-2 bottom-2 w-px bg-gradient-to-b from-indigo-500/30 via-violet-500/20 to-transparent" />

                  <div className="space-y-1.5">
                    {currentSchedule.items?.map((item, index) => {
                      const priority = item.task?.priority || 'low';
                      const pc = priorityConfig[priority as keyof typeof priorityConfig] || priorityConfig.low;

                      const isTask = item.item_type === 'task';
                      const isLunch = item.item_type === 'lunch';
                      const isBreak = item.item_type === 'break';

                      const dotColor = isTask
                        ? (priority === 'high' ? 'bg-red-400' : priority === 'medium' ? 'bg-amber-400' : 'bg-sky-400')
                        : isLunch
                        ? 'bg-emerald-400'
                        : 'bg-slate-500';

                      return (
                        <div
                          key={item.id}
                          className={`relative flex items-start gap-4 pl-2 py-2.5 pr-3 rounded-lg transition-all duration-200 ${
                            isTask ? 'hover:bg-white/[0.03]' : ''
                          } ${item.completed ? 'opacity-50' : ''}`}
                          style={{ animationDelay: `${index * 50}ms` }}
                        >
                          {/* Timeline dot */}
                          <div className="relative z-10 flex-shrink-0 mt-1.5">
                            <div className={`w-3 h-3 rounded-full ${dotColor} ring-4 ring-[#050507]`} />
                          </div>

                          {/* Content */}
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2 text-xs text-slate-400 mb-0.5">
                              <span className="font-mono">{item.start_time}</span>
                              <span className="text-slate-600">-</span>
                              <span className="font-mono">{item.end_time}</span>
                              {isTask && item.task && (
                                <span className={`flex items-center gap-1 ${pc.text}`}>
                                  <span className={`w-1 h-1 rounded-full ${pc.dot}`} />
                                  {pc.label}
                                </span>
                              )}
                              {isLunch && <span className="text-emerald-400">Lunch</span>}
                              {isBreak && <span className="text-slate-500">Break</span>}
                            </div>
                            <div className={`font-medium text-sm ${
                              item.completed ? 'line-through text-slate-500' :
                              isTask ? 'text-white' : 'text-slate-400'
                            }`}>
                              {item.title}
                            </div>
                          </div>

                          {/* Checkbox */}
                          {isTask && (
                            <div className="flex-shrink-0 mt-1">
                              <input
                                type="checkbox"
                                checked={item.completed}
                                onChange={() => handleCompleteTask(item.id, item.task_id || null, item.completed)}
                                className="custom-checkbox"
                              />
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
