import { useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Input } from '@/components/ui/input';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { formatUGX } from '@/lib/agentAdvanceCalculations';
import { AlertTriangle, ArrowRightLeft, CheckCircle2, Clock, Loader2 } from 'lucide-react';
import { UserSearchPicker, type UserResult } from '@/components/cfo/UserSearchPicker';
import { advanceControlMessage, newIdempotencyKey, transferArgs, type TransferDestination } from '@/lib/advanceControls';

// The transfer / write-off tables and RPCs are newer than the generated types.
const db = supabase as any;

interface Props {
  advance: any | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess?: () => void;
}

type Mode = 'transfer' | 'recoup_from_wallet' | 'write_off';

interface OpenAdvance { id: string; principal: number; outstanding_balance: number; status: string; issued_at: string }
interface WriteOffRequest { id: string; status: string; amount: number; reason: string; requested_by: string; requested_at: string; decided_at: string | null; decision_note: string | null }

const MIN_REASON = 15;
const MIN_WRITE_OFF_REASON = 20;

/**
 * Closing an advance (CFO). A balance that is still owed is never dropped: it is moved to another advance with an
 * accounting-only transfer (no money moves), kept owed for recoup from the wallet, or written off after a second person
 * (another CFO or the CEO) approved the write-off. An advance with nothing owed is simply cancelled.
 */
export function CancelAdvanceDialog({ advance, open, onOpenChange, onSuccess }: Props) {
  const queryClient = useQueryClient();
  const outstanding = Number(advance?.outstanding_balance || 0);
  const owes = outstanding > 0;
  const agentName = advance?.profiles?.full_name || 'agent';
  const agentId: string | undefined = advance?.agent_id;

  const [mode, setMode] = useState<Mode>('transfer');
  const [reason, setReason] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [destination, setDestination] = useState<TransferDestination>('replacement');
  const [amount, setAmount] = useState('');
  const [roiPercent, setRoiPercent] = useState('20');
  const [partner, setPartner] = useState<UserResult | null>(null);
  const [toAdvanceId, setToAdvanceId] = useState('');
  const [crossReason, setCrossReason] = useState('');
  // One key per opening of the dialog: a retry of the same attempt (double click, dropped connection) replays the
  // recorded transfer instead of posting it twice.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const idempotencyKey = useMemo(() => newIdempotencyKey(), [open, advance?.id]);

  useEffect(() => {
    if (!open) return;
    setMode(owes ? 'transfer' : 'write_off');
    setReason(''); setError(null); setDestination('replacement'); setAmount(''); setRoiPercent('20');
    setPartner(null); setToAdvanceId(''); setCrossReason('');
  }, [open, advance?.id, owes]);

  const existingAgentId = destination === 'existing' ? (partner?.id ?? agentId) : undefined;
  const { data: openAdvances = [], isLoading: loadingOpen } = useQuery<OpenAdvance[]>({
    queryKey: ['advance-transfer-destinations', existingAgentId, advance?.id],
    enabled: open && owes && mode === 'transfer' && destination === 'existing' && !!existingAgentId,
    queryFn: async () => {
      const { data, error: e } = await db.from('agent_advances')
        .select('id, principal, outstanding_balance, status, issued_at')
        .eq('agent_id', existingAgentId).in('status', ['active', 'overdue']).neq('id', advance.id)
        .order('issued_at', { ascending: false });
      if (e) throw e;
      return (data ?? []) as OpenAdvance[];
    },
  });

  const { data: writeOff, refetch: refetchWriteOff } = useQuery<WriteOffRequest | null>({
    queryKey: ['advance-write-off-request', advance?.id],
    enabled: open && !!advance?.id && owes,
    queryFn: async () => {
      const { data, error: e } = await db.from('agent_advance_write_off_requests')
        .select('id, status, amount, reason, requested_by, requested_at, decided_at, decision_note')
        .eq('advance_id', advance.id).in('status', ['requested', 'approved'])
        .order('requested_at', { ascending: false }).limit(1);
      if (e) throw e;
      return ((data ?? [])[0] ?? null) as WriteOffRequest | null;
    },
  });

  const amt = amount.trim() ? Number(amount.replace(/[, _]/g, '')) : outstanding;
  const amountError = mode === 'transfer' && owes && (!Number.isFinite(amt) || amt <= 0 || amt > outstanding)
    ? `Enter an amount above 0 and at most ${formatUGX(outstanding)}.` : null;
  const crossAccount = destination === 'partnership' || (destination === 'existing' && !!partner && partner.id !== agentId);
  const roiNum = Number(roiPercent);
  const roiOk = destination === 'roi' ? roiNum > 0 && roiNum <= 100
    : destination === 'partnership' ? roiNum >= 0 && roiNum <= 100 : true;

  const transferReady = mode === 'transfer' && owes && !amountError && reason.trim().length >= MIN_REASON && roiOk
    && (destination !== 'partnership' || (!!partner && partner.id !== agentId))
    && (destination !== 'existing' || !!toAdvanceId)
    && (!crossAccount || crossReason.trim().length >= MIN_REASON);

  const refresh = () => {
    for (const key of ['cfo-advances', 'agent-advances', 'agent-advance-write-off-queue', 'agent-advance-exceptions', 'advance-write-off-request']) {
      queryClient.invalidateQueries({ queryKey: [key], exact: false });
    }
  };
  const fail = (e: any, fallback: string) => {
    const msg = advanceControlMessage(e?.message) || fallback;
    setError(msg);
    toast.error(msg);
  };

  const submitTransfer = async () => {
    if (!advance || !transferReady) return;
    setSubmitting(true); setError(null);
    try {
      const args = transferArgs({
        fromAdvanceId: advance.id, destination, reason, idempotencyKey,
        amount: amount.trim() ? amt : null, toAdvanceId: toAdvanceId || null, partnerAgentId: partner?.id ?? null,
        roiPercent: destination === 'roi' || destination === 'partnership' ? roiNum : null,
        crossAccountReason: crossAccount ? crossReason : null,
      });
      const { data, error: e } = await db.rpc('cfo_transfer_agent_advance', args);
      if (e) throw e;
      const r = (data ?? {}) as { amount?: number; source_closed?: boolean; replayed?: boolean };
      toast.success(r.replayed
        ? 'This transfer was already recorded. Nothing was posted twice.'
        : `${formatUGX(Number(r.amount ?? amt))} transferred. No money was paid out.${r.source_closed ? ' The advance is closed.' : ''}`);
      refresh(); onOpenChange(false); onSuccess?.();
    } catch (e: any) {
      fail(e, 'Transfer failed');
    } finally {
      setSubmitting(false);
    }
  };

  const submitCancel = async (recoup: boolean) => {
    if (!advance) return;
    setSubmitting(true); setError(null);
    try {
      const { error: e } = await supabase.rpc('cancel_agent_advance', { p_advance_id: advance.id, p_recoup: recoup, p_reason: reason.trim() });
      if (e) throw e;
      toast.success(recoup
        ? `Advance cancelled. ${formatUGX(outstanding)} stays owed for recoup via Record Payment.`
        : owes ? `Approved write-off of ${formatUGX(outstanding)} posted and the advance closed.` : 'Advance cancelled.');
      refresh(); onOpenChange(false); onSuccess?.();
    } catch (e: any) {
      fail(e, 'Cancellation failed');
    } finally {
      setSubmitting(false);
    }
  };

  const submitWriteOffRequest = async () => {
    if (!advance) return;
    setSubmitting(true); setError(null);
    try {
      const { error: e } = await db.rpc('request_agent_advance_write_off', { p_advance_id: advance.id, p_reason: reason.trim() });
      if (e) throw e;
      toast.success('Write-off requested. Another CFO or the CEO must approve it before the advance can be closed.');
      setReason('');
      await refetchWriteOff(); refresh();
    } catch (e: any) {
      fail(e, 'Write-off request failed');
    } finally {
      setSubmitting(false);
    }
  };

  // An open request for a different amount (the balance moved since) can only be replaced by a new request.
  const staleWriteOff = !!writeOff && Math.abs(Number(writeOff.amount) - outstanding) >= 1;
  const waitingApproval = owes && mode === 'write_off' && writeOff?.status === 'requested' && !staleWriteOff;
  let action: { label: string; run: () => void; enabled: boolean; destructive?: boolean } | null = null;
  if (!owes) {
    action = { label: 'Cancel advance', run: () => submitCancel(false), enabled: reason.trim().length >= 10, destructive: true };
  } else if (mode === 'transfer') {
    action = { label: 'Transfer balance', run: submitTransfer, enabled: transferReady };
  } else if (mode === 'recoup_from_wallet') {
    action = { label: 'Cancel, keep balance owed', run: () => submitCancel(true), enabled: reason.trim().length >= 10 };
  } else if (writeOff?.status === 'approved' && !staleWriteOff) {
    action = { label: 'Post approved write-off', run: () => submitCancel(false), enabled: reason.trim().length >= 10, destructive: true };
  } else if (!writeOff || staleWriteOff) {
    action = { label: staleWriteOff ? 'Request write-off of current balance' : 'Request write-off', run: submitWriteOffRequest, enabled: reason.trim().length >= MIN_WRITE_OFF_REASON };
  }

  const reasonLabel = owes && mode === 'transfer' ? `Reason for the transfer (min ${MIN_REASON} characters)`
    : owes && mode === 'write_off' && (!writeOff || staleWriteOff) ? `Why it should be written off (min ${MIN_WRITE_OFF_REASON} characters)`
    : 'Reason (min 10 characters)';

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!submitting) onOpenChange(o); }}>
      <DialogContent className="w-[calc(100vw-1.5rem)] max-w-[calc(100vw-1.5rem)] sm:max-w-lg max-h-[90dvh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <AlertTriangle className="h-4 w-4 text-amber-600" />
            Close advance for {agentName}
          </DialogTitle>
          <DialogDescription>
            {owes
              ? <>{formatUGX(outstanding)} is still owed. Move it to another advance, keep it owed for recoup, or write it off with a second approval. It is never simply dropped.</>
              : <>Nothing is owed on this advance. Cancelling stops all daily deductions.</>}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {error && (
            <p role="alert" className="rounded-lg border border-destructive/40 bg-destructive/10 p-2 text-xs text-destructive">{error}</p>
          )}

          {owes && (
            <RadioGroup value={mode} onValueChange={(v) => { setMode(v as Mode); setError(null); }} className="space-y-2">
              <label className="flex items-start gap-3 rounded-lg border border-border p-3 cursor-pointer hover:border-primary/40">
                <RadioGroupItem value="transfer" id="close-transfer" className="mt-1" />
                <div className="flex-1">
                  <Label htmlFor="close-transfer" className="font-semibold cursor-pointer">Transfer the balance</Label>
                  <p className="text-xs text-muted-foreground mt-1">
                    Move it to a replacement, Returns-recovered, partnership or existing advance. Accounting only: no money is paid out.
                  </p>
                </div>
              </label>
              <label className="flex items-start gap-3 rounded-lg border border-border p-3 cursor-pointer hover:border-primary/40">
                <RadioGroupItem value="recoup_from_wallet" id="close-recoup" className="mt-1" />
                <div className="flex-1">
                  <Label htmlFor="close-recoup" className="font-semibold cursor-pointer">Cancel but keep the balance owed</Label>
                  <p className="text-xs text-muted-foreground mt-1">
                    Daily deductions stop. The {formatUGX(outstanding)} stays owed and is recovered through Record Payment.
                  </p>
                </div>
              </label>
              <label className="flex items-start gap-3 rounded-lg border border-border p-3 cursor-pointer hover:border-primary/40">
                <RadioGroupItem value="write_off" id="close-writeoff" className="mt-1" />
                <div className="flex-1">
                  <Label htmlFor="close-writeoff" className="font-semibold cursor-pointer">Write off (needs a second approval)</Label>
                  <p className="text-xs text-muted-foreground mt-1">
                    Recorded as a loss. Another CFO or the CEO must approve the request first.
                  </p>
                </div>
              </label>
            </RadioGroup>
          )}

          {owes && mode === 'transfer' && (
            <div className="space-y-3 rounded-lg border border-primary/30 bg-primary/5 p-3">
              <div className="flex items-center gap-2 text-xs font-semibold"><ArrowRightLeft className="h-3.5 w-3.5" /> Where does the balance go?</div>
              <Select value={destination} onValueChange={(v) => { setDestination(v as TransferDestination); setToAdvanceId(''); setPartner(null); }}>
                <SelectTrigger aria-label="Destination"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="replacement">New replacement advance (same agent)</SelectItem>
                  <SelectItem value="roi">New advance recovered from Returns (same agent)</SelectItem>
                  <SelectItem value="partnership">Partnership / another account</SelectItem>
                  <SelectItem value="existing">An existing open advance</SelectItem>
                </SelectContent>
              </Select>

              {(destination === 'partnership' || destination === 'existing') && (
                <UserSearchPicker
                  label={destination === 'partnership' ? 'Account that takes over the balance' : 'Agent holding the advance (leave empty for this agent)'}
                  placeholder="Search by name or phone..."
                  selectedUser={partner}
                  onSelect={(u) => { setPartner(u); setToAdvanceId(''); }}
                />
              )}
              {destination === 'partnership' && partner?.id === agentId && (
                <p className="text-xs text-destructive">Choose a different account, or use a replacement advance.</p>
              )}

              {destination === 'existing' && (
                <div>
                  <Label className="text-xs">Advance that receives the balance</Label>
                  {loadingOpen ? (
                    <p className="text-xs text-muted-foreground inline-flex items-center gap-1.5 mt-1"><Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading open advances...</p>
                  ) : openAdvances.length === 0 ? (
                    <p className="text-xs text-muted-foreground mt-1">No other open advance for this account.</p>
                  ) : (
                    <Select value={toAdvanceId} onValueChange={setToAdvanceId}>
                      <SelectTrigger aria-label="Destination advance" className="mt-1"><SelectValue placeholder="Choose an advance" /></SelectTrigger>
                      <SelectContent>
                        {openAdvances.map((a) => (
                          <SelectItem key={a.id} value={a.id}>
                            {a.id.slice(0, 8)} · outstanding {formatUGX(Number(a.outstanding_balance))} ({a.status})
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )}
                </div>
              )}

              {(destination === 'roi' || destination === 'partnership') && (
                <div>
                  <Label className="text-xs">{destination === 'roi' ? 'Share of each Returns payout taken (%)' : 'Share of Returns taken (%), 0 for daily wallet recovery'}</Label>
                  <Input type="number" min={0} max={100} value={roiPercent} onChange={(e) => setRoiPercent(e.target.value)} className="mt-1" />
                  {!roiOk && <p className="text-xs text-destructive mt-1">{destination === 'roi' ? 'Enter a share between 1 and 100.' : 'Enter a share between 0 and 100.'}</p>}
                </div>
              )}

              <div>
                <Label className="text-xs">Amount to transfer (UGX). Leave empty for the full {formatUGX(outstanding)}</Label>
                <Input inputMode="numeric" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder={String(outstanding)} className="mt-1" />
                {amountError && <p className="text-xs text-destructive mt-1">{amountError}</p>}
                {!amountError && amount.trim() && amt < outstanding && (
                  <p className="text-xs text-muted-foreground mt-1">{formatUGX(outstanding - amt)} stays on this advance, which remains open.</p>
                )}
              </div>

              {crossAccount && (
                <div>
                  <Label className="text-xs">Why another account takes the balance (min {MIN_REASON} characters)</Label>
                  <Textarea value={crossReason} onChange={(e) => setCrossReason(e.target.value)} className="mt-1 min-h-[56px]"
                    placeholder="e.g. Same person; the partner account holds the portfolio that repays it" />
                </div>
              )}
            </div>
          )}

          {owes && mode === 'write_off' && writeOff && (
            <div className={`rounded-lg border p-3 text-xs ${writeOff.status === 'approved' ? 'border-emerald-500/40 bg-emerald-500/10' : 'border-amber-500/40 bg-amber-500/10'}`}>
              <p className="font-semibold inline-flex items-center gap-1.5">
                {writeOff.status === 'approved' ? <CheckCircle2 className="h-3.5 w-3.5" /> : <Clock className="h-3.5 w-3.5" />}
                Write-off of {formatUGX(Number(writeOff.amount))} {writeOff.status === 'approved' ? 'approved' : 'waiting for approval'}
              </p>
              <p className="mt-1 text-muted-foreground">{writeOff.reason}</p>
              {writeOff.decision_note && <p className="mt-1">Approval note: {writeOff.decision_note}</p>}
              {staleWriteOff && (
                <p className="mt-1 font-medium text-amber-800 dark:text-amber-300">
                  The balance is now {formatUGX(outstanding)}. A write-off can never exceed what was approved, so request a new one for the current balance; it replaces this one.
                </p>
              )}
              {writeOff.status === 'requested' && !staleWriteOff && (
                <p className="mt-1">Another CFO or the CEO approves it under Write-off approvals.</p>
              )}
            </div>
          )}

          {!waitingApproval && (
            <div>
              <Label className="text-xs font-semibold">{reasonLabel}</Label>
              <Textarea value={reason} onChange={(e) => setReason(e.target.value)} className="mt-1 min-h-[70px]"
                placeholder={mode === 'transfer' && owes ? 'e.g. Replacement advance on new terms agreed with the agent' : 'e.g. Agent left; nothing left to recover'} />
            </div>
          )}
        </div>

        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>Keep advance</Button>
          {action && (
            <Button variant={action.destructive ? 'destructive' : 'default'} onClick={action.run} disabled={submitting || !action.enabled}>
              {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : action.label}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
