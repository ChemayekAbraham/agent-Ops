# Food M1 — Production read-only preflight (2026-10-14)

Outcome: **NO-GO** (one open decision; everything else checked is clean or has a known, ordered fix).
Repo: `lovable` @ `8f0bd3cdde`, clean tree. Earlier reports kept unchanged:
`food-m1-release-audit-2026-10-13.md`, `food-m1-risk-closure-register.md`,
`food-m1-production-evidence-and-isolation.md`.

No production change was made: every query ran in a read-only session
(`default_transaction_read_only = on`, probe E0b returned `READ_ONLY_CONFIRMED`),
as the restricted role `sandbox_exec`. No role, record, ledger entry, wallet,
order, Returns posting, deploy, publish, push or merge.

Raw output (verbatim): `/mnt/documents/food-m1-preflight-2026-10-14/evidence.out`
(sha256 `c996c3be993be554d8f3fe749ebca7afe8fce999c35246de1450b3f26d035fa1`) and `precheck.out`.

## 1. Production identity and deployment
- Database: the project's Lovable Cloud backend (ref `wirntoujqoyjobfhyelc`), PostgreSQL 17.6,
  taken 2026-10-14 02:02:45 UTC. This is the live database behind welileapp.com and the preview.
- Deployed frontend: welileapp.com serves `assets/index-CZDDhFI_.js`. A crawl of all 956 live
  chunks found **no** `post_portfolio_roi_ledger` call; the live COO/Partners chunks still use the
  old direct ledger path. So the live site predates `af745b3ff2` (the boundary switch).
  Exact deployed commit: UNVERIFIED (no tool reads it); strongest evidence = last publish at `677ec01874` lineage.

## 2. Migration history reconciliation
- `supabase_migrations.schema_migrations`: 3,262 rows, max `20260911080102`. **None** of the 11
  Food versions (nor 20261013129000) is recorded. This table has recorded nothing since
  2026-09-11 although later migrations are live, so history alone proves nothing.
- Schema reconciliation: 0 `food_%` tables/views, 0 `food%` functions, 0 food policies/triggers,
  no `food_guard_payment_reversal` trigger, no `food-meal-images` bucket, no `food_meal_images_*`
  storage policy, no `post_portfolio_roi_ledger` / `_ledger_can_post_partner_returns`.
  0 ledger rows with a `FOODPAY-%` reference or `reversal:FOODPAY-%` key.
- Conclusion: all 11 are **unapplied, with no partial install and no name conflicts**.
- Ordering caveat (DEP-1): Food versions are older than already-live migrations, so a
  timestamp-ordered runner would skip or misorder them; apply one at a time in the list order.

## 3. Read-only check results
| Check | Result |
|---|---|
| E0 / E0b | read-only on, write probe rejected |
| E1 `check_transfer_recipient_eligibility(uuid,text,uuid)` | exists, SECURITY DEFINER, exact signature/return type the release expects |
| E1c wallets | `wallets.id`, `wallets_physical(id,user_id)`, `general_ledger.wallet_id` present; one wallet per user (`wallets_user_id_key`) |
| E2 | no Food objects, no Food versions (above). `schema_migrations` read via the platform read tool; psql role denied (UNVERIFIED via psql only) |
| E2b | guard trigger name free; 0 conflicting ledger rows |
| E6 | 0 SECURITY INVOKER ledger callers; |
| E6b | all 115 definer callers owned by `postgres`, keep EXECUTE after a future revoke on all 4 overloads |
| P-6e | 0 storage.objects policies without a `bucket_id` restriction |
| P-7a | `v_pso_officers` exists |
| Precheck P-1..P-5 | script aborted at P-3d: `permission denied for schema auth` (sandbox role). The equivalent checks were rerun individually and are reported here. |

## 4. Migration impact table
| Migration | Purpose / objects | Money impact | Applied | Rec. |
|---|---|---|---|---|
| 20261009120001 | Food tables, RLS, coordinator assignments; **conditional coordinator seed** | none | no | NO-GO until §5 decided |
| 20261009130001 | 18 operation RPCs (menu, orders, delivery) | none | no | GO after 120001 |
| 20261009160000 | coordinator candidate list (1 fn) | none | no | GO |
| 20261009170000 | exception resolution (1 fn, reason ≥10) | none | no | GO |
| 20261012120000 | release corrections, `food_bootstrap_coordinator` (service_role only), 15 fn, 1 policy, 1 trigger | none | no | GO |
| 20261013120001 | private `food-meal-images` bucket + 2 bucket-scoped policies, 3 fn | none | no | GO (bucket via migration conflicts with platform rule "create buckets with the bucket tool"; must be executed as written or split — decide before apply) |
| 20261013125000 | staff lookup includes PSO via `v_pso_officers`; Food-specific RPC, not `cc_forward_staff_options` | none | no | GO |
| 20261013126000 | `post_portfolio_roi_ledger` + `_ledger_can_post_partner_returns`; grants only, no revoke | posts Returns legs (COO/Partners) | no | GO, **must precede publishing current code** |
| 20261013127000 | exception self-resolution (1 fn) | none | no | GO |
| 20261013128000 | pay-after-receipt: 1 table, 1 policy, 9 fn, 4 calls to `create_ledger_transaction` (employee → coordinator wallet) | yes, wallet transfer | no | GO in test first |
| 20261013128500 | `food_guard_payment_reversal` trigger (WHEN `reference_id LIKE 'FOODPAY-%-REV'` or `idempotency_key LIKE 'reversal:FOODPAY-%'`) + handover/payee checks | blocks Food reversals only | no | GO |
| 20261013129000 | revoke | — | — | **excluded** |

## 5. Food Coordinator decision
- Seed condition: inserts profile `29a0cfa8-…` as active coordinator when that profile is live and
  no active coordinator exists. In production both are true, so **applying 120001 as written seats it**.
- That profile: SARAH ANGWEN — live, not frozen, one wallet, enabled `employee` role (also CFO, COO,
  CEO and others). Eligible on the recorded rules. `assigned_by` would be the same person.
- The requester of this preflight is the same person, so self-confirmation is not an independent
  approval. **Unresolved → NO-GO.** Options: (a) a second authorised person confirms in writing; or
  (b) neutralise the seed in a reviewed revision and appoint via `food_bootstrap_coordinator()`
  (service_role only, writes `food_audit`). Revision before first apply creates no conflict (no row exists).

## 6. COO / Partner-Ops authorization (20261013126000)
- New rule: enabled role `coo`/`super_admin`/`cto`, or active staff grant `coo`/`partner-ops`.
- Live holders: coo 8, cto 3, super_admin 2; grants `partner-ops` 10, `coo` 9.
- App gates today: `/coo/dashboard` = role coo/super_admin/cto + grant `coo` (super_admin/cto bypass);
  Executive Hub Partners tab = grant `partner-ops` (super_admin/cto bypass). The DB rule is a superset
  of both gates, so **no legitimate user is blocked**. 1 user with the `partner_ops` app role has no
  grant; they cannot reach the page today either — consistent, no change suggested.
- Side effects: adds two functions, revokes nothing; live direct path keeps working. Not executed.
- **Risk:** the repo frontend already calls `post_portfolio_roi_ledger`. Publishing current code
  before 126000 is applied breaks COO Returns compounding/split payouts.

## 7. RLS, storage, ledger
- Bucket private, policies name the bucket; no other storage policy leaks into it (P-6e = 0).
- Ledger guard narrowly scoped by WHEN clause; 0 existing rows match; ordinary transfers and other
  reversals unaffected (by definition text; not executed). Payment reversal stays disabled.

## 8. Tests and recovery
- Earlier local throwaway-cluster runs (prior reports) are **not** production evidence. No verified
  isolated Lovable Cloud test project is connected here (Test Sandbox has no backend). UNVERIFIED in a
  real environment: sign-in, photo storage, staff lookup, wallet payment.
- Rollbacks are listed in each migration header (drop functions/trigger). 128000 creates payment rows;
  once real payments exist rollback is not data-neutral.

## 9. Blockers
1. Coordinator decision (§5) — owner: business, independent of the appointee.
2. No verified isolated test project for end-to-end tests.
3. Bucket-creation-by-migration vs platform rule (120001).
4. Publish order: 126000 must be applied before the current frontend is published.
5. Shopping Advance counting of canteen payments (earlier finding) — unresolved.

## 10. Proposed sequence (for separate approval only)
120001 → 130001 → 160000 → 170000 → 20261012120000 → 20261013120001 → 125000 → 126000 → 127000 → 128000 → 128500.
Stop if: any statement errors; a Food object appears before its migration; the seed NOTICE differs
from the approved decision; any E-check differs from §3. 129000 not included. Nothing applied.
