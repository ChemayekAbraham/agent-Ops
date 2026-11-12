# Co-support screens brief (Phase 3, for Lovable)

Two partners share one Rent Plan 50/50 through a link that stays open for 48 hours.
The logic and data are done (Phase 1: database; Phase 2: link, hooks, onboarding
return). This brief covers only screens. Don't change the hooks, the lib or the
database. If a screen needs data that isn't here, ask instead of querying tables.

**Copy rules:** say "Rent Plan", "partner" and "Rent Profit Share". Never write
"loan", "lender", "interest", "ROI" or "Returns". Never show a rate or the other
partner's Rent Profit Share. Each person sees only their own.

**Code to use**
- Hooks are in `src/hooks/useCoSupport.ts`:
  - `useCoSupportPreview(code, userId)`
  - `useMyCoSupportInvites()`
  - `useCreateCoSupport`, `useAcceptCoSupport`, `useDeclineCoSupport`, `useCancelCoSupport`
  - `useReinviteCoSupport({ inviteId, newLink })`
  - `useFundCoSupportAlone`
- Helpers are in `src/lib/coSupport.ts`:
  - `coSupportShareUrl(code)`
  - `coSupportShareText({...})`
  - `whatsappShareUrl(text)`
  - `coSupportSignInPath(code)`
  - `coSupportOnboardingPath(code, referrerId)`
  - `coSupportErrorMessage(err)`: use it for every error toast
  - `coSupportBlockMessage(preview)`
  - `coSupportTimeLeft(expires_at)`
- Every amount comes from the server (`your_share`, `partner_share`, `plan_amount`,
  `your_monthly_rent_profit_share`). Never compute halves on the screen.

## 1. "Support with a partner" on a Rent Plan

- **Where:** on the funder Rent Plan card and its detail sheet, next to "Fund this
  House". Rent Plans only, never empty houses.
- **Hide it when:** `plan_amount` (the amount the partner pays) is under 100,000.
- **Tap:** call `useCreateCoSupport().mutate(rentRequestId)`. On success, open the
  share sheet (section 2). On error, show `coSupportErrorMessage(error)`. That
  covers "Add float…", "Sign your partnership agreement first" and the rest.
- **Explain before the tap:** "You pay half (UGX {your_share}) and a partner pays
  half. We hold your half for 48 hours while they decide."

## 2. Share sheet (sender)

Show:
- the house photo, `tenant_first_name` and `city`;
- "Your half: UGX {your_share} · Your partner's half: UGX {partner_share}";
- "Your Rent Profit Share: UGX {your_monthly_rent_profit_share} a month";
- a countdown from `coSupportTimeLeft(expires_at)`.

Buttons:
- **WhatsApp:** `whatsappShareUrl(coSupportShareText({ tenantFirstName, city, partnerShare: partner_share, url: coSupportShareUrl(code) }))`.
- **Copy link:** copies `coSupportShareUrl(code)`.
- **Done.**

## 3. "Waiting for your partner" (sender's list)

- **Where:** a section on the funder dashboard showing `useMyCoSupportInvites()`
  rows where `your_role = 'lead'`.

What each status shows and allows:

| status | Show | Actions |
|---|---|---|
| `open` | countdown, "Waiting for your partner" | Share again (section 2), Cancel |
| `declined` | "{partner_first_name} said no" | Ask again (same link) `reinvite(newLink:false)`, Invite someone else `reinvite(newLink:true)`, Pay the full amount `fundAlone`, Cancel |
| `expired` | "The 48 hours ran out" | Same four actions as `declined` |
| `completed` | "Supported with {partner_first_name}", "Your Rent Profit Share: UGX {...} a month" | none |
| `cancelled`, `replaced`, `funded_alone`, `plan_unavailable` | one-line note | none (hide after 7 days) |

- **Pay the full amount:** confirm first with "You'll pay the full UGX {plan_amount}
  from your float". If the float is short, the error toast already gives both amounts.

## 4. Invitation page: route `/co-support/:code` (new)

- **Register the route.** It's public: logged-out people must reach it.
- **Load:** `useCoSupportPreview(code, user?.id)`.
- **`found = false`:** "This link is not valid. Ask your partner to share it again."
- **Dialog header** (the main ask): "{lead_first_name} wants to support {tenant_first_name}'s
  Rent Plan with you", followed by the house photo, `city`, "Your half: UGX {your_share}"
  and the countdown.
- **Not signed in** (`signed_in = false`):
  - **"I have an account":** `navigate(coSupportSignInPath(code))`. Auth returns here
    after sign-in.
  - **"I'm new to Welile":** `navigate(coSupportOnboardingPath(code, referrer_id))`.
    funder-onboarding signs the contract and records the sharer as referrer, then comes
    back here by itself.
- **Signed in and `can_accept`:**
  - Show "Your Rent Profit Share: UGX {your_monthly_rent_profit_share} a month".
  - **Accept** calls `useAcceptCoSupport().mutate(code)`.
    - If `ok`: success screen ("You and {lead_first_name} now support this Rent Plan.
      Your portfolio: UGX {your_share}"), then a link to the dashboard.
    - If `ok = false`: show `message`. Nothing was charged.
  - **Decline** calls `useDeclineCoSupport()`.
- **Signed in and cannot accept:** show `coSupportBlockMessage(preview)` and the next step:
  - `agreement_required` → the partnership agreement screen, then back here;
  - `funds_short` → the wallet deposit, then back here;
  - `not_a_partner` → funder-onboarding.
- **Viewer is the sender** (`your_role = 'lead'`): show their own view (section 3 row),
  not the accept dialog.

## 5. Partner Ops: cancel a co-supported plan

- **Where:** in Partner Ops, on a plan that shows two funding partners.
- **Action:** "Cancel both halves" with a required reason of at least 10 characters.
- **Call:** `rpc('co_support_staff_cancel', { p_invite_id, p_reason })`, Partner Ops
  only. Show the returned `refunds_due` (each partner's first name and amount): finance
  refunds them.
- **Landlord already paid:** the call refuses with LANDLORD_ALREADY_PAID. Show the message.

## 6. Phase 4: empty houses (added after the Rent Plan screens)

Partners can now share a verified **empty house** too. The flow is the same as a
Rent Plan, with one difference: **after the partner accepts, Partner Ops approve
both halves together.** Nothing is taken from either wallet until then; each half
is held on its partner's float. Approving either half approves both. Rejecting
either half rejects both.

- **Button:** add "Support with a partner" to the empty-house card and its detail
  sheet. Call `useCreateCoSupportHouse().mutate(houseId)`.
  - Hide it when the amount the partner pays is under UGX 100,000.
  - The current house card hides the button with `isEmpty ? null : …`. Show it for
    houses too, using the house hook.
  - Explanation: "You pay half and a partner pays half. We hold your half for 48 hours
    while they decide. Partner Ops then approve the house."
- **Every invitation now has `kind`:** `'rent_plan'` or `'house'`.
  - **Houses:** use `house_title` and `city` (`tenant_first_name` is empty).
  - **Share text:** pass `kind` and `houseTitle` to `coSupportShareText`, so it says
    "an empty house (…)".
- **Invitation page header:**
  - Houses: "{lead_first_name} wants to support an empty house with you", then
    `house_title`.
  - Rent Plans: unchanged ("…'s Rent Plan").
- **After accepting a house** (`awaiting_partner_ops = true`): success screen "You and
  {lead_first_name} have shared this house. Partner Ops will approve it. Your half stays
  held until then." Don't say the money has moved yet.
- **Waiting list (section 3):** for a `completed` house with
  `awaiting_partner_ops = true`, show "Waiting for Partner Ops". Once false, show
  "Supported with {partner_first_name}". The "Pay the full amount" action also works for
  houses (it becomes a normal one-partner house support, waiting for Partner Ops).
- **Partner Ops list (replaces the pending-vetting hook in section 5):** the cancel
  button never showed there, because no server row carries a co-support id.
  - Add a "Shared supports" list in Partner Ops using `useCoSupportStaffList()`.
  - Each row: `title`, `place`, `kind`, `status` ("Waiting for approval" / "Funded"),
    both partners (`partners[].name` and `amount`) and `accepted_at`.
  - "Cancel both halves" uses `useCoSupportStaffCancel().mutate({ inviteId, reason })`.
    Show `refunds_due` afterwards.
  - Hide the button when `landlord_paid_out > 0`, and on house rows with
    `status = 'awaiting_approval'`. Those are rejected from the normal approval queue,
    and rejecting one half rejects both.
- **Approval queue:** a shared house shows as two pending rows (one per partner).
  Approving or rejecting either one handles both, so after one click both rows leave
  the queue. Optional: label the rows "Shared house, approved together".

## 7. Invitation page redesign (2026-11-12, replaces the look of section 4)

The owner designed the new invitation page. The boards are in
[`docs/co-support-design/`](./co-support-design/): eight 390 px wide HTML files with
inline styles. Open them in a browser and match them. They are references, not code:
their `support.js` and `/_blob/...` images won't load, and the figures in them
(Benjamin, Nakasagga, UGX 1,530,000) are one real example.

**Words:** every sentence comes from `coSupportInviteCopy(preview)` in
`src/lib/coSupport.ts` (tested). Don't write copy in JSX and don't compute amounts on
screen. The page never says "half". It says "to join".

**Design system:** Welile tokens.
- Grey page, one white card (16 px radius, the soft shadow in the boards), 20 px
  padding, 16 px gap.
- Headings: Plus Jakarta Sans. Body: DM Sans. Amounts: mono.
- Primary purple buttons: 48 px tall, 16 px radius.
- Use the existing tokens (`primary`, `destructive`, `success`), not the raw hsl values.
  For green **text**, use a darker success shade that passes contrast on white
  (the boards use hsl 142 72% 26–29%).
- Mobile first. On wider screens, centre the card at max-w-md.

### Shared parts, top to bottom (boards 1, 2, 3, 5)

1. **Sharer row.**
   - A 48 px round photo with a purple ring.
   - The image comes from `useCoSupportLeadPhoto(preview.lead_avatar_url)`, which
     returns a signed URL or null. When null, show the grey person silhouette from the
     boards. Alt text: `copy.leadPhotoAlt`.
   - Next to the photo: `copy.leadName` (semibold) above `copy.leadTagline` (small,
     muted).
2. **Headline** `copy.headline`: 22 px, bold.
3. **Photo.**
   - Rent Plan: `preview.house_image_url`, 196 px tall, cover, 12 px radius, alt
     `copy.photoAlt`.
   - No image: the light-purple placeholder with a house icon (board 5).
4. **House only:** `copy.houseLine` (semibold) and `copy.houseSubLine` (muted) under
   the photo.
5. **Intro:** `copy.intro`, muted, 14 px.
6. **Figure row** (boards 1, 3, 5): top and bottom borders.
   - Left: `copy.joinAmount` (mono, bold) over `copy.joinAmountLabel`.
   - An arrow in the middle.
   - Right: `copy.earningAmount` (mono, bold, purple) over `copy.earningLabel`.
   - Signed out: no arrow. The right side is the muted text `copy.earningSignedOut`.
7. **Countdown:** a clock icon and `copy.holdPrefix` followed by **`copy.holdTime`**
   in bold. Hide it when `copy.holdLine` is null.

### Board 1: short of float (`reason = 'funds_short'`)

- **Shared parts 1–7.**
- **Amber box:** a wallet icon and `copy.blockTitle` ("Add UGX 1,335,514 to join").
  - Under it, the rows of `copy.floatLines` (label left, mono amount right).
  - Then each of `copy.floatNotes` as a small line.
- **Primary button:** `copy.blockAction` ("Add float to join Benjamin"). It opens the
  Add float sheet (boards 1a–1c below).

### Board 2: ready to join (`can_accept`)

- **Shared parts 1–5,** then a **vertical timeline** from `copy.timeline` instead of the
  figure row.
  - Each step: `when` (small, semibold) over `text`, followed by `amount` in bold mono
    when set.
  - The dot follows `tone`:
    - `'now'`: filled purple, with a soft ring.
    - `'next'`: purple ring.
    - `'later'`: dashed ring.
  - A thin line joins the dots. No line after the last one.
  - Houses get an empty timeline: show the figure row instead.
- **Countdown.**
- **Buttons:**
  - `copy.acceptLabel` ("Join Benjamin"): primary, calls
    `useAcceptCoSupport().mutate(code)` as today.
  - `copy.declineLabel` ("Not this time"): white, **red border and red text**
    (destructive), calls `useDeclineCoSupport()` as today.

### Board 3: not signed in (`signed_in = false`)

- **Shared parts 1–7,** with the signed-out figure row.
- **Buttons:**
  - `copy.signInLabel` ("I have a Welile account"): primary, goes to
    `coSupportSignInPath(code)`.
  - `copy.joinLabel` ("I'm new to Welile"): white, **green border and green text**,
    with an external-link icon after the label. Goes to
    `coSupportOnboardingPath(code, preview.referrer_id)`.
- Under the buttons: `copy.signedOutHint`, small, centred.

### Board 4: joined (after an `ok` accept)

This screen has no card. Build it on the page itself, centred:

1. **Two overlapping 72 px avatars.**
   - The sharer: same photo hook as above.
   - The person who joined: their own profile photo through the app's usual avatar
     hook, or the silhouette.
   - A green tick badge sits where the two overlap, at the bottom.
2. **Green pill:** `copy.successPill` ("Benjamin + you · 50/50").
3. **Title and line:** `copy.successTitle` (24 px, extra bold), then
   `copy.successDetail` (muted).
4. **Gradient card** with the signature gradient
   `linear-gradient(137deg,#9234ea 0%,#7616d0 54%,#4a1da5 100%)` and white text. It
   reads from `copy.successCard`:
   - A 52 px house thumb, then `eyebrow` over `title`.
   - Two columns: `putInLabel` / `putIn`, and `earningLabel` / `earning` with a small
     " /mo". Hide the second column when `earning` is null.
   - A divider, then `firstLabel` left and `first` right.
5. **White card:** "What happens next" (`copy.nextStepsTitle`), listing
   `copy.nextSteps`.
   - `done`: a green filled circle with a tick.
   - Not done: a purple ring with the step number.
   - `title` is semibold, over `detail`.
6. **Buttons:**
   - `copy.seePortfolioLabel`: primary. Goes to `/dashboard/funder/portfolio`. Open
     `result.your_portfolio_id` there if that screen can focus one portfolio.
   - `copy.findAnotherLabel`: soft purple (primary/10 background, primary text). Goes
     to the funder's Rent Plan list (house: the empty-house list).

Use `coSupportInviteCopy({...preview, your_share: preview.your_share ?? result.your_share, kind: preview.kind ?? result.kind})`
for this screen, as the page does today.

### Board 5: empty house invitation

- **Shared parts 1–7,** with `houseLine` / `houseSubLine`.
- **Buttons** as on board 2.
- No "Example figures" line: it was a label on the design only.

### Boards 1a–1c: Add float without leaving the invitation

These open from board 1's button, as a bottom sheet over the invitation.

- **1a, how to pay: reuse `DepositFlow`.** Don't build a second deposit form or insert
  into `deposit_requests` yourself. DepositFlow already does the Transaction ID checks
  and the instant auto-verify.
  - Open it with:
    ```tsx
    <DepositFlow open onOpenChange={…}
      defaultPurpose="operational_float" lockPurpose
      defaultAmount={preview.float_needed} defaultChannel="momo" defaultMomoProvider="mtn"
      onSubmitted={(r) => setDeposit({ id: r.id, submittedAt: Date.now(), amount: r.amount, provider: r.provider })} />
    ```
  - `onSubmitted` is new. It fires once the deposit is saved, after the auto-verify
    attempt.
  - Use board 1a only for the header: `copy.depositTitle` ("Add UGX 1,335,514") and
    `copy.depositIntro`. Restyle inside DepositFlow only where it doesn't change what
    it submits.
- **When `onSubmitted` fires:** close DepositFlow and show the waiting sheet.
  - Drive it with
    `const { state, preview: fresh } = useCoSupportFloatWatch(code, user?.id, deposit)`.
  - This re-reads the invitation and the deposit every 4 s.
- **`state = 'waiting'`, board 1b:**
  - A spinner ring with a wallet icon.
  - `copy.waitingTitle`, then `copy.waitingDetail(deposit.provider)`.
  - A small table: Amount (`deposit.amount`) and the Transaction ID.
  - `copy.waitingNote`.
  - A white "Close" button. Closing is fine: the page keeps working.
- **`state = 'slow'`** (still pending after 2 minutes): same sheet, no spinner, with
  `copy.slowTitle` and `copy.slowDetail`.
- **`state = 'rejected'`:** `copy.rejectedTitle` and `copy.rejectedDetail`, with a
  button to open DepositFlow again.
- **`state = 'arrived'`, board 1c:**
  - A green tick in a soft green circle.
  - `copy.arrivedTitle`, then `copy.arrivedDetail(deposit.amount)`.
  - A row: `copy.arrivedFreeLabel` and the free float,
    `ugx(fresh.float_available)` (format as elsewhere).
  - Primary button `copy.arrivedAction` ("Join Benjamin now"). It closes the sheet and
    the page now shows board 2, because the preview says `can_accept`.

Other `reason`s (`agreement_required`, `not_a_partner`, `paused`, `invite_*`) keep
today's behaviour, styled like board 1's box (`blockTitle`, `blockDetail`,
`blockAction`). The sender's own view (`your_role = 'lead'`) is unchanged.

**Server:** `co_support_preview` returns `lead_avatar_url` from migration
`20261117090000_co_support_preview_lead_photo.sql`. Until that migration is live the
field is missing and the hook returns null, so the silhouette shows. Build the page
either way.

## Not in this phase

- **The new name for the 2% agent fee:** the owner is choosing. Keep today's wording.
- **Types:** `src/integrations/supabase/types.ts` is regenerated after the migration is
  applied. Don't hand-edit it.
