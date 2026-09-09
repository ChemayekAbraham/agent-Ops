/**
 * Stage 5 reads for the Tenant Ops smartphone/SMS analytics surfaces.
 *
 * Two SECURITY DEFINER RPCs, one round trip each, both aggregated server-side:
 *   get_tenant_smartphone_overview      — device/dashboard segmentation
 *   get_tenant_notification_performance — SMS send/delivery/conversion by event
 *
 * Data-fetching only — this file is Claude's lane (src/hooks/). The actual
 * cards/charts consuming these are Gemini's (src/components/, src/pages/) per
 * CLAUDE.md's division of labor; nothing here renders anything.
 *
 * `conversion_rate_pct` on the performance RPC means "sent AND later acted
 * within the attribution rules", not causation — see
 * docs/tenant-notification-engine-runbook.md's Stage 5 section before
 * building copy around it.
 */
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

export interface TenantSmartphoneOverview {
  active_tenants: number;
  device: {
    confirmed_smartphone: number;
    confirmed_feature_phone: number;
    unknown: number;
  };
  source: {
    onboarding: number;
    call_centre: number;
    dashboard_access: number;
    agent: number;
    system_detection: number;
    unresolved: number;
  };
  dashboard: {
    activated: number;
    never_activated: number;
    smartphone_and_activated: number;
    smartphone_not_activated: number;
    activation_rate_pct: number;
    opened_once: number;
    opened_2_plus: number;
    opened_last_7d: number;
    opened_last_30d: number;
  };
  filters: { district: string | null; agent_id: string | null };
  generated_at: string;
}

export interface TenantNotificationEventPerformance {
  event_key: string;
  sent: number;
  delivered: number;
  failed: number;
  suppressed: number;
  unique_tenants: number;
  acted: number;
  conversion_rate_pct: number;
}

export interface TenantNotificationPerformance {
  start_date: string;
  end_date: string;
  filters: { event_key: string | null; district: string | null };
  totals: Omit<TenantNotificationEventPerformance, 'event_key'>;
  by_event: TenantNotificationEventPerformance[];
  generated_at: string;
}

interface SmartphoneOverviewFilters {
  district?: string | null;
  agentId?: string | null;
}

/** Device/dashboard segmentation for the Tenant Ops smartphone card. */
export function useTenantSmartphoneOverview(filters: SmartphoneOverviewFilters = {}) {
  const { district = null, agentId = null } = filters;

  return useQuery({
    queryKey: ['tenant-smartphone-overview', district, agentId],
    queryFn: async (): Promise<TenantSmartphoneOverview> => {
      const { data, error } = await supabase.rpc('get_tenant_smartphone_overview', {
        p_district: district,
        p_agent_id: agentId,
      });
      if (error) throw error;
      return data as unknown as TenantSmartphoneOverview;
    },
    staleTime: 5 * 60 * 1000,
  });
}

interface NotificationPerformanceFilters {
  startDate: string; // YYYY-MM-DD
  endDate: string; // YYYY-MM-DD
  eventKey?: string | null;
  district?: string | null;
}

/** SMS send/delivery/conversion totals, plus a per-event breakdown. */
export function useTenantNotificationPerformance(filters: NotificationPerformanceFilters) {
  const { startDate, endDate, eventKey = null, district = null } = filters;

  return useQuery({
    queryKey: ['tenant-notification-performance', startDate, endDate, eventKey, district],
    queryFn: async (): Promise<TenantNotificationPerformance> => {
      const { data, error } = await supabase.rpc('get_tenant_notification_performance', {
        p_start: startDate,
        p_end: endDate,
        p_event_key: eventKey,
        p_district: district,
      });
      if (error) throw error;
      return data as unknown as TenantNotificationPerformance;
    },
    staleTime: 2 * 60 * 1000,
  });
}
