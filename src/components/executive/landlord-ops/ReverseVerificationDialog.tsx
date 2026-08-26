import { useCallback, useEffect, useState } from 'react';
import { supabase } from '@/integrations/supabase/client';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { useToast } from '@/hooks/use-toast';
import { AlertTriangle, Loader2, RotateCcw, ShieldOff } from 'lucide-react';
import { MIN_VERIFICATION_REASON_LENGTH } from '@/lib/landlord-ops/verification';

/**
 * Ops-only "Reverse Verification" dialog for a VERIFIED landlord or LC1
 * chairperson that was verified / paid by mistake.
 *
 * It changes nothing on its own: it reads `get_verification_reversal_preview`
 * so Ops can see exactly which verification bonuses were paid and how much is
 * still recoverable, then calls `reverse_verification`, which claws the bonuses
 * back through the ledger and hands the status change to the existing
 * `set_landlord_verification` / `set_lc1_verification` rejection path.
 */

export type ReverseEntityType = 'landlord' | 'lc1';

interface PreviewLeg {
  ledger_id: string;
  amount: number;
  category: string;
  description: string | null;
  paid_at: string | null;
  user_id: string | null;
}

interface Preview {
  entity_name: string | null;
  status: string | null;
  verified_at: string | null;
  agent_id: string | null;
  agent_name: string | null;
  agent_available_balance: number;
  reversible_legs: PreviewLeg[];
  reversible_amount: number;
  recoverable_now: number;
  can_reverse: boolean;
  already_reversed_for_this_episode: boolean;
  rejection_charge_on_reject: number;
}

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  entityType: ReverseEntityType;
  entityId: string;
  entityName?: string | null;
  /** Called after a successful reversal so the caller can refetch its list. */
  onReversed?: () => void;
}

const ugx = (n: number) => `UGX ${Math.round(n || 0).toLocaleString()}`;

export function ReverseVerificationDialog({
  open, onOpenChange, entityType, entityId, entityName, onReversed,
}: Props) {
  const { toast } = useToast();
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reason, setReason] = useState('');

  const label = entityType === 'landlord' ? 'landlord' : 'LC1 chairperson';

  const loadPreview = useCallback(async () => {
    setLoading(true);
    setError(null);
    const { data, error: err } = await (supabase.rpc as any)('get_verification_reversal_preview', {
      p_entity_type: entityType,
      p_entity_id: entityId,
    });
    setLoading(false);
    if (err) {
      setPreview(null);
      setError(err.message || 'Could not load the reversal details');
      return;
    }
    setPreview(data as Preview);
  }, [entityType, entityId]);

  useEffect(() => {
    if (!open) return;
    setReason('');
    loadPreview();
  }, [open, loadPreview]);

  const submit = async () => {
    const note = reason.trim();
    if (note.length < MIN_VERIFICATION_REASON_LENGTH) {
      toast({
        title: 'Reason required',
        description: `Give at least ${MIN_VERIFICATION_REASON_LENGTH} characters explaining why this verification is being reversed.`,
        variant: 'destructive',
      });
      return;
    }
    setBusy(true);
    const { data, error: err } = await (supabase.rpc as any)('reverse_verification', {
      p_entity_type: entityType,
      p_entity_id: entityId,
      p_reason: note,
    });
    setBusy(false);
    if (err) {
      toast({ title: 'Reversal failed', description: err.message || 'Could not reverse this verification', variant: 'destructive' });
      return;
    }
    const res = (data ?? {}) as {
      reversed_amount?: number; unrecovered_amount?: number; recovery_status?: string; rejection_charge_amount?: number;
    };
    const parts: string[] = [];
    if ((res.reversed_amount ?? 0) > 0) parts.push(`${ugx(res.reversed_amount!)} recovered from the agent`);
    if ((res.unrecovered_amount ?? 0) > 0) parts.push(`${ugx(res.unrecovered_amount!)} could not be recovered (money already used) — logged for CFO follow-up`);
    if ((res.rejection_charge_amount ?? 0) > 0) parts.push(`standard ${ugx(res.rejection_charge_amount!)} rejection charge applied`);
    toast({
      title: `Verification reversed — ${label} moved to Rejected`,
      description: parts.length ? parts.join('. ') + '.' : 'No bonus payment was found on this record.',
    });
    onOpenChange(false);
    onReversed?.();
  };

  const name = preview?.entity_name || entityName || label;
  const blocked = !!preview && (!preview.can_reverse || preview.already_reversed_for_this_episode);

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!busy) onOpenChange(v); }}>
      <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-base">
            <ShieldOff className="h-4 w-4 text-destructive shrink-0" />
            Reverse verification — {name}
          </DialogTitle>
          <DialogDescription className="text-xs">
            Use this only when the verification or its payment happened by mistake. The {label} moves from
            Verified back to Rejected, the agent is notified and can correct and resubmit it exactly as with
            any other rejection.
          </DialogDescription>
        </DialogHeader>

        {loading ? (
          <div className="flex justify-center py-8"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
        ) : error ? (
          <p className="text-sm text-destructive">{error}</p>
        ) : preview ? (
          <div className="space-y-3">
            <div className="rounded-xl border border-border bg-muted/30 p-3 space-y-1.5">
              <div className="flex items-center justify-between gap-2">
                <span className="text-[11px] text-muted-foreground uppercase tracking-wider font-semibold">Current status</span>
                <Badge variant="outline" className="text-[10px] border-0 bg-emerald-100 text-emerald-700 font-semibold">
                  {preview.status || 'unknown'}
                </Badge>
              </div>
              {preview.verified_at && (
                <p className="text-[11px] text-muted-foreground">
                  Verified {new Date(preview.verified_at).toLocaleString()}
                </p>
              )}
              <p className="text-[11px] text-muted-foreground">
                Registering agent: <span className="font-medium text-foreground">{preview.agent_name || 'Unknown agent'}</span>
              </p>
              {preview.agent_id && (
                <p className="text-[11px] text-muted-foreground">
                  Agent withdrawable balance now: <span className="font-semibold text-foreground">{ugx(preview.agent_available_balance)}</span>
                </p>
              )}
            </div>

            <div className="rounded-xl border border-border p-3 space-y-2">
              <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                Money paid on this verification
              </p>
              {(preview.reversible_legs || []).length === 0 ? (
                <p className="text-xs text-muted-foreground">
                  No outstanding verification bonus found on this record — only the status will change.
                </p>
              ) : (
                <ul className="space-y-1.5">
                  {preview.reversible_legs.map((leg) => (
                    <li key={leg.ledger_id} className="flex items-start justify-between gap-2 text-xs">
                      <span className="min-w-0 flex-1 text-muted-foreground break-words">
                        {leg.description || leg.category}
                        {leg.paid_at ? ` · ${new Date(leg.paid_at).toLocaleDateString()}` : ''}
                      </span>
                      <span className="font-semibold shrink-0">{ugx(leg.amount)}</span>
                    </li>
                  ))}
                </ul>
              )}
              {preview.reversible_amount > 0 && (
                <div className="flex items-center justify-between border-t border-border pt-1.5 text-xs">
                  <span className="font-semibold">To recover</span>
                  <span className="font-bold">{ugx(preview.reversible_amount)}</span>
                </div>
              )}
              {preview.reversible_amount > preview.recoverable_now && (
                <p className="text-[11px] text-amber-700 flex items-start gap-1">
                  <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-[1px]" />
                  Only about {ugx(preview.recoverable_now)} is still in the agent's wallet. The rest has already
                  been used or withdrawn — it will be recorded as unrecovered for CFO follow-up instead of being forced.
                </p>
              )}
            </div>

            <p className="text-[11px] text-amber-700">
              Rejecting also applies the standard {ugx(preview.rejection_charge_on_reject)} rejection charge to the
              registering agent, exactly as a normal rejection does.
            </p>

            {preview.already_reversed_for_this_episode && (
              <p className="text-xs text-destructive font-medium">
                This verification has already been reversed. Nothing further will be charged or changed.
              </p>
            )}
            {!preview.can_reverse && !preview.already_reversed_for_this_episode && (
              <p className="text-xs text-destructive font-medium">
                Only a verified {label} can be reversed (current status: {preview.status || 'unknown'}).
              </p>
            )}

            <div className="space-y-1">
              <Textarea
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder={`Why is this ${label} verification being reversed? (shown to the agent, min ${MIN_VERIFICATION_REASON_LENGTH} characters)`}
                className="min-h-[72px] text-sm"
                disabled={blocked || busy}
              />
              <p className="text-[10px] text-muted-foreground">
                {reason.trim().length}/{MIN_VERIFICATION_REASON_LENGTH} characters minimum · recorded against your name and the time of the reversal
              </p>
            </div>
          </div>
        ) : null}

        <DialogFooter className="gap-2 sm:gap-2">
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={busy} className="min-h-[44px]">
            Cancel
          </Button>
          <Button
            variant="destructive"
            onClick={submit}
            disabled={busy || loading || blocked || reason.trim().length < MIN_VERIFICATION_REASON_LENGTH}
            className="min-h-[44px]"
          >
            {busy ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <RotateCcw className="h-4 w-4 mr-1" />}
            Reverse &amp; reject
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
