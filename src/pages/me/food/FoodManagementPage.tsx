import { Link, useSearchParams } from 'react-router-dom';
import { ShieldAlert, Eye, UtensilsCrossed } from 'lucide-react';
import PersonalLayout from '@/components/layout/PersonalLayout';
import { Button } from '@/components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Skeleton } from '@/components/ui/skeleton';
import { useRequireFoodCoordinator, useFoodSession, useFoodCoordinatorOverview } from '@/hooks/useFoodService';
import FoodOverviewPanel from '@/components/food/manage/FoodOverviewPanel';
import FoodQueuePanel from '@/components/food/manage/FoodQueuePanel';
import FoodMenuPanel from '@/components/food/manage/FoodMenuPanel';
import FoodServicePanel from '@/components/food/manage/FoodServicePanel';
import FoodAuditPanel from '@/components/food/manage/FoodAuditPanel';
import FoodCoordinatorPanel from '@/components/food/manage/FoodCoordinatorPanel';

const VALID_TABS = ['overview', 'queue', 'menu', 'service', 'audit', 'coordinator'] as const;
type FoodManagementTab = typeof VALID_TABS[number];

/**
 * Food Management. Deliberately lives in My Space, not the CFO dashboard, and
 * is reachable only by someone holding a Food Coordinator assignment.
 *
 * A BACKUP holder reads everything and authors nothing: `canAuthor` is threaded
 * into every panel so controls are disabled with a reason rather than hidden,
 * which is kinder than letting them click into a permission error.
 */
export default function FoodManagementPage() {
  useFoodSession();
  const { checked, allowed, isBackupOnly, isActive } = useRequireFoodCoordinator();
  // Pre-fetch coordinator overview in parallel once allowed
  useFoodCoordinatorOverview(undefined, allowed);

  const [searchParams, setSearchParams] = useSearchParams();
  const tabParam = searchParams.get('tab');
  const activeTab = (tabParam && (VALID_TABS as readonly string[]).includes(tabParam))
    ? tabParam
    : 'overview';

  const onTabChange = (nextTab: string) => {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      if (nextTab === 'overview') {
        next.delete('tab');
      } else {
        next.set('tab', nextTab);
      }
      return next;
    }, { replace: true });
  };

  if (!checked) {
    return (
      <PersonalLayout title="Food Management" backTo="/me" backLabel="Back to My space">
        <div className="mx-auto w-full max-w-5xl space-y-4 p-4 sm:p-6">
          <Skeleton className="h-7 w-48" />
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-24 w-full rounded-xl" />
            ))}
          </div>
          <Skeleton className="h-64 w-full rounded-xl" />
        </div>
      </PersonalLayout>
    );
  }

  if (!allowed) {
    return (
      <PersonalLayout title="Food Management" backTo="/me" backLabel="Back to My space">
        <div className="mx-auto w-full max-w-md p-6">
          <div className="flex flex-col items-center gap-3 rounded-xl border border-border/70 bg-card p-10 text-center">
            <ShieldAlert className="h-8 w-8 text-muted-foreground/50" aria-hidden="true" />
            <p className="text-sm font-medium">You do not have access to Food Management</p>
            <p className="text-xs text-muted-foreground">
              This area is for the Food Coordinator. Speak to the current holder if
              you believe you should have access.
            </p>
          </div>
        </div>
      </PersonalLayout>
    );
  }

  const canAuthor = isActive;

  return (
    <PersonalLayout title="Food Management" backTo="/me" backLabel="Back to My space">
      <div className="mx-auto w-full max-w-5xl space-y-4 p-4 sm:p-6">
        <header className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-lg font-semibold sm:text-xl">Food Management</h1>
            <p className="text-sm text-muted-foreground">
              The canteen menu, orders and service for today.
            </p>
          </div>
          <Button asChild variant="outline" size="sm" className="rounded-xl font-semibold">
            <Link to="/me/food">
              <UtensilsCrossed className="mr-2 h-4 w-4" aria-hidden="true" />
              Today&rsquo;s menu
            </Link>
          </Button>
        </header>

        {isBackupOnly && (
          <div className="flex gap-2 rounded-lg border border-border/70 bg-muted/60 p-3">
            <Eye className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
            <p className="text-xs leading-relaxed text-muted-foreground">
              You hold <strong className="font-semibold">backup</strong> access: you can see
              everything here but cannot change the menu or work the queue. The active
              Food Coordinator does that.
            </p>
          </div>
        )}

        <Tabs value={activeTab} onValueChange={onTabChange}>
          <TabsList className="flex h-auto w-full flex-wrap justify-start gap-1">
            <TabsTrigger value="overview">Overview</TabsTrigger>
            <TabsTrigger value="queue">Orders &amp; queue</TabsTrigger>
            <TabsTrigger value="menu">Menu</TabsTrigger>
            <TabsTrigger value="service">Service</TabsTrigger>
            <TabsTrigger value="audit">History</TabsTrigger>
            <TabsTrigger value="coordinator">Coordinator</TabsTrigger>
          </TabsList>

          <TabsContent value="overview" className="mt-4">
            <FoodOverviewPanel onSelectTab={onTabChange} />
          </TabsContent>
          <TabsContent value="queue" className="mt-4">
            <FoodQueuePanel canAuthor={canAuthor} />
          </TabsContent>
          <TabsContent value="menu" className="mt-4">
            <FoodMenuPanel canAuthor={canAuthor} />
          </TabsContent>
          <TabsContent value="service" className="mt-4">
            <FoodServicePanel canAuthor={canAuthor} />
          </TabsContent>
          <TabsContent value="audit" className="mt-4">
            <FoodAuditPanel canAuthor={canAuthor} />
          </TabsContent>
          <TabsContent value="coordinator" className="mt-4">
            <FoodCoordinatorPanel canAuthor={canAuthor} />
          </TabsContent>
        </Tabs>
      </div>
    </PersonalLayout>
  );
}
