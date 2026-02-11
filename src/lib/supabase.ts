// src/lib/supabase.ts

import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

export const supabase = createClient(supabaseUrl, supabaseAnonKey, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
  }
});

// Helper functions for database operations

export async function createTask(userId: string, taskData: {
  title: string;
  description?: string;
  estimated_duration?: number;
  priority: 'high' | 'medium' | 'low';
  tags?: string[];
}) {
  const { data, error } = await supabase
    .from('tasks')
    .insert({
      user_id: userId,
      ...taskData,
      status: 'pending'
    })
    .select()
    .single();

  if (error) throw error;
  return data;
}

export async function getPendingTasks(userId: string) {
  const { data, error } = await supabase
    .from('tasks')
    .select('*')
    .eq('user_id', userId)
    .in('status', ['pending', 'rolled_over'])
    .order('priority', { ascending: false })
    .order('created_at', { ascending: true });

  if (error) throw error;
  return data;
}

export async function getScheduleForDate(userId: string, date: string) {
  const { data: schedule, error: scheduleError } = await supabase
    .from('schedules')
    .select('*')
    .eq('user_id', userId)
    .eq('schedule_date', date)
    .single();

  if (scheduleError && scheduleError.code !== 'PGRST116') throw scheduleError;
  if (!schedule) return null;

  const { data: items, error: itemsError } = await supabase
    .from('schedule_items')
    .select(`
      *,
      task:tasks(*)
    `)
    .eq('schedule_id', schedule.id)
    .order('start_time', { ascending: true });

  if (itemsError) throw itemsError;

  return {
    ...schedule,
    items
  };
}

export async function saveSchedule(
  userId: string,
  date: string,
  scheduleData: any,
  items: Array<{
    task_id?: string;
    start_time: string;
    end_time: string;
    item_type: 'task' | 'break' | 'lunch';
    title: string;
  }>
) {
  // Insert or update schedule
  const { data: schedule, error: scheduleError } = await supabase
    .from('schedules')
    .upsert({
      user_id: userId,
      schedule_date: date,
      schedule_data: scheduleData
    }, {
      onConflict: 'user_id,schedule_date'
    })
    .select()
    .single();

  if (scheduleError) throw scheduleError;

  // Delete existing items
  await supabase
    .from('schedule_items')
    .delete()
    .eq('schedule_id', schedule.id);

  // Insert new items
  const { error: itemsError } = await supabase
    .from('schedule_items')
    .insert(
      items.map(item => ({
        schedule_id: schedule.id,
        ...item
      }))
    );

  if (itemsError) throw itemsError;

  // Update task statuses
  const taskIds = items
    .filter(item => item.task_id)
    .map(item => item.task_id!);

  if (taskIds.length > 0) {
    await supabase
      .from('tasks')
      .update({ status: 'scheduled' })
      .in('id', taskIds);
  }

  return schedule;
}

export async function markTaskCompleted(taskId: string, actualDuration: number) {
  const { error } = await supabase
    .from('tasks')
    .update({
      status: 'completed',
      completed_at: new Date().toISOString(),
      actual_duration: actualDuration
    })
    .eq('id', taskId);

  if (error) throw error;
}

export async function rolloverIncompleteTasks(userId: string, date: string) {
  const schedule = await getScheduleForDate(userId, date);
  if (!schedule) return [];

  const incompleteTasks = schedule.items
    ?.filter(item => item.item_type === 'task' && !item.completed && item.task_id)
    .map(item => item.task_id!) || [];

  if (incompleteTasks.length === 0) return [];

  const { data, error } = await supabase
    .from('tasks')
    .update({ status: 'rolled_over' })
    .in('id', incompleteTasks)
    .select();

  if (error) throw error;
  return data;
}

export async function getTaskPatterns(userId: string) {
  const { data, error } = await supabase
    .from('task_patterns')
    .select('*')
    .eq('user_id', userId);

  if (error) throw error;
  return data;
}

export async function updateTaskPattern(
  userId: string,
  keywords: string[],
  duration: number,
  completed: boolean
) {
  // Try to find matching pattern
  const { data: existingPatterns } = await supabase
    .from('task_patterns')
    .select('*')
    .eq('user_id', userId);

  let matchingPattern = existingPatterns?.find(pattern =>
    pattern.task_keywords.some(kw => keywords.includes(kw))
  );

  if (matchingPattern) {
    // Update existing pattern
    const newTimesScheduled = matchingPattern.times_scheduled + 1;
    const newTimesCompleted = completed 
      ? matchingPattern.times_completed + 1 
      : matchingPattern.times_completed;
    const newAvgDuration = Math.round(
      (matchingPattern.average_duration * matchingPattern.times_scheduled + duration) / newTimesScheduled
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
    // Create new pattern
    await supabase
      .from('task_patterns')
      .insert({
        user_id: userId,
        task_keywords: keywords,
        average_duration: duration,
        times_scheduled: 1,
        times_completed: completed ? 1 : 0,
        completion_rate: completed ? 1.0 : 0.0
      });
  }
}
