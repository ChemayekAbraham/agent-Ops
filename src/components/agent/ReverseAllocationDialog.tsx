import { useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Loader2, Undo2, AlertTriangle } from 'lucide-react';
import { toast } from 'sonner';
import { supabase } from '@/integrations/supabase/client';
import { formatUGX } from '@/lib/rentCalculations';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  collectionId: string | null;
  amount: number;
  tenantName?: string;
  onReversed?: () => void;
}

export function ReverseAllocationDialog({
  open, onOpenChange, collectionId, amount, tenantName, onReversed,
}: Props) {
  const [reason, setReason] = useState('');
  const [loading, setLoading] = useState(false);

  const commission = Math.round(amount * 0.10);
  const isValid = reason.trim().length >= 5;

  const handleReverse = async () => {
    if (!collectionId || !isValid) return;
    setLoading(true);
    try {
      const { data, error } = await supabase.rpc('agent_reverse_tenant_allocation', {
        p_collection_id: collectionId,
        p_reason: reason.trim(),
      });
      if (error) throw error;
      const res = data as any;
      if (!res?.success) {
        toast.error('Reversal failed', { description: res?.error });
        return;
      }
      toast.success('Allocation reversed', {
        description: `${formatUGX(res.amount_returned)} returned to your float.`,
      });
      setReason('');
      onReversed?.();
      onOpenChange(false);
    } catch (err: any) {
      toast.error('Reversal failed', { description: err.message });
    } finally {
      setLoading(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!loading) onOpenChange(o); }}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-base">
            <Undo2 className="h-5 w-5 text-warning" />
            Reverse Allocation
          </DialogTitle>
          <DialogDescription className="text-xs">
            This returns the money to your float, claws back the commission, and restores tenant debt.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="rounded-xl bg-muted/40 border p-3 text-sm space-y-1.5">
            {tenantName && (
              <div className="flex justify-between"><span className="text-muted-foreground">Tenant</span><span className="font-semibold">{tenantName}</span></div>
            )}
            <div className="flex justify-between"><span className="text-muted-foreground">Amount returned</span><span className="font-mono font-bold text-success">+{formatUGX(amount)}</span></div>
            <div className="flex justify-between"><span className="text-muted-foreground">Commission clawback</span><span className="font-mono text-destructive">-{formatUGX(commission)}</span></div>
            <div className="flex justify-between border-t pt-1.5"><span className="text-muted-foreground">Tenant debt restored</span><span className="font-mono">+{formatUGX(amount)}</span></div>
          </div>

          <div className="flex items-start gap-2 rounded-xl bg-warning/10 border border-warning/20 p-2.5">
            <AlertTriangle className="h-4 w-4 text-warning shrink-0 mt-0.5" />
            <p className="text-[11px] text-warning-foreground">
              Reversals are logged for audit. Each allocation can only be reversed once.
            </p>
          </div>

          <div>
            <Label className="text-xs">Reason for reversal *</Label>
            <Textarea
              placeholder="e.g. Wrong tenant selected"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              maxLength={300}
              rows={3}
              disabled={loading}
            />
            <p className="text-[10px] text-muted-foreground mt-1">{reason.length}/300 — minimum 5 characters</p>
          </div>

          <div className="flex gap-2">
            <Button variant="outline" className="flex-1" onClick={() => onOpenChange(false)} disabled={loading}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              className="flex-1"
              onClick={handleReverse}
              disabled={!isValid || loading}
            >
              {loading ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <Undo2 className="h-4 w-4 mr-2" />}
              Reverse
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
