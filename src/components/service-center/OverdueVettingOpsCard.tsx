import { formatDistanceToNow } from 'date-fns';
import { Clock } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { useOverdueVettingOverview } from '@/hooks/useOverdueVettingAlert';
import { formatAge } from '@/lib/vettingOverdueCopy';
import { cn } from '@/lib/utils';

/** Ops/COO view of managers holding overdue vetting. Hidden for non-ops callers (the server refuses them). */
export function OverdueVettingOpsCard() {
  const { data, isLoading, error } = useOverdueVettingOverview();
  if (error) return null;
  const rows = data ?? [];

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-base">
          <Clock className="h-4 w-4 text-muted-foreground" aria-hidden /> Overdue vetting
        </CardTitle>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <p className="text-sm text-muted-foreground">Loading...</p>
        ) : rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">No overdue vetting.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-xs text-muted-foreground">
                <tr>
                  <th className="py-2 pr-3 font-medium">Manager</th>
                  <th className="py-2 pr-3 font-medium text-right">Overdue</th>
                  <th className="py-2 pr-3 font-medium text-right">Escalated</th>
                  <th className="py-2 pr-3 font-medium">Oldest</th>
                  <th className="py-2 pr-3 font-medium">Rent Plans / Landlords / LC1</th>
                  <th className="py-2 font-medium">Last alert shown</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr
                    key={r.manager_id}
                    className={cn('border-t border-border', Number(r.escalated_count) > 0 && 'border-l-4 border-l-destructive')}
                  >
                    <td className="py-2 pl-2 pr-3 font-medium">{r.manager_name ?? 'Unknown manager'}</td>
                    <td className="py-2 pr-3 text-right tabular-nums">{r.overdue_count}</td>
                    <td className={cn('py-2 pr-3 text-right tabular-nums', Number(r.escalated_count) > 0 && 'font-semibold text-destructive')}>
                      {r.escalated_count}
                    </td>
                    <td className="py-2 pr-3 tabular-nums">{formatAge(Number(r.oldest_age_hours))}</td>
                    <td className="py-2 pr-3 tabular-nums">{r.rent_plans} / {r.landlords} / {r.lc1}</td>
                    <td className="py-2 text-muted-foreground">
                      {r.last_alert_at ? formatDistanceToNow(new Date(r.last_alert_at), { addSuffix: true }) : 'Never'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
