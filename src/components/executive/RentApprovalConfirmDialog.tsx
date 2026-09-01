import { useEffect, useState } from 'react';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { CheckCircle2, EyeOff, Loader2, Star } from 'lucide-react';

export interface FunderVisibilityDecision {
  funderVisible: boolean;
  reason: string;
}

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  request: any | null;
  approveLabel: string;
  processing?: boolean;
  onConfirm: (decision: FunderVisibilityDecision) => void;
}

const fmt = (n: any) => `UGX ${Number(n || 0).toLocaleString()}`;

/**
 * Tenant Ops approval confirmation.
 *
 * Two jobs: let the officer re-check the request details before it moves on,
 * and capture whether this rent plan may be shown to funders in the Funder
 * dashboard (Self Support). Choosing "No" requires a written reason and makes
 * the request skip Partner Operations — it goes straight to the COO flagged
 * "No proxy attached".
 */
export function RentApprovalConfirmDialog({
  open, onOpenChange, request, approveLabel, processing, onConfirm,
}: Props) {
  const [visible, setVisible] = useState(true);
  const [reason, setReason] = useState('');

  useEffect(() => {
    if (open) {
      setVisible(request?.funder_visible !== false);
      setReason(request?.funder_visibility_reason || '');
    }
  }, [open, request?.id]);

  if (!request) return null;

  const reasonTooShort = !visible && reason.trim().length < 10;

  const rows: [string, string][] = [
    ['Tenant', request.tenant_name || '—'],
    ['Tenant phone', request.tenant_phone || '—'],
    ['Landlord', request.landlord_name || '—'],
    ['Agent', request.agent_name || '—'],
    ['Rent amount', fmt(request.rent_amount)],
    ['Daily repayment', fmt(request.daily_repayment)],
    ['Total repayable', fmt(request.total_repayment)],
    ['Duration', `${request.duration_days || 0} days`],
    ['Location', request.location_display || request.request_city || '—'],
  ];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg max-h-[92vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="text-base">Confirm approval</DialogTitle>
          <DialogDescription className="text-xs">
            Check the details below are correct, then decide whether this rent plan appears in the Funder dashboard.
          </DialogDescription>
        </DialogHeader>

        <div className="rounded-xl border border-border divide-y divide-border text-xs">
          {rows.map(([label, value]) => (
            <div key={label} className="flex items-start justify-between gap-3 px-3 py-2">
              <span className="text-muted-foreground">{label}</span>
              <span className="font-semibold text-right break-words">{value}</span>
            </div>
          ))}
        </div>

        <div className="space-y-2">
          <Label className="text-xs font-semibold">Show this rent plan in the Funder dashboard?</Label>
          <div className="grid grid-cols-2 gap-2">
            <Button
              type="button"
              variant={visible ? 'default' : 'outline'}
              className="h-auto py-2 flex-col gap-1"
              onClick={() => setVisible(true)}
            >
              <span className="flex items-center gap-1 text-xs font-bold">
                <Star className="h-3.5 w-3.5" /> Yes — publish
              </span>
              <span className="text-[10px] font-normal opacity-80">Goes through Partner Ops</span>
            </Button>
            <Button
              type="button"
              variant={!visible ? 'destructive' : 'outline'}
              className="h-auto py-2 flex-col gap-1"
              onClick={() => setVisible(false)}
            >
              <span className="flex items-center gap-1 text-xs font-bold">
                <EyeOff className="h-3.5 w-3.5" /> No — keep internal
              </span>
              <span className="text-[10px] font-normal opacity-80">Skips Partner Ops → COO</span>
            </Button>
          </div>

          {!visible && (
            <div className="space-y-1.5">
              <div className="flex items-center gap-2">
                <Badge variant="destructive" className="text-[10px]">No proxy attached</Badge>
                <span className="text-[10px] text-muted-foreground">Reason is required (min 10 characters)</span>
              </div>
              <Textarea
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="Why should this rent plan not appear in the Funder dashboard?"
                rows={3}
                className="text-xs"
              />
            </div>
          )}
        </div>

        <DialogFooter className="gap-2">
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)} disabled={processing}>
            Cancel
          </Button>
          <Button
            size="sm"
            disabled={!!processing || reasonTooShort}
            onClick={() => onConfirm({ funderVisible: visible, reason: reason.trim() })}
          >
            {processing ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <>
                <CheckCircle2 className="h-4 w-4 mr-1" />
                {approveLabel}
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
