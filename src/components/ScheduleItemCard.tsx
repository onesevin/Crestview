'use client';

import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { ScheduleItem } from '@/types';
import { SCHEDULE_ITEM } from '@/lib/dnd-constants';
import { formatDisplayTime } from '@/lib/format-time';

interface ScheduleItemCardProps {
  item: ScheduleItem;
  pc: { dot: string; text: string; label: string; tint: string };
  onComplete: (itemId: string, taskId: string | null, completed: boolean, startTime?: string, endTime?: string, title?: string) => void;
  dateStr: string;
  isDragOverlay?: boolean;
}

export default function ScheduleItemCard({ item, pc, onComplete, dateStr, isDragOverlay }: ScheduleItemCardProps) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({
    id: item.id,
    data: { type: SCHEDULE_ITEM, item, dateStr },
    disabled: isDragOverlay,
  });

  const style = isDragOverlay ? undefined : {
    transform: CSS.Transform.toString(transform),
    transition,
    touchAction: 'none' as const,
  };

  if (item.item_type === 'break' || item.item_type === 'lunch') {
    return (
      <div
        ref={isDragOverlay ? undefined : setNodeRef}
        style={style}
        {...(isDragOverlay ? {} : { ...attributes, ...listeners })}
        className={`rounded-xl px-4 py-3 border ${
          item.item_type === 'lunch'
            ? 'bg-white/[0.04] border-[#7dab6e]/30'
            : 'bg-white/[0.04] border-white/[0.08]'
        } ${isDragging && !isDragOverlay ? 'opacity-40' : ''} ${
          isDragOverlay ? 'shadow-2xl ring-1 ring-white/20' : ''
        }`}
      >
        <div className="flex items-center justify-between">
          <span className={`text-sm font-medium ${
            item.item_type === 'lunch' ? 'text-[#7dab6e]' : 'text-slate-400'
          }`}>
            {item.title}
          </span>
          <span className="text-[11px] text-slate-600 font-mono">
            {formatDisplayTime(item.start_time)} - {formatDisplayTime(item.end_time)}
          </span>
        </div>
      </div>
    );
  }

  return (
    <div
      ref={isDragOverlay ? undefined : setNodeRef}
      style={style}
      {...(isDragOverlay ? {} : { ...attributes, ...listeners })}
      className={`flex items-center gap-3 px-4 py-3 ${pc.tint} border border-white/[0.06] rounded-xl transition-all duration-150 hover:bg-white/[0.05] ${
        item.completed ? 'opacity-40' : ''
      } ${isDragging && !isDragOverlay ? 'opacity-40' : ''} ${
        isDragOverlay ? 'shadow-2xl ring-1 ring-white/20' : ''
      }`}
    >
      <div className={`w-2.5 h-2.5 rounded-full ${pc.dot} flex-shrink-0`} />
      <div className="flex-1 min-w-0">
        <div className={`text-sm font-medium ${
          item.completed ? 'line-through text-slate-600' : 'text-slate-100'
        }`}>
          {item.title}
        </div>
        <div className="flex items-center gap-1.5 mt-0.5">
          <span className="text-[11px] text-slate-600 font-mono">{item.start_time} - {item.end_time}</span>
          <span className={`text-[11px] ${pc.text}`}>{pc.label}</span>
        </div>
      </div>
      {!isDragOverlay && (
        <input
          type="checkbox"
          checked={item.completed}
          onChange={() => onComplete(item.id, item.task_id || null, item.completed, item.start_time, item.end_time, item.title)}
          onPointerDown={(e) => e.stopPropagation()}
          className="custom-checkbox flex-shrink-0"
        />
      )}
    </div>
  );
}
