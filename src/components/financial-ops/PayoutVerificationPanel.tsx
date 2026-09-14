/**
 * Verify Payout Numbers — Financial Ops.
 *
 * Shows every mobile money number and bank account waiting to be verified,
 * with the holder's National ID name beside the name on the number so the
 * operator can call and confirm ownership from a phone. No withdrawal to an
 * unverified destination can be submitted or approved (gate is in the
 * database and in the approve-withdrawal function).
 */
import { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  BadgeCheck,
  Building2,
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  History,
  IdCard,
  Loader2,
  MessageCircle,
  PhoneCall,
  Search,
  ShieldAlert,
  Smartphone,
  UserRound,
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
import { formatUGX } from '@/lib/rentCalculations';
import {
  PAYOUT_DECISION_LOG_PAGE_SIZE,
  PAYOUT_VERIFICATION_PAGE_SIZE,
  last9,
  useDecidePayoutDestination,
  usePayoutDecisionLog,
  usePayoutVerificationCounts,
  usePayoutVerificationQueue,
  usePhoneAccountLookup,
  type PayoutDestinationRow,
  type PayoutDecisionLogRow,
  type PayoutQueueFilter,
  type PayoutQueueSort,
  type PhoneAccountInfo,
} from '@/hooks/usePayoutVerification';
import { identityPhotoUrl, useIdentityPhotosFor } from '@/hooks/useIdentityPhotos';
import { UserProfileDrilldown } from '@/components/ops/UserProfileDrilldown';

/** wa.me chat link for a Ugandan number (256 + last 9 digits). */
function waLink(phone: string | null | undefined): string | null {
  const k = last9(phone);
  return k ? `https://wa.me/256${k}` : null;
}

/**
 * Small pill under a phone number saying whether that number has a Welile
 * account, and whose — so the operator immediately knows if a payout number
 * belongs to the holder's own account or to someone else entirely.
 */
function PhoneAccountBadge({ info, loading }: { info: PhoneAccountInfo | undefined; loading: boolean }) {
  if (loading) return <Skeleton className="h-5 w-28 rounded-full" />;
  if (!info?.has_account) {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-[10px] font-bold text-muted-foreground">
        <X className="h-3 w-3" /> No account in system
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-bold text-primary">
      <UserRound className="h-3 w-3" />
      Has account{info.account_name ? ` — ${info.account_name}` : ''}
    </span>
  );
}

/**
 * The National ID card photo and the selfie the holder recorded, shown under
 * their name so the operator compares the face before tapping Verify. Tapping
 * a thumbnail opens the full photo in a new tab (short-lived signed link).
 * `onPhotosAvailable` reports whether BOTH photos exist — the query polls
 * while they're missing, so the parent re-enables Verify the moment the
 * holder finishes recording, without a refresh.
 */
function IdentityPhotosStrip({
  userId,
  onPhotosAvailable,
}: {
  userId: string;
  onPhotosAvailable?: (available: boolean) => void;
}) {
  const photos = useIdentityPhotosFor(userId);
  const [idUrl, setIdUrl] = useState<string | null>(null);
  const [selfieUrl, setSelfieUrl] = useState<string | null>(null);
  const idPath = photos.data?.national_id_photo_path ?? null;
  const selfiePath = photos.data?.selfie_photo_path ?? null;

  const bothAvailable = !!idPath && !!selfiePath;
  useEffect(() => {
    onPhotosAvailable?.(bothAvailable);
  }, [bothAvailable, onPhotosAvailable]);

  useEffect(() => {
    let alive = true;
    setIdUrl(null);
    setSelfieUrl(null);
    if (idPath) identityPhotoUrl(idPath).then((u) => alive && setIdUrl(u));
    if (selfiePath) identityPhotoUrl(selfiePath).then((u) => alive && setSelfieUrl(u));
    return () => {
      alive = false;
    };
  }, [idPath, selfiePath]);

  if (photos.isLoading) {
    return (
      <div className="flex gap-2">
        <Skeleton className="h-20 w-16 rounded-lg" />
        <Skeleton className="h-20 w-16 rounded-lg" />
      </div>
    );
  }

  if (!idPath && !selfiePath) {
    return (
      <p className="text-xs text-amber-600 flex items-center gap-1.5">
        <AlertTriangle className="h-3.5 w-3.5" />
        No ID photo or selfie yet — ask them to record both in the app before verifying.
      </p>
    );
  }

  const shot = (url: string | null, label: string) =>
    url ? (
      <a href={url} target="_blank" rel="noreferrer" className="block shrink-0">
        <img
          src={url}
          alt={label}
          loading="lazy"
          className="h-20 w-16 rounded-lg object-cover border border-border"
        />
        <span className="block text-[10px] text-center text-muted-foreground mt-0.5">{label}</span>
      </a>
    ) : (
      <div className="shrink-0">
        <div className="h-20 w-16 rounded-lg border border-dashed border-border flex items-center justify-center">
          <IdCard className="h-4 w-4 text-muted-foreground" />
        </div>
        <span className="block text-[10px] text-center text-muted-foreground mt-0.5">{label}</span>
      </div>
    );

  return <div className="flex gap-3">{shot(idUrl, 'National ID')}{shot(selfieUrl, 'Selfie')}</div>;
}

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

/** "14 Sep 2026, 08:41" */
function formatDecisionTime(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  return `${d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}, ${d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}`;
}

/**
 * Collapsible, filterable audit trail of every verification decision —
 * searchable by holder name / number / decider, filterable by decision
 * (approved or rejected) and by decision date range. Newest first.
 */
function DecisionAuditLog({ onOpenProfile }: { onOpenProfile?: (userId: string) => void }) {
  const [open, setOpen] = useState(false);
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [decision, setDecision] = useState<'all' | 'verified' | 'rejected'>('all');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [page, setPage] = useState(0);

  const log = usePayoutDecisionLog(open, { search, decision, from, to }, page);
  const rows = log.data?.rows ?? [];
  const total = log.data?.total ?? 0;
  const pageCount = Math.max(1, Math.ceil(total / PAYOUT_DECISION_LOG_PAGE_SIZE));
  const fromRow = total === 0 ? 0 : page * PAYOUT_DECISION_LOG_PAGE_SIZE + 1;
  const toRow = Math.min(total, (page + 1) * PAYOUT_DECISION_LOG_PAGE_SIZE);

  const applySearch = () => {
    setSearch(searchInput);
    setPage(0);
  };

  return (
    <div className="rounded-2xl border border-border bg-card">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center justify-between gap-2 p-4"
      >
        <span className="flex items-center gap-2 text-sm font-bold text-foreground">
          <History className="h-4 w-4 text-primary" />
          Decision audit log
        </span>
        {open ? (
          <ChevronUp className="h-4 w-4 text-muted-foreground" />
        ) : (
          <ChevronDown className="h-4 w-4 text-muted-foreground" />
        )}
      </button>

      {open && (
        <div className="border-t border-border p-4 space-y-3">
          {/* Filters */}
          <div className="relative">
            <Search className="h-3.5 w-3.5 text-muted-foreground absolute left-2.5 top-1/2 -translate-y-1/2" />
            <Input
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && applySearch()}
              onBlur={applySearch}
              placeholder="Search holder, number or who decided"
              className="pl-8 h-11 text-sm"
            />
          </div>
          <div className="flex gap-2">
            {(['all', 'verified', 'rejected'] as const).map((d) => (
              <button
                key={d}
                type="button"
                onClick={() => {
                  setDecision(d);
                  setPage(0);
                }}
                className={`flex-1 rounded-lg border px-3 h-10 text-xs font-semibold capitalize ${
                  decision === d ? 'border-primary bg-primary/10 text-primary' : 'border-border bg-card'
                }`}
              >
                {d === 'all' ? 'All decisions' : d}
              </button>
            ))}
          </div>
          <div className="flex gap-2">
            <div className="flex-1">
              <label className="block text-[10px] font-semibold text-muted-foreground mb-1">From</label>
              <Input
                type="date"
                value={from}
                onChange={(e) => {
                  setFrom(e.target.value);
                  setPage(0);
                }}
                className="h-11 text-sm"
              />
            </div>
            <div className="flex-1">
              <label className="block text-[10px] font-semibold text-muted-foreground mb-1">To</label>
              <Input
                type="date"
                value={to}
                onChange={(e) => {
                  setTo(e.target.value);
                  setPage(0);
                }}
                className="h-11 text-sm"
              />
            </div>
          </div>

          {/* Rows */}
          {log.isLoading ? (
            <div className="space-y-2">
              {[0, 1, 2].map((i) => (
                <Skeleton key={i} className="h-14 w-full rounded-xl" />
              ))}
            </div>
          ) : log.isError ? (
            <p className="text-xs text-destructive">
              Could not load the audit log. {log.error instanceof Error ? log.error.message : ''}
            </p>
          ) : rows.length === 0 ? (
            <p className="text-xs text-muted-foreground text-center py-4">
              No decisions match these filters.
            </p>
          ) : (
            <div className="space-y-2">
              {rows.map((r: PayoutDecisionLogRow) => {
                const dest =
                  r.destination_type === 'mobile_money'
                    ? `${r.provider ?? 'Mobile money'} · ${r.momo_number ?? ''}`
                    : `${r.bank_name ?? ''} ${r.bank_account_number ?? ''}`.trim();
                return (
                  <div key={r.id} className="rounded-xl border border-border bg-muted/30 p-3 space-y-1">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="text-xs font-bold text-foreground truncate">
                          {r.full_name || 'Name not recorded'}
                        </p>
                        <p className="text-[11px] text-muted-foreground truncate">{dest}</p>
                      </div>
                      <span
                        className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide ${
                          r.status === 'verified'
                            ? 'bg-primary/10 text-primary'
                            : 'bg-destructive/10 text-destructive'
                        }`}
                      >
                        {r.status === 'verified' ? 'Approved' : 'Rejected'}
                      </span>
                    </div>
                    <p className="text-[11px] text-muted-foreground">
                      by <span className="font-semibold text-foreground">{r.decided_by_name || 'Financial Ops'}</span>
                      {' · '}
                      {formatDecisionTime(r.decided_at)}
                    </p>
                    {r.decision_reason && (
                      <p className="text-[11px] text-muted-foreground">Reason: {r.decision_reason}</p>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          {/* Pagination — newest decisions first */}
          {total > 0 && (
            <div className="flex items-center justify-between gap-2 pt-1">
              <p className="text-xs text-muted-foreground">
                Showing {fromRow}–{toRow} of {total}
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
        </div>
      )}
    </div>
  );
}

export default function PayoutVerificationPanel() {
  const [status, setStatus] = useState<PayoutQueueFilter>('waiting');
  const [sort, setSort] = useState<PayoutQueueSort>('balance');
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(0);
  const [active, setActive] = useState<PayoutDestinationRow | null>(null);
  // Per-row photo readiness; each photo strip reports here and the photo
  // query polls while shots are missing, so Verify turns on by itself the
  // moment both photos land — no refresh.
  const [photosAvailable, setPhotosAvailable] = useState<Record<string, boolean>>({});
  // Name tap → read-only profile sheet for that person.
  const [profileUserId, setProfileUserId] = useState<string | null>(null);

  const counts = usePayoutVerificationCounts();
  const queue = usePayoutVerificationQueue({ status, search, sort, page });

  const total = queue.data?.total ?? 0;
  const rows = queue.data?.rows ?? [];

  // One batched lookup for every phone on the page (account phone + payout
  // number): does this number have a Welile account, and whose?
  const pagePhones = useMemo(
    () => rows.flatMap((r) => [r.user_phone, r.momo_number]),
    [rows],
  );
  const phoneAccounts = usePhoneAccountLookup(pagePhones, rows.length > 0);
  const accountFor = (phone: string | null | undefined): PhoneAccountInfo | undefined =>
    phoneAccounts.data?.[last9(phone)];
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

      {/* Filters — sticky so they stay within thumb reach on a phone */}
      <div className="sticky top-0 z-20 -mx-1 flex gap-2 overflow-x-auto bg-background/95 px-1 py-2 backdrop-blur supports-[backdrop-filter]:bg-background/80">
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
                  <div className="min-w-0">
                    <button
                      type="button"
                      onClick={() => r.user_id && setProfileUserId(r.user_id)}
                      className="block max-w-full text-left text-sm font-bold text-foreground truncate underline decoration-primary/50 underline-offset-2 active:text-primary"
                    >
                      {r.full_name || 'Name not recorded'}
                    </button>
                    <p className="text-xs text-muted-foreground">{r.user_phone || 'No account phone'}</p>
                    <div className="mt-1">
                      <PhoneAccountBadge
                        info={accountFor(r.user_phone)}
                        loading={phoneAccounts.isLoading && !!r.user_phone}
                      />
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

                <IdentityPhotosStrip
                  userId={r.user_id}
                  onPhotosAvailable={(a) =>
                    setPhotosAvailable((m) => (m[r.id] === a ? m : { ...m, [r.id]: a }))
                  }
                />

                <div className="rounded-xl bg-muted/40 p-3 space-y-2">
                  <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
                    {isMomo ? <Smartphone className="h-4 w-4 text-primary" /> : <Building2 className="h-4 w-4 text-primary" />}
                    <span className="truncate">
                      {isMomo ? `${r.provider ?? 'Mobile money'} · ${dest}` : dest}
                    </span>
                  </div>
                  {isMomo && (
                    <PhoneAccountBadge
                      info={accountFor(r.momo_number)}
                      loading={phoneAccounts.isLoading && !!r.momo_number}
                    />
                  )}
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

                <div className="grid grid-cols-1 min-[400px]:grid-cols-2 gap-2">
                  {r.user_phone && (
                    <a
                      href={`tel:${r.user_phone}`}
                      className="inline-flex items-center justify-center gap-2 rounded-xl bg-primary text-primary-foreground h-12 text-sm font-bold"
                    >
                      <PhoneCall className="h-4 w-4" /> Call {r.full_name?.split(' ')[0] || 'holder'}
                    </a>
                  )}
                  {waLink(r.user_phone) && (
                    <a
                      href={waLink(r.user_phone) as string}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center justify-center gap-2 rounded-xl bg-emerald-600 text-white h-12 text-sm font-bold"
                    >
                      <MessageCircle className="h-4 w-4" /> WhatsApp
                    </a>
                  )}
                  {isMomo && r.momo_number && last9(r.momo_number) !== last9(r.user_phone) && (
                    <>
                      <a
                        href={`tel:${r.momo_number}`}
                        className="inline-flex items-center justify-center gap-2 rounded-xl border border-primary/40 text-primary h-12 text-sm font-bold"
                      >
                        <PhoneCall className="h-4 w-4" /> Call payout number
                      </a>
                      {waLink(r.momo_number) && (
                        <a
                          href={waLink(r.momo_number) as string}
                          target="_blank"
                          rel="noreferrer"
                          className="inline-flex items-center justify-center gap-2 rounded-xl border border-emerald-600/50 text-emerald-700 h-12 text-sm font-bold"
                        >
                          <MessageCircle className="h-4 w-4" /> WhatsApp payout number
                        </a>
                      )}
                    </>
                  )}
                </div>

                {r.decided_at && (
                  <p className="text-[11px] text-muted-foreground">
                    {r.status === 'verified' ? 'Approved' : r.status === 'rejected' ? 'Rejected' : 'Decided'} by{' '}
                    <span className="font-semibold text-foreground">{r.decided_by_name || 'Financial Ops'}</span>
                    {' on '}
                    {formatDecisionTime(r.decided_at)}
                  </p>
                )}

                {r.status !== 'verified' || r.name_match_score === null ? (
                  <Button
                    className="w-full h-11"
                    onClick={() => setActive(r)}
                    disabled={!photosAvailable[r.id]}
                  >
                    Verify or reject
                  </Button>
                ) : (
                  <Button
                    variant="outline"
                    className="w-full h-11"
                    onClick={() => setActive(r)}
                    disabled={!photosAvailable[r.id]}
                  >
                    Change decision
                  </Button>
                )}

                {photosAvailable[r.id] === false && (
                  <p className="text-xs text-amber-600 flex items-center gap-1.5">
                    <AlertTriangle className="h-3.5 w-3.5" />
                    Both a National ID photo and a selfie must be uploaded before verifying.
                  </p>
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
      <UserProfileDrilldown
        open={!!profileUserId}
        onOpenChange={(v) => {
          if (!v) setProfileUserId(null);
        }}
        userId={profileUserId}
      />
    </div>
  );
}
