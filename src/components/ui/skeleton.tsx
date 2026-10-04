import { cn } from "@/lib/utils";

interface SkeletonProps extends React.HTMLAttributes<HTMLDivElement> {
  className?: string;
  shimmer?: boolean;
}

function Skeleton({ className, shimmer = true }: SkeletonProps) {
  return (
    <div className={cn("relative rounded-lg bg-muted/40 overflow-hidden", className)}>
      {shimmer && (
        <div className="skeleton-shimmer absolute inset-0 -translate-x-full bg-gradient-to-r from-transparent via-foreground/[0.03] to-transparent" />
      )}
    </div>
  );
}

// Enhanced skeleton with gentle pulse
function SkeletonPulse({ className }: { className?: string }) {
  return <div className={cn("rounded-lg bg-muted/40 animate-pulse", className)} />;
}

// Skeleton variants for common UI patterns
function SkeletonCard({ className }: { className?: string }) {
  return (
    <div className={cn("animate-fade-in rounded-xl border border-border bg-card p-5 space-y-4", className)}>
      <div className="flex items-center gap-3">
        <Skeleton className="h-10 w-10 rounded-full" />
        <div className="space-y-2 flex-1">
          <Skeleton className="h-4 w-1/3" />
          <Skeleton className="h-3 w-1/4" />
        </div>
      </div>
      <Skeleton className="h-20 w-full" />
      <div className="flex gap-2">
        <Skeleton className="h-8 w-20" />
        <Skeleton className="h-8 w-20" />
      </div>
    </div>
  );
}

function SkeletonMetricCard({ className }: { className?: string }) {
  return (
    <div className={cn("animate-fade-in rounded-xl border border-border bg-card p-4 space-y-3", className)}>
      <div className="flex items-center justify-between">
        <Skeleton className="h-4 w-24" />
        <Skeleton className="h-8 w-8 rounded-lg" />
      </div>
      <Skeleton className="h-8 w-32" />
      <Skeleton className="h-3 w-20" />
    </div>
  );
}

function SkeletonListItem({ className }: { className?: string }) {
  return (
    <div className={cn("animate-fade-in flex items-center gap-3 p-3 rounded-lg bg-secondary/20", className)}>
      <Skeleton className="h-10 w-10 rounded-full" />
      <div className="flex-1 space-y-2">
        <Skeleton className="h-4 w-3/4" />
        <Skeleton className="h-3 w-1/2" />
      </div>
      <Skeleton className="h-5 w-16" />
    </div>
  );
}

function SkeletonWallet({ className }: { className?: string }) {
  return (
    <div className={cn("animate-fade-in rounded-xl overflow-hidden border border-border", className)}>
      <div className="bg-gradient-to-br from-muted/60 to-muted/30 p-5 space-y-4">
        <div className="flex items-center gap-3">
          <Skeleton className="h-10 w-10 rounded-lg" />
          <Skeleton className="h-5 w-28" />
        </div>
        <div className="flex items-center gap-4">
          <Skeleton className="h-14 w-14 rounded-full" />
          <div className="space-y-2">
            <Skeleton className="h-4 w-24" />
            <Skeleton className="h-3 w-20" />
            <Skeleton className="h-8 w-36" />
          </div>
        </div>
      </div>
      <div className="p-5 space-y-4 bg-card">
        <div className="grid grid-cols-3 gap-2">
          <Skeleton className="h-9 rounded-lg" />
          <Skeleton className="h-9 rounded-lg" />
          <Skeleton className="h-9 rounded-lg" />
        </div>
        <div className="space-y-2 pt-4 border-t border-border">
          <Skeleton className="h-4 w-32 mb-3" />
          <SkeletonListItem />
          <SkeletonListItem />
          <SkeletonListItem />
        </div>
      </div>
    </div>
  );
}

function SkeletonChart({ className }: { className?: string }) {
  return (
    <div className={cn("animate-fade-in rounded-xl border border-border bg-card p-5 space-y-4", className)}>
      <div className="flex items-center justify-between">
        <Skeleton className="h-5 w-32" />
        <Skeleton className="h-8 w-24 rounded-lg" />
      </div>
      <div className="flex items-end gap-2 h-48">
        {[...Array(7)].map((_, i) => (
          <div
            key={i}
            style={{ height: `${30 + ((i * 37) % 60)}%`, animationDelay: `${i * 0.04}s` }}
            className="animate-fade-in flex-1 bg-muted/40 rounded-t-lg origin-bottom"
          />
        ))}
      </div>
    </div>
  );
}

function SkeletonTable({ rows = 5, className }: { rows?: number; className?: string }) {
  return (
    <div className={cn("animate-fade-in rounded-xl border border-border bg-card overflow-hidden", className)}>
      <div className="p-4 border-b border-border flex gap-4">
        <Skeleton className="h-4 w-20" />
        <Skeleton className="h-4 w-24" />
        <Skeleton className="h-4 w-16" />
        <Skeleton className="h-4 w-20 ml-auto" />
      </div>
      <div className="divide-y divide-border/50">
        {[...Array(rows)].map((_, i) => (
          <div
            key={i}
            style={{ animationDelay: `${i * 0.04}s` }}
            className="animate-fade-in p-4 flex items-center gap-4"
          >
            <Skeleton className="h-8 w-8 rounded-full" />
            <Skeleton className="h-4 w-32" />
            <Skeleton className="h-4 w-24" />
            <Skeleton className="h-4 w-16 ml-auto" />
          </div>
        ))}
      </div>
    </div>
  );
}

// Product card skeleton for marketplace
function SkeletonProductCard({ className }: { className?: string }) {
  return (
    <div className={cn("animate-fade-in rounded-xl border border-border bg-card overflow-hidden", className)}>
      <Skeleton className="aspect-square w-full rounded-none" />
      <div className="p-4 space-y-3">
        <div className="flex items-start justify-between gap-2">
          <Skeleton className="h-5 w-3/4" />
          <Skeleton className="h-5 w-16 rounded-full" />
        </div>
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-2/3" />
        <div className="flex items-center justify-between pt-2">
          <Skeleton className="h-6 w-24" />
          <Skeleton className="h-4 w-16" />
        </div>
        <div className="flex gap-2 pt-2">
          <Skeleton className="h-9 w-9 rounded-lg" />
          <Skeleton className="h-9 flex-1 rounded-lg" />
        </div>
      </div>
    </div>
  );
}

// Product grid skeleton
function SkeletonProductGrid({ count = 8, className }: { count?: number; className?: string }) {
  return (
    <div className={cn("grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4", className)}>
      {[...Array(count)].map((_, i) => (
        <div key={i} style={{ animationDelay: `${i * 0.04}s` }} className="animate-fade-in">
          <SkeletonProductCard />
        </div>
      ))}
    </div>
  );
}

// Transaction list skeleton
function SkeletonTransactionList({ count = 5, className }: { count?: number; className?: string }) {
  return (
    <div className={cn("space-y-3", className)}>
      {[...Array(count)].map((_, i) => (
        <div
          key={i}
          style={{ animationDelay: `${i * 0.05}s` }}
          className="animate-fade-in flex items-center gap-4 p-4 rounded-xl bg-card border border-border"
        >
          <Skeleton className="h-12 w-12 rounded-full" />
          <div className="flex-1 space-y-2">
            <Skeleton className="h-4 w-1/2" />
            <Skeleton className="h-3 w-1/3" />
          </div>
          <div className="text-right space-y-2">
            <Skeleton className="h-5 w-20 ml-auto" />
            <Skeleton className="h-3 w-16 ml-auto" />
          </div>
        </div>
      ))}
    </div>
  );
}

// Inline text skeleton for loading text content
function SkeletonText({ lines = 3, className }: { lines?: number; className?: string }) {
  return (
    <div className={cn("space-y-2", className)}>
      {[...Array(lines)].map((_, i) => (
        <Skeleton key={i} className={cn("h-4", i === lines - 1 ? "w-2/3" : "w-full")} />
      ))}
    </div>
  );
}

// Avatar skeleton
function SkeletonAvatar({ size = "md", className }: { size?: "sm" | "md" | "lg"; className?: string }) {
  const sizeClasses = { sm: "h-8 w-8", md: "h-10 w-10", lg: "h-14 w-14" };
  return <Skeleton className={cn("rounded-full", sizeClasses[size], className)} />;
}

// Button skeleton
function SkeletonButton({ className }: { className?: string }) {
  return <Skeleton className={cn("h-10 w-24 rounded-lg", className)} />;
}

export {
  Skeleton,
  SkeletonPulse,
  SkeletonCard,
  SkeletonMetricCard,
  SkeletonListItem,
  SkeletonWallet,
  SkeletonChart,
  SkeletonTable,
  SkeletonProductCard,
  SkeletonProductGrid,
  SkeletonTransactionList,
  SkeletonText,
  SkeletonAvatar,
  SkeletonButton
};
