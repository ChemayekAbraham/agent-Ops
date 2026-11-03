/** Loading placeholders. They hold the shape of the real thing, so nothing jumps when data lands. */

export function Skeleton({ className = '' }: { className?: string }) {
  return <div className={`animate-pulse rounded bg-muted motion-reduce:animate-none ${className}`} aria-hidden />;
}

export function SkeletonLead() {
  return (
    <div className="space-y-2" role="status" aria-label="Loading figures">
      <Skeleton className="h-6 w-full max-w-2xl" />
      <Skeleton className="h-6 w-2/3 max-w-md" />
    </div>
  );
}

export function SkeletonTiles({ count, board }: { count: number; board: boolean }) {
  return (
    <div className={`grid gap-3 ${board ? 'grid-cols-4' : 'grid-cols-2 md:grid-cols-3 xl:grid-cols-4'}`} role="status" aria-label="Loading figures">
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="rounded-lg border border-border bg-card p-4 space-y-2">
          <Skeleton className="h-3 w-24" />
          <Skeleton className="h-8 w-20" />
        </div>
      ))}
    </div>
  );
}

export function SkeletonRows({ cols, rows = 6 }: { cols: number; rows?: number }) {
  return (
    <>
      {Array.from({ length: rows }, (_, r) => (
        <tr key={r} className="border-b border-border last:border-0">
          {Array.from({ length: cols }, (_, c) => (
            <td key={c} className="px-3 py-2.5">
              <Skeleton className={`h-3.5 ${c === 0 ? 'w-24' : 'w-16'}`} />
            </td>
          ))}
        </tr>
      ))}
    </>
  );
}
