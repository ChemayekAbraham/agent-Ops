import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Bell, Check, TrendingUp, Gift, Info, AlertTriangle, CheckCircle2 } from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { formatDistanceToNow } from 'date-fns';
import { cn } from '@/lib/utils';

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
  investment: { icon: TrendingUp, color: 'text-primary', bg: 'bg-primary/10' },
  reward: { icon: Gift, color: 'text-amber-600', bg: 'bg-amber-500/10' },
  warning: { icon: AlertTriangle, color: 'text-amber-600', bg: 'bg-amber-500/10' },
  info: { icon: Info, color: 'text-blue-600', bg: 'bg-blue-500/10' },
  welcome: { icon: Bell, color: 'text-primary', bg: 'bg-primary/10' },
};

const PAGE_SIZE = 10;

interface NotificationsModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  notifications: Notification[];
  onMarkAsRead: (id: string) => void;
  onMarkAllRead: () => void;
  unreadCount: number;
}

export function NotificationsModal({
  open,
  onOpenChange,
  notifications,
  onMarkAsRead,
  onMarkAllRead,
  unreadCount,
}: NotificationsModalProps) {
  const [page, setPage] = useState(0);
  const navigate = useNavigate();
  const totalPages = Math.ceil(notifications.length / PAGE_SIZE);
  const paged = notifications.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

  const handleClick = (n: Notification) => {
    if (!n.is_read) onMarkAsRead(n.id);
    const meta = (n.metadata ?? {}) as Record<string, unknown>;
    if (meta.kind === 'landlord_verification_request' && meta.request_id) {
      onOpenChange(false);
      navigate(`/verification-request/${meta.request_id}`);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md max-h-[85vh] flex flex-col p-0 gap-0 rounded-2xl">
        <DialogHeader className="px-4 pt-4 pb-2 flex-row items-center justify-between space-y-0">
          <DialogTitle className="text-base font-bold">All Notifications</DialogTitle>
          {unreadCount > 0 && (
            <Button variant="ghost" size="sm" className="text-xs h-7 gap-1 text-muted-foreground" onClick={onMarkAllRead}>
              <Check className="h-3 w-3" />
              Mark all read
            </Button>
          )}
        </DialogHeader>

        <div className="flex-1 overflow-y-auto px-3 pb-2 space-y-1.5">
          {paged.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-10">No notifications</p>
          ) : (
            paged.map(n => {
              const config = typeConfig[n.type] || typeConfig.info;
              const Icon = config.icon;
              return (
                <button
                  key={n.id}
                  onClick={() => handleClick(n)}
                  className={cn(
                    "w-full text-left px-3 py-3 rounded-xl border transition-colors touch-manipulation",
                    n.is_read
                      ? "bg-card/50 border-border/40 opacity-70"
                      : "bg-card border-border/60 shadow-sm"
                  )}
                >
                  <div className="flex gap-2.5">
                    <div className={cn("w-8 h-8 rounded-lg flex items-center justify-center shrink-0 mt-0.5", config.bg)}>
                      <Icon className={cn("h-4 w-4", config.color)} />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-start justify-between gap-2">
                        <p className={cn("text-sm font-semibold leading-tight", !n.is_read && "text-foreground")}>
                          {n.title}
                        </p>
                        {!n.is_read && <span className="w-2 h-2 rounded-full bg-primary shrink-0 mt-1.5" />}
                      </div>
                      <p className="text-xs text-muted-foreground mt-1 whitespace-pre-line line-clamp-3">{n.message}</p>
                      {n.created_at && (
                        <p className="text-[10px] text-muted-foreground/60 mt-1.5">
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

        {totalPages > 1 && (
          <div className="flex items-center justify-between px-4 py-3 border-t">
            <Button
              variant="outline"
              size="sm"
              disabled={page === 0}
              onClick={() => setPage(p => p - 1)}
              className="text-xs"
            >
              Previous
            </Button>
            <span className="text-xs text-muted-foreground">
              {page + 1} / {totalPages}
            </span>
            <Button
              variant="outline"
              size="sm"
              disabled={page >= totalPages - 1}
              onClick={() => setPage(p => p + 1)}
              className="text-xs"
            >
              Next
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
