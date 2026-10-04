import { LandlordFloatIdleQueue } from '@/components/shared/LandlordFloatIdleQueue';
import { CFOAllocationReturnApprovals } from '@/components/cfo/CFOAllocationReturnApprovals';

/**
 * Landlord money that has left the CFO but not reached the landlord.
 *
 * Two lists, deliberately on one page, because they are the same problem seen
 * from opposite ends:
 *
 *   * the idle register — float nobody has acted on, which the 24-hour rule
 *     watches, and
 *   * agent return requests — float the agent has already told us they cannot
 *     pay out, waiting on a decision.
 *
 * Both decisions are now open to Landlord Ops, not only the CFO: the return
 * decision used to require membership of `cfo_approval_approvers`, a table with
 * one member, which is why requests sit pending for days.
 */
export default function IdleFloat() {
  return (
    <div className="space-y-6">
      <LandlordFloatIdleQueue />
      <CFOAllocationReturnApprovals />
    </div>
  );
}
