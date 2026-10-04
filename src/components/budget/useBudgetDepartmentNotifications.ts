import { useCallback, useEffect, useState } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { departmentKeysForDashboard } from './departmentScope';

export interface DeptNotification {
  id: string;
  department_key: string;
  department_name: string;
  cycle_title: string;
  deadline: string | null;
  title: string;
  message: string;
  link: string;
  created_at: string;
  is_read: boolean;
}

/**
 * Loads department-scoped budget cycle notices. Scoping is enforced server-side
 * by `get_budget_department_notifications`; the keys passed here only narrow it
 * further to the dashboard being viewed.
 */
export function useBudgetDepartmentNotifications(
  dashboard?: string,
  departmentKeys?: string[],
) {
  const [items, setItems] = useState<DeptNotification[]>([]);

  const scopedKeys = departmentKeys ?? departmentKeysForDashboard(dashboard);
  const scopeSignature = scopedKeys && scopedKeys.length > 0 ? scopedKeys.join(',') : '';

  const load = useCallback(async () => {
    const { data, error } = await supabase.rpc('get_budget_department_notifications', {
      _department_keys: scopeSignature ? scopeSignature.split(',') : null,
    });
    if (error) {
      console.error('Failed to load department budget notices:', error);
      return;
    }
    setItems((data as DeptNotification[]) ?? []);
  }, [scopeSignature]);

  useEffect(() => { load(); }, [load]);

  const unread = items.filter(i => !i.is_read).length;

  const markRead = useCallback(async (id: string) => {
    const { error } = await supabase.rpc('mark_budget_department_notification_read', {
      _notification_id: id,
    });
    if (error) console.error('Failed to mark notice read:', error);
    else setItems(prev => prev.map(i => (i.id === id ? { ...i, is_read: true } : i)));
  }, []);

  const markAll = useCallback(async () => {
    const pending = items.filter(i => !i.is_read);
    if (pending.length === 0) return;
    await Promise.all(
      pending.map(i =>
        supabase.rpc('mark_budget_department_notification_read', { _notification_id: i.id }),
      ),
    );
    setItems(prev => prev.map(i => ({ ...i, is_read: true })));
  }, [items]);

  return { items, unread, reload: load, markRead, markAll };
}
