import { useEffect, useState } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Loader2, RotateCcw, AlertCircle } from 'lucide-react';
import { useToast } from '@/hooks/use-toast';
import { formatUGX } from '@/lib/rentCalculations';
import { formatDistanceToNowStrict } from 'date-fns';

interface Reversible {
  transaction_group: string;
  amount: number;
  landlord_id: string | null;
  landlord_name: string;
  description: string | null;
  created_at: string;
  requires_cfo_approval: boolean;
  pending_request_id: string | null;
  pending_request_status: string | null;
}

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  rentRequestId: string;
  tenantName: string;
  onReversed?: () => void;
}

/**
 * Lets an agent reverse one of their own recent (≤7 days) tenant float
 * allocations. Money goes back to their landlord float bucket (tagged with the
 * same landlord name), the rent plan's amount_repaid is reduced, and the 10%
 * commission is clawed back. A reason of 10+ characters is required.
 */
export function MarkNotFundedDialog({ open, onOpenChange, rentRequestId, tenantName, onReversed }: Props) {
  const { user } = useAuth();
  const { toast } = useToast();
  const [loading, setLoading] = useState(false);
  const [items, setItems] = useState<Reversible[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!open || !user) return;
    let cancelled = false;
    (async () => {
      setLoading(true);
      setSelected(null);
      setReason('');
      const { data, error } = await supabase.rpc('get_agent_reversible_allocations', {
        p_agent_id: user.id,
        p_rent_request_id: rentRequestId,
      });
      if (cancelled) return;
      if (error) {
        toast({ title: 'Could not load fundings', description: error.message, variant: 'destructive' });
        setItems([]);
      } else {
        const rows = (data || []) as Reversible[];
        setItems(rows);
        if (rows.length === 1) setSelected(rows[0].transaction_group);
      }
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [open, user, rentRequestId, toast]);

  const handleConfirm = async () => {
    if (!user || !selected) return;
    if (reason.trim().length < 10) {
      toast({ title: 'Reason required', description: 'Please give at least 10 characters of context.', variant: 'destructive' });
      return;
    }
    const picked = items.find((i) => i.transaction_group === selected);
    if (!picked) return;
    if (picked.pending_request_status === 'pending') {
      toast({ title: 'Already waiting on CFO', description: 'This funding is already pending CFO approval.' });
      return;
    }
    setSubmitting(true);
    const { data, error } = picked.requires_cfo_approval
      ? await supabase.rpc('request_agent_unallocation', {
          p_agent_id: user.id,
          p_rent_request_id: rentRequestId,
          p_original_transaction_group: selected,
          p_reason: reason.trim(),
        })
      : await supabase.rpc('agent_unallocate_tenant_payment', {
          p_agent_id: user.id,
          p_rent_request_id: rentRequestId,
          p_original_transaction_group: selected,
          p_reason: reason.trim(),
        });
    setSubmitting(false);
    if (error || (data as any)?.success === false) {
      toast({
        title: 'Could not mark as not funded',
        description: error?.message || (data as any)?.error || 'Please try again.',
        variant: 'destructive',
      });
      return;
    }
    const r = data as any;
    if (picked.requires_cfo_approval) {
      toast({
        title: 'Sent to CFO for approval',
        description: `${formatUGX(r.amount)} reversal for ${r.landlord_name} is now waiting on CFO sign-off.`,
      });
    } else {
      toast({
        title: 'Marked as not funded',
        description: `${formatUGX(r.amount_returned)} returned to ${r.landlord_name} float. Commission of ${formatUGX(r.commission_clawback)} was clawed back.`,
      });
    }
    onReversed?.();
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Mark {tenantName} as not funded</DialogTitle>
          <DialogDescription>
            Reverses a funding you previously made. Within 7 days it's instant — older fundings need CFO approval.
            On reversal, the money goes back to your landlord float and your 10% commission is clawed back.
          </DialogDescription>
        </DialogHeader>

        {loading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : items.length === 0 ? (
          <div className="flex items-start gap-2 rounded-lg border border-border bg-muted/40 p-3 text-sm">
            <AlertCircle className="h-4 w-4 text-muted-foreground mt-0.5 shrink-0" />
            <p className="text-muted-foreground">
              No reversible fundings found on this rent plan.
            </p>
          </div>
        ) : (
          <div className="space-y-2 max-h-64 overflow-y-auto">
            {items.map((it) => {
              const isActive = selected === it.transaction_group;
              const pending = it.pending_request_status === 'pending';
              return (
                <button
                  key={it.transaction_group}
                  type="button"
                  onClick={() => !pending && setSelected(it.transaction_group)}
                  disabled={pending}
                  className={`w-full text-left rounded-lg border p-3 transition ${
                    isActive ? 'border-primary bg-primary/5' : 'border-border hover:bg-muted/40'
                  } ${pending ? 'opacity-60 cursor-not-allowed' : ''}`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-sm font-semibold truncate">{it.landlord_name}</span>
                    <span className="text-sm font-mono font-bold">{formatUGX(Number(it.amount))}</span>
                  </div>
                  <div className="flex items-center justify-between gap-2 mt-0.5">
                    <p className="text-[11px] text-muted-foreground">
                      {formatDistanceToNowStrict(new Date(it.created_at), { addSuffix: true })}
                    </p>
                    {pending ? (
                      <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded bg-warning/15 text-warning border border-warning/30">
                        Awaiting CFO
                      </span>
                    ) : it.requires_cfo_approval ? (
                      <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded bg-primary/10 text-primary border border-primary/30">
                        Needs CFO approval
                      </span>
                    ) : (
                      <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded bg-success/10 text-success border border-success/30">
                        Instant
                      </span>
                    )}
                  </div>
                </button>
              );
            })}
          </div>
        )}

        {items.length > 0 && (
          <div className="space-y-2">
            <label className="text-xs font-semibold text-muted-foreground">
              Reason (required, 10+ characters)
            </label>
            <Textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="e.g. Tenant cancelled before move-in, landlord refused payment, wrong tenant…"
              rows={3}
              maxLength={500}
            />
            <p className="text-[10px] text-muted-foreground text-right">{reason.trim().length}/10</p>
          </div>
        )}

        <div className="flex justify-end gap-2 pt-2">
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={submitting}>
            Cancel
          </Button>
          <Button
            onClick={handleConfirm}
            disabled={submitting || !selected || reason.trim().length < 10 || items.length === 0}
            variant="destructive"
            className="gap-2"
          >
            {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <RotateCcw className="h-4 w-4" />}
            {(() => {
              const picked = items.find((i) => i.transaction_group === selected);
              return picked?.requires_cfo_approval ? 'Request CFO approval' : 'Mark not funded';
            })()}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}