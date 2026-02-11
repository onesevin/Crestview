// src/app/api/rollover/route.ts

import { NextRequest, NextResponse } from 'next/server';
import { rolloverIncompleteTasks } from '@/lib/supabase';
import { supabase } from '@/lib/supabase';

export async function POST(request: NextRequest) {
  try {
    const { date } = await request.json();

    const { data: { session } } = await supabase.auth.getSession();
    if (!session) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const rolledOverTasks = await rolloverIncompleteTasks(session.user.id, date);

    return NextResponse.json({
      success: true,
      rolledOver: rolledOverTasks.length,
      tasks: rolledOverTasks
    });

  } catch (error) {
    console.error('Rollover error:', error);
    return NextResponse.json(
      { error: 'Failed to rollover tasks' },
      { status: 500 }
    );
  }
}
