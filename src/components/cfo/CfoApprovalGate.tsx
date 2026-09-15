import type { ReactNode } from 'react';

/**
 * CFO Dashboard approval controls are visible to everyone who can access the
 * dashboard. The restriction is enforced strictly server-side: every CFO
 * decision RPC checks `public.is_cfo_approver` and the shared edge-function
 * gate rejects non-approvers with a generic failure. This component is kept as
 * a pass-through so the markup structure stays stable; it must never hide,
 * disable, or label its children.
 */
export function CfoApprovalGate({ children }: { children: ReactNode }) {
  return <>{children}</>;
}

export default CfoApprovalGate;
