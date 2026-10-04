import {
  Bell,
  TrendingUp,
  Home,
  Banknote,
  Store,
  CreditCard,
  Undo2,
  FileText,
  Users,
  Briefcase,
  Wallet,
  ArrowDownToLine,
  Check,
  ClipboardList,
  AlertCircle,
} from 'lucide-react';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { formatDistanceToNow } from 'date-fns';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import {
  useBudgetDepartmentNotifications,
  type DeptNotification,
} from '@/components/budget/useBudgetDepartmentNotifications';
import {
  useCfoApprovalNotifications,
  type CfoApprovalNotificationKey,
} from '@/hooks/useCfoApprovalNotifications';

/**
 * Notification bell for the CFO dashboard header. Purely an alert layer over
 * the existing approval queues — clicking an entry jumps to the existing list.
 * Also the single home for department budget cycle notices on this dashboard
 * (finance-scoped), so the CFO only ever sees one bell.
 */
export function CFOApprovalNotificationsBell({
  onJump,
}: {
  onJump: (tabId: string) => void;
}) {
  const { notifications, failed, total, isLoading } = useCfoApprovalNotifications();
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();
  const {
    items: budgetItems,
    unread: budgetUnread,
    markRead: markBudgetRead,
    markAll: markAllBudgetRead,
  } = useBudgetDepartmentNotifications('cfo');

  const badgeTotal = total + budgetUnread;

  const openBudgetItem = async (n: DeptNotification) => {
    setOpen(false);
    if (!n.is_read) await markBudgetRead(n.id);
    navigate(n.link || '/budgets');
  };

  const icons: Record<CfoApprovalNotificationKey, typeof Bell> = {
    roi: TrendingUp,
    rent: Home,
    agentAdvances: Banknote,
    businessAdvances: Briefcase,
    creditDraws: CreditCard,
    allocationReturns: Undo2,
    unfunding: Undo2,
    merchantFloat: Store,
    agentRequisitions: FileText,
    partnerTopups: Wallet,
    directorRequisitions: FileText,
    employeeRequisitions: Users,
    staffRequisitions: Users,
    withdrawals: ArrowDownToLine,
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={
            badgeTotal > 0
              ? `${badgeTotal} notifications awaiting your review`
              : 'No pending notifications'
          }
          className="relative p-1.5 rounded-lg hover:bg-white/10 transition-colors"
          style={{ touchAction: 'manipulation' }}
        >
          <Bell className="h-4 w-4" />
          {badgeTotal > 0 && (
            <span className="absolute -top-0.5 -right-0.5 min-w-[16px] h-4 px-1 rounded-full bg-destructive text-destructive-foreground text-[10px] font-bold flex items-center justify-center">
              {badgeTotal > 99 ? '99+' : badgeTotal}
            </span>
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 p-0 max-h-[70vh] overflow-y-auto">
        <div className="px-4 py-3 border-b border-border">
          <p className="text-sm font-semibold">Notifications</p>
          <p className="text-xs text-muted-foreground">Items ready for CFO approval</p>
        </div>
        <div className="divide-y divide-border">
          {isLoading && (
            <p className="px-4 py-6 text-sm text-muted-foreground">Checking approvals…</p>
          )}
          {!isLoading && notifications.length === 0 && failed.length === 0 && (
            <p className="px-4 py-6 text-sm text-muted-foreground">
              No pending approvals right now.
            </p>
          )}
          {notifications.map((n) => {
            const Icon = icons[n.key] ?? Bell;
            return (
              <button
                key={n.key}
                type="button"
                onClick={() => onJump(n.tabId)}
                className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-muted transition-colors"
              >
                <span className="h-8 w-8 rounded-lg bg-primary/10 text-primary flex items-center justify-center shrink-0">
                  <Icon className="h-4 w-4" />
                </span>
                <span className="flex-1 min-w-0">
                  <span className="block text-sm font-medium truncate">{n.title}</span>
                  <span className="block text-xs text-muted-foreground">
                    {n.count} {n.count === 1 ? 'item' : 'items'} awaiting approval
                  </span>
                </span>
                <span className="text-xs font-bold text-primary">{n.count}</span>
              </button>
            );
          })}
          {failed.map((n) => {
            const Icon = icons[n.key] ?? Bell;
            return (
              <div
                key={n.key}
                className="w-full flex items-center gap-3 px-4 py-3 text-left opacity-70"
              >
                <span className="h-8 w-8 rounded-lg bg-destructive/10 text-destructive flex items-center justify-center shrink-0">
                  <Icon className="h-4 w-4" />
                </span>
                <span className="flex-1 min-w-0">
                  <span className="block text-sm font-medium truncate">{n.title}</span>
                  <span className="block text-xs text-muted-foreground">
                    Temporarily unavailable — retrying automatically
                  </span>
                </span>
                <AlertCircle className="h-4 w-4 text-destructive shrink-0" />
              </div>
            );
          })}
        </div>

        {/* Department budgets (finance-scoped) — merged into this single bell */}
        <div className="px-4 py-2.5 border-t border-border flex items-center justify-between">
          <p className="text-sm font-semibold">Department budgets</p>
          {budgetUnread > 0 && (
            <Button
              variant="ghost"
              size="sm"
              className="h-7 gap-1 text-xs text-muted-foreground"
              onClick={markAllBudgetRead}
            >
              <Check className="h-3 w-3" />
              Mark all read
            </Button>
          )}
        </div>
        <div className="px-2 pb-2 space-y-1">
          {budgetItems.length === 0 && (
            <p className="px-2 pb-2 text-xs text-muted-foreground">
              No budget notices for your departments.
            </p>
          )}
          {budgetItems.map((n) => (
            <button
              key={n.id}
              type="button"
              onClick={() => openBudgetItem(n)}
              className={cn(
                'w-full text-left px-3 py-2.5 rounded-xl transition-colors flex gap-3',
                n.is_read ? 'opacity-60 hover:bg-accent/30' : 'bg-accent/40 hover:bg-accent/60',
              )}
            >
              <span className="h-8 w-8 rounded-lg bg-primary/10 text-primary flex items-center justify-center shrink-0">
                <ClipboardList className="h-4 w-4" />
              </span>
              <span className="flex-1 min-w-0">
                <span className="flex items-start justify-between gap-2">
                  <span className="text-xs font-semibold leading-tight">{n.department_name}</span>
                  {!n.is_read && <span className="w-2 h-2 rounded-full bg-primary shrink-0 mt-1" />}
                </span>
                <span className="block text-[11px] font-medium mt-0.5">{n.cycle_title}</span>
                <span className="block text-[11px] text-muted-foreground mt-0.5 line-clamp-3">
                  {n.message}
                </span>
                <span className="block text-[10px] text-muted-foreground/70 mt-1">
                  {formatDistanceToNow(new Date(n.created_at), { addSuffix: true })} · Open Department Budgets
                </span>
              </span>
            </button>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}
