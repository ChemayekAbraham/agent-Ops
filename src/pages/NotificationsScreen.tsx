import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  ArrowLeft, Bell, BellOff, CheckCheck, ChevronDown, Loader2, RefreshCw, Wallet, Home,
  ShieldAlert, Info, MessageSquare,
} from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { formatDistanceToNow, format } from 'date-fns';
import { toast } from 'sonner';

interface NotificationRow {
  id: string;
  title: string | null;
  message: string | null;
  type: string | null;
  is_read: boolean | null;
  created_at: string | null;
}

type Tab = 'unread' | 'all';

/** Maps a notification type to an icon + tint, falling back to a neutral info look. */
const visualFor = (type?: string | null) => {
  const t = (type || '').toLowerCase();
  if (t.includes('payment') || t.includes('wallet') || t.includes('withdraw') || t.includes('deposit')) {
    return { Icon: Wallet, tint: 'bg-emerald-500/10 text-emerald-600' };
  }
  if (t.includes('rent') || t.includes('house') || t.includes('listing')) {
    return { Icon: Home, tint: 'bg-primary/10 text-primary' };
  }
  if (t.includes('alert') || t.includes('fraud') || t.includes('freeze') || t.includes('overdue')) {
    return { Icon: ShieldAlert, tint: 'bg-destructive/10 text-destructive' };
  }
  if (t.includes('message') || t.includes('chat')) {
    return { Icon: MessageSquare, tint: 'bg-sky-500/10 text-sky-600' };
  }
  return { Icon: Info, tint: 'bg-muted text-muted-foreground' };
};

export default function NotificationsScreen() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { user } = useAuth();
  const [tab, setTab] = useState<Tab>('unread');
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const { data: notifications = [], isLoading, isFetching, refetch } = useQuery({
    queryKey: ['my-notifications', user?.id],
    enabled: !!user?.id,
    staleTime: 30_000,
    queryFn: async (): Promise<NotificationRow[]> => {
      const { data, error } = await supabase
        .from('notifications')
        .select('id, title, message, type, is_read, created_at')
        .eq('user_id', user!.id)
        .order('created_at', { ascending: false })
        .limit(100);
      if (error) throw error;
      return (data || []) as NotificationRow[];
    },
  });

  const unreadCount = useMemo(() => notifications.filter(n => !n.is_read).length, [notifications]);
  const visible = useMemo(
    () => (tab === 'unread' ? notifications.filter(n => !n.is_read) : notifications),
    [notifications, tab],
  );

  const markRead = useMutation({
    mutationFn: async (ids: string[]) => {
      if (!ids.length) return;
      const { error } = await supabase
        .from('notifications')
        .update({ is_read: true })
        .in('id', ids)
        .eq('user_id', user!.id);
      if (error) throw error;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['my-notifications', user?.id] }),
    onError: (e: any) => toast.error(e?.message || 'Could not update notifications'),
  });

  const relative = (d?: string | null) => {
    if (!d) return '';
    try { return formatDistanceToNow(new Date(d), { addSuffix: true }); } catch { return ''; }
  };
  const absolute = (d?: string | null) => {
    if (!d) return '';
    try { return format(new Date(d), 'dd MMM yyyy, HH:mm'); } catch { return ''; }
  };

  return (
    <div className="min-h-screen bg-background pb-28">
      <header className="sticky top-0 z-20 bg-primary text-primary-foreground px-4 py-3 shadow-md pt-safe">
        <div className="flex items-center gap-3">
          <Button
            variant="ghost"
            size="icon"
            onClick={() => navigate(-1)}
            aria-label="Go back"
            className="h-10 w-10 text-primary-foreground/90 hover:text-primary-foreground hover:bg-white/10 rounded-xl"
          >
            <ArrowLeft className="h-5 w-5" />
          </Button>
          <h1 className="text-base font-semibold flex-1">Notifications</h1>
          <Button
            variant="ghost"
            size="icon"
            onClick={() => refetch()}
            aria-label="Refresh notifications"
            className="h-10 w-10 text-primary-foreground/90 hover:text-primary-foreground hover:bg-white/10 rounded-xl"
          >
            <RefreshCw className={cn('h-4 w-4', isFetching && 'animate-spin')} />
          </Button>
        </div>

        <div className="flex items-center gap-2 mt-3">
          {(['unread', 'all'] as Tab[]).map(t => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={cn(
                'px-3 py-1.5 rounded-full text-xs font-semibold transition-colors touch-manipulation',
                tab === t ? 'bg-card text-primary' : 'bg-white/10 text-primary-foreground/80',
              )}
            >
              {t === 'unread' ? `Unread${unreadCount ? ` (${unreadCount})` : ''}` : 'All'}
            </button>
          ))}
          <div className="flex-1" />
          {unreadCount > 0 && (
            <Button
              variant="ghost"
              size="sm"
              disabled={markRead.isPending}
              onClick={() => markRead.mutate(notifications.filter(n => !n.is_read).map(n => n.id))}
              className="h-8 gap-1.5 text-primary-foreground/90 hover:text-primary-foreground hover:bg-white/10 text-xs"
            >
              <CheckCheck className="h-3.5 w-3.5" /> Mark all read
            </Button>
          )}
        </div>
      </header>

      <main className="px-4 py-4 space-y-2.5 max-w-2xl mx-auto">
        {isLoading ? (
          <div className="flex items-center justify-center py-20 text-muted-foreground">
            <Loader2 className="h-5 w-5 animate-spin mr-2" /> Loading notifications…
          </div>
        ) : visible.length === 0 ? (
          <Card className="rounded-2xl">
            <CardContent className="py-14 flex flex-col items-center text-center gap-2">
              {tab === 'unread' ? (
                <>
                  <BellOff className="h-8 w-8 text-muted-foreground" />
                  <p className="text-sm font-medium">You're all caught up</p>
                  <p className="text-xs text-muted-foreground">
                    New alerts about payments, rent and your account will appear here.
                  </p>
                  {notifications.length > 0 && (
                    <Button variant="outline" size="sm" className="mt-2" onClick={() => setTab('all')}>
                      View earlier notifications
                    </Button>
                  )}
                </>
              ) : (
                <>
                  <Bell className="h-8 w-8 text-muted-foreground" />
                  <p className="text-sm font-medium">No notifications yet</p>
                  <p className="text-xs text-muted-foreground">
                    We'll notify you here about payments, rent and account activity.
                  </p>
                </>
              )}
            </CardContent>
          </Card>
        ) : (
          visible.map(n => {
            const { Icon, tint } = visualFor(n.type);
            const unread = !n.is_read;
            const expanded = expandedId === n.id;
            return (
              <Card
                key={n.id}
                role="button"
                tabIndex={0}
                aria-expanded={expanded}
                onClick={() => {
                  setExpandedId(expanded ? null : n.id);
                  if (unread) markRead.mutate([n.id]);
                }}
                onKeyDown={e => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    setExpandedId(expanded ? null : n.id);
                    if (unread) markRead.mutate([n.id]);
                  }
                }}
                className={cn(
                  'rounded-2xl transition-colors cursor-pointer',
                  unread ? 'border-primary/40 bg-primary/[0.04]' : 'bg-card',
                )}
              >
                <CardContent className="p-4 flex gap-3">
                  <div className={cn('p-2 rounded-xl shrink-0 h-fit', tint)}>
                    <Icon className="h-4 w-4" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-start gap-2">
                      <p className={cn('text-sm font-semibold flex-1 break-words', !expanded && 'line-clamp-2')}>
                        {n.title?.trim() || 'Notification'}
                      </p>
                      {unread && <span className="mt-1.5 h-2 w-2 rounded-full bg-primary shrink-0" />}
                      <ChevronDown
                        className={cn(
                          'h-4 w-4 shrink-0 mt-0.5 text-muted-foreground transition-transform',
                          expanded && 'rotate-180',
                        )}
                      />
                    </div>
                    {n.message && (
                      <p
                        className={cn(
                          'text-xs text-muted-foreground mt-1 whitespace-pre-line break-words',
                          !expanded && 'line-clamp-2',
                        )}
                      >
                        {n.message}
                      </p>
                    )}
                    <div className="flex flex-wrap items-center gap-2 mt-2">
                      <span className="text-[11px] text-muted-foreground" title={absolute(n.created_at)}>
                        {expanded ? absolute(n.created_at) : relative(n.created_at)}
                      </span>
                      {n.type && (
                        <Badge variant="outline" className="text-[10px] capitalize">
                          {n.type.replace(/_/g, ' ')}
                        </Badge>
                      )}
                    </div>
                  </div>
                </CardContent>
              </Card>
            );
          })

        )}
      </main>
    </div>
  );
}
