import { useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { supabase } from '@/integrations/supabase/client';
import { useToast } from '@/hooks/use-toast';
import { invokeEdgeFunction } from '@/lib/invokeEdgeFunction';
import { Trash2, XCircle, AlertCircle } from 'lucide-react';

interface EmptyHouseActionDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  listingId: string;
  listingTitle: string;
  actionType: 'delete' | 'delist' | 'reject';
  userId: string;
  onComplete: () => void;
}

export function EmptyHouseActionDialog({
  open,
  onOpenChange,
  listingId,
  listingTitle,
  actionType,
  userId,
  onComplete,
}: EmptyHouseActionDialogProps) {
  const { toast } = useToast();
  const [reason, setReason] = useState('');
  const [loading, setLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const isDelete = actionType === 'delete';
  const isReject = actionType === 'reject';
  const label = isDelete ? 'Delete' : isReject ? 'Reject' : 'Delist';
  const minChars = 10;
  const valid = reason.trim().length >= minChars;

  const handleSubmit = async () => {
    if (!valid) return;
    setLoading(true);
    setErrorMessage(null);
    try {
      if (isDelete) {
        const { error } = await supabase.from('house_listings').delete().eq('id', listingId);
        if (error) throw error;
      } else if (isReject) {
        // Atomic reject + audit + agent notification via SECURITY DEFINER RPC.
        const { data, error } = await supabase.rpc('reject_house_listing', {
          p_listing_id: listingId,
          p_reason: reason.trim(),
        });
        if (error) throw error;
        if (data && typeof data === 'object' && 'error' in (data as any)) {
          throw new Error((data as any).error);
        }

        // Best-effort WEB PUSH (no SMS) so the listing agent learns of the
        // rejection + reason. The RPC already wrote the in-app notification;
        // never block the flow on the push send.
        await invokeEdgeFunction('notify-listing-rejected', {
          body: { listing_id: listingId, reason: reason.trim() },
          silent: true,
        });
      } else {
        const { error } = await supabase.from('house_listings').update({ status: 'delisted' }).eq('id', listingId);
        if (error) throw error;
      }

      // Audit log for delete/delist (reject is logged inside the RPC for attribution).
      if (!isReject) {
        await supabase.from('audit_logs').insert({
          user_id: userId,
          action_type: isDelete ? 'listing_deleted' : 'listing_delisted',
          table_name: 'house_listings',
          record_id: listingId,
          metadata: { reason: reason.trim(), listing_title: listingTitle },
        });
      }

      toast({ title: `${label}ed`, description: `${listingTitle} has been ${label.toLowerCase()}ed.` });
      setReason('');
      setErrorMessage(null);
      onOpenChange(false);
      onComplete();
    } catch (err: any) {
      // Keep the dialog open and surface the error inline so mobile
      // operators don't miss a transient toast. Also log the full error
      // object so support can diagnose RLS / permission / RPC issues.
      const msg = err?.message || `Failed to ${label.toLowerCase()} listing`;
      setErrorMessage(msg);
      toast({ title: `${label} Failed`, description: msg, variant: 'destructive' });
      console.error(`[EmptyHouseActionDialog] ${label} failed for listing ${listingId}:`, err);
    } finally {
      setLoading(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) setErrorMessage(null); onOpenChange(o); }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {isDelete ? <Trash2 className="h-4 w-4 text-destructive" /> : isReject ? <XCircle className="h-4 w-4 text-orange-600" /> : <XCircle className="h-4 w-4 text-warning" />}
            {label} Listing
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <p className="text-sm text-muted-foreground">
            You are about to <strong>{label.toLowerCase()}</strong> <strong>{listingTitle}</strong>. This action will be logged.
          </p>
          <div>
            <label className="text-xs font-medium text-muted-foreground mb-1 block">
              Reason (min {minChars} characters) *
            </label>
            <Textarea
              value={reason}
              onChange={(e) => { setReason(e.target.value); if (errorMessage) setErrorMessage(null); }}
              placeholder={`Why is this listing being ${label.toLowerCase()}ed?`}
              className="min-h-[80px]"
            />
            {reason.length > 0 && reason.trim().length < minChars && (
              <p className="text-[10px] text-destructive mt-1">{minChars - reason.trim().length} more characters needed</p>
            )}
          </div>
          {errorMessage && (
            <div className="flex gap-2 rounded-md border border-destructive/40 bg-destructive/10 p-2.5 text-xs text-destructive">
              <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
              <div className="space-y-0.5">
                <p className="font-semibold">{label} failed</p>
                <p className="text-destructive/90">{errorMessage}</p>
              </div>
            </div>
          )}
          <div className="flex gap-2 justify-end">
            <Button variant="outline" size="sm" onClick={() => onOpenChange(false)} disabled={loading}>
              Cancel
            </Button>
            <Button
              variant={isDelete ? 'destructive' : 'warning'}
              size="sm"
              onClick={handleSubmit}
              disabled={!valid || loading}
            >
              {loading ? 'Processing...' : errorMessage ? `Retry ${label}` : `${label} Listing`}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
