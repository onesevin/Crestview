// src/types/index.ts

export interface Task {
  id: string;
  user_id: string;
  title: string;
  description?: string;
  estimated_duration?: number;
  actual_duration?: number;
  priority: 'high' | 'medium' | 'low';
  tags?: string[];
  created_at: string;
  completed_at?: string;
  status: 'pending' | 'scheduled' | 'completed' | 'rolled_over';
}

export interface ScheduleItem {
  id: string;
  schedule_id: string;
  task_id?: string;
  start_time: string;
  end_time: string;
  item_type: 'task' | 'break' | 'lunch';
  title: string;
  completed: boolean;
  task?: Task;
}

export interface Schedule {
  id: string;
  user_id: string;
  schedule_date: string;
  schedule_data: {
    total_hours: number;
    work_blocks: number;
    break_blocks: number;
    suggestions?: string[];
  };
  created_at: string;
  items?: ScheduleItem[];
}

export interface TaskPattern {
  id: string;
  user_id: string;
  task_keywords: string[];
  average_duration: number;
  completion_rate: number;
  times_scheduled: number;
  times_completed: number;
  updated_at: string;
}

export interface GenerateScheduleRequest {
  date: string;
  tasks: string[]; // Natural language task descriptions
  existingPatterns?: TaskPattern[];
}

export interface GenerateScheduleResponse {
  schedule: {
    date: string;
    blocks: ScheduleBlock[];
  };
  suggestions: string[];
}

export interface ScheduleBlock {
  start_time: string;
  end_time: string;
  type: 'task' | 'break' | 'lunch';
  title: string;
  description?: string;
  estimated_duration: number;
  task_id?: string;
}
