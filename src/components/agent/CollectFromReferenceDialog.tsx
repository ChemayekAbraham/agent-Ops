import { useEffect, useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import DepositReferenceMatcher, {
  type MatchResult,
} from '@/components/payments/DepositReferenceMatcher';
import DepositFlow from '@/components/payments/DepositFlow';
import { Receipt } from 'lucide-react';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  agentId: string;
}

/**
 * Dashboard entry for the "Collect from receipt/reference" flow.
 *
 * The agent dropped cash at a merchant code in the field but didn't
 * record the TID at deposit time. They open this dialog, paste the
 * bank reference / receipt number / TID from the SMS, and the matcher
 * resolves it to either:
 *
 *   • a pending Operational Float deposit_request that's still missing
 *     a real TID — we hand off to DepositFlow in EDIT mode against
 *     that row so the agent just confirms and saves, or
 *
 *   • one or more recent un-deposited agent_collections — we hand off
 *     to DepositFlow with the Operational Float purpose pre-locked,
 *     amount + per-tenant allocations + reference all pre-filled.
 *
 * This dialog owns the lookup; DepositFlow owns the actual submission.
 */
export function CollectFromReferenceDialog({ open, onOpenChange, agentId }: Props) {
  const [editId, setEditId] = useState<string | null>(null);
  const [prefill, setPrefill] = useState<MatchResult | null>(null);
  const [depositOpen, setDepositOpen] = useState(false);

  // Reset internal state every time the dialog re-opens so a fresh
  // paste session never inherits stale match data from the last attempt.
  useEffect(() => {
    if (open) {
      setEditId(null);
      setPrefill(null);
      setDepositOpen(false);
    }
  }, [open]);

  const handleApplyMatch = (m: MatchResult) => {
    if (m.editDepositId) {
      setEditId(m.editDepositId);
      setPrefill(null);
    } else {
      setEditId(null);
      setPrefill(m);
    }
    onOpenChange(false);
    // Defer opening DepositFlow so the close animation of this dialog
    // doesn't fight the open animation of the next one.
    setTimeout(() => setDepositOpen(true), 80);
  };

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-base">
              <Receipt className="h-4 w-4 text-primary" />
              Collect from receipt / reference
            </DialogTitle>
            <DialogDescription className="text-xs">
              Paste the bank reference, MoMo TID, or merchant receipt number
              from your SMS. We'll find the matching field collections or
              your in-flight Operational Float deposit and pre-fill the
              breakdown for you.
            </DialogDescription>
          </DialogHeader>
          <DepositReferenceMatcher
            agentId={agentId}
            currentAmount={0}
            highlight
            onApplyMatch={handleApplyMatch}
          />
        </DialogContent>
      </Dialog>

      <DepositFlow
        open={depositOpen}
        onOpenChange={(o) => {
          setDepositOpen(o);
          if (!o) {
            setEditId(null);
            setPrefill(null);
          }
        }}
        defaultPurpose="operational_float"
        allowedPurposes={['operational_float']}
        lockPurpose
        editRequestId={editId}
        prefillFromMatch={prefill}
      />
    </>
  );
}

export default CollectFromReferenceDialog;