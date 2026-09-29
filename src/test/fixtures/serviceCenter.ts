/**
 * Shared fixtures for the Service Center roster payload
 * (`get_agent_service_center`). Kept in one place so the ranking maths tests
 * and the rankings board tests cannot drift apart on shape.
 */
import type { ServiceCenterSubAgent, ServiceCenterTenant } from '@/hooks/useAgentServiceCenter';

let planSeq = 0;

/** A funded, repaying rent plan owned by the sub-agent, unless overridden. */
export function rentPlan(over: Partial<ServiceCenterTenant> = {}): ServiceCenterTenant {
  planSeq += 1;
  const merged: ServiceCenterTenant = {
    rent_request_id: `rr-${planSeq}`,
    tenant_id: `tenant-${planSeq}`,
    tenant_name: `Tenant ${planSeq}`,
    status: 'repaying',
    monthly_rent: 300_000,
    total_repayment: 1_000_000,
    amount_repaid: 400_000,
    daily_repayment: 10_000,
    is_active: true,
    owned_by_subagent: true,
    ...over,
  };
  // The live payload always carries `collected_live`. Default it to the plan
  // balance rather than a constant, so a test that overrides `amount_repaid`
  // alone keeps meaning exactly what it did before the field existed. A test
  // that cares about the difference sets `collected_live` explicitly, and one
  // that wants the pre-field payload deletes the key.
  if (merged.collected_live === undefined) merged.collected_live = merged.amount_repaid;
  return merged;
}

export function subAgentFixture(
  id: string,
  tenants: ServiceCenterTenant[] = [],
  over: Partial<ServiceCenterSubAgent> = {},
): ServiceCenterSubAgent {
  return {
    sub_agent_id: id,
    full_name: id.toUpperCase(),
    avatar_url: null,
    phone: null,
    email: null,
    agent_tier: null,
    link_status: 'verified',
    linked_at: null,
    source: null,
    commission_total: 0,
    referral_bonus: 0,
    active_tenants: tenants.filter((t) => t.is_active).length,
    total_tenants: tenants.length,
    tenant_list: tenants,
    nested_subagents: 0,
    landlords_registered: 0,
    landlords_verified: 0,
    wallet: { withdrawable: 0, float: 0, advance: 0 },
    suspension: null,
    pending_transfers: 0,
    ...over,
  };
}
