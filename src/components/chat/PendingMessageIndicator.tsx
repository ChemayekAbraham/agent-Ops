import { Clock, AlertCircle, RefreshCw } from 'lucide-react';
import { cn } from '@/lib/utils';

interface PendingMessageIndicatorProps {
  status: 'pending' | 'sending' | 'failed';
  onRetry?: () => void;
}

export default function PendingMessageIndicator({ status, onRetry }: PendingMessageIndicatorProps) {
  return (
    <div className={cn(
      "flex items-center gap-1 text-[10px]",
      status === 'failed' ? 'text-destructive' : 'text-muted-foreground'
    )}>
      {status === 'pending' && (
        <>
          <Clock className="h-3 w-3" />
          <span>Queued</span>
        </>
      )}
      {status === 'sending' && (
        <>
          <RefreshCw className="h-3 w-3 animate-spin" />
          <span>Sending...</span>
        </>
      )}
      {status === 'failed' && (
        <>
          <AlertCircle className="h-3 w-3" />
          <span>Failed</span>
          {onRetry && (
            <button 
              onClick={onRetry}
              className="underline hover:no-underline ml-1"
            >
              Retry
            </button>
          )}
        </>
      )}
    </div>
  );
}
