import { ReactNode, useState } from 'react';
import { useSwipeGesture } from '@/hooks/useSwipeGesture';
import { cn } from '@/lib/utils';
import { Trash2, Edit, Eye, Check, X, MoreHorizontal, HandCoins, Bookmark } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

interface SwipeAction {
  icon: LucideIcon;
  label: string;
  onClick: () => void;
  color: 'primary' | 'success' | 'warning' | 'destructive';
}

interface SwipeableRowProps {
  children: ReactNode;
  leftActions?: SwipeAction[];
  rightActions?: SwipeAction[];
  className?: string;
  disabled?: boolean;
}

const colorClasses = {
  primary: 'bg-primary text-primary-foreground',
  success: 'bg-success text-white',
  warning: 'bg-warning text-white',
  destructive: 'bg-destructive text-destructive-foreground',
};

export function SwipeableRow({
  children,
  leftActions = [],
  rightActions = [],
  className,
  disabled = false,
}: SwipeableRowProps) {
  const [isOpen, setIsOpen] = useState<'left' | 'right' | null>(null);
  
  const { offset, isSwiping, handlers, reset } = useSwipeGesture({
    threshold: 60,
    maxSwipe: 100,
    onSwipeLeft: () => {
      if (rightActions.length > 0) {
        setIsOpen('right');
      }
    },
    onSwipeRight: () => {
      if (leftActions.length > 0) {
        setIsOpen('left');
      }
    },
  });

  const handleActionClick = (action: SwipeAction) => {
    action.onClick();
    setIsOpen(null);
    reset();
  };

  const handleContentClick = () => {
    if (isOpen) {
      setIsOpen(null);
      reset();
    }
  };

  // Calculate transform based on state
  const getTransform = () => {
    if (disabled) return 'translateX(0)';
    
    if (isOpen === 'right') {
      return `translateX(-${rightActions.length * 56}px)`;
    }
    if (isOpen === 'left') {
      return `translateX(${leftActions.length * 56}px)`;
    }
    if (isSwiping) {
      return `translateX(${offset}px)`;
    }
    return 'translateX(0)';
  };

  if (disabled || (leftActions.length === 0 && rightActions.length === 0)) {
    return <div className={className}>{children}</div>;
  }

  return (
    <div className={cn('relative overflow-hidden rounded-xl', className)}>
      {/* Left Actions (revealed when swiping right) */}
      {leftActions.length > 0 && (
        <div className="absolute left-0 top-0 bottom-0 flex items-stretch">
          {leftActions.map((action, index) => {
            const Icon = action.icon;
            return (
              <button
                key={index}
                onClick={() => handleActionClick(action)}
                className={cn(
                  'flex flex-col items-center justify-center w-14 gap-1 transition-transform active:scale-95',
                  colorClasses[action.color]
                )}
              >
                <Icon className="h-5 w-5" />
                <span className="text-[9px] font-medium">{action.label}</span>
              </button>
            );
          })}
        </div>
      )}

      {/* Right Actions (revealed when swiping left) */}
      {rightActions.length > 0 && (
        <div className="absolute right-0 top-0 bottom-0 flex items-stretch">
          {rightActions.map((action, index) => {
            const Icon = action.icon;
            return (
              <button
                key={index}
                onClick={() => handleActionClick(action)}
                className={cn(
                  'flex flex-col items-center justify-center w-14 gap-1 transition-transform active:scale-95',
                  colorClasses[action.color]
                )}
              >
                <Icon className="h-5 w-5" />
                <span className="text-[9px] font-medium">{action.label}</span>
              </button>
            );
          })}
        </div>
      )}

      {/* Main Content */}
      <div
        {...handlers}
        onClick={handleContentClick}
        className={cn(
          'relative bg-card transition-transform duration-200 ease-out touch-pan-y',
          isSwiping && 'transition-none'
        )}
        style={{ transform: getTransform() }}
      >
        {children}
      </div>

      {/* Swipe hint indicator */}
      {!isOpen && !isSwiping && (rightActions.length > 0 || leftActions.length > 0) && (
        <div className="absolute right-2 top-1/2 -translate-y-1/2 pointer-events-none opacity-30">
          <MoreHorizontal className="h-4 w-4 text-muted-foreground" />
        </div>
      )}
    </div>
  );
}

// Pre-configured action factories for common use cases
export const swipeActions = {
  delete: (onClick: () => void): SwipeAction => ({
    icon: Trash2,
    label: 'Delete',
    onClick,
    color: 'destructive',
  }),
  edit: (onClick: () => void): SwipeAction => ({
    icon: Edit,
    label: 'Edit',
    onClick,
    color: 'primary',
  }),
  view: (onClick: () => void): SwipeAction => ({
    icon: Eye,
    label: 'View',
    onClick,
    color: 'primary',
  }),
  approve: (onClick: () => void): SwipeAction => ({
    icon: Check,
    label: 'Approve',
    onClick,
    color: 'success',
  }),
  reject: (onClick: () => void): SwipeAction => ({
    icon: X,
    label: 'Reject',
    onClick,
    color: 'destructive',
  }),
  fund: (onClick: () => void): SwipeAction => ({
    icon: HandCoins,
    label: 'Fund',
    onClick,
    color: 'success',
  }),
  unwatch: (onClick: () => void): SwipeAction => ({
    icon: Bookmark,
    label: 'Remove',
    onClick,
    color: 'destructive',
  }),
};
