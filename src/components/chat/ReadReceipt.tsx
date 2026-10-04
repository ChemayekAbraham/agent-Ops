import { Check, CheckCheck } from 'lucide-react';
import { format } from 'date-fns';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

interface ReadReceiptProps {
  sentAt: string;
  readAt: string | null;
  isOwn: boolean;
}

export default function ReadReceipt({ sentAt, readAt, isOwn }: ReadReceiptProps) {
  if (!isOwn) return null;

  const formatSeenTime = (dateStr: string) => {
    const date = new Date(dateStr);
    return format(date, 'MMM d, yyyy \'at\' h:mm a');
  };

  return (
    <TooltipProvider delayDuration={300}>
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="inline-flex items-center cursor-default">
            {readAt ? (
              <CheckCheck className={cn(
                "h-3.5 w-3.5 text-primary transition-colors"
              )} />
            ) : (
              <Check className="h-3.5 w-3.5 text-muted-foreground" />
            )}
          </span>
        </TooltipTrigger>
        <TooltipContent side="left" className="text-xs">
          {readAt ? (
            <div className="space-y-0.5">
              <p className="font-medium text-primary flex items-center gap-1">
                <CheckCheck className="h-3 w-3" />
                Seen
              </p>
              <p className="text-muted-foreground">{formatSeenTime(readAt)}</p>
            </div>
          ) : (
            <div className="space-y-0.5">
              <p className="font-medium flex items-center gap-1">
                <Check className="h-3 w-3" />
                Sent
              </p>
              <p className="text-muted-foreground">{formatSeenTime(sentAt)}</p>
            </div>
          )}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
