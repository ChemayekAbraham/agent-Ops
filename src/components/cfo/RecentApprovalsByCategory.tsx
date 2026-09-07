import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
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
import { Loader2, ClipboardCheck, ChevronRight, Inbox } from 'lucide-react';
import { formatUGX } from '@/lib/rentCalculations';
import { format } from 'date-fns';
import { cn } from '@/lib/utils';
import { PAYOUT_CATEGORIES } from './DirectCreditTool';

const RECENT_WINDOW = 300;
const PER_CATEGORY_PREVIEW = 6;

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

/** Strip the leading emoji/decoration so a stored label can be compared to a dropdown label. */
function normaliseLabel(value: string): string {
  return value
    .replace(/[^\p{L}\p{N}\s&]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

export function RecentApprovalsByCategory() {
  // Categories are read straight from the page's existing payout dropdown list.
  const categories = PAYOUT_CATEGORIES;
  const [activeCategoryId, setActiveCategoryId] = useState<string>(categories[0]?.id ?? '');
  const [openRow, setOpenRow] = useState<ApprovalRow | null>(null);

  const { data, isLoading, error } = useQuery({
    queryKey: ['cfo-recent-approvals-by-category'],
    refetchOnWindowFocus: false,
    staleTime: 30_000,
    queryFn: async (): Promise<ApprovalRow[]> => {
      const { data: rows, error: rowsErr } = await supabase
        .from('platform_wallet_corrections')
        .select('id, operation, amount, evidence, reference_id, created_at, created_by, target_user_id, metadata')
        .eq('tool', 'cfo_direct_credit')
        .order('created_at', { ascending: false })
        .limit(RECENT_WINDOW);
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

  const grouped = useMemo(() => {
    const buckets: Record<string, ApprovalRow[]> = Object.fromEntries(
      categories.map((c) => [c.id, [] as ApprovalRow[]]),
    );
    const byLabel = new Map(categories.map((c) => [normaliseLabel(c.label), c.id]));

    for (const row of data ?? []) {
      const meta = row.metadata ?? {};
      const label = typeof meta.category_label === 'string' ? meta.category_label : '';
      const base = label.split('—')[0].split('/')[0];
      let categoryId =
        byLabel.get(normaliseLabel(label)) ?? byLabel.get(normaliseLabel(base)) ?? null;

      if (!categoryId) {
        const match = categories.find(
          (c) =>
            c.platformCategory === meta.platform_category &&
            c.walletCategory === meta.wallet_category &&
            c.allowedOps.includes(row.operation as any),
        );
        categoryId = match?.id ?? null;
      }
      if (categoryId && buckets[categoryId]) buckets[categoryId].push(row);
    }
    return buckets;
  }, [data, categories]);

  const activeCategory = categories.find((c) => c.id === activeCategoryId) ?? categories[0];
  const activeRows = grouped[activeCategory?.id ?? ''] ?? [];

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base font-semibold flex items-center gap-2">
          <ClipboardCheck className="h-4 w-4 text-muted-foreground" />
          Recent Approvals
        </CardTitle>
        <p className="text-xs text-muted-foreground">
          Approved payouts grouped by the same categories used in the payout dropdown above. Tap a
          category, then tap an approval to see its full details.
        </p>
      </CardHeader>
      <CardContent className="space-y-4">
        {isLoading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : error ? (
          <p className="text-sm text-destructive">Could not load recent approvals.</p>
        ) : (
          <>
            {/* Category selector — one chip per existing dropdown category */}
            <div className="-mx-1 flex gap-2 overflow-x-auto px-1 pb-1">
              {categories.map((c) => {
                const count = grouped[c.id]?.length ?? 0;
                const isActive = c.id === activeCategory?.id;
                return (
                  <button
                    key={c.id}
                    type="button"
                    onClick={() => setActiveCategoryId(c.id)}
                    className={cn(
                      'flex shrink-0 items-center gap-2 rounded-full border px-3 py-1.5 text-xs transition-colors',
                      isActive
                        ? 'border-primary bg-primary text-primary-foreground'
                        : 'border-border bg-muted/40 text-foreground hover:bg-muted',
                    )}
                  >
                    <span className="max-w-[190px] truncate font-medium">{c.label}</span>
                    <span
                      className={cn(
                        'rounded-full px-1.5 py-0.5 text-[10px] font-semibold',
                        isActive ? 'bg-primary-foreground/20' : 'bg-background',
                      )}
                    >
                      {count}
                    </span>
                  </button>
                );
              })}
            </div>

            {activeCategory && (
              <div className="space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="min-w-0">
                    <p className="text-sm font-semibold">{activeCategory.label}</p>
                    <p className="text-xs text-muted-foreground line-clamp-2">
                      {activeCategory.description}
                    </p>
                  </div>
                  <Badge variant="secondary" className="text-xs">
                    {activeRows.length} recent approval{activeRows.length === 1 ? '' : 's'}
                  </Badge>
                </div>

                {activeRows.length === 0 ? (
                  <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed border-border bg-muted/20 px-4 py-8 text-center">
                    <Inbox className="h-5 w-5 text-muted-foreground" />
                    <p className="text-sm font-medium">No recent approvals in this category</p>
                    <p className="text-xs text-muted-foreground">
                      Approvals recorded under {activeCategory.label} will appear here.
                    </p>
                  </div>
                ) : (
                  <ul className="divide-y divide-border rounded-xl border border-border">
                    {activeRows.slice(0, PER_CATEGORY_PREVIEW).map((row) => {
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
                                {format(new Date(row.created_at), 'dd MMM yyyy, HH:mm')}
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
                )}
              </div>
            )}
          </>
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
                ['Approved at', format(new Date(openRow.created_at), 'dd MMM yyyy, HH:mm')],
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
