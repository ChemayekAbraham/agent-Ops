/**
 * Stage 6D reads/writes for the tenant in-app notification inbox.
 *
 * Reuses the existing `notifications` table (already written to by several
 * other edge functions) rather than a parallel tenant-only table — see the
 * Stage 6 migration's preamble. `event_key`/`notification_log_id` are only
 * populated on rows the tenant notification engine created; older/other
 * notifications simply have them null and still show up in the inbox.
 *
 * Data-fetching only — this file is Claude's lane (src/hooks/). The actual
 * inbox UI is Gemini's (src/components/, src/pages/).
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

export interface TenantInAppNotification {
  id: string;
  event_key: string | null;
  title: string;
  message: string;
  link_path: string | null;
  metadata: Record<string, unknown>;
  is_read: boolean;
  read_at: string | null;
  dismissed_at: string | null;
  created_at: string;
  expires_at: string | null;
}

interface UseTenantInAppNotificationsOptions {
  /** Defaults to the signed-in user via RLS if omitted. */
  tenantId: string;
  includeDismissed?: boolean;
  limit?: number;
}

/** The tenant's own inbox — RLS already restricts this to their own rows. */
export function useTenantInAppNotifications(options: UseTenantInAppNotificationsOptions) {
  const { tenantId, includeDismissed = false, limit = 50 } = options;

  return useQuery({
    queryKey: ['tenant-in-app-notifications', tenantId, includeDismissed, limit],
    enabled: Boolean(tenantId),
    queryFn: async (): Promise<TenantInAppNotification[]> => {
      let query = supabase
        .from('notifications')
        .select(
          'id, event_key, title, message, link_path, metadata, is_read, read_at, dismissed_at, created_at, expires_at',
        )
        .eq('user_id', tenantId)
        .order('created_at', { ascending: false })
        .limit(limit);

      if (!includeDismissed) {
        query = query.is('dismissed_at', null);
      }

      const { data, error } = await query;
      if (error) throw error;
      return (data ?? []) as unknown as TenantInAppNotification[];
    },
    staleTime: 30 * 1000,
  });
}

export function useUnreadTenantInAppCount(tenantId: string) {
  return useQuery({
    queryKey: ['tenant-in-app-unread-count', tenantId],
    enabled: Boolean(tenantId),
    queryFn: async (): Promise<number> => {
      const { count, error } = await supabase
        .from('notifications')
        .select('id', { count: 'exact', head: true })
        .eq('user_id', tenantId)
        .eq('is_read', false)
        .is('dismissed_at', null);
      if (error) throw error;
      return count ?? 0;
    },
    staleTime: 30 * 1000,
  });
}

/**
 * Marks read via mark_in_app_notification_read, not a direct table update —
 * the RPC also stamps the matching tenant_notification_deliveries row
 * (channel='in_app') as opened, which a raw UPDATE on `notifications` alone
 * cannot reach (that table carries no RLS write access at all).
 */
export function useMarkTenantInAppNotificationRead() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (notificationId: string) => {
      const { data, error } = await (supabase as any).rpc('mark_in_app_notification_read', {
        p_notification_id: notificationId,
      });
      if (error) throw error;
      return data as boolean;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['tenant-in-app-notifications'] });
      queryClient.invalidateQueries({ queryKey: ['tenant-in-app-unread-count'] });
    },
  });
}

export function useDismissTenantInAppNotification() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (notificationId: string) => {
      const { data, error } = await (supabase as any).rpc('dismiss_in_app_notification', {
        p_notification_id: notificationId,
      });
      if (error) throw error;
      return data as boolean;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['tenant-in-app-notifications'] });
      queryClient.invalidateQueries({ queryKey: ['tenant-in-app-unread-count'] });
    },
  });
}
