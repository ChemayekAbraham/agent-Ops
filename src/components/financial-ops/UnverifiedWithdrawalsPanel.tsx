import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { formatUGX } from '@/lib/rentCalculations';
import { finopsPath } from '@/lib/financialOpsRoutes';
import { PageHeader, StatTile, Pager } from './FinopsKit';
import {
  UNVERIFIED_WITHDRAWALS_PAGE_SIZE,
  badgeLabel,
  missingPieces,
  useUnverifiedWithdrawals,
  useUnverifiedWithdrawalCounts,
  type UnverifiedBadgeFilter,
  type UnverifiedSort,
  type UnverifiedWithdrawalRow,
} from '@/hooks/useUnverifiedWithdrawals';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import {
  AlertTriangle,
  Banknote,
  BadgeCheck,
  CheckCircle2,
  Clock,
  EyeOff,
  Phone,
  Search,
  ShieldAlert,
  Smartphone,
  Users,
  X,
} from 'lucide-react';

/**
 * Admin-only view: open withdrawal requests whose owners have not finished
 * ID verification. Merchant agents never see these — the payout queue, the
 * automatic dispatcher and the claim action all refuse them. This panel is
 * the ONLY place they surface, so Financial Ops can call the person and walk
 * them through verification.
 */

function telHref(phone?: string | null): string | null {
  const digits = String(phone ?? '').replace(/\D/g, '');
  const last9 = digits.slice(-9);
  if (last9.length < 9) return null;
  return `tel:+256${last9}`;
}

function destinationLine(r: UnverifiedWithdrawalRow): string {
  if (r.payout_method === 'bank_transfer') {
    return [r.bank_name, r.bank_account_number].filter(Boolean).join(' · ') || 'Bank account';
  }
  return [r.mobile_money_provider, r.mobile_money_number].filter(Boolean).join(' · ') || 'Mobile money';
}

function MissingChips({ row }: { row: UnverifiedWithdrawalRow }) {
  return (
    <div className="flex flex-wrap gap-1.5" role="list" aria-label="What is still missing">
      {missingPieces(row).map((m) => (
        <span
          key={m}
          role="listitem"
          className="inline-flex items-center gap-1 rounded-full border border-primary/25 bg-primary/10 px-2.5 py-1 text-xs font-medium text-primary"
        >
          <AlertTriangle className="h-3 w-3" aria-hidden />
          {m}
        </span>
      ))}
    </div>
  );
}

const shortId = (id: string) => `#${id.replace(/-/g, '').slice(0, 8).toUpperCase()}`;
const when = (iso: string) =>
  new Date(iso).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

/** Colourblind-friendly outcome badge: icon + plain words, never colour alone. */
function StatusBadge({ badge }: { badge: UnverifiedWithdrawalRow['badge'] }) {
  const label = badgeLabel(badge);
  const Icon = badge === 'verified' ? BadgeCheck : badge === 'needs_review' ? AlertTriangle : Clock;
  const tone =
    badge === 'verified'
      ? 'border-primary/30 bg-primary/10 text-primary'
      : badge === 'needs_review'
        ? 'border-primary/20 bg-primary/5 text-foreground'
        : 'border-border bg-muted/40 text-muted-foreground';
  return (
    <Badge variant="outline" className={`gap-1 ${tone}`} role="status" aria-label={`Status: ${label}`}>
      <Icon className="h-3 w-3" aria-hidden />
      {label}
    </Badge>
  );
}

function Row({ row }: { row: UnverifiedWithdrawalRow }) {
  const call = telHref(row.phone ?? row.mobile_money_number);
  return (
    <li className="rounded-2xl border bg-card p-4 shadow-sm">
      <div className="flex items-start gap-3">
        <Avatar className="h-11 w-11 shrink-0">
          <AvatarImage src={row.avatar_url ?? undefined} alt="" />
          <AvatarFallback>{(row.full_name ?? '?').slice(0, 1).toUpperCase()}</AvatarFallback>
        </Avatar>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <p className="truncate text-base font-semibold">{row.full_name ?? 'Unknown user'}</p>
            <StatusBadge badge={row.badge} />
            <Badge
              variant="outline"
              className="gap-1 border-sky-500/40 bg-sky-500/10 text-sky-700 dark:text-sky-400"
              role="status"
              aria-label="Hidden from merchant agents"
            >
              <EyeOff className="h-3 w-3" aria-hidden />
              Hidden from merchants
            </Badge>
          </div>
          <p className="mt-0.5 flex items-center gap-1.5 text-sm text-muted-foreground">
            {row.payout_method === 'bank_transfer' ? (
              <Banknote className="h-3.5 w-3.5" aria-hidden />
            ) : (
              <Smartphone className="h-3.5 w-3.5" aria-hidden />
            )}
            {destinationLine(row)}
          </p>
          <div className="mt-2">
            <MissingChips row={row} />
          </div>
          <div className="mt-3 flex items-center justify-between gap-2">
            <p className="text-lg font-bold tabular-nums">{formatUGX(row.amount)}</p>
            {call ? (
              <Button asChild size="sm" className="min-h-[40px] gap-1.5">
                <a href={call} aria-label={`Call ${row.full_name ?? 'the user'}`}>
                  <Phone className="h-4 w-4" aria-hidden />
                  Call
                </a>
              </Button>
            ) : null}
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            Requested {new Date(row.created_at).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}
            {' · '}status {row.status.replace(/_/g, ' ')}
          </p>
        </div>
      </div>
    </li>
  );
}

const FILTER_OPTIONS: { value: UnverifiedBadgeFilter; label: string }[] = [
  { value: 'all', label: 'All statuses' },
  { value: 'pending', label: 'Pending' },
  { value: 'needs_review', label: 'Needs review' },
  { value: 'verified', label: 'Verified' },
];

const SORT_OPTIONS: { value: UnverifiedSort; label: string }[] = [
  { value: 'newest', label: 'Newest first' },
  { value: 'oldest', label: 'Oldest first' },
  { value: 'biggest', label: 'Biggest amount' },
  { value: 'smallest', label: 'Smallest amount' },
];

const selectCls =
  'h-11 rounded-xl border bg-background px-3 text-sm font-medium outline-none focus-visible:ring-2 focus-visible:ring-primary min-w-0';

export default function UnverifiedWithdrawalsPanel() {
  const navigate = useNavigate();
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(0);
  const [filter, setFilter] = useState<UnverifiedBadgeFilter>('all');
  const [sort, setSort] = useState<UnverifiedSort>('newest');
  const { data, isLoading, isError, error } = useUnverifiedWithdrawals(search, page, filter, sort);
  const counts = useUnverifiedWithdrawalCounts();
  const rows = data?.rows ?? [];
  const total = data?.total ?? 0;
  const pick = (f: UnverifiedBadgeFilter) => { setFilter(f); setPage(0); };
  const review = () => navigate(finopsPath('payout_verification'));

  return (
    <section className="space-y-5" aria-labelledby="unverified-withdrawals-title">
      <PageHeader
        titleId="unverified-withdrawals-title"
        icon={ShieldAlert}
        tone="amber"
        title="Withdrawals waiting on ID verification"
        description={
          <>
            These people asked to withdraw but have not finished identity checks, so merchant agents cannot
            see or pay their requests. Call each person, help them submit their National ID and selfie, then
            verify them in <strong>Verify Payout Numbers</strong>. Their request appears for merchant agents
            automatically afterwards.
          </>
        }
      />

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <StatTile icon={Users} tone="primary" label="All" value={counts.data?.all ?? '—'} note="Total unverified"
          active={filter === 'all'} onClick={() => pick('all')} />
        <StatTile icon={Clock} tone="amber" label="Pending" value={counts.data?.pending ?? '—'} note="Awaiting ID check"
          active={filter === 'pending'} onClick={() => pick('pending')} />
        <StatTile icon={AlertTriangle} tone="rose" label="Needs review" value={counts.data?.needs_review ?? '—'} note="Name mismatch"
          active={filter === 'needs_review'} onClick={() => pick('needs_review')} />
        <StatTile icon={CheckCircle2} tone="emerald" label="Verified" value={counts.data?.verified ?? '—'} note="ID confirmed"
          active={filter === 'verified'} onClick={() => pick('verified')} />
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <div className="relative flex-1 min-w-[14rem]">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
          <Input
            value={search}
            onChange={(e) => { setSearch(e.target.value); setPage(0); }}
            placeholder="Search by name, phone or payout number"
            className="pl-9 pr-9 h-11 rounded-xl"
            aria-label="Search unverified withdrawals"
          />
          {search ? (
            <button
              type="button"
              onClick={() => { setSearch(''); setPage(0); }}
              className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground"
              aria-label="Clear search"
            >
              <X className="h-4 w-4" aria-hidden />
            </button>
          ) : null}
        </div>
        <select value={filter} onChange={(e) => pick(e.target.value as UnverifiedBadgeFilter)} className={selectCls} aria-label="Filter by status">
          {FILTER_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
        <select
          value={sort}
          onChange={(e) => { setSort(e.target.value as UnverifiedSort); setPage(0); }}
          className={selectCls}
          aria-label="Sort payouts"
        >
          {SORT_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      </div>

      {isLoading ? (
        <div className="space-y-3" aria-busy="true">
          {[0, 1, 2].map((i) => <Skeleton key={i} className="h-16 w-full rounded-2xl" />)}
        </div>
      ) : isError ? (
        <p role="alert" className="rounded-xl border border-destructive/40 bg-destructive/10 p-4 text-sm">
          Could not load this list. {(error as Error)?.message ?? ''}
        </p>
      ) : total === 0 ? (
        <p className="flex items-center gap-2 rounded-xl border border-primary/30 bg-primary/5 p-4 text-sm">
          <CheckCircle2 className="h-4 w-4 text-primary" aria-hidden />
          {filter === 'all'
            ? 'Nothing here — every open withdrawal belongs to a verified person.'
            : filter === 'verified'
              ? 'No verified payouts are open right now.'
              : `No payouts currently marked ${badgeLabel(filter === 'needs_review' ? 'needs_review' : 'pending').toLowerCase()}.`}
        </p>
      ) : (
        <div className="rounded-2xl border bg-card shadow-2xs overflow-hidden">
          {/* Tablet and desktop: a table */}
          <div className="hidden md:block overflow-x-auto">
            <table className="w-full min-w-[820px] border-collapse text-sm">
              <thead>
                <tr className="text-left text-xs font-semibold text-muted-foreground">
                  <th className="px-4 py-3">Payout #</th>
                  <th className="px-2 py-3">User</th>
                  <th className="px-2 py-3">Phone</th>
                  <th className="px-2 py-3 text-right">Amount (UGX)</th>
                  <th className="px-2 py-3">Requested</th>
                  <th className="px-2 py-3">Verification</th>
                  <th className="px-4 py-3">Actions</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const call = telHref(r.phone ?? r.mobile_money_number);
                  return (
                    <tr key={r.id} className="border-t align-top">
                      <td className="px-4 py-3.5 font-mono text-xs whitespace-nowrap">{shortId(r.id)}</td>
                      <td className="px-2 py-3.5 max-w-[260px]">
                        <div className="flex items-start gap-2.5">
                          <Avatar className="h-8 w-8 shrink-0">
                            <AvatarImage src={r.avatar_url ?? undefined} alt="" />
                            <AvatarFallback>{(r.full_name ?? '?').slice(0, 1).toUpperCase()}</AvatarFallback>
                          </Avatar>
                          <div className="min-w-0">
                            <p className="truncate font-semibold">{r.full_name ?? 'Unknown user'}</p>
                            <p className="flex items-center gap-1 text-xs text-muted-foreground truncate">
                              {r.payout_method === 'bank_transfer'
                                ? <Banknote className="h-3 w-3 shrink-0" aria-hidden />
                                : <Smartphone className="h-3 w-3 shrink-0" aria-hidden />}
                              {destinationLine(r)}
                            </p>
                            <p className="mt-1 text-[11px] text-primary font-medium">
                              Missing: {missingPieces(r).join(', ') || 'nothing'}
                            </p>
                          </div>
                        </div>
                      </td>
                      <td className="px-2 py-3.5 whitespace-nowrap">{r.phone ?? r.mobile_money_number ?? '—'}</td>
                      <td className="px-2 py-3.5 text-right font-semibold tabular-nums whitespace-nowrap">{formatUGX(r.amount)}</td>
                      <td className="px-2 py-3.5 whitespace-nowrap text-muted-foreground">{when(r.created_at)}</td>
                      <td className="px-2 py-3.5"><StatusBadge badge={r.badge} /></td>
                      <td className="px-4 py-3.5">
                        <div className="flex items-center gap-2">
                          {call && (
                            <Button asChild size="sm" className="min-h-[36px] gap-1.5">
                              <a href={call} aria-label={`Call ${r.full_name ?? 'the user'}`}>
                                <Phone className="h-4 w-4" aria-hidden /> Call
                              </a>
                            </Button>
                          )}
                          <Button variant="outline" size="sm" className="min-h-[36px]" onClick={review}>Review</Button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {/* Phone: one card per request */}
          <ul className="md:hidden space-y-3 p-3">
            {rows.map((r) => <Row key={r.id} row={r} />)}
          </ul>

          <div className="border-t px-4 py-3">
            <Pager page={page} pageSize={UNVERIFIED_WITHDRAWALS_PAGE_SIZE} total={total} onPage={setPage} noun="results" />
          </div>
        </div>
      )}
    </section>
  );
}
