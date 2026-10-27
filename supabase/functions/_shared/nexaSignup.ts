import { extractPhoneNumberFromText, toAuthGatedPath } from './nexaGuides.ts';

export type InquiryRole = 'supporter' | 'tenant' | 'agent' | 'landlord';
export interface InquiryLeadOptions { leadName?: string; leadPhone?: string; leadRole?: string }
export interface InquirySignupResult { status: 'signup_required'; role: InquiryRole; loginUrl: string }
const roles: readonly InquiryRole[] = ['supporter', 'tenant', 'agent', 'landlord'];

/** Intended role is a public preference, never an authorization grant. */
export function detectInquiryIntendedRole(text: string): InquiryRole {
  if (roles.includes(text.trim().toLowerCase() as InquiryRole)) return text.trim().toLowerCase() as InquiryRole;
  if (/\b(?:supporter|supporting|funding|partner|promissory|returns)\b|15\s*%|\bsupport (?:a |the )?tenant\b/i.test(text)) return 'supporter';
  if (/\b(?:agent|commission|jobs?|bikes?)\b/i.test(text)) return 'agent';
  if (/\b(?:landlord|property)\b/i.test(text)) return 'landlord';
  return 'tenant';
}

export function extractInquiryLeadDetails(text: string, options: InquiryLeadOptions = {}) {
  const phone = extractPhoneNumberFromText(options.leadPhone ?? '') ?? extractPhoneNumberFromText(text);
  const phoneKey = phone ? phone.replace(/\D/g, '').slice(-9) : null;
  const phrase = text.match(/\bmy name is\s+([^,\n.!?\d]{2,80})/i)
    ?? text.match(/\bI am\s+([^,\n.!?\d]{2,80})/i)
    ?? text.match(/^\s*([^,\n\d]{2,80}),\s*(?:07|\+?2567)/);
  const candidate = (options.leadName ?? phrase?.[1] ?? '').trim();
  // Do not mistake statements such as "I am looking for rent" for names.
  const name = /^[\p{L}][\p{L} '\-]{1,79}$/u.test(candidate)
    && !/\b(?:looking|interested|tenant|landlord|agent|supporter|from|asking|want|need)\b/i.test(candidate) ? candidate : null;
  const role = options.leadRole && roles.includes(options.leadRole as InquiryRole)
    ? options.leadRole as InquiryRole : detectInquiryIntendedRole(text);
  return { name, phoneKey, fullPhone: phoneKey ? `256${phoneKey}` : null, displayPhone: phoneKey ? `0${phoneKey}` : null, role };
}

export function buildInquirySignupResult(roleOrText: string): InquirySignupResult {
  const role = detectInquiryIntendedRole(roleOrText);
  const target = role === 'supporter' ? '/dashboard/funder-new' : role === 'agent' ? '/become-agent' : role === 'landlord' ? '/register-landlord' : '/dashboard';
  return { status: 'signup_required', role, loginUrl: `https://welileapp.com${toAuthGatedPath(target)}&signup=1&role=${role}&signup_source=nexa_inquiry` };
}

/** Never accept credentials, created/existing claims or arbitrary URLs from chat events. */
export function parseInquirySignupResult(value: unknown): InquirySignupResult | null {
  if (!value || typeof value !== 'object') return null;
  const result = value as Record<string, unknown>;
  if (result.status !== 'signup_required' || typeof result.role !== 'string' || !roles.includes(result.role as InquiryRole)) return null;
  return buildInquirySignupResult(result.role);
}

export function buildAutoSignupConfirmationBanner(result: InquirySignupResult): string {
  const safe = buildInquirySignupResult(result.role);
  return `**Your next step: open your Welile account**\n[Continue to free signup](${safe.loginUrl}). Complete the secure signup steps and choose your own password. If you already have an account, sign in instead. Sharing a phone number here does not create an account or sign you in.`;
}

export function buildSignupPersuasionPitch(roleOrText: string, hasPhone = false): string {
  const result = buildInquirySignupResult(roleOrText);
  const hook: Record<InquiryRole, string> = {
    supporter: 'Explore verified houses with Tenant, Landlord and GPS details. Illustrative 15% monthly Returns: support UGX 100,000 for UGX 15,000/month, subject to approved terms.',
    tenant: 'Build your Rent Access Limit with on-time paid days: +UGX 10,000/day up to UGX 30,000,000. Missed days reduce it by UGX 7,000/day; eligibility and approval apply.',
    agent: 'Join as a Field Agent to help tenants, register properties and track eligible commissions and incentives on your dashboard. Approved programme conditions apply.',
    landlord: 'Register your property and explore upfront landlord rent payments through approved, funded Rent Plans.',
  };
  return `${hook[result.role]}\n\n**Free signup + Welile Digital Wallet**\n${hasPhone ? 'You can use your phone number on the secure signup page; no need to share it again here.' : 'Ready to start? Open free signup or use the signup bar in Nexa.'} Complete the secure signup steps, consent to the terms and choose your own password. No account is created just by asking a question.\nYour wallet provides digital receipts and MTN Merchant **090777** / Airtel Merchant **4380664** deposit options; verification and available-funds rules apply. [Continue to free signup](${result.loginUrl}). Already registered? Sign in instead.`;
}