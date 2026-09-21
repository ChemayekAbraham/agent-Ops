import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

/**
 * Tenant Communications data layer.
 *
 * Read-only over the existing payment-notice engine: the live message
 * templates, the merchant codes in payment_channels, the configurable
 * customer-care numbers and the recent send log. The only write is the care
 * number itself, through set_tenant_support_contact.
 */

export interface CommsTemplate {
  event_key: string;
  label: string | null;
  active: boolean;
  message_class: string | null;
  body_template: string | null;
}

export interface CommsChannel {
  provider: string;
  merchant_code: string;
  merchant_name: string | null;
  active: boolean;
}

export interface SupportContact {
  id: string;
  label: string;
  phone: string;
  sort_order: number;
  active: boolean;
}

export interface CommsTotal {
  event_key: string;
  channel: string;
  status: string;
  count: number;
}

export interface CommsRecent {
  id: string;
  tenant_id: string;
  tenant_name: string | null;
  event_key: string;
  channel: string;
  status: string;
  skip_reason: string | null;
  provider: string | null;
  phone: string | null;
  created_at: string;
}

export interface TenantCommunicationsOverview {
  as_of: string;
  rules: Record<string, unknown>;
  templates: CommsTemplate[];
  channels: CommsChannel[];
  support_contacts: SupportContact[];
  totals: CommsTotal[];
  recent: CommsRecent[];
}

export function useTenantCommunications(limit = 50) {
  return useQuery({
    queryKey: ['tenant-communications', limit],
    queryFn: async (): Promise<TenantCommunicationsOverview> => {
      const { data, error } = await supabase.rpc('get_tenant_communications_overview', {
        p_limit: limit,
      });
      if (error) throw error;
      return data as unknown as TenantCommunicationsOverview;
    },
    staleTime: 60_000,
  });
}

export function useSaveSupportContact() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      id?: string | null;
      label: string;
      phone: string;
      sort_order?: number;
      active?: boolean;
    }) => {
      const { data, error } = await supabase.rpc('set_tenant_support_contact', {
        p_id: input.id ?? null,
        p_label: input.label,
        p_phone: input.phone,
        p_sort_order: input.sort_order ?? 1,
        p_active: input.active ?? true,
      });
      if (error) throw error;
      return data as unknown as string;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['tenant-communications'] });
    },
  });
}

export interface TenantPaymentMessageFigures {
  tenant_id: string;
  rent_amount: number;
  total_expected: number;
  paid_to_date: number;
  remaining: number;
  term_end: string | null;
  days_left_in_cycle: number | null;
  days_after_cycle: number | null;
  tier_key: string;
  current_access: number;
  current_topup: number;
  next_level_required: number | null;
  next_level_access: number | null;
  next_level_deadline: string | null;
}

/** The exact figures a tenant's confirmation message will quote. */
export function useTenantPaymentMessageFigures(tenantId: string | null) {
  return useQuery({
    queryKey: ['tenant-payment-message-figures', tenantId],
    enabled: Boolean(tenantId),
    queryFn: async (): Promise<TenantPaymentMessageFigures | null> => {
      const { data, error } = await supabase.rpc('get_tenant_payment_message_vars', {
        p_tenant_ids: [tenantId as string],
      });
      if (error) throw error;
      const rows = (data ?? []) as unknown as TenantPaymentMessageFigures[];
      return rows[0] ?? null;
    },
  });
}

const ugx = (n: number | null | undefined) =>
  `UGX ${Math.round(Number(n || 0)).toLocaleString()}`;

/**
 * Mirrors the sentences the edge function builds, so the tab previews the real
 * wording. Exact amounts only — a tenant is never shown a percentage.
 */
export function buildEligibilityPreview(
  figures: TenantPaymentMessageFigures | null | undefined,
  contacts: SupportContact[],
  channels: CommsChannel[],
): string {
  if (!figures) return '';
  const parts: string[] = [];

  if (Number(figures.total_expected) > 0) {
    parts.push(
      Number(figures.remaining) <= 0
        ? `You have now paid ${ugx(figures.paid_to_date)} of ${ugx(figures.total_expected)} — nothing remains on this Rent Plan.`
        : `You have now paid ${ugx(figures.paid_to_date)} of ${ugx(figures.total_expected)}, leaving ${ugx(figures.remaining)} to pay.`,
    );
  }

  const left = Number(figures.days_left_in_cycle ?? 0);
  const after = Number(figures.days_after_cycle ?? 0);
  if (left > 0) parts.push(`Your payment cycle ends in ${left} day${left === 1 ? '' : 's'}.`);
  else if (after > 0) parts.push(`Your payment cycle ended ${after} day${after === 1 ? '' : 's'} ago.`);

  const access = Number(figures.current_access ?? 0);
  const topup = Number(figures.current_topup ?? 0);
  if (access > 0) {
    parts.push(
      topup > 0
        ? `You have qualified for rent of up to ${ugx(access)} next time — that is ${ugx(topup)} more than your current ${ugx(figures.rent_amount)}.`
        : `You have qualified for rent of up to ${ugx(access)} next time, the same as your current rent.`,
    );
  }

  const required = Number(figures.next_level_required ?? 0);
  const nextAccess = Number(figures.next_level_access ?? 0);
  if (required > 0 && nextAccess > 0) {
    parts.push(
      `Pay ${ugx(required)} more to qualify for rent of up to ${ugx(nextAccess)}.` +
        (figures.next_level_deadline ? ` Pay it by ${figures.next_level_deadline} to keep this.` : ''),
    );
  }

  const codes = channels
    .filter((c) => c.active)
    .map((c) => `${c.provider} ${c.merchant_code}`)
    .join(' or ');
  if (codes) parts.push(`Pay directly via ${codes}.`);

  const numbers = contacts.filter((c) => c.active).map((c) => c.phone).join(' or ');
  if (numbers) parts.push(`Need help? Call Welile customer care on ${numbers}.`);

  return parts.join(' ');
}
