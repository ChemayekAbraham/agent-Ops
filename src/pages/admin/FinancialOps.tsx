import { useNavigate } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { ArrowLeft, LayoutDashboard } from 'lucide-react';
import { FinancialOpsCommandCenter } from '@/components/financial-ops/FinancialOpsCommandCenter';
import { BudgetDepartmentNotificationBell } from '@/components/budget/BudgetDepartmentNotificationBell';

export default function FinancialOpsPage() {
  const navigate = useNavigate();

  const goToManagerDashboard = () => navigate('/dashboard/manager');
  const goBack = () => {
    if (window.history.length > 1) {
      navigate(-1);
    } else {
      navigate('/dashboard/manager');
    }
  };

  return (
    <div className="min-h-screen bg-background overflow-x-hidden">
      {/* Sticky top bar so the back action is always reachable */}
      <div className="sticky top-0 z-40 bg-background/95 backdrop-blur border-b border-border shadow-xs">
        <div className="w-full px-3 sm:px-6 py-2 sm:py-2.5 flex items-center justify-between gap-2 min-w-0">
          <Button
            variant="ghost"
            size="sm"
            onClick={goBack}
            className="gap-1.5 sm:gap-2 text-xs sm:text-sm font-medium -ml-1 sm:-ml-2 shrink-0"
            aria-label="Back to previous page"
          >
            <ArrowLeft className="h-4 w-4 shrink-0" />
            <span className="hidden sm:inline">Back to dashboard</span>
            <span className="sm:hidden">Back</span>
          </Button>
          <div className="flex items-center gap-1.5 shrink-0">
            <BudgetDepartmentNotificationBell dashboard="financial-ops" />
            <Button
              variant="outline"
              size="sm"
              onClick={goToManagerDashboard}
              className="gap-1.5 sm:gap-2 text-xs sm:text-sm font-medium shrink-0"
            >
              <LayoutDashboard className="h-4 w-4 shrink-0" />
              <span className="hidden sm:inline">Manager dashboard</span>
              <span className="sm:hidden">Manager</span>
            </Button>
          </div>
        </div>
      </div>

      <div className="w-full px-3 sm:px-6 py-3 sm:py-8 space-y-4 sm:space-y-6 min-w-0">
        <FinancialOpsCommandCenter />
      </div>
    </div>
  );
}
