'use client';

import { useDroppable } from '@dnd-kit/core';
import { SCHEDULE_DROP_ZONE } from '@/lib/dnd-constants';

interface ScheduleDropZoneProps {
  children: React.ReactNode;
}

export default function ScheduleDropZone({ children }: ScheduleDropZoneProps) {
  const { setNodeRef, isOver } = useDroppable({
    id: SCHEDULE_DROP_ZONE,
  });

  return (
    <div
      ref={setNodeRef}
      className={`space-y-2 rounded-xl transition-all duration-150 ${
        isOver ? 'ring-1 ring-white/20 ring-offset-2 ring-offset-[#050507]' : ''
      }`}
    >
      {children}
    </div>
  );
}
