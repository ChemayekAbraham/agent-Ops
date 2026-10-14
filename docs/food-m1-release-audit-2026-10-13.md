# Food M1 — Release-Readiness Audit

**Date:** 2026-10-13, about 10:30–12:00 EAT. **Auditor:** Claude Code, read-only audit; no fixes were made.
**Scope:** release worktree `C:\Users\USER\welilereceipts-food-m1-release2`. Every result below was re-run during this audit against the current working tree; no earlier run was relied on.
**Status labels:** PASS (direct evidence) · FAIL · UNVERIFIED (evidence missing) · BLOCKED (prerequisite unavailable).

---

## 1. Executive status: **BLOCKED**

The code and the local database evidence are strong. Every automated suite passes on PostgreSQL 17.10 and 18.6. Food M1 still **cannot be accepted for employee use**, for three reasons:
- production schema compatibility has never been checked (no authorised read-only access);
- storage rules have only been tested against a local stand-in, never real Supabase Storage;
- this audit found two new problems in the release worktree itself (A-01, A-04) that must be fixed before anything is committed or released.

## 2. Repository state

| Item | Value |
|---|---|
| Worktree | `C:\Users\USER\welilereceipts-food-m1-release2` |
| Branch | `release/food-m1-v2` (exists locally only; no remote branch of that name) |
| HEAD | `451f2b86be19494985cfc35bdeb7938cce3e813c` (2026-10-13 06:49) |
| Base | `origin/lovable` @ `e1c0264528` (local remote-tracking cache). The live remote `lovable` is now at `d992472c13`, a commit not present locally |
| Commits on base | 7: `879bb7eecc` (Food M1), `79d9e07dba` and `716a115a88` (lockfile), `9c60d23081`, `1d67e48658`, `6053304e0a`, `451f2b86be` |
| Staged | none |
| Stashes | 3 (`preserved-stash` refs, unchanged) |

**Uncommitted, and present (PASS):**
- **UI redesign:** `FoodMealCard.tsx`, `FoodOrderingPage.tsx` (including the purple "My orders" button) and `personalNav.ts` (Food items moved to the end of the sidebar).
- **Meal photos:** migration `20261013120000_food_meal_images.sql`, `FoodMenuPanel.tsx`, `useFoodService.ts`, `foodService.ts`, `foodService.mock.ts`, `45_meal_images.sql`, `foodMealPhoto.test.tsx`, plus changes to the scaffold and the runners.
- **All-day ordering:** `FoodServicePanel.tsx`, `foodService.ts`, the fixture seed and tests.
- **Docs and tests:** `docs/food-m1-risk-closure-register.md`, and `production_readonly_precheck.sql` (storage checks P-6a–d).

**Uncommitted, and must NOT be committed:**
- `supabase/functions/mcp/index.ts` and `mcp-public/index.ts`: see **A-01**.
- `src/components/shared/tests/__snapshots__/PersonNameFields.test.tsx.snap`: line endings only, rewritten by a vitest run; content identical.

**Processes still running:**

| Process | Purpose | Safe to stop? |
|---|---|---|
| Vite preview server, `127.0.0.1:5180`, PID 25284 | Offline UI preview | Yes, whenever you're done with the preview |
| PostgreSQL 17.10, `:55433`, PID 15700 | Disposable local test cluster | Yes; leave it running while testing continues |
| PostgreSQL 18.6, `:55432`, PID 15860 | Disposable local test cluster | Yes; leave it running while testing continues |

No test, build or watcher job is still running. The 11-hour "backup verification" job was a broken wait loop; it has been stopped, and the verification itself had finished in about 4 minutes on 2026-10-12.

**Backup** `C:\Users\USER\food-m1-backups\food-m1-backup_2026-10-12_185739`:
- Untouched: 0 files changed since `MANIFEST.md` was written.
- The original checkout (`dev/employee-food-ordering` @ `8c437912da`) still matches the snapshot exactly: same HEAD, the same 5 modified and 4 untracked files, the same blob hashes.
- **The backup contains none of the 7 release commits and none of the uncommitted release work**; see **A-04**.

## 3. Blocker-closure table

Earlier items come from `food-m1-master-problem-register.md` (worktree `welilereceipts-food-m1`) and `food-m1-risk-closure-register.md`. "Retest" means re-run during this audit.

| ID | Original issue | Required correction | Status | Evidence | Retest result | Remaining risk | Next action |
|---|---|---|---|---|---|---|---|
| FM-01 | Fixture served unless the flag was false | Opt-in, dev-only | **PASS** | `isFoodMockMode()` (`foodService.ts:395`) | Food tests 218/218; bundle scan: 0 `VITE_FOOD_SERVICE_MOCK` | — | — |
| FM-04 | Fixture and demo identities shipped in the bundle | DEV-guarded dynamic import, synthetic ids | **PASS** | bundle scan of `dist/` built today | 0 hits for `foodMockRpc`, `FOOD-M1-FIXTURE`, demo coordinator id, seed profile id, `service_role` | — | — |
| FM-02/03/14/24/33 | Real-mode read defects | Embeds, `mineOnly`, names, cache reset, no-retry gates | **PASS** | `foodRealModeReads.test.tsx` | in 218/218 | — | — |
| FM-05 / D1 | No payment method | Recorded only: cash / wallet / mobile_money | **PASS** | REL-D1a–g, PM-01, DRY-01…07 | run.sh 156/156 and dry run 15/15 (PG17, PG18) | — | — |
| FM-06 / D2 | Unpaid orders could not be prepared | Transitions independent of payment | **PASS** | `food_set_fulfilment` (`20261012120000:366`) | REL-D2a–d, DRY-10/11 pass | — | — |
| FM-07/09/10/11/12/13 | Overview, closure, archived meal, bounds, probe, `search_path` | As registered | **PASS** | run.sh REL-* | 156/156; schema scan: 0 definer functions without `pg_temp` | — | — |
| FM-15 / FM-26f | Any account could order | Staff or coordinator only | **PASS** | ACC-01…09, CAN-USE-01…03 | pass | Real production `user_roles` population unknown | Run precheck P-2 |
| FM-17 | Seed by hard-coded profile id | Conditional seed and bootstrap | **PASS** | MIG-A1–A5, BOOT-01…07 | matrix 23/23 | Who the first coordinator is remains a decision | P-4 / CFO |
| FM-21 / A / FM-37 | No way to raise exceptions; 9 kinds | `food_raise_exception`, 9 kinds | **PASS** | EXR-01…21, KIND-01…08 | pass | — | — |
| Exception resolution | Must be active coordinator only, reason required, audited | `food_resolve_exception` | **PASS** | EXC-01 (blank reason refused), EXC-03 and EXR-10 (employee refused), EXR-18, audit EXR-21 | pass | — | — |
| FM-23 / G4 | Temp table in a definer function; concurrency | Local arrays; locks | **PASS** | races, R2–R4 | races 7/7 (PG17, PG18); R2–R4 16/16 (PG17, this audit) | R2–R4 not re-run on PG18 in this audit | Optional |
| FM-34 / G2 | Harness could target production | Host guard | **PASS** | `foodDbHostGuard.test.ts`; runners refuse non-local hosts and the production ref | pass; every run in this audit used 127.0.0.1 | — | — |
| ISO / G1 | Non-Food isolation, money untouched | Canaries, fingerprint | **PASS** | `isolation_check.sh` | 10/10 (PG17, PG18): 107 non-Food objects identical; positive control counts a real ledger write | — | — |
| G3 | Migration paths | Matrix | **PASS** | `migration_matrix.sh` | 23/23 (PG17, PG18) | — | — |
| **B / FM-28** | Production compatibility never checked | Run `production_readonly_precheck.sql` (P-1…P-6) read-only | **BLOCKED** | No authorised production read access in this session | not run | Missing column, role population or name collisions would fail the migration | Authorised person runs the precheck and records the output |
| **C** | Compatibility with the latest `lovable` | Re-merge and retest | **UNVERIFIED** | Register §C is still the placeholder "_Filled in from the trial-merge run below_"; remote `lovable` has moved to `d992472c13` since | not run (a fetch would change Git tracking state) | Conflicts or regressions from 40+ upstream commits | With approval: fetch, trial-merge in a throwaway worktree, re-run all suites |
| D / FM-27 | Generated types lack Food | Regenerate after migrations | **Open by design** | `guard-schema-types` passes | pass | — | Release step |
| E5 | Visual and responsive pass | Gemini | **UNVERIFIED** | Redesign done in this session; phone-width check not performed | — | Layout at 360–414 px | Gemini, or a resize check in the preview |
| FM-16, FM-22 | Idempotency key per cart; cart gating | Done | **PASS (no dedicated auto test)** | Server refuses regardless (ORD-*, DRY-07) | — | — | — |
| FM-29 | Build regenerates the MCP functions | Always `git restore` after a local build | **FAIL (regressed)** | see **A-01** | — | — | see A-01 |
| SEC-01b | Personal data in older Food commits | Release as a squashed commit | **PASS for the release diff** | release diff scan (earlier); `dist` scan clean today | — | Older history is a separate workstream | — |
| **A-01 (new)** | `supabase/functions/mcp/index.ts` and `mcp-public/index.ts` truncated (2,212 lines removed) at 2026-10-13 08:50:18 by a local `vite build` (`@lovable.dev/mcp-js` plugin). The stubs import `npm:C:\Users\USER\...` | Restore both files from HEAD; never commit them; add an MCP guard | **FAIL** | `git diff --stat`; file mtime matches the meal-photo build; stub content | Committing either file would break both MCP edge functions on deploy. **No guard catches it**: no MCP guard exists on this branch, and `guard:all` passes | High if committed | With approval: `git restore supabase/functions/mcp/index.ts supabase/functions/mcp-public/index.ts`; consider a guard that fails when either file contains a local path |
| **A-02 (new)** | `food_no_hard_delete()` is EXECUTE-able by `anon` | REVOKE for least privilege | **Low / informational** | schema scan | Non-definer trigger function; PostgreSQL refuses direct calls to trigger functions | None practical | Optional REVOKE in a future migration |
| **A-03 (new)** | The R2–R4 harness refuses the default scaffold (the stand-in seed coordinator holds the seat) and needs `FOOD_DB_SESSION_MODE=confirmed` | Document the procedure | **Low (procedure)** | This audit: first two runs refused safely, third passed 16/16 | pass after deleting the stand-in seed profile **before** the migrations (the matrix's covered "no seed profile" path) | Next tester repeats the confusion | Add the steps to the test README |
| **A-04 (new)** | The release candidate (7 commits) and all uncommitted release work exist only in this one local worktree: not pushed, not in the backup | New backup of the release worktree (mirror plus working-files copy) | **FAIL (data-loss risk)** | `git cat-file -e` on the backup mirror: all 7 commits absent; backup dated 2026-10-12 18:57 | — | Disk loss or a mistaken clean loses about a day's work | With approval: take a second backup to a new folder (the existing backup stays untouched) |
| **A-05 (new)** | Meal photos are **publicly** readable by URL, not limited to employees | Confirm or restrict | **Decision needed** | bucket `public = true` (PH-01) | — | Anyone with a photo URL can view it; photos carry no personal data unless people appear in them | CFO: accept public read, or switch to signed URLs |
| **A-06 (new)** | Storage policies were tested against a local stand-in, not real Supabase Storage | Test on the approved isolated project | **BLOCKED** | `00_supabase_scaffold.sql` stand-in | PH-01…18 pass locally | Real `storage.objects` columns and policy evaluation may differ | Needs a confirmed test project (see §6) |
| A-07 (new) | Register D4 still lists the old 5 lowercase exception kinds | Update the doc | **Low (doc)** | `food-m1-master-problem-register.md` §1 | Code and tests carry the 9 kinds | Reader confusion | Doc edit |

Missing evidence: the master register's §3 is the only full blocker inventory. Items before FM-01 (if any) are not recorded anywhere I could find.

## 4. Test results (all run during this audit, against the current working tree)

| Test | Target | Result | Exit |
|---|---|---|---|
| Food client tests (9 files) | jsdom + fixture | **218 passed, 16 skipped** (the skipped 16 are R2–R4, which need a database; run below) | 0 |
| R2–R4 database integration (`test:food-db`) | Disposable PG17 database `food_rint_audit`, dropped afterwards | **16/16** | 0 |
| Behaviour (`run.sh`) | Local PG17.10 / PG18.6 | **156/156 · 156/156** | 0 · 0 |
| Races (`race.sh`) | PG17 / PG18 | **7/7 · 7/7** | 0 · 0 |
| Migration matrix | PG17 / PG18 | **23/23 · 23/23** | 0 · 0 |
| Isolation + canaries | PG17 / PG18 | **10/10 · 10/10** | 0 · 0 |
| Payment dry run | PG17 / PG18 | **15/15 · 15/15** | 0 · 0 |
| Payment negative control (planted wallet debit) | PG17 | DRY-13 and DRY-14 **FAIL as intended** (detected `wallet_transactions:INSERT`) | — |
| TypeScript `tsc -p tsconfig.app.json` | — | **0 errors** | 0 |
| ESLint (all changed and new `src` files) | — | **0 problems** | 0 |
| Production build (`vite build`) | — | **built** in 4m 6s | 0 |
| Guards (`guard:all`) | — | **all passed** | 0 |
| Bundle leak scan | `dist/` | 0 fixture, mock, test-identity, seed-profile or `service_role` hits | — |
| Schema inventory | Disposable PG17 | see §6 | — |
| Whole-project vitest | — | **Not re-run in this audit.** Last run (08:31) had 48 non-Food failures, matching the registered pre-existing set by file | UNVERIFIED for the current tree |
| Production precheck | Production | **BLOCKED** | — |

## 5. Payment status

- **Method recording: PASS.**
  - Cash, Welile wallet and Mobile money are each stored on the order and returned to the caller.
  - "card", a missing method and "Wallet" are refused (22023).
  - A repeat submission keeps the original method (DRY-07, REL-D1g).
  - The coordinator overview reports the mix of methods.
  - The screens require a choice, pre-select none, and show "Not paid yet · Pays by …".
- **Actual payment collection: NOT IMPLEMENTED, by decision (D1/D2).**
  - No wallet debit, ledger posting, requisition write or Mobile Money collection exists or happened.
  - `food_pay_order` raises `0A000` for the employee and the coordinator, before and after delivery.
  - Every order stays `pending_payment` with `paid_at` NULL and `transaction_group_id` NULL.
  - There is no "payment confirmed" state. Building one needs an approved payment design.
- **Isolation evidence: PASS.**
  - Canary tables planted before the migrations recorded zero writes, and totals were unchanged.
  - The negative control proves the canaries detect a write.
  - The dry run is wrapped in BEGIN … ROLLBACK, and DRY-15 confirms nothing remained.
  - Each disposable database is dropped by the runner's exit trap.
- **Payment gate:** under D2 there deliberately is none. Unpaid orders are prepared and delivered, and payment follows delivery. This is the approved behaviour, not a bypass.

## 6. Database and authorisation status

**M1-only schema (20261009120000 alone, disposable PG17): PASS. Every expected count matches.**

| Expected | Actual |
|---|---|
| 11 tables | 11 |
| 97 columns | 97 |
| 20 CHECK constraints | 20 |
| 20 foreign keys | 20 |
| … of which to profiles | 11 |
| … of which internal | 9 |
| … of which CASCADE | 1 (`food_order_items → food_orders`) |
| 25 indexes | 25 |
| 16 policies | 16 |
| 4 triggers | 4 |
| 3 functions | 3 (`food_no_hard_delete`, `is_food_coordinator`, `is_active_food_coordinator`) |

**Full chain (all 6 Food migrations): every difference from M1 traces to an approved change.**

| Object | Full chain | Added after M1 by |
|---|---|---|
| Columns | 101 (+4) | `food_orders.payment_mode` (D1); `food_exceptions.raised_by`, `raised_via` (D4/FM-21); `resolution_reason` (exception resolution) |
| CHECK constraints | 24 (+4) | `payment_mode_known`, `payment_mode_required`, `kind_known`, `raised_via_known` |
| Foreign keys | 21 (+1) | `food_exceptions.raised_by → profiles` |
| Indexes | 27 (+2) | `one_open_employee_report`, `open_idx` |
| Policies | 17 (+1) | `food_exc_read_own` |
| Triggers | 5 (+1) | `food_exceptions_no_delete` |
| Functions | 30 (+27) | the Food RPCs |
| Storage policies | 2 | `food_meal_images_insert` and `_select`; no UPDATE or DELETE policy |

Nothing was removed after M1.

**Authorisation:**

| Check | Status | Evidence |
|---|---|---|
| RLS on all 11 Food tables | **PASS** | schema scan |
| No table grants to `anon`; no INSERT/UPDATE/DELETE grants to `authenticated` | **PASS** | schema scan |
| Every definer function sets `search_path … pg_temp` | **PASS** | schema scan |
| 5 internal functions are `service_role`-only | **PASS** | including `food_bootstrap_coordinator` and `food_audit_write` |
| Staff lookup uses the restricted `food_coordinator_candidates()` (active coordinator only), not `cc_forward_staff_options` | **PASS** | migration text; COO-06; `useFoodService.ts:835`. `cc_forward_staff_options` appears in Food code only in a comment explaining why it wasn't reused |
| Ordering limits and concurrency | **PASS** | ORD-*, D3 tests, races 7/7, R2–R4 16/16 |
| Exception resolution | **PASS** | active coordinator only, reason required, single resolution, audited (EXC-01…03, EXR-10/18/21) |
| Isolation from non-Food objects | **PASS locally** | ISO-01/09 |

**Test project `nykdsrixasxokqtfvvgw`: BLOCKED.**
- No document, test configuration or memory record designates it as a Food test project.
- The only recorded sandbox is a different one: Lovable project `73ddf668…`, built for Agent Advance.
- This session has no Supabase or Lovable connection.
- The project was not contacted.

## 7. UI and meal-photo status

| Item | Status | Evidence |
|---|---|---|
| Meal cards: photo or fallback icon (also on image load error) | **PASS** | `FoodMealCard.tsx:33,66,70` |
| Add/Edit meal: choose, preview, change, remove | **PASS** | 6 UI tests; preview checked |
| JPEG/PNG/WebP, 2 MB limit, empty file | **PASS** | client `foodMealImageProblem` tests; bucket limits PH-01; UI refusal test |
| Upload failure → nothing attached; meal kept; no duplicate on retry | **PASS** | `foodMealPhoto.test.tsx` "does not attach anything when the upload fails"; dialog keeps the meal id |
| Orphaned files (upload succeeded, attach failed) | **Open (accepted risk, no cleanup)** | by design; files are immutable |
| Narrow upload, no update/delete; employee, anonymous and backup coordinator refused; another bucket unaffected | **PASS locally** | PH-02…10 |
| Same, on real Supabase Storage | **BLOCKED** | A-06 |
| Employee read access | **PASS, but broader than employees** | A-05 |
| Checkout: method required, none pre-selected, button disabled | **PASS** | UI tests; preview |
| Order history and payment display | **PASS** | FM-25 tests; preview |
| Coordinator monitoring and exceptions | **PASS** | queue, overview and exception UI tests |
| All-day ordering | **PASS** | 5 UI/fixture tests and 2 lib tests; preview |
| Other employee pages and routes unaffected | **PASS (nav order changed only)** | `personalNav.ts` moves Food to the end; `guard:persona-routes` passes; non-Food pages render in the preview |
| Phone-width layout | **UNVERIFIED** | E5 |

## 8. Production safety

| Claim | Status | Basis |
|---|---|---|
| No Food branch pushed | **PASS** | `git ls-remote --heads origin`: no `food` or `release` branch; no remote head equals any release commit |
| Food not merged into remote `lovable` | **UNVERIFIED** | Remote tip `d992472c13` is not available locally; inspecting it needs a fetch, which was not done |
| No production migration, write, ledger posting or money movement during this audit | **PASS for this audit** | Every database action targeted 127.0.0.1 (PG17 `:55433`, PG18 `:55432`) through guarded runners that refuse the production ref; no Supabase or Lovable tool exists in this session |
| Same for earlier sessions | **UNVERIFIED independently** | Registers say no; nothing here can prove the absence of production activity without production read access |
| Production never selected as a test target | **PASS (this audit)** | host guards; `config.toml` names the production ref but nothing reads it for tests |
| Verified backup untouched | **PASS** | 0 files newer than `MANIFEST.md` |
| Original checkout unchanged | **PASS** | matches the snapshot exactly |

## 9. Remaining actions (most severe first)

| # | Severity | Action | Owner and authorisation |
|---|---|---|---|
| 1 | **High** | **A-04:** take a new backup of the release worktree (repo mirror plus working-files copy) to a new folder, leaving the existing backup untouched | Needs your go-ahead |
| 2 | **High** | **A-01:** `git restore` the two MCP files, then confirm `git status` no longer lists them. Optionally add a guard that fails when either file references a local path | Needs your go-ahead; the guard is a code change |
| 3 | **High** | **B:** run `supabase/tests/food_m1/production_readonly_precheck.sql` (READ ONLY, aggregates only, P-1…P-6) on production and record the output | Authorised person with production read access |
| 4 | **High** | **A-06:** confirm which project is the approved isolated Food test project (`nykdsrixasxokqtfvvgw`?), then apply the migrations there and repeat PH-01…18 on real Storage | Your confirmation of the project, plus access |
| 5 | **Medium** | **C:** fetch, trial-merge the latest `origin/lovable` in a throwaway worktree, re-run every suite, and fill in register §C | Fetch needs approval (changes remote-tracking refs) |
| 6 | **Medium** | **Commit the uncommitted Food work** on `release/food-m1-v2`, **excluding** the MCP files and the `.snap` line-ending change | Your instruction to commit |
| 7 | **Medium** | **Decisions:** public photo read (A-05); first coordinator (P-4); the "+" stepper; whether a backup coordinator sees Food Management | CFO |
| 8 | Medium | **E5:** phone-width visual check (Gemini, or a resize in the preview) | Gemini / UI |
| 9 | Low | Re-run the whole-project vitest on the final tree and confirm the failures are still exactly the pre-existing set | After item 6 |
| 10 | Low | A-03 test README; A-07 doc fix; A-02 optional REVOKE | Doc / minor change |
| 11 | Release | Apply the migrations, regenerate types (FM-27), merge to `lovable` only while Lovable's agent is idle and with your go-ahead, then run post-deploy smoke tests | Release approval |

## 10. Acceptance decision

**Food M1 is NOT ready for employee use.**
- The application logic, payment-method recording, isolation from money paths, authorisation and the meal-photo feature all **pass** on disposable local PostgreSQL 17 and 18, and the code type-checks, lints, builds and passes its guards.
- Production schema compatibility is **BLOCKED** (no read-only access), and Supabase Storage behaviour is **BLOCKED** (no confirmed test project).
- The release worktree has two new **FAIL** items (A-01 truncated MCP files; A-04 work not backed up).
- No real payment collection exists. Orders are recorded unpaid, as decided in D1/D2.

Food M1 must remain unavailable to employees until items 1–6 are closed and re-verified.
