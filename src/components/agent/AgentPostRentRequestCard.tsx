import { ArrowRight, FileText } from 'lucide-react';
import { LANDLORD_PAYOUT_COMMISSION_RATE } from '@/lib/rentCalculations';
import { hapticTap } from '@/lib/haptics';

/**
 * The agent dashboard's major action: post a rent request for a tenant.
 *
 * Rendered directly above the Service Center button, so it is the first action
 * an agent meets. It opens the same rent request screen the old "Add Tenant"
 * tile opened.
 */
export function AgentPostRentRequestCard({
  onOpen,
  restricted = false,
}: {
  onOpen: () => void;
  /** Merchant Agents are payout-only: hide the action. */
  restricted?: boolean;
}) {
  if (restricted) return null;

  return (
    <button
      onClick={() => { hapticTap(); onOpen(); }}
      aria-label={`Post rent request here — earn ${Math.round(LANDLORD_PAYOUT_COMMISSION_RATE * 100)}% of the landlord payout when the money reaches the landlord`}
      title="Post a rent request for your tenant"
      className="flex w-full flex-col items-start gap-2 rounded-2xl border border-primary/40 bg-primary p-4 text-left text-primary-foreground shadow-sm transition-all min-h-[132px] active:scale-[0.97] touch-manipulation focus:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background"
      style={{ WebkitTapHighlightColor: 'transparent' }}
    >
      <div className="flex w-full items-center justify-between">
        <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-primary-foreground/15 shadow-sm">
          <FileText className="h-7 w-7" strokeWidth={2.2} />
        </div>
        <ArrowRight className="h-4 w-4 opacity-80" />
      </div>
      <div className="w-full min-w-0">
        <p className="text-[15px] font-bold uppercase leading-tight tracking-wide">
          Post rent request here
        </p>
        <p className="mt-1 truncate text-sm font-semibold leading-tight opacity-95">
          {Math.round(LANDLORD_PAYOUT_COMMISSION_RATE * 100)}% of the landlord payout
        </p>
        <p className="mt-0.5 truncate text-[11px] opacity-85">
          When the money reaches the landlord
        </p>
      </div>
    </button>
  );
}

export default AgentPostRentRequestCard;
