# Person-Name Capture Inventory (Card 01 — read-only discovery)

Status: discovery only. **Zero code edits were made.** This document is the sole artefact.
Date: 2026-08-12. Scope: frontend person-name CAPTURE/EDIT inputs only.

---

## 1. Method — searches actually run

All searches were run with `rg` against `src/` (not guessed). Raw hit counts:

| Term | Files | Hits | Notes |
| --- | ---: | ---: | --- |
| `full_name` | 577 | 2818 | Overwhelmingly display/select/report; only 30 are capture points |
| `fullName` | 70 | 274 | Mostly local state + display |
| `setFullName` | 13 | 34 | Strong capture signal — all 13 reviewed |
| `firstName` | 7 | 23 | Only 2 are person-name capture (Onboarding, NameCompletionGate) |
| `lastName` | 4 | 17 | Same 2 files + 2 test/bench files |
| `other_names` | 0 | 0 | **Field does not exist anywhere today** (new concept) |
| `Full name` / `Full Name` | 31 | 35 | Labels/placeholders — reviewed individually |
| `validateFullName` | 9 | 28 | The only shared validator; used by 8 call sites |
| `depositor_name` | 9 | 46 | 3 capture points, rest display/report |
| `applicant_name` | 0 | 0 | Internship uses `full_name`, not `applicant_name` |
| `tenant_name` | 140 | 492 | Almost all display/report; 2 capture payload keys |
| `landlord_name` | 100 | 419 | Mostly display; 4 capture points |
| `lc1` | 42 | 821 | 7 capture points (chairperson name) |
| `Input` + `Label`/placeholder mentioning a person | — | — | Swept per directory (agent, tenant, landlord, shared, vouch, manager, admin, hr, executive, ops, cfo, financial-ops, partner, coo, wallet, cto) |

Every hit was classified as **(a) capture/edit → in scope**, **(b) display/greeting/initials/PDF/report/search/audit-string → excluded**, or **(c) non-person name → excluded**. Exclusion rules are in §5 and cover the remaining hits in bulk.

---

## 2. Existing reusable pieces (noted, NOT modified)

| Piece | Path | What it does today |
| --- | --- | --- |
| `validateFullName` | `src/lib/authValidation.ts:86-146` | trims, ≥2 chars, ≥2 parts, each part ≥2 letters, rejects dummy words / keyboard mash / identical first+last. Returns `{valid, error, trimmed}` |
| `validateSignUp` | `src/lib/authValidation.ts:148-158` | wraps `validateFullName` + password/phone |
| `FieldError` | `src/components/shared/FieldError.tsx` | inline error text |
| `FormFeedback` | `src/components/shared/FormFeedback.tsx` | form-level feedback |
| `Input` / `Label` / `Form` | `src/components/ui/{input,label,form}.tsx` | shadcn primitives |
| `formatNameInput` | `src/components/agent/AgentRentRequestDialog.tsx:442` | **local, not exported** title-case/space cleanup — a de-facto pattern to fold into the shared component |
| `normalizeName` | `src/lib/tenantSearch.ts` | search normalization only; not a capture validator |
| zod name schema | `src/components/agent/EditTenantDialog.tsx:35` | `z.string().trim().min(2).max(100)` — one-off duplicate of the validator |

**Existing split first/last precedent (2 places, both hand-rolled):** `src/pages/Onboarding.tsx:794-810` and `src/components/notifications/NameCompletionGate.tsx:27-28,60-70`.

---

## 3. In-scope inventory — one row per input

Columns: file:line · component · field/state · create|edit · shape · validation today · submit path · payload field · helper used.

### 3.1 Auth, signup and self-service profile

| # | File:line | Component | Field/state | C/E | Shape | Validation | Submit path | Payload field | Helper |
| --: | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | `src/hooks/useAuthForm.ts:57,402` (input `src/pages/Auth.tsx:1234-1242`) | useAuthForm / Auth | `fullName` | C | single | `validateFullName` + `validateSignUp` + `check_fraud_account_by_name` RPC | `functions.invoke('phone-signup')` / signUp metadata | `full_name` | ✅ shared |
| 2 | `src/pages/Onboarding.tsx:794-810,1247` | Onboarding | `form.firstName`, `form.lastName` | C | **split** | `sanitizeInput` only (no shape rules) | `registerUser(...)` + `from('partner_agreements').upsert` (`:1332`) | `full_name` (joined `${first} ${last}`) | ❌ none |
| 3 | `src/pages/Onboarding.tsx:715` | Onboarding | `form.kinName` (next of kin) | C | single | none | `partner_agreements.upsert` | `kin_name` | ❌ |
| 4 | `src/components/notifications/NameCompletionGate.tsx:27-28,67` | NameCompletionGate | `firstName`, `lastName` | E | **split** | `validateFullName(combined)` | `from('profiles').update` (`:74`) | `full_name` | ✅ shared |
| 5 | `src/pages/Settings.tsx:191,462` | Settings | `fullName` | E | single | `!trim()` only | `from('profiles').update` (`:285`) | `full_name` | ❌ |
| 6 | `src/pages/PortfolioCompletion.tsx:81,419` | PortfolioCompletion | `kinName` | E | single | `length < 3` | `functions.invoke('submit-portfolio-completion')` (`:266`) | `kin_name` | ❌ |

### 3.2 Public registration / activation pages

| # | File:line | Component | Field/state | C/E | Shape | Validation | Submit path | Payload field | Helper |
| --: | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 7 | `src/pages/RegisterTenantPublic.tsx:81,476` | RegisterTenantPublic | `fullName` | C | single | `validateFullName` (`:195`) | insert payload `:211` | `full_name` | ✅ |
| 8 | `src/pages/RegisterTenantPublic.tsx:503` | ″ | `landlordName` | C | single | `validateFullName` (`:196`) | same payload | `landlord_name` | ✅ |
| 9 | `src/pages/RegisterTenantPublic.tsx:551` | ″ | `lc1Name` | C | single | `validateFullName` (`:197`) | same payload | `lc1_chairperson_name` | ✅ |
| 10 | `src/pages/RegisterPartnerPublic.tsx:51,230` | RegisterPartnerPublic | `fullName` | C | single | `validateFullName` (`:120`) | insert payload `:128` | `full_name` | ✅ |
| 11 | `src/pages/LandlordSignup.tsx:41,218-221` | LandlordSignup | `form.fullName` | C | single | `validateFullName` (`:53,59`) | signup/registerUser path | `full_name` | ✅ |
| 12 | `src/pages/MerchantRegister.tsx:41,206-209` | MerchantRegister | `fullName` | C | single | **re-implemented** 2-part split check (`:77`) | `functions.invoke('phone-signup')` (`:123`) then `profiles.update` (`:159`) | `full_name` | ❌ duplicate logic |
| 13 | `src/pages/ActivatePartner.tsx:41,231` | ActivatePartner | `fullName` | E (activate) | single | 2-part check, not shared | update at `:127` | `full_name` | ❌ |
| 14 | `src/pages/ActivateSupporter.tsx:55,676-680` | ActivateSupporter | `fullName` | E (activate) | single | `!trim()` | `functions.invoke('activate-supporter')` (`:215`) | `fullName` **(camelCase outlier)** | ❌ |
| 15 | `src/pages/InviteMerchantAgent.tsx:63,97` | InviteMerchantAgent | `fullName` | C | single | `length >= 3` | localStorage intake → `profiles.update` (`:143,159`) | `full_name` | ❌ |
| 16 | `src/pages/Internship.tsx:28,156` | Internship | `form.fullName` | C | single | `!trim()` (`:41`) | `from('internship_applications').insert` (`:53`) | `full_name` | ❌ |
| 17 | `src/pages/Careers.tsx:37,222` | Careers | `form.fullName` | C | single | `!trim()` (`:78`) | insert (`:95`) | `full_name` | ❌ |
| 18 | `src/pages/PublicRequisitionForm.tsx:43,205` | PublicRequisitionForm | `form.employee_name` | C | single | `length >= 2` (`:92`) | `fetch('/functions/v1/requisition-submit')` (`:128`) | `employee_name` | ❌ |

### 3.3 Agent / tenant / landlord operational dialogs

| # | File:line | Component | Field/state | C/E | Shape | Validation | Submit path | Payload field | Helper |
| --: | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 19 | `src/components/shared/LandlordRegistrationForm.tsx:226,370` | LandlordRegistrationForm | `landlordName` | C | single | `validateFullName` (`:118,133`) | `from('supporter_invites').insert` | `full_name` | ✅ |
| 20 | `src/components/shared/LandlordRegistrationForm.tsx:238,1021` | ″ | `lc1Name` | C | single | trim only | `rpc('find_lc1_by_phone')` then `from('lc1_chairpersons').insert` (`:656-668`) | `name` | ❌ |
| 21 | `src/components/agent/QuickRegisterTenantDialog.tsx:39,146` | QuickRegisterTenantDialog | `fullName` | C | single | `validateFullName` (`:69`) | `from(...).insert` (`:83`) | `full_name` | ✅ |
| 22 | `src/components/agent/RegisterTenantDialog.tsx:80,622` | RegisterTenantDialog | `tenantFullName` | C | single | trim only (`:305`) | `functions.invoke('register-tenant')` | `full_name` | ❌ |
| 23 | `src/components/agent/RegisterTenantDialog.tsx:92,716` | ″ | `landlordName` | C | single | trim only | same invoke | `landlord.name` | ❌ |
| 24 | `src/components/agent/RegisterTenantDialog.tsx:103,899` | ″ | `lc1Name` | C | single | trim only | same invoke | `lc1.name` | ❌ |
| 25 | `src/components/agent/EditTenantDialog.tsx:79,816` | EditTenantDialog | `fullName` | E | single | local zod `min(2).max(100)` (`:35`) | diffed `from('profiles').update` (`:424`) | `full_name` | ❌ (zod dup) |
| 26 | `src/components/agent/RegisterSubAgentDialog.tsx:211` | RegisterSubAgentDialog | `formData.fullName` | C | single | `required` only | `functions.invoke('create-supporter-invite')` (`:99`) | `fullName` | ❌ |
| 27 | `src/components/agent/AgentRentRequestDialog.tsx:694,3746` | AgentRentRequestDialog | `tenantName` | C | single | `formatNameInput` + presence | draft `rent_request_drafts.insert` (`:1630`) and `functions.invoke('register-tenant')` (`:2823`) | `tenant_name` (draft) / `full_name` (fn) | ⚠️ local formatter |
| 28 | `src/components/agent/AgentRentRequestDialog.tsx:722,933` | ″ | `landlordName` | C | single | presence | same invoke | `landlord.name` | ⚠️ |
| 29 | `src/components/agent/AgentRentRequestDialog.tsx:739,1170` | ″ | `lc1Name` | C | single | presence | same invoke | `lc1.name` | ⚠️ |
| 30 | `src/components/agent/AgentEditRentRequestDialog.tsx:57,365` | AgentEditRentRequestDialog | `landlordName` | E | single | presence | landlord update (`:240`) | `landlord_name` | ❌ |
| 31 | `src/components/agent/CreateUserInviteDialog.tsx:382,533` | agent CreateUserInviteDialog | `formData.fullName` | C | single | `required` | `functions.invoke('create-supporter-invite')` (`:218`) | `full_name` | ❌ |
| 32 | `src/components/agent/CreateUserInviteDialog.tsx:424` | ″ | `supporterData.nextOfKinName` | C | single | presence | same invoke (`:207`) | `next_of_kin_name` | ❌ |
| 33 | `src/components/agent/ListEmptyHouseDialog.tsx:279,1909` | ListEmptyHouseDialog | `form.landlord_name` | C/E | single | presence (`:980`) | `rpc('find_landlord_duplicate')` then `from('landlords').insert` (`:1152`) | `name` | ❌ |
| 34 | `src/components/agent/ListEmptyHouseDialog.tsx:2127` | ″ | `form.caretaker_name` | C | single | presence | same insert | `caretaker_name` | ❌ |
| 35 | `src/components/agent/Lc1ChairpersonPicker.tsx:274-278` | Lc1ChairpersonPicker | `value.name` (new LC1) | C | single | `!trim()` styling only | parent payload → `lc1_chairpersons` / `lc1_chairperson_name` | `name` | ❌ |
| 36 | `src/components/agent/AgentAngelPoolInvestDialog.tsx:59,322-326` | AgentAngelPoolInvestDialog | `regName` | C | single | presence | `functions.invoke('register-proxy-funder')` (`:168`) | `full_name` | ❌ |
| 37 | `src/components/tenant/RentRequestForm.tsx:108,675` | RentRequestForm | `tenantFullName` | E (self) | single | presence | `from('profiles').update` (`:332`) | `full_name` | ❌ |
| 38 | `src/components/tenant/RentRequestForm.tsx:116` | ″ | `landlordName` | C | single | presence | `from('landlords').insert` | `name` | ❌ |
| 39 | `src/components/tenant/RentRequestForm.tsx:125,851` | ″ | `lc1Name` | C | single | presence | `from('lc1_chairpersons').insert` | `name` | ❌ |
| 40 | `src/components/tenant/RentRequestButton.tsx:214,686` | RentRequestButton | `landlordName` | C | single | presence (`:404`) | `from('landlords').insert` (`:269`) | `name` | ❌ |
| 41 | `src/components/tenant/RentRequestButton.tsx:221,737` | ″ | `lc1Name` | C | single | presence | `from('lc1_chairpersons').insert` (`:288`) | `name` | ❌ |
| 42 | `src/components/landlord/RegisterPropertyDialog.tsx:73,508` | RegisterPropertyDialog | `caretakerName` | C | single | presence | `from('landlords').insert` (`:219`) | `caretaker_name` | ❌ |
| 43 | `src/components/landlord/RegisterPropertyDialog.tsx:86,672` | ″ | `lc1Name` | C | single | presence | `from('lc1_chairpersons').insert` (~`:299`) | `name` | ❌ |
| 44 | `src/components/vouch/borrower/BorrowerResidenceGate.tsx:123,427` | BorrowerResidenceGate | `lc1Form.name` | C | single | `!trim()` (`:290`) | `from('lc1_chairpersons').insert` (`:297`) | `name` | ❌ |

### 3.4 Admin / manager / HR / executive / ops / finance

| # | File:line | Component | Field/state | C/E | Shape | Validation | Submit path | Payload field | Helper |
| --: | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 45 | `src/components/admin/RegisterEmployeeDialog.tsx:26,161` | RegisterEmployeeDialog | `form.fullName` | C | single | presence (`:51`); also feeds `generateEmployeeId` | `functions.invoke('register-employee')` (`:73`) | `full_name` | ❌ |
| 46 | `src/components/manager/CreateUserInviteDialog.tsx:240` | manager CreateUserInviteDialog | `formData.fullName` | C | single | none client-side | `functions.invoke('create-supporter-invite')` (`:108`) | `fullName` | ❌ |
| 47 | `src/components/manager/UserDetailsDialog.tsx:165,1654,2306` | UserDetailsDialog | `editForm.full_name` | E | single | none | `from('profiles').update` (`:717`) | `full_name` | ❌ |
| 48 | `src/components/executive/TenantDetailPanel.tsx:52,800` | TenantDetailPanel | `profileEdit.full_name` | E | single | `!trim()` (`:460`) | `from('profiles').update` (`:475`) | `full_name` | ❌ |
| 49 | `src/components/ops/UserDrilldownDrawer.tsx:243,332` | UserDrilldownDrawer / ProfileHeader | `name` | E | single | none (only 10-char reason) | `rpc('ops_update_user_identity')` (`:255`) | `p_full_name` | ❌ |
| 50 | `src/pages/hr/EmployeeProfile.tsx:68,696` | EmployeeProfile | `editName` | E | single | `if (editName.trim())` optional | profile update (`:191`) | `full_name` | ❌ |
| 51 | `src/pages/coo/ActivePartnersDetail.tsx:65,613` | ActivePartnersDetail | `editName` | E | single | none | `from('profiles').update` (`:281`) | `full_name` | ❌ |
| 52 | `src/components/executive/landlord-ops/EditLandlordDialog.tsx:167` | EditLandlordDialog | `form.name` | E | single | none | `from('landlords').update` (`:124`) | `name` | ❌ |
| 53 | `src/components/executive/landlord-ops/EditLandlordDialog.tsx:254` | ″ | `form.caretaker_name` | E | single | none | same update | `caretaker_name` | ❌ |
| 54 | `src/components/executive/landlord-ops/EditLC1Dialog.tsx:32,164` | EditLC1Dialog | `form.name` | E | single | none | `from('lc1_chairpersons').update` (`:110`) + `house_listings.update` (`:107`) | `name` | ❌ |
| 55 | `src/components/financial-ops/StartCashDepositDialog.tsx:30,117` | StartCashDepositDialog | `ownerName` | C | single | whitespace normalize only (`:40`) | `functions.invoke('finops-cash-deposit-initiate')` (`:61`) | `depositor_name` | ❌ |
| 56 | `src/components/financial-ops/ManualFloatCreditPanel.tsx:34,150` | ManualFloatCreditPanel | `depositorName` | C | single | `length >= 2` (`:47`) | `rpc('finops_manual_float_credit')` (`:53`) | `p_depositor_name` | ❌ |
| 57 | `src/components/partner/PartnerCompanyDefaultsDialog.tsx:26,141` | PartnerCompanyDefaultsDialog | `repName` | E | single | `!trim()` (`:79`) | `partner_agreement_company_defaults` update/insert (`:100`) | `rep_name` | ❌ |

**In-scope count: 57 person-name capture/edit inputs across 39 files.**
Of these, only **8 use `validateFullName`** and only **2 are split first/last** today.

---

## 4. Hydration points (stored name → editable input)

These are the places the split-on-hydrate work must handle. A stored single string must be split back into First / Last / Other on load, and re-joined byte-identically if untouched.

| # | File:line | Source of stored value | Target field |
| --: | --- | --- | --- |
| H1 | `src/components/notifications/NameCompletionGate.tsx:40-52` | `profiles.full_name` | `firstName` + `lastName` (already splits) |
| H2 | `src/pages/Settings.tsx:239` | `profiles.full_name` | `fullName` |
| H3 | `src/pages/PortfolioCompletion.tsx:186` | `partner_agreements.kin_name` | `kinName` |
| H4 | `src/pages/PortfolioCompletion.tsx:192,194` | `profiles.full_name` fallback | `momoName`, `bankAccountName` (payout names) |
| H5 | `src/components/agent/EditTenantDialog.tsx:79,134` | `tenant.full_name` | `fullName` |
| H6 | `src/components/agent/QuickRegisterTenantDialog.tsx:49` | duplicate-match `m.full_name` | `fullName` |
| H7 | `src/components/agent/RegisterTenantDialog.tsx:86` | duplicate-match `m.full_name` | `tenantFullName` |
| H8 | `src/components/agent/AgentRentRequestDialog.tsx:2100,2129,2141,2184` | draft / duplicate / renewal record | `tenantName` |
| H9 | `src/components/agent/AgentRentRequestDialog.tsx:933` | request history `h.landlord_name` | `landlordName` |
| H10 | `src/components/agent/AgentEditRentRequestDialog.tsx:57-60` | `landlordOriginal.name` | `landlordName` |
| H11 | `src/components/agent/ListEmptyHouseDialog.tsx:318` | `initialLandlordName` prop | `form.landlord_name` |
| H12 | `src/components/agent/ListEmptyHouseDialog.tsx:631,833` | landlord search `hit.name` | `form.landlord_name` |
| H13 | `src/components/agent/Lc1ChairpersonPicker.tsx:283-290` | phone-contact pick `{name}` | `value.name` |
| H14 | `src/components/manager/UserDetailsDialog.tsx` (edit tab init) | `user.full_name` | `editForm.full_name` |
| H15 | `src/components/executive/TenantDetailPanel.tsx:448` | `profile.full_name` | `profileEdit.full_name` |
| H16 | `src/components/ops/UserDrilldownDrawer.tsx:243` | `profile.full_name` (init-only, may go stale) | `name` |
| H17 | `src/pages/hr/EmployeeProfile.tsx:252` | `employee.profile.full_name` | `editName` |
| H18 | `src/pages/coo/ActivePartnersDetail.tsx:283` | row `r.name` ← `profiles.full_name` | `editName` |
| H19 | `src/components/executive/landlord-ops/EditLandlordDialog.tsx:51-59` | `landlords.name`, `caretaker_name` | `form.*` |
| H20 | `src/components/executive/landlord-ops/EditLC1Dialog.tsx:51` | `lc1_chairpersons.name` | `form.name` |
| H21 | `src/components/partner/PartnerCompanyDefaultsDialog.tsx:49` | `rep_name` | `repName` |
| H22 | `src/components/wallet/WithdrawRequestDialog.tsx:290-292` | saved payout method names | `momoName`, `bankAccountName` (see §5 ambiguity) |
| H23 | `src/components/manager/CreateUserInviteDialog.tsx:121` | server echo `invite.full_name` | local state (not a visible input) |

**23 hydration points; 22 feed an editable input.**

---

## 5. Exclusion rules (cover all remaining search hits)

| Rule | Applies to | Examples |
| --- | --- | --- |
| **X1 Display / greeting / initials** | any `full_name` rendered in text, avatar initials, toasts, badges, table cells | `src/pages/YourProfile.tsx` (read-only by design, `:18-21`), `src/hr/components/StaffScorecard.tsx:383`, `src/components/executive/SignupSourceLogPanel.tsx:443`, `src/components/agent/AgentAngelPoolInvestDialog.tsx:237-556`, `src/pages/BecomeSupporter.tsx:75-80` (referrer banner) |
| **X2 PDF / report / CSV export** | name strings composed for artefacts | `src/lib/tenantProfilePdf.ts:149`, `src/lib/rentRequestFormPdf.ts:45,83`, `src/lib/landlordRegistrationFormPdf.ts:159,199`, `src/lib/receiptPdf.ts:112,148`, `src/lib/tenantRegistrationFormPdf.ts:131`, `src/pages/UserManagement.tsx:405`, `src/pages/InviteMerchantAgent.tsx:113,129,131`, `src/components/agent/AgentRentRequestDialog.tsx:3300`, `src/components/tenant/agreement/*` contract placeholders |
| **X3 Search / lookup / filter boxes** | typed text used only to query, never persisted | `src/pages/admin/Users.tsx:198`, `src/pages/PartnerOnboarding.tsx:150`, `src/hr/components/StaffDirectory.tsx` filters, `src/components/executive/AgentTenantSearch.tsx`, `src/components/vouch/.../BorrowerResidenceGate.tsx:590` (`lc1Search`), `src/components/manager/CreateInvestmentAccountDialog.tsx:214` |
| **X4 Read-only admin/ops tables & queues** | ~500 of the `full_name` / `tenant_name` / `landlord_name` hits | `LandlordOpsDashboard.tsx`, `TenantOpsDashboard.tsx`, `RentPipelineQueue.tsx`, `FundedTenantsList.tsx`, `WithdrawalRequestsManager.tsx`, `HRInternshipApplications.tsx` (list only), `SubAgentAnalytics.tsx`, etc. |
| **X5 Denormalized audit/system snapshots** | name written into a payload from the session profile, never typed | `BorrowerResidenceGate.tsx:324,349` (`agent_name`), `EditTenantDialog.tsx:293` (`tenant_name` in audit log), `RouteEmailDepositDialog.tsx` (all `*_user_name` reason strings) |
| **X6 Non-person names** | business, bank, institution, product, item, portfolio, venue, district/village, property, momo provider label | `bank_name` (`EditLandlordDialog.tsx:204` — the institution), `landlordBankName` (`RentRequestButton.tsx:217`), `account_name` (`CreateInvestmentAccountDialog.tsx:400` — portfolio label), payout-method `nickname` (`Onboarding.tsx:1294,1305`), department/position `name` (`StaffDirectory.tsx:1548,1596`), all `UgLocationPicker` fields (village/parish/county/district/town council/cell/zone) |
| **X7 Generated/typed types** | `src/integrations/supabase/types.ts` (186 hits) — generated schema | — |
| **X8 Tests / benchmarks** | `src/lib/tenantSearch.test.ts`, `.bench.test.ts`, `.perf.test.ts` | — |
| **X9 Share-text only, never submitted** | typed name used solely to build a WhatsApp/share string | `src/components/cto/MerchantLoginLinkCard.tsx:23,63` |
| **X10 CSV import column mapping** | `src/components/coo/PartnerImportDialog.tsx:62,329` — bulk import header map, not a capture input | — |

### Ambiguity register (deliberately excluded, flagged for a decision)

These are account-holder names that may be a natural person *or* a registered business. They are excluded from the split treatment unless product explicitly says otherwise, because forcing First/Last on a business account name would break payouts:

- `momoName` / `bankAccountName` — `src/components/wallet/WithdrawRequestDialog.tsx:954,982`
- `momoName` / `bankAccountName` — `src/pages/PortfolioCompletion.tsx:86,88`, `src/pages/Onboarding.tsx` (`momo_name`, `bank_account_name`)
- `accountName` — `src/pages/RegisterPartnerPublic.tsx:349`
- `bank_account_name` — `src/components/manager/CreateInvestmentAccountDialog.tsx:530`
- `mobile_money_name` — `src/components/executive/landlord-ops/EditLandlordDialog.tsx:196`
- `momoName` — `src/components/shared/LandlordRegistrationForm.tsx:242,1327`

### Fields verified absent

- `other_names` — **0 hits**. It is a brand-new frontend-only concept; nothing stores or reads it today.
- `applicant_name` — **0 hits**; the internship/careers forms use `full_name`.

---

## 6. Proposed card-to-flow mapping (cards 04-08)

| Card | Flows | Inventory rows | Files |
| --- | --- | --- | --- |
| **04 — Pilot: signup / auth** | Auth signup only | 1 | `src/hooks/useAuthForm.ts`, `src/pages/Auth.tsx` |
| **05 — Consolidate existing hand-rolled splits + self-service edits** | Onboarding, NameCompletionGate, Settings, PortfolioCompletion kin | 2, 3, 4, 5, 6 (+ H1-H4) | `Onboarding.tsx`, `NameCompletionGate.tsx`, `Settings.tsx`, `PortfolioCompletion.tsx` |
| **06 — Tenant, landlord & LC1 capture** | public tenant/landlord registration, agent rent-request, tenant self-service, LC1 pickers, caretaker | 7, 8, 9, 11, 19-25, 27-30, 33-35, 37-44 (+ H5-H13) | `RegisterTenantPublic.tsx`, `LandlordSignup.tsx`, `LandlordRegistrationForm.tsx`, `QuickRegisterTenantDialog.tsx`, `RegisterTenantDialog.tsx`, `EditTenantDialog.tsx`, `AgentRentRequestDialog.tsx`, `AgentEditRentRequestDialog.tsx`, `ListEmptyHouseDialog.tsx`, `Lc1ChairpersonPicker.tsx`, `RentRequestForm.tsx`, `RentRequestButton.tsx`, `RegisterPropertyDialog.tsx`, `BorrowerResidenceGate.tsx` |
| **07 — Staff, agent, merchant, supporter, partner & admin capture** | partner/supporter/merchant registration + activation, sub-agent, invites, employee, HR, exec/ops/COO profile edits | 10, 12-15, 26, 31, 32, 36, 45-54, 57 (+ H14-H21) | `RegisterPartnerPublic.tsx`, `MerchantRegister.tsx`, `ActivatePartner.tsx`, `ActivateSupporter.tsx`, `InviteMerchantAgent.tsx`, `RegisterSubAgentDialog.tsx`, agent+manager `CreateUserInviteDialog.tsx`, `AgentAngelPoolInvestDialog.tsx`, `RegisterEmployeeDialog.tsx`, `UserDetailsDialog.tsx`, `TenantDetailPanel.tsx`, `UserDrilldownDrawer.tsx`, `EmployeeProfile.tsx`, `ActivePartnersDetail.tsx`, `EditLandlordDialog.tsx`, `EditLC1Dialog.tsx`, `PartnerCompanyDefaultsDialog.tsx` |
| **08 — Long tail sweep** | public application forms, requisition, cash-deposit and float depositor names; confirm ambiguity register decisions | 16, 17, 18, 55, 56 | `Internship.tsx`, `Careers.tsx`, `PublicRequisitionForm.tsx`, `StartCashDepositDialog.tsx`, `ManualFloatCreditPanel.tsx` |

---

## 7. Counts

- **In-scope person-name capture/edit inputs: 57** (across 39 files)
- **Hydration points to handle on split: 23** (22 into editable inputs)
- Already using the shared validator: **8** · already split first/last: **2** · no validation beyond `.trim()`/presence: **41**
- Distinct payload field names in use: `full_name`, `fullName`, `name`, `tenant_name`, `landlord_name`, `lc1_chairperson_name`, `lc1.name`, `landlord.name`, `caretaker_name`, `kin_name`, `next_of_kin_name`, `rep_name`, `employee_name`, `depositor_name`, `p_full_name`, `p_depositor_name` — **all must keep receiving a single concatenated string.**

## 8. Residual uncertainties to resolve during cards 04-08 (not blockers)

1. `LandlordSignup.tsx` — exact submit call after `validateFullName` not fully traced (assumed `registerUser`/signUp with `full_name`).
2. `ActivatePartner.tsx:127` — target table of the update not confirmed (likely `profiles`).
3. `useAuthForm.ts` real-email signup branch (~`:541+`) — confirm `full_name` also travels as auth user metadata.
4. `Onboarding.tsx:1261` `registerUser(...)` — confirm the hook does not re-validate/re-join independently.
5. `RegisterPropertyDialog.tsx:82` `tenantName` — may be lookup-only and never submitted; confirm before treating as in scope (currently excluded from the 57).
6. `AgentBioEditor.tsx` — `full_name` validated at `:50` but no bound `<Input>` found; confirm it is not an editable name field.
7. `ops_update_user_identity` RPC — confirm `p_full_name` writes `profiles.full_name` (server side, out of frontend scope).
