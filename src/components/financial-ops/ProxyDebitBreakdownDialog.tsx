import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger, DialogDescription,
} from '@/components/ui/dialog';
import { Loader2, Wallet, Undo2, AlertTriangle, UserCheck, ArrowRight } from 'lucide-react';
import { format } from 'date-fns';
import { useToast } from '@/hooks/use-toast';

const fmtUgx = (n: number | null | undefined) =>
  n === null || n === undefined || !Number.isFinite(Number(n))
    ? '—'
    : `UGX ${Math.round(Number(n)).toLocaleString()}`;

/** A single managed-proxy debit charged on the proxy agent's wallet on
 *  behalf of a managed user (partner). Reconstructed from
 *  `email_routing_history` (the panel already reads this table). */
interface ProxyDebit {
  id: string;
  created_at: string;
  amount: number;
  reason: string;
  subject: string | null;
  transaction_id: string | null;
  ledger_reference_id: string | null;
}

interface ProxyDebitBreakdownDialogProps {
  /** The managed user whose payout was charged to the proxy. */
  partner: { id: string; name: string | null };
  /** The managed proxy agent whose wallet was (or can be) debited. */
  proxy: { agentId: string; agentName: string | null };
  children: ReactNode;
  /** Fired after a successful reversal so the parent can refresh balances. */
  onChanged?: () => void;
}

const REVERSAL_ROUTE = 'proxy_reversal_to_user';

/**
 * ProxyDebitBreakdownDialog
 * -------------------------
 * Opens a per-(managed user → proxy agent) breakdown of every wallet debit
 * that was charged to the proxy agent on that managed user's behalf, with
 * a running total and live wallet positions for both parties.
 *
 * When a proxy debit was taken even though the managed user currently holds
 * enough withdrawable balance, the row is marked and the operator can trigger
 * a correction: "Refund proxy + debit user" — it credits the amount back to
 * the proxy wallet and debits the managed user's wallet instead, both through
 * the single sanctioned CFO Direct Debit/Credit channel.
 */
export function ProxyDebitBreakdownDialog({ partner, proxy, children, onChanged }: ProxyDebitBreakdownDialogProps) {
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [debits, setDebits] = useState<ProxyDebit[]>([]);
  const [reversedIds, setReversedIds] = useState<Set<string>>(new Set());
  const [proxyAvail, setProxyAvail] = useState<number | null>(null);
  const [userAvail, setUserAvail] = useState<number | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  // Per-row required reason capture for the reversal correction.
  const [reasonForId, setReasonForId] = useState<string | null>(null);
  const [reasonText, setReasonText] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const partnerName = (partner.name ?? '').trim().toLowerCase();
      const [histRes, proxyBalRes, userBalRes] = await Promise.all([
        (supabase.from('email_routing_history') as any)
          .select('id,created_at,amount,reason,subject,transaction_id,ledger_reference_id,route,target_user_id')
          .eq('target_user_id', proxy.agentId)
          .order('created_at', { ascending: false })
          .limit(500),
        (supabase.rpc as any)('get_user_available_balance', { p_user_id: proxy.agentId }),
        (supabase.rpc as any)('get_user_available_balance', { p_user_id: partner.id }),
      ]);

      const all = (histRes?.data ?? []) as Array<ProxyDebit & { route: string }>;
      // Managed-proxy debits charged for THIS managed user. The edge functions
      // write the reason as "...via managed proxy for <partner name>...".
      const mine = all.filter((h) => {
        const reason = (h.reason ?? '').toLowerCase();
        if (!reason.includes('managed proxy')) return false;
        // When we can, scope to this partner by name to avoid bleeding in
        // debits the agent took for a different beneficiary.
        if (partnerName) return reason.includes(partnerName);
        return true;
      });
      // Reversal markers we previously wrote (route = proxy_reversal_to_user)
      // carry "[rev:<original routing id>]" so we can mark a debit corrected.
      const reversed = new Set<string>();
      for (const h of all) {
        if (h.route !== REVERSAL_ROUTE) continue;
        const m = (h.reason ?? '').match(/\[rev:([0-9a-f-]+)\]/i);
        if (m?.[1]) reversed.add(m[1]);
      }
      setDebits(mine);
      setReversedIds(reversed);
      setProxyAvail(Number(proxyBalRes?.data ?? 0));
      setUserAvail(Number(userBalRes?.data ?? 0));
    } catch (e) {
      console.warn('[ProxyDebitBreakdownDialog] load failed', e);
    } finally {
      setLoading(false);
    }
  }, [partner.id, partner.name, proxy.agentId]);

  useEffect(() => {
    if (open) void load();
  }, [open, load]);

  const totalDebited = debits
    .filter((d) => !reversedIds.has(d.id))
    .reduce((s, d) => s + Number(d.amount ?? 0), 0);

  // Correction: refund the proxy and charge the managed user instead.
  // Order is deliberate — refund the proxy FIRST so a mid-flight failure can
  // only ever leave the payout under-collected (recoverable), never double
  // charged across two real people.
  const reverseToUser = async (d: ProxyDebit, reason: string) => {
    const amount = Number(d.amount ?? 0);
    if (!(amount > 0)) return;
    const trimmedReason = reason.trim();
    if (trimmedReason.length < 10) {
      toast({
        title: 'Reason required',
        description: 'Enter a reason of at least 10 characters for this reversal.',
        variant: 'destructive',
      });
      return;
    }
    setBusyId(d.id);
    try {
      const idTag = `[rev:${d.id}]`;
      // 1. Refund the proxy agent (credit back what was wrongly taken).
      const { data: cData, error: cErr } = await supabase.functions.invoke('cfo-direct-credit', {
        body: {
          target_user_id: proxy.agentId,
          amount,
          reason:
            `Refund managed-proxy debit ${idTag} — managed user ${partner.name || partner.id} ` +
            `had sufficient balance; reversing charge wrongly taken from proxy ${proxy.agentName || proxy.agentId}.`,
          operation: 'credit' as const,
          wallet_category: 'wallet_transfer',
          platform_category: 'wallet_transfer',
          financial_impact: 'neutral' as const,
          category_label: 'Proxy debit refund (correction)',
          recipient_type: 'user',
          sub_category: d.transaction_id ?? null,
        },
      });
      if (cErr) throw new Error((cErr as any)?.message || 'Proxy refund failed');
      if ((cData as any)?.error) throw new Error((cData as any).error);

      // 2. Debit the managed user (who should have paid in the first place).
      const { data: dData, error: dErr } = await supabase.functions.invoke('cfo-direct-credit', {
        body: {
          target_user_id: partner.id,
          amount,
          reason:
            `Charge managed user ${idTag} — moved payout charge from proxy ` +
            `${proxy.agentName || proxy.agentId} to ${partner.name || partner.id} who had funds.`,
          operation: 'debit' as const,
          wallet_category: 'wallet_transfer',
          platform_category: 'wallet_transfer',
          financial_impact: 'neutral' as const,
          category_label: 'Email charge → Withdrawable (proxy correction)',
          recipient_type: 'user',
          sub_category: d.transaction_id ?? null,
        },
      });
      if (dErr || (dData as any)?.error) {
        const msg = (dErr as any)?.message || (dData as any)?.error || 'User debit failed';
        throw new Error(
          `Proxy was refunded, but charging the managed user failed (${msg}). ` +
          `Their balance may have changed — debit the user manually to finish the correction.`,
        );
      }

      // 3. Persist a reversal marker so the row stays corrected across reloads.
      try {
        const { data: me } = await supabase.auth.getUser();
        let routedByName: string | null = null;
        if (me?.user?.id) {
          const { data: rp } = await (supabase.from('profiles') as any)
            .select('full_name').eq('id', me.user.id).maybeSingle();
          routedByName = rp?.full_name ?? null;
        }
        await (supabase.from('email_routing_history') as any).insert({
          gmail_transaction_id: null,
          gmail_message_id: null,
          transaction_id: d.transaction_id ?? null,
          from_email: null,
          from_name: null,
          subject: d.subject ?? null,
          amount,
          route: REVERSAL_ROUTE,
          target_user_id: partner.id,
          target_user_name: partner.name,
          target_user_phone: null,
          reason:
            `Reversed managed-proxy debit ${idTag}: refunded ${proxy.agentName || 'proxy'} ` +
            `and debited ${partner.name || 'managed user'} (who had funds). Financial Ops correction. ` +
            `Reason: ${trimmedReason}`,
          ledger_reference_id: (dData as any)?.reference_id ?? null,
          routed_by: me?.user?.id ?? null,
          routed_by_name: routedByName,
          sms_sent: false,
          sms_error: null,
        });

        // 4. Audit log — record who reversed, the affected managed user and
        //    proxy agent, the amount and the mandatory reason.
        await supabase.from('audit_logs').insert({
          user_id: me?.user?.id ?? null,
          action_type: 'proxy_debit_reversal',
          table_name: 'email_routing_history',
          record_id: d.id,
          metadata: {
            reason: trimmedReason,
            amount,
            affected_user_id: partner.id,
            affected_user_name: partner.name,
            proxy_agent_id: proxy.agentId,
            proxy_agent_name: proxy.agentName,
            transaction_id: d.transaction_id ?? null,
            original_routing_id: d.id,
            reversal_route: REVERSAL_ROUTE,
            reversed_by_name: routedByName,
          },
        });
      } catch (e) {
        console.warn('[ProxyDebitBreakdownDialog] reversal marker / audit insert failed', e);
      }

      toast({
        title: 'Correction applied',
        description: `Refunded ${fmtUgx(amount)} to ${proxy.agentName || 'proxy'} and debited ${partner.name || 'the user'}.`,
      });
      setReversedIds((cur) => new Set(cur).add(d.id));
      setReasonForId(null);
      setReasonText('');
      await load();
      onChanged?.();
    } catch (e: any) {
      toast({ title: 'Correction failed', description: e?.message || String(e), variant: 'destructive' });
    } finally {
      setBusyId(null);
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>{children}</DialogTrigger>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-base">
            <Wallet className="h-4 w-4 text-amber-600" />
            Proxy wallet debits for {partner.name || 'this user'}
          </DialogTitle>
          <DialogDescription className="text-xs">
            Every charge taken from <strong>{proxy.agentName || 'the proxy agent'}</strong>'s wallet
            on behalf of <strong>{partner.name || 'this managed user'}</strong>.
          </DialogDescription>
        </DialogHeader>

        <div className="grid grid-cols-2 gap-2 text-xs">
          <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-2">
            <p className="text-[10px] uppercase tracking-wider text-amber-700 font-semibold flex items-center gap-1">
              <UserCheck className="h-3 w-3" /> Proxy agent
            </p>
            <p className="font-medium truncate">{proxy.agentName || '—'}</p>
            <p className="font-mono text-foreground/80">Wallet: {proxyAvail === null ? '…' : fmtUgx(proxyAvail)}</p>
          </div>
          <div className="rounded-lg border border-primary/30 bg-primary/5 p-2">
            <p className="text-[10px] uppercase tracking-wider text-primary font-semibold flex items-center gap-1">
              <Wallet className="h-3 w-3" /> Managed user
            </p>
            <p className="font-medium truncate">{partner.name || '—'}</p>
            <p className="font-mono text-foreground/80">Wallet: {userAvail === null ? '…' : fmtUgx(userAvail)}</p>
          </div>
        </div>

        <div className="flex items-center justify-between rounded-lg bg-muted/60 px-3 py-1.5 text-xs">
          <span className="text-muted-foreground">Total charged to proxy for this user</span>
          <span className="font-mono font-semibold text-rose-700">−{fmtUgx(totalDebited)}</span>
        </div>

        <div className="max-h-72 overflow-y-auto space-y-1.5 pr-1">
          {loading ? (
            <div className="flex items-center justify-center py-6 text-muted-foreground text-xs gap-2">
              <Loader2 className="h-4 w-4 animate-spin" /> Loading debits…
            </div>
          ) : debits.length === 0 ? (
            <p className="text-center text-xs text-muted-foreground py-6">
              No proxy-wallet debits recorded for this user.
            </p>
          ) : (
            debits.map((d) => {
              const amount = Number(d.amount ?? 0);
              const isReversed = reversedIds.has(d.id);
              // "User had money" — current withdrawable can cover this charge.
              const userHasFunds = userAvail !== null && userAvail >= amount;
              const canReverse = !isReversed && userHasFunds;
              return (
                <div
                  key={d.id}
                  className={`rounded-lg border p-2 text-xs ${
                    isReversed
                      ? 'border-emerald-500/30 bg-emerald-500/5'
                      : userHasFunds
                        ? 'border-amber-500/40 bg-amber-500/5'
                        : 'border-border bg-background'
                  }`}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="font-mono font-semibold text-rose-700">−{fmtUgx(amount)}</p>
                      <p className="text-muted-foreground truncate">{d.subject || 'Outgoing payment email'}</p>
                      <p className="text-[10px] text-muted-foreground/80">
                        {format(new Date(d.created_at), 'MMM d, yyyy HH:mm')}
                        {d.transaction_id ? ` · TID ${d.transaction_id}` : ''}
                      </p>
                    </div>
                    <div className="shrink-0 flex flex-col items-end gap-1">
                      {isReversed ? (
                        <Badge variant="success" className="text-[10px] gap-1">
                          <ArrowRight className="h-3 w-3" /> moved to user
                        </Badge>
                      ) : userHasFunds ? (
                        <Badge variant="warning" className="text-[10px] gap-1">
                          <AlertTriangle className="h-3 w-3" /> user had funds
                        </Badge>
                      ) : (
                        <Badge variant="muted" className="text-[10px]">proxy covered</Badge>
                      )}
                      {canReverse && (
                        reasonForId === d.id ? null : (
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={busyId === d.id}
                            onClick={() => { setReasonForId(d.id); setReasonText(''); }}
                            className="h-6 text-[10px] gap-1 border-rose-300 text-rose-700 hover:bg-rose-50"
                            title="Refund the proxy agent and debit the managed user instead"
                          >
                            <Undo2 className="h-3 w-3" />
                            Refund proxy + debit user
                          </Button>
                        )
                      )}
                    </div>
                  </div>
                  {canReverse && reasonForId === d.id && (
                    <div className="mt-2 space-y-1.5 rounded-md border border-rose-200 bg-rose-50/60 p-2">
                      <label className="text-[10px] font-semibold uppercase tracking-wider text-rose-700">
                        Reason for reversal <span className="text-rose-500">(required, min 10 chars)</span>
                      </label>
                      <Textarea
                        value={reasonText}
                        onChange={(e) => setReasonText(e.target.value)}
                        placeholder={`Why move this charge from ${proxy.agentName || 'the proxy'} to ${partner.name || 'the user'}?`}
                        className="min-h-[56px] text-xs"
                        disabled={busyId === d.id}
                      />
                      <div className="flex items-center justify-end gap-2">
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-6 text-[10px]"
                          disabled={busyId === d.id}
                          onClick={() => { setReasonForId(null); setReasonText(''); }}
                        >
                          Cancel
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-6 text-[10px] gap-1 border-rose-300 text-rose-700 hover:bg-rose-50"
                          disabled={busyId === d.id || reasonText.trim().length < 10}
                          onClick={() => reverseToUser(d, reasonText)}
                        >
                          {busyId === d.id
                            ? <Loader2 className="h-3 w-3 animate-spin" />
                            : <Undo2 className="h-3 w-3" />}
                          Confirm reversal
                        </Button>
                      </div>
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}