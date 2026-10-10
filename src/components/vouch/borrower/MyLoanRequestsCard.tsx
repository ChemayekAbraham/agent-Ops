import { useEffect, useState, lazy, Suspense } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { HandCoins } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
import { formatUGX } from '@/lib/rentCalculations';

const BorrowLoanSheet = lazy(() => import('./BorrowLoanSheet'));

interface RequestRow {
  id: string;
  lender_agent_id: string;
  requested_amount_ugx: number;
  requested_duration_days: number | null;
  interest_rate_pct: number | null;
  purpose: string | null;
  status: string;
  decline_reason: string | null;
  loan_id: string | null;
  created_at: string;
}

const STATUS_META: Record<string, { label: string; badge: string; hint: string }> = {
  pending: { label: 'Waiting for agent', badge: 'bg-amber-500/15 text-amber-700', hint: 'The lending agent will review your request soon' },
  approved: { label: 'Approved', badge: 'bg-emerald-500/15 text-emerald-700', hint: 'Approved — check your wallet for the money' },
  declined: { label: 'Declined', badge: 'bg-destructive/15 text-destructive', hint: 'Try another offer or a smaller amount' },
};

/** Borrower home: status of each loan request the borrower has submitted. */
export function MyLoanRequestsCard({ userId }: { userId: string }) {
  const { user } = useAuth();
  const [requests, setRequests] = useState<RequestRow[]>([]);
  const [lenderNames, setLenderNames] = useState<Record<string, string>>({});
  const [loaded, setLoaded] = useState(false);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!userId) return;
    let cancelled = false;
    const load = async () => {
      const { data } = await (supabase
        .from('lending_loan_requests' as any)
        .select('id, lender_agent_id, requested_amount_ugx, requested_duration_days, interest_rate_pct, purpose, status, decline_reason, loan_id, created_at')
        .eq('borrower_user_id', userId)
        .order('created_at', { ascending: false })
        .limit(8) as any);
      if (cancelled) return;
      const rows = (data as RequestRow[]) ?? [];
      setRequests(rows);
      setLoaded(true);
      const ids = [...new Set(rows.map((r) => r.lender_agent_id))];
      if (ids.length > 0) {
        const { data: profs } = await (supabase
          .from('profiles')
          .select('id, full_name')
          .in('id', ids) as any);
        if (!cancelled && profs) {
          setLenderNames(Object.fromEntries((profs as any[]).map((p) => [p.id, p.full_name ?? 'Lending agent'])));
        }
      }
    };
    load();
    return () => { cancelled = true; };
  }, [userId]);

  // Realtime: keep statuses fresh when the lending agent decides
  useEffect(() => {
    if (!userId || !user) return;
    const channel = supabase
      .channel(`my-loan-requests-${userId}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'lending_loan_requests', filter: `borrower_user_id=eq.${userId}` },
        () => { setLoaded(false); },
      )
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [userId, user]);

  if (!userId || !loaded || requests.length === 0) return null;

  return (
    <>
      <Card>
        <CardContent className="p-3.5 space-y-2.5">
          <div className="flex items-center justify-between">
            <p className="flex items-center gap-1.5 text-sm font-bold">
              <HandCoins className="h-4 w-4 text-primary" /> My loan requests
            </p>
            <button className="text-xs font-semibold text-primary" onClick={() => setOpen(true)}>New request</button>
          </div>
          {requests.map((r) => {
            const meta = STATUS_META[r.status] ?? STATUS_META.pending;
            return (
              <div key={r.id} className="rounded-xl border bg-muted/20 p-2.5 space-y-1">
                <div className="flex items-center justify-between gap-2">
                  <p className="text-sm font-bold">{formatUGX(Number(r.requested_amount_ugx))}</p>
                  <Badge className={`${meta.badge} border-0 text-[9px] font-bold`}>{meta.label}</Badge>
                </div>
                <p className="truncate text-[11px] text-muted-foreground">
                  {lenderNames[r.lender_agent_id] ?? 'Lending agent'}
                  {r.interest_rate_pct ? ` · ${Number(r.interest_rate_pct)}%` : ''}
                  {r.requested_duration_days ? ` · ${r.requested_duration_days} days` : ''}
                  {' · '}
                  {new Date(r.created_at).toLocaleDateString()}
                </p>
                <p className="text-[11px] text-muted-foreground">{meta.hint}</p>
                {r.status === 'declined' && r.decline_reason && (
                  <p className="text-[11px] text-muted-foreground italic">Reason: {r.decline_reason}</p>
                )}
              </div>
            );
          })}
        </CardContent>
      </Card>
      {open && (
        <Suspense fallback={null}>
          <BorrowLoanSheet open={open} onOpenChange={setOpen} />
        </Suspense>
      )}
    </>
  );
}

export default MyLoanRequestsCard;
