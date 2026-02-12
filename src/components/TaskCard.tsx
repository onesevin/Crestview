'use client';

import { useDraggable } from '@dnd-kit/core';
import { Task } from '@/types';
import { TASK_LIST_ITEM } from '@/lib/dnd-constants';
import { format } from 'date-fns';

interface TaskCardProps {
  task: Task;
  pc: { dot: string; text: string; label: string; border: string; tint: string };
  isEditing: boolean;
  editingTitle: string;
  onEditingTitleChange: (title: string) => void;
  onTitleEdit: (taskId: string, title: string) => void;
  onStartEditing: (taskId: string, title: string) => void;
  onCancelEditing: () => void;
  onDelete: (taskId: string) => void;
  onChangePriority: (taskId: string, priority: 'high' | 'medium' | 'low') => void;
  onEstimatedMinutesChange: (taskId: string, value: string) => void;
  onDueDateChange: (taskId: string, newDate: string) => void;
  isDragOverlay?: boolean;
}

export default function TaskCard({
  task, pc, isEditing, editingTitle,
  onEditingTitleChange, onTitleEdit, onStartEditing, onCancelEditing,
  onDelete, onChangePriority, onEstimatedMinutesChange, onDueDateChange,
  isDragOverlay,
}: TaskCardProps) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: `task-${task.id}`,
    data: { type: TASK_LIST_ITEM, task },
    disabled: isDragOverlay,
  });

  const isOverdue = task.due_date && task.due_date < format(new Date(), 'yyyy-MM-dd');
  const isDueToday = task.due_date && task.due_date === format(new Date(), 'yyyy-MM-dd');

  return (
    <div
      ref={isDragOverlay ? undefined : setNodeRef}
      {...(isDragOverlay ? {} : { ...attributes, ...listeners })}
      className={`group ${pc.tint} border border-white/[0.05] border-l-2 ${pc.border} rounded-lg pl-3.5 pr-3 py-2.5 card-hover ${
        isDragging && !isDragOverlay ? 'opacity-40' : ''
      } ${isDragOverlay ? 'shadow-2xl ring-1 ring-white/20' : ''}`}
      style={{ touchAction: 'none' }}
    >
      <div className="flex justify-between items-start gap-2">
        <div className="flex-1 min-w-0">
          {isEditing && !isDragOverlay ? (
            <input
              autoFocus
              value={editingTitle}
              onChange={(e) => onEditingTitleChange(e.target.value)}
              onBlur={() => onTitleEdit(task.id, editingTitle)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') onTitleEdit(task.id, editingTitle);
                if (e.key === 'Escape') onCancelEditing();
              }}
              onPointerDown={(e) => e.stopPropagation()}
              className="w-full font-medium text-slate-200 text-sm leading-snug bg-white/[0.05] border border-white/[0.1] rounded px-1.5 py-0.5 focus:outline-none focus:ring-1 focus:ring-white/20"
            />
          ) : (
            <div
              className="font-medium text-slate-100 text-sm leading-snug cursor-text hover:text-white transition-colors"
              onPointerDown={(e) => {
                // Allow double-click to edit but don't prevent drag
              }}
              onClick={() => { onStartEditing(task.id, task.title); }}
            >
              {task.title}
            </div>
          )}
          {task.description && (
            <div className="text-xs text-slate-600 mt-0.5 line-clamp-1">
              {task.description}
            </div>
          )}
        </div>
        {!isDragOverlay && (
          <button
            onClick={() => onDelete(task.id)}
            onPointerDown={(e) => e.stopPropagation()}
            className="p-1 rounded text-slate-700 hover:text-slate-400 transition-colors opacity-0 group-hover:opacity-100 flex-shrink-0"
          >
            <svg xmlns="http://www.w3.org/2000/svg" className="h-3.5 w-3.5" viewBox="0 0 20 20" fill="currentColor">
              <path fillRule="evenodd" d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z" clipRule="evenodd" />
            </svg>
          </button>
        )}
      </div>
      {!isDragOverlay && (
        <div className="flex gap-1.5 items-center mt-2 flex-wrap">
          <select
            value={task.priority}
            onChange={(e) => onChangePriority(task.id, e.target.value as 'high' | 'medium' | 'low')}
            onPointerDown={(e) => e.stopPropagation()}
            className={`text-[11px] px-1.5 py-0.5 rounded bg-white/[0.03] border border-white/[0.06] ${pc.text} cursor-pointer focus:outline-none transition-all`}
          >
            <option value="high">High</option>
            <option value="medium">Medium</option>
            <option value="low">Low</option>
          </select>
          <select
            value={task.estimated_minutes || ''}
            onChange={(e) => onEstimatedMinutesChange(task.id, e.target.value)}
            onPointerDown={(e) => e.stopPropagation()}
            className="text-[11px] px-1.5 py-0.5 rounded bg-white/[0.03] border border-white/[0.06] text-slate-500 cursor-pointer focus:outline-none transition-all"
          >
            <option value="">Est.</option>
            {[5, 10, 15, 30, 45, 60, 90, 120].map(m => (
              <option key={m} value={m}>{m}m</option>
            ))}
          </select>
          {task.due_date ? (
            <label
              onPointerDown={(e) => e.stopPropagation()}
              className={`relative text-[11px] px-1.5 py-0.5 rounded cursor-pointer transition-all ${
                isOverdue
                  ? 'bg-[#e8705e]/10 text-[#e8705e] border border-[#e8705e]/20'
                  : isDueToday
                  ? 'bg-[#d4a54a]/10 text-[#d4a54a] border border-[#d4a54a]/20'
                  : 'bg-white/[0.03] text-slate-500 border border-white/[0.06] hover:border-white/10'
              }`}
            >
              {isOverdue ? 'Overdue' : isDueToday ? 'Today' : format(new Date(task.due_date + 'T00:00:00'), 'MMM d')}
              <input
                type="date"
                value={task.due_date}
                onChange={(e) => onDueDateChange(task.id, e.target.value)}
                className="absolute inset-0 opacity-0 cursor-pointer [color-scheme:dark]"
              />
            </label>
          ) : (
            <label
              onPointerDown={(e) => e.stopPropagation()}
              className="relative text-[11px] px-1.5 py-0.5 rounded bg-white/[0.02] text-slate-700 border border-white/[0.04] cursor-pointer hover:text-slate-500 hover:border-white/[0.08] transition-all"
            >
              + date
              <input
                type="date"
                value=""
                onChange={(e) => onDueDateChange(task.id, e.target.value)}
                className="absolute inset-0 opacity-0 cursor-pointer [color-scheme:dark]"
              />
            </label>
          )}
        </div>
      )}
    </div>
  );
}
