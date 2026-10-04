---
name: Merchant Agent Agreement acceptance
description: Merchant (Cash-Out) agents must accept the Welile Merchant Agent Agreement; acceptance is audited and visible to the CFO alongside execution performance
type: feature
---
When an agent uses the Cash-Out (payouts) tab, `MerchantAgreementGate` blocks the
payout console until they accept the current Welile Merchant Agent Agreement.
Acceptance is recorded in `merchant_agreement_acceptance` (agent_id, merchant_name,
merchant_phone, agreement_version, accepted_at, ip_address, device_info, status)
via `useMerchantAgreement`. RLS: agent inserts/reads own; CFO/COO/manager/super_admin
read all.

CFO sees this in **Cash-Out Agents** (CashoutAgentManager):
- list cards show a Signed / No-agreement badge (keyed by `agreement_by_agent_id` = cashout_agents.agent_id);
- the per-agent drill-down Profile tab shows an Agreement card (accepted date, signed-as name/phone, IP, device) + Download Agreement PDF, plus the existing execution performance (payouts processed, volume, commission, telecom charges, method breakdown).

Agreement version comes from `MERCHANT_AGREEMENT_VERSION`; PDF from `downloadMerchantAgreementPdf`.
