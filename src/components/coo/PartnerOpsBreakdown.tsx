import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { format } from 'date-fns';
import {
  PlusCircle, Clock, CheckCircle2, Ban, Layers, ChevronDown, ChevronUp, Loader2, AlertTriangle,
  type LucideIcon,
} from 'lucide-react';

import { supabase } from '@/integrations/supabase/client';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

const ugx = (n?: number | null) =>
  n == null || !Number.isFinite(Number(n))
    ? 'UGX 0'
    : `UGX ${new Intl.NumberFormat('en-UG').format(Math.round(Number(n)))}`;

const num = (n: any) => (Number.isFinite(Number(n)) ? Number(n) : 0);

const fmt = (iso?: string | null, pattern = 'd MMM yy') => {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : format(d, pattern);
};

interface Row {
  id: string;
  code?: string | null;
  person?: string | null;
  amount?: number | null;
  principal?: number | null;
  status?: string | null;
  reason?: string | null;
  created_at?: string | null;
  paid_at?: string | null;
  next_roi_date?: string | null;
  overdue?: boolean;
  reference?: string | null;
}

interface Bucket {
  count?: number;
  amount?: number;
  rows?: Row[];
  [k: string]: any;
}

interface Breakdown {
  new_portfolios?: Bucket;
  nearing_payouts?: Bucket;
  paid_out?: Bucket;
  suspended?: Bucket;
  created_all_time?: Bucket;
}

const PAGE = 8;

export default function PartnerOpsBreakdown({ from, to }: { from?: Date; to?: Date }) {
  const fromISO = from ? new Date(from.getFullYear(), from.getMonth(), from.getDate(), 0, 0, 0).toISOString() : undefined;
  const toISO = to ? new Date(to.getFullYear(), to.getMonth(), to.getDate(), 23, 59, 59).toISOString() : undefined;

  const { data, isLoading, error } = useQuery({
    queryKey: ['partner-ops-breakdown', fromISO, toISO],
    staleTime: 60_000,
    queryFn: async () => {
      const { data, error } = await supabase.rpc('partner_ops_report_breakdown', {
        p_from: fromISO,
        p_to: toISO,
      } as any);
      if (error) throw error;
      return (data ?? {}) as Breakdown;
    },
  });

  const rangeLabel = useMemo(
    () => `${from ? format(from, 'PP') : '—'} → ${to ? format(to, 'PP') : '—'}`,
    [from, to],
  );

  if (error) {
    return (
      <div className="rounded-2xl border border-destructive/30 bg-destructive/5 p-4 flex items-start gap-2">
        <AlertTriangle className="h-4 w-4 text-destructive mt-0.5" />
        <div>
          <p className="text-sm font-bold text-destructive">Could not load the portfolio breakdown</p>
          <p className="text-xs text-muted-foreground mt-0.5">{(error as any)?.message ?? 'Unknown error'}</p>
        </div>
      </div>
    );
  }

  const nb = data?.new_portfolios ?? {};
  const np = data?.nearing_payouts ?? {};
  const po = data?.paid_out ?? {};
  const su = data?.suspended ?? {};
  const ca = data?.created_all_time ?? {};

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <p className="text-xs font-bold uppercase tracking-widest text-muted-foreground">Portfolio breakdown</p>
        <Badge variant="outline" className="text-[10px]">{rangeLabel}</Badge>
        {isLoading && <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" />}
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
        <Panel
          title="New portfolios created"
          icon={PlusCircle}
          tone="info"
          headline={String(num(nb.count))}
          sub={`${ugx(num(nb.amount))} · ${num(nb.partners)} partners · ${num(nb.verified)} verified, ${num(nb.pending)} pending`}
          loading={isLoading}
          rows={nb.rows ?? []}
          render={(r) => ({
            primary: r.person ?? 'Unknown',
            secondary: `${r.code ?? '—'} · ${fmt(r.created_at)}`,
            value: ugx(r.amount),
            tag: r.status ?? undefined,
          })}
        />

        <Panel
          title="Pending payouts (nearing)"
          icon={Clock}
          tone="warning"
          headline={String(num(np.count))}
          sub={`${ugx(num(np.amount))} due · ${num(np.overdue_count)} overdue (${ugx(num(np.overdue_amount))})`}
          loading={isLoading}
          rows={np.rows ?? []}
          render={(r) => ({
            primary: r.person ?? 'Unknown',
            secondary: `${r.code ?? '—'} · due ${fmt(r.next_roi_date)}`,
            value: ugx(r.amount),
            tag: r.overdue ? 'overdue' : 'due soon',
            tagTone: r.overdue ? 'destructive' : 'warning',
          })}
        />

        <Panel
          title="Paid out portfolios"
          icon={CheckCircle2}
          tone="success"
          headline={String(num(po.count))}
          sub={`${ugx(num(po.amount))} across ${num(po.payments)} payouts in the selected range`}
          loading={isLoading}
          rows={po.rows ?? []}
          render={(r) => ({
            primary: r.person ?? 'Unknown',
            secondary: `${r.code ?? r.reference ?? '—'} · ${fmt(r.paid_at, 'd MMM yy HH:mm')}`,
            value: ugx(r.amount),
            tag: 'paid',
            tagTone: 'success',
          })}
        />

        <Panel
          title="Suspended portfolios"
          icon={Ban}
          tone="destructive"
          headline={String(num(su.count))}
          sub={`${ugx(num(su.amount))} held · ${num(su.in_range)} flagged in the selected range`}
          loading={isLoading}
          rows={su.rows ?? []}
          render={(r) => ({
            primary: r.person ?? 'Unknown',
            secondary: `${r.code ?? '—'} · ${fmt(r.created_at)}${r.reason ? ` · ${r.reason}` : ''}`,
            value: ugx(r.amount),
            tag: (r.status ?? '').replace(/_/g, ' ') || undefined,
            tagTone: 'destructive',
          })}
        />

        <Panel
          title="Created portfolios (all time)"
          icon={Layers}
          tone="neutral"
          headline={String(num(ca.count))}
          sub={`${ugx(num(ca.amount))} raised · ${num(ca.partners)} partners · ${num(ca.active)} active`}
          loading={isLoading}
          rows={[]}
        />
      </div>
    </div>
  );
}

type Tone = 'neutral' | 'info' | 'success' | 'warning' | 'destructive';

const TONE_BORDER: Record<Tone, string> = {
  neutral: 'border-border bg-card',
  info: 'border-primary/30 bg-primary/5',
  success: 'border-success/30 bg-success/5',
  warning: 'border-warning/30 bg-warning/5',
  destructive: 'border-destructive/30 bg-destructive/5',
};

const TONE_TEXT: Record<Tone, string> = {
  neutral: 'text-foreground',
  info: 'text-primary',
  success: 'text-success',
  warning: 'text-warning',
  destructive: 'text-destructive',
};

const TAG_CLASS: Record<Tone, string> = {
  neutral: 'bg-muted text-muted-foreground border-border',
  info: 'bg-primary/10 text-primary border-primary/20',
  success: 'bg-success/10 text-success border-success/20',
  warning: 'bg-warning/10 text-warning border-warning/20',
  destructive: 'bg-destructive/10 text-destructive border-destructive/20',
};

function Panel({
  title, icon: Icon, tone, headline, sub, rows, render, loading,
}: {
  title: string;
  icon: LucideIcon;
  tone: Tone;
  headline: string;
  sub: string;
  rows: Row[];
  loading?: boolean;
  render?: (r: Row) => { primary: string; secondary: string; value: string; tag?: string; tagTone?: Tone };
}) {
  const [limit, setLimit] = useState(PAGE);
  const visible = rows.slice(0, limit);

  return (
    <div className={cn('rounded-2xl border p-4 flex flex-col min-w-0', TONE_BORDER[tone])}>
      <div className="flex items-start justify-between gap-2">
        <p className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">{title}</p>
        <Icon className={cn('h-4 w-4 shrink-0', TONE_TEXT[tone])} />
      </div>
      <p className={cn('text-2xl sm:text-3xl font-black tracking-tight tabular-nums mt-1', TONE_TEXT[tone])}>
        {loading ? '—' : headline}
      </p>
      <p className="text-[11px] text-muted-foreground mt-1 break-words">{sub}</p>

      {render && (
        <div className="mt-3 border-t border-border/60 pt-2 space-y-1.5">
          {loading && (
            <p className="text-[11px] text-muted-foreground flex items-center gap-1.5">
              <Loader2 className="h-3 w-3 animate-spin" /> Loading rows…
            </p>
          )}
          {!loading && rows.length === 0 && (
            <p className="text-[11px] text-muted-foreground">No records in this window.</p>
          )}
          {visible.map((r, i) => {
            const v = render(r);
            return (
              <div key={`${r.id}-${i}`} className="flex items-start justify-between gap-2 min-w-0">
                <div className="min-w-0">
                  <p className="text-xs font-medium truncate">{v.primary}</p>
                  <p className="text-[10px] text-muted-foreground truncate">{v.secondary}</p>
                </div>
                <div className="text-right shrink-0">
                  <p className="text-xs font-mono tabular-nums">{v.value}</p>
                  {v.tag && (
                    <span className={cn(
                      'inline-block mt-0.5 text-[9px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded border',
                      TAG_CLASS[v.tagTone ?? 'neutral'],
                    )}>
                      {v.tag}
                    </span>
                  )}
                </div>
              </div>
            );
          })}
          {rows.length > PAGE && (
            <Button
              variant="ghost"
              size="sm"
              className="h-7 px-2 text-[11px] gap-1"
              onClick={() => setLimit((l) => (l >= rows.length ? PAGE : l + PAGE))}
            >
              {limit >= rows.length
                ? <>Show less <ChevronUp className="h-3 w-3" /></>
                : <>Show more ({rows.length - limit} left) <ChevronDown className="h-3 w-3" /></>}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
