import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { formatDynamic } from '@/lib/currencyFormat';
import { CalendarClock } from 'lucide-react';

interface NearingRow {
  commitment_id: string;
  partner_id: string;
  partner_name: string;
  active_principal: number;
  monthly_rate: number;
  next_payout_date: string;
  days_until: number;
  expected_amount: number;
  total_paid: number;
}

/**
 * Self Portfolio Management — Phase Four visibility.
 * Self-managed commitments whose returns fall due within the next 7 days.
 * Payout itself is automated (nightly `pay_partner_self_cycles`); this panel is
 * read-only so Partner Ops can see money leaving before it happens.
 */
export function SelfManagedNearingPayouts() {
  const { data, isLoading } = useQuery({
    queryKey: ['partner-self-nearing-payouts'],
    queryFn: async () => {
      const { data, error } = await supabase.rpc('partner_self_nearing_payouts', { p_days: 7 });
      if (error) throw error;
      const payload = (data ?? {}) as { rows?: NearingRow[]; expected_total?: number; count?: number };
      return {
        rows: payload.rows ?? [],
        expectedTotal: Number(payload.expected_total ?? 0),
        count: Number(payload.count ?? 0),
      };
    },
    staleTime: 60000,
    retry: false,
  });

  if (isLoading) return <Skeleton className="h-24 w-full rounded-xl" />;
  if (!data || data.rows.length === 0) return null;

  return (
    <Card className="border-primary/20">
      <CardContent className="p-4 space-y-3">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <div className="p-2 rounded-xl bg-primary/10">
              <CalendarClock className="h-4 w-4 text-primary" />
            </div>
            <div>
              <p className="text-sm font-bold">Self-managed returns due (7 days)</p>
              <p className="text-xs text-muted-foreground">
                Paid automatically on each partner&apos;s own contribution date
              </p>
            </div>
          </div>
          <div className="text-right">
            <p className="text-sm font-black">{formatDynamic(data.expectedTotal)}</p>
            <p className="text-[10px] text-muted-foreground">{data.count} commitment{data.count === 1 ? '' : 's'}</p>
          </div>
        </div>

        <div className="space-y-2">
          {data.rows.map((row) => (
            <div
              key={row.commitment_id}
              className="flex items-center justify-between gap-3 rounded-lg bg-muted/40 px-3 py-2"
            >
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <p className="text-xs font-semibold truncate">{row.partner_name}</p>
                  <Badge variant="secondary" className="text-[9px]">Self-managed</Badge>
                </div>
                <p className="text-[10px] text-muted-foreground">
                  {formatDynamic(row.active_principal)} active · {row.monthly_rate}% monthly
                </p>
              </div>
              <div className="text-right shrink-0">
                <p className="text-xs font-black">{formatDynamic(row.expected_amount)}</p>
                <p className="text-[10px] text-muted-foreground">
                  {row.days_until <= 0 ? 'due now' : `in ${row.days_until}d`} · {row.next_payout_date}
                </p>
              </div>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
