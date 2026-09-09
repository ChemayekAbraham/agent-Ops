/**
 * Stage 6L: the tenant's one notification preference.
 *
 * Deliberately a single marketing_push_opt_out toggle, not four switches.
 * PAYMENT events, RENT_LIMIT_INCREASED, FIVE_DAY_AGENT_OPPORTUNITY and
 * MERCHANT_CODE_REMINDER are all `critical` in the channel policy, and Stage
 * 6L is explicit that critical/contractual communication must not become
 * suppressible just because promotional push is off — routeTenantNotification
 * already ignores this flag for critical events. Only the genuinely optional
 * category (relocation, rent-limit progress, dashboard-activated push/in-app)
 * is exposed here. SMS opt-out is separate (sms_opt_outs) and untouched.
 *
 * Direct RLS table access, matching push_subscriptions' own convention for
 * this table family — a preference, not money, so no RPC layer.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

export interface TenantNotificationPreferences {
  push_enabled: boolean;
  marketing_push_opt_out: boolean;
}

const DEFAULTS: TenantNotificationPreferences = {
  push_enabled: true,
  marketing_push_opt_out: false,
};

export function useTenantNotificationPreferences(tenantId: string) {
  return useQuery({
    queryKey: ['tenant-notification-preferences', tenantId],
    enabled: Boolean(tenantId),
    queryFn: async (): Promise<TenantNotificationPreferences> => {
      const { data, error } = await (supabase as any)
        .from('tenant_notification_preferences')
        .select('push_enabled, marketing_push_opt_out')
        .eq('tenant_id', tenantId)
        .maybeSingle();
      if (error) throw error;
      // No row yet = the same defaults the router itself falls back to.
      return (data as TenantNotificationPreferences | null) ?? DEFAULTS;
    },
    staleTime: 5 * 60 * 1000,
  });
}

export function useUpdateTenantNotificationPreferences(tenantId: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (patch: Partial<TenantNotificationPreferences>) => {
      const { error } = await (supabase as any)
        .from('tenant_notification_preferences')
        .upsert(
          { tenant_id: tenantId, ...patch, updated_at: new Date().toISOString() },
          { onConflict: 'tenant_id' },
        );
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['tenant-notification-preferences', tenantId] });
    },
  });
}
