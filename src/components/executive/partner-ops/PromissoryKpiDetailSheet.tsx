import { useMemo } from 'react';
import { format, parseISO } from 'date-fns';
import {
  ResponsiveContainer,
  AreaChart,
  Area,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
} from 'recharts';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Badge } from '@/components/ui/badge';
import { CompactAmount } from '@/components/ui/CompactAmount';
import { formatUGX } from '@/lib/rentCalculations';
import type { PromissoryOpsReport } from '@/hooks/usePromissoryOpsReport';

export type PromissoryKpiMetric =
  | 'notes_count'
  | 'partners_came_in'
  | 'partners_with_portfolio'
  | 'receivable'
  | 'promised_total'
  | 'proxy_agents'
  | 'lead_attachments'
  | 'pending_commission'
  | 'approved_commission'
  | 'proxies_pending'
  | 'self_supporting_tenants'
  | 'proxy_commission';

type Point = { at: string | null; value: number; label: string; sub?: string };

/** Read-only detail view for one promissory-notes number: trend over time plus
 *  the records that make it up. Derived entirely from the same report payload
 *  already on screen — no extra reads, no writes. */
export function PromissoryKpiDetailSheet({
  metric,
  label,
  rangeLabel,
  report,
  onClose,
}: {
  metric: PromissoryKpiMetric | null;
  label: string;
  rangeLabel: string;
  report: PromissoryOpsReport;
  onClose: () => void;
}) {
  const { points, isMoney, note } = useMemo<{
    points: Point[];
    isMoney: boolean;
    note?: string;
  }>(() => {
    const notes = report.notes || [];
    const agents = report.proxy_agents || [];
    const outstandingOf = (n: any) =>
      Number(n.outstanding ?? Number(n.amount || 0) - Number(n.total_collected || 0));

    switch (metric) {
      case 'notes_count':
        return {
          isMoney: false,
          points: notes.map(n => ({
            at: n.created_at,
            value: 1,
            label: n.partner_name,
            sub: `${n.agent_name} · ${formatUGX(Number(n.amount || 0))} · ${n.status}`,
          })),
        };
      case 'partners_came_in':
        return {
          isMoney: false,
          points: notes
            .filter(n => n.came_in)
            .map(n => ({
              at: n.came_in_at || n.created_at,
              value: 1,
              label: n.came_in_name || n.partner_name,
              sub: `matched on ${n.came_in_match_basis || 'account'} · ${n.agent_name}`,
            })),
        };
      case 'partners_with_portfolio':
        return {
          isMoney: false,
          points: notes
            .filter(n => Number(n.portfolio_count || 0) > 0)
            .map(n => ({
              at: n.first_portfolio_at || n.came_in_at || n.created_at,
              value: 1,
              label: n.partner_name,
              sub: `${n.portfolio_active_count} active · ${n.portfolio_pending_count} pending · ${formatUGX(Number(n.portfolio_amount || 0))}`,
            })),
        };
      case 'receivable':
        return {
          isMoney: true,
          points: notes
            .filter(n => outstandingOf(n) > 0)
            .map(n => ({
              at: n.created_at,
              value: outstandingOf(n),
              label: n.partner_name,
              sub: `promised ${formatUGX(Number(n.amount || 0))} · collected ${formatUGX(Number(n.total_collected || 0))}`,
            })),
        };
      case 'promised_total':
        return {
          isMoney: true,
          points: notes.map(n => ({
            at: n.created_at,
            value: Number(n.amount || 0),
            label: n.partner_name,
            sub: `fulfilled ${formatUGX(Number(n.total_collected || 0))} · ${n.status}`,
          })),
        };
      case 'proxy_agents':
        return {
          isMoney: false,
          points: agents.map(a => ({
            at: a.joined_at,
            value: 1,
            label: a.name,
            sub: `${a.status} · ${a.notes_count} notes · ${a.partners_count} partners`,
          })),
        };
      case 'proxies_pending':
        return {
          isMoney: false,
          points: agents
            .filter(a => (a.status || '').toLowerCase() === 'pending')
            .map(a => ({
              at: a.joined_at,
              value: 1,
              label: a.name,
              sub: `awaiting approval · ${a.district || 'district not set'}`,
            })),
        };
      case 'self_supporting_tenants':
        return {
          isMoney: false,
          points: notes
            .filter(n => n.support_mode === 'self_support')
            .map(n => ({
              at: n.created_at,
              value: Number(n.reserved_plans || 1),
              label: n.partner_name,
              sub: `${n.reserved_plans} plan${Number(n.reserved_plans) === 1 ? '' : 's'} · ${formatUGX(Number(n.reserved_amount || 0))}`,
            })),
        };
      case 'proxy_commission':
        return {
          isMoney: true,
          points: notes
            .filter(n => Number(n.commission_paid_total || 0) > 0)
            .map(n => ({
              at: n.last_commission_at || n.first_portfolio_at || n.created_at,
              value: Number(n.commission_paid_total || 0),
              label: n.agent_name,
              sub: `on ${n.partner_name} · creation ${formatUGX(Number(n.creation_commission_paid || 0))} · top-up ${formatUGX(Number(n.topup_commission_paid || 0))}`,
            })),
        };
      case 'lead_attachments':
      case 'pending_commission':
      case 'approved_commission':
        return {
          isMoney: metric !== 'lead_attachments',
          points: [],
          note: 'This figure is reported as a running total only, so there is no dated history to draw a trend from.',
        };
      default:
        return { isMoney: false, points: [] };
    }
  }, [metric, report]);

  const dated = useMemo(
    () => points.filter(p => !!p.at).sort((a, b) => (a.at! < b.at! ? -1 : 1)),
    [points],
  );

  const chart = useMemo(() => {
    if (!dated.length) return [] as { key: string; value: number; running: number }[];
    const first = parseISO(dated[0].at!);
    const last = parseISO(dated[dated.length - 1].at!);
    const spanDays = (last.getTime() - first.getTime()) / 86_400_000;
    const monthly = spanDays > 90;
    const buckets = new Map<string, number>();
    for (const p of dated) {
      const d = parseISO(p.at!);
      const key = monthly ? format(d, 'yyyy-MM') : format(d, 'yyyy-MM-dd');
      buckets.set(key, (buckets.get(key) || 0) + p.value);
    }
    let running = 0;
    return Array.from(buckets.entries()).map(([key, value]) => {
      running += value;
      return {
        key: monthly ? format(parseISO(`${key}-01`), 'MMM yy') : format(parseISO(key), 'dd MMM'),
        value,
        running,
      };
    });
  }, [dated]);

  const total = points.reduce((s, p) => s + p.value, 0);
  const top = useMemo(
    () => [...points].sort((a, b) => b.value - a.value || (a.at! < b.at! ? 1 : -1)).slice(0, 60),
    [points],
  );

  return (
    <Sheet open={!!metric} onOpenChange={open => { if (!open) onClose(); }}>
      <SheetContent side="right" className="w-full sm:max-w-lg overflow-y-auto">
        <SheetHeader className="text-left">
          <SheetTitle className="text-base">{label}</SheetTitle>
        </SheetHeader>

        <div className="mt-3 space-y-4">
          <div className="rounded-lg border bg-muted/30 p-3">
            <p className="text-[11px] text-muted-foreground">{rangeLabel}</p>
            <p className="text-2xl font-bold mt-0.5">
              {isMoney ? <CompactAmount value={total} /> : total.toLocaleString()}
            </p>
            <p className="text-[11px] text-muted-foreground mt-0.5">
              {points.length.toLocaleString()} record{points.length === 1 ? '' : 's'}
              {dated.length !== points.length && ` · ${points.length - dated.length} without a date`}
            </p>
          </div>

          {note && <p className="text-xs text-muted-foreground">{note}</p>}

          {chart.length > 1 && (
            <div className="rounded-lg border p-2">
              <p className="px-1 pb-1 text-[11px] font-medium text-muted-foreground">Trend</p>
              <div className="h-48">
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={chart} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
                    <defs>
                      <linearGradient id="pnKpiFill" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor="hsl(var(--primary))" stopOpacity={0.35} />
                        <stop offset="100%" stopColor="hsl(var(--primary))" stopOpacity={0.02} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
                    <XAxis dataKey="key" tick={{ fontSize: 10 }} stroke="hsl(var(--muted-foreground))" />
                    <YAxis tick={{ fontSize: 10 }} stroke="hsl(var(--muted-foreground))" width={48} />
                    <Tooltip
                      formatter={(v: any, n: any) => [
                        isMoney ? formatUGX(Number(v)) : Number(v).toLocaleString(),
                        n === 'running' ? 'Cumulative' : 'In period',
                      ]}
                      contentStyle={{ fontSize: 11 }}
                    />
                    <Area
                      type="monotone"
                      dataKey="value"
                      stroke="hsl(var(--primary))"
                      fill="url(#pnKpiFill)"
                      strokeWidth={2}
                    />
                    <Area
                      type="monotone"
                      dataKey="running"
                      stroke="hsl(var(--muted-foreground))"
                      fill="none"
                      strokeDasharray="4 3"
                      strokeWidth={1.5}
                    />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
              <p className="px-1 pt-1 text-[10px] text-muted-foreground">
                Solid line: added in each period. Dashed line: cumulative.
              </p>
            </div>
          )}

          {chart.length === 1 && (
            <p className="text-xs text-muted-foreground">
              Everything behind this number falls in a single period, so there is no trend to plot yet.
            </p>
          )}

          <div>
            <p className="text-[11px] font-medium text-muted-foreground mb-1.5">
              What makes up this number{top.length < points.length ? ` (top ${top.length})` : ''}
            </p>
            <div className="space-y-1.5">
              {top.map((p, i) => (
                <div key={`${p.label}-${i}`} className="rounded-md border p-2.5">
                  <div className="flex items-start justify-between gap-2">
                    <p className="text-xs font-medium truncate">{p.label}</p>
                    <span className="shrink-0 text-xs font-semibold">
                      {isMoney ? formatUGX(p.value) : p.value.toLocaleString()}
                    </span>
                  </div>
                  {p.sub && <p className="text-[10px] text-muted-foreground mt-0.5">{p.sub}</p>}
                  {p.at && (
                    <Badge variant="outline" className="mt-1 text-[9px] font-normal">
                      {format(parseISO(p.at), 'dd MMM yyyy')}
                    </Badge>
                  )}
                </div>
              ))}
              {!top.length && (
                <p className="text-xs text-muted-foreground">Nothing recorded for this number yet.</p>
              )}
            </div>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}
