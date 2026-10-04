# Funder / Supporter Dashboard — Features Guide

> **Platform:** Welile Rent Management System  
> **Last Updated:** March 2026

---

## 🎯 Overview

The Supporter (Funder) dashboard is a **premium fintech-style interface** designed for users who contribute capital to help tenants pay rent, earning platform rewards in return. The dashboard emphasizes trust, clarity, and professional appeal with glassmorphism effects, animated indicators, and mobile-first design.

---

## 🏠 Dashboard Layout

### Top Bar & Navigation
- **Personalised greeting** with user avatar and name via `UserAvatar` and `useProfile`.
- **Horizontal scrollable pill-style action buttons** (`ModernQuickActions`) for instant access to key features.
- **Pull-to-refresh** support for mobile users (`PullToRefresh` component).
- **Menu drawer** (`SupporterMenuDrawer`) with full navigation, settings, and role switching.

---

## 💎 Core Features

### 1. Portfolio Hero Card (`HeroBalanceCard`)
- **Mesh gradient background** with animated ROI indicators and glassmorphism.
- Displays: Total Invested, Monthly Returns (15% ROI), Completed Rewards, Active Fundings.
- Quick action buttons: **Add Investment** and **View Portfolio**.

### 2. Investment Accounts (`SimpleAccountsList`)
- List of all supporter investment accounts with status badges (approved/pending/rejected).
- Color-coded account indicators and balance display in UGX.
- **Quick actions per account**: Fund (sparkle icon) and Withdraw (arrow icon).
- **Create New Account** button with gradient styling.
- **View All** link to the full `/investment-portfolio` page.
- Tap any account card to open `AccountDetailsDialog` with full transaction history.

### 3. Tenant Rent Opportunities (`SimpleTenantsList`)
- Live feed of tenants requesting rent assistance.
- Each card shows: rent amount, duration (days), and projected reward (+15%).
- **One-tap Fund button** per tenant with haptic feedback.
- Limited to 5 visible items with tip banner explaining the 15% return model.

### 4. Funding Pool Card (`FundingPoolCard`)
- Shows the central rent management pool health.
- Metrics: Pool Balance, Total Deployed, 15% Reserve (locked), Deployable amount.

### 5. Quick Stats Row (`QuickStatsRow`)
- At-a-glance metrics displayed in a compact horizontal row.

### 6. Portfolio Summary Cards (`PortfolioSummaryCards`)
- Tappable cards showing investment breakdown by category.
- Opens `InvestmentBreakdownSheet` and `FullScreenWalletSheet` for detailed views.

---

## 📱 Investment Management

### 7. Create Account Dialog (`CreateAccountDialog`)
- Modal for creating new investment accounts with name, initial amount, and preferences.

### 8. Fund Account Dialog (`FundAccountDialog`)
- Add funds to an existing approved account from the supporter's wallet.

### 9. Withdraw Account Dialog (`WithdrawAccountDialog`)
- Request withdrawal from an investment account.
- Subject to COO final approval (see COO Roles document).

### 10. Investment Calculator (`InvestmentCalculator`)
- **Regulatory-compliant terminology**: "Contribution" (not Investment), "Rewards/Earnings" (not ROI).
- Mandatory legal disclaimer: projections are illustrative, not guaranteed.
- Heart icon branding (not sparkles) to align with "Support" identity.
- **Ultra-small screen optimised** (240px–390px): 44px touch targets, collapsible actions, reduced visual effects.
- Shareable via `ShareCalculatorLink`.

### 11. Investment Goals (`InvestmentGoals` + `SetGoalDialog`)
- Set and track monthly/quarterly contribution targets.

### 12. Investment Package Sheet (`InvestmentPackageSheet`)
- Browse and select from predefined investment packages.

### 13. Investment Withdrawal Button (`InvestmentWithdrawButton`)
- Quick access to request withdrawal from the investment pool.
- Rewards are paused during withdrawal processing.

---

## 🏡 Rent & Opportunity Features

### 14. Rent Opportunities (`RentOpportunities` + `ModernOpportunityTabs`)
- Tabbed view of available rent funding opportunities.
- Categories: All, Urgent, High-Value, Nearby.

### 15. Virtual Houses Feed (`VirtualHousesFeed` + `VirtualHouseCard`)
- Browse verified house listings available for rent support.
- `VirtualHouseDetailsSheet` shows full property details.

### 16. House Opportunities (`HouseOpportunities`)
- Curated list of houses needing supporter funding.

### 17. Credit Requests Feed (`CreditRequestsFeed`)
- Live feed of tenant credit/rent requests awaiting funding.

### 18. Fund Rent Dialog (`FundRentDialog`)
- Direct rent funding flow: select tenant → confirm amount → fund from wallet.

### 19. Pay Landlord Dialog (`PayLandlordDialog`)
- Direct landlord payment flow for funded rent.

### 20. Tenant Request Details (`TenantRequestDetailsDialog`)
- Full details of a specific tenant's rent request with verification status.

---

## 📊 Performance & History

### 21. ROI Earnings Card (`ROIEarningsCard`)
- Visual display of accumulated platform rewards and earnings history.

### 22. Interest Payment History (`InterestPaymentHistory`)
- Chronological log of all reward/interest payments received.

### 23. Funded History (`FundedHistory`)
- Complete history of all rent fundings made by the supporter.

### 24. Funding Milestones (`FundingMilestones`)
- Gamified milestones: first funding, 10th funding, UGX 1M funded, etc.

### 25. My Investment Requests (`MyInvestmentRequests`)
- Track status of pending investment and withdrawal requests.

---

## 🏆 Social & Referral Features

### 26. Supporter Leaderboard (`SupporterLeaderboard` + `SupporterROILeaderboard`)
- Ranked list of top supporters by total funded and ROI earned.

### 27. Referral Stats (`SupporterReferralStats`)
- Track referral performance: invites sent, conversions, referral earnings.

### 28. Share Supporter Link (`ShareSupporterLink`)
- One-tap sharing via WhatsApp/native share API.
- Personalised referral link with user ID tracking.

### 29. Share Calculator Link (`ShareCalculatorLink`)
- Share the earnings calculator with potential supporters.

### 30. Modern Invite Card (`ModernInviteCard`)
- Visual invite card for recruiting new supporters.

### 31. Merchant Code Pills (`MerchantCodePills`)
- Display and copy merchant/agent codes for in-person referrals.

---

## 🔔 Notifications & Alerts

### 32. Notification Bell (`NotificationBell`)
- Badge-counted notification icon in the top bar.

### 33. Notifications Modal (`NotificationsModal`)
- Full notification center with read/unread states.

### 34. Supporter Notifications Feed (`SupporterNotificationsFeed`)
- Real-time feed of platform events: fundings, rewards, withdrawals, system alerts.

---

## 📜 Legal & Compliance

### 35. Supporter Agreement System (`agreement/`)
- **Agreement Banner** (`SupporterAgreementBanner`) — Persistent banner until agreement is accepted.
- **Agreement Modal** (`SupporterAgreementModal`) — Full 12-month participation agreement with:
  - Quick summary tab and full legal text tab.
  - Download as TXT and Print as HTML options.
  - Must scroll and explicitly accept before accessing funding features.
- **Agreement Card** (`SupporterAgreementCard`) — Compact agreement status display.
- **Locked Overlay** (`LockedOverlay`) — Blocks all funding actions until agreement is accepted.
- **Accepted Badge** (`AgreementAcceptedBadge`) — Visual confirmation after acceptance.

---

## 🎨 Design System

- **Glassmorphism**: Frosted glass effects on hero cards and overlays.
- **Mesh gradients**: Primary color gradient backgrounds on key cards.
- **Animated ROI indicators**: Framer Motion animations for earnings display.
- **Haptic feedback**: `hapticTap` and `hapticSuccess` on interactive elements.
- **Trust signals**: Badges, verification icons, and professional typography throughout.
- **Mobile-first**: Optimised for 240px–390px screens with large touch targets.
- **Dark mode**: Full dark mode support via semantic design tokens.

---

## 🔐 Security & Data

- All financial actions go through the `general_ledger` for auditability.
- Withdrawal requests require **COO final approval**.
- Supporter pool has a **15% reserve lock** to ensure solvency.
- Agreement acceptance is recorded and timestamped in the database.
- Wallet operations use atomic transactions to prevent race conditions.
