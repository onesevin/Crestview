// src/app/dashboard/page.tsx
'use client';

import { useState, useEffect } from 'react';
import { supabase } from '@/lib/supabase';
import { authenticatedFetch } from '@/lib/api-client';
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
    const response = await authenticatedFetch('/api/tasks');
    const data = await response.json();
    setTasks(data.tasks || []);
  };

  const loadScheduleForDate = async (date: Date) => {
    // Skip weekends
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
      .eq('user_id', user.id)
      .eq('schedule_date', dateStr)
      .single();

    setCurrentSchedule(data);
  };

  const handleAddTasks = async () => {
    if (!taskInput.trim()) return;

    if (!user) {
      alert('Please log in to add tasks');
      return;
    }

    setLoading(true);
    try {
      const response = await authenticatedFetch('/api/tasks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ input: taskInput }),
      });

      const data = await response.json();

      if (response.ok) {
        if (data.hasDuplicates) {
          // Show duplicate confirmation dialog
          const duplicateList = data.duplicates
            .map((d: any, i: number) => 
              `${i + 1}. "${d.newTask.title}" (similar to existing: "${d.existingTask.title}")`
            )
            .join('\n');
          
          const message = `Found ${data.duplicates.length} potential duplicate(s):\n\n${duplicateList}\n\nAdd anyway?`;
          
          if (confirm(message)) {
            // User wants to add duplicates too
            const allTasks = [...data.uniqueTasks, ...data.duplicates.map((d: any) => d.newTask)];
            
            const confirmResponse = await authenticatedFetch('/api/tasks', {
              method: 'PUT',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ tasksToAdd: allTasks }),
            });
            
            if (confirmResponse.ok) {
              const confirmData = await confirmResponse.json();
              setTaskInput('');
              await loadPendingTasks();
              alert(`Successfully added ${confirmData.tasks.length} task(s)!`);
            }
          } else if (data.uniqueTasks.length > 0) {
            // User doesn't want duplicates, add only unique tasks
            const confirmResponse = await authenticatedFetch('/api/tasks', {
              method: 'PUT',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ tasksToAdd: data.uniqueTasks }),
            });
            
            if (confirmResponse.ok) {
              const confirmData = await confirmResponse.json();
              setTaskInput('');
              await loadPendingTasks();
              alert(`Added ${confirmData.tasks.length} task(s), skipped ${data.duplicates.length} duplicate(s)`);
            }
          } else {
            alert('No unique tasks to add.');
          }
        } else {
          // No duplicates, tasks were added successfully
          setTaskInput('');
          await loadPendingTasks();
          alert(`Successfully added ${data.tasks.length} task(s)!`);
        }
      } else {
        alert(`Error: ${data.error || 'Failed to add tasks'}`);
        console.error('API error:', data);
      }
    } catch (error) {
      console.error('Error adding tasks:', error);
      alert('Failed to add tasks. Check console for details.');
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
      
      // Get dates from today forward (remaining weekdays)
      const remainingDates = weekDates.filter(date => {
        const d = new Date(date);
        d.setHours(0, 0, 0, 0);
        return d >= today;
      });

      if (remainingDates.length === 0) {
        alert('No remaining days in this week to schedule!');
        setLoading(false);
        return;
      }

      // Distribute tasks across remaining days based on priority
      const highPriority = tasks.filter(t => t.priority === 'high');
      const mediumPriority = tasks.filter(t => t.priority === 'medium');
      const lowPriority = tasks.filter(t => t.priority === 'low');
      
      // Reorder: high first, then medium, then low
      const sortedTasks = [...highPriority, ...mediumPriority, ...lowPriority];
      
      // Distribute tasks evenly across days
      const tasksPerDay: string[][] = remainingDates.map(() => []);
      sortedTasks.forEach((task, index) => {
        const dayIndex = index % remainingDates.length;
        tasksPerDay[dayIndex].push(task.id);
      });

      // Generate schedule for each remaining day with its assigned tasks
      for (let i = 0; i < remainingDates.length; i++) {
        const date = remainingDates[i];
        const dateStr = format(date, 'yyyy-MM-dd');
        const hours = workHours[dateStr] || 6; // Default to 6 hours
        const dayTasks = tasksPerDay[i];
        
        if (dayTasks.length === 0) continue; // Skip days with no tasks
        
        const response = await authenticatedFetch('/api/generate-schedule', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            date: dateStr,
            taskIds: dayTasks,
            workHours: hours,
          }),
        });

        if (!response.ok) {
          console.error(`Failed to generate schedule for ${dateStr}`);
        }
      }

      // Reload the current date's schedule
      await loadScheduleForDate(selectedDate);
      await loadPendingTasks();
      
      alert(`Generated schedules from today through Friday!`);
    } catch (error) {
      console.error('Error generating schedules:', error);
      alert('Failed to generate schedules. Check console for details.');
    } finally {
      setLoading(false);
    }
  };

  const handleCompleteTask = async (taskId: string) => {
    const startTime = prompt('How many minutes did this task take?');
    if (!startTime) return;

    try {
      await authenticatedFetch('/api/tasks', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          taskId,
          actualDuration: parseInt(startTime),
        }),
      });

      await loadScheduleForDate(selectedDate);
      await loadPendingTasks();
    } catch (error) {
      console.error('Error completing task:', error);
    }
  };

  const handleRollover = async () => {
    const yesterday = addDays(selectedDate, -1);
    const dateStr = format(yesterday, 'yyyy-MM-dd');

    try {
      const response = await authenticatedFetch('/api/rollover', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ date: dateStr }),
      });

      if (response.ok) {
        await loadPendingTasks();
      }
    } catch (error) {
      console.error('Error rolling over tasks:', error);
    }
  };

  const handleDeleteTask = async (taskId: string) => {
    if (!confirm('Are you sure you want to delete this task?')) {
      return;
    }

    try {
      const response = await authenticatedFetch('/api/tasks', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ taskId }),
      });

      if (response.ok) {
        await loadPendingTasks();
        await loadScheduleForDate(selectedDate); // Reload schedule to reflect changes
      } else {
        alert('Failed to delete task');
      }
    } catch (error) {
      console.error('Error deleting task:', error);
      alert('Failed to delete task');
    }
  };

  const handleChangePriority = async (taskId: string, newPriority: 'high' | 'medium' | 'low') => {
    try {
      const response = await authenticatedFetch('/api/tasks/priority', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ taskId, priority: newPriority }),
      });

      if (response.ok) {
        await loadPendingTasks();
      } else {
        alert('Failed to update priority');
      }
    } catch (error) {
      console.error('Error updating priority:', error);
      alert('Failed to update priority');
    }
  };

  const getWeekDates = () => {
    const start = startOfWeek(selectedDate, { weekStartsOn: 1 }); // Monday
    return Array.from({ length: 5 }, (_, i) => addDays(start, i));
  };

  if (!user) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="text-center">
          <h2 className="text-2xl font-bold mb-4">Please log in</h2>
          <button
            onClick={() => window.location.href = '/login'}
            className="bg-indigo-600 text-white px-6 py-2 rounded-lg"
          >
            Go to Login
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-900 p-8">
      <div className="max-w-7xl mx-auto">
        <div className="flex justify-between items-center mb-8">
          <h1 className="text-3xl font-bold text-white">Work Scheduler</h1>
          <button
            onClick={() => supabase.auth.signOut()}
            className="text-gray-400 hover:text-white"
          >
            Sign Out
          </button>
        </div>

        {/* Week Navigation */}
        <div className="bg-gray-800 border border-gray-700 rounded-lg shadow-lg p-6 mb-6">
          <div className="space-y-4">
            <div className="flex gap-2">
              {getWeekDates().map((date) => {
                const dateStr = format(date, 'yyyy-MM-dd');
                const isSelected = dateStr === format(selectedDate, 'yyyy-MM-dd');
                
                return (
                  <div key={date.toISOString()} className="flex-1">
                    <button
                      onClick={() => setSelectedDate(date)}
                      className={`w-full py-3 px-4 rounded-t-lg transition ${
                        isSelected
                          ? 'bg-indigo-600 text-white'
                          : 'bg-gray-700 text-gray-300 hover:bg-gray-600'
                      }`}
                    >
                      <div className="text-sm">{format(date, 'EEE')}</div>
                      <div className="font-semibold">{format(date, 'MMM d')}</div>
                    </button>
                    <select
                      value={workHours[dateStr] || 6}
                      onChange={(e) => setWorkHours({
                        ...workHours,
                        [dateStr]: parseInt(e.target.value)
                      })}
                      className={`w-full py-2 px-2 text-sm rounded-b-lg border-t-0 ${
                        isSelected
                          ? 'bg-indigo-700 text-white border-indigo-600'
                          : 'bg-gray-700 text-gray-300 border-gray-600'
                      }`}
                    >
                      <option value="4">4 hours</option>
                      <option value="5">5 hours</option>
                      <option value="6">6 hours</option>
                      <option value="7">7 hours</option>
                      <option value="8">8 hours</option>
                    </select>
                  </div>
                );
              })}
            </div>
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Task Input */}
          <div className="lg:col-span-1">
            <div className="bg-gray-800 border border-gray-700 rounded-lg shadow-lg p-6 mb-6">
              <h2 className="text-xl font-semibold mb-4 text-white">Add Tasks</h2>
              <textarea
                value={taskInput}
                onChange={(e) => setTaskInput(e.target.value)}
                placeholder="Enter tasks in natural language, e.g.:&#10;- Review Q1 reports (high priority)&#10;- Team meeting at 2pm&#10;- Write blog post about productivity"
                className="w-full h-32 p-3 bg-gray-700 border border-gray-600 text-white placeholder-gray-400 rounded-lg mb-4 resize-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
              />
              <button
                onClick={handleAddTasks}
                disabled={loading}
                className="w-full bg-indigo-600 text-white py-2 rounded-lg hover:bg-indigo-700 disabled:opacity-50"
              >
                {loading ? 'Processing...' : 'Add Tasks'}
              </button>
            </div>

            {/* Pending Tasks */}
            <div className="bg-gray-800 border border-gray-700 rounded-lg shadow-lg p-6">
              <div className="flex justify-between items-center mb-4">
                <h2 className="text-xl font-semibold text-white">Pending Tasks</h2>
                <span className="text-sm text-gray-400">{tasks.length} tasks</span>
              </div>
              <div className="space-y-2 max-h-96 overflow-y-auto">
                {tasks.map((task) => (
                  <div
                    key={task.id}
                    className="p-3 bg-gray-700 border border-gray-600 rounded-lg hover:bg-gray-650"
                  >
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
                            onChange={(e) => handleChangePriority(task.id, e.target.value as 'high' | 'medium' | 'low')}
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
                          {task.status === 'rolled_over' && (
                            <span className="text-xs px-2 py-1 rounded bg-orange-100 text-orange-700">
                              Rolled over
                            </span>
                          )}
                        </div>
                      </div>
                      <button
                        onClick={() => handleDeleteTask(task.id)}
                        className="ml-3 text-gray-400 hover:text-red-500 transition"
                        title="Delete task"
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

          {/* Schedule Display */}
          <div className="lg:col-span-2">
            <div className="bg-gray-800 border border-gray-700 rounded-lg shadow-lg p-6">
              <div className="flex justify-between items-center mb-6">
                <h2 className="text-xl font-semibold text-white">
                  Schedule for {format(selectedDate, 'EEEE, MMMM d')}
                </h2>
                <div className="flex gap-2">
                  <button
                    onClick={handleRollover}
                    className="px-4 py-2 bg-gray-700 border border-gray-600 text-gray-300 rounded-lg hover:bg-gray-600"
                  >
                    Rollover Yesterday
                  </button>
                  <button
                    onClick={handleGenerateSchedule}
                    disabled={loading || tasks.length === 0}
                    className="px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {loading ? 'Generating...' : 'Generate Today Forward'}
                  </button>
                </div>
              </div>

              {currentSchedule ? (
                <div className="space-y-2">
                  {currentSchedule.items?.map((item) => {
                    // Get task priority for color coding
                    const task = item.task ? item.task : tasks.find(t => t.id === item.task_id);
                    const priority = task?.priority || 'low';
                    
                    // Determine border and background color based on priority for tasks
                    let borderColor = 'border-gray-500';
                    let bgColor = 'bg-gray-700/50';
                    
                    if (item.item_type === 'task') {
                      if (priority === 'high') {
                        borderColor = 'border-red-500';
                        bgColor = 'bg-red-900/30';
                      } else if (priority === 'medium') {
                        borderColor = 'border-yellow-500';
                        bgColor = 'bg-yellow-900/30';
                      } else {
                        borderColor = 'border-indigo-500';
                        bgColor = 'bg-indigo-900/30';
                      }
                    } else if (item.item_type === 'lunch') {
                      borderColor = 'border-green-500';
                      bgColor = 'bg-green-900/30';
                    }
                    
                    return (
                      <div
                        key={item.id}
                        className={`p-4 rounded-lg border-l-4 ${borderColor} ${bgColor}`}
                      >
                        <div className="flex justify-between items-start">
                          <div className="flex-1">
                            <div className="flex items-center gap-2">
                              <span className="font-mono text-sm text-gray-400">
                                {item.start_time} - {item.end_time}
                              </span>
                              <span className="font-medium text-white">{item.title}</span>
                              {item.item_type === 'task' && priority && (
                                <span className={`text-xs px-2 py-0.5 rounded ${
                                  priority === 'high'
                                    ? 'bg-red-100 text-red-700'
                                    : priority === 'medium'
                                    ? 'bg-yellow-100 text-yellow-700'
                                    : 'bg-blue-100 text-blue-700'
                                }`}>
                                  {priority}
                                </span>
                              )}
                            </div>
                          </div>
                          {item.item_type === 'task' && !item.completed && (
                            <button
                              onClick={() => handleCompleteTask(item.task_id!)}
                              className="text-sm px-3 py-1 bg-gray-700 border border-gray-600 text-gray-300 rounded hover:bg-gray-600"
                            >
                              Complete
                            </button>
                          )}
                          {item.completed && (
                            <span className="text-sm px-3 py-1 bg-green-900/50 text-green-300 rounded border border-green-700">
                              ✓ Done
                            </span>
                          )}
                        </div>
                      </div>
                    );
                  })}
                  
                  {currentSchedule.schedule_data.suggestions && (
                    <div className="mt-6 p-4 bg-yellow-900/20 border border-yellow-700/50 rounded-lg">
                      <h3 className="font-semibold mb-2 text-yellow-300">💡 Tips</h3>
                      <ul className="list-disc list-inside space-y-1 text-sm text-gray-300">
                        {currentSchedule.schedule_data.suggestions.map((tip, i) => (
                          <li key={i}>{tip}</li>
                        ))}
                      </ul>
                    </div>
                  )}
                </div>
              ) : (
                <div className="text-center py-12 text-gray-400">
                  <p>No schedule generated yet</p>
                  <p className="text-sm mt-2">Add tasks and click "Generate Schedule"</p>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
