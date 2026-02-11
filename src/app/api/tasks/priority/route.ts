// src/app/api/tasks/priority/route.ts

import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase-server';

// PATCH - Update task priority
export async function PATCH(request: NextRequest) {
  try {
    const { taskId, priority } = await request.json();

    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // Update task priority
    const { error } = await supabase
      .from('tasks')
      .update({ priority })
      .eq('id', taskId)
      .eq('user_id', user.id); // Make sure user owns the task

    if (error) throw error;

    return NextResponse.json({ success: true });

  } catch (error) {
    console.error('Update priority error:', error);
    return NextResponse.json(
      { error: 'Failed to update priority' },
      { status: 500 }
    );
  }
}
