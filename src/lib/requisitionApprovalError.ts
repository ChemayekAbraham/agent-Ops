const AUTHORITY_PATTERN = /\b(cfo|ceo|coo|supervisor|department head|director)\b/i;
const DENIAL_PATTERN = /not authori[sz]ed|unauthori[sz]ed|permission denied|not permitted|forbidden|insufficient privilege|requires? .*approver|cannot approve/i;

export function requisitionApprovalError(message: string, requiredAuthority?: string | null) {
  if (!DENIAL_PATTERN.test(message)) return message;

  const authority = requiredAuthority?.trim() || message.match(AUTHORITY_PATTERN)?.[1];
  if (authority) {
    return `Approval not permitted. This requisition requires an authorized ${authority.toUpperCase()} approver.`;
  }

  return 'Approval not permitted. You are not authorized to approve this requisition.';
}