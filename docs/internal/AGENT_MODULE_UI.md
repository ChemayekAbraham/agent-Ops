# AGENT_MODULE_UI.md — Exhaustive Agent Module UI Specification

> **Source of Truth** for the Welile Agent Dashboard UI.  
> Last updated: 2026-03-27

---

## 1. Architecture Overview

The Agent Dashboard (`src/components/dashboards/AgentDashboard.tsx`) is a **wallet-centric, mobile-first** interface designed for field agents operating on low-end devices. It is lazy-loaded from the main `Dashboard.tsx` when the user's active role is `agent`. The layout prioritizes high-impact information at the top and uses bottom-sheets/dialogs for all secondary flows.

**Key design constraints:**
- Ultra-minimalist layout for older devices with limited scroll capability
- Wallet-first hierarchy — wallet balance is the most prominent element
- 6-button action grid for immediate access to core operations
- All secondary features accessible via the **Agent Hub** (bottom-sheet menu drawer)
- Offline-capable via `useOfflineAgentDashboard` hook with cache-first rendering
- Haptic feedback (`hapticTap`, `hapticSuccess`) on all interactive elements

**Primary file:** `src/components/dashboards/AgentDashboard.tsx`  
**Menu drawer:** `src/components/agent/AgentMenuDrawer.tsx`  
**Component directory:** `src/components/agent/`

---

## 2. Dashboard Layout (Top → Bottom)

### 2.1 Offline Banner
- **Component:** `<OfflineBanner />`
- Displays when `isOnline === false` from `useOffline()` context
- Shows yellow warning bar with WiFi-off icon and refresh button
- Text: "You're offline — data may be outdated"

### 2.2 Dashboard Header
- **Component:** `<DashboardHeader />`
- Role switcher (tenant, agent, supporter, landlord)
- Sign-out functionality
- Menu items array (Register User)

### 2.3 Agent Agreement Banner
- **Component:** `<AgentAgreementBanner />` (from `src/components/agent/agreement/`)
- Prompts agent to accept terms before operating
- Related files: `AgentAgreementModal.tsx`, `AgentAgreementContent.ts`, `AgentAgreementButton.tsx`, `AgentTermsQuickAccess.tsx`
- Hook: `useAgentAgreement`

### 2.4 Profile + Name + AI ID
- Displays avatar (clickable → `/settings`), full name, verified badge (if verified), territory
- **Component:** `<UserAvatar />`, `<AiIdButton variant="compact" />`
- Shows: "Welile Agent · {territory}"

### 2.5 Wallet Button (Most Prominent)
- Full-width gradient card with primary border
- Displays: Wallet Balance in `formatUGX()` format
- Shows MoMo provider badges (MTN yellow "M" / Airtel red "A") based on phone regex
- Opens: `<FullScreenWalletSheet />` + `<WalletDisclaimer />`
- Styling: `border-2 border-primary/30 bg-gradient-to-br from-primary/10`

### 2.6 Verification Checklist
- **Component:** `<VerificationChecklist userId={user.id} highlightRole="agent" compact />`
- Shows verification progress for agent role

### 2.7 Daily Rent Expected Card
- **Component:** `<DailyRentExpectedCard userId={user.id} />`
- Aggregate portfolio repayment target for the day
- Top priority visibility — placed before action grid

### 2.8 Action Grid (3×2 = 6 Buttons)
The core navigation grid, immediately accessible without scrolling:

| Button | Icon | Color | Action |
|--------|------|-------|--------|
| **Pay Rent** | `Banknote` | Primary | Opens `AgentTopUpTenantDialog` |
| **Post Request** | `FileText` | Success (highlighted with ring) | Opens `AgentRentRequestDialog` |
| **Tenants** | `Users` | Primary | Opens `AgentTenantsSheet` |
| **List House** | `Home` | Chart-4 | Opens `ListEmptyHouseDialog` |
| **Credit** | `TrendingUp` | Warning | Toggles `CreditAccessCard` visibility |
| **Agent Hub** | `Menu` | Foreground/muted | Opens `AgentMenuDrawer` |

- Each button uses `staggerDelay(i, 40)` for CSS animation
- Touch manipulation with `active:scale-95` feedback

### 2.9 Credit Access Card (Collapsible)
- **Component:** `<CreditAccessCard userId={user.id} compact />`
- Toggles via AnimatePresence on Credit button press
- Shows credit limit, usage, and access details

### 2.10 Action Insights
- **Component:** `<AgentActionInsights agentId={user.id} hideDailyRent />`
- Contains (Daily Rent hidden since shown above):
  - **Earnings Forecast Card** (`EarningsForecastCard`)
  - **Collection Streak Card** (`CollectionStreakCard`)
  - **Priority Collection Queue** trigger button → opens `PriorityCollectionQueue` sheet

### 2.11 Cash Payouts (Conditional)
- Only visible for CFO-assigned cashout agents (`cashout_agents` table check)
- Shows agent's payout type: Cash Only / Bank Only / Cash & Bank
- Opens `AgentCashPayoutsTab` in a dialog
- Dedicated page also at `/agent/cash-payouts` (`src/pages/agent/CashPayouts.tsx`)

### 2.12 Landlord Float Card
- **Component:** `<AgentLandlordFloatCard />`
- Displays: Landlord float balance (ring-fenced escrow)
- Shows pending withdrawal count
- **Main action:** Pay Landlord → opens `AgentFloatPayoutWizard`
- **Quick action strip** (3-col):
  - Recovery → `LandlordRecoveryLedger`
  - Status → `FloatPayoutStatusTracker`
  - History → `FloatTransactionHistory`

### 2.13 Recent Auto-Charges
- **Component:** `<RecentAutoCharges />`
- Shows recent automatic wallet deductions

### 2.14 Mobile Bottom Nav
- **Component:** `<MobileBottomNav currentRole={currentRole} />`
- Persistent bottom navigation bar

---

## 3. Agent Hub (Menu Drawer)

**Component:** `<AgentMenuDrawer />`  
**Style:** Bottom-sheet with drag handle, 88vh max height, rounded top corners  
**Navigation:** Horizontal scrollable category tabs → 3-column icon grid

### 3.1 Category: Actions
| Item | Icon | Description | Badge |
|------|------|-------------|-------|
| Pay Rent | Banknote | Pay rent for tenant | ★ |
| Register User | UserPlus | Onboard tenants & landlords | — |
| Deposit | ArrowDownCircle | Add funds to user wallet | — |
| Post Rent | FileText | Request on behalf of tenant | — |
| Issue Receipt | Receipt | Record cash payment | New |
| Top Up Wallet | Wallet | Deposit to tenant wallet | — |
| Invest for Partner | HandCoins | Proxy investment | Proxy |
| Cash Payouts | Banknote | Verify & pay cash-outs | 💵 |
| Invite & Refer | Share2 | Grow your network | — |

### 3.2 Category: Property
| Item | Icon | Description | Badge |
|------|------|-------------|-------|
| List House | Home | Earn UGX 5,000 | 5K |
| My Listings | ClipboardList | View listed houses | — |
| Manage Property | Building2 | For landlords | 2% |
| Managed Props | Home | Properties & payouts | — |
| Find Rentals | Search | Browse by location | — |
| Landlord Map | MapPin | Navigate to landlords | GPS |

### 3.3 Category: People
Includes a **"Build Your Team 🚀"** CTA banner showing:
- Earn UGX 500 per signup + 1% of sub-agent collections
- Quick buttons: Register / My Team / Share Link

| Item | Icon | Description | Badge |
|------|------|-------------|-------|
| My Tenants | Users | Repayment schedules | — |
| Registrations | ClipboardList | Invite status & links | — |
| Rent Requests | ScrollText | Verify posted requests | — |
| Schedules | Calendar | PDF & WhatsApp | PDF |
| Proxy History | History | Partner investments | — |
| My Funders | HandCoins | No-smartphone partners | 📱 |
| Register Sub-Agent | Handshake | Add to your team | 500 |
| My Sub-Agents | Users | View your team | — |
| Share Recruit Link | Share2 | WhatsApp / Copy link | 🔗 |

### 3.4 Category: Earnings
| Item | Icon | Description |
|------|------|-------------|
| Rank System | Trophy | Levels & badges |
| My Earnings | TrendingUp | Detailed breakdown |
| Goals | Target | Track targets |
| Analytics | BarChart3 | Performance metrics |
| Withdrawals | PiggyBank | Commission payouts |
| Referrals | Users | Users you brought in |

### 3.5 Category: Tools
| Item | Icon | Description |
|------|------|-------------|
| Shop | Store | Buy & sell |
| Receipts | Receipt | Scan to earn |
| My Loans | Banknote | View & manage |
| Transactions | History | Payment history |
| Statement | FileText | Financial statement |
| Calculator | Calculator | Rent & interest |

### 3.6 Category: More
| Item | Icon | Description |
|------|------|-------------|
| Share App | Download | `/install` |
| Agreement | ScrollText | `/agent-agreement` |
| Settings | Settings | `/settings` |
| Help | HelpCircle | `/help` |

**"How It Works" Guides** (accordion, in More tab only):
1. **Rent Payments & Auto-Deductions** — 4-step guide: Search Tenant → Enter Amount → Instant Processing → Receivables Updated. Includes Auto-Deduction System explainer (tenant wallet → agent wallet → accumulated debt).
2. **How to Verify a Tenant** — 6-step guide: Visit Residence → Verify Electricity Meter → Verify Water Meter → Confirm MM Details → Capture GPS → Tap "Verify" (earn UGX 10,000 + 5% commission).
3. **How to Verify a Landlord** — 7-step guide: Visit Property → Collect MM Details → Record Utility Meters → Get LC1 Details → Capture GPS → Register & Share Link → Landlord Verified.

---

## 4. Dialog & Sheet Components (Full Inventory)

### 4.1 Registration & Onboarding
| Component | File | Purpose |
|-----------|------|---------|
| `UnifiedRegistrationDialog` | `UnifiedRegistrationDialog.tsx` | Multi-role user registration (tenant, landlord) |
| `RegisterSubAgentDialog` | `RegisterSubAgentDialog.tsx` | Sub-agent registration with UGX 500 bonus |
| `RegisterTenantDialog` | `RegisterTenantDialog.tsx` | Dedicated tenant registration |
| `RegisterLandlordDialog` | `RegisterLandlordDialog.tsx` | Dedicated landlord registration |
| `CreateUserInviteDialog` | `CreateUserInviteDialog.tsx` | Create invite link for users |

### 4.2 Financial Operations
| Component | File | Purpose |
|-----------|------|---------|
| `AgentDepositDialog` | `AgentDepositDialog.tsx` | Deposit funds to user wallet |
| `AgentDepositCashDialog` | `AgentDepositCashDialog.tsx` | Cash deposit handling |
| `AgentTopUpTenantDialog` | `AgentTopUpTenantDialog.tsx` | Pay rent / top up tenant wallet |
| `AgentWithdrawalDialog` | `AgentWithdrawalDialog.tsx` | Agent withdrawal requests |
| `AgentReceiptDialog` | `AgentReceiptDialog.tsx` | Issue manual receipt for cash payment |
| `RequestCommissionPayoutDialog` | `RequestCommissionPayoutDialog.tsx` | Request commission payout |
| `MyCommissionPayouts` | `MyCommissionPayouts.tsx` | View commission payout history |
| `GeneratePaymentTokenDialog` | `GeneratePaymentTokenDialog.tsx` | Generate QR/token for payment collection |
| `RecordAgentCollectionDialog` | `RecordAgentCollectionDialog.tsx` | Record cash collection from tenant |
| `RecordTenantPaymentDialog` | `RecordTenantPaymentDialog.tsx` | Record tenant payment |
| `MobileMoneySettings` | `MobileMoneySettings.tsx` | Configure MoMo provider & number |
| `LoanManagement` | `LoanManagement.tsx` | View and manage agent loans |
| `LoanPaymentCalculator` | `LoanPaymentCalculator.tsx` | Calculate loan repayment schedules |

### 4.3 Landlord Float & Payout System
| Component | File | Purpose |
|-----------|------|---------|
| `AgentLandlordFloatCard` | `AgentLandlordFloatCard.tsx` | Float balance display + quick actions |
| `AgentFloatPayoutWizard` | `AgentFloatPayoutWizard.tsx` | Step-by-step landlord payout via MoMo |
| `AgentLandlordPayoutDialog` | `AgentLandlordPayoutDialog.tsx` | Direct landlord payout dialog |
| `AgentLandlordPayoutFlow` | `AgentLandlordPayoutFlow.tsx` | Full landlord payout flow |
| `AgentOpsFloatPayoutReview` | `AgentOpsFloatPayoutReview.tsx` | Agent ops review of float payout |
| `FloatPayoutStatusTracker` | `FloatPayoutStatusTracker.tsx` | Track payout approval status |
| `FloatTransactionHistory` | `FloatTransactionHistory.tsx` | Historical float transactions |
| `LandlordRecoveryLedger` | `LandlordRecoveryLedger.tsx` | Track landlord payment recovery |

### 4.4 Rent Requests
| Component | File | Purpose |
|-----------|------|---------|
| `AgentRentRequestDialog` | `AgentRentRequestDialog.tsx` | Post rent request on behalf of tenant |
| `AgentRentRequestsManager` | `AgentRentRequestsManager.tsx` | Manage all rent requests |
| `AgentMyRentRequestsSheet` | `AgentMyRentRequestsSheet.tsx` | View agent's own posted rent requests |
| `AgentTenantRentRequestsList` | `AgentTenantRentRequestsList.tsx` | List rent requests by tenant |
| `CollapsibleRentRequests` | `CollapsibleRentRequests.tsx` | Collapsible rent request section |
| `AgentDeliveryConfirmation` | `AgentDeliveryConfirmation.tsx` | Confirm rent delivery with GPS + photos |

### 4.5 Tenant Management
| Component | File | Purpose |
|-----------|------|---------|
| `AgentTenantsSheet` | `AgentTenantsSheet.tsx` | View all registered tenants |
| `NearbyTenantsSheet` | `NearbyTenantsSheet.tsx` | GPS-based nearby tenant discovery |
| `NoSmartphoneScheduleManager` | `NoSmartphoneScheduleManager.tsx` | Visual repayment calendar for non-smartphone tenants |
| `AgentVisitDialog` | `AgentVisitDialog.tsx` | Log field visit to tenant |
| `AgentVisitPaymentWizard` | `AgentVisitPaymentWizard.tsx` | Combined visit check-in + payment collection |

### 4.6 Property & Housing
| Component | File | Purpose |
|-----------|------|---------|
| `ListEmptyHouseDialog` | `ListEmptyHouseDialog.tsx` | List vacant house (earn UGX 5,000) |
| `AgentListingsSheet` | `AgentListingsSheet.tsx` | View all listed houses with status badges |
| `AgentManagedPropertyDialog` | `AgentManagedPropertyDialog.tsx` | Register managed property for landlord |
| `AgentManagedPropertiesSheet` | `AgentManagedPropertiesSheet.tsx` | View managed properties + request payouts |
| `AgentLandlordMapSheet` | `AgentLandlordMapSheet.tsx` | GPS map of landlord locations |
| `RentalFinderSheet` | `RentalFinderSheet.tsx` | Browse available rentals by location |
| `HouseImageUploader` | `HouseImageUploader.tsx` | Upload house photos for listings |

### 4.7 Sub-Agent & Team Management
| Component | File | Purpose |
|-----------|------|---------|
| `MySubAgentsSheet` | `MySubAgentsSheet.tsx` | View sub-agents, invites, and share link |
| `SubAgentsList` | `SubAgentsList.tsx` | List of active sub-agents |
| `SubAgentInvitesList` | `SubAgentInvitesList.tsx` | Pending sub-agent invites |
| `ShareSubAgentLink` | `ShareSubAgentLink.tsx` | Generate & share recruitment link |
| `QuickShareSubAgentSheet` | `QuickShareSubAgentSheet.tsx` | Quick WhatsApp/copy share sheet |
| `RecruitSubAgentCTA` | `RecruitSubAgentCTA.tsx` | Recruitment call-to-action banner |
| `CollapsibleSubAgents` | `CollapsibleSubAgents.tsx` | Collapsible sub-agents section |
| `SetTeamGoalDialog` | `SetTeamGoalDialog.tsx` | Set monthly team targets |
| `TeamGoalProgress` | `TeamGoalProgress.tsx` | Track team goal progress |

### 4.8 User Invites & Link Signups
| Component | File | Purpose |
|-----------|------|---------|
| `AgentInvitesList` | `AgentInvitesList.tsx` | List of registered user invites |
| `CollapsibleUserInvites` | `CollapsibleUserInvites.tsx` | Collapsible registered users section |
| `LinkSignupsList` | `LinkSignupsList.tsx` | Users who signed up via referral link |
| `CollapsibleLinkSignups` | `CollapsibleLinkSignups.tsx` | Collapsible link signups section |
| `ShareReferralLink` | `ShareReferralLink.tsx` | Share general referral link |
| `CollapsibleAgentSection` | `CollapsibleAgentSection.tsx` | Reusable collapsible section wrapper |

### 4.9 Proxy Investments & Funders
| Component | File | Purpose |
|-----------|------|---------|
| `AgentInvestForPartnerDialog` | `AgentInvestForPartnerDialog.tsx` | Proxy investment for no-smartphone partners |
| `ProxyInvestmentHistorySheet` | `ProxyInvestmentHistorySheet.tsx` | View proxy investment history |
| `FunderManagementSheet` | `FunderManagementSheet.tsx` | Manage no-smartphone funders/partners |
| `FunderPortfolioCard` | `FunderPortfolioCard.tsx` | Display funder's portfolio summary |

### 4.10 Earnings & Performance
| Component | File | Purpose |
|-----------|------|---------|
| `EarningsRankSystemSheet` | `EarningsRankSystemSheet.tsx` | Rank system with levels & badges |
| `EarningsForecastCard` | `EarningsForecastCard.tsx` | Projected earnings forecast |
| `CollectionStreakCard` | `CollectionStreakCard.tsx` | Current/longest collection streak + badges |
| `AgentLeaderboard` | `AgentLeaderboard.tsx` | Agent performance leaderboard |
| `AgentGoalCard` | `AgentGoalCard.tsx` | Individual goal tracking card |
| `AgentGoalProgress` | `AgentGoalProgress.tsx` | Goal progress visualization |
| `AgentRegistrationAnalytics` | `AgentRegistrationAnalytics.tsx` | Registration performance analytics |
| `ShareablePerformanceCard` | `ShareablePerformanceCard.tsx` | Shareable performance summary image |
| `ShareableMilestoneCard` | `ShareableMilestoneCard.tsx` | Shareable milestone achievement image |
| `AgentDailyOpsCard` | `AgentDailyOpsCard.tsx` | Daily ops: visits, collections, float gauge |
| `PriorityCollectionQueue` | `PriorityCollectionQueue.tsx` | Prioritized tenant collection queue |

### 4.11 Verification & Credit
| Component | File | Purpose |
|-----------|------|---------|
| `VerificationOpportunitiesButton` | `VerificationOpportunitiesButton.tsx` | Floating button for verification tasks |
| `AgentVerificationOpportunitiesCard` | `AgentVerificationOpportunitiesCard.tsx` | Card listing verification opportunities |
| `CreditVerificationButton` | `CreditVerificationButton.tsx` | Credit verification action button |

### 4.12 Cash Payouts (CFO-Assigned)
| Component | File | Purpose |
|-----------|------|---------|
| `AgentCashPayoutsTab` | `AgentCashPayoutsTab.tsx` | Main cash payout verification interface |
| `CashPayouts` (page) | `src/pages/agent/CashPayouts.tsx` | Dedicated cash payouts page at `/agent/cash-payouts` |

### 4.13 Rent Payment Guide
| Component | File | Purpose |
|-----------|------|---------|
| `AgentRentPaymentGuide` | `AgentRentPaymentGuide.tsx` | Step-by-step rent payment guide |

### 4.14 Pending Deposits
| Component | File | Purpose |
|-----------|------|---------|
| `PendingDepositsSection` | `PendingDepositsSection.tsx` | Show pending deposit transactions |

### 4.15 Recruit Tenant for Welile Homes
| Component | File | Purpose |
|-----------|------|---------|
| `RecruitTenantWelileHomes` | `RecruitTenantWelileHomes.tsx` | CTA to recruit tenants for Welile Homes |

---

## 5. Hooks Used by Agent Module

| Hook | File | Purpose |
|------|------|---------|
| `useAuth` | `useAuth.tsx` | Authentication state & user object |
| `useProfile` | `useProfile.ts` | Agent profile data (name, territory, avatar, verified, phone) |
| `useAgentEarnings` | `useAgentEarnings.ts` | Earnings data + refresh function |
| `useWallet` | `useWallet.ts` | Wallet balance + refresh function |
| `useOfflineAgentDashboard` | `useOfflineAgentDashboard.ts` | Offline-first dashboard data (stats, loading, hasLoadedOnce) |
| `useOffline` | `OfflineContext` | Online/offline connectivity state |
| `useAgentAgreement` | `useAgentAgreement.ts` | Agreement acceptance state |
| `useHouseListings` | `useHouseListings.ts` | House listing queries |
| `useGeoLocation` | `useGeoLocation.tsx` | GPS location for visits/verification |
| `useUserSnapshot` | `useUserSnapshot.ts` | Cached user data snapshot (invites, signups) |
| `useCreditAccessLimit` | `useCreditAccessLimit.ts` | Credit access and limit data |
| `useVerificationStatus` | `useVerificationStatus.ts` | Agent verification progress |

---

## 6. Database Tables (Agent-Specific)

| Table | Purpose |
|-------|---------|
| `agent_collections` | Cash/MoMo collections from tenants |
| `agent_visits` | GPS-stamped field visit logs |
| `agent_float_limits` | Daily float capacity + collected_today |
| `agent_float_funding` | Float funding records |
| `agent_float_withdrawals` | Landlord payout withdrawal requests (multi-stage approval) |
| `agent_landlord_float` | Ring-fenced landlord escrow balance |
| `agent_landlord_payouts` | Direct landlord payout records |
| `agent_landlord_assignments` | Agent-landlord relationship mapping |
| `agent_earnings` | Commission and earning records |
| `agent_commission_payouts` | Commission payout requests |
| `agent_collection_streaks` | Streak data, badges, multiplier |
| `agent_advances` | Agent advance/loan records |
| `agent_advance_ledger` | Daily advance deduction ledger |
| `agent_advance_topups` | Advance top-up records |
| `agent_escalations` | Issue escalations with severity |
| `agent_tasks` | Manager-assigned tasks |
| `agent_goals` | Monthly registration/activation targets |
| `agent_incentive_bonuses` | Bonus awards (streak, milestone, etc.) |
| `agent_receipts` | Manual receipt records |
| `agent_subagents` | Parent-child agent relationships |
| `agent_rebalance_records` | Float rebalance audit trail |
| `agent_delivery_confirmations` | GPS + photo delivery confirmations |
| `cashout_agents` | CFO-assigned cash payout agents |

---

## 7. Routing

| Path | Component | Purpose |
|------|-----------|---------|
| `/dashboard` (role=agent) | `AgentDashboard` | Main agent dashboard |
| `/agent/cash-payouts` | `AgentCashPayoutsPage` | Dedicated cash payouts page |
| `/agent-registrations` | — | Registration invites & status |
| `/agent-analytics` | — | Goals & performance analytics |
| `/agent-agreement` | — | Agent terms & agreement |
| `/earnings` | — | Earnings breakdown & withdrawals |
| `/referrals` | — | Referral tracking |
| `/financial-statement` | — | Financial statement |
| `/transactions` | — | Transaction history |
| `/calculator` | — | Rent & interest calculator |
| `/my-receipts` | — | Receipt scan history |
| `/my-loans` | — | Loan management |
| `/shop` | — | Marketplace |
| `/settings` | — | Profile & app settings |
| `/help` | — | Help center |
| `/install` | — | PWA install / share app |

---

## 8. Key UX Patterns

### 8.1 Wallet-Centric Design
- Wallet is the largest, most prominent element
- Purple gradient styling for all wallet-related actions
- MoMo provider detection via phone number regex

### 8.2 Offline-First Architecture
- `useOfflineAgentDashboard` provides cached stats
- `hasLoadedOnce` prevents skeleton flash on subsequent views
- Offline banner with manual refresh option
- Service worker caching via `public/sw.js`

### 8.3 Bottom-Sheet Pattern
- All secondary flows use `<Sheet side="bottom">` or `<Dialog>`
- Consistent drag handle, rounded corners, max-height constraints
- `overscroll-contain` for nested scroll areas

### 8.4 Haptic Feedback
- `hapticTap()` on button presses
- `hapticSuccess()` on successful actions (menu item selection)

### 8.5 Staggered Animations
- Action grid uses `staggerDelay(i, 40)` for sequential fade-in
- `animate-fade-in` CSS class on most sections
- Framer Motion for conditional renders (AnimatePresence)

### 8.6 Collapsible Sections
- `CollapsibleAgentSection` provides reusable accordion pattern
- Used for: User Invites, Link Signups, Sub-Agents, Rent Requests
- Shows pending count badge and total count

### 8.7 No-Smartphone Support
- `charge_agent_wallet` flag bypasses tenant wallet
- `NoSmartphoneScheduleManager` generates visual repayment calendars
- `FunderManagementSheet` manages no-smartphone partners

### 8.8 Multi-Stage Approval Flows
- Float payouts: `pending_agent_ops` → `agent_ops_approved` → `manager_approved` → `completed`
- Commission payouts: `pending` → `processed`
- Proxy investments: `pending_approval` → `active` / `cancelled` (with refund)

---

## 9. Commission & Incentive Structure (UI-Displayed)

| Action | Reward |
|--------|--------|
| Register tenant | UGX 10,000 |
| Verify tenant | UGX 10,000 + 5% ongoing commission |
| List empty house | UGX 5,000 |
| Register sub-agent | UGX 500 |
| Sub-agent override | 1% of sub-agent collections |
| Manage property | 2% management fee |
| Rent payment commission | 5% of payment amount |

---

## 10. Agent Hub Menu Drawer — Accent Color System

The menu drawer uses a centralized accent color mapping for consistent theming:

```
primary → bg-primary/15, text-primary
success → bg-success/15, text-success
chart-4 → bg-chart-4/15, text-chart-4
blue-500 → bg-blue-500/15, text-blue-500
amber-500 → bg-amber-500/15, text-amber-500
emerald-500 → bg-emerald-500/15, text-emerald-500
orange-500 → bg-orange-500/15, text-orange-500
violet-500 → bg-violet-500/15, text-violet-500
pink-500 → bg-pink-500/15, text-pink-500
purple-500 → bg-purple-500/15, text-purple-500
indigo-500 → bg-indigo-500/15, text-indigo-500
green-500 → bg-green-500/15, text-green-500
teal-500 → bg-teal-500/15, text-teal-500
muted-foreground → bg-muted, text-muted-foreground
```

---

## 11. Component Count Summary

| Category | Count |
|----------|-------|
| Dashboard components | 3 (main, skeleton, daily ops) |
| Dialog/Sheet components | 45+ |
| Card/Widget components | 15+ |
| Collapsible sections | 5 |
| Agreement components | 5 |
| Hooks | 12+ |
| Database tables | 20+ |
| Menu categories | 6 |
| Menu items | 40+ |
| Action grid buttons | 6 |
| **Total agent components** | **80+** |
