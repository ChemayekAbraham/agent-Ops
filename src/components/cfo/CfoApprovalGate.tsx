import type { ReactNode } from 'react';

/**
 * CFO Dashboard approval controls are visible to everyone who can access the
 * dashboard. The restriction is enforced strictly server-side: CFO decision
 * RPCs check `public.is_cfo_approver` and the shared edge-function gate rejects
 * non-approvers with a generic failure. This component is kept as a
 * pass-through so the markup structure stays stable; it must never hide,
 * disable, or label its children.
 *
 * One deliberate exception: `cfo_decide_allocation_return` moved to
 * `public.can_reverse_landlord_float` (CFO, Landlord Ops, CTO, Super Admin).
 * `cfo_approval_approvers` has a single member, and returning landlord float is
 * time-critical — requests were sitting pending behind one person.
 */
export function CfoApprovalGate({ children }: { children: ReactNode }) {
  return <>{children}</>;
}

export default CfoApprovalGate;
