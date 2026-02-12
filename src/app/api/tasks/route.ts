// src/app/api/tasks/route.ts

import { NextRequest, NextResponse } from 'next/server';
import { createTask, getPendingTasks, markTaskCompleted, updateTaskPattern } from '@/lib/supabase';
import { parseTasksFromNaturalLanguage, extractKeywordsFromTask } from '@/lib/scheduler';
import { getAuthenticatedUser } from '@/lib/api-auth';

// GET - Fetch pending tasks
export async function GET(request: NextRequest) {
  try {
    console.log('=== GET /api/tasks ===');
    
    const { user, error: authError, supabase } = await getAuthenticatedUser(request);
    
    console.log('User found:', !!user);
    if (authError) console.log('Auth error:', authError);
    
    if (!user || authError) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // Fetch tasks directly with authenticated client
    // Include 'scheduled' status so tasks remain visible even after being added to schedule
    const { data: tasks, error: tasksError } = await supabase
      .from('tasks')
      .select('*')
      .eq('user_id', user.id)
      .in('status', ['pending', 'rolled_over', 'scheduled'])
      .order('priority', { ascending: false })
      .order('created_at', { ascending: true });

    if (tasksError) {
      console.error('Tasks fetch error:', tasksError);
      throw tasksError;
    }

    console.log('Tasks found:', tasks?.length || 0);
    return NextResponse.json({ tasks: tasks || [] });

  } catch (error) {
    console.error('Fetch tasks error:', error);
    return NextResponse.json(
      { error: 'Failed to fetch tasks' },
      { status: 500 }
    );
  }
}

// POST - Create new task(s) from natural language
export async function POST(request: NextRequest) {
  try {
    const { input } = await request.json();

    const { user, error: authError, supabase } = await getAuthenticatedUser(request);
    
    if (!user || authError) {
      return NextResponse.json({ error: 'Unauthorized - Please log in' }, { status: 401 });
    }

    // Parse natural language input using Claude
    const parsedTasks = await parseTasksFromNaturalLanguage(input);

    // Get existing pending tasks to check for duplicates
    const { data: existingTasks } = await supabase
      .from('tasks')
      .select('title, description')
      .eq('user_id', user.id)
      .in('status', ['pending', 'rolled_over', 'scheduled']);

    // Separate duplicates from unique tasks
    const duplicates: any[] = [];
    const uniqueTasks: any[] = [];

    parsedTasks.forEach(newTask => {
      const matchingExisting = existingTasks?.find(existing => {
        const newTitle = newTask.title.toLowerCase().trim();
        const existingTitle = existing.title.toLowerCase().trim();
        return newTitle === existingTitle || 
               newTitle.includes(existingTitle) ||
               existingTitle.includes(newTitle);
      });

      if (matchingExisting) {
        duplicates.push({
          newTask,
          existingTask: matchingExisting
        });
      } else {
        uniqueTasks.push(newTask);
      }
    });

    console.log(`Parsed ${parsedTasks.length} tasks: ${uniqueTasks.length} unique, ${duplicates.length} potential duplicates`);

    // If there are duplicates, return them for user confirmation
    if (duplicates.length > 0) {
      return NextResponse.json({
        hasDuplicates: true,
        duplicates: duplicates,
        uniqueTasks: uniqueTasks,
        message: `Found ${duplicates.length} potential duplicate(s). Please review.`
      });
    }

    // No duplicates, create all tasks
    const createdTasks = await Promise.all(
      uniqueTasks.map(async task => {
        const { data, error } = await supabase
          .from('tasks')
          .insert({
            user_id: user.id,
            ...task,
            status: 'pending'
          })
          .select()
          .single();

        if (error) throw error;
        return data;
      })
    );

    return NextResponse.json({
      success: true,
      tasks: createdTasks,
      hasDuplicates: false
    });

  } catch (error) {
    console.error('Create task error:', error);
    return NextResponse.json(
      { error: 'Failed to create tasks: ' + (error as Error).message },
      { status: 500 }
    );
  }
}

// PUT - Add tasks after duplicate confirmation
export async function PUT(request: NextRequest) {
  try {
    const { tasksToAdd } = await request.json();

    const { user, error: authError, supabase } = await getAuthenticatedUser(request);
    
    if (!user || authError) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // Create the confirmed tasks
    const createdTasks = await Promise.all(
      tasksToAdd.map(async (task: any) => {
        const { data, error } = await supabase
          .from('tasks')
          .insert({
            user_id: user.id,
            ...task,
            status: 'pending'
          })
          .select()
          .single();

        if (error) throw error;
        return data;
      })
    );

    return NextResponse.json({
      success: true,
      tasks: createdTasks
    });

  } catch (error) {
    console.error('Add confirmed tasks error:', error);
    return NextResponse.json(
      { error: 'Failed to add tasks: ' + (error as Error).message },
      { status: 500 }
    );
  }
}

// PATCH - Mark task as completed
export async function PATCH(request: NextRequest) {
  try {
    const { taskId, actualDuration } = await request.json();

    const { user, error: authError, supabase } = await getAuthenticatedUser(request);
    
    if (!user || authError) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // Get task details
    const { data: task } = await supabase
      .from('tasks')
      .select('*')
      .eq('id', taskId)
      .single();

    if (!task) {
      return NextResponse.json({ error: 'Task not found' }, { status: 404 });
    }

    // Mark as completed
    await markTaskCompleted(taskId, actualDuration);

    // Update learning patterns
    const keywords = extractKeywordsFromTask(task.title, task.description);
    await updateTaskPattern(user.id, keywords, actualDuration, true);

    return NextResponse.json({ success: true });

  } catch (error) {
    console.error('Complete task error:', error);
    return NextResponse.json(
      { error: 'Failed to complete task' },
      { status: 500 }
    );
  }
}

// DELETE - Delete a task
export async function DELETE(request: NextRequest) {
  try {
    const { taskId } = await request.json();

    const { user, error: authError, supabase } = await getAuthenticatedUser(request);
    
    if (!user || authError) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // Neutralize any schedule items that reference this task (UPDATE instead of DELETE for RLS)
    const { error: scheduleItemsError } = await supabase
      .from('schedule_items')
      .update({ task_id: null, item_type: 'break', title: '', completed: true })
      .eq('task_id', taskId);

    if (scheduleItemsError) {
      console.error('Error neutralizing schedule items:', scheduleItemsError);
      // Continue anyway - we still want to delete the task
    }

    // Then delete the task itself
    const { error } = await supabase
      .from('tasks')
      .delete()
      .eq('id', taskId)
      .eq('user_id', user.id); // Make sure user owns the task

    if (error) throw error;

    return NextResponse.json({ success: true });

  } catch (error) {
    console.error('Delete task error:', error);
    return NextResponse.json(
      { error: 'Failed to delete task' },
      { status: 500 }
    );
  }
}
