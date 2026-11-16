/**
 * The agent's view of where a rent request is, in the current pipeline:
 * Service Centre → Agent Ops → Tenant Ops → COO → funders' board → funded → live.
 * One place for every agent-facing status label and "Next" line, so the screens agree.
 * There is no CFO funding step any more: after the COO a request goes on the funders'
 * board, a funder selects it, and the money comes to the agent's landlord float.
 */
import { COLLECTION_RULE_PCT, formatPct, parseCollectionPct } from '@/lib/collectionPct';

export type AgentStatusTone = 'review' | 'coo' | 'waiting' | 'board' | 'funded' | 'live' | 'done' | 'returned' | 'rejected' | 'other';

export type AgentRequestStatusView = {
  label: string;
  /** "Next: …", or null when nothing comes next. */
  next: string | null;
  /** The desk's note, the rejection reason, or why the request waits at the COO. */
  note: string | null;
  tone: AgentStatusTone;
};

export type AgentRequestStatusInput = {
  status: string | null | undefined;
  returned_at?: string | null;
  rejected_reason?: string | null;
  amount_repaid?: number | string | null;
  total_repayment?: number | string | null;
};

/**
 * Whether the agent's requests can leave the COO for the funders' board
 * (`_agent_eligibility(agent).eligible`). null when it can't be read: then the
 * plain "At the COO" label shows.
 */
export type AgentEligibility = { eligible: boolean; reason: string | null } | null;

/** The three statuses that sit at the COO (the last desk before the funders' board). */
export const AT_COO_STATUSES = ['tenant_ops_approved', 'landlord_ops_approved', 'partner_ops_approved'] as const;

const clean = (s: string | null | undefined): string | null => (typeof s === 'string' && s.trim() ? s.trim() : null);

const view = (label: string, next: string | null, tone: AgentStatusTone, note: string | null = null): AgentRequestStatusView =>
  ({ label, next: next ? `Next: ${next}` : null, note, tone });

export function agentRequestStatus(req: AgentRequestStatusInput, eligibility: AgentEligibility = null): AgentRequestStatusView {
  const status = req.status ?? '';
  switch (status) {
    case 'service_center_review':
      return view('At the Service Centre', 'Agent Ops', 'review');
    case 'pending':
      return view('At Agent Ops', 'Tenant Ops', 'review');
    case 'agent_ops_approved':
    case 'agent_verified': // legacy name for the same step
      return view('At Tenant Ops', 'Landlord Ops', 'review');
    case 'tenant_ops_approved':
    case 'landlord_ops_approved':
    case 'partner_ops_approved':
      if (eligibility && eligibility.eligible === false) {
        return view('Waiting at the COO', "funders' board", 'waiting', eligibility.reason ?? null);
      }
      return view('At the COO', "funders' board", 'coo');
    case 'coo_approved':
      return view("On the funders' board — waiting for a funder", 'a funder selects, then the money comes to your landlord float', 'board');
    case 'funded':
      return view('Funded — pay the landlord now', 'landlord confirms with the OTP', 'funded');
    case 'repaying':
    case 'disbursed': // the landlord is paid; the tenant pays daily
      return view('Live — collect daily', null, 'live');
    case 'completed':
    case 'fully_repaid': {
      // Defensive: only call it completed once the plan is actually repaid.
      const repaid = Number(req.amount_repaid ?? 0);
      const total = Number(req.total_repayment ?? 0);
      if (total > 0 && repaid < total) return view('Live — collect daily', null, 'live');
      return view('Completed', null, 'done');
    }
    case 'rejected':
      if (clean(req.returned_at)) {
        return view('Sent back to you — fix and resubmit', null, 'returned', clean(req.rejected_reason));
      }
      return view('Rejected', null, 'rejected', clean(req.rejected_reason));
    case 'cancelled':
      return view('Cancelled', null, 'rejected', clean(req.rejected_reason));
    default:
      return view(status ? status.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase()) : 'In review', null, 'other');
  }
}

/** The label alone, for filters, exports and badges that have no room for the rest. */
export const agentRequestStatusLabel = (status: string | null | undefined): string => agentRequestStatus({ status }).label;

/**
 * Why the agent's requests wait at the COO, from the two things the agent app can read:
 * the vetting gate (`agent_vetting_gate_status`: verified or not) and the agent's own
 * `agent_eligibility_of` (the 50% collection rule). null when neither said anything.
 */
export function agentEligibilityFrom(
  gate: { vetted: boolean | null; funding_frozen?: boolean } | null | undefined,
  eligibilityRaw: unknown,
): AgentEligibility {
  let raw: unknown = eligibilityRaw;
  if (typeof raw === 'string') { try { raw = JSON.parse(raw); } catch { raw = null; } }
  if (Array.isArray(raw)) raw = raw[0];
  const o = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : null;
  const pct = o ? parseCollectionPct(o) : null;
  const serverEligible = typeof o?.eligible === 'boolean' ? (o.eligible as boolean) : null;
  const notVerified = gate?.vetted === false || gate?.funding_frozen === true;

  const reasons: string[] = [];
  if (pct !== null && pct < COLLECTION_RULE_PCT) {
    reasons.push(`your collection is ${formatPct(pct)}%, below ${COLLECTION_RULE_PCT}%`);
  } else if (serverEligible === false) {
    reasons.push(clean(o?.reason as string) ?? `your collection is below ${COLLECTION_RULE_PCT}%`);
  }
  if (notVerified) reasons.push('you are not verified yet');

  if (reasons.length > 0) {
    const text = reasons.join(' and ');
    return { eligible: false, reason: text.charAt(0).toUpperCase() + text.slice(1) };
  }
  if (!gate && serverEligible === null && pct === null) return null;
  return { eligible: true, reason: null };
}
