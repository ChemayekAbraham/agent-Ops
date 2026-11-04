/**
 * Welile Homes landlord portfolio verification: one SMS code to the landlord per portfolio.
 * Sending uses the shared `sms-otp` service; checking happens only in
 * `wh_portfolio_verify_landlord` on the server. Tenants are never sent a code.
 */
import { supabase } from '@/integrations/supabase/client';

/** Same key the server uses: last 9 digits of the phone. */
export function landlordPhoneKey(phone?: string | null): string | null {
  const d = (phone ?? '').replace(/\D/g, '');
  return d.length >= 9 ? d.slice(-9) : null;
}

export async function sendLandlordPortfolioCode(args: { phone: string; tenantCount: number }) {
  const { data, error } = await supabase.functions.invoke('sms-otp', {
    body: {
      action: 'send', phone: args.phone, tenant_count: args.tenantCount,
      category: 'welile_homes_landlord_verify', purpose: 'welile_homes_landlord_verify',
    },
  });
  if (error) {
    let msg = error.message;
    try { const b = await (error as any).context?.json?.(); if (b?.error) msg = b.error; } catch { /* keep */ }
    throw new Error(msg);
  }
  if ((data as any)?.error) throw new Error((data as any).error);
}

export type VerifyResult = { success: true; tenantCount: number } | { success: false; error: string };

export async function verifyLandlordPortfolioCode(args: { phone: string; code: string }): Promise<VerifyResult> {
  const { data, error } = await (supabase.rpc as any)('wh_portfolio_verify_landlord', {
    p_landlord_phone: args.phone, p_code: args.code,
  });
  if (error) throw new Error(error.message);
  if (!data?.success) return { success: false, error: String(data?.error ?? 'Verification failed') };
  return { success: true, tenantCount: Number(data.tenant_count ?? 0) };
}

export interface PortfolioStatus { verified: boolean; verifiedAt: string | null; phoneSent: string | null }

export async function fetchMyPortfolioStatus(): Promise<Map<string, PortfolioStatus>> {
  const { data, error } = await (supabase.rpc as any)('wh_my_portfolio_status');
  if (error) throw new Error(error.message);
  const m = new Map<string, PortfolioStatus>();
  for (const r of (data ?? []) as any[]) {
    m.set(r.landlord_phone_key, { verified: !!r.verified, verifiedAt: r.verified_at ?? null, phoneSent: r.phone_sent ?? null });
  }
  return m;
}
