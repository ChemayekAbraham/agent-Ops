import { FinOpsScope } from '@/components/financial-ops/FinOpsScope';
import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Banknote, ChevronRight, Home, RefreshCw, Search } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { FinancialOpsCommandCenter } from '@/components/financial-ops/FinancialOpsCommandCenter';
import { BudgetDepartmentNotificationBell } from '@/components/budget/BudgetDepartmentNotificationBell';
import { FINOPS_MENU_SLUG, finopsIdFromSlug, finopsPath, FINOPS_BASE } from '@/lib/financialOpsRoutes';
import { FINOPS_MENU_GROUPS } from '@/components/financial-ops/new-ui/finopsMenu';
import { setFinOpsAutoRefresh, useFinOpsAutoRefresh } from '@/hooks/useFinOpsAutoRefresh';

const LABELS = new Map(FINOPS_MENU_GROUPS.flatMap((g) => g.entries).map((e) => [e.id, e.label]));

function ago(ms: number | undefined, now: number): string {
  if (!ms) return 'not yet';
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 5) return 'just now';
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m ago` : `${Math.floor(m / 60)}h ago`;
}
import { V360StaffPricingBanner } from '@/components/v360/V360StaffPricingBanner';

export default function FinancialOpsPage() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { panel } = useParams();
  const autoRefresh = useFinOpsAutoRefresh();
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 5000);
    return () => window.clearInterval(t);
  }, []);

  // Ctrl/Cmd+K jumps to Transaction Search, the same tool the search box opens.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        navigate(finopsPath('search'));
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [navigate]);

  const goToManagerDashboard = () => navigate('/dashboard/manager');
  const goBack = () => {
    if (window.history.length > 1) navigate(-1);
    else goToManagerDashboard();
  };

  const here = panel ? (panel === FINOPS_MENU_SLUG ? 'All tools' : LABELS.get(finopsIdFromSlug(panel)) ?? 'Tool') : 'Overview';
  const updatedAt = qc.getQueryState(['finops-wallet-overview'])?.dataUpdatedAt;

  const refresh = () => {
    void qc.invalidateQueries({
      predicate: (q) => {
        const k = String(q.queryKey[0] ?? '');
        return k.startsWith('finops') || k.startsWith('merchant-float') || k.startsWith('payout-verification');
      },
    });
    setNow(Date.now());
  };

  return (
    <FinOpsScope>
    <div className="finops-surface min-h-screen bg-background overflow-x-clip">
      {/* Sticky top bar: where you are, find anything, how fresh the numbers are */}
      <div className="sticky top-0 z-40 border-b border-border bg-background/95 shadow-xs backdrop-blur">
        <div className="flex w-full min-w-0 items-center gap-2 px-3 py-2 sm:gap-3 sm:px-6">
          <Button variant="ghost" size="icon" onClick={goBack} className="h-10 w-10 shrink-0 sm:hidden" aria-label="Back to previous page">
            <ArrowLeft className="h-4 w-4" />
          </Button>

          <nav aria-label="Breadcrumb" className="hidden min-w-0 shrink-0 items-center gap-1.5 text-sm sm:flex">
            <Link to={FINOPS_BASE} aria-label="Financial Operations overview" className="rounded-md p-1 text-muted-foreground hover:text-foreground">
              <Home className="h-4 w-4" />
            </Link>
            <Link to={FINOPS_BASE} className="font-medium text-muted-foreground hover:text-foreground">Financial Operations</Link>
            <ChevronRight className="h-3.5 w-3.5 text-muted-foreground/60" aria-hidden />
            <span className="truncate font-semibold text-foreground">{here}</span>
          </nav>
          <span className="min-w-0 flex-1 truncate text-sm font-semibold text-foreground sm:hidden">{here}</span>

          <button
            type="button"
            onClick={() => navigate(finopsPath('search'))}
            className="mx-auto hidden h-10 w-full max-w-md min-w-0 flex-1 items-center gap-2 rounded-xl border border-border bg-card px-3 text-left text-sm text-muted-foreground hover:border-primary/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary md:flex"
            aria-label="Search transactions, TIDs, phones or users"
          >
            <Search className="h-4 w-4 shrink-0" aria-hidden />
            <span className="flex-1 truncate">Find a transaction, TID, phone or user</span>
            <kbd className="rounded border border-border bg-muted px-1.5 py-0.5 text-[10px] font-semibold">Ctrl K</kbd>
          </button>

          <div className="ml-auto flex shrink-0 items-center gap-2 sm:gap-3">
            <button
              type="button"
              onClick={() => navigate(finopsPath('search'))}
              className="flex h-10 w-10 items-center justify-center rounded-xl border border-border bg-card text-muted-foreground md:hidden"
              aria-label="Search transactions, TIDs, phones or users"
            >
              <Search className="h-4 w-4" />
            </button>
            <span className="hidden items-center gap-1.5 text-xs text-muted-foreground lg:flex" aria-live="polite">
              <span className="relative flex h-2 w-2">
                <span className={`absolute inline-flex h-full w-full rounded-full bg-emerald-500 opacity-75 ${autoRefresh ? 'animate-ping' : ''}`} />
                <span className={`relative inline-flex h-2 w-2 rounded-full ${autoRefresh ? 'bg-emerald-500' : 'bg-muted-foreground'}`} />
              </span>
              Last updated {ago(updatedAt, now)}
            </span>
            <Button variant="outline" size="sm" onClick={refresh} className="h-10 gap-1.5 rounded-xl px-3 text-sm font-semibold" aria-label="Refresh the numbers">
              <RefreshCw className="h-4 w-4" aria-hidden />
              <span className="hidden sm:inline">Refresh</span>
            </Button>
            <label className="hidden cursor-pointer select-none items-center gap-2 text-sm font-medium sm:inline-flex" title={autoRefresh ? 'Numbers update on their own. Turn off to keep the screen still while you review.' : 'Auto-refresh is off.'}>
              Auto-refresh
              <Switch checked={autoRefresh} onCheckedChange={setFinOpsAutoRefresh} aria-label="Toggle auto-refresh" />
            </label>
            <Button variant="outline" size="sm" onClick={() => navigate('/desk/funders')} className="h-10 gap-1.5 rounded-xl px-3 text-sm font-semibold">
              <Banknote className="h-4 w-4" aria-hidden />
              <span className="hidden sm:inline">Funders Dashboard</span>
              <span className="sm:hidden">Funders</span>
            </Button>
            <BudgetDepartmentNotificationBell dashboard="financial-ops" />
            <Button variant="outline" size="sm" onClick={goToManagerDashboard} className="hidden h-10 gap-1.5 rounded-xl px-3 text-sm font-semibold xl:inline-flex">
              <ArrowLeft className="h-4 w-4" aria-hidden /> Back to Manager dashboard
            </Button>
          </div>
        </div>
      </div>

      <div className="w-full min-w-0 space-y-3 px-3 py-3 sm:px-6">
        <V360StaffPricingBanner />
        <FinancialOpsCommandCenter />
      </div>
    </div>
    </FinOpsScope>
  );
}
