/**
 * Dev-only Playwright harness that reproduces the agent rent-request "existing
 * tenant" flow in isolation: an agent types a tenant phone number, the live
 * lookup (`useExistingTenantByPhone`) finds a match, and the real
 * `ExistingTenantPhoneNotice` renders the tenant's outstanding balance, the
 * previous agent and a Renew button.
 *
 * Mounted at `/__e2e/existing-tenant-notice` ONLY when `import.meta.env.DEV`.
 * The parity spec intercepts the profiles lookup + get_tenant_rent_summary RPC
 * so no auth or seeded data is required.
 */
import { useState } from 'react';
import { ExistingTenantPhoneNotice } from '@/components/agent/ExistingTenantPhoneNotice';
import { useExistingTenantByPhone, type ExistingTenantMatch } from '@/hooks/useExistingTenantByPhone';

export default function ExistingTenantNoticeHarness() {
  const [phone, setPhone] = useState('');
  const [renewedName, setRenewedName] = useState<string | null>(null);
  const [usedName, setUsedName] = useState<string | null>(null);
  const { match, checking } = useExistingTenantByPhone(phone, 100);

  return (
    <div data-testid="e2e-existing-tenant-notice-harness" className="p-6 max-w-md space-y-3">
      <label className="text-sm font-semibold" htmlFor="tenant-phone">Tenant Phone</label>
      <input
        id="tenant-phone"
        data-testid="tenant-phone-input"
        value={phone}
        onChange={(e) => setPhone(e.target.value)}
        placeholder="0700 000 001"
        className="w-full rounded-lg border border-border px-3 py-2 text-sm"
      />

      <ExistingTenantPhoneNotice
        match={match}
        checking={checking}
        onUse={(m: ExistingTenantMatch) => setUsedName(m.full_name || 'unknown')}
        onRenew={(m: ExistingTenantMatch) => setRenewedName(m.full_name || 'unknown')}
      />

      {/* Observable outcomes for the spec */}
      {renewedName && (
        <p data-testid="renew-result">Renew clicked: {renewedName}</p>
      )}
      {usedName && (
        <p data-testid="use-result">Use clicked: {usedName}</p>
      )}
    </div>
  );
}
