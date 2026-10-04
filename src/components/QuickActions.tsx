import { LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';

interface QuickAction {
  icon: LucideIcon;
  label: string;
  onClick: () => void;
  color?: 'primary' | 'success' | 'warning' | 'destructive';
  badge?: string | number;
}

interface QuickActionsProps {
  actions: QuickAction[];
  columns?: 2 | 3 | 4;
  className?: string;
}

const colorClasses = {
  primary: 'bg-primary/10 text-primary group-hover:bg-primary/20',
  success: 'bg-success/10 text-success group-hover:bg-success/20',
  warning: 'bg-warning/10 text-warning group-hover:bg-warning/20',
  destructive: 'bg-destructive/10 text-destructive group-hover:bg-destructive/20',
};

export function QuickActions({ actions, columns = 4, className }: QuickActionsProps) {
  const gridCols = {
    2: 'grid-cols-2',
    3: 'grid-cols-3',
    4: 'grid-cols-4',
  };

  return (
    <div className={cn(`grid gap-3 ${gridCols[columns]}`, className)}>
      {actions.map((action, index) => {
        const Icon = action.icon;
        const color = action.color || 'primary';
        
        return (
          <button
            key={index}
            onClick={action.onClick}
            className="group relative flex flex-col items-center justify-center p-4 rounded-2xl border border-border bg-card hover:bg-accent/30 active:scale-[0.96] transition-all duration-200 min-h-[100px] touch-manipulation"
          >
            {/* Badge */}
            {action.badge !== undefined && (
              <div className="absolute -top-1.5 -right-1.5 min-w-[20px] h-5 px-1.5 rounded-full bg-destructive text-destructive-foreground text-[10px] font-bold flex items-center justify-center">
                {action.badge}
              </div>
            )}
            
            {/* Icon */}
            <div className={cn(
              'p-3 rounded-xl mb-2 transition-all duration-200 group-hover:scale-110',
              colorClasses[color]
            )}>
              <Icon className="h-7 w-7" />
            </div>
            
            {/* Label - Short & Clear */}
            <span className="text-xs font-semibold text-center text-foreground leading-tight line-clamp-2">
              {action.label}
            </span>
          </button>
        );
      })}
    </div>
  );
}
