# Partner Returns 10%: Phase 5 UI tasks for Gemini

Worktree `welile-commission-8pct`, branch `dev/partner-returns-10pct`. Nothing is committed yet.
Line numbers were checked against the working tree on 7 Nov 2026.

**What this is.** Claude has wired the data lines for the Phase 5 screens: hooks, state, handlers and request bodies. What is left is mostly presentation (JSX, copy, layout), which is Gemini's work. A few data items are still open, and they are marked **Claude, open**.

**Rules for every item**
- Presentation only. The hooks and helpers in "Data you can use" already exist. Wire them; do not compute rates yourself.
- Words: Rent Plan, Supporter or partner, Returns. Never loan, lender, ROI or interest in anything a user sees.
- Any rate or Returns figure can be `null`. Show no number for it: "—", or a sentence without a figure.
- Never write `?? 15`, `|| 15`, `* 0.15`, `|| 10`, and never use the public rate as a person's own rate.
- `formatUGX(null)` prints **UGX 0**. Never pass it a figure that can be null; use `formatUGXOrDash`.
- **Switch-off parity:** while the CEO has never turned the switch on, the hooks return today's values (15, or the stored rates). Every screen must then look exactly as it does today, apart from the copy changes listed here. When you replace a fixed "15%" with `formatRatePct(rate)`, that is what keeps parity.

---

## Ordered checklist

### A. Before the Phase 4 merge into `lovable`
1. **Claude, open (release order).** Apply the Phase 1–2 migrations and deploy `create-portfolio-invite`, `import-partners`, `submit-partner-form` and `agent-invest-for-partner` *before* this frontend merges. Then check that `get_partner_return_policy` answers `enabled=false`.
   Without that, every policy read fails and the screens break:
   - Staff create forms and partner edits refuse an unedited rate with "The Returns rate could not be checked" (O2). A typed rate still reaches the deployed `create-portfolio-invite`, which does not know `policy_enabled_seen`.
   - Edited renewals call an RPC that does not exist yet.
   - Previews show UGX 0.
2. **Claude, DONE (O2).** Staff create forms refuse to submit when the form's own policy read *failed* and the rate field was not edited. The toast says "The Returns rate could not be checked. Reload the page." The partner edits on `COOPartnersPage` and `ActivePartnersDetail` carry the same guard.
3. **Gemini, item 1.** ActivatePartner rate card, success card and error messages.
4. **Gemini, item 2.** Staff portfolio forms: labels, `PartnerRateCfoNote`, the toasts that say a rate awaits the CFO, and null-safe previews.
5. **Gemini, item 6 (NexaSalesHub only).** The labels at `NexaSalesHub.tsx:25` and `:33` must change **in the same merge** as Claude's data line. The figures already follow the public rate, which is 15 while the switch is off, but the labels still say 10%.

### B. Before migration 4b (the masks) ships
6. **Gemini, item 4.** Agent partner cards: show "—" for a null rate or Returns figure.
7. **Gemini, item 5.** InvestorPortfolioPublic: hide the rate and the expected Returns when the rate is null.
8. **Gemini, items 11a and 11b.** Trust and vouch screens, and the wallet hub: null-safe display. This turns the 4b readiness scan green.
9. **Owner decisions, open.**
   - (a) Should lenders see the vouch limit as null, or as a Returns-free limit? This decides `LenderRecordLoanCard.recordLoan`.
   - (b) Should `welile_trust_score_cache.borrowing_limit_ugx` be masked? This decides `BorrowerProfileSheet.tsx:92`, `LendingAgentPortal.tsx:564` and `BorrowerVouchBadge.tsx:59`.

### C. Before release (before `release_ready` is set)
10. **Gemini:** item 3 (agent screens), item 6 (rest of Nexa), item 7 (import template), item 9 (share-sheet leftovers), item 10 (signed-in partner copy), item 12 (CFO card and queue), item 14 (rent-facilitation reward copy) and item 15 (registration page).
11. **Gemini, item 17.** Claude's data side is done (no importer of the deprecated helpers remains). The copy and null display in those files are left.
12. **Parked agreement work** (not Gemini): the agreements still state 15%. See release scan §8.5 #2.
13. Run all three release gates (next section). All must be green.
14. **Optional:** item 16 (resend-invite toast, 360-day captions).

---

## Release gates

| Command | State on 7 Nov | Turns green when |
|---|---|---|
| `PARTNER_RATE_RELEASE_GATE=1 npx vitest run src/test/partnerRateRelease.test.ts` | 6 failed, 4 passed (1 opt-in placeholder skipped) | Items 1, 3, 6, 10, 14 and 15 are done (details below) |
| `PARTNER_RATE_RELEASE_GATE=1 npx vitest run src/test/partnerReturnsMaskedFigureUse.test.ts` | 1 failed: it lists 22 lines | Items 11a and 11b are done, plus owner decision (b) for `BorrowerProfileSheet.tsx:92`. Must be green **before 4b**. |
| `deno test --allow-read supabase/functions/_shared/releaseScan_test.ts` | 1 failed, 1 passed | §8.5 #2: parked agreement work. (§8.5 #3 is green since the item 17 data change.) |

Checks inside `partnerRateRelease.test.ts`:

| Check | State | What clears it |
|---|---|---|
| Signed-in partner screens quote their own rate | green | Done by Claude |
| Signed-in partner components do not use the public rate for their own projections | green | Done by Claude |
| Share sheets use the description the database composed | green | Done |
| Signed-in partner screens state no fixed rate | red, 13 lines | Items 10 and 14 (copy) |
| No importer of the deprecated hard-coded-15% helpers | green | Done by Claude (item 17 data side) |
| Agent screens show no per-partner rate, fixed 15% or "ROI" | red | Item 3 (`AgentInvestForPartnerDialog.tsx:299`, `:578`, `:636`) |
| Agent and public screens state no fixed 15% (`AGENT_PUBLIC_FILES`, Phase 6 audit) | red, 35 lines, all copy | Item 3b. The data lines are done; `src/test/phase6_agent_public_rate.test.ts` (always on, green) keeps them that way. |
| Nexa components state no fixed rate | red, 9 lines | Item 6 |
| The promissory-note activation page shows the stored rate | red, 3 lines | Item 1 |
| The public partner registration page quotes the live public rate | red, 1 line | Item 15 (`RegisterPartnerPublic.tsx:315`) |

Other checks:
- `npx vitest run src/test/phase5_` passes: 10 files, 135 tests (including `phase5_open_staff_policy_unknown.test.tsx` and `phase5_open_item17_withdraw_policycard.test.tsx` for O2, O3, O5 and O7).
- `npx tsc --noEmit -p tsconfig.app.json` reports only the 4 known errors in `AgentWelileMedicine.tsx`.
- `npm run guard:all` fails only on `guard:assistant-readonly`, with 12 violations from the agent-assistant partner tools. That failure is not from this work.
- The header of `partnerReturnsMaskedFigureUse.test.ts` still points to the old task list. This document replaces it.

---

## Data you can use (Claude-built)

| Need | Use |
|---|---|
| The public new-partner rate: logged-out pages, share text, agent screens, Nexa | `usePartnerReturnPolicy()` returns `{ newContractRate, enabled, policy, cutoffAt, isLoading, fromNetwork }` (`@/hooks/usePartnerReturnPolicy`). `newContractRate` and `enabled` are `null` while unknown. |
| A signed-in partner's own rate for their next portfolio, deployment, house support, calculator or rent reward | `useOwnNewPortfolioRate()` returns `{ rate: number \| null, isLoading }` (`@/hooks/usePartnerQuoteRate`). Never fall back to `newContractRate`. |
| A named partner's rate on a staff form | `usePartnerQuoteRate('partner', partnerId)` |
| The staff rate field | `useStaffPortfolioRate(partnerId, switchOffPrefill)` (`@/hooks/useStaffPortfolioRate`) returns `{ value, setValue, edited, reset, requestFields, refetchPolicy, personRate, policyEnabled, switchOffSeen, isLoading }`. Also `isPolicyChangedError` and `POLICY_CHANGED_MESSAGE` (`@/lib/staffPortfolioRate`). Already wired in every staff form. |
| Whether a staff form may submit | `staffRateSubmitBlock(rate)` (`@/lib/staffPortfolioRate`) returns `POLICY_LOADING_MESSAGE`, `POLICY_UNKNOWN_MESSAGE` or `null`. To disable the submit button, use `staffRateSubmitBlock(rate) !== null`. |
| Rate helpers | From `@/lib/partnerReturnPolicy`: `formatRatePct(rate)` returns `"10%"` or `null`; `monthlyReturnFor(amount, rate)` returns a number or `null`; `rateOrNull(v)`; `rateAwaitsCfo(typed, stored)` |
| "Awaits CFO" note on staff forms | `src/components/shared/PartnerRateCfoNote.tsx`, props `policyEnabled`, `personRate`, `typedRate`, `currentRate?`. **It is not mounted anywhere yet.** |
| Funder earnings at a rate | `calcFunderEarningsAt(rent, startDate, rate)` and `sumFunderEarningsAt(rents, startDate, rate)` (`@/lib/funderEarnings`). The figures are `null` without a rate. |
| Support-plan example at a rate | `supportExampleStepsAt(rate)`, `buildSupportPlanExampleLineAt(amount, rate)`, `exampleMonthlyReturnAt(amount, rate)` (`@/lib/supportPlanExample`). `formatFixedUGX` takes a number only. |
| Plan share text | `link.description ?? planShareFallbackDescription(plan)` (`@/lib/planShareLink`) |
| House share text | `houseShareMessageFor(house, url, link.description)`. For a figure on a screen, use `houseMonthlyReturnAt(rent, rate)` (`@/lib/houseSupportShare`). |
| Nexa sales engine | `calculateSupporterSalesProjection(amount, startDate, rate)`, `buildNexaOfflineSalesReply(input, isAuthenticated, rate)`, `buildNexaSalesContextPrompt(text, rate)`, `buildPromissoryNoteReminderReply(rate)` (`@/lib/nexaSalesEngine`). Without a rate they give `null` figures or no number. |
| Rent-facilitation reward | `calculateSupporterRewardAt(rent, rate)` and `sumSupporterRewardsAt(rents, rate)` (`@/lib/rentCalculations`). `null` without a rate. |
| A money figure that may be unknown | `formatUGXOrDash(amount)` (`@/lib/rentCalculations`) returns "—" for null, undefined or NaN |
| Vouch figures in share text or a PDF | `shownVouchLimit(profile)` and `shownTrustScore(profile)` (`@/lib/shareTrustProfile`) |
| Whether a vouched loan can be recorded | `recordVouchFigures(profile.trust).ok` (`@/lib/vouch/recordVouchFigures`) |

**Deprecated helpers.** These are hard-coded at 15%, and the release gate fails while any of them has an importer: `FUNDER_MONTHLY_RATE`, `calcFunderEarnings`, `sumFunderEarnings`, `SHARE_ROI_RATE`, `planShareDescription`, `HOUSE_SHARE_ROI_RATE`, `houseMonthlyReturn`, `houseShareMessage`, `EXAMPLE_MONTHLY_RATE`, `EXAMPLE_MONTHLY_RETURN`, `EXAMPLE_TWELVE_MONTH_TOTAL`, `SUPPORT_EXAMPLE_STEPS`, `exampleMonthlyReturn`, `buildSupportPlanExampleLine` and `calculateSupporterReward`. No import remains (test files excepted); keep it that way.

---

## Claude data lines: status

**DONE.** All of these are wired in the working tree; the phase5 tests and the code review cover them.
- **Staff forms (item 2).**
  - `useStaffPortfolioRate` drives the prefill in `COOPartnersPage`, `NewPartnersPanel`, `CreateInvestmentAccountDialog` and `InvitePartnerPortfolioDialog`. The switch-off prefill is 20 in the first three and 15 in the invite dialog.
  - The rate is sent only when the switch is seen off or staff edited the field. `policy_enabled_seen` is always sent.
  - A 409 POLICY_CHANGED shows `POLICY_CHANGED_MESSAGE` and refetches the policy.
  - Submit is refused while the form's own policy read is still loading.
- **`PartnerImportDialog`.** A blank rate is parsed as `null`. "Returns %" is accepted as a header. The request carries `policy_enabled_seen`, and a 409 is handled.
- **`RenewPortfolioDialog`.**
  - The prefill is the stored rate.
  - With the switch off, the renewal writes `roi_percentage` as today.
  - Otherwise it calls `set_portfolio_renewal_rate`, only when the rate was edited. The locals `rateInForce` and `rateAwaitsCfo` are then available before the toast.
- **`ActivePartnersDetail`.** Rate pushes and the orphan-repair insert send `roi_percentage` only when the switch is seen off or the rate was edited. They read the stored rate back (`createdRoi`), and the bulk updates return `roi_percentage`.
- **COOPartnersPage bulk and portfolio edits.** They follow the same rule. `storedRoi` is read back (`:1658`).
- `AgentPartnerDashboardSheet.tsx:89` uses `rateOrNull`.
- `FunderDetailView.tsx:130-131` keeps a null rate and a null Returns earned. Its stats type allows a null `totalROI`.
- `FunderManagementSheet.tsx:121` sets `totalROI` to null when any portfolio's figure is null.
- `InvestorPortfolioPublic.tsx:74` uses `monthlyReturnFor(amount, rateOrNull(roi_percentage))`.
- `AgentInvestForPartnerDialog.tsx:60-61` computes the preview from `newContractRate`. At `:261`, `monthly_reward` stays null when the server leaves it out.
- `NexaSalesHub.tsx:19-20` and `:37` pass the public rate.
- `RegisterPartnerPublic.tsx`: `ROI_RATE` is removed. The preview is `monthlyReturnFor(amount, newContractRate)` (`:102`), and after submit the figure is `monthly_roi` from the server (`:162-163`).
- **Item 10.** All nine signed-in partner screens read `useOwnNewPortfolioRate()`.
- **Item 9.** The share sheets use `link.description`. `SupportHouse` uses `newContractRate`.
- **Item 14.**
  - `PayLandlordDialog.tsx:58-59`.
  - `RentCategoryFeed.tsx`: rents are cached, the cache key is bumped to `welile_rent_categories_v2`, and the reward is priced at render (`:610-615`).
  - `MyWatchlist.tsx:69`, `:301`, `:568` and `:630` use the own rate.
- **Item 11a data lines** keep null:
  - `AgentVouchHighlightCard.tsx:42-44`
  - `AgentTenantHealthCard.tsx:27`
  - `BorrowerTrustScorePanel.tsx:14-18`
  - `BorrowerProfileSheet.tsx:89-90` (score)
  - `VouchAuditLog.tsx:23` and `:27`
  - `LenderRecordLoanCard.recordLoan` (`:133`) fails closed through `recordVouchFigures`.
- **Item 11b.** `FunderWalletHubSection.tsx:128` and `:142` pass null through. They pass 0 only while the hub has not loaded.
- **O2. Staff forms when the policy read failed.** One helper, `staffRateSubmitBlock` (`src/lib/staffPortfolioRate.ts`), refuses while the read is loading, and refuses an unedited rate when the switch state is unknown.
  - Create handlers: `COOPartnersPage.tsx:1525`, `NewPartnersPanel.tsx:2896`, `CreateInvestmentAccountDialog.tsx:264`, `InvitePartnerPortfolioDialog.tsx:52`.
  - Partner edits (rate push and orphan-portfolio insert): `COOPartnersPage.tsx:2002` and `ActivePartnersDetail.tsx:290`. They run before anything is written, also for a name, phone or payout-day change.
  - A typed rate may still go: the server answers 409 POLICY_CHANGED unless the switch is off.
- **O3. Item 17 data side.**
  - `SupportPlanExample` takes a `rate` prop and uses `supportExampleStepsAt` and `buildSupportPlanExampleLineAt`. `SupportPlanPublic.tsx:192` passes `newContractRate` (public page). `FunderNewSelectionPanel.tsx:605` passes `useOwnNewPortfolioRate()` (signed-in).
  - `FunderDirectHouseListing` uses `calcFunderEarningsAt` and `sumFunderEarningsAt` with the own rate. Without a rate, the earnings filters and sorts do not apply.
  - `FunderEarningsAssumptions` takes a `rate` prop. `FunderEarningsBreakdown` takes `FunderEarningsAt`, and its rows show "—" for null figures.
  - The `FunderSelectionConfirmDialog` and `FunderTopUpDialog` prop types now allow null.
  - At 15 (switch off), every figure and sentence equals today's; the tests compare against the old helpers.
- **O5. WithdrawFlow.** A null `roiBalance` is unknown (`roiCap`, `maxUnknown`, `WithdrawFlow.tsx:443-447`).
  - Steps 1 and 4 refuse while the cap is unknown (`:818`, `:843`).
  - `handleNext` refuses before comparing amounts (`:1228`).
  - `FunderQuickActions` types `roiBalance` as `number | null`.
  - Today nothing changes, because no UI selects the `'roi'` source.
- **O7. `PartnerReturnPolicyCard.tsx:40-43`.** `policyRate`, `legacyRate` and the new `newContractRatePct` are `formatRatePct(rateOrNull(...)) ?? '—'`. The switch toast leaves out the rate sentence when the rate is missing.

**OPEN (Claude).** None of these is Gemini's work; they are listed so the two lanes do not collide.
- **O1. Release order.** See checklist A1.
- **O4. Trust-cache limit readers.** `BorrowerProfileSheet.tsx:92`, `LendingAgentPortal.tsx:564` and `BorrowerVouchBadge.tsx:59` (all `|| 0`) wait on owner decision (b). `BorrowerProfileSheet.tsx:92` is also on the 4b scan list.
- **O6. Optional.** The payout-day branch of `ActivePartnersDetail` has no stored-rate read-back, so its toast cannot show the stored rate.
- **O8. Decision.** The invest-for-partner preview (`COOPartnersPage.tsx:3491`, `ActivePartnersDetail.tsx:600`) uses one existing portfolio's rate. `coo-invest-for-partner` was not in scope. Should it use `usePartnerQuoteRate('partner', id)`?
- **O9. Separate fix.** Three tests in `src/test/returnCycleGuard.test.ts:198-205` were already failing before this work. They expect `crypto.randomUUID()`, but the code uses `safeUUID()`.
- **O10. DONE (data side), 7 Nov: `FunderNewSelectionPanel.tsx`** (signed-in, `/dashboard/funder-new`). The fixed `MONTHLY_RATE = 0.15` is gone; `monthlyAt15` in `FunderNewSelectionBar` and `FunderNewReviewDialog` now comes from `useMonthlyAtOwnRate()` (the partner's own rate via `useOwnNewPortfolioRate()` + `monthlyReturnFor`; 15 while the switch has never been on, `null` while loading or unknown). The file is now in the release gate's `OWN_RATE_SCREENS`.
  - **Gemini (item 10):** the figure can be `null` and `formatDynamic(null)` prints 0: show "—" at the four `formatDynamic(monthlyAt15(...))` spots. Copy the gate flags: `:97` and `:243` and `:387` "Monthly at 15%" → "Monthly Returns" (or `formatRatePct(rate)`), `:529` share text and `:537`, `:588` ("earn 15% of their rent") → no fixed rate (say "earn monthly Returns", or use the rate). `:287` is flagged only because the line sits near the rate copy; check it.

---

## Gemini tasks

### 1. ActivatePartner (`src/pages/ActivatePartner.tsx`): **Phase 4 merge**
The data is ready in the component body (`:47-54`):
- `noteRate`, `noteRatePct` and `noteMonthlyReturn` (null means hidden)
- `activation`: `{ alreadyActive, returnRate, monthlyReturn, yourRate }`
- `yourRate` and `yourRatePct`
- `activationError`: `{ status, kind, message }`, where `kind` is `sign_in | linked_elsewhere | contact_mismatch | changed | not_open | not_found | failed`

What to change:
- **Rate card.** `:237` says "Earn 15%" and `:240` computes `formatUGX(Number(note.amount) * 0.15)`.
  - Use `noteRatePct` and `noteMonthlyReturn`.
  - When `noteRate === null`, show "Sign in to see your Returns rate" and no figure.
- **Success card.** `:253` says "15% monthly returns".
  - Show `yourRatePct`, as "what a deposit opens at for you".
  - Show no rate line when it is null.
- **Error messages from `activationError`:**
  - 401: sign in again. The page already switches back to the sign-in form.
  - 403: the note is linked to another account.
  - 409: "open the link again". The note is re-read automatically.
- **403 contact mismatch** (`kind === 'contact_mismatch'`).
  - Show `activationError.message` exactly as it is. It always says Partner Ops can link the note, and that is the person's only way forward.
  - Show it on the page, not only in a toast, and add a way to reach Partner Ops if the page has a contact link.
- **Copy:** "monthly returns" becomes "monthly Returns".

The release gate turns green for this page once `:237`, `:240` and `:253` no longer contain a fixed 15%.

### 2. Staff portfolio forms: **Phase 4 merge**
Files: `src/components/coo/COOPartnersPage.tsx`, `src/components/executive/NewPartnersPanel.tsx`, `src/components/manager/CreateInvestmentAccountDialog.tsx`, `src/components/partner/InvitePartnerPortfolioDialog.tsx`, `src/components/coo/PartnerImportDialog.tsx`, `src/components/manager/RenewPortfolioDialog.tsx`, `src/pages/coo/ActivePartnersDetail.tsx`.

The data wiring is done. Do not change the handlers' request bodies.

**Labels.** Use "Monthly Returns (%)" in place of "ROI" in these spots:
- `NewPartnersPanel.tsx:2980`
- `CreateInvestmentAccountDialog.tsx:456` and `:698`
- `InvitePartnerPortfolioDialog.tsx:142`
- `RenewPortfolioDialog.tsx:270` and `:317`
- `ActivePartnersDetail.tsx:464`, `:632` and `:645`

`COOPartnersPage.tsx:3364` already reads "Returns Rate (%)".

**`PartnerRateCfoNote`.** Mount it next to each rate field.
- Props: `policyEnabled={rate.policyEnabled}`, `personRate={rate.personRate}`, `typedRate={rate.value}`.
- On edit or renew forms, also pass `currentRate={stored rate}`.
- Review its markup and copy. Its last sentence (`:54`) says "an approved rate applies from the next cycle". Under owner decision D10, a CFO-approved rate on a new portfolio applies before its first Returns event, so reword it for new portfolios.

**Null-safe previews.** With the switch on and the partner's rate unknown, the prefill is now blank.
- `COOPartnersPage.tsx:3407` computes `formatUGX(Math.round(Number(addPortfolioAmount) * (Number(addPortfolioRoi) / 100)))`, which prints UGX 0. Use `formatUGXOrDash(monthlyReturnFor(Number(addPortfolioAmount), rateOrNull(addPortfolioRoi)))`, or hide the line.
- `CreateInvestmentAccountDialog.tsx:699` prints `{form.roi_percentage}%`, which shows a bare "%" when blank. Show "—", or say "the partner's rate" unless the field was edited.

**Create-response toasts.** `create-portfolio-invite` now answers with `roi_percentage`, `requested_roi_percentage` and `rate_awaits_cfo` for partner staff, and with `rate_note` for operations and cto.
- When `rate_awaits_cfo` is true, add: "The X% Returns rate waits for CFO approval; Y% applies until then." Otherwise show `rate_note` if it is present.
- Spots:
  - `COOPartnersPage.tsx:1556` (`result`)
  - `NewPartnersPanel.tsx:2940` (`response.data`)
  - `CreateInvestmentAccountDialog.tsx:308` and `:313` (`data`)
  - `InvitePartnerPortfolioDialog.tsx:88` (`data`)

**Renewal toast.** At `RenewPortfolioDialog.tsx:192`, when the local `rateAwaitsCfo` is true, say that the typed rate waits for CFO approval and that `rateInForce` applies until then.

**ActivePartnersDetail toasts.**
- At `:437`, the toast pushes `ROI ${updateFields.roi_percentage}%`, the typed rate. Show the stored rate instead, and add "awaits CFO" when `rateAwaitsCfo(typed, stored)`.
- At `:428`, the warning says "ROI set to ${newRoi}%" even when no rate was sent. Reword it.
- `:430` already shows the stored `createdRoi`. Only the word "ROI" needs to become "Returns".

**COOPartnersPage portfolio edit toast** (`:1660`). When `storedRoi !== roi` (`:1658`), add "The X% Returns rate waits for CFO approval; Y% applies until then."

**Loading and unknown-policy toasts.** The handlers now show one of two new messages from `staffRateSubmitBlock`: "The Returns rate is still loading. Try again in a moment." or "The Returns rate could not be checked. Reload the page." (`POLICY_LOADING_MESSAGE`, `POLICY_UNKNOWN_MESSAGE` in `src/lib/staffPortfolioRate.ts`).
- You may prefer to disable the submit button while `staffRateSubmitBlock(rate) !== null` (or `addPortfolioRate`), and reword the messages in the lib.
- Create-form spots: `COOPartnersPage.tsx:1525`, `NewPartnersPanel.tsx:2896`, `CreateInvestmentAccountDialog.tsx:264`, `InvitePartnerPortfolioDialog.tsx:52`.
- The partner edit dialogs (`COOPartnersPage.tsx:2002`, `ActivePartnersDetail.tsx:290`) show the same toasts. Their Save buttons may take the same disable rule, built from `partnerReturnPolicy`.

**Remove old comments.** Remove any comment from the old design that says a new portfolio "earns the new-contract rate, not the partner's older rate". An existing partner's new portfolio earns their own rate.

**Leave the `?? 15` display defaults alone for now.** `ActivePartnersDetail.tsx:127` and `:157` and `COOPartnersPage.tsx:732` still use `?? 15`; they keep the switch-off display the same as today. A later pass will make them null-tolerant ("—"), with a Claude data line.

### 3. Agent screens: before release
`src/components/agent/AgentInvestForPartnerDialog.tsx`:
- **WhatsApp text** (`:299`): remove "(15%)". Leave out the reward line when `monthly_reward` is null, which happens for an existing partner on their own rate once the switch is on. Today it sends "Monthly Reward: UGX 0".
- **Success card** (`:366`): use `formatUGXOrDash(success.monthly_reward)`, or hide the line.
- **Preview label** (`:578`) "15% Monthly Reward Preview": label it with the new-partner rate, `formatRatePct(newContractRate)`.
- **Preview figures** (`:581`): `formatUGX(monthlyReward)` and `formatUGX(monthlyReward * 12)`. While the policy loads, `monthlyReward` is null, so use `formatUGXOrDash` and guard the `* 12`.
- **Breakdown row** (`:636`) "Monthly reward (15%)" and its figure (`:637`): same rule as the preview.
- **"ROI" wording:** remove it.

`src/components/agent/CreateUserInviteDialog.tsx` (`:334` "📈 ROI", `:497`, `:503`, `:671`): drop the rate input, or leave the unmounted dialog alone.

#### 3b. Other agent and public screens (Phase 6 audit): before release
These quoted a fixed 15% to people who become NEW partners (10% once the switch is on). They are now in the release gate (`AGENT_PUBLIC_FILES` in `partnerRateRelease.test.ts`).

**Claude, DONE (data, 7 Nov).** Every figure and share text is priced at the public new-partner rate (`usePartnerReturnPolicy().newContractRate`; `getPublicPartnerRate()` in the agent dashboards' share handler; `returns_rate_pct` from `agent_list_empty_house_opportunities` in the empty-house list). While the switch has never been on that rate is 15, so every figure is today's. With no rate known a figure is `null` and a share text states no rate. A signed-in partner sees their own rate: the empty-house list in `mode="partner"` asks the RPC for `p_quote_for: 'me'`, and `EmptyHouseDetailSheet` with `isPartner` uses `useOwnNewPortfolioRate()`. Agent screens never show a per-person rate.

**Gemini: the copy.** Replace each fixed "15%" with the variable named, and leave the rate out of the sentence when it is `null` (or say "monthly Returns"). Words: Returns, not returns/rewards/ROI.
- **`PromissoryNoteDialog.tsx`.** `:698` "Your Partner earns 15% per month": use `newRatePct` (`:67`). The figure at `:699` is done (`formatUGXOrDash`).
- **`EmptyHouseOpportunitiesSheet.tsx`.** Use `quoteRatePct` (`:323`) at `:532` and `:538` ("15% of that rent every month for 12 months"), `:571` ("… 15% per month"), and the three "15% monthly" labels at `:663`, `:709` and `:1196`. The figures next to them are done (`formatUGXOrDash`).
- **`EmptyHouseDetailSheet.tsx`.** Use `returnsRatePct` (`:113`) at `:291` "Monthly Returns (15%)" and `:361` "15%". The figures are done.
- **`SupportModeChooserDialog.tsx`.** `:38` body: use `newRatePct` (`:25`) in place of "15%", or say "the monthly Returns they earn".
- **`ProxySupportOpportunities.tsx`.** Figures done (they show "—" while the rate loads). Optional copy: "Monthly return" at `:113` and `:490` → "Monthly Returns".
- **`AgentDashboard.tsx` / `AgentDashboardBk.tsx`.** Done (the partner invite text uses the public rate). Nothing left.
- **`CapitalOpportunityEntry.tsx`** (`/angel-pool`). In `TenantPreview`: `:80` "Monthly Return (15%)" → `newRatePct` (computed in `TenantPreview`); `:81` and `:85` call `formatAmountCompact` on `monthlyReturn` / `dailyReturn`, which are `null` while the rate loads: show "—". `:202` "Up to 15%" and `:603` "Up to 15%/mo": state the new-partner rate (`formatRatePct(usePartnerReturnPolicy().newContractRate)`) or drop the figure; "Up to" is not true for a new partner.
- **`InvestmentSelectionSheet.tsx:49`** "15%": `formatRatePct(usePartnerReturnPolicy().newContractRate)` in `OptionCards`, or "—" when null.
- **`AngelPool.tsx`.** The hero's illustrative `monthlyReturn` is `null` while the rate loads: `:162` is guarded by `> 0`; `:187` `formatAmountCompact(monthlyReturn)` needs "—".
- **`Calculator.tsx`.** Use `ratePctLabel` at `:134` ("Partner Returns target 15%…"), `:320` ("15%/mo") and `:377` ("earn 15% monthly returns"). `calculations.requiredInvestment` / `monthlyReturn` are `null` while the rate loads: `:231`, `:252` and `:316` call `formatAmount` on them; show "—". The WhatsApp share does nothing until the rate is known.
- **`TryCalculator.tsx`.** `:397` "Partner Returns target 15%…": use `ratePctLabel`. `:600` `formatAmount(monthlyEarnings)` can be `null`: show "—". The share text and the PDF already use the rate.
- **`Onboarding.tsx`** (new Supporter). `:407` badge "+15% / mo", `:472` title "15% Monthly Pay Outs", `:473` body, `:589` `badge="15% Monthly"`: take `formatRatePct(usePartnerReturnPolicy().newContractRate)` (the graph already reads it in `SupportGraph`) or drop the figure. The breakdown shows "—" while the rate is unknown (done).
- **`SupportPlanPublic.tsx`.** `:24` (the `POINTS` list), `:145` and `:162` "Monthly at 15%": use `formatRatePct(newContractRate)` (`newContractRate` is read at `:46`). The share text and the page description are done.
- **Copy-only pages:** `Auth.tsx:43` ("15% monthly returns"), `BecomeSupporter.tsx:41`, `:312`, `:377`, `Benefits.tsx:345` ("Earn 10-15%"), `SelectRole.tsx:51`, `RentMoney.tsx:59` and `:226`. Use the public rate labelled as the rate for new partners, or drop the number.

Not in the gate (signed-in partner screens, own rate, for a later round): `SupporterEarnings.tsx:91`, `:251`, `:441`; `InvestmentPortfolio.tsx:120`, `:216`, `:512` (`|| 15`); `partner/SelfSupportHousesSection.tsx` and `partner/HousePlacementTimeline.tsx` (`HOUSE_MONTHLY_ROI_RATE = 15`).

### 4. Agent partner cards: **before 4b**
4b masks these figures to null for rows the agent only created.
- `AgentPartnerDashboardSheet.tsx:427`: `{p.roiPercentage}%` becomes "—" when null.
- `FunderDetailView.tsx:238`: `formatUGX(stats.totalROI)`; `:440`: `formatUGX(p.total_roi_earned)`; `:444`: `{p.roi_percentage}%`. Use "—" when null, with `formatUGXOrDash`.
- `FunderManagementSheet.tsx:269`: `+{formatUGX(stats.totalROI)}`. Show "—" and no "+" when null.

### 5. `src/pages/InvestorPortfolioPublic.tsx`: **before 4b**
- `:104` `` `${portfolio.roi_percentage}%` ``: hide it when `rateOrNull(...)` is null (it shows "null%" today).
- `:106` `formatUGX(monthlyRoi)`: hide it, or show "—".

### 6. Nexa hub, banner and landing: before release (NexaSalesHub labels in the Phase 4 merge)
- **`NexaSalesHub.tsx`.** The data is done: the figures use `newContractRate`.
  - Change the labels `:25` "10%/mo Partner" and `:33` "Monthly Returns · 10%" to `formatRatePct(newContractRate)`, or "new-partner rate".
  - When `supporter.monthly` or `supporter.annual` is null, show "—" and do not call `formatFixedUGX(null)`.
  - **This must merge together with the data line.** Otherwise the hub shows 15% figures under a 10% label.
- **`ShareWelileAIBanner.tsx:9` and `:14`, `NexaInquirySignupBar.tsx:33`, `roleLanding.ts:33`, `:46`, `:59` and `:72`.** These are hard-coded "15%" strings. Take the rate from `usePartnerReturnPolicy().newContractRate` and label it as the rate for new partners, or drop the number. `roleLanding.ts` is a plain module, so its strings need the rate passed in from the component that renders them.

### 7. Import template (`PartnerImportDialog.tsx`)
- The template headers at `:98` are still `'ROI %'` and `'ROI Mode'`. Change them to `Returns %` and `Returns mode`, make the Returns % column optional, and allow blank sample values. The parser already accepts "Returns %".
- The preview at `:484` prints `{p.roiPercentage}% ROI`, which shows "null% ROI" for a blank row. Show "the partner's rate" or "—" when null.
- **Claude, DONE (7 Nov).** The validation message at `:153` now reads "Returns rate must be 1-30%". Also done: the `ActivePartnersDetail.tsx:430` toast now says "…created missing portfolio with ${createdRoi}% monthly Returns".
- Tell Partner Ops one behaviour change: a blank rate is now accepted, also while the switch is off. Such a row is stored at the public rate (15 today).

### 8. `RenewPortfolioDialog.tsx`
The prefill is already the stored rate (data, done). Only the labels and the toast from item 2 remain.

### 9. Share sheets: data done; leftovers before release
- `SelfPortfolioPlanDetailSheet.tsx:489` "15% per month": use the plan's own stored rate, or drop the figure.
- `SupportHouse.tsx:301` `{newContractRate}%` prints "null%" while loading. Use `formatRatePct(newContractRate)`, and leave the sentence out when it is null.

### 10. Signed-in partner screens: before release
Data is done: every file reads `useOwnNewPortfolioRate()`. Replace the fixed rate with `formatRatePct(ownRate)`, or drop the number, at these release-gate lines:
- `FunderNewCalculatorDialog.tsx:83`, `:139`, `:214`
- `FundAccountDialog.tsx:243`
- `InvestmentCalculator.tsx:975` ("target 15%, not guaranteed")
- `InvestmentPackageSheet.tsx:433`, `:482`
- `FundRentDialog.tsx:112`, `:167`

Any figure built from `ownRate` can be null. Use `formatUGXOrDash` for it. Examples: `FundAccountDialog.tsx:245`, `FundRentDialog.tsx:112` (`successInfo.monthlyReward` from the server) and `:172`. Also check `SelfPortfolioDeployDialog`, `SupporterDashboard`, `FunderBookedHousesPanel` and `SelfPortfolioFundingCard` for the same.

### 11. Trust and vouch screens, and the wallet hub: **before 4b**
4b masks these figures to null for anyone who may not see the person's Returns: everyone except the person, partner staff and the person's approved proxy agent.
- **Null means unknown.** Show "—" or leave the line out. Never show "UGX 0", "Build your vouch limit", a 0-length bar or an empty ring.
- **New field:** the public trust profile gains `supporter_activity.earning_returns: boolean`. Show "Earning Returns: yes/no" instead of an amount.

**11a. Spots.** The 4b scan flags 22 lines, all listed here. Each entry ends with "(scan)" if the scan flags it.
- **`TrustExpansionCards.tsx`.** `:15` `cf.monthly_avg > 0` (scan); `:35`, `:36` and `:37` daily, weekly and monthly (scan): use "—".
- **`TrustScoreCard.tsx`.**
  - `:34` `Math.round(trust.score)` (scan): when the score is null, show the empty state like `isNew` does, for the ring offset at `:42` and the number at `:88`.
  - `:101` and `:104`, the limit (scan): make the null check explicit, and show "—".
  - `:123` `trust.breakdown.supporter ?? 0` (scan): hide the supporter bar when null.
- **`VouchAuditLog.tsx`.**
  - The rows are portfolio (`:38-41`, `formatUGX(portfolio)` at `:39`) and payment history (`:83-85`, `formatUGX(monthlyCashflow)` at `:83`); the total is at `:148` (scan).
  - Use "—", and add one line, "Hidden: built from this person's Returns", when any of them is null.
- **`HolisticProfile.tsx`.**
  - `:214-215` (scan).
  - The vouch tile `:255-285`: `:255` and `:267` are on the scan. The `effectiveLimitUgx` prop is at `:285`.
  - The vouch breakdown `:295-335`: `portfolio_component_ugx` at `:311`, the payment booster at `:328` and the total at `:333` (scan).
  - The network tile `:424` and `:427`, `portfolio_value || 0` (scan): hide it when null.
  - `:516` `vouchedAmountText={formatUGX(...)}` (scan): pass `undefined` when null.
  - `:118` already stores null as null.
- **`AgentVouchHighlightCard.tsx`.** Own profile, so null is rare.
  - `:64-65`: `score >= t.min` with a null score treats it as 0. When null, use `trust.tier` for the current tier and show no next tier.
  - `:121` and `:148`: when `vouch` is null, show "—", not "Build your vouch limit".
  - Score shown as `{score}`: `:124`, `:240` "· x/100", `:322` "x / 100". Show "—".
  - `:245` tier ladder "reached": no tier counts as reached on a null score.
  - `:264` "N more points": hide it.
  - `:273` and `:330`: `formatUGX(vouch)`.
- **`AgentTenantHealthCard.tsx:65` and `:67`.** `vouch > 0` hides the line today. Keep it hidden when null, and never show 0.
- **`BorrowerTrustScorePanel.tsx`.**
  - `:22-27`: use a neutral tone when the score is null.
  - `:57`: empty ring.
  - `:61`: show "—".
  - `:92`: use `formatUGXOrDash(limit)`.
  - `:108`: hide the bar.
  - The breakdown may hold `supporter: null`.
- **`BorrowerProfileSheet.tsx`.**
  - `:94-97`: use a neutral risk label when the score is null.
  - `:184` `formatUGX(limit)`: use "—" once O4 is decided.
  - `:192` score and `:208` bar: show "—" and hide the bar.
  - `:92` (scan) is Claude's line; see O4.
- **`LendingAgentPortal.tsx`.** `:961` `{borrower.trust.score}`: show "—" (today the tile is empty). `:969` `monthly_avg ?? 0` (scan): use "—".
- **`LenderRecordLoanCard.tsx`.**
  - `:179`, `:184` and `:278` `formatUGX(profile.trust.borrowing_limit_ugx)` (scan): use "—", or leave the line out.
  - `:280` "Score {score} / 100": use "Score — / 100", or drop the score part.
  - While `recordVouchFigures(profile.trust).ok` is false, disable "Record a Vouched Loan" and give a one-line reason. The handler already refuses and saves nothing.
- **`BorrowerVouchBadge.tsx`** (`src/components/executive/`). `:68`, `:92` and `:120` apply only if owner decision (b) masks the cache column.

**11b. Wallet hub** (`FunderWalletHubSection.tsx`).
- The data is done: `:128` `balance={data ? data.totalAvailable : 0}` and `:142` `roiBalance={data ? data.roiAmount : 0}` now pass null through.
- `UnifiedWalletHeroCard` and `FunderQuickActions` must show "—" for a null balance.
- Today the section shows only the viewer's own hub, so nothing changes on screen.
- The null into WithdrawFlow is handled (Claude, O5 done): a null `roiBalance` is never a cap and never withdrawable.
- If a Returns source is ever offered in WithdrawFlow, the figures built from `maxAmount` show UGX 0 while `maxUnknown` is true. They must show "—" then: `WithdrawFlow.tsx:1514`, `:1525`, `:1534`, `:2130`, `:2169`, `:2172`. No screen reaches them today, because nothing selects the `'roi'` source.

**11c. Registration answer.** Covered in item 15.

### 12. CFO queue and switch
- `src/components/cfo/PartnerReturnPolicyCard.tsx` and `PartnerRateApprovalsPanel.tsx` are **not mounted**. Mount them on `src/pages/cfo/Dashboard.tsx`; the reference patch shows where.
- In the approvals panel (`:197` shows `requested_rate`), add a badge "lower than this person's rate" when `requested_rate < standard_rate`.
- **The rule text in `PartnerReturnPolicyCard.tsx:126-129` is wrong now.** It comes from the superseded design: "Every new portfolio, including a new one for an existing partner, earns {policyRate}" and "Renewals move to {policyRate}". Rewrite it to the owner's rule (6 Nov) before mounting:
  - New partners earn the new-partner rate from the cut-off.
  - Existing partners keep their own rate on new portfolios, with no cap.
  - Employees earn 20%.
  - Renewals keep their rate.
  - A typed rate different from the person's rate is stored at the person's rate and waits for the CFO.
- Figures (Claude, O7 done):
  - `policyRate` and `legacyRate` (`:40-41`) now hold "—" for a missing rate.
  - The new `newContractRatePct` (`:43`) does the same. Point the "New contracts earn" JSX at `:86` (`formatRatePct(Number(p.new_contract_rate))`, which renders nothing for a missing rate) at `newContractRatePct`.
  - The rule sentences (`:126-136`) read "earns —" when the rate is missing; the rewrite should allow for that.

### 13. Reference patches
The old-design screen edits are in `docs/partner-returns-10pct/reference/p4_gemini_reference.patch`, and the old test, lib and hook edits are in `docs/partner-returns-10pct/reference/p4_gemini_reference_supplement.patch`.
- They followed a superseded design (one public rate for everyone).
- Use them to *find* spots, not as the target.

### 14. Rent-facilitation reward screens: before release
The data is done: the screens use the own rate and the `...At` helpers. The copy remains:
- **`PayLandlordDialog.tsx`.**
  - `:175` "You'll earn {formatUGX(reward)}/month (15% ROI)": change to "({formatRatePct(ownRate)} Returns)", and hide the line when `reward` is null.
  - `:339` "15% monthly returns": use `formatRatePct(ownRate)` monthly Returns, or no rate.
  - `:359` `formatUGX(reward)`: use `formatUGXOrDash`.
- **`RentCategoryFeed.tsx`.**
  - `:225` "15% Monthly Reward" badge: use `formatRatePct(ownRate)`, or hide it. `ownRate` is read in the parent at `:610`, so pass it down.
  - `:277` "Your 15% monthly reward…": no fixed rate.
  - Reward figures at `:255`, `:262`, `:362`, `:369` and `:545` are null when there is no rate. `formatAmount` takes a number, so show "—" when null.
- **`MyWatchlist.tsx`.** `:390` `formatAmount(stats.potentialReward)`, `:568` "Earn … reward" (hide the line when null), `:630`, `:674`: use `formatUGXOrDash` or "—".
- Words: "Returns", not ROI.

### 15. Public partner registration page: before release
`src/pages/RegisterPartnerPublic.tsx`. The data is done: the preview uses `newContractRate`, and the success figure is the server's `monthly_roi`. The copy remains:
- `:315` "Monthly Returns (15%)" (release gate): use `formatRatePct(newContractRate)` and label it as the rate for new partners.
- `:217`, `:303`, `:306`, `:316` and `:321` call `formatUGX(monthlyROI)` or `formatUGX(annualROI)`, which can be null. Use `formatUGXOrDash`, or hide them.
- An existing account gets `monthly_roi: null` (their rate is personal). The success screen then shows no figure.

### 16. Small follow-ups (not release blockers)
- **Resend invite toast** (`src/components/executive/InvitedPortfoliosPanel.tsx:409-411`). Use "…was sent to {res.sent_to ?? row.partner_email}". When the rate is personal, the invite goes to the partner's confirmed login email.
- **360-day captions** (`src/components/v360/V360PlanCaptions.tsx`). The Partner Returns label is now the full sentence `V360_PARTNER_RETURNS_SENTENCE` (`src/lib/v360Captions.ts:4`).
  - If it reads badly as a `<dt>`, lay that row out on its own: the sentence above, the figure below.
  - Keep the words, and do not bring back "target 15%".
- **`V360StaffPricingBanner.tsx:75` and `V360IllustrativeExample.tsx:7`.** The text is longer now; check that it wraps well.

### 17. Deprecated-helper importers: before release (Claude data DONE; Gemini copy and null display left)
Claude's data side is done: no file imports a deprecated helper. Both release scans' #3 checks are green. What is left is copy and null display.
- **`SupportPlanExample.tsx`.** It takes `rate`. `SupportPlanPublic.tsx:192` passes `newContractRate` (public), and `FunderNewSelectionPanel.tsx:605` passes the own rate.
  - With a null rate, the steps already state no figure ("at the rate shown in the app"), and the for-this-plan line is hidden (`:41`).
  - Nothing is required. Only review the figure-free step wording if you like.
- **`FunderDirectHouseListing.tsx`** (unmounted: nothing imports it). It now prices at the own rate (`ownRate`, `:152`). Its figures are null without a rate. Either the owner removes the file, or:
  - Copy: the `:907` comment and `:915` "15% / month" become `formatRatePct(ownRate)` / month (hidden when null). `:1121` "You earn 15%…" loses the fixed rate.
  - Null display, using `formatUGXOrDash`:
    - Card: `:919` `formatUGX(earn.monthly)` and `:930` `formatUGX(m.value)`.
    - Selection bar: `:1054` `formatUGX(selectionTotals.monthly)` and `:1082` `formatUGX(m.value)`.
  - The earnings filter and sort choices (`MIN_MONTHLY_EARN`, `earn_desc` and `earn_asc`) do nothing while `ownRate` is null. Hide them or disable them then.
- **`FunderSelectionConfirmDialog.tsx:102`** `formatUGX(m.value)`, and **`FunderTopUpDialog.tsx:95`** `formatUGX(monthlyEarning)`: use `formatUGXOrDash`. The props can now be null. Both dialogs are used only by `FunderDirectHouseListing`.
- **`FunderEarningsAssumptions.tsx:40`.** The line "Monthly earning = house monthly rent × ${pct}%." reads "× —%" when the rate is null.
  - Use `formatRatePct(rate)` without the trailing "%", or leave the line out when it is null.
  - `pct` (`:18`) is the bare number, or "—".
- **`FunderEarningsBreakdown.tsx`.** Done in data: the formula reads "Rent × —" and the figures "—" when the rate is null. Nothing is required.
