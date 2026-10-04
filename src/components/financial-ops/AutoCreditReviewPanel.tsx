import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { invokeEdgeFunction } from '@/lib/invokeEdgeFunction';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from '@/components/ui/dialog';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { toast } from 'sonner';
import { CheckCircle2, Undo2, ShieldAlert, Loader2, Mail, Phone, User } from 'lucide-react';
import { formatDynamic } from '@/lib/currencyFormat';

/**
 * Auto-Credit Review Queue
 * --------------------------------------------------------------
 * Surfaces deposits the Gmail poller auto-credited via the MTN
 * NAME fallback (best-guess winner among same-named profiles).
 * Ops can:
 *   • Confirm  → marks the credit reviewed, leaves wallet untouched
 *   • Reverse  → CFO-direct-debit pulls the funds back out of the
 *                target user's Operational Float and marks reversed
 *
 * Source row:  deposit_requests
 *   auto_approved = true
 *   auto_match_audit->>match_method = 'name'
 *   auto_credit_review_status IS NULL
 */

interface ReviewRow {
  id: string;
  user_id: string;
  amount: number;
  transaction_id: string | null;
  transaction_date: string | null;
  created_at: string;
  provider: string | null;
  auto_match_audit: any;
  profile?: {
    full_name: string | null;
    phone: string | null;
    email: string | null;
  } | null;
}

const PAGE_SIZE = 25;

export function AutoCreditReviewPanel() {
  const qc = useQueryClient();
  const [reverseTarget, setReverseTarget] = useState<ReviewRow | null>(null);
  const [reverseReason, setReverseReason] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);

  const { data: rows = [], isLoading, refetch } = useQuery({
    queryKey: ['auto-credit-review-queue'],
    queryFn: async (): Promise<ReviewRow[]> => {
      const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
      const { data, error } = await supabase
        .from('deposit_requests')
        .select(
          'id, user_id, amount, transaction_id, transaction_date, created_at, provider, auto_match_audit'
        )
        .eq('auto_approved', true)
        .is('auto_credit_review_status', null)
        .filter('auto_match_audit->>match_method', 'eq', 'name')
        .gte('created_at', since)
        .order('created_at', { ascending: false })
        .limit(PAGE_SIZE);
      if (error) throw error;
      const list = (data ?? []) as ReviewRow[];
      const ids = Array.from(new Set(list.map(r => r.user_id))).filter(Boolean);
      if (ids.length) {
        const { data: profs } = await supabase
          .from('profiles')
          .select('id, full_name, phone, email')
          .in('id', ids);
        const map = new Map((profs ?? []).map((p: any) => [p.id, p]));
        list.forEach(r => { r.profile = map.get(r.user_id) ?? null; });
      }
      return list;
    },
    staleTime: 15_000,
  });

  const confirm = async (row: ReviewRow) => {
    setBusyId(row.id);
    try {
      const { data: auth } = await supabase.auth.getUser();
      const { error } = await supabase
        .from('deposit_requests')
        .update({
          auto_credit_review_status: 'confirmed',
          auto_credit_reviewed_by: auth.user?.id ?? null,
          auto_credit_reviewed_at: new Date().toISOString(),
        })
        .eq('id', row.id);
      if (error) throw error;
      toast.success('Credit confirmed');
      qc.invalidateQueries({ queryKey: ['auto-credit-review-queue'] });
    } catch (e: any) {
      toast.error('Could not confirm', { description: e?.message ?? String(e) });
    } finally {
      setBusyId(null);
    }
  };

  const submitReverse = async () => {
    if (!reverseTarget) return;
    const reason = reverseReason.trim();
    if (reason.length < 10) {
      toast.error('Add a reason of at least 10 characters');
      return;
    }
    setBusyId(reverseTarget.id);
    try {
      const tid = reverseTarget.transaction_id ?? 'no-tid';
      const { data, error } = await invokeEdgeFunction('cfo-direct-credit', {
        body: {
          target_user_id: reverseTarget.user_id,
          amount: reverseTarget.amount,
          operation: 'debit',
          recipient_type: 'operational_wallet',
          wallet_category: 'agent_float_deposit',
          reason: `Reverse auto-credit dep=${reverseTarget.id} tid=${tid}: ${reason}`,
          sub_category: 'auto_credit_reversal',
        },
        errorTitle: 'Reversal failed',
      });
      if (error) return;
      const { data: auth } = await supabase.auth.getUser();
      // 1. Mark the deposit row reversed + cancel its status so it no
      //    longer counts as a live credit anywhere downstream.
      await supabase
        .from('deposit_requests')
        .update({
          status: 'cancelled',
          auto_credit_review_status: 'reversed',
          auto_credit_reviewed_by: auth.user?.id ?? null,
          auto_credit_reviewed_at: new Date().toISOString(),
          auto_credit_review_notes: reason,
        })
        .eq('id', reverseTarget.id);

      // 2. Free the original Gmail receipt so Email Transactions shows it
      //    again as "unrouted" and ops can re-route to the correct user.
      //    Partial unique index allows multiple NULLs, so unlink is safe.
      await supabase
        .from('gmail_transactions')
        .update({
          linked_deposit_request_id: null,
          auto_matched_at: null,
          auto_match_method: null,
        })
        .eq('linked_deposit_request_id', reverseTarget.id);

      toast.success('Credit reversed', {
        description:
          'Float debited, deposit cancelled and email receipt unlinked — re-route it from Email Transactions.',
      });
      setReverseTarget(null);
      setReverseReason('');
      qc.invalidateQueries({ queryKey: ['auto-credit-review-queue'] });
    } catch (e: any) {
      toast.error('Reversal failed', { description: e?.message ?? String(e) });
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-xl sm:text-2xl font-bold flex items-center gap-2.5">
          <ShieldAlert className="h-6 w-6 text-amber-600" />
          Auto-Credit Review
        </h2>
        <p className="text-sm text-muted-foreground mt-1">
          Deposits auto-credited by best-guess name matching. Confirm or reverse if the wrong user was picked.
        </p>
      </div>

      {isLoading ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground p-6 justify-center">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading queue…
        </div>
      ) : rows.length === 0 ? (
        <Card>
          <CardContent className="py-10 text-center text-sm text-muted-foreground">
            <CheckCircle2 className="h-8 w-8 text-success mx-auto mb-2" />
            Nothing pending. All recent auto-credits look clean.
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {rows.map((r) => {
            const audit = r.auto_match_audit ?? {};
            const tieKey: string = String(audit.tiebreaker ?? '');
            const risky = tieKey === 'first-candidate' || tieKey === 'most-recent-active';
            return (
              <Card key={r.id} className={risky ? 'border-amber-500/40' : ''}>
                <CardHeader className="pb-2">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <CardTitle className="text-base flex items-center gap-2">
                        {formatDynamic(r.amount)}
                        <Badge variant="outline" className="text-[10px] uppercase">
                          {r.provider ?? '—'}
                        </Badge>
                        {tieKey && (
                          <Badge
                            variant={risky ? 'destructive' : 'secondary'}
                            className="text-[10px]"
                          >
                            {tieKey}
                          </Badge>
                        )}
                      </CardTitle>
                      <CardDescription className="mt-0.5">
                        TID {r.transaction_id ?? '—'} · {new Date(r.created_at).toLocaleString()}
                      </CardDescription>
                    </div>
                  </div>
                </CardHeader>
                <CardContent className="space-y-2 text-sm">
                  <div className="rounded-lg bg-muted/40 p-2.5 space-y-1">
                    <div className="flex items-center gap-2 font-medium">
                      <User className="h-3.5 w-3.5 text-muted-foreground" />
                      {r.profile?.full_name ?? '(no profile name)'}
                    </div>
                    <div className="flex items-center gap-2 text-xs text-muted-foreground">
                      <Phone className="h-3.5 w-3.5" />
                      {r.profile?.phone ?? 'no phone on file'}
                    </div>
                    {r.profile?.email && (
                      <div className="flex items-center gap-2 text-xs text-muted-foreground">
                        <Mail className="h-3.5 w-3.5" />
                        {r.profile.email}
                      </div>
                    )}
                  </div>
                  {audit.matched_name && (
                    <div className="text-xs text-muted-foreground">
                      Email sender name: <span className="font-mono">{String(audit.matched_name)}</span>
                    </div>
                  )}
                  {audit.name_match && (
                    <div className="rounded-lg border border-border/60 bg-background/60 p-2.5 space-y-1.5">
                      <div className="flex items-center justify-between gap-2">
                        <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                          Match audit
                        </div>
                        {audit.confidence && (
                          <Badge
                            variant={
                              audit.confidence === 'high'
                                ? 'secondary'
                                : audit.confidence === 'medium'
                                ? 'outline'
                                : 'destructive'
                            }
                            className="text-[10px]"
                          >
                            {audit.confidence} confidence
                            {typeof audit.confidence_score === 'number'
                              ? ` · ${(audit.confidence_score * 100).toFixed(0)}%`
                              : ''}
                          </Badge>
                        )}
                      </div>
                      <div className="text-[11px] text-muted-foreground">
                        Tie-breaker: <span className="font-mono">{tieKey || '—'}</span>
                        {audit.name_match.tiebreaker_pool && (
                          <> · pool: <span className="font-mono">{audit.name_match.tiebreaker_pool}</span></>
                        )}
                        {' · '}
                        {audit.name_match.total_candidates} candidate
                        {audit.name_match.total_candidates === 1 ? '' : 's'}
                      </div>
                      {Array.isArray(audit.confidence_reasons) && audit.confidence_reasons.length > 0 && (
                        <ul className="text-[11px] text-muted-foreground list-disc list-inside space-y-0.5">
                          {audit.confidence_reasons.map((reason: string, i: number) => (
                            <li key={i}>{reason}</li>
                          ))}
                        </ul>
                      )}
                      {Array.isArray(audit.name_match.candidates) && audit.name_match.candidates.length > 0 && (
                        <div className="space-y-1 pt-1">
                          <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
                            Candidate pool
                          </div>
                          {audit.name_match.candidates.map((c: any) => (
                            <div
                              key={c.id}
                              className={`flex items-center justify-between gap-2 text-[11px] rounded px-2 py-1 ${
                                c.selected ? 'bg-amber-500/10 border border-amber-500/30' : 'bg-muted/30'
                              }`}
                            >
                              <div className="min-w-0 truncate">
                                {c.selected && <span className="font-semibold">✓ </span>}
                                <span className="font-medium">{c.full_name ?? '(unnamed)'}</span>
                                {c.phone_last4 ? (
                                  <span className="text-muted-foreground"> · •••{c.phone_last4}</span>
                                ) : (
                                  <span className="text-muted-foreground"> · no phone</span>
                                )}
                              </div>
                              <span className="text-muted-foreground shrink-0">
                                {c.last_sign_in_at
                                  ? `seen ${new Date(c.last_sign_in_at).toLocaleDateString()}`
                                  : 'never signed in'}
                              </span>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                  <div className="flex flex-col sm:flex-row gap-2 pt-1">
                    <Button
                      size="sm"
                      variant="success"
                      disabled={busyId === r.id}
                      onClick={() => confirm(r)}
                      className="flex-1"
                    >
                      <CheckCircle2 className="h-4 w-4" />
                      Confirm credit
                    </Button>
                    <Button
                      size="sm"
                      variant="destructive"
                      disabled={busyId === r.id}
                      onClick={() => { setReverseTarget(r); setReverseReason(''); }}
                      className="flex-1"
                    >
                      <Undo2 className="h-4 w-4" />
                      Reverse credit
                    </Button>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      <Dialog open={!!reverseTarget} onOpenChange={(o) => { if (!o) setReverseTarget(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Reverse auto-credit</DialogTitle>
            <DialogDescription>
              This will debit {reverseTarget ? formatDynamic(reverseTarget.amount) : ''} from{' '}
              <span className="font-medium">{reverseTarget?.profile?.full_name ?? 'this user'}</span>'s
              Operational Float. After this, re-route the receipt to the correct user
              from Email Transactions.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <label className="text-xs font-medium text-muted-foreground">
              Reason (min 10 characters)
            </label>
            <Textarea
              value={reverseReason}
              onChange={(e) => setReverseReason(e.target.value)}
              placeholder="e.g. Wrong Benjamin Muhanguzi — correct user is 0783673998"
              rows={3}
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setReverseTarget(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={submitReverse}
              disabled={!!busyId || reverseReason.trim().length < 10}
            >
              {busyId ? <Loader2 className="h-4 w-4 animate-spin" /> : <Undo2 className="h-4 w-4" />}
              Reverse credit
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
