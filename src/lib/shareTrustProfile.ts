import { getPublicOrigin } from './getPublicOrigin';
import { getRiskTierLabel } from './welileAiId';
import { formatUGX } from './rentCalculations';
import type { TrustProfile } from '@/hooks/useTrustProfile';

/** Build the public lender-facing URL */
export function buildProfileShareUrl(aiId: string): string {
  return `${getPublicOrigin()}/id/${aiId.toUpperCase()}`;
}

/** Compose the WhatsApp share message */
export function buildWhatsAppMessage(profile: TrustProfile): string {
  const tier = getRiskTierLabel(profile.trust.tier);
  const url = buildProfileShareUrl(profile.ai_id);
  const lines = [
    `🪪 *Welile Trust Profile*`,
    ``,
    `*${profile.identity.full_name}*`,
    `🔐 ID: ${profile.ai_id}`,
    `🛡️ Trust Tier: *${tier.label}* (${profile.trust.score}/100)`,
  ];

  if (profile.trust.borrowing_limit_ugx > 0) {
    lines.push(`💰 Welile Vouches Up To: *${formatUGX(profile.trust.borrowing_limit_ugx)}*`);
  }

  if (profile.payment_history.total_rent_plans > 0) {
    lines.push(`📊 On-time payment rate: ${profile.payment_history.on_time_rate}%`);
  }

  lines.push(
    ``,
    `View full profile (no app needed):`,
    url,
    ``,
    `_Powered by Welile — Africa's rent trust network_`,
  );

  return lines.join('\n');
}

/** Open WhatsApp share sheet */
export function shareProfileOnWhatsApp(profile: TrustProfile, recipientPhone?: string) {
  const msg = encodeURIComponent(buildWhatsAppMessage(profile));
  const base = recipientPhone
    ? `https://wa.me/${recipientPhone.replace(/[^\d]/g, '')}`
    : `https://wa.me/`;
  window.open(`${base}?text=${msg}`, '_blank');
}

/** Native share sheet (mobile) with link fallback */
export async function shareProfileNative(profile: TrustProfile): Promise<boolean> {
  const url = buildProfileShareUrl(profile.ai_id);
  const text = `${profile.identity.full_name} — Welile Trust Profile (${profile.ai_id})`;
  if (navigator.share) {
    try {
      await navigator.share({ title: text, text, url });
      return true;
    } catch {
      return false;
    }
  }
  return false;
}
