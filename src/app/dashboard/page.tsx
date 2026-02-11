// src/app/dashboard/page.tsx
'use client';

import { useState, useEffect } from 'react';
import { supabase } from '@/lib/supabase';
import { Task, Schedule } from '@/types';
import { format, addDays, startOfWeek, isWeekend } from 'date-fns';

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
          content: `Parse these tasks into a JSON array. Each task should have: title (string), description (optional string), priority ('high'|'medium'|'low').
          
CRITICAL: Preserve the EXACT original wording. Do not paraphrase, shorten, or rewrite task titles.

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

  const handleCompleteTask = async (itemId: string, taskId: string | null) => {
    // Mark schedule item as completed
    await supabase
      .from('schedule_items')
      .update({ completed: true })
      .eq('id', itemId);

    // If it has a task, mark task as completed
    if (taskId) {
      await supabase
        .from('tasks')
        .update({ 
          status: 'completed',
          completed_at: new Date().toISOString()
        })
        .eq('id', taskId);
    }

    await loadScheduleForDate(selectedDate);
    await loadPendingTasks();
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

      // Sort and distribute tasks
      const highPriority = tasks.filter(t => t.priority === 'high');
      const mediumPriority = tasks.filter(t => t.priority === 'medium');
      const lowPriority = tasks.filter(t => t.priority === 'low');
      const sortedTasks = [...highPriority, ...mediumPriority, ...lowPriority];
      
      const tasksPerDay: Task[][] = remainingDates.map(() => []);
      sortedTasks.forEach((task, index) => {
        const dayIndex = index % remainingDates.length;
        tasksPerDay[dayIndex].push(task);
      });

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
          content: `Generate a ${hours}-hour work schedule for ${date}.

TASKS:
${taskDescriptions.map((t, i) => `${i + 1}. ${t}`).join('\n')}

REQUIREMENTS:
- Total work time: ${hours} hours
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

  if (!user) {
    return (
      <div className="min-h-screen bg-gray-900 flex items-center justify-center">
        <div className="text-center">
          <h1 className="text-2xl text-white mb-4">Please sign in</h1>
          <a href="/" className="text-indigo-400 hover:text-indigo-300">
            Go to login
          </a>
        </div>
      </div>
    );
  }

  const weekDates = getWeekDates();

  return (
    <div className="min-h-screen bg-gray-900 text-white">
      <div className="max-w-7xl mx-auto p-6">
        {/* Header */}
        <div className="flex justify-between items-center mb-8">
          <h1 className="text-3xl font-bold">Work Scheduler</h1>
          <button
            onClick={handleSignOut}
            className="px-4 py-2 bg-gray-800 hover:bg-gray-700 rounded transition"
          >
            Sign Out
          </button>
        </div>

        {/* Week Navigation */}
        <div className="grid grid-cols-5 gap-4 mb-8">
          {weekDates.map((date) => {
            const dateStr = format(date, 'yyyy-MM-dd');
            const isSelected = format(selectedDate, 'yyyy-MM-dd') === dateStr;
            
            return (
              <div key={dateStr} className="text-center">
                <button
                  onClick={() => setSelectedDate(date)}
                  className={`w-full p-4 rounded-lg transition ${
                    isSelected
                      ? 'bg-indigo-600 text-white'
                      : 'bg-gray-800 text-gray-300 hover:bg-gray-700'
                  }`}
                >
                  <div className="text-sm">{format(date, 'EEE')}</div>
                  <div className="text-lg font-bold">{format(date, 'MMM d')}</div>
                </button>
                <select
                  value={workHours[dateStr] || 6}
                  onChange={(e) => setWorkHours({ ...workHours, [dateStr]: Number(e.target.value) })}
                  className="w-full mt-2 p-2 bg-gray-800 text-white rounded text-sm"
                >
                  {[4, 5, 6, 7, 8].map(h => (
                    <option key={h} value={h}>{h} hours</option>
                  ))}
                </select>
              </div>
            );
          })}
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Left Column */}
          <div className="space-y-6">
            {/* Add Tasks */}
            <div className="bg-gray-800 rounded-lg p-6">
              <h2 className="text-xl font-semibold mb-4">Add Tasks</h2>
              <textarea
                value={taskInput}
                onChange={(e) => setTaskInput(e.target.value)}
                placeholder="Enter tasks (one per line or describe naturally)"
                className="w-full p-3 bg-gray-700 text-white rounded mb-4 h-32 resize-none"
                disabled={loading}
              />
              <button
                onClick={handleAddTasks}
                disabled={loading || !taskInput.trim()}
                className="w-full bg-indigo-600 hover:bg-indigo-700 disabled:bg-gray-600 text-white py-3 rounded transition font-medium"
              >
                {loading ? 'Processing...' : 'Add Tasks'}
              </button>
            </div>

            {/* Pending Tasks */}
            <div className="bg-gray-800 rounded-lg p-6">
              <h2 className="text-xl font-semibold mb-4">
                Pending Tasks
                <span className="text-sm text-gray-400 ml-2">{tasks.length} tasks</span>
              </h2>
              <div className="space-y-3 max-h-96 overflow-y-auto">
                {tasks.map((task) => (
                  <div key={task.id} className="bg-gray-700 rounded p-4">
                    <div className="flex justify-between items-start">
                      <div className="flex-1">
                        <div className="font-medium text-white mb-2">{task.title}</div>
                        {task.description && (
                          <div className="text-sm text-gray-400 mt-1 mb-2">
                            {task.description}
                          </div>
                        )}
                        <div className="flex gap-2 items-center">
                          <select
                            value={task.priority}
                            onChange={(e) => handleChangePriority(task.id, e.target.value as any)}
                            className={`text-xs px-2 py-1 rounded border ${
                              task.priority === 'high'
                                ? 'bg-red-100 text-red-700 border-red-300'
                                : task.priority === 'medium'
                                ? 'bg-yellow-100 text-yellow-700 border-yellow-300'
                                : 'bg-green-100 text-green-700 border-green-300'
                            }`}
                          >
                            <option value="high">High Priority</option>
                            <option value="medium">Medium Priority</option>
                            <option value="low">Low Priority</option>
                          </select>
                        </div>
                      </div>
                      <button
                        onClick={() => handleDeleteTask(task.id)}
                        className="ml-3 text-gray-400 hover:text-red-500 transition"
                      >
                        <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" viewBox="0 0 20 20" fill="currentColor">
                          <path fillRule="evenodd" d="M9 2a1 1 0 00-.894.553L7.382 4H4a1 1 0 000 2v10a2 2 0 002 2h8a2 2 0 002-2V6a1 1 0 100-2h-3.382l-.724-1.447A1 1 0 0011 2H9zM7 8a1 1 0 012 0v6a1 1 0 11-2 0V8zm5-1a1 1 0 00-1 1v6a1 1 0 102 0V8a1 1 0 00-1-1z" clipRule="evenodd" />
                        </svg>
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>

          {/* Right Column - Schedule */}
          <div className="lg:col-span-2">
            <div className="bg-gray-800 rounded-lg p-6">
              <div className="flex justify-between items-center mb-6">
                <h2 className="text-xl font-semibold">
                  Schedule for {format(selectedDate, 'EEEE, MMMM d')}
                </h2>
                <button
                  onClick={handleGenerateSchedule}
                  disabled={loading || tasks.length === 0}
                  className="px-6 py-2 bg-green-600 hover:bg-green-700 disabled:bg-gray-600 rounded transition"
                >
                  {loading ? 'Generating...' : 'Generate Today Forward'}
                </button>
              </div>

              {!currentSchedule ? (
                <div className="text-center py-12 text-gray-400">
                  <p>No schedule generated yet</p>
                  <p className="text-sm mt-2">Add tasks and click "Generate Schedule"</p>
                </div>
              ) : (
                <div className="space-y-3">
                  {currentSchedule.items?.map((item) => {
                    const priorityColors = {
                      high: 'border-red-500 bg-red-900/30',
                      medium: 'border-yellow-500 bg-yellow-900/30',
                      low: 'border-indigo-500 bg-indigo-900/30',
                    };
                    
                    const typeColors = {
                      lunch: 'border-green-500 bg-green-900/30',
                      break: 'border-gray-500 bg-gray-700/30',
                      task: ''
                    };

                    const priority = item.task?.priority || 'low';
                    const colorClass = item.item_type === 'task' 
                      ? priorityColors[priority]
                      : typeColors[item.item_type as keyof typeof typeColors];

                    return (
                      <div
                        key={item.id}
                        className={`p-4 rounded-lg border-l-4 ${colorClass}`}
                      >
                        <div className="flex justify-between items-start">
                          <div className="flex-1">
                            <div className="flex items-center gap-2">
                              <span className="font-medium">{item.start_time} - {item.end_time}</span>
                              {item.item_type === 'task' && item.task && (
                                <span className={`text-xs px-2 py-0.5 rounded ${
                                  priority === 'high'
                                    ? 'bg-red-100 text-red-700'
                                    : priority === 'medium'
                                    ? 'bg-yellow-100 text-yellow-700'
                                    : 'bg-green-100 text-green-700'
                                }`}>
                                  {priority}
                                </span>
                              )}
                            </div>
                            <div className="text-lg mt-1">{item.title}</div>
                          </div>
                          {item.item_type === 'task' && !item.completed && (
                            <button
                              onClick={() => handleCompleteTask(item.id, item.task_id || null)}
                              className="ml-3 px-3 py-1 bg-green-600 hover:bg-green-700 text-white text-sm rounded transition"
                            >
                              Complete
                            </button>
                          )}
                          {item.completed && (
                            <span className="ml-3 text-green-400 text-sm">✓ Done</span>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
