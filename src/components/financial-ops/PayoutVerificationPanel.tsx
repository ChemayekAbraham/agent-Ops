import { useMemo, useState } from 'react';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Textarea } from '@/components/ui/textarea';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import {
  BadgeCheck,
  Building2,
  ChevronLeft,
  ChevronRight,
  Phone,
  Search,
  ShieldAlert,
  Smartphone,
} from 'lucide-react';
import { toast } from 'sonner';
import {
  PAYOUT_VERIFICATION_PAGE_SIZE,
  useDecidePayoutDestination,
  usePayoutVerificationCounts,
  usePayoutVerificationQueue,
  type PayoutQueueRow,
  type QueueFilter,
  type QueueSort,
} from '@/hooks/usePayoutVerification';

const FILTERS: { id: QueueFilter; label: string; countKey?: keyof ReturnType<typeof countKeys> }[] = [
  { id: 'waiting', label: 'Waiting' },
  { id: 'mismatch', label: 'Name mismatch' },
  { id: 'no_id', label: 'No National ID' },
  { id: 'verified', label: 'Verified' },
  { id: 'rejected', label: 'Rejected' },
  { id: 'all', label: 'All' },
];

function countKeys() {
  return { waiting: 0, verified: 0, rejected: 0, mismatch: 0, no_id: 0 };
}

const ugx = (n: number) => `UGX ${Math.round(Number(n) || 0).toLocaleString()}`;

function destinationLabel(row: PayoutQueueRow) {
  if (row.destination_type === 'mobile_money') {
    return `${row.provider ?? 'Mobile money'} · ${row.momo_number ?? '—'}`;
  }
  return `${row.bank_name ?? 'Bank'} · ${row.bank_account_number ?? '—'}`;
}

function matchTone(row: PayoutQueueRow) {
  if (!row.national_id) return { text: 'No National ID yet', cls: 'text-muted-foreground' };
  const score = Number(row.name_match_score ?? 0);
  if (score >= 0.8) return { text: 'Name matches', cls: 'text-emerald-600 dark:text-emerald-400' };
  if (score >= 0.5) return { text: 'Name partly matches', cls: 'text-amber-600 dark:text-amber-400' };
  const tokens = Array.isArray(row.name_mismatch_tokens) ? (row.name_mismatch_tokens as string[]) : [];
  return {
    text: tokens.length ? `Name mismatch: ${tokens.slice(0, 4).join(', ')}` : 'Name mismatch',
    cls: 'text-destructive',
  };
}

/**
 * "Verify Payout Numbers" — the Financial Ops queue of payout destinations
 * awaiting a phone call. Newest submitted National IDs sit on top by default.
 */
export default function PayoutVerificationPanel() {
  const [filter, setFilter] = useState<QueueFilter>('waiting');
  const [sort, setSort] = useState<QueueSort>('newest');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(0);
  const [decideRow, setDecideRow] = useState<PayoutQueueRow | null>(null);
  const [decision, setDecision] = useState<'verified' | 'rejected'>('verified');
  const [reason, setReason] = useState('');
  const [callOutcome, setCallOutcome] = useState('');

  const counts = usePayoutVerificationCounts();
  const queue = usePayoutVerificationQueue({ status: filter, search, sort, page });
  const decide = useDecidePayoutDestination();

  const totalPages = useMemo(
    () => Math.max(1, Math.ceil((queue.data?.total ?? 0) / PAYOUT_VERIFICATION_PAGE_SIZE)),
    [queue.data?.total],
  );

  const setFilterAndReset = (id: QueueFilter) => {
    setFilter(id);
    setPage(0);
  };

  const submitDecision = async () => {
    if (!decideRow) return;
    try {
      await decide.mutateAsync({
        id: decideRow.id,
        decision,
        reason,
        callOutcome,
      });
      toast.success(decision === 'verified' ? 'Destination verified.' : 'Destination rejected.');
      setDecideRow(null);
      setReason('');
      setCallOutcome('');
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : 'Could not save the decision.');
    }
  };

  const c = counts.data;

  return (
    <div className="space-y-4">
      <Card className="border-2 border-primary/40 bg-primary/5 p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="space-y-1">
            <h3 className="text-lg font-bold leading-tight">Verify Payout Numbers</h3>
            <p className="text-sm text-muted-foreground">
              Call each holder, confirm the number belongs to them and the National ID name matches.
              Nobody is paid until you verify it here.
            </p>
          </div>
          <ShieldAlert className="h-6 w-6 shrink-0 text-primary" />
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-3 text-sm">
          <Badge variant="destructive" className="text-sm">
            {c?.waiting ?? 0} waiting
          </Badge>
          <span className="text-muted-foreground">
            {ugx(c?.waiting_balance ?? 0)} held until verified
          </span>
        </div>
      </Card>

      <div className="flex flex-wrap gap-2">
        {FILTERS.map((f) => {
          const n =
            f.id === 'all'
              ? undefined
              : ((c as unknown as Record<string, number> | undefined)?.[f.id] ?? undefined);
          return (
            <Button
              key={f.id}
              size="sm"
              variant={filter === f.id ? 'default' : 'outline'}
              onClick={() => setFilterAndReset(f.id)}
              className="h-9"
            >
              {f.label}
              {typeof n === 'number' && <span className="ml-1.5 opacity-70">{n}</span>}
            </Button>
          );
        })}
      </div>

      <div className="flex flex-col gap-2 sm:flex-row">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setPage(0);
            }}
            placeholder="Search name, number, account or National ID"
            className="h-11 pl-9"
          />
        </div>
        <div className="flex gap-2">
          {(['newest', 'oldest', 'balance'] as QueueSort[]).map((s) => (
            <Button
              key={s}
              size="sm"
              variant={sort === s ? 'default' : 'outline'}
              onClick={() => {
                setSort(s);
                setPage(0);
              }}
              className="h-11"
            >
              {s === 'newest' ? 'Latest submitted' : s === 'oldest' ? 'Oldest first' : 'Biggest balance'}
            </Button>
          ))}
        </div>
      </div>

      {queue.isLoading && (
        <div className="space-y-3">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-32 w-full" />
          ))}
        </div>
      )}

      {queue.error && (
        <Card className="border-destructive p-4 text-sm text-destructive">
          {(queue.error as Error).message}
        </Card>
      )}

      {!queue.isLoading && !queue.error && (queue.data?.rows.length ?? 0) === 0 && (
        <Card className="p-6 text-center text-sm text-muted-foreground">
          Nothing here right now.
        </Card>
      )}

      <div className="space-y-3">
        {(queue.data?.rows ?? []).map((row) => {
          const tone = matchTone(row);
          const payoutNumber =
            row.destination_type === 'mobile_money' ? row.momo_number : null;
          const showSecondCall =
            !!payoutNumber &&
            String(payoutNumber).replace(/\D/g, '').slice(-9) !==
              String(row.user_phone ?? '').replace(/\D/g, '').slice(-9);
          return (
            <Card key={row.id} className="space-y-3 p-4">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 space-y-1">
                  <p className="truncate text-base font-semibold">{row.full_name ?? 'Unnamed'}</p>
                  <p className="flex items-center gap-1.5 truncate text-sm text-muted-foreground">
                    {row.destination_type === 'mobile_money' ? (
                      <Smartphone className="h-4 w-4" />
                    ) : (
                      <Building2 className="h-4 w-4" />
                    )}
                    {destinationLabel(row)}
                  </p>
                  <p className="truncate text-sm">
                    Name on it:{' '}
                    <span className="font-medium">{row.account_name ?? 'Not recorded'}</span>
                  </p>
                  <p className="truncate text-sm">
                    National ID:{' '}
                    <span className="font-medium">{row.national_id ?? 'Not submitted'}</span>
                    {row.national_id_name ? ` · ${row.national_id_name}` : ''}
                  </p>
                  <p className={`text-sm font-medium ${tone.cls}`}>{tone.text}</p>
                </div>
                <div className="shrink-0 text-right">
                  <p className="text-xs text-muted-foreground">Withdrawable</p>
                  <p className="font-bold">{ugx(row.withdrawable_balance)}</p>
                  <Badge
                    variant={
                      row.status === 'verified'
                        ? 'default'
                        : row.status === 'rejected'
                          ? 'destructive'
                          : 'secondary'
                    }
                    className="mt-1"
                  >
                    {row.status}
                  </Badge>
                </div>
              </div>

              {row.status !== 'waiting' && (
                <p className="rounded-md bg-muted/50 p-2 text-xs text-muted-foreground">
                  {row.status === 'verified' ? 'Verified' : 'Rejected'} by{' '}
                  {row.decided_by_name ?? 'Financial Ops'}
                  {row.decided_at ? ` on ${new Date(row.decided_at).toLocaleString()}` : ''}
                  {row.decision_reason ? ` — ${row.decision_reason}` : ''}
                </p>
              )}

              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                {row.user_phone && (
                  <Button asChild variant="outline" className="h-12 justify-start">
                    <a href={`tel:${row.user_phone}`}>
                      <Phone className="mr-2 h-4 w-4" /> Call {row.user_phone}
                    </a>
                  </Button>
                )}
                {showSecondCall && (
                  <Button asChild variant="outline" className="h-12 justify-start">
                    <a href={`tel:${payoutNumber}`}>
                      <Phone className="mr-2 h-4 w-4" /> Call payout number
                    </a>
                  </Button>
                )}
              </div>

              {row.status === 'waiting' && (
                <div className="grid grid-cols-2 gap-2">
                  <Button
                    className="h-12"
                    onClick={() => {
                      setDecideRow(row);
                      setDecision('verified');
                      setReason('');
                      setCallOutcome('');
                    }}
                  >
                    <BadgeCheck className="mr-2 h-4 w-4" /> Verify
                  </Button>
                  <Button
                    variant="destructive"
                    className="h-12"
                    onClick={() => {
                      setDecideRow(row);
                      setDecision('rejected');
                      setReason('');
                      setCallOutcome('');
                    }}
                  >
                    Reject
                  </Button>
                </div>
              )}
            </Card>
          );
        })}
      </div>

      {(queue.data?.total ?? 0) > PAYOUT_VERIFICATION_PAGE_SIZE && (
        <div className="flex items-center justify-between">
          <Button
            variant="outline"
            className="h-11"
            disabled={page === 0}
            onClick={() => setPage((p) => Math.max(0, p - 1))}
          >
            <ChevronLeft className="mr-1 h-4 w-4" /> Back
          </Button>
          <span className="text-sm text-muted-foreground">
            Page {page + 1} of {totalPages}
          </span>
          <Button
            variant="outline"
            className="h-11"
            disabled={page + 1 >= totalPages}
            onClick={() => setPage((p) => p + 1)}
          >
            Next <ChevronRight className="ml-1 h-4 w-4" />
          </Button>
        </div>
      )}

      <Dialog open={!!decideRow} onOpenChange={(v) => !v && setDecideRow(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>
              {decision === 'verified' ? 'Verify this payout destination' : 'Reject this payout destination'}
            </DialogTitle>
            <DialogDescription>
              {decideRow ? `${decideRow.full_name ?? 'Unnamed'} — ${destinationLabel(decideRow)}` : ''}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-2">
              <Label htmlFor="pv-reason">Written basis (at least 10 characters)</Label>
              <Textarea
                id="pv-reason"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                rows={3}
                placeholder="Called the holder, confirmed the number and the ID name."
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="pv-call">What the call established (optional)</Label>
              <Input
                id="pv-call"
                value={callOutcome}
                onChange={(e) => setCallOutcome(e.target.value)}
                placeholder="Answered, confirmed identity"
              />
            </div>
            <Button
              className="h-12 w-full"
              variant={decision === 'verified' ? 'default' : 'destructive'}
              disabled={decide.isPending || reason.trim().length < 10}
              onClick={submitDecision}
            >
              {decide.isPending ? 'Saving…' : decision === 'verified' ? 'Verify destination' : 'Reject destination'}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
