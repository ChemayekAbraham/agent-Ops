# CTO User Dossier — command-center audit view

A new **User Dossier** item in the CTO sidebar. The CTO searches for any user (name, phone, email or Welile AI ID) and sees everything about them on one screen, in four clearly labelled sections. Read-only: nothing on this screen changes money, wallets or user records.

## Layout

```text
[ Search user ............ ]   [avatar] Name · role badges · WEL-XXXXXX
---------------------------------------------------------------
Tabs:  Profile | Money | Partner | Activity
```

### 1. Profile
- Name, email, phone, Welile AI ID, avatar, roles, join date, last active
- GPS location (with map link) and full address
- Referral count
- History of email/phone changes (old → new, who changed it, when)

### 2. Money (categorised wallet statement)
- Current balances: withdrawable, float, advance
- Totals per category: deposits, withdrawals, wallet transfers in/out, commissions, Returns, Rent Plan repayments, fees, other
- Full statement list with filters: category, direction (in/out), date range, search by reference
- Loads 50 rows at a time ("Load more")

### 3. Partner
- Portfolio counts: total, active, suspended, deleted
- Each portfolio expandable: creation date, principal, Returns rate, top-ups, compounds, Returns withdrawals, edits and a full change history (before → after, who, when)
- Shown as "Not a partner" when the user has none

### 4. Activity (grouped by role so it is clear which is which)
- **Account**: sign-ins, last login, every device/browser used (from the user agent) with first and last seen
- **Agent**: house listings, tenant registrations, collections, visits
- **Tenant**: Rent Plans and their repayment history
- **Landlord**: properties, payouts received
- **Supporter**: deposits, portfolio actions
- One combined timeline (newest first) with a role filter, plus per-role counts at the top
- Groups that don't apply to the user are hidden

## Technical details
- One role-gated SECURITY DEFINER read-only function per section (`cto_user_dossier_profile`, `_money(p_user, filters, page)`, `_partner`, `_activity(p_user, role, page)`), plus `cto_user_dossier_search(q)`. Allowed: cto, super_admin (enabled roles only). Sections load only when their tab opens; cached with React Query.
- Money reads `general_ledger` wallet legs with the standard user-facing filter; balances via `get_user_available_balance` / `v_user_wallet_strict`. Partner history from `investor_portfolios` + `portfolio_change_log`. Profile changes from `profile_field_audit`. Devices/sign-ins from existing login/audit records (live schema verified before writing).
- New files: migration, `src/hooks/useCtoUserDossier.ts`, `src/components/executive/cto/UserDossier*.tsx`; sidebar entry in `executiveSidebarConfig.ts` (cto) and a branch in `CTODashboard.tsx`.
- No ledger/wallet writes, no publish or deploy. Run `guard:all`. Record the rule in AGENTS.md.
