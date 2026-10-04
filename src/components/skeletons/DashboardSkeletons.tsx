import { 
  Skeleton, 
  SkeletonMetricCard, 
  SkeletonWallet, 
  SkeletonListItem,
  SkeletonChart,
  SkeletonProductGrid,
  SkeletonTransactionList,
  SkeletonTable
} from '@/components/ui/skeleton';

export function DashboardHeaderSkeleton() {
  return (
    <div
      className="flex items-center justify-between p-4 border-b border-border bg-card/80 backdrop-blur-sm"
    >
      <div className="flex items-center gap-3">
        <Skeleton className="h-10 w-10 rounded-lg" />
        <div className="space-y-2">
          <Skeleton className="h-5 w-32" />
          <Skeleton className="h-3 w-24" />
        </div>
      </div>
      <div className="flex items-center gap-2">
        <Skeleton className="h-9 w-9 rounded-full" />
        <Skeleton className="h-9 w-9 rounded-full" />
      </div>
    </div>
  );
}

export function TenantDashboardSkeleton() {
  return (
    <div
      className="space-y-6 p-4"
    >
      <DashboardHeaderSkeleton />
      
      <div>
        <SkeletonWallet />
      </div>
      
      <div className="grid grid-cols-2 gap-3">
        <SkeletonMetricCard />
        <SkeletonMetricCard />
      </div>
      
      <div className="space-y-3">
        <Skeleton className="h-5 w-32" />
        <SkeletonListItem />
        <SkeletonListItem />
        <SkeletonListItem />
      </div>
    </div>
  );
}

export function AgentDashboardSkeleton() {
  return (
    <div
      className="space-y-6 p-4"
    >
      <DashboardHeaderSkeleton />
      
      <div className="grid grid-cols-2 gap-3">
        <SkeletonMetricCard />
        <SkeletonMetricCard />
        <SkeletonMetricCard />
        <SkeletonMetricCard />
      </div>
      
      <div>
        <SkeletonChart />
      </div>
      
      <div className="space-y-3">
        <Skeleton className="h-5 w-40" />
        <SkeletonListItem />
        <SkeletonListItem />
        <SkeletonListItem />
        <SkeletonListItem />
      </div>
    </div>
  );
}

export function ManagerDashboardSkeleton() {
  return (
    <div
      className="space-y-6 p-4"
    >
      <DashboardHeaderSkeleton />
      
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <SkeletonMetricCard />
        <SkeletonMetricCard />
        <SkeletonMetricCard />
        <SkeletonMetricCard />
      </div>
      
      <div className="grid md:grid-cols-2 gap-4">
        <SkeletonChart />
        <SkeletonChart />
      </div>
      
      <div className="space-y-3">
        <div className="flex items-center gap-2">
          <Skeleton className="h-10 w-24 rounded-md" />
          <Skeleton className="h-10 w-24 rounded-md" />
          <Skeleton className="h-10 w-24 rounded-md" />
        </div>
      </div>
    </div>
  );
}

export function SupporterDashboardSkeleton() {
  return (
    <div
      className="space-y-6 p-4"
    >
      <DashboardHeaderSkeleton />
      
      <div>
        <SkeletonWallet />
      </div>
      
      <div className="grid grid-cols-3 gap-3">
        <SkeletonMetricCard />
        <SkeletonMetricCard />
        <SkeletonMetricCard />
      </div>
      
      <div className="space-y-3">
        <Skeleton className="h-5 w-40" />
        <SkeletonListItem />
        <SkeletonListItem />
        <SkeletonListItem />
      </div>
    </div>
  );
}

export function LandlordDashboardSkeleton() {
  return (
    <div
      className="space-y-6 p-4"
    >
      <DashboardHeaderSkeleton />
      
      <div>
        <SkeletonWallet />
      </div>
      
      <div className="grid grid-cols-2 gap-3">
        <SkeletonMetricCard />
        <SkeletonMetricCard />
      </div>
      
      <div className="space-y-3">
        <Skeleton className="h-5 w-36" />
        <SkeletonListItem />
        <SkeletonListItem />
        <SkeletonListItem />
      </div>
    </div>
  );
}

// Marketplace skeleton
export function MarketplaceSkeleton() {
  return (
    <div
      className="space-y-6 p-4"
    >
      {/* Search and filter bar */}
      <div className="flex gap-3">
        <Skeleton className="h-10 flex-1 rounded-lg" />
        <Skeleton className="h-10 w-10 rounded-lg" />
      </div>
      
      {/* Category tabs */}
      <div className="flex gap-2 overflow-hidden">
        <Skeleton className="h-9 w-16 rounded-full" />
        <Skeleton className="h-9 w-20 rounded-full" />
        <Skeleton className="h-9 w-24 rounded-full" />
        <Skeleton className="h-9 w-18 rounded-full" />
        <Skeleton className="h-9 w-22 rounded-full" />
      </div>
      
      {/* Product grid */}
      <div>
        <SkeletonProductGrid count={8} />
      </div>
    </div>
  );
}

// Cart skeleton
export function CartSkeleton() {
  return (
    <div
      className="space-y-4 p-4"
    >
      {[...Array(3)].map((_, i) => (
        <div
          key={i}
          className="flex gap-3 p-3 rounded-xl bg-card border border-border/50"
        >
          <Skeleton className="h-16 w-16 rounded-lg" />
          <div className="flex-1 space-y-2">
            <Skeleton className="h-4 w-3/4" />
            <Skeleton className="h-3 w-1/2" />
            <div className="flex items-center gap-2 pt-1">
              <Skeleton className="h-7 w-7 rounded" />
              <Skeleton className="h-5 w-8" />
              <Skeleton className="h-7 w-7 rounded" />
            </div>
          </div>
          <Skeleton className="h-5 w-20" />
        </div>
      ))}
      
      {/* Order summary */}
      <div className="pt-4 border-t border-border/50 space-y-3">
        <div className="flex justify-between">
          <Skeleton className="h-4 w-20" />
          <Skeleton className="h-4 w-24" />
        </div>
        <div className="flex justify-between">
          <Skeleton className="h-5 w-16" />
          <Skeleton className="h-6 w-28" />
        </div>
        <Skeleton className="h-11 w-full rounded-lg" />
      </div>
    </div>
  );
}

// Settings page skeleton
export function SettingsSkeleton() {
  return (
    <div
      className="min-h-screen bg-background p-4 space-y-6"
    >
      <DashboardHeaderSkeleton />
      
      {/* Profile section */}
      <div className="flex items-center gap-4 p-4 rounded-xl bg-card border border-border">
        <Skeleton className="h-16 w-16 rounded-full" />
        <div className="flex-1 space-y-2">
          <Skeleton className="h-5 w-40" />
          <Skeleton className="h-4 w-32" />
        </div>
        <Skeleton className="h-9 w-20 rounded-lg" />
      </div>
      
      {/* Settings sections */}
      {[...Array(4)].map((_, i) => (
        <div key={i} className="space-y-3">
          <Skeleton className="h-4 w-24" />
          <div className="rounded-xl bg-card border border-border divide-y divide-border">
            {[...Array(3)].map((_, j) => (
              <div key={j} className="flex items-center justify-between p-4">
                <div className="flex items-center gap-3">
                  <Skeleton className="h-5 w-5 rounded" />
                  <Skeleton className="h-4 w-32" />
                </div>
                <Skeleton className="h-6 w-10 rounded-full" />
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

// Receipts page skeleton
export function ReceiptsSkeleton() {
  return (
    <div
      className="min-h-screen bg-background p-4 space-y-6"
    >
      <DashboardHeaderSkeleton />
      
      {/* Stats cards */}
      <div className="grid grid-cols-2 gap-3">
        <SkeletonMetricCard />
        <SkeletonMetricCard />
      </div>
      
      {/* Action buttons */}
      <div className="flex gap-2">
        <Skeleton className="h-10 flex-1 rounded-lg" />
        <Skeleton className="h-10 flex-1 rounded-lg" />
      </div>
      
      {/* Receipt list */}
      <div className="space-y-3">
        <Skeleton className="h-5 w-28" />
        {[...Array(5)].map((_, i) => (
          <div
            key={i}
            className="flex items-center gap-3 p-4 rounded-xl bg-card border border-border"
          >
            <Skeleton className="h-12 w-12 rounded-lg" />
            <div className="flex-1 space-y-2">
              <Skeleton className="h-4 w-3/4" />
              <Skeleton className="h-3 w-1/2" />
            </div>
            <div className="space-y-1 text-right">
              <Skeleton className="h-5 w-20 ml-auto" />
              <Skeleton className="h-4 w-16 ml-auto rounded-full" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// Loans page skeleton
export function LoansSkeleton() {
  return (
    <div
      className="min-h-screen bg-background p-4 space-y-6"
    >
      <DashboardHeaderSkeleton />
      
      {/* Loan summary */}
      <div className="p-5 rounded-xl bg-gradient-to-br from-primary/10 to-primary/5 border border-primary/20 space-y-3">
        <div className="flex items-center justify-between">
          <Skeleton className="h-5 w-32" />
          <Skeleton className="h-6 w-20 rounded-full" />
        </div>
        <Skeleton className="h-10 w-48" />
        <div className="flex gap-4">
          <div className="space-y-1">
            <Skeleton className="h-3 w-16" />
            <Skeleton className="h-5 w-24" />
          </div>
          <div className="space-y-1">
            <Skeleton className="h-3 w-16" />
            <Skeleton className="h-5 w-24" />
          </div>
        </div>
      </div>
      
      {/* Progress bar */}
      <div className="space-y-2">
        <div className="flex justify-between">
          <Skeleton className="h-4 w-24" />
          <Skeleton className="h-4 w-16" />
        </div>
        <Skeleton className="h-3 w-full rounded-full" />
      </div>
      
      {/* Loan list */}
      <div className="space-y-3">
        <Skeleton className="h-5 w-28" />
        {[...Array(4)].map((_, i) => (
          <div
            key={i}
            className="p-4 rounded-xl bg-card border border-border space-y-3"
          >
            <div className="flex items-center justify-between">
              <Skeleton className="h-5 w-32" />
              <Skeleton className="h-5 w-16 rounded-full" />
            </div>
            <div className="grid grid-cols-3 gap-2">
              <div className="space-y-1">
                <Skeleton className="h-3 w-12" />
                <Skeleton className="h-4 w-20" />
              </div>
              <div className="space-y-1">
                <Skeleton className="h-3 w-12" />
                <Skeleton className="h-4 w-20" />
              </div>
              <div className="space-y-1">
                <Skeleton className="h-3 w-12" />
                <Skeleton className="h-4 w-20" />
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// Transaction history skeleton
export function TransactionHistorySkeleton() {
  return (
    <div
      className="min-h-screen bg-background p-4 space-y-6"
    >
      <DashboardHeaderSkeleton />
      
      {/* Filter tabs */}
      <div className="flex gap-2 overflow-x-auto pb-2">
        <Skeleton className="h-9 w-16 rounded-full" />
        <Skeleton className="h-9 w-20 rounded-full" />
        <Skeleton className="h-9 w-24 rounded-full" />
        <Skeleton className="h-9 w-20 rounded-full" />
      </div>
      
      {/* Date groups */}
      {[...Array(3)].map((_, groupIndex) => (
        <div key={groupIndex} className="space-y-3">
          <Skeleton className="h-4 w-24" />
          <SkeletonTransactionList count={3} />
        </div>
      ))}
    </div>
  );
}

// Referrals page skeleton
export function ReferralsSkeleton() {
  return (
    <div
      className="min-h-screen bg-background p-4 space-y-6"
    >
      <DashboardHeaderSkeleton />
      
      {/* Stats overview */}
      <div className="grid grid-cols-3 gap-3">
        <SkeletonMetricCard />
        <SkeletonMetricCard />
        <SkeletonMetricCard />
      </div>
      
      {/* Share card */}
      <div className="p-5 rounded-xl bg-gradient-to-br from-primary/10 to-accent/10 border border-primary/20 space-y-4">
        <div className="flex items-center gap-3">
          <Skeleton className="h-12 w-12 rounded-xl" />
          <div className="flex-1 space-y-2">
            <Skeleton className="h-5 w-40" />
            <Skeleton className="h-4 w-56" />
          </div>
        </div>
        <Skeleton className="h-11 w-full rounded-lg" />
      </div>
      
      {/* Referral list */}
      <div className="space-y-3">
        <Skeleton className="h-5 w-32" />
        {[...Array(5)].map((_, i) => (
          <SkeletonListItem key={i} />
        ))}
      </div>
      
      {/* Leaderboard */}
      <div>
        <Skeleton className="h-5 w-28 mb-3" />
        <SkeletonTable rows={5} />
      </div>
    </div>
  );
}

// Generic page skeleton
export function PageSkeleton() {
  return (
    <div
      className="min-h-screen bg-background p-4 space-y-6"
    >
      <DashboardHeaderSkeleton />
      
      <div className="space-y-4">
        <Skeleton className="h-6 w-48" />
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-3/4" />
      </div>
      
      <div className="grid grid-cols-2 gap-3">
        <SkeletonMetricCard />
        <SkeletonMetricCard />
      </div>
      
      <div className="space-y-3">
        <SkeletonListItem />
        <SkeletonListItem />
        <SkeletonListItem />
        <SkeletonListItem />
      </div>
    </div>
  );
}
