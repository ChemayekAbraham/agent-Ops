import { buildSignupPersuasionPitch } from './nexaSignup.ts';
import { isRestrictedInternalStaffQuery, buildInternalStaffRefusalReply, WELILE_COM_AND_WELILEAPP_PUBLIC_CATALOG } from './nexaPublicCatalog.ts';

/** Public guidance only: phone numbers are never proof of account ownership. */
export function toAuthGatedPath(path: string): string {
  let cleanPath = '/dashboard';
  try {
    const url = new URL(path.trim(), 'https://welileapp.com');
    if (url.origin === 'https://welileapp.com' && !/[\\\u0000-\u001f]/.test(path)) {
      cleanPath = url.pathname + url.search + url.hash;
    }
  } catch { /* Unsafe targets fall back to the dashboard. */ }
  if (cleanPath.startsWith('/auth?redirect=')) return cleanPath;
  return `/auth?redirect=${encodeURIComponent(cleanPath)}`;
}
export function toAuthGatedUrl(path: string, baseUrl = 'https://welileapp.com'): string {
  return `${baseUrl.replace(/\/+$/, '')}${toAuthGatedPath(path)}`;
}
export const NEXA_ACTION_LINKS = Object.fromEntries([
  '/dashboard/funder-new', '/dashboard', '/rent-calculator', '/register-tenant',
  '/become-agent', '/register-landlord', '/find-a-house', '/marketplace',
  '/merchandise', '/merchandise?tab=orders',
].map(path => [path, toAuthGatedUrl(path)]));
export function extractPhoneNumberFromText(text: string): string | null {
  const match = text.match(/(?<![\d+])(?:\+?256[\s-]*7(?:[\s-]*\d){8}|07(?:[\s-]*\d){8})(?![\s-]*\d)/);
  if (!match) return null;
  const digits = match[0].replace(/\D/g, '');
  return digits.startsWith('0') ? `+256${digits.slice(1)}` : `+${digits}`;
}
export function isAccountOrBalanceQuery(text: string): boolean {
  return extractPhoneNumberFromText(text) !== null || /\b(?:my|account|remaining|investment)\b.*\b(?:portfolio|balance|status|payouts?|rewards?|rent|investment)\b|\b(?:portfolio|investment status|payout status|rent balance|account balance)\b/i.test(text);
}
export function buildAccountPhoneAndDashboardGuideReply(text = ''): string {
  const intro = extractPhoneNumberFromText(text)
    ? 'Use the registered Welile phone number you provided to sign in. A phone number alone does not verify ownership; I cannot share private account figures here.'
    : 'What is your registered Welile phone number (07XX XXX XXX or +256...)? Never share your password or one-time code here. Your number alone does not verify ownership; private figures are only available on your own signed-in dashboard.';
  return `${intro}\n\n**Partners / Supporters — Portfolio & 15% Monthly Returns**\n1. Open [Sign In / Sign Up to Funder Dashboard](${toAuthGatedUrl('/dashboard/funder-new')}).\n2. Enter your registered phone number and complete sign-in.\n3. View **Active Portfolio**, **Monthly 15% Reward Schedule**, **Promissory Notes**, and **Supported Houses**. Approved plan terms apply.\n\n**Tenants — Rent Balance & UGX 30M Access Limit**\n1. Open [Sign In / Sign Up to Tenant Dashboard](${toAuthGatedUrl('/dashboard')}).\n2. Enter your registered phone number and complete sign-in.\n3. View **Remaining Rent Balance**, **Daily Repayment Schedule**, **On-Time Streak**, and **Welile Access Limit (growing up to UGX 30,000,000)**.`;
}
export function isMerchandiseQuery(text: string): boolean {
  return /\bmerch(?:andise)?\b|\bjackets?\b|\bpress\s+(?:jacket|vest)\b|\bvests?\b|\bjumpers?\b|\bpolo\s+shirts?\b|\bt[\s-]?shirts?\b|\buniforms?\b|\bcompany\s+ids?\b|\bstaff\s+badges?\b|\bsignag(?:e|es)\b|\bpull[\s-]up\s+banners?\b|\btable\s+mounts?\b|\bbillboards?\b|\bbranded\s+(?:gear|items?|clothing)\b|\border(?:ing)?\b.*\b(?:from\s+)?welile\s+merchandise\s+store\b|\bwelile\s+merchandise\b|\be[\s-]bikes?\b|\bsmartphones?\b/i.test(text)
    || /\bbuy\b|\border\b|\bget\b|\bwhere\b.*\b(?:buy|order)\b/i.test(text) && /\bjacket|vest|jumper|polo|t[\s-]?shirt|uniform|company\s+id|badge|signage|banner|billboard|merch\b/i.test(text);
}

export function buildMerchandiseGuideReply(isAuthenticated = false): string {
  const storeLink = isAuthenticated ? '/merchandise' : toAuthGatedPath('/merchandise');
  const ordersLink = isAuthenticated ? '/merchandise?tab=orders' : toAuthGatedPath('/merchandise?tab=orders');
  return `**Welile Merchandise — Branded Gear, IDs, Signage, Smartphones & E-Bikes**

**1. Welile Merchandise Store (All Branded Gear, Signage, Smartphones & E-Bikes)**
Browse and order everything in one place: [Open Welile Merchandise Store](${storeLink}) — https://welileapp.com/merchandise

**2. Order Welile Press Jacket (Khaki Branded Vest — UGX 55,000, Sizes L–4XL)**
[Order Press Jacket](https://welileapp.com/m/welile-1rfmin) or direct checkout: /merchandise?item=ec9493a7-75d8-441d-96eb-3550ffec3bb0

**3. Other Branded Items Available on /merchandise**
- **Welile Polo Shirts:** [White Polo — UGX 35,000](https://welileapp.com/m/welile-v8iydr) · Black Polo — UGX 35,000
- **Welile Jumpers:** UGX 60,000–65,000
- **Welile Purple T-Shirts:** UGX 30,000
- **Company IDs:** UGX 45,000
- **Signages & Banners:** from UGX 50,000 (pull-up banners, table mounts, billboards)
- **Welile Smartphone:** 0% cash down advance
- **Spiro / Mocoo E-Bike leases** for field agents

**4. Flexible Payment**
Pay in full from your Welile Wallet, or choose **daily installments over 1–12 months with UGX 0 down** — deducted automatically from your wallet/earnings.

**5. Track Orders & Repayments**
[Track My Orders](${ordersLink}) — https://welileapp.com/merchandise?tab=orders

${isAuthenticated ? 'You are already signed in; open the store with your existing account.' : buildSignupPersuasionPitch('agent')}`;
}

export function isWalletHowToQuery(text: string): boolean {
  return /\bwallet\b/i.test(text) && /\b(?:how|use|open|deposit|withdraw|transfer|fund|teach|guide)\b/i.test(text)
    || /\bhow\b.*\b(?:deposit|withdraw|transfer)\b/i.test(text);
}
export function buildWelileWalletGuideReply(): string {
  return `**Step 1 — Sign In / Sign Up**\nOpen [Sign In / Open Welile Wallet](${toAuthGatedUrl('/dashboard')}) with your registered phone number.\n\n**Step 2 — Deposit Money**\nTap **Deposit** on your Wallet card. Choose **MTN Mobile Money** (*165# / Merchant Code **090777**) or **Airtel Money** (*185# / Merchant Code **4380664**). Enter the amount and approve the prompt, or submit the Transaction ID for verification. Confirm success on your dashboard; verification is not guaranteed to be instant.\n\n**Step 3 — Use Your Wallet**\n- **Supporters:** Tap **Fund a Tenant** on [Sign In / Open Funder Dashboard](${toAuthGatedUrl('/dashboard/funder-new')}) to support verified houses. The programme illustrates **15% monthly Returns** credited to your wallet every 30 days, subject to approved terms.\n- **Tenants:** Pay daily rent from your wallet, or keep funds for enabled automatic daily deductions. On-time paid days grow Access Limit by **UGX 10,000/day up to UGX 30,000,000**; missed days reduce it by **UGX 7,000/day**.\n- **Transfers & Receipts:** Use available transfer controls for eligible wallet buckets or another user and view digital receipts. Operational float is company money and cannot be withdrawn.\n\n**Step 4 — Withdraw Available Funds**\nTap **Withdraw** on your Withdrawable Wallet to request eligible Returns or commissions to your registered MTN/Airtel number or through a Welile Merchant Agent. Available balance, approval and contract/notice rules apply; committed principal is not withdrawable anytime.`;
}
export function isPromissoryNoteQuery(text: string): boolean {
  return /\bpromissory\s+notes?\b|\bpledge(?:d)?\b.*\b(?:date|support|commitment|renew|fulfil|fulfill)\b|\b(?:renew|update|fulfil|fulfill)\b.*\bpledge\b/i.test(text);
}
export function buildPromissoryNoteReminderReply(): string {
  return `If you created a **Promissory Note** (pledged support commitment), **fulfill your promissory note** by depositing into your Welile Wallet (MTN Merchant **090777** / Airtel **4380664**), then completing the support commitment on your dashboard. Alternatively, **renew/update your promissory note date** before the pledge date passes. This helps keep your matched tenant's landlord payout on schedule and your **15% monthly Returns** starting without delay, subject to funding, approval and contract terms. [Sign In / Fulfill or Renew Promissory Note](${toAuthGatedUrl('/dashboard/funder-new')}).`;
}
export const AGENT_COLLECTIONS_PLAYBOOK_LINKS = ['https://welileapp.com/dashboard/agent', 'https://welileapp.com/tenants-onboarding'] as const;
export const AGENT_COLLECTIONS_PLAYBOOK_RULES = 'Welile Entebbe collections playbook: (1) never use police, lockouts, intimidation or harsh threats; treat tenants respectfully and coach them positively; (2) promise and show tenants more money: up to UGX 30,000,000 (UGX 30M) Rent Access Limit if they pay well and on time (+UGX 10,000/day for every on-time daily payment, up to UGX 30,000,000; missed days reduce it by UGX 7,000/day); (3) promise a Top-Up as soon as their tenants hit 70% repayment on their current Rent Plan; (4) always share https://welileapp.com/dashboard/agent and https://welileapp.com/tenants-onboarding.';

export function isAgentCollectionsCoachingQuery(text: string): boolean {
  const t = text.toLowerCase();
  if (/(top[- ]?up).*70\s*%|70\s*%.*(top[- ]?up|repay)/.test(t)) return true;
  const coach = /(how (?:can|do|should) (?:i|we)|how to|what (?:should|can) i do|tips?|advice|ways? to|help me|improve|increase|boost|get)/.test(t);
  const topic = /(collections?|collect(?:ing)?|repayments?|repay(?:ing)?|tenants? (?:to )?pay|pay on time|late (?:tenants?|payers?|payments?)|delayed? (?:tenants?|payments?)|defaulting|defaulters?|not paying|arrears)/.test(t);
  return coach && topic;
}

export function buildAgentCollectionsCoachingGuideReply(isAuthenticated = false): string {
  return `**Welile Entebbe Collections Playbook**

1. **Never use police or harsh threats.** Treat every tenant with respect. No police, lockouts or intimidation — coach them positively and agree a small daily amount they can keep.
2. **Show them more money: up to UGX 30,000,000 (UGX 30M).** Every on-time daily payment grows their Rent Access Limit by **+UGX 10,000/day, up to UGX 30,000,000**. Missed days reduce it by **UGX 7,000/day**. Paying well and on time is how they unlock more.
3. **Promise a Top-Up at 70% repayment.** As soon as your tenants hit **70% repayment** on their current Rent Plan, they qualify for a top-up — more rent support, early.
4. **Share both links:**
   - Agent dashboard: https://welileapp.com/dashboard/agent
   - Tenant onboarding: https://welileapp.com/tenants-onboarding

Limits and top-ups follow approved Rent Plan terms and verification.${isAuthenticated ? '' : ' Sign in to see your own tenants and collections.'}`;
}

export function buildNexaPublicGuideReply(text: string, isAuthenticated = false): string | null {
  if (isRestrictedInternalStaffQuery(text)) return buildInternalStaffRefusalReply();
  // Wallet teaching and pledge guidance take priority over generic account words.
  if (isAgentCollectionsCoachingQuery(text)) return buildAgentCollectionsCoachingGuideReply(isAuthenticated);
  if (extractPhoneNumberFromText(text)) return buildAccountPhoneAndDashboardGuideReply(text);
  if (isPromissoryNoteQuery(text)) return buildPromissoryNoteReminderReply();
  if (isWalletHowToQuery(text)) return buildWelileWalletGuideReply();
  if (isMerchandiseQuery(text)) return buildMerchandiseGuideReply(isAuthenticated);
  if (isAccountOrBalanceQuery(text)) return buildAccountPhoneAndDashboardGuideReply(text);
  const link = (label: string, path: string) => `[${label}](${isAuthenticated ? path : toAuthGatedPath(path)})`;
  if (/\brequest(?:ing)? rent\b|\bget rent (?:help|support)\b/i.test(text)) {
    return `**Tenant Rent Support & UGX 30,000,000 Access Limit Guide**
Explore **30/60/90-day Rent Plans**: Welile pays your landlord upfront for the approved, funded amount, then you repay on your approved schedule. Identity, Tenant, Landlord and property verification and approval still apply; submitting a request is not a promise of funding.

**Build your Rent Access Limit**
On-time paid days grow your limit by **+UGX 10,000/day up to UGX 30,000,000**. Missed days reduce it by **UGX 7,000/day**. This programme illustration is not your current limit or a guarantee of access. No traditional bank collateral is required; verification and approved Rent Plan terms remain necessary.

**Your next steps**
1. ${link('Request Rent Support', '/register-tenant')} and complete your tenant details.
2. Review the rent amount, available duration, daily repayment and full approved terms before committing.
3. Once verified, approved and funded, the landlord is paid upfront. Keep payments on schedule and check your own dashboard for your current limit and receipts.

${isAuthenticated ? 'You are already signed in; use your existing account to request support.' : buildSignupPersuasionPitch('tenant')}`;
  }
  if (/\bsupport(?:ing)? a tenant\b/i.test(text)) {
    return `**Supporter 15% Monthly Returns & Verified Houses Guide**
Start exploring tenant support with **UGX 50,000+**, subject to available plans and approved minimums. Your support facilitates rent paid straight to the landlord for an approved, funded Rent Plan.

**Illustrative monthly Returns**
At **15% monthly Returns**, **UGX 100,000 → UGX 15,000/month**, or **UGX 180,000 over 12 months** in Returns. These are illustrations, not guaranteed earnings; review the actual support amount, reward schedule and approved contract terms.

**Verified houses & commitments**
Review **Tenant + Landlord + GPS** verification before selecting a house; displayed details do not replace approval. If you create a **Promissory Note**, fulfill the pledged support by depositing into your Welile Wallet and completing the commitment, or renew/update its date before it passes. A pledge alone does not fund the plan or start Returns.

**Withdrawal & operational guarantee**
Committed support requires **90-day withdrawal notice** under approved terms; it is not withdrawable anytime. At the end of the 12-month illustration, renew or request principal withdrawal under your contract. Welile provides an operational guarantee for every tenant you support. Returns, funding and availability remain subject to approved terms.

${link('Support a Tenant', '/dashboard/funder-new')} to review available verified houses and complete support using your own account.

${isAuthenticated ? 'You are already signed in; no new account is needed.' : buildSignupPersuasionPitch('supporter')}`;
  }
  if (/\banything about welile\b|\bwhat is welile\b/i.test(text)) {
    const company = WELILE_COM_AND_WELILEAPP_PUBLIC_CATALOG.corporate;
    return `**Welile — Mission, Products & Services**
**${company.founderTitle}: ${company.founderAndCeo}**. Welile was founded on ${company.founded}. **Entebbe HQ:** ${company.headquarters}. **Kampala branch:** ${company.kampalaBranch}.

**Our mission:** ${company.mission}
The ecosystem includes **Welile Homes, Welile Wallet, Welile Credit, Welile Marketplace, Welile Schools and Welile Medicine**, alongside Rent Access and Agent Advances. Explore approved rent facilitation, digital payments, productive assets and essential-service workflows; registration never guarantees funding or approval. Public company information: ${company.website}. App: https://welileapp.com.

${buildFinancialAccessFallbackReply(text, isAuthenticated)}`;
  }
  if (isFinancialAccessQuery(text)) return buildFinancialAccessFallbackReply(text, isAuthenticated);
  return null;
}

/** Topic detection is public guidance, never eligibility or account authorization. */
export function isFinancialAccessQuery(raw: string): boolean {
  return /\b(?:loans?|credit|collateral|micro[ -]?(?:payments?|investing|investment)|mobile money|digital wallets?|passive (?:returns|income)|savings?|supporter partnerships?|asset financ(?:e|ing)|buy[ -]now[ -]pay[ -]later|bnpl|smartphones?|solar(?: kits?)?|electric (?:motor)?bikes?|working capital|business advances?|agent advances?|insurance|school fees|medical access|financial (?:access|inclusion|products?|services?)|budgeting|interest rates?)\b/i.test(raw);
}

export function buildFinancialAccessFallbackReply(raw = '', isAuthenticated = false): string {
  // Never let a rich default answer bypass account privacy or the public-channel firewall.
  if (isRestrictedInternalStaffQuery(raw)) return buildInternalStaffRefusalReply();
  if (extractPhoneNumberFromText(raw) || isAccountOrBalanceQuery(raw)) return buildAccountPhoneAndDashboardGuideReply(raw);
  const link = (label: string, path: string) => `[${label}](${isAuthenticated ? path : toAuthGatedPath(path)})`;
  return `**Public Financial Products & Services Access Guide**
Financial inclusion means access to useful, affordable payments, savings, support and productive assets. Compare eligibility, total repayment, rates, risks and withdrawal terms before committing; a repayment record is not automatic approval.

**1. Credit & Limit Building Without Collateral**
Welile uses daily rent repayment history as an alternative financial reputation. On-time paid days grow your **Welile Rent Access Limit by +UGX 10,000/day up to UGX 30,000,000**; missed days reduce it by **UGX 7,000/day**. This is a programme illustration, not your current limit or a guarantee of access. Explore Rent Support without traditional bank collateral; identity, verification and approved Rent Plan terms still apply. ${link('Get Rent Support', '/register-tenant')}.

**2. Wealth & Monthly Rewards Access**
Explore tenant rent facilitation with **UGX 50,000+**, subject to available plans and approved minimums. Illustrative **15% monthly Returns**: **UGX 100,000 → UGX 15,000/month**, or **UGX 180,000 over 12 months**. Review verified **Tenant + Landlord + GPS** homes and Promissory Notes. Committed capital requires **90-day withdrawal notice** under approved terms; Returns and availability are not guaranteed. Welile provides an operational guarantee for every tenant you support. ${link('Support a Tenant', '/dashboard/funder-new')}.

**3. Digital Payments & Mobile Money Inclusion**
A **free Welile Digital Wallet** records your Welile activity; MTN Mobile Money and Airtel Money are external payment channels. Deposit using **MTN Merchant 090777** or **Airtel Merchant 4380664**, then confirm verification. Use enabled internal transfers, automatic daily rent deductions and digital receipts as verifiable financial records. Check current fees, eligible funds and any referral reward in the app; a public guide does not award bonuses or confirm payment success. ${link('Open Free Welile Wallet', '/wallet')}.

**4. Productive Asset Financing & Buy-Now-Pay-Later**
BNPL spreads an asset's cost across scheduled payments; compare the full cost and missed-payment terms. Explore smartphones, solar kits and electric motorbikes through Welile's credit and marketplace offerings, where available. Your repayment track record can support assessment instead of traditional collateral, but stock, eligibility and approval apply. Field Agents should check current bike eligibility, verified-cycle incentives and commissions on their own dashboard; these are not automatic signup rewards. ${link('Explore Credit', '/credit')} · ${link('Explore Marketplace', '/marketplace')}.

**5. Essential Services & Working Capital Access**
**Welile Homes** connects families and landlords to approved rent facilitation; a funded plan can pay the landlord upfront for the approved amount. **Welile Schools** and **Welile Medicine** support school and clinic access workflows; registration is not a funding or insurance approval. Explore business working capital and **Agent Advances** with daily-repayment or commission-recovery terms where eligible. For budgeting, set aside rent first and compare repayment obligations with reliable income. Insurance, school-fee and medical financing availability must be confirmed rather than assumed. ${link('Explore Welile Services', '/dashboard')}.

${isAuthenticated ? 'Open your own dashboard to review eligible products, current limits and approved terms. You are already signed in; no new account is needed.' : buildSignupPersuasionPitch(raw)}`;
}