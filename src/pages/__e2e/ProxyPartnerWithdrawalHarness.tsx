/**
 * Dev-only Playwright harness that renders the real WithdrawalPayoutCard for a
 * PROXY PARTNER withdrawal — the exact scenario a merchant / cash-out agent
 * sees when they are withdrawing on behalf of a partner.
 *
 * It exercises the partner-name resolution chain added to the payout card:
 *   1. requester profile (`profiles.full_name`) — the AGENT, often blank here
 *   2. linked partner profile (`linked_party_profile.full_name`)
 *   3. registered payout name (`mobile_money_name` / `bank_account_name`)
 *
 * Mounted at `/__e2e/proxy-partner-withdrawal` ONLY when `import.meta.env.DEV`.
 * No auth or seeded data is required — the withdrawal rows are static props.
 */
import { WithdrawalPayoutCard } from '@/components/withdrawals/WithdrawalPayoutCard';

const AGENT_ID = '44444444-4444-4444-4444-444444444444';
const PARTNER_ID = '55555555-5555-5555-5555-555555555555';

// (A) Partner name resolves from the LINKED PARTNER profile even though the
// requesting user (agent) has no readable/blank profile name.
const withdrawalLinkedPartner = {
  id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
  user_id: AGENT_ID,
  linked_party: PARTNER_ID,
  amount: 250000,
  status: 'fin_ops_approved',
  reason: 'Proxy payout delivery for partner return',
  payout_method: 'mobile_money',
  mobile_money_number: '0770123456',
  mobile_money_provider: 'MTN',
  mobile_money_name: 'Grace Nakato',
  bank_account_name: null,
  bank_name: null,
  bank_account_number: null,
  created_at: '2026-07-01T09:00:00Z',
  // Agent (requester) profile has NO usable name.
  profiles: null,
  // Linked partner profile carries the real name.
  linked_party_profile: { id: PARTNER_ID, full_name: 'Grace Nakato', phone: '0770123456' },
};

// (B) No profile at all — partner name must fall back to the registered payout
// (bank) name, never the literal "Unknown".
const withdrawalPayoutFallback = {
  id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
  user_id: AGENT_ID,
  linked_party: PARTNER_ID,
  amount: 500000,
  status: 'fin_ops_approved',
  reason: 'Proxy payout delivery for partner return',
  payout_method: 'bank_transfer',
  mobile_money_number: null,
  mobile_money_name: null,
  bank_name: 'Stanbic Bank',
  bank_account_name: 'Moses Okello',
  bank_account_number: '9030001234567',
  created_at: '2026-07-01T09:05:00Z',
  profiles: null,
  linked_party_profile: null,
};

export default function ProxyPartnerWithdrawalHarness() {
  return (
    <div data-testid="e2e-proxy-partner-withdrawal-harness" className="p-6 max-w-md space-y-4">
      <div data-testid="proxy-card-linked-partner">
        <WithdrawalPayoutCard withdrawal={withdrawalLinkedPartner} readOnly />
      </div>
      <div data-testid="proxy-card-payout-fallback">
        <WithdrawalPayoutCard withdrawal={withdrawalPayoutFallback} readOnly />
      </div>
    </div>
  );
}
