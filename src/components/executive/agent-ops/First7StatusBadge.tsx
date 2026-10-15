import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { STATUS_LABEL, type RowStatus } from '@/lib/newTenantFirst7';
import { STATUS_TONE } from './first7Cells';

export function StatusBadge({ status }: { status: RowStatus }) {
  return <Badge variant="outline" className={cn('whitespace-nowrap text-[10px]', STATUS_TONE[status])}>{STATUS_LABEL[status]}</Badge>;
}
