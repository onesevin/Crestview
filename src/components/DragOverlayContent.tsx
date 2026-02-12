'use client';

import { Task, ScheduleItem } from '@/types';
import { TASK_LIST_ITEM, SCHEDULE_ITEM } from '@/lib/dnd-constants';

interface DragOverlayContentProps {
  activeItem: {
    type: string;
    task?: Task;
    item?: ScheduleItem;
  };
  priorityConfig: Record<string, { dot: string; text: string; label: string; border: string; tint: string }>;
}

export default function DragOverlayContent({ activeItem, priorityConfig }: DragOverlayContentProps) {
  if (activeItem.type === TASK_LIST_ITEM && activeItem.task) {
    const task = activeItem.task;
    const pc = priorityConfig[task.priority] || priorityConfig.medium;
    return (
      <div className={`${pc.tint} border border-white/[0.1] border-l-2 ${pc.border} rounded-lg pl-3.5 pr-3 py-2.5 shadow-2xl ring-1 ring-white/20 max-w-[280px]`}>
        <div className="font-medium text-slate-100 text-sm leading-snug">{task.title}</div>
        {task.estimated_minutes && (
          <div className="text-[11px] text-slate-500 mt-1">{task.estimated_minutes}min</div>
        )}
      </div>
    );
  }

  if (activeItem.type === SCHEDULE_ITEM && activeItem.item) {
    const item = activeItem.item;

    if (item.item_type === 'break' || item.item_type === 'lunch') {
      return (
        <div className={`rounded-xl px-4 py-3 border shadow-2xl ring-1 ring-white/20 max-w-[400px] ${
          item.item_type === 'lunch'
            ? 'bg-white/[0.04] border-[#7dab6e]/30'
            : 'bg-white/[0.04] border-white/[0.08]'
        }`}>
          <span className={`text-sm font-medium ${
            item.item_type === 'lunch' ? 'text-[#7dab6e]' : 'text-slate-400'
          }`}>
            {item.title}
          </span>
        </div>
      );
    }

    const priority = item.task?.priority || 'low';
    const pc = priorityConfig[priority] || priorityConfig.low;
    return (
      <div className={`flex items-center gap-3 px-4 py-3 ${pc.tint} border border-white/[0.1] rounded-xl shadow-2xl ring-1 ring-white/20 max-w-[400px]`}>
        <div className={`w-2.5 h-2.5 rounded-full ${pc.dot} flex-shrink-0`} />
        <div className="flex-1 min-w-0">
          <div className="text-sm font-medium text-slate-100">{item.title}</div>
          <div className="text-[11px] text-slate-600 font-mono mt-0.5">
            {item.start_time} - {item.end_time}
          </div>
        </div>
      </div>
    );
  }

  return null;
}
