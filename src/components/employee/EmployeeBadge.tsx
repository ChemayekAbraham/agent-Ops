import { Shield } from 'lucide-react';
import { cn } from '@/lib/utils';

interface Props {
  employeeId?: string | null;
  className?: string;
  showId?: boolean;
}

export function EmployeeBadge({ employeeId, className, showId = true }: Props) {
  return (
    <span className={cn(
      "inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[10px] font-bold tracking-wide",
      "bg-primary/10 text-primary border border-primary/20",
      className
    )}>
      <Shield className="h-3 w-3" />
      <span>WELILE STAFF</span>
      {showId && employeeId && (
        <span className="text-muted-foreground font-mono ml-0.5">• {employeeId}</span>
      )}
    </span>
  );
}
