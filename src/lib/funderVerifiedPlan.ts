import { supabase } from '@/integrations/supabase/client';
import { TENANT_AGREEMENT_TEXT, TENANT_AGREEMENT_VERSION } from '@/components/tenant/agreement/TenantAgreementContent';

/** What `funder_verified_rent_plan_dossier` returns when the caller may see it. */
export interface FunderFundingStep {
  key: string;
  state: 'done' | 'current' | 'waiting';
  title: string;
  detail: string;
}

/** Server-decided funding timeline. The screen prints these sentences as they arrive. */
export interface FunderFundingStatus {
  recordedAt: string | null;
  amount: number;
  receiptNumber: string;
  reference: string | null;
  tid: string | null;
  funderName: string;
  agentName: string | null;
  landlordHasDashboard: boolean;
  rentPaid: boolean;
  route: string;
  routeDetail: string;
  steps: FunderFundingStep[];
}

export interface FunderVerifiedPlan {
  rentRequestId: string;
  verified: boolean;
  verificationLabel: string | null;
  status: string | null;
  tenantName: string;
  tenantPhone: string | null;
  landlordName: string;
  landlordPhone: string | null;
  payoutMomoNumber: string | null;
  payoutMomoName: string | null;
  /** `approved` is the payout number Landlord Ops confirmed. `on_file` is the number on the landlord record. */
  payoutMomoSource: 'approved' | 'on_file' | null;
  houseCategory: string | null;
  location: string | null;
  rentAmount: number;
  dailyRepayment: number;
  totalRepayment: number;
  amountRepaid: number;
  durationDays: number | null;
  repaymentFrequency: string | null;
  repaymentStartsOn: string | null;
  fundedAt: string | null;
  houseTitle: string | null;
  funding: FunderFundingStatus | null;
  agreement: {
    version: string | null;
    status: 'accepted' | 'not_accepted';
    acceptedAt: string | null;
  };
}

export type FunderVerifiedPlanResult =
  | { state: 'ready'; plan: FunderVerifiedPlan }
  | { state: 'hidden'; code: 'not_verified' | 'not_available' }
  | { state: 'unavailable' }
  | { state: 'error'; message: string };

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);
const num = (v: unknown): number => {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
  return Number.isFinite(n) ? n : 0;
};

/** True when the dossier RPC is not on the database yet. The screen then stays quiet. */
export function isMissingDossierError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const e = error as { code?: string; message?: string; details?: string };
  const blob = `${e.code ?? ''} ${e.message ?? ''} ${e.details ?? ''}`.toLowerCase();
  return (
    blob.includes('pgrst202')
    || blob.includes('42883')
    || blob.includes('could not find the function')
    || blob.includes('schema cache')
    || blob.includes('does not exist')
  );
}

export function parseFunderVerifiedPlanPayload(data: unknown): FunderVerifiedPlanResult {
  if (!data || typeof data !== 'object') return { state: 'error', message: 'Empty reply' };
  const row = data as Record<string, unknown>;
  if (row.ok !== true) {
    const code = row.code === 'not_verified' ? 'not_verified' : 'not_available';
    return { state: 'hidden', code };
  }
  const id = str(row.rent_request_id);
  if (!id) return { state: 'error', message: 'Missing plan' };
  const verified = row.verified === true;
  const agreement = (row.agreement && typeof row.agreement === 'object')
    ? row.agreement as Record<string, unknown>
    : {};
  const source = row.payout_momo_source === 'approved' || row.payout_momo_source === 'on_file'
    ? row.payout_momo_source
    : null;
  const fundingRaw = row.funding && typeof row.funding === 'object'
    ? row.funding as Record<string, unknown>
    : null;
  const steps = Array.isArray(fundingRaw?.steps)
    ? fundingRaw.steps.flatMap((step): FunderFundingStep[] => {
        if (!step || typeof step !== 'object') return [];
        const s = step as Record<string, unknown>;
        const state = s.state === 'done' || s.state === 'current' || s.state === 'waiting' ? s.state : 'waiting';
        const title = str(s.title);
        const detail = str(s.detail);
        if (!title || !detail) return [];
        return [{ key: str(s.key) || title, state, title, detail }];
      })
    : [];
  return {
    state: 'ready',
    plan: {
      rentRequestId: id,
      verified,
      verificationLabel: verified ? str(row.verification_label) : null,
      status: str(row.status),
      tenantName: str(row.tenant_name) || 'Tenant',
      tenantPhone: verified ? str(row.tenant_phone) : null,
      landlordName: str(row.landlord_name) || 'Landlord',
      landlordPhone: verified ? str(row.landlord_phone) : null,
      payoutMomoNumber: verified ? str(row.payout_momo_number) : null,
      payoutMomoName: verified ? str(row.payout_momo_name) : null,
      payoutMomoSource: verified ? source : null,
      houseCategory: str(row.house_category),
      location: str(row.location),
      rentAmount: num(row.rent_amount),
      dailyRepayment: num(row.daily_repayment),
      totalRepayment: num(row.total_repayment),
      amountRepaid: num(row.amount_repaid),
      durationDays: row.duration_days == null ? null : num(row.duration_days),
      repaymentFrequency: str(row.repayment_frequency),
      repaymentStartsOn: str(row.repayment_starts_on),
      fundedAt: str(row.funded_at),
      houseTitle: str(row.house_title),
      funding: fundingRaw ? {
        recordedAt: str(fundingRaw.recorded_at),
        amount: num(fundingRaw.amount),
        receiptNumber: str(fundingRaw.receipt_number) || `WR-${id.slice(0, 8).toUpperCase()}`,
        reference: str(fundingRaw.reference),
        tid: str(fundingRaw.tid),
        funderName: str(fundingRaw.funder_name) || 'Supporter',
        agentName: str(fundingRaw.agent_name),
        landlordHasDashboard: fundingRaw.landlord_has_dashboard === true,
        rentPaid: fundingRaw.rent_paid === true,
        route: str(fundingRaw.route) || 'funding_recorded',
        routeDetail: str(fundingRaw.route_detail) || '',
        steps,
      } : null,
      agreement: {
        version: str(agreement.version),
        status: agreement.status === 'accepted' ? 'accepted' : 'not_accepted',
        acceptedAt: str(agreement.accepted_at),
      },
    },
  };
}

export async function fetchFunderVerifiedPlan(rentRequestId: string): Promise<FunderVerifiedPlanResult> {
  const { data, error } = await supabase.rpc(
    'funder_verified_rent_plan_dossier' as never,
    { p_rent_request_id: rentRequestId } as never,
  );
  if (error) {
    if (isMissingDossierError(error)) return { state: 'unavailable' };
    return { state: 'error', message: error.message || 'Could not load this Rent Plan' };
  }
  return parseFunderVerifiedPlanPayload(data);
}

/** Fill the on-file tenant agreement with the people on this Rent Plan. */
export function filledTenantAgreement(plan: FunderVerifiedPlan): string {
  const who = [plan.tenantName, plan.tenantPhone].filter(Boolean).join(' / ');
  const when = plan.agreement.status === 'accepted' && plan.agreement.acceptedAt
    ? new Date(plan.agreement.acceptedAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })
    : 'Not accepted yet';
  return TENANT_AGREEMENT_TEXT
    .replace('[Full Name / Phone]', who || 'Tenant')
    .replace('[Auto-fill]', when);
}

export function agreementSummary(plan: FunderVerifiedPlan): string {
  if (plan.agreement.status === 'accepted') {
    const when = plan.agreement.acceptedAt
      ? new Date(plan.agreement.acceptedAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
      : 'a recorded date';
    const version = plan.agreement.version || TENANT_AGREEMENT_VERSION;
    return `Accepted on ${when} (${version}).`;
  }
  return 'Not accepted yet.';
}
