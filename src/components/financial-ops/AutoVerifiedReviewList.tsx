/**
 * Payout destinations the system verified on its own (ID name match, or SMS code + face match). Nobody's withdrawal waits
 * on a call, so a person checks these afterwards: confirm the name on the number is the person on the ID, then mark it
 * reviewed. Reads and writes only through finops_auto_verified_review_* functions (migration 20261106120000).
 */
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { BadgeCheck, Loader2, Search, ShieldCheck } from 'lucide-react';
import { toast } from 'sonner';
import { format } from 'date-fns';
import { supabase } from '@/integrations/supabase/client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { formatUGX } from '@/lib/rentCalculations';
import { Pager } from './FinopsKit';

const PAGE_SIZE = 20;
export const AUTO_REVIEW_COUNT_KEY = ['payout-auto-verified-review-count'];

type Row = {
  id: string;
  user_id: string;
  full_name: string | null;
  user_phone: string | null;
  destination_type: 'mobile_money' | 'bank_transfer';
  provider: string | null;
  momo_number: string | null;
  bank_name: string | null;
  bank_account_number: string | null;
  account_name: string | null;
  national_id_name: string | null;
  name_match_score: number | null;
  sms_code_confirmed: boolean;
  decided_at: string | null;
  withdrawable_balance: number;
};

const rpc = (fn: string, args?: Record<string, unknown>) =>
  (supabase.rpc as unknown as (f: string, a?: Record<string, unknown>) => Promise<{ data: unknown; error: { message: string } | null }>)(fn, args);

/** Count for the tab badge. Returns null when the migration has not been applied yet, so the tab still opens and explains. */
export function useAutoVerifiedReviewCount() {
  return useQuery({
    queryKey: AUTO_REVIEW_COUNT_KEY,
    staleTime: 15_000,
    refetchInterval: 30_000,
    retry: false,
    queryFn: async () => {
      const { data, error } = await rpc('finops_auto_verified_review_count');
      if (error) return null;
      return Number(data ?? 0);
    },
  });
}

/** Marks an auto-verified destination as looked at by a person. Shared by the list and the case screen. */
export function useMarkAutoVerifiedReviewed() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const { error } = await rpc('finops_mark_auto_verified_reviewed', { p_destination_id: id, p_note: null });
      if (error) throw new Error(error.message);
    },
    onSuccess: () => {
      toast.success('Marked as reviewed');
      void qc.invalidateQueries({ queryKey: ['payout-auto-verified-review'] });
      void qc.invalidateQueries({ queryKey: AUTO_REVIEW_COUNT_KEY });
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Could not save the review.'),
  });
}

function destinationLabel(r: Row) {
  return r.destination_type === 'mobile_money'
    ? `${r.provider ?? 'Mobile money'} ${r.momo_number ?? ''}`.trim()
    : `${r.bank_name ?? 'Bank'} ${r.bank_account_number ?? ''}`.trim();
}

function matchChip(score: number | null) {
  if (score == null) return { text: 'No name score', cls: 'bg-muted text-muted-foreground' };
  if (score >= 0.9) return { text: `Names match ${Math.round(score * 100)}%`, cls: 'bg-emerald-500/15 text-emerald-700' };
  if (score >= 0.5) return { text: `Partly matches ${Math.round(score * 100)}%`, cls: 'bg-amber-500/15 text-amber-700' };
  return { text: `Names differ ${Math.round(score * 100)}%`, cls: 'bg-destructive/10 text-destructive' };
}

export default function AutoVerifiedReviewList() {
  const [input, setInput] = useState('');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(0);

  const list = useQuery({
    queryKey: ['payout-auto-verified-review', search, page],
    retry: false,
    queryFn: async () => {
      const { data, error } = await rpc('finops_auto_verified_review_queue', {
        p_search: search || null,
        p_limit: PAGE_SIZE,
        p_offset: page * PAGE_SIZE,
      });
      if (error) throw new Error(error.message);
      const d = data as { total?: number; rows?: Row[] } | null;
      return { total: Number(d?.total ?? 0), rows: d?.rows ?? [] };
    },
  });

  const review = useMarkAutoVerifiedReviewed();

  const missing = list.isError && /does not exist|could not find|schema cache/i.test(list.error instanceof Error ? list.error.message : '');

  return (
    <div className="space-y-3">
      <div className="rounded-2xl border border-primary/20 bg-primary/5 p-4 text-sm text-foreground">
        <p className="flex items-center gap-2 font-bold">
          <ShieldCheck className="h-4 w-4 text-primary" aria-hidden /> Verified by the system, waiting for a person
        </p>
        <p className="mt-1 text-muted-foreground">
          These people are already paid out without delay. Check that the name on the number is the person on the ID, then mark it reviewed.
        </p>
      </div>

      <div className="relative">
        <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden />
        <Input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') { setSearch(input.trim()); setPage(0); } }}
          onBlur={() => { setSearch(input.trim()); setPage(0); }}
          placeholder="Name or number"
          className="h-10 pl-8 text-sm"
          aria-label="Search auto-verified numbers"
        />
      </div>

      {list.isLoading ? (
        <Skeleton className="h-64 w-full rounded-2xl" />
      ) : missing ? (
        <div className="rounded-2xl border border-amber-500/40 bg-amber-500/10 p-4 text-sm">
          <p className="font-semibold text-foreground">This list is not switched on yet</p>
          <p className="mt-1 text-muted-foreground">The review database change (migration 20261106120000) has not been applied to this database.</p>
        </div>
      ) : list.isError ? (
        <div className="rounded-2xl border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">
          <p className="font-semibold">The list could not be loaded</p>
          <p>{list.error instanceof Error ? list.error.message : 'Something went wrong.'}</p>
          <Button size="sm" variant="outline" className="mt-2" onClick={() => list.refetch()}>Try again</Button>
        </div>
      ) : (list.data?.rows.length ?? 0) === 0 ? (
        <div className="rounded-2xl border border-border bg-card p-10 text-center">
          <BadgeCheck className="mx-auto mb-2 h-8 w-8 text-primary" aria-hidden />
          <p className="text-sm font-semibold text-foreground">Nothing to review</p>
        </div>
      ) : (
        <>
          <ul className="space-y-2">
            {list.data!.rows.map((r) => {
              const chip = matchChip(r.name_match_score);
              const busy = review.isPending && review.variables === r.id;
              return (
                <li key={r.id} className="flex flex-wrap items-center gap-3 rounded-2xl border border-border bg-card p-3.5 shadow-2xs">
                  <div className="min-w-0 flex-1 basis-60">
                    <p className="truncate text-sm font-bold text-foreground">{r.full_name ?? 'Unnamed account'}</p>
                    <p className="truncate text-xs text-muted-foreground">
                      {destinationLabel(r)}{r.account_name ? ` · ${r.account_name}` : ''}
                    </p>
                    <p className="truncate text-xs text-muted-foreground">
                      ID name: {r.national_id_name ?? '—'}
                      {r.decided_at ? ` · verified ${format(new Date(r.decided_at), 'd MMM yyyy')}` : ''}
                    </p>
                  </div>
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className={`rounded-full px-2.5 py-1 text-[11px] font-bold ${chip.cls}`}>{chip.text}</span>
                    {r.sms_code_confirmed && (
                      <span className="rounded-full bg-sky-500/15 px-2.5 py-1 text-[11px] font-bold text-sky-700">SMS code confirmed</span>
                    )}
                    <span className="rounded-full bg-muted px-2.5 py-1 text-[11px] font-bold text-muted-foreground tabular-nums">
                      {formatUGX(r.withdrawable_balance)}
                    </span>
                  </div>
                  <Button type="button" className="min-h-[44px] w-full sm:w-auto" disabled={busy} onClick={() => review.mutate(r.id)}>
                    {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <BadgeCheck className="h-4 w-4" aria-hidden />}
                    Mark reviewed
                  </Button>
                </li>
              );
            })}
          </ul>
          <Pager page={page} pageSize={PAGE_SIZE} total={list.data!.total} onPage={setPage} noun="numbers" />
        </>
      )}
    </div>
  );
}
