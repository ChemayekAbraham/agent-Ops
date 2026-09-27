import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Megaphone, MousePointerClick, Users, Eye } from 'lucide-react';

type PromoStatsRow = {
  surface: string;
  unique_tenants: number;
  impressions: number;
  clicks: number;
  click_through_rate: number;
};

const SURFACE_LABELS: Record<string, string> = {
  tenant_dashboard: 'Tenant dashboard banner',
  daily_payment_card: 'Daily payment card',
  repayment_dialog: 'Repayment popup',
  pay_rent_flow: 'Pay-rent flow',
};

const kampalaToday = () =>
  new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString().slice(0, 10);

const daysAgo = (n: number) => {
  const d = new Date(Date.now() + 3 * 60 * 60 * 1000 - n * 24 * 60 * 60 * 1000);
  return d.toISOString().slice(0, 10);
};

const PRESETS = [
  { label: '7 days', days: 7 },
  { label: '30 days', days: 30 },
  { label: '90 days', days: 90 },
] as const;

const fmtPct = (v: number) => `${(v * 100).toFixed(1)}%`;

export default function RentAccessPromoStatsCard() {
  const [from, setFrom] = useState(daysAgo(30));
  const [to, setTo] = useState(kampalaToday());

  const { data, isLoading, isError, refetch, isFetching } = useQuery({
    queryKey: ['rent-access-promo-stats', from, to],
    queryFn: async () => {
      const { data, error } = await supabase.rpc('get_rent_access_promo_stats', {
        p_from: from,
        p_to: to,
      });
      if (error) throw error;
      return (data ?? []) as PromoStatsRow[];
    },
  });

  const totals = useMemo(() => {
    const rows = data ?? [];
    const impressions = rows.reduce((s, r) => s + r.impressions, 0);
    const clicks = rows.reduce((s, r) => s + r.clicks, 0);
    const unique = rows.reduce((s, r) => s + r.unique_tenants, 0);
    return {
      unique,
      impressions,
      clicks,
      ctr: impressions > 0 ? clicks / impressions : 0,
    };
  }, [data]);

  return (
    <Card className="min-w-0 border-border/60">
      <CardHeader className="px-3 pb-3 sm:px-6">
        <CardTitle className="flex items-center gap-2 text-base">
          <Megaphone className="h-4 w-4 text-primary" />
          Rent-Access Growth Message — Reach &amp; Engagement
        </CardTitle>
        <CardDescription>
          How often tenants see and tap the "grow your rent access up to UGX 30,000,000" message,
          per screen.
        </CardDescription>
      </CardHeader>
      <CardContent className="min-w-0 space-y-4 px-3 sm:px-6">
        {/* Date-range filter */}
        <div className="flex flex-wrap items-end gap-2">
          <div className="flex gap-1.5">
            {PRESETS.map((p) => {
              const active = from === daysAgo(p.days) && to === kampalaToday();
              return (
                <Button
                  key={p.days}
                  size="sm"
                  variant={active ? 'default' : 'outline'}
                  className="h-8 text-xs"
                  onClick={() => {
                    setFrom(daysAgo(p.days));
                    setTo(kampalaToday());
                  }}
                >
                  {p.label}
                </Button>
              );
            })}
          </div>
          <div className="flex items-center gap-1.5">
            <Input
              type="date"
              value={from}
              max={to}
              onChange={(e) => e.target.value && setFrom(e.target.value)}
              className="h-8 w-[9.5rem] text-xs"
              aria-label="From date"
            />
            <span className="text-xs text-muted-foreground">to</span>
            <Input
              type="date"
              value={to}
              min={from}
              max={kampalaToday()}
              onChange={(e) => e.target.value && setTo(e.target.value)}
              className="h-8 w-[9.5rem] text-xs"
              aria-label="To date"
            />
          </div>
        </div>

        {/* Totals */}
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <div className="rounded-xl border border-border/60 bg-muted/30 p-3">
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <Users className="h-3.5 w-3.5" /> Reach
            </div>
            <div className="mt-1 text-lg font-bold tabular-nums">
              {isLoading ? '…' : totals.unique.toLocaleString()}
            </div>
            <div className="text-[11px] text-muted-foreground">unique tenants</div>
          </div>
          <div className="rounded-xl border border-border/60 bg-muted/30 p-3">
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <Eye className="h-3.5 w-3.5" /> Sightings
            </div>
            <div className="mt-1 text-lg font-bold tabular-nums">
              {isLoading ? '…' : totals.impressions.toLocaleString()}
            </div>
            <div className="text-[11px] text-muted-foreground">times shown</div>
          </div>
          <div className="rounded-xl border border-border/60 bg-muted/30 p-3">
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <MousePointerClick className="h-3.5 w-3.5" /> Taps
            </div>
            <div className="mt-1 text-lg font-bold tabular-nums">
              {isLoading ? '…' : totals.clicks.toLocaleString()}
            </div>
            <div className="text-[11px] text-muted-foreground">times tapped</div>
          </div>
          <div className="rounded-xl border border-border/60 bg-muted/30 p-3">
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <Megaphone className="h-3.5 w-3.5" /> Tap-rate
            </div>
            <div className="mt-1 text-lg font-bold tabular-nums">
              {isLoading ? '…' : fmtPct(totals.ctr)}
            </div>
            <div className="text-[11px] text-muted-foreground">taps per sighting</div>
          </div>
        </div>

        {/* Per-surface breakdown */}
        {isError ? (
          <div className="rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-sm">
            Could not load the numbers.{' '}
            <button className="underline" onClick={() => refetch()} disabled={isFetching}>
              Tap to retry
            </button>
          </div>
        ) : (
          <div className="overflow-x-auto rounded-xl border border-border/60">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border/60 bg-muted/40 text-left text-xs text-muted-foreground">
                  <th className="px-3 py-2 font-medium">Screen</th>
                  <th className="px-3 py-2 text-right font-medium">Reach</th>
                  <th className="px-3 py-2 text-right font-medium">Sightings</th>
                  <th className="px-3 py-2 text-right font-medium">Taps</th>
                  <th className="px-3 py-2 text-right font-medium">Tap-rate</th>
                </tr>
              </thead>
              <tbody>
                {(data ?? []).map((r) => (
                  <tr key={r.surface} className="border-b border-border/40 last:border-0">
                    <td className="px-3 py-2">{SURFACE_LABELS[r.surface] ?? r.surface}</td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {r.unique_tenants.toLocaleString()}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {r.impressions.toLocaleString()}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {r.clicks.toLocaleString()}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {fmtPct(r.click_through_rate)}
                    </td>
                  </tr>
                ))}
                {!isLoading && (data ?? []).length === 0 && (
                  <tr>
                    <td colSpan={5} className="px-3 py-6 text-center text-muted-foreground">
                      No sightings recorded in this date range yet.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
