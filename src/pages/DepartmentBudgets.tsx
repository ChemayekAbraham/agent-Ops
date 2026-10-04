import { ArrowLeft } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useNavigate, useSearchParams } from 'react-router-dom';
import DepartmentBudgetSubmission from '@/components/budget/DepartmentBudgetSubmission';

export default function DepartmentBudgets() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  // Opened from a department hub (e.g. /budgets?dashboard=tenant-ops) the form is
  // locked to that department, so submissions stay department-specific.
  const dashboard = params.get('dashboard') ?? undefined;
  // Opened from the budget submission gate: the exact cycle/department that is
  // owed, and the existing draft to resume so no duplicate submission is made.
  const initialCycleId = params.get('cycle') ?? undefined;
  const initialDepartmentId = params.get('department') ?? undefined;
  const initialSubmissionId = params.get('submission') ?? undefined;

  return (
    <main className="mx-auto w-full max-w-[1440px] space-y-5 p-4 pb-24 sm:p-6 lg:p-8">
      <header className="flex items-center gap-3 border-b border-border/70 pb-4">
        <Button variant="ghost" size="icon" onClick={() => navigate(-1)} aria-label="Go back">
          <ArrowLeft className="h-5 w-5" />
        </Button>
        <div>
          <h1 className="text-xl font-semibold sm:text-2xl">Department Budgets</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Prepare your department budget against the company chart of accounts and submit it for CFO approval.
          </p>
        </div>
      </header>
      <DepartmentBudgetSubmission
        dashboard={dashboard}
        initialCycleId={initialCycleId}
        initialDepartmentId={initialDepartmentId}
        initialSubmissionId={initialSubmissionId}
      />
    </main>
  );
}