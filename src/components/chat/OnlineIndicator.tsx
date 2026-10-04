import { forwardRef } from 'react';
import { cn } from '@/lib/utils';

interface OnlineIndicatorProps {
  isOnline: boolean;
  size?: 'sm' | 'md' | 'lg';
  className?: string;
}

const OnlineIndicator = forwardRef<HTMLSpanElement, OnlineIndicatorProps>(
  ({ isOnline, size = 'md', className }, ref) => {
    const sizeClasses = {
      sm: 'h-2 w-2',
      md: 'h-2.5 w-2.5',
      lg: 'h-3 w-3',
    };

    return (
      <span
        ref={ref}
        className={cn(
          'rounded-full border-2 border-background',
          sizeClasses[size],
          isOnline ? 'bg-success' : 'bg-muted-foreground/50',
          className
        )}
        title={isOnline ? 'Online' : 'Offline'}
      />
    );
  }
);

OnlineIndicator.displayName = 'OnlineIndicator';

export default OnlineIndicator;
