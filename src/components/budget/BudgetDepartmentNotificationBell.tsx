import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Bell, Check, AlertTriangle } from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { cn } from '@/lib/utils';
import {
  useBudgetDepartmentNotifications,
  type DeptNotification,
} from './useBudgetDepartmentNotifications';
import { useBudgetSubmissionGate } from '@/hooks/useBudgetSubmissionGate';
import { departmentKeysForDashboard } from './departmentScope';


/**
 * Department-level budget notice bell. A single notice exists per budget cycle
 * per department; every user with dashboard access to that department sees it,
 * and read state is tracked per user.
 *
 * Pass `dashboard` (executive-hub tab slug, role slug, or dashboard permission
 * key) to scope the bell to that dashboard's own department(s). Scoping is
 * enforced server-side by `get_budget_department_notifications`.
 */
export function BudgetDepartmentNotificationBell({
  className,
  dashboard,
  departmentKeys,
}: {
  className?: string;
  dashboard?: string;
  departmentKeys?: string[];
}) {
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();
  const { items, unread, markRead, markAll } = useBudgetDepartmentNotifications(
    dashboard,
    departmentKeys,
  );

  const openItem = async (n: DeptNotification) => {
    setOpen(false);
    if (!n.is_read) await markRead(n.id);
    navigate(n.link || '/budgets');
  };

  /**
   * Required-action state comes from `hasOutstanding`, never `shouldPrompt`:
   * skipping the full-screen gate hides the gate only, so the bell must keep
   * offering the way back to the outstanding budget.
   */
  const { obligation, hasOutstanding } = useBudgetSubmissionGate();
  const scopeKeys = departmentKeys ?? departmentKeysForDashboard(dashboard);
  const required =
    hasOutstanding && obligation && (!scopeKeys || scopeKeys.includes(obligation.department_key))
      ? obligation
      : null;

  const openRequired = () => {
    if (!required) return;
    setOpen(false);
    const params = new URLSearchParams({
      cycle: required.call_id,
      department: required.department_id,
    });
    if (required.draft_submission_id) params.set('submission', required.draft_submission_id);
    navigate(`/budgets?${params.toString()}`);
  };


  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          aria-label="Department budget notifications"
          className={cn('relative shrink-0', className)}
        >
          <Bell className="h-5 w-5" />
          {unread > 0 ? (
            <span className="absolute -top-0.5 -right-0.5 min-w-[18px] h-[18px] px-1 flex items-center justify-center rounded-full bg-destructive text-destructive-foreground text-[10px] font-bold">
              {unread > 9 ? '9+' : unread}
            </span>
          ) : required ? (
            <span className="absolute -top-0.5 -right-0.5 h-2.5 w-2.5 rounded-full bg-destructive ring-2 ring-background" />
          ) : null}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" sideOffset={8} className="w-80 p-0 rounded-2xl">
        <div className="flex items-center justify-between px-4 pt-3 pb-2">
          <h3 className="text-sm font-bold">Department budgets</h3>
          {unread > 0 && (
            <Button variant="ghost" size="sm" className="h-7 gap-1 text-xs text-muted-foreground" onClick={markAll}>
              <Check className="h-3 w-3" />
              Mark all read
            </Button>
          )}
        </div>
        <div className="max-h-[320px] overflow-y-auto px-2 pb-2 space-y-1">
          {required && (
            <button
              onClick={openRequired}
              className="w-full text-left px-3 py-2.5 rounded-xl border border-destructive/40 bg-destructive/10 transition-colors hover:bg-destructive/15"
            >
              <div className="flex items-center gap-1.5">
                <AlertTriangle className="h-3.5 w-3.5 text-destructive shrink-0" />
                <p className="text-xs font-bold text-destructive">
                  {required.is_overdue ? 'Budget submission overdue' : 'Budget submission required'}
                </p>
              </div>
              <p className="text-[11px] font-medium mt-0.5">{required.cycle_title}</p>
              <p className="text-[11px] text-muted-foreground mt-0.5">
                {required.department_name} · Open the budget form to complete it
              </p>
            </button>
          )}
          {items.length === 0 && !required && (
            <p className="px-3 py-4 text-xs text-muted-foreground">No budget notices for your departments.</p>
          )}
          {items.map(n => (
            <button
              key={n.id}
              onClick={() => openItem(n)}
              className={cn(
                'w-full text-left px-3 py-2.5 rounded-xl transition-colors',
                n.is_read ? 'opacity-60 hover:bg-accent/30' : 'bg-accent/40 hover:bg-accent/60',
              )}
            >
              <div className="flex items-start justify-between gap-2">
                <p className="text-xs font-semibold leading-tight">{n.department_name}</p>
                {!n.is_read && <span className="w-2 h-2 rounded-full bg-primary shrink-0 mt-1" />}
              </div>
              <p className="text-[11px] font-medium mt-0.5">{n.cycle_title}</p>
              <p className="text-[11px] text-muted-foreground mt-0.5 line-clamp-3">{n.message}</p>
              <p className="text-[10px] text-muted-foreground/70 mt-1">
                {formatDistanceToNow(new Date(n.created_at), { addSuffix: true })} · Open Department Budgets
              </p>
            </button>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}
