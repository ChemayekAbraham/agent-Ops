import { ReactNode } from 'react';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { Lock } from 'lucide-react';

interface LockedActionTooltipProps {
  children: ReactNode;
  isLocked: boolean;
}

export default function LockedActionTooltip({ children, isLocked }: LockedActionTooltipProps) {
  if (!isLocked) {
    return <>{children}</>;
  }

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <div className="relative">
            <div className="opacity-50 pointer-events-none">
              {children}
            </div>
            <div className="absolute inset-0 flex items-center justify-center bg-background/50 rounded-lg cursor-not-allowed">
              <Lock className="h-4 w-4 text-muted-foreground" />
            </div>
          </div>
        </TooltipTrigger>
        <TooltipContent>
          <p className="text-xs">Accept Terms to continue</p>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
