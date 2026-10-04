import { useCallback, useEffect, useState } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { invokeEdgeFunction } from '@/lib/invokeEdgeFunction';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { toast } from 'sonner';
import { Loader2, TrendingUp, Users, CheckCircle2, XCircle, Clock, Wallet } from 'lucide-react';

interface NextWindow {
  eligible: boolean;
  window_start: string | null;
  window_end: string | null;
  user_count: number;
  rate_per_user: number;
  amount: number;
}

interface Claim {
  id: string;
  claim_code: string;
  window_start: string;
  window_end: string;
  user_count: number;
  rate_per_user: number;
  amount: number;
  status: string;
  credited_at: string | null;
  created_at: string;
  requisition_id: string | null;
}

const fmtUGX = (n: number) => `UGX ${Math.round(n).toLocaleString('en-US')}`;

const fmtDate = (iso: string | null) =>
  iso
    ? new Date(iso).toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })
    : '—';

function StatusBadge({ status }: { status: string }) {
  if (status === 'released') {
    return (
      <Badge variant="outline" className="border-emerald-500/30 bg-emerald-500/10 text-emerald-700">
        <Wallet className="mr-1 h-3 w-3" /> Credited
      </Badge>
    );
  }
  if (status === 'rejected') {
    return (
      <Badge variant="outline" className="border-destructive/30 bg-destructive/10 text-destructive">
        <XCircle className="mr-1 h-3 w-3" /> Declined
      </Badge>
    );
  }
  if (status === 'approved') {
    return (
      <Badge variant="outline" className="border-blue-500/30 bg-blue-500/10 text-blue-700">
        <CheckCircle2 className="mr-1 h-3 w-3" /> Approved
      </Badge>
    );
  }
  return (
    <Badge variant="outline" className="border-amber-500/30 bg-amber-500/10 text-amber-700">
      <Clock className="mr-1 h-3 w-3" /> In review
    </Badge>
  );
}

/**
 * Growth commission: UGX 50 per new platform user, claimable at any time.
 * The card is self-gating — the entitlement lives in the database, so a user
 * without one simply sees nothing.
 */
export function GrowthCommissionCard() {
  const [entitled, setEntitled] = useState(false);
  const [next, setNext] = useState<NextWindow | null>(null);
  const [claims, setClaims] = useState<Claim[]>([]);
  const [loading, setLoading] = useState(true);
  const [claiming, setClaiming] = useState(false);

  const load = useCallback(async () => {
    const [{ data: win }, { data: rows }] = await Promise.all([
      supabase.rpc('growth_commission_next_window'),
      supabase
        .from('growth_commission_claims')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(20),
    ]);
    const w = (Array.isArray(win) ? win[0] : win) as NextWindow | undefined;
    setEntitled(!!w?.eligible);
    setNext(w ?? null);
    setClaims((rows ?? []) as Claim[]);
    setLoading(false);
  }, []);

  useEffect(() => {
    load();
    // 60s poll only. The old Realtime listener was on growth_commission_claims,
    // which is not in the publication, so it never fired (doc 147).
    const interval = setInterval(load, 60_000);
    return () => {
      clearInterval(interval);
    };
  }, [load]);

  const submitClaim = async () => {
    setClaiming(true);
    try {
      const { data, error } = await invokeEdgeFunction<{ ok?: boolean; message?: string; error?: string }>(
        'growth-commission-claim',
        { body: {}, silent: true },
      );
      if (error || data?.error) {
        toast.error(data?.message || data?.error || error?.message || 'Could not raise the claim');
        return;
      }
      toast.success('Claim sent to the CEO for review');
      await load();
    } finally {
      setClaiming(false);
    }
  };

  if (loading || !entitled) return null;

  const count = Number(next?.user_count ?? 0);
  const amount = Number(next?.amount ?? 0);

  return (
    <Card className="rounded-2xl border-primary/20 p-5">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="flex items-center gap-2 text-sm font-semibold text-muted-foreground">
            <TrendingUp className="h-4 w-4 text-primary" /> Growth commission
          </p>
          <p className="mt-2 text-3xl font-black tracking-tight">{fmtUGX(amount)}</p>
          <p className="mt-1 flex items-center gap-1.5 text-sm text-muted-foreground">
            <Users className="h-3.5 w-3.5" />
            {count.toLocaleString('en-US')} new platform users since {fmtDate(next?.window_start ?? null)}
          </p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {fmtUGX(Number(next?.rate_per_user ?? 50))} per new platform user · updates live
          </p>
        </div>
        <Button onClick={submitClaim} disabled={claiming || count <= 0}>
          {claiming ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
          Claim commission
        </Button>
      </div>

      {count <= 0 && (
        <p className="mt-3 rounded-lg bg-muted p-3 text-xs text-muted-foreground">
          Nothing to claim yet — new signups from now on will count towards your next claim.
        </p>
      )}

      {claims.length > 0 && (
        <div className="mt-5 border-t pt-4">
          <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            My claims
          </p>
          <div className="mt-2 space-y-2">
            {claims.map((c) => (
              <div
                key={c.id}
                className="flex flex-wrap items-center justify-between gap-2 rounded-lg border p-3"
              >
                <div className="min-w-0">
                  <p className="text-sm font-semibold">
                    {c.claim_code} · {fmtUGX(Number(c.amount))}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {Number(c.user_count).toLocaleString('en-US')} users ·{' '}
                    {fmtDate(c.window_start)} – {fmtDate(c.window_end)}
                  </p>
                  {c.credited_at && (
                    <p className="text-xs text-emerald-700">Credited {fmtDate(c.credited_at)}</p>
                  )}
                </div>
                <StatusBadge status={c.status} />
              </div>
            ))}
          </div>
        </div>
      )}
    </Card>
  );
}

export default GrowthCommissionCard;
