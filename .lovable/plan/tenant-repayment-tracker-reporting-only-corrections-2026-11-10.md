# Tenant Repayment Tracker: reporting-only corrections

## Investigation result
Reproduced the displayed 243 exceptions across 208 tenants. No production case was resolved or changed. Five cases have evidence-backed reporting-only correction candidates; the remaining 238 need further evidence or review. See the attached case workbook and summary.

## Proposed changes for approval
1. Load the full authorized register instead of only the first 1,000 plans; reconcile cards against complete rows.
2. Correct three false receipt warnings for Makwanga Ivan, Kiggundu Akram and Namutosi Joan by recognizing already-counted, uniquely matching same-plan Money In. Never add those payments again.
3. Correct two false edit warnings for Nicholas Atuhairwe and Nsubuga Lawrence George by recognizing the existing repayment-backed Money In path.
4. Provide exact tenant-and-plan investigation links, with tenant lifetime activity clearly separated from selected-plan collections.
5. Retain all unresolved warnings and original evidence. No bulk closures or unsupported matches.

## Boundaries
No payments, wallet movements, deductions, refunds, transfers, recoveries, ledger changes, production balance changes or plan status changes. No data-link edits without separate case-specific evidence and approval. Approval here authorizes reporting work only.

## Technical details
The register hook currently makes one unpaginated RPC call. Receipt validation omits the rent_requests source already used by collected totals. The edit detector tests nearby agent_collections but misses payment-backed repayment records. Any read-only reporting-function revision will use a separately reviewed migration after approval, retaining grants, caller checks and every financial definition. Tenant Operations chooses latest plan per tenant and aggregates lifetime collections, so those totals must never be assigned to an older exception plan.

## Verification
Test pagination, plan/tenant isolation, unique payment matching, reversals, repeated equal amounts and cutoff boundaries. Revalidate the five live cases before and after changes, asserting unchanged amounts/status/history. Verify the authorized CFO screen before reporting production resolution.
