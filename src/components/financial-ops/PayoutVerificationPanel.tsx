/**
 * Verify Payout Numbers — Financial Ops.
 *
 * Shows every mobile money number and bank account waiting to be verified,
 * with the holder's National ID name beside the name on the number so the
 * operator can call and confirm ownership from a phone. No withdrawal to an
 * unverified destination can be submitted or approved (gate is in the
 * database and in the approve-withdrawal function).
 */
import { useMemo, useState } from 'react';
import {
  AlertTriangle,
  BadgeCheck,
  Building2,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  IdCard,
  Loader2,
  PhoneCall,
  Search,
  ShieldAlert,
  Smartphone,
  X,
} from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { formatUGX } from '@/lib/rentCalculations';
import { useUserAvatars } from '@/hooks/useUserAvatars';
import {
  PAYOUT_VERIFICATION_PAGE_SIZE,
  useDecidePayoutDestination,
  usePayoutVerificationCounts,
  usePayoutVerificationQueue,
  type PayoutDestinationRow,
  type PayoutQueueFilter,
  type PayoutQueueSort,
} from '@/hooks/usePayoutVerification';

const FILTERS: { id: PayoutQueueFilter; label: string }[] = [
  { id: 'waiting', label: 'Waiting' },
  { id: 'mismatch', label: 'Name mismatch' },
  { id: 'no_id', label: 'No National ID' },
  { id: 'verified', label: 'Verified' },
  { id: 'rejected', label: 'Rejected' },
  { id: 'all', label: 'All' },
];

function matchTone(score: number | null): { label: string; className: string } {
  if (score === null) return { label: 'No ID to compare', className: 'bg-muted text-muted-foreground' };
  if (score >= 0.8) return { label: 'Names match', className: 'bg-primary/10 text-primary' };
  if (score >= 0.5) return { label: 'Partly matches', className: 'bg-amber-500/15 text-amber-600' };
  return { label: 'Names do not match', className: 'bg-destructive/10 text-destructive' };
}

function DecisionDialog({
  row,
  onClose,
}: {
  row: PayoutDestinationRow | null;
  onClose: () => void;
}) {
  const decide = useDecidePayoutDestination();
  const [reason, setReason] = useState('');
  const [callOutcome, setCallOutcome] = useState('');
  const [decision, setDecision] = useState<'verified' | 'rejected'>('verified');

  const submit = async () => {
    if (!row) return;
    if (reason.trim().length < 10) {
      toast.error('Write at least 10 characters saying what the holder confirmed on the call.');
      return;
    }
    try {
      await decide.mutateAsync({
        id: row.id,
        userId: row.user_id,
        decision,
        reason: reason.trim(),
        callOutcome: callOutcome.trim() || undefined,
      });

      toast.success(decision === 'verified' ? 'Destination verified.' : 'Destination rejected.');
      setReason('');
      setCallOutcome('');
      onClose();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not save the decision.');
    }
  };

  return (
    <Dialog open={!!row} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="text-base">
            {decision === 'verified' ? 'Verify this destination' : 'Reject this destination'}
          </DialogTitle>
          <DialogDescription className="text-xs">
            {row?.full_name ?? 'This person'} — {row?.momo_number ?? row?.bank_account_number}
          </DialogDescription>
        </DialogHeader>
        <div className="flex gap-2">
          <Button
            type="button"
            variant={decision === 'verified' ? 'default' : 'outline'}
            className="flex-1"
            onClick={() => setDecision('verified')}
          >
            <CheckCircle2 className="h-4 w-4 mr-1.5" /> Verify
          </Button>
          <Button
            type="button"
            variant={decision === 'rejected' ? 'destructive' : 'outline'}
            className="flex-1"
            onClick={() => setDecision('rejected')}
          >
            <X className="h-4 w-4 mr-1.5" /> Reject
          </Button>
        </div>
        <div className="space-y-2">
          <Input
            value={callOutcome}
            onChange={(e) => setCallOutcome(e.target.value)}
            placeholder="Call outcome (answered, no answer, wrong number…)"
            className="text-sm"
          />
          <Textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            rows={3}
            placeholder="What did the holder confirm? (at least 10 characters — this is kept on the audit trail)"
            className="text-sm"
          />
        </div>
        <Button onClick={submit} disabled={decide.isPending} className="w-full h-11">
          {decide.isPending ? <Loader2 className="h-4 w-4 animate-spin mr-1.5" /> : null}
          Save decision
        </Button>
      </DialogContent>
    </Dialog>
  );
}

export default function PayoutVerificationPanel() {
  const [status, setStatus] = useState<PayoutQueueFilter>('waiting');
  const [sort, setSort] = useState<PayoutQueueSort>('balance');
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(0);
  const [active, setActive] = useState<PayoutDestinationRow | null>(null);

  const counts = usePayoutVerificationCounts();
  const queue = usePayoutVerificationQueue({ status, search, sort, page });

  const total = queue.data?.total ?? 0;
  const rows = queue.data?.rows ?? [];
  // Faces beside the names, kept current the moment anyone's picture changes.
  const { avatarFor } = useUserAvatars(rows.map((r) => r.user_id));
  const pageCount = Math.max(1, Math.ceil(total / PAYOUT_VERIFICATION_PAGE_SIZE));
  const from = total === 0 ? 0 : page * PAYOUT_VERIFICATION_PAGE_SIZE + 1;
  const to = Math.min(total, (page + 1) * PAYOUT_VERIFICATION_PAGE_SIZE);

  const countFor = useMemo(
    () => (id: PayoutQueueFilter) => {
      const c = counts.data;
      if (!c) return null;
      switch (id) {
        case 'waiting': return c.waiting;
        case 'verified': return c.verified;
        case 'rejected': return c.rejected;
        case 'mismatch': return c.mismatch;
        case 'no_id': return c.no_id;
        default: return null;
      }
    },
    [counts.data],
  );

  const applySearch = () => {
    setSearch(searchInput);
    setPage(0);
  };

  return (
    <div className="space-y-4">
      {/* Headline */}
      <div className="rounded-2xl border border-primary/30 bg-primary/5 p-4">
        <div className="flex items-start gap-3">
          <div className="h-10 w-10 rounded-xl bg-primary/15 flex items-center justify-center shrink-0">
            <ShieldAlert className="h-5 w-5 text-primary" />
          </div>
          <div className="min-w-0">
            <h2 className="text-base font-bold text-foreground">Verify Payout Numbers</h2>
            <p className="text-xs text-muted-foreground mt-0.5">
              Call each holder, confirm the number or bank account is theirs and that the National ID
              name matches the name on the number. Nobody is paid until you verify.
            </p>
            {counts.data && (
              <p className="text-xs font-semibold text-foreground mt-2">
                {counts.data.waiting} waiting · {formatUGX(counts.data.waiting_balance)} held behind
                verification
              </p>
            )}
          </div>
        </div>
      </div>

      {/* Filters */}
      <div className="-mx-1 flex gap-2 overflow-x-auto px-1 pb-1">
        {FILTERS.map((f) => {
          const n = countFor(f.id);
          const selected = status === f.id;
          return (
            <button
              key={f.id}
              type="button"
              onClick={() => {
                setStatus(f.id);
                setPage(0);
              }}
              className={`shrink-0 rounded-full border px-3 py-1.5 text-xs font-semibold transition-colors ${
                selected
                  ? 'border-primary bg-primary text-primary-foreground'
                  : 'border-border bg-card text-foreground hover:bg-muted/50'
              }`}
            >
              {f.label}
              {n !== null && n > 0 ? ` (${n})` : ''}
            </button>
          );
        })}
      </div>

      {/* Search + sort */}
      <div className="flex flex-col sm:flex-row gap-2">
        <div className="relative flex-1">
          <Search className="h-3.5 w-3.5 text-muted-foreground absolute left-2.5 top-1/2 -translate-y-1/2" />
          <Input
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && applySearch()}
            onBlur={applySearch}
            placeholder="Search name, number, account or National ID"
            className="pl-8 h-11 text-sm"
          />
        </div>
        <div className="flex gap-2">
          {(['balance', 'oldest'] as PayoutQueueSort[]).map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => {
                setSort(s);
                setPage(0);
              }}
              className={`flex-1 sm:flex-none rounded-lg border px-3 h-11 text-xs font-semibold ${
                sort === s ? 'border-primary bg-primary/10 text-primary' : 'border-border bg-card'
              }`}
            >
              {s === 'balance' ? 'Biggest balance' : 'Oldest first'}
            </button>
          ))}
        </div>
      </div>

      {/* Rows */}
      {queue.isLoading ? (
        <div className="space-y-3">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-40 w-full rounded-2xl" />
          ))}
        </div>
      ) : queue.isError ? (
        <div className="rounded-xl border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">
          Could not load the queue. {queue.error instanceof Error ? queue.error.message : ''}
        </div>
      ) : rows.length === 0 ? (
        <div className="rounded-2xl border border-border bg-card p-8 text-center">
          <BadgeCheck className="h-8 w-8 text-primary mx-auto mb-2" />
          <p className="text-sm font-semibold text-foreground">Nothing here</p>
          <p className="text-xs text-muted-foreground mt-1">
            No payout destinations match this filter.
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {rows.map((r) => {
            const tone = matchTone(r.name_match_score);
            const isMomo = r.destination_type === 'mobile_money';
            const dest = isMomo ? r.momo_number : `${r.bank_name ?? ''} ${r.bank_account_number ?? ''}`.trim();
            return (
              <div key={r.id} className="rounded-2xl border border-border bg-card p-4 space-y-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="flex min-w-0 items-center gap-3">
                    <Avatar className="h-10 w-10 shrink-0 border border-border">
                      <AvatarImage src={avatarFor(r.user_id) ?? undefined} alt={r.full_name || 'Holder photo'} />
                      <AvatarFallback className="text-xs font-bold">
                        {(r.full_name || '?').trim().charAt(0).toUpperCase()}
                      </AvatarFallback>
                    </Avatar>
                    <div className="min-w-0">
                      <p className="text-sm font-bold text-foreground truncate">
                        {r.full_name || 'Name not recorded'}
                      </p>
                      <p className="text-xs text-muted-foreground">{r.user_phone || 'No account phone'}</p>
                    </div>
                  </div>
                  <span
                    className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide ${
                      r.status === 'verified'
                        ? 'bg-primary/10 text-primary'
                        : r.status === 'rejected'
                          ? 'bg-destructive/10 text-destructive'
                          : 'bg-amber-500/15 text-amber-600'
                    }`}
                  >
                    {r.status}
                  </span>
                </div>

                <div className="rounded-xl bg-muted/40 p-3 space-y-2">
                  <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
                    {isMomo ? <Smartphone className="h-4 w-4 text-primary" /> : <Building2 className="h-4 w-4 text-primary" />}
                    <span className="truncate">
                      {isMomo ? `${r.provider ?? 'Mobile money'} · ${dest}` : dest}
                    </span>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Name on the {isMomo ? 'number' : 'account'}:{' '}
                    <span className="font-semibold text-foreground">{r.account_name || 'Not given'}</span>
                  </p>
                  <p className="text-xs text-muted-foreground flex items-center gap-1.5">
                    <IdCard className="h-3.5 w-3.5" />
                    National ID:{' '}
                    <span className="font-semibold text-foreground">
                      {r.national_id ? `${r.national_id} · ${r.national_id_name ?? '—'}` : 'Not submitted'}
                    </span>
                  </p>
                  <div className="flex flex-wrap items-center gap-2">
                    <span className={`rounded-full px-2 py-0.5 text-[10px] font-bold ${tone.className}`}>
                      {tone.label}
                    </span>
                    {(r.name_mismatch_tokens ?? []).length > 0 && (
                      <span className="text-[10px] text-muted-foreground">
                        Different words: {(r.name_mismatch_tokens ?? []).join(', ')}
                      </span>
                    )}
                  </div>
                  <p className="text-xs font-bold text-foreground">
                    Withdrawable balance: {formatUGX(r.withdrawable_balance)}
                  </p>
                  {r.decision_reason && (
                    <p className="text-xs text-muted-foreground">Note: {r.decision_reason}</p>
                  )}
                </div>

                <div className="flex flex-col sm:flex-row gap-2">
                  {r.user_phone && (
                    <a
                      href={`tel:${r.user_phone}`}
                      className="flex-1 inline-flex items-center justify-center gap-2 rounded-xl bg-primary text-primary-foreground h-12 text-sm font-bold"
                    >
                      <PhoneCall className="h-4 w-4" /> Call {r.full_name?.split(' ')[0] || 'holder'}
                    </a>
                  )}
                  {isMomo && r.momo_number && r.momo_number !== r.user_phone && (
                    <a
                      href={`tel:${r.momo_number}`}
                      className="flex-1 inline-flex items-center justify-center gap-2 rounded-xl border border-primary/40 text-primary h-12 text-sm font-bold"
                    >
                      <PhoneCall className="h-4 w-4" /> Call payout number
                    </a>
                  )}
                </div>

                {r.status !== 'verified' || r.name_match_score === null ? (
                  <Button className="w-full h-11" onClick={() => setActive(r)}>
                    Verify or reject
                  </Button>
                ) : (
                  <Button variant="outline" className="w-full h-11" onClick={() => setActive(r)}>
                    Change decision
                  </Button>
                )}

                {r.national_id === null && (
                  <p className="text-xs text-amber-600 flex items-center gap-1.5">
                    <AlertTriangle className="h-3.5 w-3.5" />
                    Ask them to submit their National ID in the app before verifying.
                  </p>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Pagination */}
      {total > 0 && (
        <div className="flex items-center justify-between gap-2">
          <p className="text-xs text-muted-foreground">
            Showing {from}–{to} of {total}
          </p>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={page === 0}
              onClick={() => setPage((p) => Math.max(0, p - 1))}
            >
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <span className="text-xs font-semibold">
              {page + 1} / {pageCount}
            </span>
            <Button
              variant="outline"
              size="sm"
              disabled={page + 1 >= pageCount}
              onClick={() => setPage((p) => p + 1)}
            >
              <ChevronRight className="h-4 w-4" />
            </Button>
          </div>
        </div>
      )}

      <DecisionDialog row={active} onClose={() => setActive(null)} />
    </div>
  );
}
