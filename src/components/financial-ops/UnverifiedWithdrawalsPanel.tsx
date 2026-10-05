import { useState } from 'react';
import { formatUGX } from '@/lib/rentCalculations';
import {
  UNVERIFIED_WITHDRAWALS_PAGE_SIZE,
  badgeLabel,
  missingPieces,
  useUnverifiedWithdrawals,
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
  ArrowUpDown,
  Banknote,
  BadgeCheck,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Clock,
  EyeOff,
  Phone,
  Search,
  ShieldAlert,
  Smartphone,
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
          className="inline-flex items-center gap-1 rounded-full border border-amber-500/40 bg-amber-500/10 px-2.5 py-1 text-xs font-medium text-amber-700 dark:text-amber-400"
        >
          <AlertTriangle className="h-3 w-3" aria-hidden />
          {m}
        </span>
      ))}
    </div>
  );
}

/** Colourblind-friendly outcome badge: icon + plain words, never colour alone. */
function StatusBadge({ badge }: { badge: UnverifiedWithdrawalRow['badge'] }) {
  const label = badgeLabel(badge);
  const Icon = badge === 'verified' ? BadgeCheck : badge === 'needs_review' ? AlertTriangle : Clock;
  const tone =
    badge === 'verified'
      ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400'
      : badge === 'needs_review'
        ? 'border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-400'
        : 'border-sky-500/40 bg-sky-500/10 text-sky-700 dark:text-sky-400';
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
  { value: 'all', label: 'All' },
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

export default function UnverifiedWithdrawalsPanel() {
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(0);
  const [filter, setFilter] = useState<UnverifiedBadgeFilter>('all');
  const [sort, setSort] = useState<UnverifiedSort>('newest');
  const { data, isLoading, isError, error } = useUnverifiedWithdrawals(search, page, filter, sort);
  const rows = data?.rows ?? [];
  const total = data?.total ?? 0;
  const pageCount = Math.max(1, Math.ceil(total / UNVERIFIED_WITHDRAWALS_PAGE_SIZE));

  return (
    <section className="space-y-4" aria-labelledby="unverified-withdrawals-title">
      <header className="rounded-2xl border border-amber-500/30 bg-amber-500/5 p-4">
        <h2 id="unverified-withdrawals-title" className="flex items-center gap-2 text-lg font-bold">
          <ShieldAlert className="h-5 w-5 text-amber-600" aria-hidden />
          Withdrawals waiting on ID verification
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          These people asked to withdraw but have not finished identity checks, so merchant
          agents cannot see or pay their requests. Call each person, help them submit their
          National ID and selfie, then verify them in <strong>Verify Payout Numbers</strong> —
          their request appears for merchant agents automatically afterwards.
        </p>
      </header>

      <div className="relative">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
        <Input
          value={search}
          onChange={(e) => { setSearch(e.target.value); setPage(0); }}
          placeholder="Search by name, phone or payout number"
          className="pl-9 pr-9 min-h-[44px]"
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

      <div className="flex flex-wrap items-center gap-2">
        <div className="flex flex-wrap gap-2" role="group" aria-label="Filter by status">
          {FILTER_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              type="button"
              aria-pressed={filter === opt.value}
              onClick={() => { setFilter(opt.value); setPage(0); }}
              className={`min-h-[40px] rounded-full border px-4 text-sm font-medium transition-colors ${
                filter === opt.value
                  ? 'border-primary bg-primary text-primary-foreground'
                  : 'bg-background text-foreground hover:bg-muted'
              }`}
            >
              {opt.label}
            </button>
          ))}
        </div>
        <label className="ml-auto flex min-h-[40px] items-center gap-2 rounded-full border bg-background px-3 text-sm">
          <ArrowUpDown className="h-4 w-4 text-muted-foreground" aria-hidden />
          <span className="sr-only">Sort payouts</span>
          <select
            value={sort}
            onChange={(e) => { setSort(e.target.value as UnverifiedSort); setPage(0); }}
            className="bg-transparent text-sm font-medium outline-none"
            aria-label="Sort payouts"
          >
            {SORT_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>{opt.label}</option>
            ))}
          </select>
        </label>
      </div>

      {isLoading ? (
        <div className="space-y-3" aria-busy="true">
          {[0, 1, 2].map((i) => <Skeleton key={i} className="h-28 w-full rounded-2xl" />)}
        </div>
      ) : isError ? (
        <p role="alert" className="rounded-xl border border-destructive/40 bg-destructive/10 p-4 text-sm">
          Could not load this list. {(error as Error)?.message ?? ''}
        </p>
      ) : total === 0 ? (
        <p className="flex items-center gap-2 rounded-xl border border-emerald-500/30 bg-emerald-500/5 p-4 text-sm">
          <CheckCircle2 className="h-4 w-4 text-emerald-600" aria-hidden />
          {filter === 'all'
            ? 'Nothing here — every open withdrawal belongs to a verified person.'
            : filter === 'verified'
              ? 'No verified payouts are open right now.'
              : `No payouts currently marked ${badgeLabel(filter === 'needs_review' ? 'needs_review' : 'pending').toLowerCase()}.`}
        </p>
      ) : (
        <>
          <p className="text-sm text-muted-foreground" role="status">
            {total} request{total === 1 ? '' : 's'}
            {filter === 'all' ? ' waiting on verification' : ` marked ${badgeLabel(filter === 'needs_review' ? 'needs_review' : filter).toLowerCase()}`}
          </p>
          <ul className="space-y-3">
            {rows.map((r) => <Row key={r.id} row={r} />)}
          </ul>
          {pageCount > 1 ? (
            <nav className="flex items-center justify-between" aria-label="Pages">
              <Button
                variant="outline"
                size="sm"
                disabled={page === 0}
                onClick={() => setPage((p) => Math.max(0, p - 1))}
                className="min-h-[40px] gap-1"
              >
                <ChevronLeft className="h-4 w-4" aria-hidden /> Newer
              </Button>
              <span className="text-sm text-muted-foreground">Page {page + 1} of {pageCount}</span>
              <Button
                variant="outline"
                size="sm"
                disabled={page >= pageCount - 1}
                onClick={() => setPage((p) => p + 1)}
                className="min-h-[40px] gap-1"
              >
                Older <ChevronRight className="h-4 w-4" aria-hidden />
              </Button>
            </nav>
          ) : null}
        </>
      )}
    </section>
  );
}
