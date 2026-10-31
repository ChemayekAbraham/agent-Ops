import { useLocation, useNavigate } from 'react-router-dom';
import { ClipboardList, AlertTriangle, ArrowRight, X } from 'lucide-react';
import WelileLogo from '@/components/WelileLogo';
import { Button } from '@/components/ui/button';
import { useBudgetSubmissionGate } from '@/hooks/useBudgetSubmissionGate';
import { useSessionPopup } from '@/hooks/useSessionPopup';
import { useAuth } from '@/hooks/useAuth';
import { useEffect, useState } from 'react';
import { Textarea } from '@/components/ui/textarea';
import { supabase } from '@/integrations/supabase/client';

/** Roles whose job includes opening and reviewing budget cycles. */
const BUDGET_WORKFLOW_ROLES = ['cfo', 'coo', 'ceo', 'super_admin'];

const BUDGET_DEADLINE_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Local `d MMM yyyy, HH:mm`. Inlined so the shell does not import date-fns. */
function formatBudgetDeadline(d: Date): string {
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${d.getDate()} ${BUDGET_DEADLINE_MONTHS[d.getMonth()]} ${d.getFullYear()}, ${hh}:${mm}`;
}

/**
 * Budget reminder for an open cycle the signed-in user still owes a submission for.
 *
 * People who are not in the budget workflow (Partner Ops and the other desks)
 * get a dismissible banner. The dashboard stays usable. CFO, COO, CEO and
 * super admin can still get one dialog, and only when it is the single popup
 * for this browser session. Escape and a click outside that dialog dismiss it
 * for the session. Skip does not clear the obligation.
 *
 * It fails open by design — while the obligation query is loading or errored,
 * `shouldPrompt` is false and the application renders normally.
 */
export function BudgetSubmissionGate({ children }: { children: React.ReactNode }) {
  const navigate = useNavigate();
  const location = useLocation();
  const { enabledRoles, rolesResolved } = useAuth();
  const { obligation, shouldPrompt, skip, refresh } = useBudgetSubmissionGate();
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onBudgetPage = location.pathname.startsWith('/budgets');
  const inBudgetWorkflow = rolesResolved && (enabledRoles || []).some((role) =>
    BUDGET_WORKFLOW_ROLES.includes(role),
  );
  const wantsModal = shouldPrompt && !!obligation && inBudgetWorkflow && !onBudgetPage;
  const granted = useSessionPopup('budget', wantsModal ? 'ready' : 'idle');
  const showModal = wantsModal && granted;
  const showBanner = shouldPrompt && !!obligation && !onBudgetPage && !showModal;

  useEffect(() => {
    if (!showModal && !showBanner) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      skip();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [showModal, showBanner, skip]);

  // The budget form itself must stay usable.
  if (!shouldPrompt || !obligation || onBudgetPage) return <>{children}</>;

  /** Declines this cycle for the department server-side; the obligation then clears on refresh. */
  const confirmReject = async () => {
    setBusy(true);
    setError(null);
    const { error: rpcError } = await supabase.rpc('budget_decline_obligation' as any, {
      p_call_id: obligation.call_id,
      p_department_id: obligation.department_id,
      p_reason: reason.trim(),
    });
    setBusy(false);
    if (rpcError) {
      setError(rpcError.message || 'Could not reject this budget. Please try again.');
      return;
    }
    setRejecting(false);
    setReason('');
    refresh();
  };

  const deadline = obligation.deadline ? new Date(obligation.deadline) : null;
  const overdue = obligation.is_overdue;

  const openBudgetForm = () => {
    const params = new URLSearchParams({
      cycle: obligation.call_id,
      department: obligation.department_id,
    });
    // Resume the existing draft rather than starting a second submission.
    if (obligation.draft_submission_id) params.set('submission', obligation.draft_submission_id);
    navigate(`/budgets?${params.toString()}`);
  };

  const actions = (
    <div className={showModal ? 'mt-6 flex flex-col gap-2' : 'mt-2 flex flex-wrap gap-2'}>
      <Button className={showModal ? 'w-full' : ''} size={showModal ? 'default' : 'sm'} onClick={openBudgetForm}>
        Complete Budget Submission
        <ArrowRight className="ml-2 h-4 w-4" />
      </Button>
      {rejecting ? (
        <div className="w-full space-y-2 rounded-lg border border-destructive/40 p-3">
          <Textarea
            value={reason}
            onChange={e => setReason(e.target.value)}
            placeholder="Why is your department declining this budget? (at least 10 characters)"
            rows={3}
          />
          {error && <p className="text-xs text-destructive">{error}</p>}
          <div className="flex gap-2">
            <Button variant="ghost" className="flex-1" disabled={busy} onClick={() => { setRejecting(false); setError(null); }}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              className="flex-1"
              disabled={busy || reason.trim().length < 10}
              onClick={confirmReject}
            >
              {busy ? 'Rejecting…' : 'Confirm Reject'}
            </Button>
          </div>
        </div>
      ) : (
        <Button variant="destructive" className={showModal ? 'w-full' : ''} size={showModal ? 'default' : 'sm'} onClick={() => setRejecting(true)}>
          Reject
        </Button>
      )}
      <Button variant="ghost" className={showModal ? 'w-full' : ''} size={showModal ? 'default' : 'sm'} onClick={skip}>
        Skip for Now
      </Button>
    </div>
  );

  const banner = (
    <div className="pointer-events-none fixed inset-x-0 top-0 z-[60] px-3 pt-3">
      <div
        role="status"
        aria-labelledby="budget-gate-title"
        className="pointer-events-auto mx-auto flex w-full max-w-3xl items-start gap-3 rounded-xl border border-border bg-card p-3 shadow-lg"
      >
        <div className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full ${overdue ? 'bg-destructive/10' : 'bg-primary/10'}`}>
          {overdue ? <AlertTriangle className="h-4 w-4 text-destructive" /> : <ClipboardList className="h-4 w-4 text-primary" />}
        </div>
        <div className="min-w-0 flex-1">
          <p id="budget-gate-title" className="text-sm font-semibold text-foreground">New budget cycle</p>
          <p className="text-xs leading-relaxed text-muted-foreground">
            {obligation.department_name} still owes {obligation.cycle_title}. Deadline {deadline ? formatBudgetDeadline(deadline) : 'not set'}.
            {overdue ? ' This submission is overdue.' : ''}
          </p>
          {actions}
        </div>
        <Button variant="ghost" size="icon" className="shrink-0" onClick={skip} aria-label="Dismiss budget reminder">
          <X className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );

  const modal = (
    <div
      className="fixed inset-0 z-[80] flex items-center justify-center overflow-y-auto bg-background/80 p-4"
      onMouseDown={skip}
    >
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="budget-gate-title"
        className="mx-auto w-full max-w-lg rounded-2xl border border-border bg-card p-6 shadow-xl sm:p-8"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="mb-6 flex justify-center">
          <WelileLogo size="lg" linkToHome={false} />
        </div>
        <div className={`mx-auto mb-5 flex h-14 w-14 items-center justify-center rounded-full ${overdue ? 'bg-destructive/10' : 'bg-primary/10'}`}>
          {overdue ? <AlertTriangle className="h-7 w-7 text-destructive" /> : <ClipboardList className="h-7 w-7 text-primary" />}
        </div>
        <p className="text-center text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Action required</p>
        <h1 id="budget-gate-title" className="mt-1 text-center text-2xl font-semibold tracking-tight text-foreground">New budget cycle</h1>
        <p className="mt-3 text-center text-sm leading-relaxed text-muted-foreground">
          A new budget cycle has been opened and your department budget is required before
          the cycle closes. Complete your submission to continue as normal.
        </p>
        {overdue && (
          <div className="mt-5 rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-center">
            <p className="text-sm font-semibold text-destructive">This submission is overdue</p>
            <p className="mt-1 text-xs text-destructive/90">The deadline has passed. Submit now — your budget will be recorded as late.</p>
          </div>
        )}
        <dl className="mt-5 space-y-2 rounded-lg border border-border bg-muted/40 p-4">
          <div className="flex items-baseline justify-between gap-3">
            <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Budget cycle</dt>
            <dd className="text-right text-sm font-semibold text-foreground">{obligation.cycle_title}</dd>
          </div>
          <div className="flex items-baseline justify-between gap-3">
            <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Department</dt>
            <dd className="text-right text-sm font-semibold text-foreground">{obligation.department_name}</dd>
          </div>
          <div className="flex items-baseline justify-between gap-3">
            <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Deadline</dt>
            <dd className={`text-right text-sm font-semibold ${overdue ? 'text-destructive' : 'text-foreground'}`}>
              {deadline ? formatBudgetDeadline(deadline) : 'No deadline set'}
            </dd>
          </div>
        </dl>
        {actions}
        <p className="mt-4 text-center text-[11px] leading-relaxed text-muted-foreground">
          Escape, a click outside, or Skip for Now hides this for the rest of this session only.
          The budget stays outstanding and remains listed in your notifications until it is submitted.
        </p>
      </div>
    </div>
  );

  return (
    <>
      {children}
      {showModal ? modal : banner}
    </>
  );
}

export default BudgetSubmissionGate;
