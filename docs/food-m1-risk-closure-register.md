# Food M1 — Risk-Closure Register and Release-Readiness Evidence

**2026-10-13.** Release candidate branch `release/food-m1-v2`, worktree `C:\Users\USER\welilereceipts-food-m1-release2`.

| | |
|---|---|
| Starting commit (this pass) | `9c60d2308124a60a5416d088581e4142575aa907` (verified before any change) |
| Final commit | see the final report (this document is part of it) |
| Production | **no** connection, query, DDL/DML, migration, deployment, push or merge |
| Overall status | **CODE-VERIFIED, PRODUCTION COMPATIBILITY NOT YET VERIFIED** |

Personal data: none. Synthetic test identities only. The single production profile id that appears is M1's conditional coordinator seed, as before.

---

## Risk-closure register

| ID | Issue and impact | Status | Evidence | Change | Test → result | Remaining limitation |
|---|---|---|---|---|---|---|
| **A / FM-37** | Exception categories: 5 implemented vs the **9 approved** codes stated in the 2026-10-13 instruction. *Note:* the session record of 2026-10-12 shows "Standard 5" was selected when asked; the latest instruction is followed | **FIXED AND VERIFIED** | Table CHECK, `food_raise_exception`, TS type, labels, fixture and both pickers now carry exactly MISSING_ITEM, WRONG_ITEM, QUALITY_ISSUE, LATE_DELIVERY, NOT_DELIVERED, DAMAGED_ORDER, STOCK_UNAVAILABLE, ORDER_ERROR, OTHER | `20261012120000` (CHECK, RPC), `foodService.ts`, `foodService.mock.ts`, tests | SQL KIND-01…08 on PG17 **and** PG18 → pass; fixture 9 accept + 3 refuse → pass; exact-set and both-picker UI tests → pass | Old lowercase rows from earlier test projects remain (CHECK is NOT VALID); production has none |
| A2 | Operational exception rules (own-order reports, coordinator any order and resolve, required description, one open report per order, audit, no money or status effect) | **VERIFIED — NO FIX NEEDED** | Unchanged code paths; re-run with the new codes | — | EXR-01…21, KIND-08, ISO-03/06/07 → pass on PG17 and PG18 | — |
| **B / FM-28** | Production schema compatibility: `profiles.deleted_at`, `user_roles.enabled`, the employee-role population, Food-object conflicts, first coordinator | **BLOCKED — NOT VERIFIED** | No authorised read-only production connection exists in this session (no Lovable or Supabase tool); none was attempted | Added `supabase/tests/food_m1/production_readonly_precheck.sql`: READ ONLY transaction, aggregate counts and booleans only | Validated on local PG17/18 scaffolds: runs; a write inside it is refused. **Not proof of production** | Needs an authorised person to run it before any migration |
| **C** | Latest `lovable` compatibility | **FIXED AND VERIFIED — see §C** | `ls-remote` tip `169118141b` (40 commits after base `e1c0264528`); objects fetched with **no ref change** (verified). Upstream touches 12 non-Food files: no migrations, edge functions, dependencies, routes, nav or auth. Trial merge in a throwaway detached worktree: clean, 0 conflict markers | none needed | guards, Food tests, `tsc`, build on the merge → §C | Lovable keeps moving: re-merge `origin/lovable` at release time |
| **D** | Generated Supabase types lack Food objects | **VERIFIED — NO FIX NEEDED (pre-migration)** | `types.ts` is the *generated Lovable Cloud types*, pinned by `guard-schema-types`, and is regenerated only after a migration is applied (`schema:accept-types --write`). Regenerating now would need the migrations on the live database, and hand-editing would defeat the guard. Food code uses explicit casts and its own interfaces | Added `supabase/tests/food_m1/local/types_vs_schema.py` | All 10 Food row interfaces vs the final migration columns: 0 phantom fields → pass; `tsc` 0 errors | Regenerate types after the migrations are applied (release step) |
| **E1 / FM-36** | Audit, Coordinator, Menu and Service panels had no error state: a failed read showed the EMPTY state ("Nothing outstanding") | **FIXED AND VERIFIED** | `FoodLoadError` alert with retry of failed reads | `FoodLoadError.tsx`, 4 panels | UI-state test: red without the component, green with it | — |
| E2 | Food nav gates must not retry (retry storm when RPCs are missing) | **FIXED AND VERIFIED** | `retry: false` on both gates | (earlier) | canteen gate and coordinator-status gate: exactly one request on failure → pass | — |
| E3 | Keyboard usability of ordering | **VERIFIED — NO FIX NEEDED** | native buttons, select and textarea; Radix radio group | — | keyboard-only order test (Enter, Space) → pass | Screen-reader pass not performed |
| E4 | Loading, empty, error and success states; role visibility; validation messages | **VERIFIED — NO FIX NEEDED** after E1 | Every Food screen has loading and empty states; error states now on all; toasts on success; route guard and nav gating tested; inline validation for cart, menu, cancel and exceptions | — | 196 Food client tests → pass | — |
| **E5** | Visual restyle to CFO/employee design conventions; responsive layout at phone widths | **OPEN (Gemini)** | Not performed and not visually verified: no browser preview could be started without writing launch config into the protected original checkout | — | — | Gemini: payment-mode selector, report-a-problem form, cancel dialog, menu scheduling inputs, exception log form, "Pays by" badge, FoodLoadError. Plus a responsive pass at 360–414 px |
| **FM-35** | Fixture and UI suites depended on the wall clock (failed before 08:00 Kampala); exposed this morning (06:36 Kampala) | **FIXED AND VERIFIED** | `Date` pinned to a Kampala noon in both suites (timers real) | 2 test files | 193/196 pass at 06:36 Kampala (previously 8 failed) | DB fixtures use 00:00–23:59:59 windows: only a run straddling Kampala midnight could flake |
| FM-38 | `run.sh` counted any output line containing "ERROR" as a failure (an `ORDER_ERROR` value) | **FIXED AND VERIFIED** | counts only psql `ERROR:` lines | `run.sh` | 138/138; a real SQL error is still counted (probe) | — |
| **F** | 40 full-suite failures at `9c60d23081` | **VERIFIED — none introduced by Food M1** | see §F | `import_reach.py` (tool) | — | 37 pre-existing and 3 flaky remain in non-Food areas (not ours to change) |
| G1 | Financial isolation (orders, modes, delivery, cancel, exceptions, `food_pay_order`, non-Food objects) | **VERIFIED — NO FIX NEEDED** | rerun because the migration changed | — | `isolation_check.sh` 10/10 on PG17 and PG18 (83/96 non-Food objects identical; zero canary DML; positive control counts a real write) | — |
| G2 | Harness and SQL runners cannot reach production | **VERIFIED — NO FIX NEEDED** | unchanged since the last gate (host-guard tests 4/4; runner refusal probes) | — | `foodDbHostGuard.test.ts` → pass (in the 196) | — |
| G3 | Migrations: fresh database, existing database, re-apply, prerequisites, schema equivalence | **VERIFIED** | rerun after the migration change | — | `migration_matrix.sh` 20/20 on PG17 and PG18 | — |
| G4 | Concurrency (cap, stock, cancel, idempotency, handover) | **VERIFIED** | rerun | — | races 7/7 and R2–R4 16/16 on PG17 and PG18 | — |
| H | Original checkout, refs, stashes and backup | **VERIFIED — intact** | HEAD, branch, status, index bytes and 9 dirty-file hashes identical to the backup snapshot; every original ref intact; stash list identical; backup unmodified since written | — | read-only comparisons | `origin/lovable` and `origin/HEAD` (remote-tracking caches) were advanced by fetches; this pass's fetch changed no ref |

## §C Latest-`lovable` compatibility

_Filled in from the trial-merge run below._

## §F Full-suite failure classification (run at `9c60d23081`; later commits change Food files only)

| Class | Count | Evidence |
|---|---|---|
| Confirmed pre-existing baseline | **37 tests** (in 21 files, plus file-level load errors in the same set) | Identical failing set on a clean `origin/lovable` `e1c0264528` worktree using the **same** `node_modules` |
| Intermittent / flaky | **3 tests**: `AwarenessCallsPage › every filter reaches the reports on the server`; `ShortfallDrilldownPage › filters on the server…`; `› records a follow-up…` | Failed 1 of 3 isolated runs on clean `lovable`; passed 3 of 3 on the release; fail only under full-suite load |
| Potentially introduced by Food M1 | **0** | `import_reach.py`: none of the 23 failing test files can reach any of the 30 changed `src` files, even transitively. Positive control: Food tests, PersonalLayout and App do reach |
| Unclassified | **0** | — |

The failing areas are agent service-centre, sub-agent copy, promissory note, CFO wallet-movement read-only guard, fleet collected, executive nav nesting, cash-deposit expiry, send-money dialog, login performance, onboarding and settings name capture, supporter managed proxy, payout card, and national-ID OCR. All are non-Food and owned by other workstreams. They were not modified.

## Addendum 2026-10-13 — meal photo upload

Requested by the CFO: the Add/Edit meal form lets the active Food Coordinator attach, change or remove a photo. Nothing touches money, wallets, the ledger or payment status.

| Item | Decision / result |
|---|---|
| Migration | `20261013120000_food_meal_images.sql` — **not applied anywhere but the local test clusters.** |
| Storage | One new bucket `food-meal-images`: public read, JPEG/PNG/WebP only, 2 MB cap. Upload only by the **active** coordinator (backup holder refused), only as `meals/<uuid>.<ext>`. No UPDATE/DELETE policy, so a photo that appeared on a menu cannot be silently swapped; a change is a new file. Other buckets' policies untouched (isolation check proves the `avatars` stand-in is unchanged). |
| Meal record | `food_set_meal_image(meal, path, reason)` sets or clears `image_path`; refuses archived meals, foreign URLs and paths never uploaded; writes `photo_set` / `photo_removed` to the audit trail. |
| Client | Meal saved first, then the photo attached to the returned id; if the photo step fails the dialog stays open as an edit of the saved meal, so a retry never duplicates the meal. Client checks mirror the bucket limits. |
| Why public read | Menu photos are not personal or sensitive, and every employee must see them; a signed-URL design was considered and rejected as cost without benefit. Revisit if photos ever carry people. |
| Tests | SQL PH-01…PH-18 (PG17 + PG18, behaviour 156/156; matrix, isolation, races green); client `src/__tests__/foodMealPhoto.test.tsx` (real upload path) and 6 UI tests; tsc 0 errors; guard:all passed; production build passed; checked in the offline preview. |
| Open | Production precheck for the `storage` schema (bucket name free, policy names free) is added to the items that need read-only production access. Orphaned uploads (picked, upload succeeded, attach failed) are possible and harmless; an admin cleanup can be scheduled later. |

## Addendum 2026-10-13 — ordering runs all day

CFO decision: Breakfast and Lunch take orders throughout the day, with no closing time.

| Item | Decision / result |
|---|---|
| Server | **No change.** `food_place_order` accepts an order while Kampala time is BETWEEN the period's opening and closing times (inclusive); a period set 00:00:00 – 23:59:59 is open all day. The behaviour suite's own periods already use that window, and its order tests pass at any hour. |
| Considered and rejected | Removing the window check from the RPC: a migration plus a loss of the coordinator's ability to set a cut-off later (e.g. a supper period). Data-only keeps both. |
| Production | No service periods exist yet (none are seeded by any migration). When Food is released, the coordinator creates Breakfast and Lunch in Food Management → Service with **"Take orders all day"** ticked. Existing periods cannot have their times edited in the UI today (only activate/deactivate). |
| Client | `FOOD_ALL_DAY_OPENS/CLOSES` and `isFoodAllDayWindow()` in `src/lib/foodService.ts`; canteen shows "Orders open all day"; Service panel has the all-day option and lists such periods as "Ordering all day". Fixture seed: both periods 00:00:00 – 23:59:59. |
| Known edge | The final sub-second of the day (23:59:59.x) falls outside the inclusive window. Orders are for today only, so this is immaterial. |
| Unchanged | Per-person limits (Breakfast 2, Lunch 5 in the fixture), orders for today only, closure days, payment after delivery (D2). |
| Tests | 5 new UI/fixture tests (open at 05:00 and 23:30 Kampala; late Breakfast order accepted; coordinator all-day option), 2 lib tests; fixture tests now pick Lunch by name. Food tests 214/214. |

## Addendum 2026-10-13 — payment-method dry test

Asked: confirm the payment methods work. Under D1/D2 a method is **recorded only**; nothing is charged, and payment happens after delivery through a process not yet approved.

**Server, disposable local databases (PG 17.10 and PG 18.6), all inside BEGIN … ROLLBACK, financial canaries planted before the Food migrations: 15/15 on both.**
Each of cash / wallet / mobile money is accepted, echoed back and stored; every order unpaid with no transaction. "card", no method and "Wallet" (mis-spelt) refused. A repeated submission keeps the first method. `food_pay_order` refused for employee and coordinator, including after delivery. All three taken to delivered: still unpaid, method unchanged. Coordinator overview shows the method mix. Zero writes to ledger / wallet / requisition stand-ins and their totals unchanged; nothing left behind after rollback.
**Negative control:** the same run with one planted wallet debit fails DRY-13 (`wallet_transactions:INSERT`) and DRY-14, so the clean result is not vacuous.

**Screens (offline preview, fixture data):** checkout offers Cash / Welile wallet / Mobile money, none pre-selected, "Place order" disabled until one is chosen, copy says nothing is charged now. One order per method placed; My orders shows each as "Not paid yet · Pays by <method>".

**Not tested, by design:** an actual wallet debit or MoMo collection. Neither exists in Food M1; building one needs an approved payment design.
Dry-test scripts were kept outside the repository (session scratchpad).

## Addendum 2026-10-13 — meal photo security (Phase 4: P-1, P-2)

Source: `C:\Users\USER\food-m1-audits\food-m1-photo-security-audit-2026-10-13.md`. Migration `20261013120000` was edited in place: it had never been committed or applied anywhere but local test databases.

| Finding | Change | Evidence (local only) |
|---|---|---|
| **P-1** photos public | Bucket **private**, and the fail-closed check now refuses an existing public bucket. Read policy via `food_meal_photo_readable(name)` (definer, self-only, `authenticated` only): the active coordinator reads every photo; a canteen user reads **only the photo of a published meal**; a tenant, a disabled employee and anonymous read nothing. The client shows photos through **signed URLs** (`createSignedUrls`, one batch per menu fetch, TTL 1 h, cached and renewed 10 min before expiry); `getPublicUrl` is no longer used | PH-01, PH-19…28; MIG-D5…D7; negative control: a weakened "any canteen user" rule fails PH-21/22/23/28; client tests "never builds a public URL", "one request", cache and renewal |
| **P-2** `food_upsert_meal` bypass | `food_upsert_meal` (same signature, grants and `search_path`) refuses any non-NULL `p_image_path`, so photos change only through `food_set_meal_image`. New column CHECK `food_meals_image_path_shape` (NOT VALID) admits only `meals/<uuid>.<ext>`. Client: `UpsertMealInput.imagePath` removed; only server-shaped names are ever signed or shown | PH-29…38 (external, data, absolute, other-bucket and even well-formed names refused; an edit keeps the photo; a privileged write is refused by the CHECK); fixture parity test; client tests |
| P-4 client pass-through | Closed by the same client change (non-storage values map to null) | client tests |
| Unchanged | Upload: active coordinator only, server-shaped name, no UPDATE/DELETE policy, `upsert: false`; audit trail; no order, payment, wallet or ledger logic touched | PH-02…18; isolation 10/10; dry run 15/15 |

**Limitations (open):**
- None of this is verified on real Supabase Storage; that needs an approved isolated project (P-9).
- A signed URL is a bearer link, valid until it expires (at most 1 h), even after the meal is unpublished.
- P-3 (`purge-rejected-listings` deletes across buckets) and P-5 (no clean-up of orphaned photos) remain open.
- Production precheck P-6e (unscoped storage policies) has been added but has not been run.

## Addendum 2026-10-13 — P-3 cross-bucket deletion (Phase 5)

**Root cause.** `purge-rejected-listings` runs with the service role. Its `parseMedia()` took the bucket name from the text of any URL containing `/storage/v1/object/public/` and deleted the object:
- no bucket allowlist;
- no host check;
- no path validation;
- `decodeURIComponent` could throw and abort the whole run.

Negative control (the original function against attack inputs): it returned the Food bucket and `avatars` for deletion, accepted a storage-shaped URL on a foreign host, and threw a `URIError` on a malformed escape.

**Fix (smallest).** The decision now lives in a new pure module, `supabase/functions/purge-rejected-listings/media.ts`. An object is deleted only when all of these hold:
- the URL is http(s) on this project's own Storage host (the `SUPABASE_URL` host);
- the path is `/storage/v1/object/public/<bucket>/<path>`;
- the bucket is in `PURGE_ALLOWED_BUCKETS = ['house-images']`. Evidence: every listing-photo upload path uses `house-images`, and videos are external links;
- every path segment is clean: not empty, not `.` or `..`, and with no `/`, `\` or control character once decoded.

Anything else is refused, counted by reason and bucket (no URLs or paths are logged), and recorded in the run's `errors` as `{stage: "media_refused"}`. It does **not** fail the run: the listing is still purged, only that object is left alone.

`index.ts` changes only how media references become deletions. Batching, size measurement, removal, listing deletion and the `rejected_listing_purge_runs` audit row are unchanged.

**Tests.** `src/__tests__/purgeRejectedListingsMedia.test.ts`: 28/28 pass. They cover:
- allowed deletions and normal grouping and de-duplication;
- the Food photo refused;
- 6 other buckets refused;
- `..` and `%2e%2e` traversal into the Food bucket refused;
- foreign hosts, including a look-alike host;
- relative paths and non-http schemes;
- a malformed escape, encoded `/` and `\`, empty segments, a NUL character, a missing bucket or path, an uppercase bucket, an over-long path;
- non-string values.

Lint passes; `media.ts` type-checks strictly, as does `index.ts` (with Deno type stand-ins; the original type-checks the same way). `guard:all` passes.

**Limitations.**
- Deno itself is not installed, so the function was not run in Deno, and it was not deployed anywhere.
- Within `house-images`, a rejected listing that lists *another* listing's photo URL could still have that photo deleted; that needs ownership data the purge does not have. This is residual and outside Food scope.
- If production stores listing media in a bucket other than `house-images`, those files are now left in place, and reported, rather than deleted.

## Release gates (as of 2026-10-13, Phase 5)

| Gate | Status |
|---|---|
| Production read-only precheck (`production_readonly_precheck.sql`, P-1…P-6e) | **Not run.** The earlier zero-issue result came from a local stand-in, which is **not** production evidence |
| Real Supabase Storage verification (private bucket, policies, signed URLs) | **BLOCKED.** No isolated project is positively identified (`nykdsrixasxokqtfvvgw` is not designated anywhere on record) |
| Work preserved | Phases 4–5 and earlier UI work are uncommitted. The Phase 1 backup predates Phases 4–5 |
| Latest `lovable` compatibility | Not re-verified since `lovable` moved (68 commits ahead) |
| Deployment path | Migrations, then the edge function, deployed through Lovable's agent (not git push); the frontend is merged to `lovable` only while the agent is idle and with Josh's go-ahead; types regenerated after the migrations |
| Decisions pending | First coordinator (P-4); "+" stepper; whether a backup coordinator sees Food Management |
| Non-blocking | E5 phone-width pass; P-5 orphan clean-up; whole-project vitest re-run |


## Release-gate register (Phase 6, 2026-10-13)

Evidence types:
- **local**: disposable PostgreSQL 17/18 with the storage stand-in, or a jsdom fixture.
- **code-only**: read-only source inspection.
- **owner-supplied**: an operator's statement, not independently verified.

Nothing below is production or real Supabase Storage evidence.

| ID | Sev | Finding | Status | Evidence (type, date) | Remaining action / prerequisite | Blocks employee availability |
|---|---|---|---|---|---|---|
| **PAY-W1** | **Critical** | **Wallet payment to the Food Coordinator is not implemented.** Choosing "Welile wallet" only records `payment_mode='wallet'`: `FoodOrderingPage` submit → `usePlaceFoodOrder` (`useFoodService.ts:693-702`) → `food_place_order` (`20261012120000:170-313`; validation at 207; INSERT with `pending_payment` at 311-313). There is no debit, no credit, no recipient, and no wallet or ledger call anywhere in Food code or on any local branch. The coordinator is identified only by a profile id in `food_coordinator_assignments` (`is_active_food_coordinator`, `20261012120000:106-111`); no wallet is linked. `food_pay_order` refuses in every version (`20261009130000:402`, `20261012120000:420`), and no screen calls `usePayFoodOrder`. Nothing can set `paid`: there is no UPDATE grant, and a CHECK requires `transaction_group_id` for `paid` (`20261009120000:109`). Fulfilment deliberately does not wait for payment (D2). **This conflicts with the 2026-10-13 instruction that wallet routing to the coordinator is a critical requirement; D1/D2 (2026-10-12) said "recorded only, pay after delivery".** | **OPEN (needs owner decision)** | code-only and local: PAY-01/02, REL-D1a-g, REL-D2a-d, SEC-02, PM-01/02, INT-02, DRY-01..15 (2026-10-13) | The CFO must resolve D1/D2 against the wallet requirement. If wallet settlement is required, a separately authorised design must specify: the recipient account (the coordinator's personal wallet or a dedicated canteen account; the coordinator is an individual), the ledger category and accounting treatment, payment through the established ledger function only, server-side idempotency, refusal before delivery (D2), atomic `paid` plus `transaction_group_id`, and failure states. **Not implemented without authorisation** | **Yes, if wallet payment is required at launch.** No, if D1/D2 (recorded only) stands. The current behaviour moves no money and is safe |
| **ENV-1** | High | Isolated Supabase project `nykdsrixasxokqtfvvgw` | **BLOCKED ON OWNER CONFIRMATION** | owner-supplied (session 2e880c72, 2026-10-12): name "Welile Food Ordering Test", the operator said it matches the dashboard and is non-production. No connection was ever made. `docs/food-m1-execution-evidence.md` section 1: the earlier test project's reference "was not recorded, and now likely unrecoverable" | Written owner confirmation (below) | Yes (real Storage verification depends on it) |
| **STO-1** | High | Private bucket, storage policies and signed URLs not verified on real Supabase Storage | **BLOCKED** (on ENV-1) | local only: PH-01..38, MIG-D5..D7, negative control (2026-10-13) | Run the isolated-project steps (Phase 5 report) | Yes |
| **B / FM-28** | High | Production read-only precheck not run | **BLOCKED** (no authorised read access in this session) | code-only: the file is three statements (`BEGIN TRANSACTION READ ONLY`; one SELECT; `ROLLBACK`). With string literals removed, the only functions called are built-in and side-effect-free: `count`, `coalesce`, `current_setting`, `to_regclass`, `to_regprocedure`; no user-defined function | An authorised person runs it (requirements below) | Yes |
| **P-3** | Medium | Cross-bucket deletion in `purge-rejected-listings` | **FIXED AND VERIFIED (local)**; not deployed | local: 28/28 (2026-10-13). Code unchanged since: hashes equal the Phase 6 backup | Deploy the function **before or with** Food, through Lovable's agent. Employees learn object names from signed URLs, so the old function could still be pointed at Food photos | Yes (deploy ordering) |
| **P-3b** | Medium (not Food) | An agent can list another agent's public `house-images` URL in their own listing's `image_urls` ("Agents can update own listings" does not protect `image_urls`; no constraint). If that listing is rejected for 14+ days with no rent request, the purge deletes the other agent's file. The function is also callable by anyone with a valid JWT, and `days` can be set as low as 1 | **OPEN, deferrable for Food** | code-only (2026-10-13) | Listings workstream: restrict deletion to objects owned by the listing's agent (`storage.objects.owner` or a path prefix) and gate the function on a service caller | No |
| **P-5** | Low | Orphaned photos are not cleaned up | **DEFERRABLE** | code-only. The bucket is private and orphans are unreadable by employees (PH-22); cost only | Later scheduled clean-up with an explicit batch cap | No |
| **C** | Medium | Latest `lovable` compatibility | **UNVERIFIED (runtime)**; textual compatibility good | local git, read-only (2026-10-13): the auto-fetched cache `95671efb01` is 112 commits ahead of the base. The only overlap is `src/App.tsx`, and an out-of-repo three-way merge gives 0 conflicts. Upstream changed `types.ts`, a guard and 4 migrations | With approval: fetch, trial-merge in a throwaway worktree, run the Food suites | Yes (before merge to `lovable`) |
| **DEP-1** | Medium | Migration ordering: the Food migrations' timestamps (20261009..20261013120000) are older than migrations already in `lovable` (for example 20261012150000, 20261013130000) | **OPEN** | local git (2026-10-13) | Apply the six files explicitly, in order, through the approved path. If a tool orders by timestamp, re-timestamp them first (needs authorisation) | Yes (deployment procedure) |
| **DEC-1** | High | First coordinator | **OPEN (owner)** | M1 seats profile `29a0cfa8-...` only if it exists and is live; otherwise `food_bootstrap_coordinator` (service role) is needed | The owner names the first coordinator | Yes (no one can publish a menu without one) |
| DEC-2 | Low | "+" stepper | OPEN (owner) | UX only | Owner choice | No |
| DEC-3 | Low | Whether a backup coordinator sees Food Management | OPEN (owner) | A backup holder is read-only (COO-09, PH-10) | Owner choice | No |
| E5 | Low | Phone-width visual pass | OPEN (Gemini) | none | Gemini | No |

**ENV-1: the confirmation needed from the project owner, in writing, with no credentials in the message:**
1. `nykdsrixasxokqtfvvgw` is the designated Food M1 test project, in a project separate from production `wirntoujqoyjobfhyelc` and not connected to the Lovable production app.
2. It holds no real personal or financial data, and synthetic users, orders and uploads may be created there and later discarded.
3. Approval for the listed actions: apply the six Food migrations, create synthetic users, upload test images, call Storage as each role.
4. How credentials will be supplied: entered by the operator at an interactive prompt or through an environment variable, never in chat.
5. Whether its existing state (the earlier M1 test fixture) may be reset first.

**B / FM-28: requirements for running the production precheck safely:**
- **Who:** a person with authorised read access.
- **Target:** confirmed in the dashboard to be the production ref, connected with `sslmode=require`. Use a direct or session connection; a transaction pooler may drop `PGOPTIONS`, so the script's own `BEGIN TRANSACTION READ ONLY` remains the primary guard.
- **Role:** one that is not subject to RLS on `profiles` and `user_roles` (for example `postgres`, still inside the read-only transaction). Otherwise counts P-2b and P-2c may be silently filtered and therefore wrong.
- **Credentials:** the password typed at the prompt or held in an environment variable, never in the command line, the repo or chat.
- **Output:** written outside the repository. It contains only counts and booleans.


## Consolidated fix pass (2026-10-13)

| # | Item | Result | Change | Evidence (local) |
|---|---|---|---|---|
| 8 | Staff lookup excluded Platform Sales Officers | **FIXED** | New migration `20261013125000_food_staff_includes_pso.sql`. One predicate `food_is_staff(user)`: a live profile **and** (an enabled `employee` role **or** a current PSO officer per `v_pso_officers`). It is used by canteen access, the successor lookup, the handover and the bootstrap. Service-only helper, not granted to anyone | PSO-01…18 (PostgreSQL 17 and 18); MIG-C2c, D8, D9; R2–R4 16/16 |
| 4a | A canteen payment could be tagged as a "Welile item" | **FIXED** | `welileItemOf` ignores `source_table='food_orders'`; the item filter keeps only genuine item rows | `foodWalletRegressionFixes.test.ts` |
| 3 | Food receipts would inflate the Shopping Advance limit | **FIXED** (no effect until Food payments exist) | `wallet-transfer` and `ShoppingAdvanceHistory` drop `food_orders` rows before summing. A NULL `source_table` is kept | same test file |
| 4b | Custodial cash counted only the outflow leg of `wallet_transfer` | **FIXED** | `useFinancialStatements` uses `netWalletTransferOutflow(out, in)`. The investor-report "Wallet Transfers" line is now the net | same test file |
| 6, 7, 10 | Exception controls, meal photos, schema | **Re-verified, no change** | — | 194/194, matrix 29/29, isolation 10/10, races 7/7, dry run 15/15 on PostgreSQL 17 and 18 |
| 1 | Food payment reversal through `reverse_wallet_transfer` | **BLOCKED** | That function exists only in production. A safe server-side refusal needs its definition. Food payments do not exist yet | — |
| 2 | Advance-sweep shield treats food receipts as peer transfers | **BLOCKED** | The shield is SQL (`20260719161607`) plus `process-agent-advance-deductions`. Redefining it from the repo copy could overwrite production-only logic | — |
| 5 | Food wallet payment | **BLOCKED** | See the gates below. The brief also says "fulfil only after authoritative payment confirmation", which contradicts the approved "pay after receipt confirmation" | — |
| 9 | `create_ledger_transaction` callable by any signed-in user | **CONFIRMED by code evidence; not fixed** | `src/components/coo/COOPartnersPage.tsx:631, 5214, 5692` call it with the user's session, so `authenticated` must hold EXECUTE in production. The function has no caller check, and the caller controls `skip_balance_check`. Fixing it means moving those COO postings server-side and revoking EXECUTE: a separate, CFO-approved security change | — |


## Remediation pass (2026-10-13, after 9e6ea7a6d1)

All evidence below is **local**: disposable PostgreSQL 17.10 and 18.6 on 127.0.0.1, and jsdom. No production object, permission, migration or ledger row was touched. The Supabase test project `nykdsrixasxokqtfvvgw` was **not** used (identity unverified).

| ID | Sev | Root cause | Change | Tests and evidence | Needed production definitions or approval? | Status |
|---|---|---|---|---|---|---|
| **A** Direct ledger posting | Critical | `create_ledger_transaction` (SECURITY DEFINER, sets `ledger.authorized` itself, no caller check) was never revoked, so `authenticated` holds EXECUTE through default privileges. This is proven by `COOPartnersPage.tsx`, which called it with the user's session three times. `create_ledger_transaction_accrual_only` was explicitly granted to `authenticated` and forwards arbitrary platform entries | (1) Migration `20261013126000_ledger_direct_execute_boundary.sql`: new `post_portfolio_roi_ledger(op, portfolio, amount, ref, desc_out, desc_in)`. It checks the caller (role coo, super_admin or cto, or an active coo or partner-ops grant); requires the portfolio; bounds the amount by one cycle of Returns; chooses the recipient (the partner, or the active managed proxy agent for Keep-as-Returns); builds the exact legs the page used; posts idempotently; never skips the balance check. EXECUTE on **every** `create_ledger_transaction*` overload is revoked from PUBLIC, anon and authenticated and granted to service_role. **No definition changed.** (2) `COOPartnersPage.tsx`: the three postings call the boundary; every other step is unchanged. (3) `guard-frontend-ledger-writes.mjs` fails the build on any direct `rpc('create_ledger_transaction…')` outside tests | `supabase/tests/ledger_boundary/local`: before the migration the exposure is **reproduced** (authenticated EXECUTE = true); after it, A-01…A-31 pass on PG17 and PG18. They cover direct calls refused for employee, COO, anon and the legacy and accrual overloads; service role and owner-run SQL posters still work; employee, tenant, revoked grant and anon refused at the boundary; COO and partner-ops postings produce the exact legs; managed and non-managed routing; duplicate reference posts once; 8 manipulated-payload refusals; no recipient or entries parameter. `ledgerBoundaryCOO.test.ts` 4/4. Guard negative control: the old page's 3 calls are caught | The live grants and the definitions of the overloads are unread. The fix does not depend on them (it revokes whatever exists and changes no definition). **Deploy the migration and the page together** | **FIXED AND VERIFIED (local)**; production state not verified |
| A2 | High (review) | A heuristic scan found **21 SQL functions** that call the ledger, are not revoked from `authenticated` and show no caller check (for example `credit_recruiter_override`, `post_rent_fee_collection`, `recognise_partner_receivable`, `welile_home_run_landlord_payouts`) | None: shared accounting functions whose production definitions may differ; not fixed on guesswork | Repo scan only | Production definitions and grants (read-only) | **BLOCKED — ACTION REQUIRED** |
| **B** Food payment lifecycle and reversal | Critical | Not implemented; contradictory instructions | None | — | The decision below, plus production `reverse_wallet_transfer` and `wallet_transfer_reversal_status`, plus a verified test project with a production-faithful ledger | **BLOCKED — ACTION REQUIRED** |
| **C** Advance recovery | High | The shield (SQL `20260719161607` and `process-agent-advance-deductions`) treats `wallet_transfer` cash_in as peer transfers; production definition unread | None. Today Food posts **no** ledger rows (INT-02, isolation canaries), so it cannot affect advance recovery | INT-02, isolation 10/10 (PG17, PG18) | Production definition of the shield | **BLOCKED — ACTION REQUIRED** (no current interference) |
| **D** Test environment | High | `nykdsrixasxokqtfvvgw` identity unverified; no connection tooling | Local disposable clusters used and verified: 127.0.0.1:55433 (PG 17.10), :55432 (PG 18.6), databases created and dropped per run; runners refuse non-local hosts and the production reference; `FOOD-M1-FIXTURE` seat guard exercised (R2–R4) | All runs above | Owner's written confirmation | Local: **VERIFIED**; Supabase test project: **BLOCKED** |
| **E** Exception escalation | Medium | The active coordinator could resolve an exception about **their own** order | Migration `20261013127000_food_exception_self_resolution.sql`: refused with 42501; the exception stays open until a different active coordinator resolves it (for example after a handover) | SELF-01…07 (PG17, PG18); RACE-EXC-1…3 (two concurrent resolutions: one wins, the other waits and is refused, one audit row) | **Business decision:** who handles an exception the coordinator cannot (unavailable, or the subject), and within what time. Not invented | Self-resolution: **FIXED AND VERIFIED (local)**; escalation authority: **BLOCKED — ACTION REQUIRED** |
| **F** Integration with latest `lovable` | High | Branch base is 247 commits behind `origin/lovable` (2227e2c034) | The merge **was attempted and denied by the permission system**; not retried. Read-only analysis: only `src/App.tsx` overlaps (clean earlier), no Food, package or MCP changes upstream, no new direct ledger callers. Upstream has edited `COOPartnersPage.tsx` (lines shifted), so the boundary change must be reconciled at merge | — | Permission to merge `origin/lovable` into the feature branch; for `lovable` itself: Lovable agent idle, Josh's go-ahead | **BLOCKED — ACTION REQUIRED** |
| Earlier fixes (PSO, item classification, Shopping Advance, custodial net) | — | — | Unchanged in this pass | PSO-01…18; `foodWalletRegressionFixes` 11/11 | — | **FIXED AND VERIFIED (local)** |

**Decision required for B.** Two owner statements conflict:
- 2026-10-13 (earlier): "Only after the employee confirms delivery does wallet payment become available".
- This brief: "the order becomes eligible for fulfilment only after confirmed payment".

They describe opposite orders: pay after the meal is received, versus pay before the meal is prepared. "Receipt" is used for both a payment receipt and a meal receipt. Food fulfilment is currently **not** gated on payment (D2). Payment is not implemented, so no order can be paid, and Food stays unavailable to employees.


## Blocker-closure pass (2026-10-13, after af745b3ff2)

The evidence for this pass is **local only**: disposable PostgreSQL 17.10 (127.0.0.1:55433) and 18.6 (:55432), plus jsdom. No production object, permission, migration, ledger row or wallet was touched. `nykdsrixasxokqtfvvgw` was **not** used. Nothing was merged or pushed to `lovable`.

Owner decisions applied:
1. The employee confirms delivery first, and payment becomes available only afterwards. The order is marked paid only after independent verification.
2. Another active Food Coordinator handles a complaint after an authorised handover.
3. Prepare the merge but do not perform it.
4. Production stays unchanged.

The earlier "Decision required for B" is resolved by decision 1.

| ID | Item | Change | Evidence (local, PG17 and PG18) | Status |
|---|---|---|---|---|
| **A / PAY-W1** | Wallet payment after receipt confirmation | See "A — payment detail" below | `48_payment.sql` PAYS-01…36; RACE-PAY-0…3; `foodPaymentClient.test.tsx` 5/5; fixture tests 3/3; the earlier PAY-01, REL-D2c, ISO-08 and DRY-08/09/11 now expect the new refusals | **FIXED AND VERIFIED (local)**. Reversal *detection* only (see "Reversal" below). Not applied to production |
| **B** Exception handover | No new migration needed: `20261013127000` plus the existing role model already enforce it. Tests added | SELF-08 employee, SELF-09 anon, SELF-10 backup (inactive) coordinator, SELF-11 new active coordinator after handover, SELF-12 duplicate, SELF-13 blank reason, SELF-14 revoked coordinator; RACE-EXC (concurrent resolution, exactly one wins); PAYS: an open exception blocks payment (unresolved payment exception) | **FIXED AND VERIFIED (local)** |
| **C** Advance recovery | None | Food payments are now `wallet_transfer` cash_in to the coordinator. The advance shield (`20260719161607` plus `process-agent-advance-deductions`) treats those as peer receipts. Whether a coordinator who holds an Agent Advance would have the receipt swept depends on the **production** shield definition, which has not been read | **BLOCKED — ACTION REQUIRED**: a read-only export of the production shield definition |
| **D** Test project | Local disposable clusters only | Runners refuse non-local hosts and the production ref | **BLOCKED — ACTION REQUIRED**: owner's written confirmation that `nykdsrixasxokqtfvvgw` is isolated |
| **E / A2** 21 flagged ledger functions | None (shared, non-Food accounting functions; repo is known to drift from production) | Repo-only review, see "E" below: 9 genuine, 9 limited, 3 not exposed, 1 likely broken (22 signatures: the two `credit_recruiter_override` overloads count separately) | **BLOCKED — ACTION REQUIRED**: production `proacl` read, then an approved permission change |
| **F** Merge preparation | Three Food migrations **renumbered** (see DEP-2). No merge performed | `git merge-tree` against `origin/lovable` `1d01bdee53` (321 commits ahead of the base, 9 ours) | **BLOCKED — ACTION REQUIRED**: permission to merge (see "F") |
| **DEP-2** Migration version collisions (new, found here) | `20261009120000_food_service_schema_and_coordinator` → `…120001`; `20261009130000_food_service_operations_rpcs` → `…130001`; `20261013120000_food_meal_images` → `…120001`. The previous names collided with `lovable`'s Apophia, Emma and CTO-report migrations, which are already applied. Supabase records migrations by version, so the Food file of each pair would have been skipped or rejected. Executable references were updated; `migration_matrix.sh:60-61` keeps the old names because it reads an old commit | Full re-run after the rename: run 244/244, race 14/14, matrix 31/31, isolation 10/10, dry run 15/15 (all PG17 and PG18); R2–R4 16/16 | **FIXED AND VERIFIED (local)** |
| **G** Regression | tsc found two `Record<FoodPaymentStatus,…>` maps missing `payment_reversed`: added the label (`foodService.ts`) and a tone that reuses the `payment_failed` style (`FoodStatusBadges.tsx`; restyling is Gemini's) | tsc 0 errors; guard:all passed; eslint clean on changed files; Food vitest 247 passed / 16 skipped; ledger boundary 31/31; MCP files untouched | **FIXED AND VERIFIED (local)** |

### A — payment detail (`20261013128000_food_payment_after_receipt.sql`)
- `food_confirm_receipt(order)`: only the ordering employee, only once the order is `delivered` or `collected`. Idempotent (`already_confirmed`). It snapshots the active coordinator as `payee_id` and refuses if there is none. Event and audit entry.
- `food_pay_order(order)`: only the ordering employee, and only after receipt is confirmed. Refused while any exception is open, when payee = payer, or when the payee is not staff. Both wallets must already exist (none are created). The server alone decides the amount and recipient: the client sends the order id only. A single ledger transaction with a fixed idempotency key (`food_order_payment:<id>`) posts two `wallet_transfer` legs, payer cash_out and payee cash_in, both withdrawable, both with `source_table='food_orders'`.
- **Independent verification before "paid":** after posting, the general-ledger legs are re-read and checked (count, direction, amount, category, scope, source and reference). On any mismatch the whole transaction aborts (XX000) and nothing is marked paid.
- **Insufficient funds:** `{status:'failed'}`, nothing posted, the order stays `pending_payment`, the attempt is recorded and audited.
- **Retries and races:** a retry returns the same payment (`replayed:true`). Two concurrent sessions produce exactly one posting (RACE-PAY-3: two legs, one transaction).
- Screenshots, client flags and statuses can't count as paid: no client-writable path sets `payment_status`, and the hooks send only the order id. The fixture can never take a payment: every call fails with the `FOOD_CHECKOUT_DISABLED` marker.
- **Reversal:** `food_verify_payment(order)` (employee or active coordinator) re-checks a paid order. If the legs no longer match, or a ledger row with reference `FOODPAY-<ref>-REV…` exists, it sets `payment_reversed`. That status is never treated as paid. **`reverse_wallet_transfer` and `wallet_transfer_reversal_status` exist only in production and were not read or replaced.** The `-REV` suffix is the UI convention (`TransactionDetailDrawer`), so it must be confirmed against the production function before release.
- **Ledger in tests:** `05_ledger_standin.sql` is a local stand-in with the repo semantics of `create_ledger_transaction` (advisory lock, idempotent key, balance check on withdrawable cash_out). The production definition still needs to be confirmed.

### E — classification of the 21 functions (repo evidence only; production grants unverified)
- **Genuine, signed-in (and per repo also anon) callers can move money or fabricate accounting:**
  - `reverse_phantom_auto_debit_obligation` and `reverse_all_phantom_auto_debits`: credit the debtor's withdrawable wallet and void any open obligation;
  - `credit_agent_event_bonus`: bonuses that can be repeated without limit;
  - `credit_recruiter_override` (5-argument): repeatable;
  - `welile_home_record_collection`: debits another user's wallet;
  - `recover_merchandise_from_wallets`: hourly idempotency key;
  - `post_rent_fee_collection` and `post_instalment_waterfall`: the caller chooses amounts and sources;
  - `pay_proxy_commission_queue_item`: skips Partner Ops approval;
  - `welile_home_run_landlord_payouts`: future date, no row lock.
- **Limited:** `ensure_merchant_payout_float_debit`, `merge_paidout_topups`, `pay_partner_self_cycles`, `post_treasury_fee_cash_transfer` (harmful only when chained), `recognise_funding_treasury` (no check that the plan was funded), `recognise_partner_receivable`, `recognise_landlord_receivable`, `settle_tenant_rent_from_deposit`, `try_credit_qualified_referrals`.
- **Not exposed:** `apply_roi_advance_recovery`, `credit_promissory_agent_commission`, `record_merchant_float_delivery`.
- **Likely broken:** the 3-argument `credit_recruiter_override`.
- **Not fixed here, deliberately.** These are non-Food shared accounting functions. The repo is known to drift from production, and the brief forbids production permission changes. A migration file added to this branch would reach production on merge, which counts as a permission change.
- **Proposed next step (needs approval):**
  1. Read `SELECT p.oid::regprocedure, p.proacl FROM pg_proc p WHERE p.proname IN (…)` read-only in production.
  2. For the confirmed functions, a migration that `REVOKE`s EXECUTE from `PUBLIC, anon, authenticated` and grants it to `service_role`.
  3. Where a frontend caller exists, add a role-checked wrapper: `ServiceCentrePayoutApproval.tsx` (bonus), `AgentWelileHomesSheet.tsx` (collection) and `WelileHomesAdminPanel.tsx` (payouts).
- **Separate regression observed (repo only):** the latest `merge_paidout_topups` (`20261002130000`) no longer sets `welile.proxy_commission_merge_in_progress`. The previous version (`20260924120000:227`) set it to prevent a double 1% proxy top-up commission. Production must be checked. **Nothing was posted or corrected.**

### F — merge preparation (read-only `git merge-tree`; no refs or worktree changed)
- `src/App.tsx`, `package.json` and `src/components/coo/COOPartnersPage.tsx` auto-merge. The merged `COOPartnersPage.tsx` keeps all three calls through `post_portfolio_roi_ledger`, and merged `src` has no direct `create_ledger_transaction` call.
- **One textual conflict: `package-lock.json`.** On our side the cause is the two portability commits (`79d9e07dba` pdfjs-dist sync, `716a115a88` public-registry URLs). Our `package.json` adds only the `test:food-db` script. Suggested resolution: take `lovable`'s lockfile, then re-apply only the portability fix if Lovable's install needs it.
- None of the 15 upstream migrations since the base touch ledger grants, Food or `post_portfolio_roi_ledger`. After DEP-2 the merge introduces no duplicate migration versions. Upstream's latest migrations (`20261013201000`, `20261013220000`) sort after ours, so DEP-1 still holds: apply the Food files explicitly and in order.
- **Exact permission needed:** "Merge `origin/lovable` into `release/food-m1-v2` (merge commit, no rebase), resolve `package-lock.json`, rerun the suites, push `release/food-m1-v2`." A later, separate approval is needed (Lovable's agent idle, plus Josh's go-ahead) to fast-forward `lovable`.

### Full-suite classification (jsdom, run during this pass)
- Result: 25 failed files / 50 tests, against the previous 24 / 46.
- The four extra failures are timing failures under machine load (a 5 s timeout, a debounce, a perf budget). They vary between runs, and `AuthSignupName` passes 3/3 when run alone.
- `import_reach.py`: 24 of 25 failing files cannot reach any changed file. The 25th, `SettingsName.test.tsx`, reaches `transactionsFeed.ts` (changed in `9e6ea7a6d1`) and was already in the previous baseline with the same failure.
- None is Food. **No new failures attributable to this branch.**


## Advance-recovery integration (2026-10-13, after fecfd04af9)

**Confirmed business rule (owner, 2026-10-13):**
- Keep the existing Agent Advance recovery exactly as it is.
- A Food Coordinator who is an agent in arrears stays subject to the same recovery rules as any agent.
- No Food-specific exemption, protection or recovery logic.
- No change to advance balances, recovery calculations, repayment logic, wallet behaviour or ledger posting.

Evidence below is from the repo and local disposable databases only (PostgreSQL 17.10 and 18.6). Production was not read or changed.

**How recovery decides what it may take (repo).**
- `process-agent-advance-deductions` and the deployed waterfall paths (`20260927270000`, `20260927280000`) get the recoverable amount from `get_agent_sweepable_withdrawable` (`20260719161607`).
- That function returns the canonical spendable balance minus any `wallet_transfer` cash_in received since the agent's oldest active advance, less later spending.
- A Food payment credits the coordinator as an ordinary `wallet_transfer`. The existing generic rule therefore applies to it exactly as to any peer transfer: protected while unspent, recoverable once that protection is used up. Nothing in it depends on the Food role.
- No advance code references Food, and no Food function references advance objects (ADV-21).

**Bypass found and fixed (Food side only).** `food_pay_order` posted through the ledger without applying three gates that the standard transfer path (`wallet-transfer`) applies:
1. the Wallet Ops controls (`maintenance_mode` / `maintenance_until`, `withdrawals_paused`);
2. the canonical spendable figure `get_user_available_balance`, which subtracts funder holds and, while `advance_withdrawals_paused` is on, the advance-locked amount;
3. the shared recipient eligibility check.

Without gates 1 and 2, an agent could have spent advance-locked money on food during an advance-withdrawal pause.

`food_pay_order` (`20261013128000`) now applies gates 1 and 2 unchanged, before posting:
- A frozen wallet raises 55000, and nothing is posted.
- An insufficient spendable figure returns `failed / insufficient_funds`, and nothing is posted.
- The ledger's own balance check remains the final safeguard.
- No shared function was modified.

| Test | Proves | PG17 | PG18 |
|---|---|---|---|
| ADV-01…05 | Paused withdrawals and maintenance stop a Food payment; an unreadable end time keeps the freeze; nothing posted; payment resumes after the window | pass | pass |
| ADV-06…09 | Funder holds and advance-locked money (while paused) cannot pay for food; the lock does not apply when the pause is off (existing rule) | pass | pass |
| ADV-10, 11 | If the spendable figure reads high, the ledger still refuses; nothing posted | pass | pass |
| ADV-12…16 | Using the **repo** sweep function, loaded verbatim: the coordinator receives the full payment; the receipt is protected only as any peer transfer is; the coordinator's other money stays fully recoverable; a coordinator and an ordinary agent receiving the same transfer are treated identically; once spent, the protection is gone for both | pass | pass |
| ADV-17, 18 | Food never changes advance balances or status, and posts only ordinary `wallet_transfer` legs | pass | pass |
| ADV-19 | A coordinator with no advance: the receipt is ordinary withdrawable money | pass | pass |
| ADV-20 | A payer in arrears: the food payment counts as ordinary spending under the existing rule | pass | pass |
| ADV-21 | No `food_*` function references advance recovery objects | pass | pass |

Full re-run after the change:
- run 265/265, race 14/14, matrix 31/31, isolation 10/10 and dry run 15/15, all on both PG17 and PG18;
- R2–R4 16/16; Food vitest 247 passed; guard:all passed.

**Still requires production confirmation (read-only):**
- C-P1: the production definitions of `get_agent_sweepable_withdrawable`, `get_user_available_balance` and `get_advance_locked_withdrawable`. The repo is known to drift from production, and the tests prove the repo rule only.
- C-P2: `check_transfer_recipient_eligibility` (gate 3), which exists only in production. It checks that the receiver's account is live, not frozen, not deleted and not the sender. Food's own checks cover live staff and not the payer, but not "frozen". It was not guessed or replaced.
- C-P3: any production-only gate inside `create_ledger_transaction` (for example the TID-backed float gate, which lives only in production).

**Status:**
- Integration with existing recovery: **FIXED AND VERIFIED (local, repo definitions)**.
- Production equivalence: **BLOCKED — ACTION REQUIRED** (C-P1…C-P3).


## Recipient eligibility on the Food payment path (2026-10-13, after b5bac8d1d3)

**Defect closed (C-P2).** `food_pay_order` did not apply the recipient gate that `wallet-transfer` applies. It now calls the shared `check_transfer_recipient_eligibility` before anything is posted, exactly as `wallet-transfer` calls it: recipient = the order's payee, item NULL, sender = payer. Named arguments are used, so the call is bound to the contract below. If the function is missing or its signature differs, the payment is refused with nothing posted (ELIG-22). Refusals raise P0002 with the gate's own reason. No shared function was changed, and the function was not re-implemented.

**Contract evidence (repository, not production):**
- `drizzle/migrations/0045_transfer_recipient_eligibility.sql:19-105` defines `check_transfer_recipient_eligibility(p_recipient_id uuid, p_item text DEFAULT NULL, p_sender_id uuid DEFAULT NULL) RETURNS TABLE(eligible boolean, reason text, display_name text, has_wallet boolean)`, SECURITY DEFINER, with EXECUTE granted to `authenticated` and `service_role`. It refuses: not authenticated; a sender other than the caller; self-transfer; no profile; a closed account (`deleted_at`); a frozen account (`is_frozen`); a missing `auth.users` row; and an item outside the Welile list. The earlier searches missed it because they looked only in `supabase/migrations`.
- `src/integrations/supabase/types.ts:63555` (generated from the schema) has the same argument names and result columns.
- `docs/HANDOVER/169-…md:11` (2026-09-30): "live body verified: receiver checks only".
- Fraud blocking: `fraud_block_user_identifiers` (latest body `20260706131556:143`) sets `profiles.is_frozen = TRUE`, so the shared gate refuses a user blocked through the standard tool. An identifier block that did not freeze the profile is **not** part of the standard gate. That is the existing standard behaviour on both paths; no Food-specific rule was added.

**Tests** (`51_recipient_eligibility.sql`, ELIG-01…24; 0045 loaded verbatim):
- ELIG-01, 02: an eligible coordinator is paid; employee debited, coordinator credited, two legs.
- ELIG-03…10: frozen and fraud-blocked coordinators are refused, including on repeat; no legs, no paid event, both wallets unchanged; after unfreezing the order pays exactly once and a repeat is a replay.
- ELIG-11…13: a closed account is refused, and the shared gate agrees.
- ELIG-14…16: self-transfer refused.
- ELIG-17…19: a disabled staff role, or no longer staff: refused.
- ELIG-20, 21: after a handover, a payee who has become ineligible is not paid.
- ELIG-22…24: fail closed without the gate; the call shape is pinned.

**Results:**
- PostgreSQL 17 and 18: run 290/290, race 14/14, matrix 31/31, isolation 10/10, dry run 15/15.
- R2–R4 16/16; ledger boundary 31/31; Food vitest 247 passed; guard:all passed.
- **Negative control:** with the gate removed from a scratch copy, 12 ELIG tests fail.

**Status:**
- Food-side fix: **FIXED AND VERIFIED (local only)**.
- Equivalence with the live function (body, signature, grants, owner): **UNVERIFIED**. This needs Q2 from `food-m1-production-safety-verification-2026-10-13.md`. Local tests do not prove production behaviour.
- PAYEE-1 is unchanged: the payee is the coordinator snapshotted at receipt. The owner must confirm this rule. Eligibility is now re-checked at payment time.


## Reversal handling and production evidence pack (2026-10-13, after a3f41d3cdc)

### Reversal path traced (repository evidence; the live functions are unread)
- The standard sender reversal is `reverse_wallet_transfer(p_reference text)`. Its latest definition is `drizzle/migrations/0451:48`; the status check is `wallet_transfer_reversal_status`, latest `0453:11`. Both are granted to `authenticated`.
- **How it works:**
  - Only the sender can reverse.
  - It is refused once the recipient has a non-rejected withdrawal after the transfer, and refused when the recipient has nothing left.
  - Otherwise it reverses `least(sent, recipient's available)`, so a reversal **can be partial**. There is no time limit.
  - It posts two `wallet_transfer` legs with `reference_id = <ref>||'-REV'` and `idempotency_key = 'reversal:'||<ref>`, `source_table='wallet_transactions'`.
- The statement UI (`TransactionDetailDrawer.tsx:82-86`, `TransactionsFeed.tsx:417-423`) offers **Reverse** on any `wallet_transfer` cash_out row that does not end in `-REV`.
- **Confirmed failure modes before this fix** (local tests run the 0451 and 0453 definitions verbatim):
  1. An employee can reverse their Food payment with the standard feature (REVX-01…03).
  2. The order then still reads `paid` until a Food check runs (REVX-04). Nothing ran a check automatically.
  3. Retrying pay on that order answered "already paid" (REVX-05 fails on the old code).
  4. If any path ever put a reversed order back to unpaid, re-paying with the fixed key would return the **reversed** transaction and mark the order paid **without new money** (REVX-15 fails on the old code).
- **Is the `-REV` convention reliable?** In the repo, yes: it is written by the one standard reversal function, together with the `reversal:` key. Food references use only `[A-Z0-9-]`, so the earlier `LIKE '-REV%'` match could not be fooled. It now matches exactly what the mechanism writes. Whether production has other functions that write `-REV`, and whether the live bodies match, is checked by evidence pack E5.

### Fix (Food only; no shared function changed)
`20261013128000`:
- `food_payment_problem` reads both reversal signals exactly and is used by every check.
- A pay retry on a reversed order marks it `payment_reversed` and returns that status, never "paid".
- After posting, the check also refuses a transaction that has already been reversed.
- New `food_reconcile_payments(p_limit)`:
  - for the active coordinator or `service_role`;
  - **explicit batch cap 1..500 (default 100)**; least-recently-verified orders first; skips locked rows;
  - returns `more_pending`.

Client: the pay result type handles `payment_reversed` and never reports it as paid; `useReconcileFoodPayments` added; the fixture mirrors the caller rule and the cap.

Tests (`52_reversal.sql`, REVX-01…23):
- REVX-09, 10: partial reversal.
- REVX-11: no false positive across orders.
- REVX-12: the coordinator cannot reverse.
- REVX-13, 14: after a withdrawal the order stays paid.
- REVX-17…22: reconcile authorisation, cap and accuracy.
- REVX-23: the internal helpers are not callable by users.
- Two new client tests.
- Negative control: with the previous `food_pay_order`, 5 tests fail.

Results:
- PostgreSQL 17 and 18: run 313/313, race 14/14, matrix 31/31, isolation 10/10, dry run 15/15.
- R2–R4 16/16; ledger boundary 31/31; Food vitest 250 passed.
- tsc 0 errors; eslint clean on changed files; guard:all passed; MCP files untouched.

**Owner decisions required (not made here):**
- **REV-D1.** Should employees be able to reverse a Food payment at all? Today the standard feature allows it until the coordinator withdraws. Blocking it would change the shared reversal function or UI, which is outside Food scope.
- **REV-D2.** What happens to a `payment_reversed` order? It cannot be paid again: the employee owes and the coordinator is out of pocket. Settling it needs a defined process. Re-payment, if wanted, needs a new idempotency key per attempt.
- **REV-D3.** Should `food_reconcile_payments` be scheduled (for example a cron running as `service_role`, with the cap)? Scheduling is a production configuration change.

### Production evidence pack
`supabase/tests/food_m1/production_readonly_evidence.sql`, sections E0–E7:
- **E1:** recipient eligibility.
- **E2:** Food presence and migration versions.
- **E3:** balance, holds, advance lock and recovery.
- **E4:** every ledger overload and trigger, the TID gate, role and database settings.
- **E5:** the reversal functions, plus aggregate counts of how reversal legs are recorded.
- **E6:** the permission impact of `20261013126000` (who can execute; invoker functions that would break).
- **E7:** the deployed edge-function source (not SQL).

How it is safe and what it reads:
- Each query says what it proves and what it cannot prove.
- The session is `default_transaction_read_only`: it was checked locally that writes are refused there, and that every statement parses and runs.
- Catalogue reads plus three aggregate counts only; no personal records.
- **Its output, once an authorised operator supplies it, is the only production evidence. Nothing in this register is production-verified.**
