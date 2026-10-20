import { useState, type ReactNode } from 'react';
import { AlertTriangle, ChevronLeft, ChevronRight, ChevronRight as RowArrow, GitBranch, Loader2, RefreshCw, Wallet } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { useTenantOpsRentLifetime, useTenantOpsRentLifetimeList } from '@/hooks/useTenantOpsRentLifetime';
import {
  FUNNEL_LABEL, LIFETIME_BUCKET_HINT, LIFETIME_BUCKET_TITLE, LIFETIME_PAGE_SIZE, kampalaDate, pct, stagePassRate, updatedClock,
  type LifetimeBucket, type RentLifetime,
} from '@/lib/rentLifetime';
import { formatUGX } from '@/lib/rentCalculations';
import { cn } from '@/lib/utils';
import { TenantOpsRentLifetimeHowCounted } from './TenantOpsRentLifetimeHowCounted';

// The all-time rent request section of the Tenant Ops summary. Every count and amount is what tenant_ops_rent_request_lifetime() returns; the page's
// date filter does not reach it (the hooks take no dates). Percentages are display only (pct of two figures the server returned).

const n = (v: number) => v.toLocaleString('en-US');
const p = (v: number) => `${v}%`;

interface Refresh { onRefresh: () => void; busy: boolean; clock: string | null }

function CardTools({ onRefresh, busy, clock }: Refresh) {
  return (
    <span className="flex shrink-0 items-center gap-1">
      {clock && <span className="whitespace-nowrap text-xs font-normal text-muted-foreground" data-testid="lifetime-updated">Updated {clock}</span>}
      <Button type="button" variant="ghost" size="icon" className="h-9 w-9" onClick={onRefresh} aria-label="Refresh the all-time figures" data-testid="lifetime-refresh">
        <RefreshCw className={cn('h-3.5 w-3.5', busy && 'animate-spin')} />
      </Button>
    </span>
  );
}

function AllTimeBadge() {
  return <Badge variant="outline" className="shrink-0 whitespace-nowrap text-xs font-medium" data-testid="lifetime-all-time-badge">All time</Badge>;
}

/** Plain placeholder blocks (no shared component, so no ref is ever handed to a function component here). */
function Placeholder({ className }: { className: string }) {
  return <div className={cn('animate-pulse rounded-xl bg-muted/50', className)} />;
}

export function TenantOpsRentLifetimeCards() {
  const q = useTenantOpsRentLifetime();
  const [bucket, setBucket] = useState<LifetimeBucket | null>(null);
  const failed = !!q.error && !q.isFetching;
  const tools: Refresh = { onRefresh: q.refetch, busy: q.isFetching, clock: updatedClock(q.data?.generated_at) };

  return (
    <section className="space-y-2.5" data-testid="lifetime-section" aria-label="Rent requests, all time">
      <div className="flex items-center gap-3">
        <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Rent requests — all time</p>
        <div className="h-px flex-1 bg-border/70" />
        <TenantOpsRentLifetimeHowCounted />
      </div>
      <p className="text-xs text-muted-foreground" data-testid="lifetime-note">These figures cover all time; the date filter does not apply.</p>
      {q.isLoading ? (
        <div className="grid gap-3 lg:grid-cols-2" data-testid="lifetime-loading" aria-busy="true" aria-label="Loading all-time rent request figures">
          <Placeholder className="h-[380px]" />
          <Placeholder className="h-[380px]" />
        </div>
      ) : failed || !q.data ? (
        <Card className="border shadow-sm" data-testid="lifetime-error">
          <CardContent role="alert" className="flex flex-col gap-2 p-4">
            <p className="flex items-start gap-2 text-sm text-destructive"><AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />Could not load the all-time rent request figures.</p>
            <Button type="button" variant="outline" className="min-h-11 self-start" onClick={q.refetch}><RefreshCw className="mr-2 h-4 w-4" />Retry</Button>
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-3 lg:grid-cols-2" data-testid="lifetime-cards">
          <JourneyCard d={q.data} tools={tools} />
          <RepaymentCard d={q.data} tools={tools} onOpen={setBucket} />
        </div>
      )}
      <LifetimeSheet bucket={bucket} onClose={() => setBucket(null)} />
    </section>
  );
}

function JourneyCard({ d, tools }: { d: RentLifetime; tools: Refresh }) {
  const o = d.outcomes;
  const rows = d.stage_funnel;
  return (
    <Card className="border shadow-sm" data-testid="lifetime-journey">
      <CardHeader className="px-3 pb-2 sm:px-4">
        <CardTitle className="flex items-center justify-between gap-2 text-sm font-semibold">
          <span className="flex min-w-0 items-center gap-2"><GitBranch className="h-4 w-4 shrink-0 text-primary" />Rent request journey</span>
          <span className="flex shrink-0 items-center gap-1"><AllTimeBadge /></span>
        </CardTitle>
        <div className="flex items-center justify-between gap-2">
          <p className="text-xs text-muted-foreground">Requests that cleared each stage or a later one, since the start.</p>
          <CardTools {...tools} />
        </div>
      </CardHeader>
      <CardContent className="space-y-3 px-3 pb-3 sm:px-4">
        {/* phones: one block per stage with a thin bar */}
        <ul className="space-y-3 sm:hidden" data-testid="lifetime-funnel-cards">
          <li data-testid="lifetime-card-row-submitted">
            <div className="flex items-baseline justify-between gap-2">
              <span className="text-sm font-medium text-foreground">Submitted</span>
              <span className="text-sm font-bold tabular-nums text-foreground">{n(d.submitted)}</span>
            </div>
            <div className="mt-1 h-1.5 w-full rounded-full bg-muted"><div className="h-full rounded-full bg-primary" style={{ width: d.submitted > 0 ? '100%' : '0%' }} /></div>
            <p className="mt-1 text-xs text-muted-foreground">{d.submitted > 0 ? '100%' : p(0)} of submitted · of previous: —</p>
          </li>
          {rows.map((row, i) => (
            <li key={row.stage} data-testid={`lifetime-card-row-${row.stage}`}>
              <div className="flex items-baseline justify-between gap-2">
                <span className="text-sm text-foreground">{FUNNEL_LABEL[row.stage]}</span>
                <span className="text-sm font-bold tabular-nums text-foreground">{n(row.count)}</span>
              </div>
              <div className="mt-1 h-1.5 w-full rounded-full bg-muted"><div className="h-full rounded-full bg-primary" style={{ width: `${pct(row.count, d.submitted)}%` }} /></div>
              <p className="mt-1 text-xs text-muted-foreground">{p(pct(row.count, d.submitted))} of submitted · {p(stagePassRate(rows, i, d.submitted))} of previous</p>
            </li>
          ))}
        </ul>
        {/* 640px and wider: the table */}
        <div className="hidden overflow-x-auto sm:block">
          <table className="w-full text-sm" data-testid="lifetime-funnel">
            <thead>
              <tr className="text-left text-xs text-muted-foreground">
                <th className="py-1 pr-2 font-medium">Stage</th>
                <th className="px-2 py-1 text-right font-medium">Requests</th>
                <th className="px-2 py-1 text-right font-medium">Of submitted</th>
                <th className="py-1 pl-2 text-right font-medium">Of previous</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              <tr data-testid="lifetime-row-submitted">
                <td className="py-2 pr-2 font-medium text-foreground">Submitted</td>
                <td className="px-2 py-2 text-right font-bold tabular-nums text-foreground">{n(d.submitted)}</td>
                <td className="px-2 py-2 text-right tabular-nums text-muted-foreground">{d.submitted > 0 ? '100%' : p(0)}</td>
                <td className="py-2 pl-2 text-right text-muted-foreground">—</td>
              </tr>
              {rows.map((row, i) => (
                <tr key={row.stage} data-testid={`lifetime-row-${row.stage}`}>
                  <td className="py-2 pr-2 text-foreground">{FUNNEL_LABEL[row.stage]}</td>
                  <td className="px-2 py-2 text-right font-bold tabular-nums text-foreground">{n(row.count)}</td>
                  <td className="px-2 py-2 text-right tabular-nums text-muted-foreground" data-testid={`lifetime-of-submitted-${row.stage}`}>{p(pct(row.count, d.submitted))}</td>
                  <td className="py-2 pl-2 text-right tabular-nums text-muted-foreground" data-testid={`lifetime-of-previous-${row.stage}`}>{p(stagePassRate(rows, i, d.submitted))}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <dl className="grid grid-cols-2 gap-x-3 gap-y-2 border-t border-border pt-3" data-testid="lifetime-outcomes">
          {([
            ['Waiting at Service Centre', o.waiting_service_centre],
            ['In approval', o.in_approval],
            ['Rejected', o.rejected],
            ['Withdrawn by agent', o.deleted_by_agent],
            ['Cancelled', o.cancelled],
          ] as const).map(([label, v]) => (
            <div key={label} className="min-w-0">
              <dt className="text-xs leading-snug text-muted-foreground">{label}</dt>
              <dd className="text-sm font-bold tabular-nums text-foreground">{n(v)}</dd>
            </div>
          ))}
        </dl>
      </CardContent>
    </Card>
  );
}

const BUCKETS = [
  { key: 'full', label: 'Paid in full', bar: 'bg-primary', open: null },
  { key: 'partial', label: 'Partly paid', bar: 'bg-primary/50', open: null },
  { key: 'never_paid', label: 'Never paid (30+ days)', bar: 'bg-destructive', open: 'never_paid' },
  { key: 'too_early', label: 'Too early', bar: 'bg-muted-foreground/40', open: null },
] as const;

function RowShell({ open, onOpen, label, testId, children }: { open: LifetimeBucket | null; onOpen: (b: LifetimeBucket) => void; label: string; testId: string; children: ReactNode }) {
  if (!open) return <li className="flex items-center justify-between gap-2 py-2" data-testid={testId}>{children}</li>;
  return (
    <li data-testid={testId}>
      <button
        type="button" onClick={() => onOpen(open)} aria-label={`Open the list: ${label}`}
        className="flex min-h-11 w-full items-center justify-between gap-2 rounded-lg py-2 text-left hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {children}
      </button>
    </li>
  );
}

function RepaymentCard({ d, tools, onOpen }: { d: RentLifetime; tools: Refresh; onOpen: (b: LifetimeBucket) => void }) {
  return (
    <Card className="border shadow-sm" data-testid="lifetime-repayment">
      <CardHeader className="px-3 pb-2 sm:px-4">
        <CardTitle className="flex items-center justify-between gap-2 text-sm font-semibold">
          <span className="flex min-w-0 items-center gap-2"><Wallet className="h-4 w-4 shrink-0 text-primary" />Financed: repayment outcome</span>
          <span className="flex shrink-0 items-center gap-1"><AllTimeBadge /></span>
        </CardTitle>
        <div className="flex items-center justify-between gap-2">
          <p className="text-xs text-muted-foreground">Rent Plans where the landlord has been paid: {n(d.financed)} in all.</p>
          <CardTools {...tools} />
        </div>
      </CardHeader>
      <CardContent className="space-y-3 px-3 pb-3 sm:px-4">
        <div className="flex h-3 w-full overflow-hidden rounded-full bg-muted" role="img" aria-label="Share of financed Rent Plans by repayment outcome" data-testid="lifetime-bar">
          {BUCKETS.map((b) => (
            <div key={b.key} className={cn('h-full', b.bar)} style={{ width: `${pct(d.repayment[b.key], d.financed)}%` }} data-testid={`lifetime-bar-${b.key}`} />
          ))}
        </div>
        <ul className="divide-y divide-border" data-testid="lifetime-buckets">
          {BUCKETS.map((b) => (
            <RowShell key={b.key} open={b.open} onOpen={onOpen} label={b.label} testId={`lifetime-bucket-${b.key}`}>
              <span className="flex items-center gap-2 text-sm text-foreground"><span className={cn('h-2.5 w-2.5 rounded-full', b.bar)} aria-hidden="true" />{b.label}</span>
              <span className="flex items-center gap-1 text-right">
                <span className="text-sm font-bold tabular-nums text-foreground">{n(d.repayment[b.key])}</span>
                <span className="ml-1 text-xs tabular-nums text-muted-foreground">{p(pct(d.repayment[b.key], d.financed))}</span>
                {b.open && <RowArrow className="h-4 w-4 text-muted-foreground" aria-hidden="true" />}
              </span>
            </RowShell>
          ))}
        </ul>
        <ul className="divide-y divide-border border-t border-border pt-1">
          <RowShell open="funded_not_financed" onOpen={onOpen} label={LIFETIME_BUCKET_TITLE.funded_not_financed} testId="lifetime-funded-not-financed">
            <span className="text-sm text-foreground">Funded but not yet financed</span>
            <span className="flex items-center gap-1"><span className="text-sm font-bold tabular-nums text-foreground">{n(d.funded_not_financed)}</span><RowArrow className="h-4 w-4 text-muted-foreground" aria-hidden="true" /></span>
          </RowShell>
          <RowShell open="financed_now_closed" onOpen={onOpen} label={LIFETIME_BUCKET_TITLE.financed_now_closed} testId="lifetime-closed-row">
            <span className="text-sm text-foreground">Financed, now rejected, cancelled or withdrawn</span>
            <span className="flex items-center gap-1"><span className="text-sm font-bold tabular-nums text-foreground">{n(d.financed_now_closed)}</span><RowArrow className="h-4 w-4 text-muted-foreground" aria-hidden="true" /></span>
          </RowShell>
        </ul>
        <div className="flex items-center justify-between gap-2 border-t border-border pt-3" data-testid="lifetime-recovered">
          <span className="text-sm text-foreground">Money recovered</span>
          <span className="text-right">
            <span className="text-sm font-bold tabular-nums text-foreground">{p(pct(d.money.amount_repaid, d.money.total_repayment))}</span>
            <span className="block text-xs tabular-nums text-muted-foreground">{formatUGX(d.money.amount_repaid)} of {formatUGX(d.money.total_repayment)}</span>
          </span>
        </div>
      </CardContent>
    </Card>
  );
}

function statusText(s: string) {
  const t = s.replace(/_/g, ' ');
  return t.charAt(0).toUpperCase() + t.slice(1);
}

function LifetimeSheet({ bucket, onClose }: { bucket: LifetimeBucket | null; onClose: () => void }) {
  const [page, setPage] = useState(0);
  const [lastBucket, setLastBucket] = useState<LifetimeBucket | null>(null);
  if (bucket !== lastBucket) { setLastBucket(bucket); setPage(0); }
  const q = useTenantOpsRentLifetimeList(bucket, page);
  const last = Math.max(0, Math.ceil(q.total / LIFETIME_PAGE_SIZE) - 1);
  const from = q.rows.length ? page * LIFETIME_PAGE_SIZE + 1 : 0;
  const to = page * LIFETIME_PAGE_SIZE + q.rows.length;
  return (
    <Sheet open={bucket != null} onOpenChange={(o) => { if (!o) onClose(); }}>
      <SheetContent side="right" className="w-full overflow-y-auto sm:max-w-xl" data-testid="lifetime-sheet">
        <SheetHeader className="text-left">
          <SheetTitle>{bucket ? LIFETIME_BUCKET_TITLE[bucket] : ''}</SheetTitle>
          <SheetDescription>{bucket ? LIFETIME_BUCKET_HINT[bucket] : ''}</SheetDescription>
        </SheetHeader>
        <div className="mt-3 space-y-2">
          {q.isLoading ? (
            <div className="space-y-2" data-testid="lifetime-sheet-loading" aria-busy="true"><Placeholder className="h-20" /><Placeholder className="h-20" /><Placeholder className="h-20" /></div>
          ) : q.error && !q.isFetching ? (
            <div role="alert" className="flex flex-col gap-2 rounded-xl border border-destructive/40 bg-destructive/5 p-3" data-testid="lifetime-sheet-error">
              <p className="flex items-start gap-2 text-sm text-destructive"><AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />Could not load this list.</p>
              <Button type="button" variant="outline" className="min-h-11 self-start" onClick={q.refetch}><RefreshCw className="mr-2 h-4 w-4" />Retry</Button>
            </div>
          ) : q.rows.length === 0 ? (
            <p className="rounded-xl border border-dashed border-border p-4 text-center text-sm text-muted-foreground" data-testid="lifetime-sheet-empty">No Rent Plans in this group.</p>
          ) : (
            <>
              <p className="flex items-center gap-2 text-xs text-muted-foreground" data-testid="lifetime-sheet-count">
                {n(from)} to {n(to)} of {n(q.total)}{q.isFetching && <Loader2 className="h-3 w-3 animate-spin" aria-label="Updating" />}
              </p>
              <ul className="divide-y divide-border rounded-xl border border-border" data-testid="lifetime-sheet-list">
                {q.rows.map((r) => (
                  <li key={r.id} className="space-y-0.5 p-3" data-testid="lifetime-sheet-row">
                    <div className="flex items-baseline justify-between gap-2">
                      <p className="min-w-0 break-words text-sm font-semibold text-foreground">{r.tenant_name}</p>
                      <p className="shrink-0 text-xs text-muted-foreground">{statusText(r.status)}</p>
                    </div>
                    <p className="text-xs text-muted-foreground">Agent {r.agent_name}</p>
                    <p className="text-xs text-muted-foreground">Rent {formatUGX(r.rent_amount)}, owed {formatUGX(r.total_repayment)}, repaid {formatUGX(r.amount_repaid)}</p>
                    <p className="text-xs text-muted-foreground">
                      {bucket === 'funded_not_financed' ? `Funded ${kampalaDate(r.funded_at)}` : `Landlord paid about ${kampalaDate(r.landlord_paid_at)}`}
                    </p>
                  </li>
                ))}
              </ul>
              <div className="flex items-center justify-end gap-1">
                <Button type="button" variant="outline" className="min-h-11 min-w-11" disabled={page === 0 || q.isFetching} onClick={() => setPage((x) => Math.max(0, x - 1))} aria-label="Previous page"><ChevronLeft className="h-4 w-4" /></Button>
                <Button type="button" variant="outline" className="min-h-11 min-w-11" disabled={page >= last || q.isFetching} onClick={() => setPage((x) => Math.min(last, x + 1))} aria-label="Next page"><ChevronRight className="h-4 w-4" /></Button>
              </div>
            </>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
