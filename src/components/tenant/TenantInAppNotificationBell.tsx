import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { formatDistanceToNow } from 'date-fns';
import {
  useTenantInAppNotifications,
  useUnreadTenantInAppCount,
  useMarkTenantInAppNotificationRead,
  useDismissTenantInAppNotification,
  type TenantInAppNotification,
} from '@/hooks/useTenantInAppNotifications';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Bell, X, Check, ArrowRight, Loader2, MessageSquare } from 'lucide-react';
import { cn } from '@/lib/utils';
import { hapticTap } from '@/lib/haptics';

interface TenantInAppNotificationBellProps {
  tenantId: string;
  className?: string;
}

export function TenantInAppNotificationBell({
  tenantId,
  className,
}: TenantInAppNotificationBellProps) {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);

  const { data: notifications = [], isLoading } = useTenantInAppNotifications({
    tenantId,
  });
  const { data: unreadCount = 0 } = useUnreadTenantInAppCount(tenantId);
  const markRead = useMarkTenantInAppNotificationRead();
  const dismiss = useDismissTenantInAppNotification();

  const handleNotificationClick = (item: TenantInAppNotification) => {
    hapticTap();
    if (!item.is_read) {
      markRead.mutate(item.id);
    }
    if (item.link_path) {
      setOpen(false);
      navigate(item.link_path);
    }
  };

  const handleDismiss = (e: React.MouseEvent, item: TenantInAppNotification) => {
    e.stopPropagation();
    hapticTap();
    dismiss.mutate(item.id);
  };

  const formatRelativeTime = (timestamp?: string | null) => {
    if (!timestamp) return '';
    try {
      return formatDistanceToNow(new Date(timestamp), { addSuffix: true });
    } catch {
      return '';
    }
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label="Open notifications"
          onClick={() => hapticTap()}
          className={cn(
            'relative p-2 rounded-xl text-primary-foreground/90 hover:text-primary-foreground hover:bg-white/10 active:scale-95 transition-all touch-manipulation min-h-[36px] min-w-[36px] flex items-center justify-center',
            className,
          )}
        >
          <Bell className="h-5 w-5" />
          {unreadCount > 0 && (
            <span className="absolute top-1 right-1 min-w-[18px] h-[18px] px-1 bg-destructive text-destructive-foreground text-[10px] font-bold rounded-full flex items-center justify-center shadow-sm animate-in zoom-in-50">
              {unreadCount > 99 ? '99+' : unreadCount}
            </span>
          )}
        </button>
      </PopoverTrigger>

      <PopoverContent
        align="end"
        sideOffset={8}
        className="w-80 sm:w-96 p-0 rounded-2xl shadow-xl border border-border/70 bg-card overflow-hidden"
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-border/50 bg-muted/30">
          <div className="flex items-center gap-2">
            <Bell className="h-4 w-4 text-primary" />
            <h2 className="text-sm font-bold text-foreground">Notifications</h2>
            {unreadCount > 0 && (
              <Badge variant="secondary" className="text-[10px] h-5 px-1.5 font-semibold bg-primary/10 text-primary">
                {unreadCount} new
              </Badge>
            )}
          </div>
        </div>

        {/* Notifications List */}
        <ScrollArea className="max-h-[380px] overflow-y-auto">
          {isLoading ? (
            <div className="py-8 text-center space-y-2">
              <Loader2 className="h-5 w-5 animate-spin mx-auto text-primary" />
              <p className="text-xs text-muted-foreground">Loading notifications…</p>
            </div>
          ) : notifications.length === 0 ? (
            <div className="py-10 px-4 text-center space-y-2">
              <div className="w-10 h-10 rounded-full bg-muted/60 flex items-center justify-center mx-auto text-muted-foreground">
                <Bell className="h-5 w-5" />
              </div>
              <p className="text-xs font-semibold text-foreground">No notifications yet</p>
              <p className="text-[11px] text-muted-foreground">
                You're all caught up! Updates about your Rent Plan and opportunities will appear here.
              </p>
            </div>
          ) : (
            <div className="divide-y divide-border/40">
              {notifications.map((item) => (
                <div
                  key={item.id}
                  onClick={() => handleNotificationClick(item)}
                  className={cn(
                    'p-3.5 flex items-start gap-3 transition-colors cursor-pointer text-left select-none relative group',
                    item.is_read
                      ? 'hover:bg-muted/40'
                      : 'bg-primary/5 hover:bg-primary/10 border-l-2 border-l-primary',
                  )}
                >
                  {/* Unread indicator dot */}
                  {!item.is_read && (
                    <span className="w-2 h-2 rounded-full bg-primary mt-1.5 shrink-0" />
                  )}

                  <div className="flex-1 min-w-0 space-y-1">
                    <div className="flex items-start justify-between gap-2">
                      <h3
                        className={cn(
                          'text-xs leading-tight',
                          item.is_read ? 'font-medium text-foreground' : 'font-bold text-foreground',
                        )}
                      >
                        {item.title}
                      </h3>
                      <span className="text-[10px] text-muted-foreground shrink-0 whitespace-nowrap">
                        {formatRelativeTime(item.created_at)}
                      </span>
                    </div>

                    <p className="text-[11px] text-muted-foreground leading-relaxed">
                      {item.message}
                    </p>

                    {item.link_path && (
                      <div className="pt-1 flex items-center gap-1 text-[11px] font-medium text-primary">
                        <span>View details</span>
                        <ArrowRight className="h-3 w-3" />
                      </div>
                    )}
                  </div>

                  {/* Explicit Dismiss button */}
                  <button
                    type="button"
                    title="Dismiss"
                    aria-label="Dismiss notification"
                    onClick={(e) => handleDismiss(e, item)}
                    className="h-6 w-6 rounded-md hover:bg-muted flex items-center justify-center text-muted-foreground hover:text-foreground opacity-60 group-hover:opacity-100 transition-opacity shrink-0 -mr-1 -mt-1"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
              ))}
            </div>
          )}
        </ScrollArea>
      </PopoverContent>
    </Popover>
  );
}

export default TenantInAppNotificationBell;
