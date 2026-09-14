import { useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import {
  ShieldAlert,
  Search,
  X,
  ChevronLeft,
  ChevronRight,
  RefreshCw,
  MailWarning,
} from 'lucide-react';
import {
  useFakeAccountCounts,
  useFakeAccountList,
  FAKE_ACCOUNT_PAGE_SIZE,
  FAKE_ACCOUNT_SIGNAL_LABELS,
  riskBand,
  type FakeAccountSignal,
} from '@/hooks/useFakeAccountRadar';

const SIGNAL_ORDER: FakeAccountSignal[] = [
  'unverified_email',
  'disposable_email',
  'duplicate_phone',
  'duplicate_national_id',
  'duplicate_name',
  'suspicious_name',
  'dormant',
  'burst_signup',
];

function fmt(n: number | undefined) {
  return typeof n === 'number' ? n.toLocaleString() : '—';
}

function when(iso: string | null) {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  });
}

export function FakeAccountRadarPanel() {
  const [signal, setSignal] = useState<FakeAccountSignal | 'all'>('all');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(0);

  const counts = useFakeAccountCounts();
  const list = useFakeAccountList({ signal, search, page });

  const total = list.data?.total ?? 0;
  const fromRow = total === 0 ? 0 : page * FAKE_ACCOUNT_PAGE_SIZE + 1;
  const toRow = Math.min(total, (page + 1) * FAKE_ACCOUNT_PAGE_SIZE);

  const setFilter = (next: FakeAccountSignal | 'all') => {
    setSignal(next);
    setPage(0);
  };

  return (
    <Card className="border-2 border-destructive/40 bg-destructive/5">
      <CardHeader className="pb-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle className="flex items-center gap-2 text-base sm:text-lg">
            <ShieldAlert className="h-5 w-5 text-destructive" />
            Potential fake accounts
          </CardTitle>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              counts.refetch();
              list.refetch();
            }}
            disabled={counts.isFetching || list.isFetching}
          >
            <RefreshCw
              className={`mr-2 h-4 w-4 ${counts.isFetching || list.isFetching ? 'animate-spin' : ''}`}
            />
            Rescan
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          Every account is checked against eight fraud signals. Email confirmation is now required
          for anyone who signs up with an email address.
        </p>
      </CardHeader>

      <CardContent className="space-y-4">
        {/* Headline numbers */}
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {[
            { label: 'Flagged accounts', value: counts.data?.flagged, tone: 'text-destructive' },
            { label: 'High risk', value: counts.data?.high_risk, tone: 'text-destructive' },
            {
              label: 'Email never confirmed',
              value: counts.data?.unverified_email,
              tone: 'text-amber-600',
            },
            { label: 'Accounts checked', value: counts.data?.total_accounts, tone: '' },
          ].map((k) => (
            <div key={k.label} className="rounded-lg border bg-background p-3">
              <p className="text-[11px] uppercase tracking-wide text-muted-foreground">{k.label}</p>
              {counts.isLoading ? (
                <Skeleton className="mt-2 h-6 w-16" />
              ) : (
                <p className={`text-xl font-bold ${k.tone}`}>{fmt(k.value)}</p>
              )}
            </div>
          ))}
        </div>

        {/* Signal filters */}
        <div className="flex flex-wrap gap-2">
          <Badge
            role="button"
            variant={signal === 'all' ? 'default' : 'outline'}
            className="cursor-pointer"
            onClick={() => setFilter('all')}
          >
            All signals ({fmt(counts.data?.flagged)})
          </Badge>
          {SIGNAL_ORDER.map((s) => (
            <Badge
              key={s}
              role="button"
              variant={signal === s ? 'default' : 'outline'}
              className="cursor-pointer"
              onClick={() => setFilter(s)}
            >
              {FAKE_ACCOUNT_SIGNAL_LABELS[s]} ({fmt(counts.data?.[s])})
            </Badge>
          ))}
        </div>

        {/* Search */}
        <div className="relative">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setPage(0);
            }}
            placeholder="Search name, email, phone or National ID"
            className="pl-9 pr-9"
          />
          {search && (
            <button
              type="button"
              onClick={() => {
                setSearch('');
                setPage(0);
              }}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground"
              aria-label="Clear search"
            >
              <X className="h-4 w-4" />
            </button>
          )}
        </div>

        {/* List */}
        {list.isLoading ? (
          <div className="space-y-2">
            {[0, 1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-20 w-full" />
            ))}
          </div>
        ) : list.error ? (
          <p className="rounded-lg border border-destructive/40 p-3 text-sm text-destructive">
            Could not load the fake-account list. You may not have access to this screen.
          </p>
        ) : (list.data?.rows.length ?? 0) === 0 ? (
          <p className="rounded-lg border p-4 text-center text-sm text-muted-foreground">
            No accounts match this filter.
          </p>
        ) : (
          <div className="space-y-2">
            {list.data!.rows.map((r) => {
              const band = riskBand(r.risk_score);
              return (
                <div
                  key={r.user_id}
                  className="rounded-lg border bg-background p-3 text-sm"
                >
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="truncate font-semibold">
                        {r.full_name?.trim() || 'No name given'}
                      </p>
                      <p className="truncate text-xs text-muted-foreground">
                        {r.is_synthetic ? 'Phone-only account' : r.auth_email || 'No email'}
                        {r.phone ? ` · ${r.phone}` : ''}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        Joined {when(r.created_at)}
                        {r.national_id ? ` · ID ${r.national_id}` : ''}
                      </p>
                    </div>
                    <Badge
                      variant={band === 'high' ? 'destructive' : 'outline'}
                      className={band === 'medium' ? 'border-amber-500 text-amber-600' : ''}
                    >
                      Risk {r.risk_score}
                    </Badge>
                  </div>

                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {!r.email_confirmed && !r.is_synthetic && (
                      <Badge className="gap-1 bg-amber-500/15 text-amber-600" variant="secondary">
                        <MailWarning className="h-3 w-3" />
                        Email not confirmed
                      </Badge>
                    )}
                    {r.signals.map((s) => (
                      <Badge key={s} variant="outline" className="text-[11px]">
                        {FAKE_ACCOUNT_SIGNAL_LABELS[s]}
                      </Badge>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {/* Pagination */}
        {total > FAKE_ACCOUNT_PAGE_SIZE && (
          <div className="flex items-center justify-between gap-2">
            <p className="text-xs text-muted-foreground">
              Showing {fmt(fromRow)}–{fmt(toRow)} of {fmt(total)}
            </p>
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="icon"
                onClick={() => setPage((p) => Math.max(0, p - 1))}
                disabled={page === 0}
                aria-label="Previous page"
              >
                <ChevronLeft className="h-4 w-4" />
              </Button>
              <span className="text-xs text-muted-foreground">
                {page + 1} / {Math.max(1, Math.ceil(total / FAKE_ACCOUNT_PAGE_SIZE))}
              </span>
              <Button
                variant="outline"
                size="icon"
                onClick={() => setPage((p) => p + 1)}
                disabled={toRow >= total}
                aria-label="Next page"
              >
                <ChevronRight className="h-4 w-4" />
              </Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export default FakeAccountRadarPanel;
