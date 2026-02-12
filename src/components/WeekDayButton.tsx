'use client';

import { useDroppable } from '@dnd-kit/core';
import { WEEK_DAY_PREFIX } from '@/lib/dnd-constants';
import { format, isToday } from 'date-fns';

interface WeekDayButtonProps {
  date: Date;
  dateStr: string;
  isSelected: boolean;
  onClick: () => void;
}

export default function WeekDayButton({ date, dateStr, isSelected, onClick }: WeekDayButtonProps) {
  const { setNodeRef, isOver } = useDroppable({
    id: `${WEEK_DAY_PREFIX}${dateStr}`,
  });

  const isTodayDate = isToday(date);

  return (
    <button
      ref={setNodeRef}
      onClick={onClick}
      className={`relative px-5 py-3 rounded-lg transition-all duration-150 min-w-[100px] ${
        isSelected
          ? 'bg-white text-black'
          : 'bg-white/[0.03] border border-white/[0.06] text-slate-500 hover:bg-white/[0.06] hover:text-slate-300'
      } ${isOver ? 'ring-2 ring-white/40 border-white/30 scale-105' : ''}`}
    >
      <div className="text-xs font-medium uppercase tracking-wider">{format(date, 'EEE')}</div>
      <div className="text-lg font-bold mt-0.5">{format(date, 'MMM d')}</div>
      {isTodayDate && (
        <div className={`absolute -top-1 -right-1 w-2 h-2 rounded-full ${isSelected ? 'bg-black ring-2 ring-white' : 'bg-white'}`} />
      )}
    </button>
  );
}
