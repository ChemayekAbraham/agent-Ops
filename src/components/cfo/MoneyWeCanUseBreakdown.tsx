import { useCallback, useEffect, useRef, useState } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import {
  ChevronDown,
  Loader2,
  ArrowDownLeft,
  ArrowUpRight,
  AlertTriangle,
  Smartphone,
  Landmark,
  Banknote,
} from 'lucide-react';
import { useActualMoneyHeld } from '@/hooks/useActualMoneyHeld';
import {
  useBayoMercyMovements,
  useMerchantAgentMovementsPage,
  useUnregisteredRecipientTransfersPage,
  useUnregisteredRecipientTransfersSummary,
} from '@/hooks/useMerchantAgentMovements';

const fmt = (n: number) =>
  `${n < 0 ? '-' : ''}UGX ${new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }).format(Math.abs(n))}`;

const day = (v: string | null) =>
  v
    ? new Date(v).toLocaleString('en-GB', {
        timeZone: 'Africa/Kampala',
        day: '2-digit',
        month: 'short',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      })
    : '—';

const channelLabel = (c: string) =>
  c === 'mtn_momo' ? 'MTN' : c === 'airtel_money' ? 'Airtel' : c || 'Line';

const PAGE_SIZE = 25;

/** Server-paged list: asks the database for the next cursor page on scroll. */
function CursorPaged<T>({
  items,
  renderItem,
  label,
  hasNextPage,
  isFetchingNextPage,
  fetchNextPage,
}: {
  items: T[];
  renderItem: (item: T, index: number) => React.ReactNode;
  label: string;
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
  fetchNextPage: () => void;
}) {
  const sentinelRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const node = sentinelRef.current;
    if (!node || !hasNextPage) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting) && !isFetchingNextPage) fetchNextPage();
      },
      { rootMargin: '120px' },
    );
    io.observe(node);
    return () => io.disconnect();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);

  return (
    <div>
      {items.map((item, i) => renderItem(item, i))}
      {hasNextPage && (
        <div ref={sentinelRef} className="flex flex-col items-center gap-1 py-3">
          <button
            type="button"
            onClick={() => fetchNextPage()}
            disabled={isFetchingNextPage}
            className="rounded-md border border-border px-3 py-1 text-[11px] font-medium hover:bg-muted/50 disabled:opacity-60"
          >
            {isFetchingNextPage ? 'Loading…' : `Load more ${label}`}
          </button>
          <p className="text-[10px] text-muted-foreground">Loaded {items.length} so far</p>
        </div>
      )}
    </div>
  );
}

/** Renders a slice of a long list and grows it as the reader reaches the end. */
function Paged<T>({
  items,
  renderItem,
  label,
}: {
  items: T[];
  renderItem: (item: T, index: number) => React.ReactNode;
  label: string;
}) {
  const [count, setCount] = useState(PAGE_SIZE);
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const total = items.length;

  useEffect(() => setCount(PAGE_SIZE), [total]);

  const showMore = useCallback(
    () => setCount((c) => Math.min(c + PAGE_SIZE, total)),
    [total],
  );

  useEffect(() => {
    const node = sentinelRef.current;
    if (!node || count >= total) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) showMore();
      },
      { rootMargin: '120px' },
    );
    io.observe(node);
    return () => io.disconnect();
  }, [count, total, showMore]);

  return (
    <>
      {(count >= total ? items : items.slice(0, count)).map((item, i) => renderItem(item, i))}
      {count < total && (
        <div ref={sentinelRef} className="flex flex-col items-center gap-1 py-3">
          <button
            type="button"
            onClick={showMore}
            className="rounded-md border border-border px-3 py-1 text-[11px] font-medium hover:bg-muted/50"
          >
            Show more {label}
          </button>
          <p className="text-[10px] text-muted-foreground">
            Showing {Math.min(count, total)} of {total}
          </p>
        </div>
      )}
    </>
  );
}

function Group({
  icon,
  title,
  note,
  total,
  totalTone,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  note: string;
  total: string;
  totalTone: string;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded-xl border border-border">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-start justify-between gap-3 p-3 text-left transition-colors hover:bg-muted/40"
      >
        <div className="flex min-w-0 items-start gap-2">
          <span className="mt-0.5 shrink-0">{icon}</span>
          <div className="min-w-0">
            <p className="truncate text-xs font-semibold">{title}</p>
            <p className="text-[10px] leading-relaxed text-muted-foreground">{note}</p>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <p className={`font-mono text-xs font-bold tabular-nums ${totalTone}`}>{total}</p>
          <ChevronDown
            className={`h-4 w-4 text-muted-foreground transition-transform ${open ? 'rotate-180' : ''}`}
          />
        </div>
      </button>
      {open && <div className="border-t border-border bg-muted/20 px-3 py-2">{children}</div>}
    </div>
  );
}

function Row({
  direction,
  amount,
  at,
  party,
  reference,
  note,
  tag,
}: {
  direction: 'in' | 'out';
  amount: number;
  at: string | null;
  party: string | null;
  reference: string | null;
  note: string | null;
  tag?: string | null;
}) {
  const out = direction === 'out';
  return (
    <div className="flex items-start gap-3 border-t border-border/60 py-2 first:border-t-0">
      <div
        className={`mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full ${
          out ? 'bg-orange-500/10 text-orange-600' : 'bg-emerald-500/10 text-emerald-600'
        }`}
      >
        {out ? <ArrowUpRight className="h-3.5 w-3.5" /> : <ArrowDownLeft className="h-3.5 w-3.5" />}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between gap-2">
          <p className="truncate text-xs font-medium">
            {out ? 'Sent out' : 'Came in'}
            {party ? ` · ${party}` : ''}
          </p>
          <p
            className={`shrink-0 font-mono text-xs font-bold tabular-nums ${
              out ? 'text-orange-600' : 'text-emerald-600'
            }`}
          >
            {out ? '-' : '+'}
            {fmt(amount)}
          </p>
        </div>
        <p className="mt-0.5 text-[10px] text-muted-foreground">
          {day(at)}
          {tag ? ` · ${tag}` : ''}
          {reference ? ` · Ref ${reference}` : ''}
        </p>
        {note ? <p className="mt-0.5 line-clamp-2 text-[10px] text-muted-foreground/80">{note}</p> : null}
      </div>
    </div>
  );
}

const Spinner = () => (
  <div className="flex justify-center py-4">
    <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
  </div>
);

/**
 * Expandable reconciliation detail under the Money We Can Use card: exactly what
 * counts toward Money We Have, what counts toward Money We Owe, and the flagged
 * transfers that are deliberately excluded from both. Read-only throughout — the
 * same live sources the cards themselves use, so figures cannot disagree.
 */
export function MoneyWeCanUseBreakdown() {
  const [open, setOpen] = useState(false);
  const { data: money, isLoading: moneyLoading } = useActualMoneyHeld();
  const {
    data: merchantPages,
    isLoading: merchantLoading,
    hasNextPage: merchantHasNext,
    isFetchingNextPage: merchantFetchingNext,
    fetchNextPage: merchantFetchNext,
  } = useMerchantAgentMovementsPage(null, open, PAGE_SIZE);
  const { data: bayoMoves, isLoading: bayoLoading } = useBayoMercyMovements(open);
  const flaggedSummary = useUnregisteredRecipientTransfersSummary(open);
  const {
    data: flaggedPages,
    isLoading: flagLoading,
    hasNextPage: flagHasNext,
    isFetchingNextPage: flagFetchingNext,
    fetchNextPage: flagFetchNext,
  } = useUnregisteredRecipientTransfersPage(open, 120, PAGE_SIZE);

  const haveLines = [
    {
      label: 'MTN Mobile Money line balance',
      value: money?.mtn ?? 0,
      note: 'Live balance from the latest MTN provider alert.',
    },
    {
      label: 'Airtel Money line balance',
      value: money?.airtel ?? 0,
      note: 'Live balance from the latest Airtel provider alert.',
    },
    {
      label: 'Cash in Custody — Not Yet Confirmed Banked (excluded)',
      value: money?.custodyNotConfirmedBanked ?? 0,
      note: 'Cash collected and verified but with no verified banking event, so it is not counted as company cash.',
    },

    {
      label: 'Cash at bank (marked banked)',
      value: money?.bankedCash ?? 0,
      note: `${money?.bankedCashCount ?? 0} verified deposit(s) marked banked by Financial Ops.`,
    },
  ];

  const merchantMoves = (merchantPages?.pages ?? []).flat();
  const flaggedRows = (flaggedPages?.pages ?? []).flat();
  const merchantOut = merchantMoves.filter((m) => m.direction === 'out');
  const merchantIn = merchantMoves.filter((m) => m.direction === 'in');

  return (
    <Card className="border-border/60">
      <CardContent className="p-4">
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          className="flex w-full items-center justify-between gap-3 text-left"
        >
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold">What is behind Money We Can Use</p>
            <p className="text-[11px] text-muted-foreground">
              Every transaction counting toward Money We Have and Money We Owe, plus the flagged
              transfers left out of both.
            </p>
          </div>
          <ChevronDown
            className={`h-4 w-4 shrink-0 text-muted-foreground transition-transform ${
              open ? 'rotate-180' : ''
            }`}
          />
        </button>

        {open && (
          <div className="mt-4 space-y-3">
            <Group
              icon={<Banknote className="h-4 w-4 text-emerald-600" />}
              title="Counts toward Money We Have"
              note="Provider line balances plus verified cash, banked and unbanked."
              total={fmt(money?.total ?? 0)}
              totalTone="text-emerald-600"
            >
              {moneyLoading ? (
                <Spinner />
              ) : (
                <div>
                  {haveLines.map((l) => (
                    <div
                      key={l.label}
                      className="flex items-start justify-between gap-3 border-t border-border/60 py-2 first:border-t-0"
                    >
                      <div className="min-w-0">
                        <p className="truncate text-xs font-medium">{l.label}</p>
                        <p className="text-[10px] text-muted-foreground">{l.note}</p>
                      </div>
                      <p className="shrink-0 font-mono text-xs font-bold tabular-nums text-emerald-600">
                        {fmt(l.value)}
                      </p>
                    </div>
                  ))}
                  <p className="mt-2 text-[10px] text-muted-foreground">
                    The email-derived bank reconciliation figure ({fmt(money?.bankReconciliation ?? 0)})
                    is a reference comparison only and is never added here.
                  </p>
                </div>
              )}
            </Group>

            <Group
              icon={<Smartphone className="h-4 w-4 text-orange-600" />}
              title="Counts toward Money We Owe · merchant agents"
              note="Every matched transfer out to a merchant agent number, and what they sent back."
              total={`${merchantOut.length} out · ${merchantIn.length} back${merchantHasNext ? '+' : ''}`}
              totalTone="text-orange-600"
            >
              {merchantLoading ? (
                <Spinner />
              ) : merchantMoves.length === 0 ? (
                <p className="py-3 text-[11px] text-muted-foreground">
                  No matched merchant agent transfers in the extracted emails.
                </p>
              ) : (
                <div className="max-h-80 overflow-y-auto pr-1">
                  <CursorPaged
                    hasNextPage={!!merchantHasNext}
                    isFetchingNextPage={merchantFetchingNext}
                    fetchNextPage={merchantFetchNext}
                    items={merchantMoves}
                    label="transfers"
                    renderItem={(m) => (
                      <Row
                        key={`${m.id}-${m.desk_id}`}
                        direction={m.direction}
                        amount={m.amount}
                        at={m.at}
                        party={m.agent_name || m.counterparty}
                        reference={m.transaction_id}
                        note={m.snippet}
                        tag={channelLabel(m.channel)}
                      />
                    )}
                  />
                </div>
              )}
            </Group>

            <Group
              icon={<Landmark className="h-4 w-4 text-sky-600" />}
              title="Counts toward Money We Owe · Bayo Mercy bank account"
              note="Bank email movements on the account since the reconciliation reset."
              total={`${(bayoMoves ?? []).length} movement(s)`}
              totalTone="text-orange-600"
            >
              {bayoLoading ? (
                <Spinner />
              ) : (bayoMoves ?? []).length === 0 ? (
                <p className="py-3 text-[11px] text-muted-foreground">
                  No qualifying bank movements in the extracted emails.
                </p>
              ) : (
                <div className="max-h-80 overflow-y-auto pr-1">
                  <Paged
                    items={bayoMoves ?? []}
                    label="movements"
                    renderItem={(r) => (
                      <Row
                        key={r.id}
                        direction={r.direction}
                        amount={r.amount}
                        at={r.at}
                        party={r.counterparty}
                        reference={r.transaction_id}
                        note={r.note}
                        tag="Bank"
                      />
                    )}
                  />
                </div>
              )}
            </Group>

            <Group
              icon={<AlertTriangle className="h-4 w-4 text-amber-600" />}
              title="Excluded from both sides · flagged transfers"
              note="Money-out transfers whose receiver is not an active merchant agent. Review only."
              total={fmt(flaggedSummary.data?.total ?? 0)}
              totalTone="text-amber-700 dark:text-amber-300"
            >
              {flagLoading ? (
                <Spinner />
              ) : flaggedRows.length === 0 ? (
                <p className="py-3 text-[11px] text-muted-foreground">
                  Every money-out transfer went to a registered merchant agent.
                </p>
              ) : (
                <div className="max-h-80 overflow-y-auto pr-1">
                  <CursorPaged
                    hasNextPage={!!flagHasNext}
                    isFetchingNextPage={flagFetchingNext}
                    fetchNextPage={flagFetchNext}
                    items={flaggedRows}
                    label="flagged transfers"
                    renderItem={(t) => (
                      <div key={t.id} className="border-t border-border/60 py-2 first:border-t-0">
                        <div className="flex items-baseline justify-between gap-2">
                          <p className="truncate text-xs font-medium">
                            {t.profile_name || t.counterparty || t.recipient_phone || 'Unknown recipient'}
                          </p>
                          <p className="shrink-0 font-mono text-xs font-bold tabular-nums text-amber-700 dark:text-amber-300">
                            -{fmt(t.amount)}
                          </p>
                        </div>
                        <p className="mt-0.5 text-[10px] text-muted-foreground">
                          {day(t.at)} · {channelLabel(t.channel)}
                          {t.transaction_id ? ` · Ref ${t.transaction_id}` : ''}
                        </p>
                        <p className="mt-1 text-[10px] text-amber-800 dark:text-amber-300">
                          <span className="font-semibold">Left out because: </span>
                          {t.reason || 'Could not be matched to an active merchant agent desk.'}
                        </p>
                        <div className="mt-1 flex flex-wrap gap-1">
                          <Badge variant="outline" className="text-[9px]">
                            {t.recipient_phone || 'No number'}
                          </Badge>
                          {t.profile_email && (
                            <Badge variant="outline" className="text-[9px]">
                              {t.profile_email}
                            </Badge>
                          )}
                        </div>
                      </div>
                    )}
                  />
                </div>
              )}
            </Group>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
