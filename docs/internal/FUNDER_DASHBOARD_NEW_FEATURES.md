# Funder Dashboard — New Features & Recent Changes

> **Platform:** Welile Rent Management System  
> **Last Updated:** March 2026  
> **Scope:** Recently implemented features, UI changes, and new logic only.

---

## 1. Wallet UI Restructure — Collapsible "Pay for Anything"

### What Changed
The wallet interface across all user roles was decluttered by hiding secondary actions behind a collapsible toggle.

### Primary Visible Actions
Only **two** wallet actions are permanently visible:
- **Deposit** — Add money to wallet via Mobile Money (MTN/Airtel merchant codes).
- **Withdraw** — Request withdrawal to linked mobile number (subject to working-hours guardrails and approval pipeline).

### Collapsible Section: "Pay for Anything"
- Tapping the **"Pay for Anything"** header toggles a collapsible section open/closed.
- A **ChevronDown** icon rotates 180° to indicate open/closed state.
- The section is **closed by default** to keep the wallet clean.

### Contents Hidden Inside "Pay for Anything"
1. **Send** — Transfer money to another Welile user.
2. **Request** — Request money from another user.
3. **12-Category Payment Grid** (4 columns):
   - Food, Groceries, Fuel, Transport, Hotel, Clinic, Mechanic, Restaurant, Electricity, Water, Salon, School.

### Animation
- Expand uses Tailwind `animate-in`, `fade-in`, and `slide-in-from-top-2` for smooth entry.

### State Management
```tsx
const [payAnythingOpen, setPayAnythingOpen] = useState(false);
```

### File
- `src/components/wallet/FullScreenWalletSheet.tsx`

---

## 2. Deposit Flow (8-Step Guided Process)

### Overview
A fully guided deposit experience inside `DepositDialog.tsx` that walks users through depositing via Mobile Money.

### Steps
| Step | Description |
|------|------------|
| 1 | Interactive instructions with swipeable slides |
| 2 | Select provider — **MTN** or **Airtel** |
| 3 | Display merchant code — `090777` (MTN) / `4380664` (Airtel) |
| 4 | Enter amount — Quick chips: UGX 50K, 100K, 200K, 500K |
| 5 | Enter **Transaction ID (TID)** — Real-time duplicate validation against DB |
| 6 | Select transaction date/time — Limited to last 7 days |
| 7 | Add optional narration/notes |
| 8 | Success summary with deposit details |

### Key Logic
- **Duplicate TID Prevention**: Before submission, the TID is checked against existing `deposit_requests` to prevent double-entries.
- **Provider Branding**: MTN shown with yellow badge, Airtel with red badge.
- **Amount Validation**: Minimum and maximum deposit limits enforced.
- Deposit creates a `deposit_requests` record with status `pending`, awaiting manager approval.

### Approval Pipeline
```
User submits → Manager reviews → Approved/Rejected
```

### File
- `src/components/wallet/DepositDialog.tsx`

---

## 3. Withdrawal Flow (Guardrailed & Multi-Approval)

### Overview
Withdrawal requests are processed through `WithdrawRequestDialog.tsx` with strict operational guardrails.

### Guardrails
| Rule | Detail |
|------|--------|
| **Working Hours Only** | Mon–Fri 8AM–5PM, Sat 8AM–1PM (EAT timezone) |
| **Minimum Balance** | UGX 5,000 must remain in wallet after withdrawal |
| **Daily Limit** | Maximum daily withdrawal amount enforced |

### UI Elements
- **Amount Slider** — Visual slider for selecting withdrawal amount.
- **Quick Amount Chips** — Preset amounts for fast selection.
- **Auto-populated Mobile Number** — From user's profile, with option to edit.
- **Balance Display** — Shows current balance and remaining after withdrawal.

### Single-Step Financial Ops Approval
Tracked via `WithdrawalStepTracker` (2-step visual: Requested → Approved & Paid):
```
Requested (wallet pre-deducted) → Financial Ops enters TID/Receipt/Bank Ref → Approved & Complete
```

### Key Logic
- Withdrawal request creates a record in `investment_withdrawal_requests` (for investment withdrawals) or wallet withdrawal queue.
- Wallet withdrawals are pre-deducted at request time via `cash_out` ledger entry.
- **Rewards are paused** during withdrawal processing for investment withdrawals.
- Financial Ops has single-step approval authority for wallet withdrawals.

### Files
- `src/components/wallet/WithdrawRequestDialog.tsx`
- `src/components/wallet/UserWithdrawalRequests.tsx`

---

## 4. Qualified Investor Auto-Routing

### Logic
Users with **≥ UGX 100,000** in deployed capital (`investor_portfolios` table) are automatically defaulted to the **Funder/Supporter** dashboard on login.

### Implementation
```tsx
// src/hooks/useDeployedCapital.ts
const INVESTOR_THRESHOLD = 100000; // UGX 100K

// Dashboard.tsx — Auto-switch effect
if (isQualifiedInvestor && role !== 'supporter' && roles.includes('supporter')) {
  switchRole('supporter');
}
```

### Override
Users can set a **"Default Dashboard"** preference in Settings to override auto-routing. When set to `'auto'`, the system applies the qualified-investor logic.

### Files
- `src/hooks/useDeployedCapital.ts`
- `src/pages/Dashboard.tsx`

---

## 5. Role Gating for High-Capital Investors

### Logic
For users with ≥ UGX 100K deployed capital:
- **Supporter role** is the default landing dashboard.
- **Tenant, Agent, Landlord** roles are gated behind a **manager-approved "Role Access Request"** application.
- Users must apply and be approved before switching to those roles.

### Seamless Public Role Switch
For users below the threshold, switching to any public role (`tenant`, `agent`, `landlord`, `supporter`) auto-provisions the role if not already assigned:
```tsx
const handlePublicRoleSwitch = async (newRole) => {
  if (PUBLIC_ROLES.includes(newRole) && !roles.includes(newRole)) {
    await addRole(newRole);
  }
  switchRole(newRole);
};
```

---

## 6. Account Frozen State

### What It Does
Users flagged with `is_frozen = true` on their profile are **completely blocked** from accessing any dashboard.

### UI
- Full-screen destructive overlay with `ShieldAlert` icon.
- Displays the frozen reason from `profile.frozen_reason`.
- Shows **"All transactions are blocked"** warning.
- Provides WhatsApp support contact (0708 257 899).
- Only action available: **Sign Out**.

### Data Source
- `profiles.is_frozen` (boolean)
- `profiles.frozen_reason` (text)

---

## 7. Offline-First Cached Dashboard

### What Changed
The dashboard now renders with cached data when the user is offline.

### Logic
1. On load, roles are checked from **session cache** (`getPreloadedRoles()`) for instant display.
2. If online fetch fails, **IndexedDB cached roles** (`getCachedUserRoles()`) are used.
3. Roles are cached to IndexedDB on every successful fetch (`cacheUserRoles()`).
4. **Offline fallback UI** shows only when no cached data exists at all.

### Files
- `src/pages/Dashboard.tsx`
- `src/lib/offlineDataStorage.ts`
- `src/lib/sessionCache.ts`

---

## 8. Wallet Disclaimer & Trust Signals

### Licensed & Regulated Badge
Every wallet interface displays a **"Licensed & Regulated"** clickable disclaimer via `WalletDisclaimer` component.

### Operator Badges
User's linked phone number is shown with branded operator badges:
- **MTN** → Yellow "M" badge
- **Airtel** → Red "A" badge

### Traffic-Light Balance Indicator
- 🟢 Green: Balance ≥ UGX 50,000
- 🟡 Yellow: Balance UGX 1–49,999
- 🔴 Red: Balance UGX 0

### Last Synced Label
Displays when wallet data was last synchronized, with offline indicator (📴) when disconnected.

---

## 9. Pending Counts Cache System

### What It Does
Wallet pending counts (money requests, deposits, withdrawals) are fetched via a centralized cache to avoid redundant DB calls.

### Implementation
```tsx
const counts = await fetchPendingCounts(user.id);
// Returns: { moneyRequests, deposits, withdrawals }
```

### File
- `src/lib/pendingCountsCache.ts`

---

## 10. Bill Payment & Food Market Dialogs

### Bill Payment (`BillPaymentDialog`)
- Pay for utilities, services, and subscriptions directly from wallet.
- Categories mapped to the 12-item grid in "Pay for Anything".

### Food Market (`FoodMarketDialog`)
- Browse and order food/groceries with wallet payment.
- Accessible from the Food/Groceries icons in the payment grid.

### Files
- `src/components/wallet/BillPaymentDialog.tsx`
- `src/components/wallet/FoodMarketDialog.tsx`

---

## Summary of UI Hierarchy

```
┌─────────────────────────────┐
│        WALLET HEADER        │
│  Balance + Status Indicator │
│  Phone + Operator Badge     │
│  Licensed & Regulated       │
├─────────────────────────────┤
│  [ Deposit ]  [ Withdraw ]  │  ← Always visible
├─────────────────────────────┤
│  ▼ Pay for Anything         │  ← Tap to expand
│  ┌─────────────────────┐    │
│  │ [Send]   [Request]  │    │
│  ├─────────────────────┤    │
│  │ Food │Groc │Fuel│Car│    │
│  │ Hotel│Clin │Mech│Res│    │
│  │ Elec │Watr │Salon│Sch│   │
│  └─────────────────────┘    │
├─────────────────────────────┤
│  Recent Transactions        │
│  Deposit Requests           │
│  Withdrawal Requests        │
└─────────────────────────────┘
```
