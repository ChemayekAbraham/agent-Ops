import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '@/integrations/supabase/client';
import { Bell, Check, Info, AlertTriangle, CheckCircle2, XCircle, Home } from 'lucide-react';
import { ShoppingBag } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { formatDistanceToNow } from 'date-fns';
import { cn } from '@/lib/utils';
import { useNotificationPulse } from '@/hooks/useNotificationPulse';

interface Notification {
  id: string;
  title: string;
  message: string;
  type: string;
  is_read: boolean | null;
  created_at: string | null;
  metadata: Record<string, unknown> | null;
}

const typeConfig: Record<string, { icon: typeof Bell; color: string; bg: string }> = {
  success: { icon: CheckCircle2, color: 'text-emerald-600', bg: 'bg-emerald-500/10' },
  warning: { icon: AlertTriangle, color: 'text-amber-600', bg: 'bg-amber-500/10' },
  error: { icon: XCircle, color: 'text-destructive', bg: 'bg-destructive/10' },
  info: { icon: Info, color: 'text-blue-600', bg: 'bg-blue-500/10' },
  listing: { icon: Home, color: 'text-primary', bg: 'bg-primary/10' },
  merchandise_recovery: { icon: ShoppingBag, color: 'text-purple-600', bg: 'bg-purple-500/10' },
  advance_arrears: { icon: AlertTriangle, color: 'text-amber-600', bg: 'bg-amber-500/10' },
};

export function AgentNotificationBell({ userId }: { userId: string }) {
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();
  const { isPulsing, stopPulse } = useNotificationPulse(userId);

  const fetchNotifications = useCallback(async () => {
    if (!userId) return;
    const { data } = await supabase
      .from('notifications')
      .select('id, title, message, type, is_read, created_at, metadata')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(20);
    setNotifications((data as Notification[]) || []);
  }, [userId]);

  useEffect(() => { fetchNotifications(); }, [fetchNotifications]);

  useEffect(() => {
    if (!userId) return;
    const channel = supabase
      .channel(`agent-notif-${userId}`)
      .on('postgres_changes', {
        event: 'INSERT',
        schema: 'public',
        table: 'notifications',
        filter: `user_id=eq.${userId}`,
      }, (payload) => {
        setNotifications(prev => [payload.new as Notification, ...prev].slice(0, 20));
      })
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [userId]);

  const unreadCount = notifications.filter(n => !n.is_read).length;

  const markAsRead = async (id: string) => {
    await supabase.from('notifications').update({ is_read: true }).eq('id', id);
    setNotifications(prev => prev.map(n => n.id === id ? { ...n, is_read: true } : n));
  };

  const markAllRead = async () => {
    if (unreadCount === 0) return;
    await supabase.from('notifications').update({ is_read: true }).eq('user_id', userId).eq('is_read', false);
    setNotifications(prev => prev.map(n => ({ ...n, is_read: true })));
  };

  const handleClick = (n: Notification) => {
    if (!n.is_read) markAsRead(n.id);
    const meta = (n.metadata ?? {}) as Record<string, unknown>;
    if (meta.kind === 'landlord_verification_request' && meta.request_id) {
      setOpen(false);
      navigate(`/verification-request/${meta.request_id}`);
    } else if (meta.kind === 'merchandise_recovery' || n.type === 'merchandise_recovery') {
      setOpen(false);
      navigate('/merchandise');
    }
  };

  return (
    <Popover open={open} onOpenChange={(o) => { setOpen(o); if (o) stopPulse(); }}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          aria-label="Notifications"
          className={cn(
            "h-10 w-10 min-w-[40px] min-h-[40px] rounded-xl relative shrink-0",
            isPulsing && "animate-bell-glow",
          )}
        >
          <Bell className={cn("h-5 w-5 text-foreground", isPulsing && "animate-bell-ring origin-top")} />
          {unreadCount > 0 && (
            <span className={cn(
              "absolute top-0 right-0 min-w-[18px] h-[18px] flex items-center justify-center text-[10px] font-bold bg-destructive text-destructive-foreground rounded-full px-1",
              isPulsing && "animate-pulse",
            )}>
              {unreadCount > 9 ? '9+' : unreadCount}
            </span>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        sideOffset={8}
        className="w-[20rem] p-0 rounded-2xl shadow-2xl border bg-background"
      >
        <div className="flex items-center justify-between px-4 pt-3 pb-2">
          <h3 className="text-sm font-bold">Notifications</h3>
          {unreadCount > 0 && (
            <Button variant="ghost" size="sm" className="text-xs h-7 gap-1 text-muted-foreground" onClick={markAllRead}>
              <Check className="h-3 w-3" />
              Mark all read
            </Button>
          )}
        </div>

        <div className="max-h-[360px] overflow-y-auto px-2 pb-2 space-y-1">
          {notifications.length === 0 ? (
            <p className="text-xs text-muted-foreground text-center py-8">No notifications yet</p>
          ) : (
            notifications.map(n => {
              const config = typeConfig[n.type] || typeConfig.info;
              const Icon = config.icon;
              return (
                <button
                  key={n.id}
                  onClick={() => handleClick(n)}
                  className={cn(
                    "w-full text-left px-3 py-2.5 rounded-xl transition-colors touch-manipulation hover:bg-accent/60",
                    n.is_read ? "opacity-60" : "bg-accent/40 animate-notif-fade-in"
                  )}
                >
                  <div className="flex gap-2.5">
                    <div className={cn("w-7 h-7 rounded-lg flex items-center justify-center shrink-0 mt-0.5", config.bg)}>
                      <Icon className={cn("h-3.5 w-3.5", config.color)} />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-start justify-between gap-2">
                        <p className="text-xs font-semibold leading-tight line-clamp-1 text-foreground">{n.title}</p>
                        {!n.is_read && (
                          <span className="inline-flex items-center gap-1 shrink-0 mt-0.5">
                            <span className="text-[9px] font-bold uppercase tracking-wider text-primary bg-primary/10 rounded px-1 py-px">New</span>
                            <span className="w-2 h-2 rounded-full bg-primary" />
                          </span>
                        )}
                      </div>
                      <p className="text-[11px] text-muted-foreground mt-0.5 line-clamp-3">{n.message}</p>
                      {n.created_at && (
                        <p className="text-[10px] text-muted-foreground/70 mt-1">
                          {formatDistanceToNow(new Date(n.created_at), { addSuffix: true })}
                        </p>
                      )}
                    </div>
                  </div>
                </button>
              );
            })
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}