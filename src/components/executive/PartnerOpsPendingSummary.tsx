import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Card, CardContent } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import { formatUGX } from '@/lib/rentCalculations';

interface PendingSummaryRow {
  notes_pending: number;
  oldest_pending_days: number;
  avg_pending_days: number;
  pending_over_7_days: number;
  approved_no_lead: number;
  override_saved: number;
}

const monthStart = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`;
};

const Tile = ({ label, value, tone }: { label: string; value: string | number; tone?: 'amber' | 'red' }) => (
  <Card className="min-w-0">
    <CardContent className="p-3">
      <p className="text-[10px] uppercase tracking-wide text-muted-foreground truncate">{label}</p>
      <p
        className={cn(
          'text-base font-semibold truncate',
          tone === 'red' ? 'text-destructive' : tone === 'amber' ? 'text-amber-600' : 'text-foreground',
        )}
      >
        {value}
      </p>
    </CardContent>
  </Card>
);

export function PartnerOpsPendingSummary() {
  const { data, isLoading, isError, error } = useQuery({
    queryKey: ['partner-ops-pending-summary', monthStart()],
    queryFn: async () => {
      const { data, error } = await supabase.rpc('partner_ops_pending_summary' as any, { p_month: monthStart() });
      if (error) throw error;
      const rows = (data || []) as PendingSummaryRow[];
      return Array.isArray(rows) ? rows[0] ?? null : (rows as unknown as PendingSummaryRow);
    },
  });

  if (isError) {
    return (
      <div className="rounded-md border border-destructive bg-destructive/10 p-3 text-sm text-destructive">
        Pending summary failed to load: {(error as any)?.message}
      </div>
    );
  }

  if (isLoading) {
    return <p className="text-sm text-muted-foreground">Loading pending summary…</p>;
  }

  const s = data as PendingSummaryRow | null;
  const num = (v: unknown) => Number(v ?? 0);
  const over7 = num(s?.pending_over_7_days);
  const oldest = num(s?.oldest_pending_days);

  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-6">
      <Tile label="Pending" value={num(s?.notes_pending)} />
      <Tile
        label="Oldest wait (days)"
        value={oldest}
        tone={oldest > 14 ? 'red' : oldest > 7 ? 'amber' : undefined}
      />
      <Tile label="Average wait (days)" value={Math.round(num(s?.avg_pending_days) * 10) / 10} />
      <Tile
        label="Waiting over 7 days"
        value={over7}
        tone={over7 > 5 ? 'red' : over7 > 0 ? 'amber' : undefined}
      />
      <Tile label="Approved with no lead" value={num(s?.approved_no_lead)} />
      <Tile label="Override saved (UGX)" value={formatUGX(num(s?.override_saved))} />
    </div>
  );
}