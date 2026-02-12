// src/app/api/generate-schedule/route.ts - ENHANCED VERSION

import { NextRequest, NextResponse } from 'next/server';
import { generateOptimalSchedule } from '@/lib/scheduler';
import { getTaskPatterns } from '@/lib/supabase';
import { getAuthenticatedUser } from '@/lib/api-auth';

export async function POST(request: NextRequest) {
  try {
    const { date, taskIds, workHours } = await request.json();

    // Get authenticated user
    const { user, error: authError, supabase } = await getAuthenticatedUser(request);
    
    if (!user || authError) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const userId = user.id;

    // Get the tasks using authenticated client
    const { data: tasks, error: tasksError } = await supabase
      .from('tasks')
      .select('*')
      .in('id', taskIds);

    if (tasksError) throw tasksError;

    // Get historical patterns
    const patterns = await getTaskPatterns(userId);

    // Generate schedule using Claude with custom work hours
    const taskDescriptions = tasks.map(t => 
      `${t.title}${t.description ? ` - ${t.description}` : ''}`
    );

    const { blocks, suggestions } = await generateOptimalSchedule(
      taskDescriptions,
      patterns,
      date,
      workHours || 6
    );

    // Map blocks to tasks
    const scheduleItems = blocks.map(block => {
      const taskIndex = block.type === 'task' 
        ? tasks.findIndex(t => 
            block.title.toLowerCase().includes(t.title.toLowerCase()) ||
            t.title.toLowerCase().includes(block.title.toLowerCase())
          )
        : -1;

      return {
        task_id: taskIndex >= 0 ? tasks[taskIndex].id : undefined,
        start_time: block.start_time,
        end_time: block.end_time,
        item_type: block.type,
        title: block.title,
      };
    });

    // Save schedule to database using authenticated client
    const scheduleData = {
      total_hours: workHours || 6,
      work_blocks: blocks.filter(b => b.type === 'task').length,
      break_blocks: blocks.filter(b => b.type !== 'task').length,
      suggestions
    };

    // Save schedule directly with authenticated client
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

    // Fetch existing items (reuse rows via UPDATE instead of DELETE to avoid RLS issues)
    const { data: existingItems } = await supabase
      .from('schedule_items')
      .select('id')
      .eq('schedule_id', schedule.id)
      .order('start_time');

    const newItems = scheduleItems.map(item => ({
      schedule_id: schedule.id,
      ...item
    }));

    const oldItems = existingItems || [];
    for (let i = 0; i < newItems.length; i++) {
      if (i < oldItems.length) {
        await supabase
          .from('schedule_items')
          .update(newItems[i])
          .eq('id', oldItems[i].id);
      } else {
        const { error: itemsError } = await supabase
          .from('schedule_items')
          .insert(newItems[i]);
        if (itemsError) throw itemsError;
      }
    }

    // Neutralize leftover old items
    for (let i = newItems.length; i < oldItems.length; i++) {
      await supabase
        .from('schedule_items')
        .update({ task_id: null, item_type: 'break', title: '', start_time: '23:59', end_time: '23:59', completed: true })
        .eq('id', oldItems[i].id);
    }

    // Note: We keep tasks as 'pending' so they remain visible in the pending list
    // Tasks are only marked 'completed' when user explicitly completes them

    return NextResponse.json({
      success: true,
      schedule: {
        date,
        blocks,
        suggestions
      }
    });

  } catch (error) {
    console.error('Schedule generation error:', error);
    return NextResponse.json(
      { error: 'Failed to generate schedule' },
      { status: 500 }
    );
  }
}
