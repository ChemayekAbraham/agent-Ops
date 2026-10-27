import { RENT_ACCESS_MAX_LIMIT_UGX, RENT_ACCESS_PAID_INCREMENT_UGX, RENT_ACCESS_MISSED_DECREMENT_UGX } from './rentAccessLimit';
import { formatFixedUGX } from './supportPlanExample';
import { ensureWelileEmailHeader, ensureWelileEmailTextHeader } from './emailHeader';
export { RENT_ACCESS_MAX_LIMIT_UGX, RENT_ACCESS_PAID_INCREMENT_UGX, RENT_ACCESS_MISSED_DECREMENT_UGX };
export const ACCESS_LIMIT_MAX_UGX = RENT_ACCESS_MAX_LIMIT_UGX;
export const ACCESS_LIMIT_DAILY_GROWTH_UGX = RENT_ACCESS_PAID_INCREMENT_UGX;
export const ACCESS_LIMIT_MISSED_DAY_REDUCTION_UGX = RENT_ACCESS_MISSED_DECREMENT_UGX;
export const ACCESS_LIMIT_MISSED_DROP_UGX = ACCESS_LIMIT_MISSED_DAY_REDUCTION_UGX;
export const ACCESS_LIMIT_MIN_UGX = 30_000;
export const formatAccessUgx = formatFixedUGX;
export function toWhatsAppPhone(phone?: string | null): string | null {
  let digits = (phone ?? '').replace(/\D/g, '');
  if (/^0\d{9}$/.test(digits)) digits = `256${digits.slice(1)}`;
  else if (/^\d{9}$/.test(digits)) digits = `256${digits}`;
  return /^[1-9]\d{7,14}$/.test(digits) ? digits : null;
}
export const ACCESS_LIMIT_CAMPAIGN_COPY = 'Pay on time daily: grow your Rent Access Limit by UGX 10,000 up to UGX 30,000,000. Missed days reduce it by UGX 7,000/day.';
export function buildTenantAccessLimitWhatsAppMessage(): string {
  return `${ACCESS_LIMIT_CAMPAIGN_COPY}\nPay through Welile: https://welileapp.com/dashboard/tenant`;
}
export function buildAgentAccessLimitWhatsAppMessage(): string {
  return `Help your tenants grow their rent access. ${ACCESS_LIMIT_CAMPAIGN_COPY}\nhttps://welileapp.com/ai?role=tenant`;
}
function whatsappUrl(message: string, phone?: string | null): string {
  const recipient = toWhatsAppPhone(phone);
  return `https://wa.me/${recipient ?? ''}?text=${encodeURIComponent(message)}`;
}
export const buildTenantAccessLimitWhatsAppUrl = (phone?: string | null) => whatsappUrl(buildTenantAccessLimitWhatsAppMessage(), phone);
export const buildAgentAccessLimitWhatsAppUrl = (phone?: string | null) => whatsappUrl(buildAgentAccessLimitWhatsAppMessage(), phone);
export function buildTenantAccessLimitSms(): string {
  return 'WELILE: Pay daily, grow rent access +UGX 10,000/day up to UGX 30,000,000. Missed days: -UGX 7,000/day. welileapp.com';
}
export function buildAgentAccessLimitSms(): string {
  return 'WELILE agents: Help tenants pay daily: +UGX 10,000/day rent access up to UGX 30,000,000. Missed days: -UGX 7,000/day. welileapp.com';
}
export interface AccessLimitEmail { subject: string; text: string; html: string }
function email(agent: boolean): AccessLimitEmail {
  const text = agent ? buildAgentAccessLimitWhatsAppMessage() : buildTenantAccessLimitWhatsAppMessage();
  return { subject: agent ? 'Help tenants grow their Rent Access Limit' : 'Grow your Rent Access Limit', text: ensureWelileEmailTextHeader(text), html: ensureWelileEmailHeader(`<p>${text.replace(/\n/g, '</p><p>')}</p>`) };
}
export const buildTenantAccessLimitEmail = () => email(false);
export const buildAgentAccessLimitEmail = () => email(true);
export const buildTenantAccessLimitSmsCopy = buildTenantAccessLimitSms;
export const buildAgentAccessLimitSmsCopy = buildAgentAccessLimitSms;
export const buildTenantAccessLimitEmailTemplate = buildTenantAccessLimitEmail;
export const buildAgentAccessLimitEmailTemplate = buildAgentAccessLimitEmail;
export function buildAccessLimitMailtoHref(to: string, message: AccessLimitEmail = buildTenantAccessLimitEmail()): string {
  const emailAddress = /^[^\s@?&#]+@[^\s@?&#]+\.[^\s@?&#]+$/.test(to) ? to : '';
  return `mailto:${emailAddress}?subject=${encodeURIComponent(message.subject)}&body=${encodeURIComponent(message.text)}`;
}