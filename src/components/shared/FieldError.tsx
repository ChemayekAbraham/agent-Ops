import { AlertTriangle } from 'lucide-react';
import { cn } from '@/lib/utils';

interface FieldErrorProps {
  message?: string | null;
  className?: string;
}

/**
 * Consistent inline field error used across the registration / listing forms.
 * Renders nothing when there is no message so it can be dropped under any input.
 */
export default function FieldError({ message, className }: FieldErrorProps) {
  if (!message) return null;
  return (
    <p
      className={cn(
        'mt-1 flex items-start gap-1 text-[11px] font-medium text-destructive',
        className,
      )}
    >
      <AlertTriangle className="mt-px h-3 w-3 shrink-0" />
      <span>{message}</span>
    </p>
  );
}