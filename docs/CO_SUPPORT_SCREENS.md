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

## Not in this phase

- **The new name for the 2% agent fee:** the owner is choosing. Keep today's wording.
- **Empty houses:** Phase 4.
- **Types:** `src/integrations/supabase/types.ts` is regenerated after the migration is
  applied. Don't hand-edit it.
