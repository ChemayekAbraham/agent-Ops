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
export function buildNexaPublicGuideReply(text: string): string | null {
  // Wallet teaching and pledge guidance take priority over generic account words.
  if (extractPhoneNumberFromText(text)) return buildAccountPhoneAndDashboardGuideReply(text);
  if (isPromissoryNoteQuery(text)) return buildPromissoryNoteReminderReply();
  if (isWalletHowToQuery(text)) return buildWelileWalletGuideReply();
  if (isAccountOrBalanceQuery(text)) return buildAccountPhoneAndDashboardGuideReply(text);
  return null;
}