/**
 * Verify Payout Numbers — Financial Ops, focus mode.
 *
 * One case fills the screen at a time: the holder's National ID photo and
 * selfie dominate, the name-match result is a single glanceable signal, and
 * Call / WhatsApp / Verify / Reject are the only actions. Next/previous move
 * through the queue without returning to a list. The verification gate itself
 * lives in the database and the approve-withdrawal function.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  BadgeCheck,
  Building2,
  Camera,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Clock,
  HelpCircle,
  History,
  IdCard,
  Image,
  Loader2,
  MessageCircle,
  PhoneCall,
  Search,
  ShieldAlert,
  Smartphone,
  Undo2,
  UserCheck,
  X,
  XCircle,

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
import { useAuth } from '@/hooks/useAuth';
import { identityPhotoUrl, useIdentityPhotosFor } from '@/hooks/useIdentityPhotos';
import {
  PAYOUT_VERIFICATION_PAGE_SIZE,
  last9,
  useAdoptNationalIdName,
  useHolderNameHistory,
  useDecidePayoutDestination,
  useRevertHolderName,
  useSetHolderName,
  useReplaceNationalIdPhoto,




  usePayoutVerificationCounts,
  usePayoutVerificationQueue,
  type PayoutDestinationRow,
  type PayoutQueueFilter,
  type PayoutQueueSort,
} from '@/hooks/usePayoutVerification';

const FILTERS: { id: PayoutQueueFilter; label: string }[] = [
  { id: 'waiting', label: 'Waiting' },
  { id: 'mismatch', label: 'Mismatch' },
  { id: 'no_id', label: 'No ID' },
  { id: 'verified', label: 'Verified' },
  { id: 'rejected', label: 'Rejected' },
];

function waHref(phone: string | null | undefined, text: string): string | null {
  const digits = last9(phone);
  if (!digits) return null;
  return `https://wa.me/256${digits}?text=${encodeURIComponent(text)}`;
}

function matchSignal(score: number | null): {
  label: string;
  dot: string;
  text: string;
  Icon: typeof BadgeCheck;
} {
  if (score === null) return { label: 'No ID to compare', dot: 'bg-muted-foreground', text: 'text-muted-foreground', Icon: HelpCircle };
  if (score >= 0.8) return { label: 'Names match', dot: 'bg-emerald-500', text: 'text-emerald-600', Icon: BadgeCheck };
  if (score >= 0.5) return { label: 'Partly matches', dot: 'bg-amber-500', text: 'text-amber-600', Icon: AlertTriangle };
  return { label: 'Names do not match', dot: 'bg-destructive', text: 'text-destructive', Icon: XCircle };
}

/**
 * Glanceable outcome badge. Colour is never the only signal: every state
 * pairs a distinct icon and plain-word label with its colour, so the badge
 * reads the same for colour-blind operators.
 */
function statusBadge(row: PayoutDestinationRow): {
  label: string;
  Icon: typeof BadgeCheck;
  classes: string;
} {
  if (row.status === 'verified')
    return { label: 'Verified', Icon: BadgeCheck, classes: 'bg-emerald-500/15 text-emerald-700 ring-1 ring-inset ring-emerald-500/40' };
  if (row.status === 'rejected')
    return { label: 'Rejected', Icon: XCircle, classes: 'bg-destructive/10 text-destructive ring-1 ring-inset ring-destructive/40' };
  if (row.name_match_score !== null && row.name_match_score < 0.5)
    return { label: 'Needs review', Icon: AlertTriangle, classes: 'bg-amber-500/15 text-amber-700 ring-1 ring-inset ring-amber-500/50' };
  return { label: 'Pending', Icon: Clock, classes: 'bg-sky-500/15 text-sky-700 ring-1 ring-inset ring-sky-500/40' };
}

/** Photos-ready badge so operators instantly know which cases can be actioned. */
function readinessBadge(photosReady: boolean): {
  label: string;
  Icon: typeof Camera;
  classes: string;
} {
  return photosReady
    ? { label: 'Ready', Icon: Camera, classes: 'bg-emerald-500/15 text-emerald-700 ring-1 ring-inset ring-emerald-500/40' }
    : { label: 'Pending photos', Icon: Image, classes: 'bg-amber-500/15 text-amber-700 ring-1 ring-inset ring-amber-500/50' };
}

/**
 * Where the name on the account came from: adopted from the National ID, or
 * confirmed/set by a reviewer when the selfie was verified. Returns null when
 * the name has never been touched, so no badge shows.
 */
function nameSourceBadge(source: PayoutDestinationRow['name_source']): {
  label: string;
  Icon: typeof Camera;
  classes: string;
} | null {
  if (source === 'national_id')
    return { label: 'ID name', Icon: IdCard, classes: 'bg-sky-500/15 text-sky-700 ring-1 ring-inset ring-sky-500/40' };
  if (source === 'verified')
    return { label: 'Verified name', Icon: UserCheck, classes: 'bg-violet-500/15 text-violet-700 ring-1 ring-inset ring-violet-500/40' };
  return null;
}

/**
 * Every time the name on the account was replaced by the name read from the
 * National ID (or corrected by hand), it is recorded in the audit log. This
 * shows that trail: who changed it, when, and from what to what.
 */
function nameChangeSourceLabel(source: string | null): string {
  if (source === 'financial_ops_manual_override') return 'Typed by hand';
  if (source === 'admin_rollback') return 'Put back by an administrator';
  return 'Taken from the National ID';
}

function NameChangeHistory({ userId }: { userId: string }) {
  const { data, isLoading } = useHolderNameHistory(userId);
  const { roles } = useAuth();
  const revert = useRevertHolderName();
  const isAdmin = roles.includes('super_admin') || roles.includes('cfo');
  if (isLoading || !data || data.length === 0) return null;

  return (
    <div className="mx-5 mt-3 rounded-2xl border border-border bg-muted/40 p-4">
      <p className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-[0.2em] text-muted-foreground">
        <History className="h-3.5 w-3.5" aria-hidden="true" /> Name changes ({data.length})
      </p>
      <ul className="mt-2 space-y-2">
        {data.map((h) => (
          <li key={h.id} className="rounded-xl bg-background/70 px-3 py-2">
            <p className="text-sm font-semibold leading-tight text-foreground">
              {h.old_name || '—'} <span aria-hidden="true">→</span>{' '}
              <span className="text-emerald-700 dark:text-emerald-400">{h.new_name || '—'}</span>
            </p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {nameChangeSourceLabel(h.source)} ·{' '}
              {h.changed_by_name || 'Financial Ops'} ·{' '}
              {new Date(h.changed_at).toLocaleString('en-GB', {
                day: '2-digit',
                month: 'short',
                year: 'numeric',
                hour: '2-digit',
                minute: '2-digit',
              })}
            </p>
            {h.reason && <p className="mt-0.5 text-xs italic text-muted-foreground">{h.reason}</p>}
            {isAdmin && h.can_revert && (
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="mt-2 h-8 gap-1.5 rounded-full text-xs"
                disabled={revert.isPending}
                onClick={() => {
                  if (!window.confirm(`Put the name back to "${h.old_name}"?`)) return;
                  revert.mutate(
                    { auditId: h.id },
                    {
                      onSuccess: (res) =>
                        toast.success(`Name put back to ${res.full_name || h.old_name}`),
                      onError: (err: Error) => toast.error(err.message),
                    },
                  );
                }}
              >
                {revert.isPending ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                ) : (
                  <Undo2 className="h-3.5 w-3.5" aria-hidden="true" />
                )}
                Put this name back
              </Button>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}


/**
 * Shown when the names do not match. The name printed on the National ID is
 * spelled out, and Financial Ops either takes it as-is or types the final
 * name themselves before marking the payout verified.
 */
function IdNameMismatchCard({ row, onSaved }: { row: PayoutDestinationRow; onSaved: () => void }) {
  const adopt = useAdoptNationalIdName();
  const setName = useSetHolderName();
  const idName = (row.national_id_name || '').trim();
  const accountName = (row.full_name || row.account_name || '').trim();
  const alreadySame = !!idName && idName.toLowerCase() === accountName.toLowerCase();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(idName || accountName);
  const busy = adopt.isPending || setName.isPending;
  const cleaned = draft.trim();

  useEffect(() => {
    setEditing(false);
    setDraft(idName || accountName);
  }, [row.id, idName, accountName]);

  return (
    <div className="mx-5 mt-3 rounded-2xl border border-amber-500/40 bg-amber-500/10 p-4">
      <p className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-[0.2em] text-amber-700 dark:text-amber-400">
        <AlertTriangle className="h-3.5 w-3.5" aria-hidden="true" /> Name on the National ID
      </p>
      <p className="mt-1.5 text-lg font-bold leading-tight text-foreground">{idName || 'Not read yet'}</p>
      <p className="mt-0.5 text-xs text-muted-foreground">On the account now: {accountName || '—'}</p>

      {editing ? (
        <div className="mt-3 space-y-2">
          <label className="text-[10px] font-bold uppercase tracking-[0.2em] text-muted-foreground" htmlFor={`final-name-${row.id}`}>
            Final name for this payout
          </label>
          <Input
            id={`final-name-${row.id}`}
            value={draft}
            autoFocus
            onChange={(e) => setDraft(e.target.value)}
            placeholder="Type the name exactly as printed on the ID"
            className="h-12 rounded-xl text-base font-semibold"
          />
          <div className="flex gap-2">
            <Button
              variant="outline"
              className="h-12 flex-1 rounded-xl text-xs font-bold uppercase tracking-widest"
              disabled={busy}
              onClick={() => {
                setDraft(idName || accountName);
                setEditing(false);
              }}
            >
              Cancel
            </Button>
            <Button
              className="h-12 flex-[2] rounded-xl text-xs font-bold uppercase tracking-widest"
              disabled={busy || cleaned.length < 3 || cleaned === accountName}
              onClick={async () => {
                try {
                  const res = await setName.mutateAsync({ id: row.id, fullName: cleaned });
                  toast.success(`Name set to ${res.full_name ?? cleaned}.`);
                  setEditing(false);
                  onSaved();
                } catch (e) {
                  toast.error(e instanceof Error ? e.message : 'Could not save the name.');
                }
              }}
            >
              {setName.isPending ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <UserCheck className="mr-2 h-4 w-4" />
              )}
              Save this name
            </Button>
          </div>
        </div>
      ) : (
        <div className="mt-3 flex gap-2">
          <Button
            className="h-12 flex-[2] rounded-xl text-xs font-bold uppercase tracking-widest"
            disabled={busy || alreadySame || idName.length < 3}
            onClick={async () => {
              try {
                const res = await adopt.mutateAsync({ id: row.id });
                toast.success(`Name changed to ${res.full_name ?? idName}.`);
                onSaved();
              } catch (e) {
                toast.error(e instanceof Error ? e.message : 'Could not change the name.');
              }
            }}
          >
            {adopt.isPending ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <UserCheck className="mr-2 h-4 w-4" />
            )}
            {alreadySame ? 'Already using the ID name' : 'Use the ID name'}
          </Button>
          <Button
            variant="outline"
            className="h-12 flex-1 rounded-xl text-xs font-bold uppercase tracking-widest"
            disabled={busy}
            onClick={() => setEditing(true)}
          >
            Change
          </Button>
        </div>
      )}
    </div>
  );
}


/** One of the two hero photos, or a clear "not sent yet" placeholder. */
function HeroPhoto({
  label,
  path,
  onOpen,
}: {
  label: string;
  path: string | null;
  onOpen: (url: string, label: string) => void;
}) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    setUrl(null);
    if (path) {
      void identityPhotoUrl(path).then((u) => {
        if (alive) setUrl(u);
      });
    }
    return () => {
      alive = false;
    };
  }, [path]);

  return (
    <div className="flex flex-col gap-2">
      <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-muted-foreground">{label}</p>
      {path ? (
        url ? (
          <button
            type="button"
            onClick={() => onOpen(url, label)}
            aria-label={`Open ${label} full size`}
            className="aspect-[4/5] w-full overflow-hidden rounded-3xl border-2 border-primary/10 bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
          >
            <img src={url} alt={label} className="h-full w-full object-cover" />
          </button>
        ) : (
          <Skeleton className="aspect-[4/5] w-full rounded-3xl" />
        )
      ) : (
        <div className="flex aspect-[4/5] w-full flex-col items-center justify-center gap-2 rounded-3xl border-2 border-dashed border-border bg-muted/40 px-4 text-center">
          <AlertTriangle className="h-5 w-5 text-amber-600" />
          <p className="text-xs font-semibold text-muted-foreground">Not sent yet</p>
        </div>
      )}
    </div>
  );
}

/**
 * Shown when no name could be read from the National ID photo: Financial Ops
 * can put a clearer photo in its place, and the name extraction is retried on
 * the new photo straight away.
 */
function ReUploadIdPhotoCard({ row }: { row: PayoutDestinationRow }) {
  const replace = useReplaceNationalIdPhoto();
  const inputId = `reupload-id-${row.id}`;

  const onPick = async (file: File | null) => {
    if (!file) return;
    try {
      const res = await replace.mutateAsync({
        id: row.id,
        userId: row.user_id,
        file,
        currentNationalId: row.national_id,
      });
      if (res.name_read) {
        toast.success(`Name read from the new photo: ${res.national_id_name}. It is now the account name.`);
      } else {
        toast.error(res.message || 'The new photo still could not be read. Ask for a clearer one.');
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not upload that photo.');
    }
  };

  return (
    <div className="mx-5 mt-3 rounded-2xl border border-destructive/40 bg-destructive/5 p-4">
      <p className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-[0.2em] text-destructive">
        <AlertTriangle className="h-3.5 w-3.5" aria-hidden="true" /> No name on the ID photo
      </p>
      <p className="mt-1.5 text-xs text-muted-foreground">
        Put a clearer photo of the National ID in its place — the name is read again automatically.
      </p>
      <input
        id={inputId}
        type="file"
        accept="image/*"
        className="sr-only"
        disabled={replace.isPending}
        onChange={(e) => {
          const file = e.target.files?.[0] ?? null;
          e.target.value = '';
          void onPick(file);
        }}
      />
      <Button
        asChild={!replace.isPending}
        disabled={replace.isPending}
        className="mt-3 h-12 w-full rounded-xl text-xs font-bold uppercase tracking-widest"
      >
        {replace.isPending ? (
          <span className="flex items-center justify-center">
            <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" /> Reading the new photo…
          </span>
        ) : (
          <label htmlFor={inputId} className="cursor-pointer">
            <Camera className="mr-2 inline h-4 w-4" aria-hidden="true" /> Re-upload ID photo
          </label>
        )}
      </Button>
    </div>
  );
}



function DecisionDialog({
  row,
  photosReady,
  idNameUnreadable,
  idBackMissing,
  onClose,
  onSaved,
}: {
  row: PayoutDestinationRow | null;
  photosReady: boolean;
  idNameUnreadable: boolean;
  idBackMissing: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const decide = useDecidePayoutDestination();
  const [reason, setReason] = useState('');
  const [callOutcome, setCallOutcome] = useState('');
  const [decision, setDecision] = useState<'verified' | 'rejected'>('verified');
  const verifyBlocked = !photosReady || idNameUnreadable || idBackMissing;

  useEffect(() => {
    setDecision(!photosReady || idNameUnreadable || idBackMissing ? 'rejected' : 'verified');
    setReason('');
    setCallOutcome('');
  }, [row, photosReady, idNameUnreadable, idBackMissing]);

  const submit = async () => {
    if (!row) return;
    if (decision === 'verified' && !photosReady) {
      toast.error('Both the National ID photo and the selfie must be on file before verifying.');
      return;
    }
    if (decision === 'verified' && idBackMissing) {
      toast.error('The back of the National ID is missing. Ask the user to upload a photo of the back of their National ID.');
      return;
    }
    if (decision === 'verified' && idNameUnreadable) {
      toast.error('The name could not be read from the National ID photo. Ask for a clearer photo — until then this payout can only be rejected.');
      return;
    }
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
      toast.success(decision === 'verified' ? 'Verified.' : 'Rejected.');
      onClose();
      onSaved();
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
            disabled={verifyBlocked}
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
        {!photosReady && (
          <p className="flex items-center gap-1.5 text-xs text-amber-600">
            <AlertTriangle className="h-3.5 w-3.5" />
            Verify unlocks once both photos are on file. Reject stays available.
          </p>
        )}
        {photosReady && idBackMissing && (
          <p role="alert" className="flex items-center gap-1.5 text-xs font-semibold text-destructive">
            <AlertTriangle className="h-3.5 w-3.5" />
            The back of the National ID is missing. Ask the user to upload a photo of the back of their National ID.
          </p>
        )}
        {photosReady && idNameUnreadable && (
          <p role="alert" className="flex items-center gap-1.5 text-xs font-semibold text-destructive">
            <AlertTriangle className="h-3.5 w-3.5" />
            No name could be read from the National ID photo. Ask for a clearer photo — until then this payout can only be rejected.
          </p>
        )}
        <div className="space-y-2">
          <Input
            value={callOutcome}
            onChange={(e) => setCallOutcome(e.target.value)}
            placeholder="Call outcome (answered, no answer, wrong number…)"
            className="text-sm"
            aria-label="Call outcome"
          />
          <Textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            rows={3}
            placeholder="What did the holder confirm? (kept on the audit trail)"
            className="text-sm"
            aria-label="Decision reason"
          />
        </div>
        <Button onClick={submit} disabled={decide.isPending} className="h-11 w-full">
          {decide.isPending ? <Loader2 className="h-4 w-4 animate-spin mr-1.5" /> : null}
          Save decision
        </Button>
      </DialogContent>
    </Dialog>
  );
}

const SORT_STORAGE_KEY = 'finops-payout-verification-sort';
const SORT_OPTIONS: PayoutQueueSort[] = ['ready_first', 'balance', 'newest', 'oldest'];

function readStoredSort(): PayoutQueueSort {
  try {
    const stored = window.localStorage.getItem(SORT_STORAGE_KEY);
    if (stored && (SORT_OPTIONS as string[]).includes(stored)) return stored as PayoutQueueSort;
  } catch {
    // storage unavailable — fall through to default
  }
  return 'ready_first';
}

export default function PayoutVerificationPanel() {
  const [status, setStatus] = useState<PayoutQueueFilter>('waiting');
  // Financial Ops should see people who have already submitted their National ID
  // and selfie first, because those cases can be actioned immediately. The last
  // chosen sort is remembered per user/device so it survives refreshes.
  const [sort, setSortState] = useState<PayoutQueueSort>(readStoredSort);
  const setSort = useCallback((next: PayoutQueueSort) => {
    setSortState(next);
    try {
      window.localStorage.setItem(SORT_STORAGE_KEY, next);
    } catch {
      // storage unavailable — in-memory state still updates
    }
  }, []);
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(0);
  const [index, setIndex] = useState(0);
  const [deciding, setDeciding] = useState(false);
  const [lightbox, setLightbox] = useState<{ url: string; label: string } | null>(null);

  const counts = usePayoutVerificationCounts();
  const queue = usePayoutVerificationQueue({ status, search, sort, page });

  const total = queue.data?.total ?? 0;
  const rows = useMemo(() => queue.data?.rows ?? [], [queue.data?.rows]);
  const row: PayoutDestinationRow | null = rows[Math.min(index, rows.length - 1)] ?? null;

  const photos = useIdentityPhotosFor(row?.user_id);
  const idPath = photos.data?.national_id_photo_path ?? null;
  const selfiePath = photos.data?.selfie_photo_path ?? null;
  const photosReady = !!idPath && !!selfiePath;
  // Verify must stay off until the ID photo has been read and produced a name.
  const idNameUnreadable = !!idPath && (row?.national_id_name || '').trim().length < 3;
  const verifyBlocked = !photosReady || idNameUnreadable;

  const { avatarFor } = useUserAvatars(row ? [row.user_id] : []);

  // Keep the pointer valid whenever the queue contents shift.
  useEffect(() => {
    if (index >= rows.length) setIndex(0);
  }, [rows.length, index]);

  const position = total === 0 ? 0 : page * PAYOUT_VERIFICATION_PAGE_SIZE + index + 1;

  const goTo = (nextGlobal: number) => {
    const maxGlobal = total - 1;
    const clamped = Math.max(0, Math.min(maxGlobal, nextGlobal));
    const nextPage = Math.floor(clamped / PAYOUT_VERIFICATION_PAGE_SIZE);
    if (nextPage !== page) setPage(nextPage);
    setIndex(clamped - nextPage * PAYOUT_VERIFICATION_PAGE_SIZE);
  };

  const applySearch = () => {
    setSearch(searchInput);
    setPage(0);
    setIndex(0);
  };

  const changeFilter = (f: PayoutQueueFilter) => {
    setStatus(f);
    setPage(0);
    setIndex(0);
  };

  return (
    <div className="space-y-3">
      {/* Slim control bar */}
      <div className="sticky top-0 z-20 -mx-1 space-y-2 bg-background/95 px-1 py-2 backdrop-blur">
        <div className="flex items-center gap-2">
          <ShieldAlert className="h-4 w-4 shrink-0 text-primary" />
          <p className="min-w-0 flex-1 truncate text-sm font-bold text-foreground">
            Verify Payouts
            {counts.data ? (
              <span className="ml-2 font-semibold text-muted-foreground">
                {counts.data.waiting} waiting · {formatUGX(counts.data.waiting_balance)} held
              </span>
            ) : null}
          </p>
          {total > 0 && (
            <p className="shrink-0 text-xs font-bold text-muted-foreground" aria-live="polite">
              {position} of {total}
            </p>
          )}
        </div>
        <div className="flex gap-2">
          <div className="relative flex-1">
            <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && applySearch()}
              onBlur={applySearch}
              placeholder="Name or number"
              className="h-10 pl-8 text-sm"
              aria-label="Search by name or number"
            />
          </div>
          <button
            type="button"
            onClick={() => {
              const order: PayoutQueueSort[] = ['ready_first', 'balance', 'newest', 'oldest'];
              const next = order[(order.indexOf(sort) + 1) % order.length];
              setSort(next);
              setPage(0);
              setIndex(0);
            }}
            className="h-10 shrink-0 rounded-lg border border-border bg-card px-3 text-xs font-semibold text-foreground"
          >
            {sort === 'ready_first' ? 'Ready first' : sort === 'balance' ? 'Biggest first' : sort === 'newest' ? 'Newest first' : 'Oldest first'}
          </button>
        </div>
        <div className="flex gap-1.5 overflow-x-auto pb-0.5">
          {FILTERS.map((f) => {
            const selected = status === f.id;
            return (
              <button
                key={f.id}
                type="button"
                onClick={() => changeFilter(f.id)}
                aria-pressed={selected}
                className={`shrink-0 rounded-full border px-3 py-1 text-xs font-semibold transition-colors ${
                  selected
                    ? 'border-primary bg-primary text-primary-foreground'
                    : 'border-border bg-card text-foreground'
                }`}
              >
                {f.label}
              </button>
            );
          })}
        </div>
      </div>

      {/* Focus card */}
      {queue.isLoading ? (
        <Skeleton className="h-[28rem] w-full rounded-[2rem]" />
      ) : queue.isError ? (
        <div className="rounded-2xl border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">
          Could not load the queue. {queue.error instanceof Error ? queue.error.message : ''}
        </div>
      ) : !row ? (
        <div className="rounded-2xl border border-border bg-card p-10 text-center">
          <BadgeCheck className="mx-auto mb-2 h-8 w-8 text-primary" />
          <p className="text-sm font-semibold text-foreground">Nothing waiting here</p>
        </div>
      ) : (
        <div
          key={row.id}
          className="overflow-hidden rounded-[2rem] border border-primary/10 bg-card shadow-xl shadow-primary/5"
        >
          {/* Case header */}
          <div className="flex items-center justify-between gap-3 border-b border-primary/10 px-5 py-4">
            <div className="flex min-w-0 items-center gap-3">
              <Avatar className="h-11 w-11 shrink-0 border border-border">
                <AvatarImage src={avatarFor(row.user_id) ?? undefined} alt={row.full_name || 'Holder photo'} />
                <AvatarFallback className="text-sm font-bold">
                  {(row.full_name || '?').trim().charAt(0).toUpperCase()}
                </AvatarFallback>
              </Avatar>
              <div className="min-w-0">
                <p className="truncate text-base font-bold text-foreground">
                  {row.full_name || 'Name not recorded'}
                </p>
                <p className="truncate text-xs text-muted-foreground">
                  {row.destination_type === 'mobile_money'
                    ? `${row.provider ?? 'Mobile money'} · ${row.momo_number ?? ''}`
                    : `${row.bank_name ?? ''} ${row.bank_account_number ?? ''}`.trim()}
                </p>
              </div>
            </div>
            {(() => {
              const badge = statusBadge(row);
              return (
                <span
                  role="status"
                  aria-label={`Verification status: ${badge.label}`}
                  className={`flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-1 text-[10px] font-bold uppercase tracking-wide ${badge.classes}`}
                >
                  <badge.Icon className="h-3.5 w-3.5" aria-hidden="true" />
                  {badge.label}
                </span>
              );
            })()}
            {(() => {
              const badge = readinessBadge(photosReady);
              return (
                <span
                  role="status"
                  aria-label={`Readiness: ${badge.label}`}
                  className={`flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-1 text-[10px] font-bold uppercase tracking-wide ${badge.classes}`}
                >
                  <badge.Icon className="h-3.5 w-3.5" aria-hidden="true" />
                  {badge.label}
                </span>
              );
            })()}
            {(() => {
              const badge = nameSourceBadge(row.name_source);
              if (!badge) return null;
              return (
                <span
                  role="status"
                  aria-label={`Name source: ${badge.label}`}
                  className={`flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-1 text-[10px] font-bold uppercase tracking-wide ${badge.classes}`}
                >
                  <badge.Icon className="h-3.5 w-3.5" aria-hidden="true" />
                  {badge.label}
                </span>
              );
            })()}
          </div>

          {/* Photos — the hero of the screen */}
          <div className="grid grid-cols-2 gap-3 p-5">
            <HeroPhoto label="Selfie" path={selfiePath} onOpen={(url, label) => setLightbox({ url, label })} />
            <HeroPhoto label="National ID" path={idPath} onOpen={(url, label) => setLightbox({ url, label })} />
          </div>

          {/* Glanceable match strip */}
          <div className="mx-5 flex items-center gap-3 rounded-2xl bg-muted/50 px-4 py-3">
            {(() => {
              const sig = matchSignal(row.name_match_score);
              return (
                <>
                  <span
                    role="img"
                    aria-label={`Name match result: ${sig.label}`}
                    className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full ${sig.dot} text-primary-foreground`}
                  >
                    <sig.Icon className="h-4 w-4" aria-hidden="true" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className={`text-sm font-bold ${sig.text}`}>{sig.label}</p>
                    <p className="truncate text-xs text-muted-foreground">
                      Account: {row.account_name || '—'} · ID: {row.national_id_name || '—'}
                    </p>
                  </div>
                  <p className="shrink-0 text-sm font-bold text-foreground">
                    {formatUGX(row.withdrawable_balance)}
                  </p>
                </>
              );
            })()}
          </div>

          {/* Both names side by side — the person in the selfie vs the National ID */}
          <div className="mx-5 mt-3 grid grid-cols-2 gap-3">
            <div className="rounded-2xl border border-border bg-card p-3">
              <p className="text-[10px] font-bold uppercase tracking-[0.15em] text-muted-foreground">Selfie name</p>
              <p className="mt-1 truncate text-sm font-bold text-foreground">{row.full_name || '—'}</p>
              <p className="text-[10px] text-muted-foreground">Name on the account</p>
            </div>
            <div
              className={`rounded-2xl border p-3 ${
                idNameUnreadable
                  ? 'border-destructive/50 bg-destructive/10'
                  : row.national_id_name && row.full_name && row.name_match_score !== null && row.name_match_score < 0.8
                    ? 'border-amber-500/50 bg-amber-500/10'
                    : 'border-border bg-card'
              }`}
            >
              <p className="text-[10px] font-bold uppercase tracking-[0.15em] text-muted-foreground">National ID name</p>
              <p className="mt-1 truncate text-sm font-bold text-foreground">{row.national_id_name || '—'}</p>
              {idNameUnreadable ? (
                <p role="alert" className="mt-0.5 flex items-start gap-1 text-[10px] font-semibold text-destructive">
                  <AlertTriangle className="mt-px h-3 w-3 shrink-0" aria-hidden="true" />
                  Could not read the name on this National ID photo. Ask for a clearer photo — Verify stays off until a name is read.
                </p>
              ) : (
                <p className="text-[10px] text-muted-foreground">
                  {row.national_id_name
                    ? row.name_match_score !== null && row.name_match_score < 0.8
                      ? 'Does not match the selfie name'
                      : 'Matches the selfie name'
                    : 'Not read from the ID yet'}
                </p>
              )}
            </div>
          </div>

          {/* No name on the ID photo: replace the photo and read it again */}
          {idNameUnreadable && <ReUploadIdPhotoCard row={row} />}

          {/* Names do not match: show the ID name and let it become the holder's name */}
          {!idNameUnreadable && row.name_match_score !== null && row.name_match_score < 0.8 && (
            <IdNameMismatchCard row={row} onSaved={() => goTo(position)} />
          )}

          {/* Audit trail of name replacements */}
          <NameChangeHistory userId={row.user_id} />



          {/* Contact actions */}
          <div className="grid grid-cols-2 gap-2 px-5 pt-3">
            {row.user_phone && (
              <a
                href={`tel:${row.user_phone}`}
                className="inline-flex h-12 items-center justify-center gap-2 rounded-xl bg-primary text-sm font-bold text-primary-foreground"
              >
                <PhoneCall className="h-4 w-4" /> Call
              </a>
            )}
            {(() => {
              const href = waHref(
                row.user_phone,
                `Hello ${(row.full_name || '').split(' ')[0] || 'there'}, this is Welile Financial Ops about your payout verification.`,
              );
              return href ? (
                <a
                  href={href}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex h-12 items-center justify-center gap-2 rounded-xl border border-emerald-600/40 text-sm font-bold text-emerald-700 dark:text-emerald-400"
                >
                  <MessageCircle className="h-4 w-4" /> WhatsApp
                </a>
              ) : null;
            })()}
            {row.destination_type === 'mobile_money' &&
              row.momo_number &&
              last9(row.momo_number) !== last9(row.user_phone) && (
                <a
                  href={`tel:${row.momo_number}`}
                  className="col-span-2 inline-flex h-11 items-center justify-center gap-2 rounded-xl border border-primary/40 text-xs font-bold text-primary"
                >
                  <Smartphone className="h-4 w-4" /> Call payout number {row.momo_number}
                </a>
              )}
            {row.destination_type !== 'mobile_money' && (
              <p className="col-span-2 flex items-center justify-center gap-2 text-xs text-muted-foreground">
                <Building2 className="h-3.5 w-3.5" /> Bank account — confirm with the bank on the call
              </p>
            )}
          </div>

          {/* Decisions */}
          <div className="flex gap-3 p-5">
            <Button
              variant="outline"
              className="h-14 flex-1 rounded-2xl text-xs font-bold uppercase tracking-widest"
              onClick={() => setDeciding(true)}
            >
              Decide
            </Button>
            <Button
              className="h-14 flex-[2] rounded-2xl text-xs font-bold uppercase tracking-widest shadow-lg shadow-primary/25 disabled:opacity-50"
              disabled={verifyBlocked}
              onClick={() => setDeciding(true)}
            >
              <CheckCircle2 className="mr-2 h-5 w-5" /> Verify payout
            </Button>
          </div>
          {!photosReady && (
            <p className="-mt-2 flex items-center justify-center gap-1.5 px-5 pb-4 text-center text-xs text-amber-600">
              <AlertTriangle className="h-3.5 w-3.5" />
              Waiting for their National ID photo and selfie
            </p>
          )}
          {photosReady && idNameUnreadable && (
            <p role="alert" className="-mt-2 flex items-center justify-center gap-1.5 px-5 pb-4 text-center text-xs font-semibold text-destructive">
              <AlertTriangle className="h-3.5 w-3.5" />
              Verify is off — the name could not be read from the National ID. Ask for a clearer ID photo.
            </p>
          )}
          {row.decision_reason && (
            <p className="px-5 pb-4 text-center text-xs text-muted-foreground">
              Last note: {row.decision_reason}
            </p>
          )}

          {/* Queue navigation */}
          <div className="flex items-center justify-between gap-2 border-t border-primary/10 px-5 py-3">
            <Button
              variant="ghost"
              className="h-11 gap-1"
              disabled={position <= 1}
              onClick={() => goTo(position - 2)}
              aria-label="Previous person in the queue"
            >
              <ChevronLeft className="h-4 w-4" /> Previous
            </Button>
            <p className="text-xs font-semibold text-muted-foreground" aria-live="polite">
              Person {position} of {total}
            </p>
            <Button
              variant="ghost"
              className="h-11 gap-1"
              disabled={position >= total}
              onClick={() => goTo(position)}
              aria-label="Next person in the queue"
            >
              Next <ChevronRight className="h-4 w-4" />
            </Button>
          </div>
        </div>
      )}

      <DecisionDialog
        row={deciding ? row : null}
        photosReady={photosReady}
        idNameUnreadable={idNameUnreadable}
        onClose={() => setDeciding(false)}
        onSaved={() => goTo(position)}
      />

      {/* Full-size photo viewer */}
      <Dialog open={!!lightbox} onOpenChange={(o) => !o && setLightbox(null)}>
        <DialogContent className="max-w-lg p-3">
          <DialogHeader className="px-2 pt-2">
            <DialogTitle className="text-sm">{lightbox?.label}</DialogTitle>
          </DialogHeader>
          {lightbox && (
            <img
              src={lightbox.url}
              alt={`${lightbox.label} — full size`}
              className="max-h-[75vh] w-full rounded-xl object-contain"
            />
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
