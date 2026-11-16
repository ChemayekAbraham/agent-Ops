import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Bell } from 'lucide-react';
import { useAuth } from '@/hooks/useAuth';
import { supabase } from '@/integrations/supabase/client';
import { CALM, FOCUS, LABEL } from './deskTheme';
import { DeskPopover } from './ui';

/**
 * The desk's notification bell (E114): the signed-in staff member's latest
 * notifications, live. The 07:30 call list (type desk_morning_brief,
 * link_path /desk/agent-ops or /desk/tenant-ops) opens that desk on its
 * Arrears calls tab; any other notification with a desk link opens its desk.
 */

type DeskNotice = {
  id: string;
  title: string;
  message: string;
  type: string;
  is_read: boolean | null;
  created_at: string | null;
  link_path: string | null;
};

/** The ?tab= value that opens a desk's Arrears calls tab (DeskPage reads any non-"queue" tab as its second tab). */
export const ARREARS_TAB = 'arrears';

/** Where a tap goes: the brief opens the Arrears calls tab; other in-app links as they are. */
export function deskNotificationTarget(n: Pick<DeskNotice, 'type' | 'link_path'>): string | null {
  const path = typeof n.link_path === 'string' && n.link_path.startsWith('/') ? n.link_path : null;
  if (!path) return null;
  if (n.type === 'desk_morning_brief' && /^\/desk\/(agent-ops|tenant-ops)\/?$/.test(path)) return `${path.replace(/\/$/, '')}?tab=${ARREARS_TAB}`;
  return path;
}

const ago = (v: string | null) => {
  if (!v || !Number.isFinite(Date.parse(v))) return '';
  const mins = Math.round((Date.now() - Date.parse(v)) / 60_000);
  if (mins < 60) return `${Math.max(1, mins)} min ago`;
  if (mins < 24 * 60) return `${Math.round(mins / 60)} h ago`;
  return `${Math.round(mins / 1440)} d ago`;
};

export function DeskBell() {
  const { user } = useAuth();
  const userId = user?.id ?? null;
  const navigate = useNavigate();
  const [items, setItems] = useState<DeskNotice[]>([]);

  const load = useCallback(async () => {
    if (!userId) return;
    const { data } = await supabase
      .from('notifications')
      .select('id, title, message, type, is_read, created_at, link_path')
      .eq('user_id', userId)
      .is('dismissed_at', null)
      .order('created_at', { ascending: false })
      .limit(20);
    setItems((data as DeskNotice[] | null) ?? []);
  }, [userId]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!userId) return;
    const channel = supabase
      .channel(`desk-notif-${userId}`)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'notifications', filter: `user_id=eq.${userId}` }, (payload) => {
        setItems((prev) => [payload.new as DeskNotice, ...prev].slice(0, 20));
      })
      .subscribe();
    return () => {
      void supabase.removeChannel(channel);
    };
  }, [userId]);

  if (!userId) return null;
  const unread = items.filter((n) => !n.is_read).length;

  const tap = async (n: DeskNotice, close: () => void) => {
    close();
    if (!n.is_read) {
      setItems((prev) => prev.map((x) => (x.id === n.id ? { ...x, is_read: true } : x)));
      await supabase.from('notifications').update({ is_read: true, read_at: new Date().toISOString() }).eq('id', n.id);
    }
    const to = deskNotificationTarget(n);
    if (to) navigate(to);
  };

  return (
    <DeskPopover
      label={unread > 0 ? `Notifications, ${unread} unread` : 'Notifications'}
      align="right"
      triggerClass={`relative inline-flex h-8 w-8 items-center justify-center rounded-md border border-[var(--desk-line-color)] bg-[var(--desk-surface)] text-foreground hover:bg-[var(--desk-surface-hover)] ${CALM} ${FOCUS}`}
      trigger={
        <span data-desk-bell style={{ display: 'inline-flex' }}>
          <Bell className="h-4 w-4" aria-hidden />
          {unread > 0 && (
            <span className="absolute -right-1 -top-1 min-w-[16px] rounded-full bg-destructive px-1 text-center text-[10px] font-bold leading-4 text-destructive-foreground" data-unread>
              {unread > 9 ? '9+' : unread}
            </span>
          )}
        </span>
      }
    >
      {(close) => (
        <span style={{ display: 'block', maxHeight: 420, overflowY: 'auto' }}>
          {items.length === 0 ? (
            <span className="block text-sm text-muted-foreground">No notifications.</span>
          ) : (
            <ul style={{ margin: 0, padding: 0, listStyle: 'none' }} aria-label="Notifications">
              {items.map((n) => (
                <li key={n.id} className="border-t border-[var(--desk-line-color)] first:border-t-0">
                  <button
                    type="button"
                    onClick={() => void tap(n, close)}
                    className={`w-full py-2 text-left hover:bg-[var(--desk-surface-hover)] ${CALM} ${FOCUS}`}
                    data-notice={n.type}
                    data-unread-notice={!n.is_read || undefined}
                  >
                    <span className={`block text-sm ${n.is_read ? 'text-muted-foreground' : 'font-semibold text-foreground'}`}>{n.title}</span>
                    <span className="mt-0.5 block text-xs text-muted-foreground" style={{ overflowWrap: 'anywhere' }}>
                      {n.message}
                    </span>
                    <span className={`${LABEL} mt-1 block`}>{ago(n.created_at)}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </span>
      )}
    </DeskPopover>
  );
}
