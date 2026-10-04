# Person-Name Standardisation — Design Decision Record

Card 02 (Reuse Audit: Extend vs Create). Read-only spike. Status: **decided**.
Date: 2026-08-12.

## 1. Decision

| Item | Decision | Reason |
| --- | --- | --- |
| Shared field component | **CREATE** `src/components/shared/PersonNameFields.tsx` | No generic person-name field component exists anywhere in the repo. |
| Split / join helpers | **EXTEND** `src/lib/authValidation.ts` | The single existing name authority (`validateFullName`) already lives there; a new module would create a second authority. |
| Validation rules | **EXTEND / REUSE ONLY** `validateFullName` | Fully implemented rule set already in place; no new rules are needed. |
| Error rendering | **REUSE** `src/components/shared/FieldError.tsx` | Already the standard inline error under registration/listing inputs. |
| Inputs / labels | **REUSE** `@/components/ui/input`, `@/components/ui/label` | Existing primitives; no new UI primitives. |

### Evidence

- `src/lib/authValidation.ts` — `validateFullName(raw)` returns `{ valid, trimmed, error }` and already enforces: min length, ≥ 2 name parts, ≥ 2 letters per part, gibberish rejection, junk-pattern sweep, and "first == last" rejection. It normalises whitespace via `.trim().replace(/\s+/g, ' ')`. It also backs `validateSignUp`. **This is the only name authority and must stay so.** There are no split/join helpers in the file.
- `src/pages/Onboarding.tsx` — hand-rolls the target behaviour: separate `form.firstName` / `form.lastName` raw `<input>` elements (~lines 793–811, not shadcn primitives), inline length checks `form.firstName.length >= 2 && form.lastName.length >= 2` (~line 1037) and per-field messages (~lines 1079–1080), then joins on submit as `` `${cleanFirst} ${cleanLast}`.trim() `` (~line 1336) for `partner_agreements.full_name`. It never calls `validateFullName`.
- `src/components/notifications/NameCompletionGate.tsx` — the mirror image: splits the stored name with `currentName.split(/\s+/).filter(Boolean)` (first = `parts[0]`, last = `parts.slice(1).join(" ")`), then rejoins with `` `${firstName.trim()} ${lastName.trim()}`.trim() `` and validates with `validateFullName`. Uses `Input` + `Label` correctly.
- `src/hooks/useAuthForm.ts` — single `fullName` string state (line 57) validated via `validateFullName` (line 402) and `validateSignUp` (line 404). No split fields; a pilot candidate but state-heavy.
- `src/lib/formContracts/` (`contracts.ts`, `validator.ts`, `types.ts`, `index.ts`) — a generic pre-submit *payload shape* validator (types, required, min/max length). `full_name` appears only as `{ type: 'text', required: true, minLength: 2, maxLength: 200 }`. Imported by just two files (`PaymentConfirmationForm.tsx`, `RentRequestButton.tsx`). It is **not** a name authority and will not be extended.
- `src/components/ui/form.tsx` — react-hook-form wrappers (`Form`, `FormField`, `FormItem`, `FormLabel`, `FormControl`, `FormMessage`). Available but *not required*: most in-scope flows are plain `useState` forms, so `PersonNameFields` must work standalone.
- `src/components/shared/FieldError.tsx` — `{ message, className }`, renders nothing when empty. Drop-in under any input.
- Repo scan for `PersonName`, `NameFields`, `SplitName`, `joinName`: **no existing component or helper**. The only textual hit is unrelated (`src/hr/components/ExecutiveBrief.tsx`).

**Conclusion:** exactly two duplicated implementations of the same split/join behaviour justify exactly one shared abstraction — one component + two helpers. Nothing more.

## 2. Component contract — `PersonNameFields`

Location: `src/components/shared/PersonNameFields.tsx`

```ts
export interface PersonNameValue {
  firstName: string;
  otherNames: string;
  lastName: string;
}

export interface PersonNameFieldsProps {
  value: PersonNameValue;
  onChange: (next: PersonNameValue) => void;
  disabled?: boolean;
  required?: boolean;   // default true
  idPrefix: string;     // e.g. "signup" -> ids signup-first-name, signup-other-names, signup-last-name
  className?: string;
}
```

Rules:
- **Fully controlled.** No internal state (no `useState`, no `useEffect`).
- No submission logic, no `supabase` calls, no data fetching, no toasts, no navigation.
- Field order and labels: **First Name** (required), **Other Names** (optional), **Last Name** (required).
- `autoComplete`: `given-name`, `additional-name`, `family-name`. `autoCapitalize="words"`.
- Uses `@/components/ui/input` and `@/components/ui/label` only; per-field errors, when a caller supplies them, render via existing `FieldError`. No new styling tokens, no hardcoded colours.
- `className` is merged with `cn(...)` onto the wrapper only.

## 3. Helper contracts — added to `src/lib/authValidation.ts`

```ts
export interface PersonNameParts {
  firstName: string;
  otherNames: string;
  lastName: string;
}

export const joinPersonName = (parts: Partial<PersonNameParts>) => string;
export const splitPersonName = (fullName: string | null | undefined) => PersonNameParts;
```

`joinPersonName` — trims each part, drops empties, joins the survivors with a single space in the order `First Other Last`, and collapses any internal runs of whitespace. Returns `''` when all parts are empty. Output is byte-identical to what today's flows already send (`"First Last"` when `otherNames` is empty).

`splitPersonName` — tokenises on `/\s+/` after trimming, then:

| Tokens | firstName | otherNames | lastName |
| --- | --- | --- | --- |
| 0 | `''` | `''` | `''` |
| 1 | `token[0]` | `''` | `''` |
| 2 | `token[0]` | `''` | `token[1]` |
| 3+ | `token[0]` | middle tokens joined by single spaces | last token |

Round-trip guarantee: `joinPersonName(splitPersonName(s)) === s.trim().replace(/\s+/g, ' ')`.

## 4. Validation policy

- `validateFullName(joinPersonName(value))` is the **only** name rule set. Its `trimmed` output is what gets submitted/stored.
- Plus a per-field required check: when `required`, `firstName` and `lastName` must each be non-empty after trim (message wording reused from the existing flows: "first name", "last name").
- `otherNames` is never required and is never validated on its own.
- No new regex. No new validation module. No competing rules. `formContracts` remains untouched.

## 5. Explicitly NOT being built

- No new form library, and no mandatory react-hook-form adoption.
- No React context provider, no name store, no global state.
- No new validation module and no changes to `src/lib/formContracts/`.
- No new UI primitives (no custom input/label) and no new styling tokens or CSS variables.
- No new hook (no `usePersonName`).
- No backend, RPC, migration, edge-function, column or payload-shape change. The database keeps receiving one concatenated `full_name` string.
- No auto-fixing/auto-capitalising of user input beyond whitespace normalisation.

## 6. Test cases for Card 03 (to implement, not now)

`splitPersonName`:
1. `''` → all empty; also `null`, `undefined`, `'   '`.
2. `'Alice'` → `{ Alice, '', '' }`.
3. `'Alice Nakato'` → `{ Alice, '', Nakato }`.
4. `'Alice Grace Nakato'` → `{ Alice, 'Grace', Nakato }`.
5. `'Alice Grace Mary Nakato'` → `{ Alice, 'Grace Mary', Nakato }`.
6. `'  Alice   Grace   Nakato  '` → same as case 4 (whitespace collapsed).
7. Tabs/newlines treated as whitespace.

`joinPersonName`:
8. `{ Alice, '', Nakato }` → `'Alice Nakato'`.
9. `{ Alice, 'Grace', Nakato }` → `'Alice Grace Nakato'`.
10. `{ ' Alice ', '  ', ' Nakato ' }` → `'Alice Nakato'` (empty middle dropped).
11. All empty → `''`.
12. Missing keys (`Partial`) do not throw.

Round-trip:
13. `joinPersonName(splitPersonName(x)) === x.trim().replace(/\s+/g,' ')` for cases 2–7.

Validation integration:
14. `validateFullName(joinPersonName({ Alice, '', Nakato }))` → valid.
15. Single token (`{ Alice, '', '' }`) → invalid with the existing "at least two names" error.
16. `{ John, '', John }` → invalid via the existing identical-first/last rule.
17. Gibberish / junk parts still rejected by `validateFullName` unchanged.

Component (`PersonNameFields`):
18. Renders three labelled inputs with ids derived from `idPrefix`.
19. Typing in each field calls `onChange` with the full merged object, other keys unchanged.
20. `disabled` disables all three inputs.
21. Holds no internal state — re-render with a new `value` prop is reflected immediately.

## 7. Pilot flow for Card 04

**Signup / auth flow** — `src/hooks/useAuthForm.ts` + its signup form UI. Chosen because it is the highest-traffic capture point, it already calls `validateFullName`/`validateSignUp` (so the authority is unchanged), and it stores a single `fullName` string — proving the split UI → joined string contract with a byte-identical submitted payload before the pattern spreads. `NameCompletionGate.tsx` and `Onboarding.tsx` are consolidated in Card 05, not here.

---

# 8. Final Audit & Handoff (Card 10)

## 8.1 Diff verification — frontend-only

Board range: first helper commit (`joinPersonName` added to `src/lib/authValidation.ts`) → HEAD.
`git diff --name-only <board-start>^..HEAD` returns **44 files, all under `src/`**. Filtering the same list
with `rg -v '^src/'` returns nothing, so:

- zero changes under `supabase/` (no migrations, no edge functions, no `config.toml`);
- zero `.sql` files;
- no `src/integrations/supabase/client.ts`, no `types.ts`, no `.env`;
- no `e2e/` spec was touched (the only name selector in `e2e/business-advance-dialog.spec.ts`
  belongs to `BusinessAdvanceRequestDialog`, which is out of scope and unchanged).

## 8.2 No API/payload change

- Grep of all added diff lines for `first_name`, `last_name`, `other_names` → **no matches**.
  The split parts exist only as camelCase React state (`firstName` / `otherNames` / `lastName`)
  and never leave the browser.
- Every submission still writes the same single concatenated string into the same key it used before:
  `full_name`, `landlord_name`, `lc1_name`, `tenant_name`, `employee_name`, `partner_name`,
  `cash_owner_name`, `applicant_name`, `depositor_name`. The only diff on those lines is the value
  source (`nameCheck.trimmed` → `nameCheck.fullName`, or `` `${first} ${last}` `` → `cleanFullName`),
  never the key.
- No form library replaced, no folder moved, no unrelated rename, no UI redesign, and no duplicate
  helper left behind — `joinPersonName` / `splitPersonName` / `validatePersonNameParts` live only in
  `src/lib/authValidation.ts` and the hand-rolled splits they replaced were deleted.

## 8.3 Files touched (44)

Shared foundation: `src/lib/authValidation.ts`, `src/components/shared/PersonNameFields.tsx`.
Account owner: `src/hooks/useAuthForm.ts`, `src/pages/Auth.tsx`, `src/pages/Onboarding.tsx`,
`src/pages/Settings.tsx`, `src/components/notifications/NameCompletionGate.tsx`.
Tenant / landlord / LC1: `RegisterTenantPublic.tsx`, `LandlordSignup.tsx`,
`agent/QuickRegisterTenantDialog.tsx`, `agent/RegisterTenantDialog.tsx`, `agent/EditTenantDialog.tsx`,
`agent/AgentRentRequestDialog.tsx`, `agent/AgentEditRentRequestDialog.tsx`,
`shared/LandlordRegistrationForm.tsx`, `ops/UserDrilldownDrawer.tsx`.
Staff / agent / merchant / partner / admin: `admin/RegisterEmployeeDialog.tsx`,
`agent/RegisterSubAgentDialog.tsx`, `agent/CreateUserInviteDialog.tsx`,
`manager/CreateUserInviteDialog.tsx`, `manager/UserDetailsDialog.tsx`, `agent/PromissoryNoteDialog.tsx`,
`agent/FunderManagementSheet.tsx`, `financial-ops/StartCashDepositDialog.tsx`,
`financial-ops/ManualFloatCreditPanel.tsx`, `pages/MerchantRegister.tsx`,
`pages/InviteMerchantAgent.tsx`, `pages/BecomeSupporter.tsx`, `pages/RegisterPartnerPublic.tsx`,
`pages/ActivatePartner.tsx`, `pages/ActivateSupporter.tsx`, `pages/PublicRequisitionForm.tsx`,
`pages/Internship.tsx`, `pages/Careers.tsx`.
Tests: `src/lib/tests/personName.test.ts`, `src/components/shared/tests/PersonNameFields.test.tsx`
(+ snapshot), `src/hooks/tests/useAuthForm.personName.test.ts`,
`src/pages/tests/{AuthSignupName,OnboardingName,SettingsName}.test.tsx`,
`src/components/notifications/tests/NameCompletionGate.test.tsx`,
`src/components/agent/tests/PromissoryNoteName.test.tsx`,
`src/components/financial-ops/tests/StartCashDepositName.test.tsx`.

## 8.4 Flows excluded (and why)

- **Non-person names** — property / house / village / district / business / department / role / plan names.
  Out of scope by definition.
- **Read-only displays** — `YourProfile.tsx`, `FunderDetailView.tsx`, `hr/StaffScorecard.tsx`,
  `admin/Users.tsx` tables, `PortfolioCompletion` read-only rows. No capture, nothing to standardise.
- **Financial-account holder names** — `WithdrawRequestDialog.tsx` ("Full name on account"),
  `cfo/DirectCreditTool.tsx` ("Account holder full name"). These mirror a bank/MoMo account label
  that must be typed exactly as the telecom/bank holds it; splitting risks re-ordering the string.
- **`BusinessAdvanceRequestDialog.tsx` guarantor fields** — an `e2e/` spec asserts the literal
  `placeholder="Full name *"`; excluded from this board to keep the diff free of spec churn.
- **Search inputs** that accept a name as a query (landlord search, transfer-agent search).

## 8.5 Remaining name-entry locations found (follow-up backlog, not regressions)

Person-name capture points still on a single input, none of which were in the card-01 in-scope list:

- Next of kin: `pages/Onboarding.tsx` (`kinName`), `agent/CreateUserInviteDialog.tsx`
  (`nextOfKinName`), `pages/PortfolioCompletion.tsx` (`nok-name`).
- Landlord name on house flows: `agent/EditHouseListingDialog.tsx`,
  `agent/AgentManagedPropertyDialog.tsx`, `agent/ListEmptyHouseDialog.tsx`.
- LC1 chairperson: `vouch/borrower/BorrowerResidenceGate.tsx`.
- Admin/exec edit dialogs: `pages/hr/EmployeeProfile.tsx`, `pages/coo/ActivePartnersDetail.tsx`,
  `coo/COOPartnersPage.tsx`, `cto/MerchantLoginLinkCard.tsx`,
  `agent/AgentAngelPoolInvestDialog.tsx`.

All are single-string capture into the existing key, so they remain functionally correct; migrating
them is a straight repeat of the pattern in this board.

## 8.6 Verification results

- **Types**: `npx tsgo --noEmit` → exit 0, clean.
- **Suite**: `bunx vitest run` → `Test Files 7 failed | 60 passed (67)`,
  `Tests 13 failed | 751 passed | 3 skipped (767)`. **New failures: 0.**
- **Pre-existing failures (13, unrelated to names, unchanged in count)**:
  `wallet/__tests__/SendMoneyDialog.test.tsx` (5, phone lookup/tooltip copy),
  `__tests__/subAgentCommissionCopy.test.ts` (2), `hooks/__tests__/classifyDailyRating.test.ts` (2),
  `__tests__/agentResubmitRentRequest.integration.test.ts` (1),
  `test/kampala-district-regression.test.ts` (1),
  `test/processSupporterRoiManagedProxy.test.ts` (1),
  `agent/AgentRentRequestDialog.undo.test.tsx` (1 — expects a landlord-search placeholder that does
  not exist in the last 8 revisions of that component, so it predates this board).
- **Preview check**: `/settings` on a live 3-token account hydrates as
  First `Timothy` / Other `Christian` / Last `Waniaye`, re-joining to the identical stored
  `"Timothy Christian Waniaye"`. 2-token hydration and byte-identical round-trip are asserted in
  `SettingsName.test.tsx` and `NameCompletionGate.test.tsx` (`"Alice Namono"` and
  `"Timothy Christian Waniaye"` both re-save unchanged), plus round-trip stability in
  `src/lib/tests/personName.test.ts`.

## 8.7 Handoff

The standard is: capture with `PersonNameFields`, hydrate with `splitPersonName`, validate with
`validatePersonNameParts`, submit `joinPersonName(...)` into the pre-existing single string key.
No backend, RPC, edge-function or column change was made or is required. Any new person-name field
should follow the same four steps; the backlog in 8.5 is the only remaining in-repo work.
