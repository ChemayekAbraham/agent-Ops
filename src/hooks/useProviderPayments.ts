/**
 * What has actually been paid to the SMS providers (Yoola, Africa's Talking).
 *
 * Finance records each top-up as a staff requisition titled for the provider
 * ("YOOLA SUBSCRIPTION", "AFRICA'S TALKING VOICE AND SMS API"). Once approved
 * and credited, that requisition is the payment. There is no provider column,
 * so the provider is recognised from the title first, then the reason.
 *
 * This is deliberately NOT part of get_cfo_money_paid_out (that function counts
 * withdrawal_requests only), so the Money Paid Out total keeps matching the
 * ledger. The figures here sit beside it and beside the estimated usage from
 * get_sms_cost_report. Africa's Talking requisitions can also cover its voice
 * API and sender ID, so they are payments to the provider, not SMS-only spend.
 *
 * Data-fetching only; read-only.
 */
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

export type SmsProviderName = 'Yoola' | "Africa's Talking";
export const SMS_PROVIDERS: SmsProviderName[] = ['Yoola', "Africa's Talking"];

export interface ProviderPayment {
  code: string;
  title: string;
  provider: SmsProviderName;
  amount: number;
  /** ISO timestamp of the wallet credit (falls back to creation time). */
  paidAt: string;
  /** Kampala calendar day, yyyy-MM-dd. */
  day: string;
}

const AT_PATTERN = /africa.?s?\s*talking/i;

/** The provider a requisition paid, from its title first, then its reason. Null when it names neither. */
export function providerOf(title: string, reason: string): SmsProviderName | null {
  const hit = (text: string): SmsProviderName | null => {
    if (/yoola/i.test(text)) return 'Yoola';
    if (AT_PATTERN.test(text)) return "Africa's Talking";
    return null;
  };
  return hit(title) ?? hit(reason);
}

/** Kampala (UTC+3, no DST) calendar day of an instant. */
export function kampalaDay(iso: string): string {
  return new Date(new Date(iso).getTime() + 3 * 3600 * 1000).toISOString().slice(0, 10);
}

export function paymentsBetween(rows: ProviderPayment[], startDay: string, endDay: string) {
  return rows.filter((p) => p.day >= startDay && p.day <= endDay);
}

export function sumPayments(rows: ProviderPayment[], provider?: SmsProviderName) {
  return rows.filter((p) => !provider || p.provider === provider).reduce((s, p) => s + p.amount, 0);
}

export function countPayments(rows: ProviderPayment[], provider?: SmsProviderName) {
  return rows.filter((p) => !provider || p.provider === provider).length;
}

export function useProviderPayments() {
  return useQuery({
    queryKey: ['sms-provider-payments'],
    queryFn: async (): Promise<ProviderPayment[]> => {
      const { data, error } = await supabase
        .from('staff_requisitions')
        .select('requisition_code, title, reason, amount, approved_amount, stage, wallet_credit_status, credited_at, created_at')
        .eq('stage', 'approved')
        .eq('wallet_credit_status', 'credited')
        .order('created_at', { ascending: false })
        .limit(2000);
      if (error) throw error;
      const out: ProviderPayment[] = [];
      for (const r of data ?? []) {
        const provider = providerOf(r.title ?? '', r.reason ?? '');
        if (!provider) continue;
        const paidAt = r.credited_at ?? r.created_at;
        out.push({
          code: r.requisition_code,
          title: r.title,
          provider,
          amount: Number(r.approved_amount ?? r.amount ?? 0),
          paidAt,
          day: kampalaDay(paidAt),
        });
      }
      return out.sort((a, b) => b.paidAt.localeCompare(a.paidAt));
    },
    staleTime: 2 * 60 * 1000,
  });
}
