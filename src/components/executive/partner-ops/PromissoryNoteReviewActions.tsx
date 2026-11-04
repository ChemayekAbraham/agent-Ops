import { BadgeCheck, CheckCircle, Trash2, XCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';

/**
 * Review and delete sit apart from Call agent / Call partner.
 * Approve & Pay only opens the existing confirmation. It does not pay by itself.
 */
export function PromissoryNoteReviewActions({
  showApprove,
  approvedAlready,
  onApprove,
  showReject,
  onReject,
  onDelete,
}: {
  showApprove?: boolean;
  approvedAlready?: boolean;
  onApprove?: () => void;
  showReject?: boolean;
  onReject?: () => void;
  onDelete?: () => void;
}) {
  if (!showApprove && !approvedAlready && !showReject && !onDelete) return null;
  return (
    <div className="space-y-3">
      {(showApprove || approvedAlready || showReject) && (
        <div className="space-y-2 rounded-xl border border-border bg-muted/30 p-3">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Review</p>
          {showApprove && (
            <>
              <Button className="w-full bg-emerald-600 text-white hover:bg-emerald-700" onClick={onApprove}>
                <BadgeCheck className="mr-2 h-4 w-4" />
                Approve & Pay UGX 1,500
              </Button>
              <p className="text-[11px] leading-snug text-muted-foreground">
                This credits the agent UGX 1,500. You confirm the reason before any money moves.
              </p>
            </>
          )}
          {approvedAlready && (
            <Button className="w-full" variant="outline" disabled>
              <CheckCircle className="mr-2 h-4 w-4 text-emerald-600" />
              Approved
            </Button>
          )}
          {showReject && (
            <Button
              variant="outline"
              className="w-full border-destructive/40 text-destructive hover:bg-destructive/10"
              onClick={onReject}
            >
              <XCircle className="mr-2 h-4 w-4" />
              Reject & Reverse Bonus
            </Button>
          )}
        </div>
      )}
      {onDelete && (
        <div className="space-y-2 rounded-xl border border-destructive/40 bg-destructive/5 p-3">
          <p className="text-xs font-medium uppercase tracking-wide text-destructive">Danger zone</p>
          <Button variant="destructive" className="w-full" onClick={onDelete}>
            <Trash2 className="mr-2 h-4 w-4" />
            Delete Promissory Note
          </Button>
          <p className="text-[11px] leading-snug text-muted-foreground">
            Deleting asks for a reason and records it before the note is removed.
          </p>
        </div>
      )}
    </div>
  );
}
