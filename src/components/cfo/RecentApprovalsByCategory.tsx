import { useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Loader2, ClipboardCheck, ChevronRight, Inbox, RefreshCw } from 'lucide-react';
import { formatUGX } from '@/lib/rentCalculations';
import { cn } from '@/lib/utils';
import { PAYOUT_CATEGORIES } from './DirectCreditTool';

const MAX_ROWS = 500;
const PER_CATEGORY_PREVIEW = 6;

/** Kampala is a fixed UTC+3 zone (no DST). */
const KAMPALA_OFFSET = '+03:00';

type Scope = 'today' | '7d' | 'all';

interface ApprovalRow {
  id: string;
  operation: string;
  amount: number;
  evidence: string | null;
  reference_id: string | null;
  created_at: string;
  created_by: string | null;
  target_user_id: string;
  metadata: Record<string, any> | null;
  beneficiary: { full_name: string | null; phone: string | null } | null;
  approver: string | null;
}

/** Today's date in Africa/Kampala, as YYYY-MM-DD. */
function kampalaToday(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Africa/Kampala',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

/** Start of a Kampala day (or N days back) as an absolute ISO instant. */
function kampalaDayStartISO(daysBack = 0): string {
  const today = kampalaToday();
  const base = new Date(`${today}T00:00:00${KAMPALA_OFFSET}`);
  base.setUTCDate(base.getUTCDate() - daysBack);
  return base.toISOString();
}

function formatKampala(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Africa/Kampala',
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(d);
}

/** Strip the leading emoji/decoration so a stored label can be compared to a dropdown label. */
function normaliseLabel(value: string): string {
  return value
    .replace(/[^\p{L}\p{N}\s&]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

const SCOPE_LABEL: Record<Scope, string> = {
  today: 'Today',
  '7d': 'Last 7 days',
  all: 'Recent',
};

export function RecentApprovalsByCategory() {
  // Categories are read straight from the page's existing payout dropdown list.
  const categories = PAYOUT_CATEGORIES;
  const [scope, setScope] = useState<Scope>('today');
  const [openRow, setOpenRow] = useState<ApprovalRow | null>(null);
  const qc = useQueryClient();

  const kampalaDate = kampalaToday();

  const { data, isLoading, isFetching, error, refetch } = useQuery({
    queryKey: ['cfo-recent-approvals-by-category', scope, kampalaDate],
    refetchOnWindowFocus: true,
    refetchOnMount: 'always',
    staleTime: 0,
    refetchInterval: 20_000,
    queryFn: async (): Promise<ApprovalRow[]> => {
      // Approval records written by the same path the Approve button uses
      // (cfo-direct-credit → platform_wallet_corrections). created_at is the
      // moment of approval, not the moment the request was raised.
      let q = supabase
        .from('platform_wallet_corrections')
        .select(
          'id, operation, amount, evidence, reference_id, created_at, created_by, target_user_id, metadata',
        )
        .eq('tool', 'cfo_direct_credit')
        .order('created_at', { ascending: false })
        .limit(MAX_ROWS);

      if (scope === 'today') q = q.gte('created_at', kampalaDayStartISO(0));
      if (scope === '7d') q = q.gte('created_at', kampalaDayStartISO(6));

      const { data: rows, error: rowsErr } = await q;
      if (rowsErr) throw rowsErr;

      const list = (rows ?? []) as unknown as ApprovalRow[];
      const ids = Array.from(
        new Set(
          list
            .flatMap((r) => [r.target_user_id, r.created_by])
            .filter((v): v is string => Boolean(v)),
        ),
      );
      let people: Record<string, { full_name: string | null; phone: string | null }> = {};
      if (ids.length) {
        const { data: profiles } = await supabase
          .from('profiles')
          .select('id, full_name, phone')
          .in('id', ids);
        people = Object.fromEntries(
          (profiles ?? []).map((p: any) => [p.id, { full_name: p.full_name, phone: p.phone }]),
        );
      }

      return list.map((r) => ({
        ...r,
        beneficiary: people[r.target_user_id] ?? null,
        approver: r.created_by ? people[r.created_by]?.full_name ?? null : null,
      }));
    },
  });

  // Live: a new approval row lands in the list without a page refresh.
  useEffect(() => {
    const channel = supabase
      .channel('cfo-approvals-live')
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'platform_wallet_corrections' },
        () => {
          qc.invalidateQueries({ queryKey: ['cfo-recent-approvals-by-category'] });
        },
      )
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
  }, [qc]);

  const groups = useMemo(() => {
    const byLabel = new Map(categories.map((c) => [normaliseLabel(c.label), c.id]));
    const buckets = new Map<string, ApprovalRow[]>();

    for (const row of data ?? []) {
      // Only completed, approved credits/debits are recorded in this table; a
      // credit is a granted payout approval.
      const meta = row.metadata ?? {};
      const label = typeof meta.category_label === 'string' ? meta.category_label : '';
      const base = label.split('—')[0].split('→')[0].split('/')[0];
      let categoryId =
        byLabel.get(normaliseLabel(label)) ?? byLabel.get(normaliseLabel(base)) ?? null;

      if (!categoryId) {
        const match =
          categories.find(
            (c) =>
              c.platformCategory === meta.platform_category &&
              c.walletCategory === meta.wallet_category &&
              c.allowedOps.includes(row.operation as any),
          ) ??
          categories.find(
            (c) =>
              c.platformCategory === meta.platform_category &&
              c.allowedOps.includes(row.operation as any),
          );
        categoryId = match?.id ?? null;
      }
      const key = categoryId ?? '__other__';
      const list = buckets.get(key) ?? [];
      list.push(row);
      buckets.set(key, list);
    }

    return Array.from(buckets.entries())
      .map(([id, rows]) => {
        const category = categories.find((c) => c.id === id);
        return {
          id,
          label: category?.label ?? '🗂️ Other approvals',
          description: category?.description ?? 'Approvals that do not map to a dropdown category.',
          rows,
          total: rows.reduce(
            (sum, r) => sum + (r.operation === 'debit' ? -Number(r.amount) : Number(r.amount)),
            0,
          ),
        };
      })
      .sort((a, b) => Math.abs(b.total) - Math.abs(a.total));
  }, [data, categories]);

  const totalCount = data?.length ?? 0;
  const totalValue = groups.reduce((s, g) => s + g.total, 0);

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0">
            <CardTitle className="text-base font-semibold flex items-center gap-2">
              <ClipboardCheck className="h-4 w-4 text-muted-foreground" />
              Recent Approvals
            </CardTitle>
            <p className="mt-1 text-xs text-muted-foreground">
              Approved payouts by approval time (Kampala), grouped by the same categories used in
              the payout dropdown above. New approvals appear here straight away.
            </p>
          </div>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => refetch()}
            className="h-8 gap-1.5 text-xs"
          >
            <RefreshCw className={cn('h-3.5 w-3.5', isFetching && 'animate-spin')} />
            Refresh
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap items-center gap-2">
          {(['today', '7d', 'all'] as Scope[]).map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => setScope(s)}
              className={cn(
                'rounded-full border px-3 py-1.5 text-xs font-medium transition-colors',
                scope === s
                  ? 'border-primary bg-primary text-primary-foreground'
                  : 'border-border bg-muted/40 text-foreground hover:bg-muted',
              )}
            >
              {SCOPE_LABEL[s]}
            </button>
          ))}
          {!isLoading && !error && (
            <span className="ml-auto text-xs text-muted-foreground">
              {totalCount} approval{totalCount === 1 ? '' : 's'} ·{' '}
              <span className="font-semibold text-foreground">{formatUGX(totalValue)}</span>
            </span>
          )}
        </div>

        {isLoading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : error ? (
          <p className="text-sm text-destructive">Could not load recent approvals.</p>
        ) : groups.length === 0 ? (
          <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed border-border bg-muted/20 px-4 py-8 text-center">
            <Inbox className="h-5 w-5 text-muted-foreground" />
            <p className="text-sm font-medium">
              No approvals {scope === 'today' ? 'yet today' : 'in this period'}
            </p>
            <p className="text-xs text-muted-foreground">
              As soon as a payout is approved it will show up here under its category.
            </p>
          </div>
        ) : (
          <div className="space-y-4">
            {groups.map((group) => (
              <div key={group.id} className="rounded-xl border border-border">
                <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border bg-muted/30 px-3 py-2.5">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-semibold">{group.label}</p>
                    <p className="line-clamp-1 text-xs text-muted-foreground">
                      {group.rows.length} approval{group.rows.length === 1 ? '' : 's'}
                    </p>
                  </div>
                  <Badge variant="secondary" className="shrink-0 text-xs font-semibold">
                    {formatUGX(group.total)}
                  </Badge>
                </div>
                <ul className="divide-y divide-border">
                  {group.rows.slice(0, PER_CATEGORY_PREVIEW).map((row) => {
                    const isDebit = row.operation === 'debit';
                    return (
                      <li key={row.id}>
                        <button
                          type="button"
                          onClick={() => setOpenRow(row)}
                          className="flex w-full items-center gap-3 px-3 py-3 text-left transition-colors hover:bg-muted/40"
                        >
                          <div className="min-w-0 flex-1 space-y-0.5">
                            <p className="truncate text-sm font-medium">
                              {row.reference_id || row.evidence || 'Approval'}
                            </p>
                            <p className="truncate text-xs text-muted-foreground">
                              {row.beneficiary?.full_name || 'Unknown recipient'}
                              {row.approver ? ` • approved by ${row.approver}` : ''}
                            </p>
                            <p className="text-[11px] text-muted-foreground">
                              {formatKampala(row.created_at)}
                            </p>
                          </div>
                          <div className="flex shrink-0 flex-col items-end gap-1">
                            <span
                              className={cn(
                                'text-sm font-semibold',
                                isDebit ? 'text-destructive' : 'text-emerald-600',
                              )}
                            >
                              {isDebit ? '−' : '+'}
                              {formatUGX(Number(row.amount))}
                            </span>
                            <Badge variant="secondary" className="text-[10px]">
                              {isDebit ? 'Taken out' : 'Approved'}
                            </Badge>
                          </div>
                          <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
                        </button>
                      </li>
                    );
                  })}
                </ul>
                {group.rows.length > PER_CATEGORY_PREVIEW && (
                  <p className="border-t border-border px-3 py-2 text-[11px] text-muted-foreground">
                    Showing {PER_CATEGORY_PREVIEW} of {group.rows.length} approvals in this category.
                  </p>
                )}
              </div>
            ))}
          </div>
        )}
      </CardContent>

      <Dialog open={!!openRow} onOpenChange={(o) => !o && setOpenRow(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="text-base">Approval details</DialogTitle>
            <DialogDescription className="text-xs">
              {openRow?.reference_id || 'Recorded wallet movement'}
            </DialogDescription>
          </DialogHeader>
          {openRow && (
            <dl className="space-y-2.5 text-sm">
              {[
                ['Category', openRow.metadata?.category_label || openRow.evidence || '—'],
                ['Subcategory', openRow.metadata?.sub_category || '—'],
                [
                  'Recipient',
                  `${openRow.beneficiary?.full_name || 'Unknown'}${
                    openRow.beneficiary?.phone ? ` (${openRow.beneficiary.phone})` : ''
                  }`,
                ],
                ['Amount', `${openRow.operation === 'debit' ? '−' : '+'}${formatUGX(Number(openRow.amount))}`],
                [
                  'Destination',
                  openRow.metadata?.recipient_type === 'operational_wallet'
                    ? 'Operational float'
                    : 'User wallet',
                ],
                ['Approved by', openRow.approver || '—'],
                ['Approved at', formatKampala(openRow.created_at)],
                ['Status', openRow.operation === 'debit' ? 'Taken out' : 'Approved'],
                ['Reason / note', openRow.evidence || '—'],
              ].map(([label, value]) => (
                <div key={String(label)} className="flex gap-3">
                  <dt className="w-32 shrink-0 text-xs text-muted-foreground">{label}</dt>
                  <dd className="min-w-0 flex-1 break-words font-medium">{String(value)}</dd>
                </div>
              ))}
            </dl>
          )}
          <Button variant="outline" size="sm" onClick={() => setOpenRow(null)}>
            Close
          </Button>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
