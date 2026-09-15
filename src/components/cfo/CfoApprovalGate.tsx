import type { ReactNode } from 'react';
import { useCfoApprovalAuthority } from '@/hooks/useCfoApprovalAuthority';

/**
 * Renders CFO Dashboard approval controls only for the designated CFO approver.
 *
 * Presentation only, and deliberately silent: everyone else simply does not see
 * the control — no labels, messages, disabled buttons or tooltips, and nothing
 * that identifies who the approver is. The real restriction lives in the
 * database (`public.is_cfo_approver`, enforced inside every CFO decision RPC)
 * and in the shared edge-function gate, so a re-enabled button changes nothing.
 */
export function CfoApprovalGate({ children }: { children: ReactNode }) {
  const { canApprove } = useCfoApprovalAuthority();
  if (!canApprove) return null;
  return <>{children}</>;
}

export default CfoApprovalGate;
