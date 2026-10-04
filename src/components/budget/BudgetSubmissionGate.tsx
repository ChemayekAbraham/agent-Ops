import { useNavigate } from 'react-router-dom';
import { format } from 'date-fns';
import { ClipboardList, AlertTriangle, ArrowRight } from 'lucide-react';
import WelileLogo from '@/components/WelileLogo';
import { Button } from '@/components/ui/button';
import { useBudgetSubmissionGate } from '@/hooks/useBudgetSubmissionGate';

/**
 * Full-screen required-action gate for an open budget cycle the signed-in user
 * still owes a submission for.
 *
 * Mounted around the authenticated route tree (same place as AccountFrozenGate)
 * so it covers the dashboard, sidebar, navigation and every page control while
 * it is showing. There is deliberately no close button, no cancel, no
 * click-outside and no escape dismissal: the only two exits are completing the
 * submission or the session-scoped "Skip for Now" the hook already owns.
 *
 * It fails open by design — while the obligation query is loading or errored,
 * `shouldPrompt` is false and the application renders normally.
 */
export function BudgetSubmissionGate({ children }: { children: React.ReactNode }) {
  const navigate = useNavigate();
  const { obligation, shouldPrompt, skip } = useBudgetSubmissionGate();

  if (!shouldPrompt || !obligation) return <>{children}</>;

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

  return (
    <div
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="budget-gate-title"
      className="fixed inset-0 z-[10000] flex flex-col items-center justify-center overflow-y-auto bg-background p-4 sm:p-6"
    >
      <div className="mx-auto w-full max-w-lg rounded-2xl border border-border bg-card p-6 shadow-xl sm:p-8">
        <div className="mb-6 flex justify-center">
          <WelileLogo size="lg" linkToHome={false} />
        </div>

        <div
          className={`mx-auto mb-5 flex h-14 w-14 items-center justify-center rounded-full ${
            overdue ? 'bg-destructive/10' : 'bg-primary/10'
          }`}
        >
          {overdue ? (
            <AlertTriangle className="h-7 w-7 text-destructive" />
          ) : (
            <ClipboardList className="h-7 w-7 text-primary" />
          )}
        </div>

        <p className="text-center text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          Action required
        </p>
        <h1
          id="budget-gate-title"
          className="mt-1 text-center text-2xl font-semibold tracking-tight text-foreground"
        >
          New budget cycle
        </h1>
        <p className="mt-3 text-center text-sm leading-relaxed text-muted-foreground">
          A new budget cycle has been opened and your department budget is required before
          the cycle closes. Complete your submission to continue as normal.
        </p>

        {overdue && (
          <div className="mt-5 rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-center">
            <p className="text-sm font-semibold text-destructive">
              This submission is overdue
            </p>
            <p className="mt-1 text-xs text-destructive/90">
              The deadline has passed. Submit now — your budget will be recorded as late.
            </p>
          </div>
        )}

        <dl className="mt-5 space-y-2 rounded-lg border border-border bg-muted/40 p-4">
          <div className="flex items-baseline justify-between gap-3">
            <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Budget cycle
            </dt>
            <dd className="text-sm font-semibold text-foreground text-right">
              {obligation.cycle_title}
            </dd>
          </div>
          <div className="flex items-baseline justify-between gap-3">
            <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Department
            </dt>
            <dd className="text-sm font-semibold text-foreground text-right">
              {obligation.department_name}
            </dd>
          </div>
          <div className="flex items-baseline justify-between gap-3">
            <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Deadline
            </dt>
            <dd
              className={`text-sm font-semibold text-right ${
                overdue ? 'text-destructive' : 'text-foreground'
              }`}
            >
              {deadline ? format(deadline, 'd MMM yyyy, HH:mm') : 'No deadline set'}
            </dd>
          </div>
        </dl>

        <div className="mt-6 flex flex-col gap-2">
          <Button className="w-full" onClick={openBudgetForm}>
            Complete Budget Submission
            <ArrowRight className="ml-2 h-4 w-4" />
          </Button>
          <Button variant="ghost" className="w-full" onClick={skip}>
            Skip for Now
          </Button>
        </div>

        <p className="mt-4 text-center text-[11px] leading-relaxed text-muted-foreground">
          Skipping hides this screen for the rest of this session only. The budget stays
          outstanding and remains listed in your notifications until it is submitted.
        </p>
      </div>
    </div>
  );
}

export default BudgetSubmissionGate;
