/**
 * Verify Payout Numbers — Financial Ops, focus mode.
 *
 * One case fills the screen at a time: the holder's National ID photo and
 * selfie dominate, the name-match result is a single glanceable signal, and
 * Call / WhatsApp / Verify / Reject are the only actions. Next/previous move
 * through the queue without returning to a list. The verification gate itself
 * lives in the database and the approve-withdrawal function.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { PayoutNameCheckHistory, logNameCheck, nameCheckHistoryKey } from './PayoutNameCheckHistory';
import {
  AlertTriangle,
  ArrowUpDown,
  BadgeCheck,
  Building2,
  Calendar as CalendarIcon,
  Camera,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Clock,
  HelpCircle,
  History,
  IdCard,
  Image,
  Link2,
  Loader2,
  MessageCircle,
  PhoneCall,
  RefreshCw,
  ScanLine,
  Search,
  ShieldAlert,
  Smartphone,
  Undo2,
  UserCheck,
  Users,
  X,
  XCircle,

} from 'lucide-react';
import { toast } from 'sonner';
import { format } from 'date-fns';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { DoubleSubmissionReasonPanel } from '@/components/financial-ops/DoubleSubmissionReasonPanel';

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Calendar } from '@/components/ui/calendar';
import { formatUGX } from '@/lib/rentCalculations';
import { assessIdNameConfidence } from '@/lib/idNameConfidence';
import { doubleSubmissionLabel } from '@/lib/doubleSubmission';
import {
  clearNameCheck,
  compareNames,
  loadNameCheck,
  networkForNumber,
  saveNameCheck,
  type PayoutNameCheck,
} from '@/lib/payoutNameCheck';
import { supabase } from '@/integrations/supabase/client';
import { PayoutQueueBlockedList, blockedReasonFor } from './PayoutQueueBlockedList';
import NationalIdLinkStaffQueue from './NationalIdLinkStaffQueue';
import PayoutNumberChangeQueue from './PayoutNumberChangeQueue';

import { useUserAvatars } from '@/hooks/useUserAvatars';
import { useAuth } from '@/hooks/useAuth';
import {
  identityPhotoUrl,
  useIdentityPhotosFor,
  useVerificationHistory,
} from '@/hooks/useIdentityPhotos';
import {
  PAYOUT_VERIFICATION_PAGE_SIZE,
  last9,
  useAdoptNationalIdName,
  useHolderNameHistory,
  useStoredIdReading,
  useStoredIdBackReading,
  usePayoutNumberOtpConfirmed,
  sameIdNumber,
  maskIdNumber,
  useDecidePayoutDestination,
  useRevertHolderName,
  useSetHolderName,


  usePayoutVerificationCounts,
  usePayoutVerificationQueue,
  usePersonPayoutDestinations,
  PayoutQueueError,
  type PayoutDestinationRow,
  type PayoutVerificationCounts,
  type PayoutQueueFilter,
  type PayoutQueueSort,
  type PayoutQueueUserType,
} from '@/hooks/usePayoutVerification';

const FILTERS: { id: PayoutQueueFilter; label: string; countKey?: keyof PayoutVerificationCounts }[] = [
  { id: 'waiting', label: 'Waiting', countKey: 'waiting' },
  { id: 'mismatch', label: 'Mismatch', countKey: 'mismatch' },
  { id: 'no_id', label: 'No ID', countKey: 'no_id' },
  { id: 'double', label: 'Double submissions', countKey: 'double' },
  { id: 'verified', label: 'Verified', countKey: 'verified' },
  { id: 'rejected', label: 'Rejected', countKey: 'rejected' },
  { id: 'all', label: 'All' },
];

/** Full technical detail of a failed queue request, for on-screen diagnosis. */
function QueueDiagnostics({ error }: { error: unknown }) {
  const [open, setOpen] = useState(true);
  const [copied, setCopied] = useState(false);
  const diag = error instanceof PayoutQueueError ? error.diagnostics : null;
  const plain = error instanceof Error ? error.message : String(error);

  const lines: { label: string; value: string }[] = [
    { label: 'Request', value: diag ? `database function · ${diag.endpoint}` : 'database function · finops_payout_verification_queue' },
    { label: 'Status', value: diag?.httpStatus != null ? `HTTP ${diag.httpStatus}` : 'no HTTP status returned' },
    { label: 'Error code', value: diag?.code || '—' },
    { label: 'Exact error', value: diag?.rawMessage || plain },
    { label: 'Details', value: diag?.details || '—' },
    { label: 'Hint', value: diag?.hint || '—' },
    { label: 'Signed-in account', value: diag?.signedInUserId || 'not signed in / unknown' },
    { label: 'Attempted at', value: diag ? `${diag.attemptedAt} (${diag.durationMs} ms)` : '—' },
    {
      label: 'Filters sent',
      value: diag?.params ? JSON.stringify(diag.params, null, 0) : '—',
    },
  ];

  const copyAll = async () => {
    try {
      await navigator.clipboard.writeText(lines.map((l) => `${l.label}: ${l.value}`).join('\n'));
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error('Could not copy. Select the text and copy it by hand.');
    }
  };

  return (
    <div className="rounded-xl border border-destructive/30 bg-background/70 p-3">
      <div className="flex items-center justify-between gap-2">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="text-xs font-semibold text-foreground underline underline-offset-2"
        >
          {open ? 'Hide technical details' : 'Show technical details'}
        </button>
        {open ? (
          <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" onClick={copyAll}>
            {copied ? 'Copied' : 'Copy details'}
          </Button>
        ) : null}
      </div>
      {open ? (
        <dl className="mt-2 space-y-1.5">
          {lines.map((l) => (
            <div key={l.label} className="grid grid-cols-[8.5rem_1fr] gap-2">
              <dt className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{l.label}</dt>
              <dd className="break-all font-mono text-[11px] leading-snug text-foreground">{l.value}</dd>
            </div>
          ))}
        </dl>
      ) : null}
    </div>
  );
}

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
function statusBadge(row: PayoutDestinationRow, isLinkedAutoVerified?: boolean): {
  label: string;
  Icon: typeof BadgeCheck;
  classes: string;
} {
  if (isLinkedAutoVerified)
    return {
      label: 'Linked · Auto-Verified',
      Icon: BadgeCheck,
      classes: 'bg-emerald-500/15 text-emerald-700 ring-1 ring-inset ring-emerald-500/40 dark:text-emerald-400 dark:ring-emerald-500/30',
    };
  if (row.status === 'verified')
    return { label: 'Verified', Icon: BadgeCheck, classes: 'bg-emerald-500/15 text-emerald-700 ring-1 ring-inset ring-emerald-500/40' };
  if (row.status === 'rejected')
    return { label: 'Rejected', Icon: XCircle, classes: 'bg-destructive/10 text-destructive ring-1 ring-inset ring-destructive/40' };
  if (row.name_match_score !== null && row.name_match_score < 0.5)
    return { label: 'Needs review', Icon: AlertTriangle, classes: 'bg-amber-500/15 text-amber-700 ring-1 ring-inset ring-amber-500/50' };
  return { label: 'Pending', Icon: Clock, classes: 'bg-sky-500/15 text-sky-700 ring-1 ring-inset ring-sky-500/40' };
}

/** 1 → "1st", 2 → "2nd", 3 → "3rd", else "Nth" — for the shared-ID banner. */
function ordinalLabel(n: number): string {
  const mod100 = n % 100;
  if (mod100 >= 11 && mod100 <= 13) return `${n}th`;
  switch (n % 10) {
    case 1: return `${n}st`;
    case 2: return `${n}nd`;
    case 3: return `${n}rd`;
    default: return `${n}th`;
  }
}

/** Calculate age in years from an ISO/YYYY-MM-DD date string. */
function ageFromDob(dob: string | null | undefined): number | null {
  if (!dob) return null;
  const birth = new Date(dob);
  if (Number.isNaN(birth.getTime())) return null;
  const today = new Date();
  let age = today.getFullYear() - birth.getFullYear();
  const monthDiff = today.getMonth() - birth.getMonth();
  const dayDiff = today.getDate() - birth.getDate();
  if (monthDiff < 0 || (monthDiff === 0 && dayDiff < 0)) age -= 1;
  return age >= 0 ? age : null;
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

/** The mobile money number or bank account the holder expects withdrawals to go to. */
function SavedPayoutNumberCard({ row }: { row: PayoutDestinationRow }) {
  const isMomo = row.destination_type === 'mobile_money';
  const number = isMomo
    ? row.momo_number
    : `${row.bank_name ?? ''} ${row.bank_account_number ?? ''}`.trim() || null;

  return (
    <div className="mx-5 mt-3 rounded-2xl border border-border bg-card p-3">
      <p className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-[0.15em] text-muted-foreground">
        {isMomo ? (
          <Smartphone className="h-3.5 w-3.5" aria-hidden="true" />
        ) : (
          <Building2 className="h-3.5 w-3.5" aria-hidden="true" />
        )}
        Saved withdrawal number
      </p>
      <div className="mt-2 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-sm font-bold text-foreground">{number ?? '—'}</p>
          <p className="truncate text-xs text-muted-foreground">
            {isMomo
              ? `${row.provider ?? 'Mobile money'} · ${row.account_name || 'Name not recorded'}`
              : row.account_name || 'Name not recorded'}
          </p>
        </div>
        {row.status === 'verified' && (
          <BadgeCheck className="mt-0.5 h-5 w-5 shrink-0 text-emerald-600 dark:text-emerald-400" aria-label="Verified" />
        )}
      </div>
    </div>
  );
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
 * Shown when the names do not match. The name printed on the National ID
 * automatically becomes the holder's name — nobody types or confirms anything.
 */
function IdNameMismatchCard({ row, onSaved }: { row: PayoutDestinationRow; onSaved: () => void }) {
  const adopt = useAdoptNationalIdName();
  const setHolderName = useSetHolderName();
  const idName = (row.national_id_name || '').trim();
  const accountName = (row.full_name || row.account_name || '').trim();
  const alreadySame = !!idName && idName.toLowerCase() === accountName.toLowerCase();
  const confidence = assessIdNameConfidence(idName);
  // finops_set_holder_name / useSetHolderName already existed for this exact
  // situation but had zero call sites anywhere in the frontend — there was no
  // button that could ever reach it, so a reviewer had no way to make a
  // correction stick against the auto-adopt effect below. correctionValue is
  // seeded from the account name (usually already correct, e.g. taken from a
  // verified selfie/withdrawal) so confirming it here is a one-click action.
  const [correctionValue, setCorrectionValue] = useState(accountName);
  const [showCorrection, setShowCorrection] = useState(false);
  // A Financial Ops manual override (finops_set_holder_name) is an explicit
  // human decision that the ID-read name is NOT the real name. Without this
  // check, every re-render of this card (case reopened, 30s queue poll,
  // navigating back to it) re-fires the auto-adopt effect below and silently
  // overwrites that decision with the same untrustworthy OCR text again —
  // this is the "every time the name goes back" bug: name_match_score stays
  // low (it is not recomputed after an override) so the card keeps rendering,
  // and neither `alreadySame` nor `confidence.confident` know a human already
  // rejected this exact ID reading.
  const humanOverridden = row.name_source === 'verified';
  const appliedRef = useRef<string | null>(null);

  // The ID name replaces the account name on its own, as soon as the case opens —
  // but only when the read is clean, and never once Financial Ops has manually
  // set the holder name (see `humanOverridden` above).
  useEffect(() => {
    if (alreadySame || !confidence.confident || humanOverridden) return;
    if (appliedRef.current === row.id) return;
    appliedRef.current = row.id;
    void (async () => {
      try {
        const res = await adopt.mutateAsync({ id: row.id });
        toast.success(`Name changed to ${res.full_name ?? idName}.`);
        // Tell the submitter their ID name is now their account name, so they
        // do not go looking for a way to change it themselves.
        void supabase.functions
          .invoke('notify-id-name-adopted', {
            body: { userId: row.user_id, idName: res.full_name ?? idName, previousName: accountName },
          })
          .catch(() => undefined);
        onSaved();
      } catch (e) {
        appliedRef.current = null;
        toast.error(e instanceof Error ? e.message : 'Could not change the name.');
      }
    })();

    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [row.id, idName, alreadySame, confidence.confident, humanOverridden]);

  // Reset the correction field when moving to a different case, so it never
  // shows a previous holder's name in the input.
  useEffect(() => {
    setCorrectionValue(accountName);
    setShowCorrection(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [row.id]);

  const flagged = !confidence.confident && !humanOverridden;

  return (
    <div
      className={`mx-5 mt-3 rounded-2xl border p-4 ${
        flagged ? 'border-destructive/50 bg-destructive/10' : humanOverridden ? 'border-emerald-500/40 bg-emerald-500/10' : 'border-amber-500/40 bg-amber-500/10'
      }`}
    >
      <p
        className={`flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-[0.2em] ${
          flagged ? 'text-destructive' : humanOverridden ? 'text-emerald-700 dark:text-emerald-400' : 'text-amber-700 dark:text-amber-400'
        }`}
      >
        <AlertTriangle className="h-3.5 w-3.5" aria-hidden="true" />
        {flagged ? 'Name on the ID needs checking' : 'Name on the National ID'}
      </p>
      <p className="mt-1.5 text-lg font-bold leading-tight text-foreground">{idName || 'Not read yet'}</p>
      <p className="mt-0.5 text-xs text-muted-foreground">On the account: {accountName || '—'}</p>
      {flagged ? (
        <p role="alert" className="mt-2 flex items-start gap-1.5 text-xs font-semibold text-destructive">
          <AlertTriangle className="mt-px h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          <span>
            {confidence.reason} The account name was left as it is — ask for a clearer ID photo before verifying.
          </span>
        </p>
      ) : humanOverridden ? (
        <p className="mt-2 flex items-start gap-1.5 text-xs font-semibold text-emerald-700 dark:text-emerald-400">
          <UserCheck className="mt-px h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          <span>
            Financial Ops set the account name manually — the ID reading above will not overwrite it again.
          </span>
        </p>
      ) : (
        <p className="mt-2 flex items-center gap-1.5 text-xs font-semibold text-amber-700 dark:text-amber-400">
          {adopt.isPending ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
          ) : (
            <UserCheck className="h-3.5 w-3.5" aria-hidden="true" />
          )}
          {adopt.isPending
            ? 'Applying the name from the ID…'
            : 'The name from the ID is now the name on the account.'}
        </p>
      )}

      {!humanOverridden && (
        showCorrection ? (
          <div className="mt-3 space-y-2">
            <Input
              value={correctionValue}
              onChange={(e) => setCorrectionValue(e.target.value)}
              placeholder="Full name as printed on the ID"
              className="h-9 text-sm"
              disabled={setHolderName.isPending}
            />
            <div className="flex gap-2">
              <Button
                type="button"
                size="sm"
                className="h-8 gap-1.5 rounded-full text-xs"
                disabled={setHolderName.isPending || correctionValue.trim().length < 3}
                onClick={() => {
                  setHolderName.mutate(
                    { id: row.id, fullName: correctionValue.trim() },
                    {
                      onSuccess: (res) => {
                        toast.success(`Name set to ${res.full_name || correctionValue.trim()}.`);
                        setShowCorrection(false);
                        onSaved();
                      },
                      onError: (err: Error) => toast.error(err.message),
                    },
                  );
                }}
              >
                {setHolderName.isPending ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                ) : (
                  <UserCheck className="h-3.5 w-3.5" aria-hidden="true" />
                )}
                Save this name
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="h-8 rounded-full text-xs"
                disabled={setHolderName.isPending}
                onClick={() => setShowCorrection(false)}
              >
                Cancel
              </Button>
            </div>
          </div>
        ) : (
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="mt-3 h-8 gap-1.5 rounded-full text-xs"
            onClick={() => setShowCorrection(true)}
          >
            <UserCheck className="h-3.5 w-3.5" aria-hidden="true" />
            {alreadySame || !confidence.confident ? 'Type the correct name' : 'Not this — type the correct name'}
          </Button>
        )
      )}
    </div>
  );
}

/** One line of the stored-reading card: a tick, a cross or a neutral dash. */
function CheckLine({
  label,
  value,
  outcome,
  note,
  className = '',
  singleLine = false,
}: {
  label?: string;
  value: string;
  outcome: boolean | null;
  note?: string | null;
  className?: string;
  singleLine?: boolean;
}) {
  const isCentered = singleLine && !note;
  return (
    <div
      className={`flex ${
        isCentered ? 'items-center' : 'items-start'
      } gap-2 rounded-xl bg-background/70 px-3 py-2 ${className}`}
    >
      {outcome === true ? (
        <CheckCircle2
          className={`${isCentered ? '' : 'mt-0.5 '}h-4 w-4 shrink-0 text-emerald-600 dark:text-emerald-400`}
          aria-hidden="true"
        />
      ) : outcome === false ? (
        <XCircle
          className={`${isCentered ? '' : 'mt-0.5 '}h-4 w-4 shrink-0 text-destructive`}
          aria-hidden="true"
        />
      ) : (
        <HelpCircle
          className={`${isCentered ? '' : 'mt-0.5 '}h-4 w-4 shrink-0 text-muted-foreground`}
          aria-hidden="true"
        />
      )}
      <div className="min-w-0 flex-1">
        {singleLine ? (
          <p className="text-xs font-semibold text-foreground">{value}</p>
        ) : (
          <>
            {label && (
              <p className="text-[10px] font-bold uppercase tracking-[0.15em] text-muted-foreground">
                {label}
              </p>
            )}
            <p className="text-sm font-bold tabular-nums text-foreground">{value}</p>
          </>
        )}
        {note && <p className="mt-0.5 text-[11px] leading-snug text-muted-foreground">{note}</p>}
      </div>
      <span className="sr-only">
        {outcome === true ? 'Checked' : outcome === false ? 'Does not match' : 'Nothing to compare'}
      </span>
    </div>
  );
}

/**
 * What was read off the National ID at submission, straight from the stored
 * reading — no re-read, no new check, no writes. ID numbers are shown part-
 * hidden (`CM****HJ`) so a reviewer can recognise the card without the panel
 * handing out a reusable number.
 */
function StoredIdReadingCard({ row }: { row: PayoutDestinationRow }) {
  const { data, isLoading } = useStoredIdReading(row.user_id);
  const numberConfirmed = usePayoutNumberOtpConfirmed(row.id);

  if (isLoading) {
    return (
      <div className="mx-5 mt-3 rounded-2xl border border-border bg-muted/40 p-4">
        <Skeleton className="h-4 w-40" />
        <Skeleton className="mt-3 h-12 w-full rounded-xl" />
      </div>
    );
  }
  if (!data) return null;

  const ninMatches = sameIdNumber(data.nin, row.national_id);
  const maskedNin = maskIdNumber(data.nin);
  const maskedCard = maskIdNumber(data.cardNumber);
  const enteredMask = maskIdNumber(row.national_id);
  const idNameOnFile = (row.national_id_name || '').trim();
  const accountName = (row.full_name || row.account_name || '').trim();
  const age = ageFromDob(data.dateOfBirth);
  // An exact spelling match is a match, whatever an older stored score says.
  const namesMatch =
    idNameOnFile && accountName
      ? idNameOnFile.toLowerCase() === accountName.toLowerCase()
        ? true
        : row.name_match_score !== null
          ? row.name_match_score >= 0.8
          : false
      : null;
  const otpPassed = numberConfirmed.data === true;

  const allClear = ninMatches === true && data.faceVerified === true && otpPassed;

  return (
    <div
      className={`mx-5 mt-3 rounded-2xl border p-4 ${
        allClear ? 'border-emerald-500/40 bg-emerald-500/10' : 'border-border bg-muted/40'
      }`}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-[0.2em] text-muted-foreground">
          <IdCard className="h-3.5 w-3.5" aria-hidden="true" /> Read from the National ID
        </p>
        <p className="text-[10px] font-semibold text-muted-foreground">
          {data.status === 'valid' ? 'Card read in full' : 'Card partly read'}
          {data.missing.length > 0 && ` · missing: ${data.missing.join(', ')}`}
        </p>
      </div>

      <div className="mt-2 grid gap-2 sm:grid-cols-2">
        <CheckLine
          label="ID number (NIN)"
          value={maskedNin ?? 'Not read'}
          outcome={ninMatches}
          note={
            ninMatches === false
              ? `Typed ${enteredMask ?? '—'} — different card.`
              : !ninMatches && !row.national_id
                ? 'No ID number typed yet.'
                : undefined
          }
        />
        <CheckLine
          label="Card number"
          value={maskedCard ?? 'Not read'}
          outcome={maskedCard ? true : null}
        />
        <CheckLine
          label="Sex"
          value={data.sex ?? 'Not read'}
          outcome={data.sex ? true : null}
        />
        <CheckLine
          label="Age"
          value={age != null ? `${age} years` : 'Not read'}
          outcome={age != null ? true : null}
        />
        <CheckLine
          singleLine
          value={
            data.faceVerified === true
              ? 'Face confirmed'
              : data.faceVerified === false
                ? 'Photo did not pass face check'
                : 'Face check not recorded'
          }
          outcome={data.faceVerified}
          note={data.faceVerified === false ? 'Ask for a new selfie.' : undefined}
        />
        <CheckLine
          singleLine
          value={
            otpPassed
              ? 'Code confirmed'
              : numberConfirmed.isLoading
                ? 'Checking confirmation code…'
                : 'No confirmed code for payout number'
          }
          outcome={numberConfirmed.isLoading ? null : otpPassed}
          note={
            !otpPassed && !numberConfirmed.isLoading
              ? 'Ask them to confirm payout number on the identity screen.'
              : undefined
          }
        />
        <CheckLine
          singleLine
          className="sm:col-span-2"
          value={
            row.is_linked_id
              ? 'Linked account — names differ as expected'
              : namesMatch === true
                ? `Names match${idNameOnFile ? `: ${idNameOnFile}` : ''}`
                : namesMatch === false
                  ? `Names differ: ${idNameOnFile || '—'} (ID) vs ${accountName || '—'} (account)`
                  : 'No name read off the card yet to compare'
          }
          outcome={row.is_linked_id ? true : namesMatch}
        />
      </div>

      <p className="mt-2 text-[11px] text-muted-foreground">
        {data.dateOfBirth ? `Born ${data.dateOfBirth} · ` : ''}
        {'Read '}
        {new Date(data.readAt).toLocaleString('en-GB', {
          day: '2-digit',
          month: 'short',
          year: 'numeric',
          hour: '2-digit',
          minute: '2-digit',
        })}
      </p>
    </div>
  );
}

/**
 * What was read off the BACK of the National ID, re-read from the archived photo
 * so reviewers see the same details the submitter confirmed: card number,
 * dates of issue/expiry, residence, MRZ state, and whether the photo looks like
 * the front again.
 */
function StoredIdBackReadingCard({
  row,
  backPath,
}: {
  row: PayoutDestinationRow;
  backPath: string | null;
}) {
  const { data, isLoading } = useStoredIdBackReading(backPath);
  const frontReading = useStoredIdReading(row.user_id);
  const frontCardNumber = frontReading.data?.cardNumber ?? null;

  if (!backPath) return null;
  if (isLoading) {
    return (
      <div className="mx-5 mt-3 rounded-2xl border border-border bg-muted/40 p-4">
        <Skeleton className="h-4 w-48" />
        <Skeleton className="mt-3 h-12 w-full rounded-xl" />
      </div>
    );
  }
  if (!data) return null;

  const backCard = (data.cardNumber ?? '').replace(/[^A-Za-z0-9]/g, '').toUpperCase();
  const frontCard = (frontCardNumber ?? '').replace(/[^A-Za-z0-9]/g, '').toUpperCase();
  const numbersMismatch =
    data.cardNumber != null && frontCardNumber != null && backCard !== frontCard && backCard.length > 3;

  return (
    <div className="mx-5 mt-3 rounded-2xl border border-border bg-muted/40 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-[0.2em] text-muted-foreground">
          <ScanLine className="h-3.5 w-3.5" aria-hidden="true" /> Read from the back of the National ID
        </p>
        <p className="text-[10px] font-semibold text-muted-foreground">
          {data.readable
            ? data.mrzPresent
              ? 'MRZ read'
              : 'Back partly read'
            : 'Could not read the back'}
        </p>
      </div>

      {data.looksLikeFront && (
        <p className="mt-2 rounded-md border-2 border-destructive/50 bg-destructive/10 p-2 text-xs font-bold text-destructive">
          The archived back photo looks like the FRONT of the card. Ask the person to retake the
          back — the side with the two lines of code at the bottom.
        </p>
      )}

      {data.details.length > 0 ? (
        <div className="mt-2 grid gap-2 sm:grid-cols-2">
          {data.details.map((d) => (
            <CheckLine
              key={d.label}
              label={d.label}
              value={d.value}
              outcome={true}
            />
          ))}
        </div>
      ) : (
        <p className="mt-2 text-xs text-muted-foreground">
          {data.error || 'No details could be read from the back photo.'}
        </p>
      )}

      {data.mrzPresent && data.checksumsOk === false && (
        <p className="mt-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-2 text-xs text-amber-700">
          The machine-readable lines on the back were read, but their check digits did not all
          match. Inspect the photo carefully before approving.
        </p>
      )}

      {numbersMismatch && (
        <p className="mt-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-2 text-xs text-amber-700">
          The card number on the back ({maskIdNumber(data.cardNumber)}) does not match the card
          number from the front ({maskIdNumber(frontCardNumber)}). Check both photos are of the
          same card.
        </p>
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
 * Earlier submissions for the same person. Every upload keeps its own
 * timestamped file, so when someone resends their ID and selfie the previous
 * ones stay readable here next to the current pair.
 */
function PriorSubmissions({
  userId,
  currentIdPath,
  currentSelfiePath,
  onOpen,
}: {
  userId: string | null | undefined;
  currentIdPath: string | null;
  currentSelfiePath: string | null;
  onOpen: (url: string, label: string) => void;
}) {
  const history = useVerificationHistory(userId);
  const older = (history.data ?? [])
    .filter(
      (e) =>
        (e.nationalId && e.nationalId.path !== currentIdPath) ||
        (e.original && e.original.path !== currentSelfiePath),
    )
    .slice(0, 4);

  if (older.length === 0) return null;

  return (
    <div className="mx-5 space-y-2 rounded-2xl bg-muted/40 p-3">
      <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-muted-foreground">
        Earlier submissions ({older.length})
      </p>
      <div className="flex gap-3 overflow-x-auto pb-1">
        {older.map((e) => (
          <div key={e.id} className="w-[132px] shrink-0 space-y-1">
            <div className="grid grid-cols-2 gap-1">
              {[
                { f: e.nationalId, label: 'National ID (earlier)' },
                { f: e.original, label: 'Selfie (earlier)' },
              ].map(({ f, label }, i) =>
                f?.url ? (
                  <button
                    key={i}
                    type="button"
                    onClick={() => onOpen(f.url!, label)}
                    aria-label={`Open ${label} full size`}
                    className="aspect-[4/5] overflow-hidden rounded-lg border bg-muted"
                  >
                    <img src={f.url} alt={label} className="h-full w-full object-cover" />
                  </button>
                ) : (
                  <div key={i} className="aspect-[4/5] rounded-lg border border-dashed bg-muted/40" />
                ),
              )}
            </div>
            <p className="text-[10px] text-muted-foreground">
              {e.submittedAt
                ? new Date(e.submittedAt).toLocaleString('en-GB', {
                    dateStyle: 'medium',
                    timeStyle: 'short',
                  })
                : 'Date unknown'}
            </p>
          </div>
        ))}
      </div>
    </div>
  );
}

function DecisionDialog({
  row,
  photosReady,
  idNameUnreadable,
  onClose,
  onSaved,
}: {
  row: PayoutDestinationRow | null;
  photosReady: boolean;
  idNameUnreadable: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const decide = useDecidePayoutDestination();
  const [reason, setReason] = useState('');
  const [callOutcome, setCallOutcome] = useState('');
  const [decision, setDecision] = useState<'verified' | 'rejected'>('verified');
  const isDouble = row?.double_submission === true;
  const doubleWhat = doubleSubmissionLabel(row?.double_kind);
  const verifyBlocked = !photosReady || idNameUnreadable || isDouble;

  useEffect(() => {
    setDecision(!photosReady || idNameUnreadable || isDouble ? 'rejected' : 'verified');
    setReason('');
    setCallOutcome('');
  }, [row, photosReady, idNameUnreadable, isDouble]);

  const submit = async () => {
    if (!row) return;
    if (decision === 'verified' && isDouble) {
      toast.error(`Double submission — this ${doubleWhat} already verifies another account. Only the first account may use it.`);
      return;
    }
    if (decision === 'verified' && !photosReady) {
      toast.error('Both the National ID photo and the selfie must be on file before verifying.');
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
        {isDouble && (
          <p role="alert" className="flex items-start gap-1.5 text-xs font-semibold text-destructive">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            Double submission — this {doubleWhat} already belongs to{' '}
            {row?.double_of_name || 'another account'}. Only the first account may be verified.
          </p>
        )}
        {!photosReady && (
          <p className="flex items-center gap-1.5 text-xs text-amber-600">
            <AlertTriangle className="h-3.5 w-3.5" />
            Verify unlocks once both photos are on file. Reject stays available.
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

/**
 * Mandatory step before Verify: the reviewer starts a send-money on their own
 * phone to this exact number, reads back the registered name the network shows,
 * types it here, and the two names are compared with the National ID name.
 */
// Audible alert for name-check outcomes, so a risky result is heard even when
// the checker is looking at their phone instead of the screen. A match plays a
// soft confirmation chime; a partial match two warning beeps; different names
// an urgent triple low-pitched alarm. Runs on a user gesture (Record tap), so
// browser autoplay rules allow it. Any audio failure is silent.
function playNameCheckAlert(outcome: 'match' | 'partial' | 'different') {
  try {
    const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    const beep = (freq: number, start: number, dur: number, gain = 0.22) => {
      const osc = ctx.createOscillator();
      const g = ctx.createGain();
      osc.type = 'square';
      osc.frequency.value = freq;
      g.gain.setValueAtTime(gain, ctx.currentTime + start);
      g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + start + dur);
      osc.connect(g).connect(ctx.destination);
      osc.start(ctx.currentTime + start);
      osc.stop(ctx.currentTime + start + dur);
    };
    if (outcome === 'match') {
      beep(880, 0, 0.12, 0.12);
      beep(1320, 0.14, 0.18, 0.12);
    } else if (outcome === 'partial') {
      beep(620, 0, 0.18);
      beep(620, 0.28, 0.18);
    } else {
      beep(330, 0, 0.22, 0.28);
      beep(330, 0.3, 0.22, 0.28);
      beep(330, 0.6, 0.34, 0.28);
    }
    // Close after the last tone so contexts don't pile up across checks.
    window.setTimeout(() => void ctx.close().catch(() => undefined), 1600);
  } catch {
    /* audio unavailable — the visual alert still shows */
  }
}

function PayoutNameCheckCard({
  row,
  check,
  onChange,
}: {
  row: PayoutDestinationRow;
  check: PayoutNameCheck | null;
  onChange: (next: PayoutNameCheck | null) => void;
}) {
  const [typed, setTyped] = useState('');
  const queryClient = useQueryClient();
  useEffect(() => setTyped(''), [row.id]);

  const idName = (row.national_id_name || '').trim();
  const isMomo = row.destination_type === 'mobile_money';
  const network = networkForNumber(row.provider, row.momo_number);
  const target = isMomo
    ? row.momo_number
    : `${row.bank_name ?? ''} ${row.bank_account_number ?? ''}`.trim();

  const record = () => {
    const networkName = typed.trim();
    if (networkName.length < 3) {
      toast.error('Type the full name exactly as it appeared on your phone.');
      return;
    }
    if (!idName) {
      toast.error('There is no name from the National ID to compare against yet.');
      return;
    }
    const outcome = compareNames(networkName, idName);
    const next: PayoutNameCheck = { networkName, outcome, checkedAt: new Date().toISOString() };
    saveNameCheck(row.id, next);
    onChange(next);
    playNameCheckAlert(outcome);
    logNameCheck({
      destinationId: row.id,
      subjectUserId: row.user_id ?? null,
      payoutTarget: target,
      network: isMomo ? network.label : row.bank_name ?? 'Bank',
      checkedName: networkName,
      idName,
      outcome,
    })
      .then(() => queryClient.invalidateQueries({ queryKey: nameCheckHistoryKey(row.id) }))
      .catch((e) => toast.error(`Name check not saved to history: ${e?.message ?? e}`));
    if (outcome === 'match') toast.success('Names are the same. Verify is now open.');
    else if (outcome === 'partial') toast.warning('Names only partly agree — Verify will need your written confirmation.');
    else toast.error('Different names — do not verify. Reject or call the holder.');
  };

  const tone =
    check?.outcome === 'match'
      ? 'border-emerald-500/50 bg-emerald-500/10'
      : check?.outcome === 'partial'
        ? 'border-amber-500/50 bg-amber-500/10'
        : check?.outcome === 'different'
          ? 'border-destructive/50 bg-destructive/10'
          : 'border-primary/40 bg-primary/5';

  return (
    <div className={`mx-5 mt-3 rounded-2xl border-2 p-4 ${tone}`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-[0.2em] text-muted-foreground">
          <Smartphone className="h-3.5 w-3.5" aria-hidden="true" /> Step 1 — name check on the number
        </p>
        {check && (
          <span
            role={check.outcome === 'match' ? undefined : 'alert'}
            className={`rounded-full px-2.5 py-1 text-[10px] font-extrabold uppercase tracking-widest ${
              check.outcome === 'match'
                ? 'bg-emerald-500/20 text-emerald-700 dark:text-emerald-400'
                : check.outcome === 'partial'
                  ? 'animate-pulse bg-amber-500 text-white'
                  : 'animate-pulse bg-destructive text-destructive-foreground'
            }`}
          >
            {check.outcome === 'match'
              ? 'Same person'
              : check.outcome === 'partial'
                ? '⚠ Partly agrees'
                : '⚠ Different name'}
          </span>
        )}
      </div>

      {/* Prominent how-to-check guide */}
      <div className="mt-3 rounded-xl border-2 border-amber-500/60 bg-amber-500/10 p-3">
        <p className="flex items-center gap-1.5 text-xs font-extrabold uppercase tracking-wide text-amber-700 dark:text-amber-400">
          <ShieldAlert className="h-4 w-4" aria-hidden="true" />
          How to check this number before verifying
        </p>
        <ol className="mt-2 list-decimal space-y-1.5 pl-4 text-xs text-foreground">
          {isMomo ? (
            <>
              <li>
                On <strong>your own phone</strong>, open {network.label} Mobile Money.
              </li>
              <li>
                Start <strong>Send Money</strong>{' '}
                {network.ussd ? (
                  <span className="font-semibold">({network.ussd})</span>
                ) : null}{' '}
                and enter <strong>{target || '—'}</strong>.
              </li>
              <li>
                <strong>Do not press OK.</strong> Just read the registered name the network shows
                on the confirmation screen.
              </li>
              <li>
                Compare that name with the National ID name below. They must be the same person.
              </li>
              <li>Type the exact name the network showed, then tap Record.</li>
            </>
          ) : (
            <>
              <li>
                Call the bank on <strong>{target || '—'}</strong>.
              </li>
              <li>Ask them to confirm the account holder name.</li>
              <li>Compare that name with the National ID name below.</li>
              <li>Type the exact name they gave you, then tap Record.</li>
            </>
          )}
        </ol>
        <p className="mt-2 text-[11px] font-bold text-destructive">
          Do not send any money. This is only a name check.
        </p>
      </div>

      <div className="mt-3 rounded-xl border border-border bg-background/70 p-2.5">
        <p className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
          Name on the National ID
        </p>
        <p className="truncate text-sm font-bold text-foreground">{idName || '—'}</p>
      </div>

      {check ? (
        <div className="mt-2 space-y-2">
          {/* The recorded network name is the decision-critical value — render it
              large, loud and colour-coded by outcome so it cannot be missed. */}
          <div
            className={`rounded-xl border-2 p-3 ${
              check.outcome === 'match'
                ? 'border-emerald-500 bg-emerald-500/15'
                : check.outcome === 'partial'
                  ? 'border-amber-500 bg-amber-500/15'
                  : 'border-destructive bg-destructive/15'
            }`}
          >
            <p className="text-[11px] font-extrabold uppercase tracking-[0.2em] text-muted-foreground">
              Name the network showed
            </p>
            <p
              className={`mt-0.5 break-words text-2xl font-extrabold leading-tight ${
                check.outcome === 'match'
                  ? 'text-emerald-700 dark:text-emerald-400'
                  : check.outcome === 'partial'
                    ? 'text-amber-700 dark:text-amber-400'
                    : 'text-destructive'
              }`}
            >
              {check.networkName}
            </p>
          </div>
          {check.outcome !== 'match' && (
            <div
              role="alert"
              className={`animate-pulse rounded-xl border-2 p-3 ${
                check.outcome === 'partial'
                  ? 'border-amber-600 bg-amber-500/25'
                  : 'border-destructive bg-destructive/25'
              }`}
            >
              <p
                className={`flex items-center gap-1.5 text-sm font-extrabold uppercase tracking-wide ${
                  check.outcome === 'partial' ? 'text-amber-700 dark:text-amber-400' : 'text-destructive'
                }`}
              >
                <ShieldAlert className="h-5 w-5 shrink-0" aria-hidden="true" />
                {check.outcome === 'partial'
                  ? 'Warning: names only partly agree'
                  : 'Danger: the names are different'}
              </p>
              <p className="mt-1 text-sm font-bold text-foreground">
                These are not clearly the same person. Call the holder first — Verify will ask for a
                written reason and your confirmation.
              </p>
            </div>
          )}
          <Button
            variant="outline"
            className="h-10 w-full rounded-xl text-xs font-bold uppercase tracking-widest"
            onClick={() => {
              clearNameCheck(row.id);
              onChange(null);
              setTyped('');
            }}
          >
            <RefreshCw className="mr-1.5 h-3.5 w-3.5" /> Redo the name check
          </Button>
        </div>
      ) : (
        <div className="mt-2 space-y-2">
          <Input
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            placeholder="Type the name your phone showed"
            className="h-11 text-sm"
            aria-label="Name shown by the mobile money or bank lookup"
          />
          <Button
            className="h-11 w-full rounded-xl text-xs font-bold uppercase tracking-widest"
            onClick={record}
          >
            <UserCheck className="mr-1.5 h-4 w-4" /> Record the name check
          </Button>
        </div>
      )}
      <PayoutNameCheckHistory destinationId={row.id} />
    </div>
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

/**
 * Compact informational card rendered for linked accounts where the National ID
 * holder has approved the link request. Payout is auto-verified immediately upon
 * holder approval; staff does not manually call or gate money movement.
 */
function LinkedAutoVerifiedCard({
  row,
  linkRequest,
}: {
  row: PayoutDestinationRow;
  linkRequest?: {
    id: string;
    nin?: string;
    status: string;
    owner_confirmed_at: string | null;
    created_at?: string | null;
  } | null;
}) {
  const holderName = row.linked_id_holder || row.national_id_name || 'National ID Holder';
  const approvedAt = linkRequest?.owner_confirmed_at || row.decided_at || row.first_seen_at;
  const approvedFormatted = approvedAt
    ? new Date(approvedAt).toLocaleString('en-GB', {
        day: '2-digit',
        month: 'short',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      })
    : 'Recently';

  const recordId = linkRequest?.id;
  const isAwaitingStaffAudit = linkRequest?.status === 'owner_approved';

  const scrollToReviewRecord = () => {
    if (recordId) {
      const targetEl = document.getElementById(`national-id-link-record-${recordId}`);
      if (targetEl) {
        targetEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
        targetEl.classList.add('ring-2', 'ring-primary', 'ring-offset-2');
        setTimeout(() => {
          targetEl.classList.remove('ring-2', 'ring-primary', 'ring-offset-2');
        }, 2500);
        return;
      }
    }
    const queueEl = document.getElementById('national-id-link-staff-queue');
    if (queueEl) {
      queueEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } else {
      toast.info(
        recordId
          ? `Link review record ${recordId.slice(0, 8)} is recorded on file.`
          : 'National ID link is confirmed on file.'
      );
    }
  };

  return (
    <div className="mx-5 my-4 overflow-hidden rounded-2xl border border-emerald-500/40 bg-emerald-500/5 p-4 shadow-sm dark:border-emerald-500/25 dark:bg-emerald-950/20">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2.5">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-emerald-500/20 text-emerald-700 dark:text-emerald-400">
            <BadgeCheck className="h-5 w-5" />
          </div>
          <div>
            <p className="text-xs font-bold uppercase tracking-wider text-emerald-800 dark:text-emerald-300">
              Verified via National ID Link
            </p>
            <p className="text-[11px] text-muted-foreground">
              Destination auto-verified upon holder approval · No manual verification needed
            </p>
          </div>
        </div>
        <span className="shrink-0 rounded-full bg-emerald-500/15 px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider text-emerald-700 ring-1 ring-inset ring-emerald-500/30 dark:text-emerald-400">
          Auto-Verified
        </span>
      </div>

      <div className="mt-3 grid gap-2 rounded-xl border border-emerald-500/20 bg-background/80 px-3.5 py-2.5 text-xs sm:grid-cols-2">
        <div className="flex items-center gap-2 font-semibold text-foreground">
          <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-600 dark:text-emerald-400" aria-hidden="true" />
          <span>
            Approved by {holderName}
            {row.national_id ? ` (${maskIdNumber(row.national_id)})` : ''}
          </span>
        </div>
        <div className="flex items-center gap-2 font-semibold text-foreground">
          <Clock className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          <span>Approved on {approvedFormatted}</span>
        </div>
      </div>

      <div className="mt-3.5 flex flex-wrap items-center justify-between gap-2 border-t border-emerald-500/20 pt-3">
        <p className="flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground">
          <Link2 className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400" />
          <span>
            {isAwaitingStaffAudit
              ? 'Staff role: Link record awaiting audit in queue above'
              : 'Staff role: Informational audit record'}
          </span>
        </p>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={scrollToReviewRecord}
          className="h-8 gap-1 rounded-lg border-emerald-500/40 text-xs font-semibold text-emerald-700 hover:bg-emerald-500/10 hover:text-emerald-800 dark:text-emerald-400 dark:hover:text-emerald-300"
        >
          <span>View National ID link review record</span>
          <ChevronRight className="h-3.5 w-3.5" />
        </Button>
      </div>
    </div>
  );
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
  const [dateFrom, setDateFrom] = useState<Date | undefined>(undefined);
  const [dateTo, setDateTo] = useState<Date | undefined>(undefined);
  const [userType, setUserType] = useState<PayoutQueueUserType>('all');
  const [page, setPage] = useState(0);
  const [index, setIndex] = useState(0);
  const [deciding, setDeciding] = useState(false);
  const [confirmingVerify, setConfirmingVerify] = useState<PayoutDestinationRow | null>(null);
  const [lightbox, setLightbox] = useState<{ url: string; label: string } | null>(null);
  const [personNumbersOpen, setPersonNumbersOpen] = useState(false);
  const focusCardRef = useRef<HTMLDivElement | null>(null);
  const skipInitialScrollRef = useRef(true);

  const quickVerify = useDecidePayoutDestination();
  const counts = usePayoutVerificationCounts();
  const queue = usePayoutVerificationQueue({
    status,
    search,
    sort,
    page,
    dateFrom: dateFrom ? format(dateFrom, 'yyyy-MM-dd') : null,
    dateTo: dateTo ? format(dateTo, 'yyyy-MM-dd') : null,
    userType,
  });

  const total = queue.data?.total ?? 0;
  const rows = useMemo(() => queue.data?.rows ?? [], [queue.data?.rows]);
  const row: PayoutDestinationRow | null = rows[Math.min(index, rows.length - 1)] ?? null;

  const photos = useIdentityPhotosFor(row?.user_id);
  const personNumbers = usePersonPayoutDestinations(row?.user_id, personNumbersOpen);
  const idPath = photos.data?.national_id_photo_path ?? null;
  const idBackPath = photos.data?.national_id_back_photo_path ?? null;
  const selfiePath = photos.data?.selfie_photo_path ?? null;
  const photosReady = !!idPath && !!selfiePath;
  // Verify must stay off until the ID photo has been read and produced a name we
  // are confident about — a doubtful read is flagged, never used as the name.
  const idNameConfidence = assessIdNameConfidence(row?.national_id_name);
  const idNameUnreadable = !!idPath && !idNameConfidence.confident;
  // One National ID and one phone number verify one account only: every later
  // account is a double submission and can never be verified.
  const isDouble = row?.double_submission === true;
  const doubleWhat = doubleSubmissionLabel(row?.double_kind);
  // Every payout number must first be name-checked on the network, exactly as
  // though money were being sent, and the name must be the same person as the
  // National ID. Until that is recorded and agrees, Verify stays off.
  const [nameCheck, setNameCheck] = useState<PayoutNameCheck | null>(null);
  useEffect(() => {
    setNameCheck(loadNameCheck(row?.id));
  }, [row?.id]);
  const nameCheckPassed = nameCheck?.outcome === 'match';
  // A partial or different name no longer hard-blocks Verify, but it requires a
  // written reason and an explicit ownership confirmation in the confirm step.
  const nameCheckNeedsOverride = !!nameCheck && nameCheck.outcome !== 'match';
  const [overrideNote, setOverrideNote] = useState('');
  const [overrideAck, setOverrideAck] = useState(false);
  useEffect(() => {
    setOverrideNote('');
    setOverrideAck(false);
  }, [confirmingVerify?.id, nameCheck?.checkedAt]);
  // When the Verify confirmation opens on a partial or different name, play the
  // alert again — this is the final moment a risky payout can still be stopped.
  useEffect(() => {
    if (confirmingVerify && nameCheck && nameCheck.outcome !== 'match') {
      playNameCheckAlert(nameCheck.outcome);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [confirmingVerify?.id]);
  const overrideReady = overrideNote.trim().length >= 10 && overrideAck;
  const verifyBlocked = !photosReady || idNameUnreadable || isDouble || !nameCheck;

  const linkRequestQuery = useQuery({
    queryKey: ['national-id-link-for-user', row?.user_id],
    enabled: !!row?.user_id,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('national_id_link_requests')
        .select('id, nin, status, owner_confirmed_at, code_verified_at, created_at, expires_at, holder_id')
        .eq('requester_id', row!.user_id)
        .in('status', ['owner_approved', 'active'])
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) return null;
      return data;
    },
  });

  const associatedLink = linkRequestQuery.data;
  const isLinkedCase = Boolean(
    (associatedLink && (associatedLink.status === 'owner_approved' || associatedLink.status === 'active')) ||
    row?.is_linked_id
  );



  const { avatarFor } = useUserAvatars(row ? [row.user_id] : []);

  // Keep the pointer valid whenever the queue contents shift.
  useEffect(() => {
    if (index >= rows.length) setIndex(0);
  }, [rows.length, index]);

  // Whenever the active case changes (Verify, Next, Previous, or list tap),
  // bring the focus card into view so the next person is immediately visible.
  useEffect(() => {
    if (skipInitialScrollRef.current) {
      skipInitialScrollRef.current = false;
      return;
    }
    const el = focusCardRef.current;
    if (!el) return;
    // Defer one frame so the new card has rendered and layout is stable.
    requestAnimationFrame(() => {
      el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  }, [row?.id]);

  const position = total === 0 ? 0 : page * PAYOUT_VERIFICATION_PAGE_SIZE + index + 1;

  /* One person can have several payout numbers waiting, so the queue holds one
     card per number. Navigation therefore has two moves: the next NUMBER for
     the same person, and the next real PERSON (skipping the rest of their
     numbers). */
  const sameUserIdx = useMemo(
    () => (row ? rows.map((r, i) => (r.user_id === row.user_id ? i : -1)).filter((i) => i >= 0) : []),
    [rows, row],
  );
  const nextSameIdx = useMemo(() => sameUserIdx.find((i) => i > index) ?? -1, [sameUserIdx, index]);
  const nextPersonIdx = useMemo(
    () => (row ? rows.findIndex((r, i) => i > index && r.user_id !== row.user_id) : -1),
    [rows, index, row],
  );
  const prevPersonIdx = useMemo(() => {
    if (!row) return -1;
    let i = index - 1;
    while (i >= 0 && rows[i].user_id === row.user_id) i -= 1;
    if (i < 0) return -1;
    const otherUser = rows[i].user_id;
    while (i > 0 && rows[i - 1].user_id === otherUser) i -= 1;
    return i;
  }, [rows, index, row]);
  const personNumbersInQueue = sameUserIdx.length;
  const personNumberPosition = Math.max(1, sameUserIdx.indexOf(index) + 1);

  const goNextPerson = () => {
    if (nextPersonIdx >= 0) setIndex(nextPersonIdx);
    else goTo((page + 1) * PAYOUT_VERIFICATION_PAGE_SIZE);
  };
  const goPrevPerson = () => {
    if (prevPersonIdx >= 0) setIndex(prevPersonIdx);
    else goTo(position - 2);
  };

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

  // One tap verifies and saves everything: the National ID name becomes the
  // account name, the note is written for the audit trail, and the queue moves on.
  const runQuickVerify = async (target: PayoutDestinationRow, overrideReason: string | null = null) => {
    try {
      await quickVerify.mutateAsync({
        id: target.id,
        userId: target.user_id,
        decision: 'verified',
        reason:
          'Verified by Financial Ops: National ID photo, selfie and payout number checked; name taken from the National ID.' +
          (nameCheck
            ? nameCheck.outcome === 'match'
              ? ` Name check on the payout number showed "${nameCheck.networkName}" — same person as the National ID.`
              : ` Name check on the payout number showed "${nameCheck.networkName}" — ${
                  nameCheck.outcome === 'partial' ? 'only partly agrees with' : 'different from'
                } the National ID. Reviewer confirmed ownership: ${overrideReason ?? ''}`
            : ''),
      });
      const idName = (target.national_id_name || '').trim();
      const before = (target.full_name || target.account_name || '').trim();
      if (
        assessIdNameConfidence(idName).confident &&
        idName.toLowerCase() !== before.toLowerCase()
      ) {
        void supabase.functions
          .invoke('notify-id-name-adopted', {
            body: { userId: target.user_id, idName, previousName: before },
          })
          .catch(() => undefined);
      }
      toast.success('Verified. The name from the ID is saved on the account.');

      // Move on to the next case. Under a filtered list (Waiting, Mismatch,
      // No ID, Double) the verified row leaves the queue, so the next case
      // A decided case leaves every queue cache immediately (see the mutation),
      // so the next person slides into the same position on their own. When the
      // decision happened on the very last case, step back one so a case is
      // always on screen.
      if (position > 1 && position >= total) goTo(position - 2);

      queue.refetch();
      counts.refetch();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not save the decision.');
    }
  };

  /* Nothing verifies itself. The machine checks (ID number read off the card,
     the face check and the SMS ownership code) are shown to the reviewer as
     evidence on each case, and a Financial Ops decision is what opens or
     closes withdrawals for that person. */




  return (
    <div className="space-y-3">
      {/* Withdrawal number changes waiting on a Financial Ops decision. */}
      <PayoutNumberChangeQueue />

      {/* National ID groups the holder has already allowed, waiting on staff. */}
      <NationalIdLinkStaffQueue />

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
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="h-8 w-8 shrink-0 rounded-full p-0"
            aria-label="Refresh the queue"
            title="Refresh the queue"
            onClick={() => {
              void queue.refetch();
              counts.refetch();
            }}
            disabled={queue.isFetching}
          >
            {queue.isFetching ? (
              <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" aria-hidden="true" />
            ) : (
              <RefreshCw className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
            )}
          </Button>
        </div>
        <p className="text-[11px] text-muted-foreground" aria-live="polite">
          {queue.isFetching
            ? 'Checking for new cases…'
            : queue.dataUpdatedAt
              ? `Updated ${new Date(queue.dataUpdatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} · refreshes on its own`
              : 'Refreshes on its own'}
        </p>
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
          <Select
            value={sort}
            onValueChange={(v) => {
              setSort(v as PayoutQueueSort);
              setPage(0);
              setIndex(0);
            }}
          >
            <SelectTrigger className="h-10 w-auto shrink-0 gap-1.5 rounded-lg border-border bg-card px-3 text-xs font-semibold" aria-label="Sort the waiting list">
              <ArrowUpDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              <SelectValue />
            </SelectTrigger>
            <SelectContent align="end">
              <SelectItem value="ready_first">Ready first</SelectItem>
              <SelectItem value="newest">Newest first</SelectItem>
              <SelectItem value="oldest">Oldest first</SelectItem>
              <SelectItem value="balance">Biggest balance</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Popover>
            <PopoverTrigger asChild>
              <button
                type="button"
                aria-label="Filter from date"
                className={`h-9 rounded-lg border border-border bg-card px-3 text-xs font-semibold ${dateFrom ? 'text-foreground' : 'text-muted-foreground'}`}
              >
                <CalendarIcon className="mr-1.5 inline h-3.5 w-3.5" />
                {dateFrom ? format(dateFrom, 'dd MMM yyyy') : 'From date'}
              </button>
            </PopoverTrigger>
            <PopoverContent className="w-auto p-0" align="start">
              <Calendar
                mode="single"
                selected={dateFrom}
                onSelect={(d) => { setDateFrom(d); setPage(0); setIndex(0); }}
                initialFocus
                className="pointer-events-auto p-3"
              />
            </PopoverContent>
          </Popover>
          <Popover>
            <PopoverTrigger asChild>
              <button
                type="button"
                aria-label="Filter to date"
                className={`h-9 rounded-lg border border-border bg-card px-3 text-xs font-semibold ${dateTo ? 'text-foreground' : 'text-muted-foreground'}`}
              >
                <CalendarIcon className="mr-1.5 inline h-3.5 w-3.5" />
                {dateTo ? format(dateTo, 'dd MMM yyyy') : 'To date'}
              </button>
            </PopoverTrigger>
            <PopoverContent className="w-auto p-0" align="start">
              <Calendar
                mode="single"
                selected={dateTo}
                onSelect={(d) => { setDateTo(d); setPage(0); setIndex(0); }}
                initialFocus
                className="pointer-events-auto p-3"
              />
            </PopoverContent>
          </Popover>
          <Select
            value={userType}
            onValueChange={(v) => { setUserType(v as PayoutQueueUserType); setPage(0); setIndex(0); }}
          >
            <SelectTrigger className="h-9 w-auto shrink-0 rounded-lg border-border bg-card px-3 text-xs font-semibold" aria-label="Filter by person type">
              <SelectValue />
            </SelectTrigger>
            <SelectContent align="end">
              <SelectItem value="all">All people</SelectItem>
              <SelectItem value="funder">Funders</SelectItem>
              <SelectItem value="tenant">Tenants</SelectItem>
              <SelectItem value="other">Others</SelectItem>
            </SelectContent>
          </Select>
          {(dateFrom || dateTo || userType !== 'all') && (
            <button
              type="button"
              onClick={() => { setDateFrom(undefined); setDateTo(undefined); setUserType('all'); setPage(0); setIndex(0); }}
              className="h-9 rounded-lg px-2 text-xs font-semibold text-muted-foreground underline-offset-2 hover:underline"
            >
              Clear
            </button>
          )}
        </div>
        <div className="flex gap-1.5 overflow-x-auto pb-0.5">
          {FILTERS.map((f) => {
            const selected = status === f.id;
            const count = f.countKey && counts.data ? counts.data[f.countKey] : null;
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
                {count !== null ? <span className={selected ? 'opacity-80' : 'text-muted-foreground'}> · {count}</span> : null}
              </button>
            );
          })}
        </div>
      </div>

      {/* Focus card */}
      {queue.isLoading ? (
        <Skeleton className="h-[28rem] w-full rounded-[2rem]" />
      ) : queue.isError ? (
        <div className="space-y-3 rounded-2xl border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">
          <p className="font-semibold">The list could not be loaded</p>
          <p>{queue.error instanceof Error ? queue.error.message : 'Something went wrong.'}</p>
          <QueueDiagnostics error={queue.error} />
          <Button size="sm" variant="outline" onClick={() => queue.refetch()}>
            Try again
          </Button>
        </div>
      ) : !row ? (
        <div className="rounded-2xl border border-border bg-card p-10 text-center">
          <BadgeCheck className="mx-auto mb-2 h-8 w-8 text-primary" />
          <p className="text-sm font-semibold text-foreground">Nothing waiting here</p>
        </div>
      ) : (
        <div
          ref={focusCardRef}
          key={row.id}
          className="overflow-hidden rounded-[2rem] border border-primary/10 bg-card shadow-xl shadow-primary/5 scroll-mt-4"
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
              const badge = statusBadge(row, isLinkedCase);
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
            {row.national_id && (
              <span
                role="status"
                aria-label={row.is_linked_id ? 'This National ID was already in the system; this person linked to it' : 'This National ID is new to the platform'}
                className={`flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-1 text-[10px] font-bold uppercase tracking-wide ${
                  row.is_linked_id
                    ? 'border-2 border-sky-500/70 bg-sky-500/15 text-sky-700 dark:text-sky-400'
                    : 'bg-muted text-muted-foreground'
                }`}
              >
                {row.is_linked_id ? (
                  <Link2 className="h-3.5 w-3.5" aria-hidden="true" />
                ) : (
                  <IdCard className="h-3.5 w-3.5" aria-hidden="true" />
                )}
                {row.is_linked_id ? 'Linked ID' : 'New ID'}
              </span>
            )}
            {row.payout_number_count > 1 && (
              <button
                type="button"
                onClick={() => setPersonNumbersOpen(true)}
                aria-label={`This person has made ${row.payout_number_count} payout number requests. Open the full list.`}
                className="flex shrink-0 items-center gap-1.5 rounded-full border-2 border-amber-500/70 bg-amber-500/15 px-2 py-1 text-[10px] font-bold uppercase tracking-wide text-amber-700 transition hover:bg-amber-500/25 dark:text-amber-400"
              >
                <Smartphone className="h-3.5 w-3.5" aria-hidden="true" />
                <span className="rounded-full bg-amber-600 px-1.5 py-0.5 text-[11px] font-extrabold leading-none text-white">
                  {row.payout_number_count}
                </span>
                requests · tap to see all
              </button>
            )}
          </div>

          {isDouble && (
            <DoubleSubmissionReasonPanel
              userId={row.user_id}
              thisName={row.full_name || row.account_name}
              thisPhone={row.user_phone}
              thisNationalId={row.national_id}
              kind={row.double_kind}
              firstName={row.double_of_name}
            />
          )}


          {row.verified_payout_count > 0 && (
            <div
              role="alert"
              className="mx-5 mt-2 rounded-2xl border-2 border-amber-500/80 bg-amber-500/10 p-4 shadow-lg shadow-amber-500/10"
            >
              <div className="flex items-start gap-3">
                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-amber-500/20">
                  <Smartphone className="h-4 w-4 text-amber-700 dark:text-amber-400" aria-hidden="true" />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="text-base font-extrabold leading-tight text-amber-800 dark:text-amber-300">
                    This person already has {row.verified_payout_count} verified payout{' '}
                    {row.verified_payout_count === 1 ? 'number' : 'numbers'}
                  </p>
                  <p className="mt-1 text-sm font-semibold text-amber-800/90 dark:text-amber-300/90">
                    They are now asking to use a different one. Confirm with them why before verifying.
                  </p>
                  <ul className="mt-2 space-y-1">
                    {row.verified_payout_numbers.map((v, i) => (
                      <li
                        key={i}
                        className="flex flex-wrap items-center gap-x-2 rounded-lg bg-amber-500/10 px-2.5 py-1.5 text-sm font-bold text-amber-900 dark:text-amber-200"
                      >
                        <BadgeCheck className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                        <span>
                          {ordinalLabel(i + 1)} verified:{' '}
                          {v.momo_number || v.bank_account_number || '—'}
                          {v.provider ? ` (${v.provider})` : v.bank_name ? ` (${v.bank_name})` : ''}
                        </span>
                        {v.decided_at && (
                          <span className="text-xs font-semibold opacity-80">
                            verified {new Date(v.decided_at).toLocaleDateString('en-UG', { day: 'numeric', month: 'short', year: 'numeric' })}
                          </span>
                        )}
                      </li>
                    ))}
                  </ul>
                </div>
              </div>
            </div>
          )}

          {row.national_id && (row.is_linked_id || row.id_account_count <= 1) && (
            <div
              role="status"
              className={`mx-5 mt-2 rounded-2xl border p-4 ${
                row.is_linked_id
                  ? 'border-sky-500/60 bg-sky-500/10'
                  : 'border-border bg-muted/40'
              }`}
            >
              <div className="flex items-start gap-3">
                <span
                  className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full ${
                    row.is_linked_id ? 'bg-sky-500/20' : 'bg-muted'
                  }`}
                >
                  {row.is_linked_id ? (
                    <Link2 className="h-4 w-4 text-sky-700 dark:text-sky-400" aria-hidden="true" />
                  ) : (
                    <IdCard className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
                  )}
                </span>
                <div className="min-w-0 flex-1">
                  {row.is_linked_id ? (
                    <>
                      <p className="text-base font-extrabold leading-tight text-sky-800 dark:text-sky-300">
                        {row.linked_id_is_this_one
                          ? 'This National ID is already in the system — linked account'
                          : 'This account is linked to another National ID'}
                      </p>
                      <p className="mt-1 text-sm font-semibold text-sky-800/90 dark:text-sky-300/90">
                        {row.linked_id_is_this_one ? (
                          <>
                            This person joined an existing ID
                            {row.linked_id_holder ? ` held by ${row.linked_id_holder}` : ''} through the
                            ID-link process, which the ID holder approved. The names here were typed by
                            the person, not read fresh from a new card.
                          </>
                        ) : (
                          <>
                            The ID submitted here
                            {row.id_account_count > 1 ? '' : ' is new, but '} this account is also linked
                            to a different National ID
                            {row.linked_id_holder ? ` held by ${row.linked_id_holder}` : ''}. Check both
                            before verifying.
                          </>
                        )}
                      </p>
                    </>
                  ) : (
                    <>
                      <p className="text-sm font-extrabold leading-tight text-foreground">
                        New National ID — first time seen on the platform
                      </p>
                      <p className="mt-1 text-xs font-semibold text-muted-foreground">
                        No other account is linked to this ID. Treat the card photos as the only evidence of who holds it.
                      </p>
                    </>
                  )}
                </div>
              </div>
            </div>
          )}

          {row.id_account_count > 1 && (
            <div
              role="alert"
              className="mx-5 mt-2 rounded-2xl border-2 border-destructive/80 bg-destructive/10 p-4 shadow-lg shadow-destructive/10"
            >
              <div className="flex items-start gap-3">
                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-destructive/20">
                  <ShieldAlert className="h-4 w-4 text-destructive" aria-hidden="true" />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="text-base font-extrabold leading-tight text-destructive">
                    This National ID is on {row.id_account_count} accounts
                  </p>
                  <p className="mt-1 text-sm font-semibold text-destructive/90">
                    This is the {ordinalLabel(row.id_account_ordinal)} account using this ID.
                    {row.id_account_ordinal > 1
                      ? ' An earlier account already holds this ID — confirm you are reviewing the right person before verifying.'
                      : ' This is the first account with this ID; the others appeared later.'}
                  </p>
                </div>
              </div>
            </div>
          )}

          {/* Photos — the hero of the screen. The back of the card is shown
              beside the front: the card number and the two lines of code are
              only printed there. */}
          <div className="grid grid-cols-3 gap-3 p-5">
            <HeroPhoto label="Selfie" path={selfiePath} onOpen={(url, label) => setLightbox({ url, label })} />
            <HeroPhoto label="National ID front" path={idPath} onOpen={(url, label) => setLightbox({ url, label })} />
            <HeroPhoto label="National ID back" path={idBackPath} onOpen={(url, label) => setLightbox({ url, label })} />
          </div>

          <PriorSubmissions
            userId={row.user_id}
            currentIdPath={idPath}
            currentSelfiePath={selfiePath}
            onOpen={(url, label) => setLightbox({ url, label })}
          />

          {/* Glanceable match strip */}
          <div className="mx-5 flex items-center gap-3 rounded-2xl bg-muted/50 px-4 py-3">
            {(() => {
              if (isLinkedCase) {
                return (
                  <>
                    <span
                      role="img"
                      aria-label="Name match result: Linked account"
                      className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-emerald-500 text-primary-foreground"
                    >
                      <BadgeCheck className="h-4 w-4" aria-hidden="true" />
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-bold text-emerald-700 dark:text-emerald-400">
                        Linked account · Name difference expected
                      </p>
                      <p className="truncate text-xs text-muted-foreground">
                        Account: {row.account_name || row.full_name || '—'} · ID holder: {row.linked_id_holder || row.national_id_name || '—'}
                      </p>
                    </div>
                    <p
                      className="shrink-0 text-sm font-bold tabular-nums text-foreground whitespace-nowrap"
                      title={`Withdrawable balance: ${formatUGX(row.withdrawable_balance)}`}
                    >
                      {formatUGX(row.withdrawable_balance)}
                    </p>
                  </>
                );
              }
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
                  <p
                    className="shrink-0 text-sm font-bold tabular-nums text-foreground whitespace-nowrap"
                    title={`Withdrawable balance: ${formatUGX(row.withdrawable_balance)}`}
                  >
                    {formatUGX(row.withdrawable_balance)}
                  </p>
                </>
              );
            })()}
          </div>

          <SavedPayoutNumberCard row={row} />

          {/* Both names side by side — the person in the selfie vs the National ID */}
          <div className="mx-5 mt-3 grid grid-cols-2 gap-3">
            <div className="rounded-2xl border border-border bg-card p-3">
              <p className="text-[10px] font-bold uppercase tracking-[0.15em] text-muted-foreground">Selfie name</p>
              <p className="mt-1 truncate text-sm font-bold text-foreground">{row.full_name || '—'}</p>
              <p className="text-[10px] text-muted-foreground">
                {row.account_name && row.account_name !== row.full_name
                  ? `Withdrawal: ${row.account_name}`
                  : 'Name on the account'}
              </p>
            </div>
            <div
              className={`rounded-2xl border p-3 ${
                idNameUnreadable
                  ? 'border-destructive/50 bg-destructive/10'
                  : !isLinkedCase && row.national_id_name && row.full_name && row.name_match_score !== null && row.name_match_score < 0.8
                    ? 'border-amber-500/50 bg-amber-500/10'
                    : 'border-border bg-card'
              }`}
            >
              <p className="text-[10px] font-bold uppercase tracking-[0.15em] text-muted-foreground">National ID name</p>
              <p className="mt-1 truncate text-sm font-bold text-foreground">{row.national_id_name || '—'}</p>
              {idNameUnreadable ? (
                <p role="alert" className="mt-0.5 flex items-start gap-1 text-[10px] font-semibold text-destructive">
                  <AlertTriangle className="mt-px h-3 w-3 shrink-0" aria-hidden="true" />
                  {idNameConfidence.reason} The account name was left unchanged and Verify stays off until a clear name is read.
                </p>
              ) : (
                <p className="text-[10px] text-muted-foreground">
                  {isLinkedCase
                    ? 'Differs from withdrawal account — expected for linked account'
                    : row.national_id_name
                      ? row.name_match_score !== null && row.name_match_score < 0.8
                        ? 'Does not match the withdrawal account name'
                        : 'Matches the withdrawal account name'
                      : 'Not read from the ID yet'}
                </p>
              )}
            </div>
          </div>

          {/* Names do not match: show the ID name and let it become the holder's name (suppressed for linked cases) */}
          {!isLinkedCase && row.name_match_score !== null && row.name_match_score < 0.8 && (
            <IdNameMismatchCard row={row} onSaved={() => goTo(position)} />
          )}

          {/* What the reader stored off the card, with the matching checks */}
          <StoredIdReadingCard row={row} />

          {/* What was read off the BACK of the card, re-read from the archived photo */}
          <StoredIdBackReadingCard row={row} backPath={idBackPath} />

          {isLinkedCase ? (
            <LinkedAutoVerifiedCard row={row} linkRequest={associatedLink} />
          ) : (
            <>
              {/* Mandatory network name check before Verify can be tapped */}
              <PayoutNameCheckCard row={row} check={nameCheck} onChange={setNameCheck} />

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
                  Reject / note
                </Button>
                <Button
                  className="h-14 flex-[2] rounded-2xl text-xs font-bold uppercase tracking-widest shadow-lg shadow-primary/25 disabled:opacity-50"
                  disabled={verifyBlocked || quickVerify.isPending}
                  onClick={() => setConfirmingVerify(row)}
                >
                  {quickVerify.isPending ? (
                    <Loader2 className="mr-2 h-5 w-5 animate-spin" />
                  ) : (
                    <CheckCircle2 className="mr-2 h-5 w-5" />
                  )}
                  Verify payout
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
                  Verify is off — {idNameConfidence.reason} Ask for a clearer ID photo.
                </p>
              )}
              {photosReady && !idNameUnreadable && !isDouble && !nameCheckPassed && (
                <p className="-mt-2 flex items-center justify-center gap-1.5 px-5 pb-4 text-center text-xs font-semibold text-amber-600">
                  <AlertTriangle className="h-3.5 w-3.5" />
                  {nameCheck
                    ? 'The name on the number is not clearly the same person — Verify needs a written reason and your confirmation.'
                    : 'Verify is off — do the name check on the payout number first (Step 1 above).'}
                </p>
              )}
              {(() => {
                const reason = blockedReasonFor(row);
                if (!reason) return null;
                return (
                  <p className={`-mt-1 flex items-start justify-center gap-1.5 px-5 pb-4 text-center text-xs font-medium ${reason.tone}`}>
                    <reason.Icon className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                    <span>{reason.text}</span>
                  </p>
                );
              })()}
              {row.decision_reason && (
                <p className="px-5 pb-4 text-center text-xs text-muted-foreground">
                  Last note: {row.decision_reason}
                </p>
              )}
            </>
          )}

          {/* Queue navigation — the next NUMBER for this person, or the next real PERSON. */}
          <div className="space-y-2 border-t border-primary/10 px-5 py-3">
            <div className="flex items-center justify-between gap-2">
              <Button
                variant="ghost"
                className="h-11 gap-1"
                disabled={position <= 1}
                onClick={goPrevPerson}
                aria-label="Previous person in the queue"
              >
                <ChevronLeft className="h-4 w-4" /> Previous person
              </Button>
              <p className="text-center text-xs font-semibold text-muted-foreground" aria-live="polite">
                Case {position} of {total}
                {personNumbersInQueue > 1 && (
                  <>
                    <br />
                    Number {personNumberPosition} of {personNumbersInQueue} waiting for this person
                  </>
                )}
              </p>
              <Button
                variant="ghost"
                className="h-11 gap-1"
                disabled={position >= total}
                onClick={goNextPerson}
                aria-label="Skip the rest of this person's numbers and go to the next person"
              >
                Next person <ChevronRight className="h-4 w-4" />
              </Button>
            </div>
            {nextSameIdx >= 0 && (
              <Button
                variant="outline"
                className="h-11 w-full gap-1.5 border-amber-500/60 text-amber-700 hover:bg-amber-500/10 dark:text-amber-400"
                onClick={() => setIndex(nextSameIdx)}
                aria-label="Next payout number for the same person"
              >
                <Smartphone className="h-4 w-4" /> Next number for the same person
              </Button>
            )}
          </div>
        </div>
      )}

      {!queue.isLoading && !queue.isError && rows.length > 0 && (
        <PayoutQueueBlockedList
          rows={rows}
          activeId={row?.id ?? null}
          startNumber={page * PAYOUT_VERIFICATION_PAGE_SIZE + 1}
          onOpen={(i) => setIndex(i)}
        />
      )}

      <DecisionDialog
        row={deciding ? row : null}
        photosReady={photosReady}
        idNameUnreadable={idNameUnreadable}
        onClose={() => setDeciding(false)}
        onSaved={() => goTo(position)}
      />

      {/* Confirm before verifying — prevents accidental one-tap saves */}
      <Dialog open={!!confirmingVerify} onOpenChange={(o) => !o && setConfirmingVerify(null)}>
        <DialogContent className="max-w-sm rounded-2xl p-0">
          <DialogHeader className="px-5 pt-5">
            <DialogTitle className="text-base">Confirm verify payout</DialogTitle>
            <DialogDescription className="text-sm">
              You are about to verify and save this payout. The name read from the National ID will become the account name.
            </DialogDescription>
          </DialogHeader>
          {confirmingVerify && (
            <div className="space-y-2 px-5 text-sm">
              <div className="flex justify-between gap-3">
                <span className="text-muted-foreground">Holder</span>
                <span className="truncate text-right font-semibold">{confirmingVerify.full_name || '—'}</span>
              </div>
              <div className="flex justify-between gap-3">
                <span className="text-muted-foreground">ID name</span>
                <span className="truncate text-right font-semibold">{confirmingVerify.national_id_name || '—'}</span>
              </div>
              <div className="flex justify-between gap-3">
                <span className="text-muted-foreground">Name on the number</span>
                <span className="truncate text-right font-semibold">{nameCheck?.networkName || '—'}</span>
              </div>
              <div className="flex justify-between gap-3">
                <span className="text-muted-foreground">Amount</span>
                <span className="text-right font-semibold">{formatUGX(confirmingVerify.withdrawable_balance)}</span>
              </div>
              <div className="flex justify-between gap-3">
                <span className="text-muted-foreground">Payout number</span>
                <span className="truncate text-right font-semibold">
                  {confirmingVerify.destination_type === 'mobile_money'
                    ? confirmingVerify.momo_number ?? '—'
                    : `${confirmingVerify.bank_name ?? ''} ${confirmingVerify.bank_account_number ?? ''}`.trim() || '—'}
                </span>
              </div>
              {nameCheckNeedsOverride && (
                <div role="alert" className="mt-3 animate-pulse space-y-2 rounded-xl border-4 border-destructive bg-destructive/20 p-3">
                  <p className="flex items-center gap-1.5 text-sm font-extrabold uppercase tracking-wide text-destructive">
                    <ShieldAlert className="h-5 w-5 shrink-0" aria-hidden="true" />
                    {nameCheck?.outcome === 'partial'
                      ? 'Warning: the names only partly agree'
                      : 'Danger: the names are different'}
                  </p>
                  <p className="text-xs text-foreground">
                    Only continue if you have confirmed with the holder that this number is theirs. Write what you checked.
                  </p>
                  <Textarea
                    value={overrideNote}
                    onChange={(e) => setOverrideNote(e.target.value)}
                    placeholder="e.g. Called the holder; the number is registered in their mother's name"
                    className="min-h-[72px] text-sm"
                    aria-label="Reason for verifying despite the name difference"
                  />
                  <label className="flex items-start gap-2 text-xs font-semibold text-foreground">
                    <input
                      type="checkbox"
                      className="mt-0.5 h-4 w-4"
                      checked={overrideAck}
                      onChange={(e) => setOverrideAck(e.target.checked)}
                    />
                    I confirm this payout number belongs to the account holder and I take responsibility for this decision.
                  </label>
                </div>
              )}
            </div>
          )}
          <DialogFooter className="gap-2 px-5 pb-5 pt-2">
            <Button
              variant="outline"
              className="h-12 flex-1 rounded-xl text-xs font-bold uppercase tracking-widest"
              onClick={() => setConfirmingVerify(null)}
              disabled={quickVerify.isPending}
            >
              Cancel
            </Button>
            <Button
              className="h-12 flex-1 rounded-xl text-xs font-bold uppercase tracking-widest shadow-lg shadow-primary/25"
              disabled={quickVerify.isPending || (nameCheckNeedsOverride && !overrideReady)}
              onClick={async () => {
                if (!confirmingVerify) return;
                if (nameCheckNeedsOverride && !overrideReady) return;
                const target = confirmingVerify;
                const note = nameCheckNeedsOverride ? overrideNote.trim() : null;
                setConfirmingVerify(null);
                await runQuickVerify(target, note);
              }}
            >
              {quickVerify.isPending ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <CheckCircle2 className="mr-2 h-4 w-4" />
              )}
              Verify
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

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

      {/* Drill-down: every payout number this person has ever submitted. */}
      <Dialog open={personNumbersOpen} onOpenChange={setPersonNumbersOpen}>
        <DialogContent className="max-w-md rounded-2xl p-0">
          <DialogHeader className="px-5 pt-5">
            <DialogTitle className="text-base">
              {row?.full_name || 'This person'} — {personNumbers.data?.length ?? row?.payout_number_count ?? 0} payout
              number requests
            </DialogTitle>
            <DialogDescription className="text-sm">
              Every number they have submitted, oldest first. Tap one that is still waiting to review it now.
            </DialogDescription>
          </DialogHeader>
          <div className="max-h-[60vh] space-y-2 overflow-y-auto px-5 pb-5 pt-2">
            {personNumbers.isLoading && <Skeleton className="h-16 w-full rounded-xl" />}
            {!personNumbers.isLoading &&
              (personNumbers.data ?? []).map((d, i) => {
                const label =
                  d.destination_type === 'mobile_money'
                    ? `${d.provider ?? 'Mobile money'} · ${d.momo_number ?? '—'}`
                    : `${d.bank_name ?? ''} ${d.bank_account_number ?? ''}`.trim() || '—';
                const inQueueIdx = rows.findIndex((r) => r.id === d.id);
                const tone =
                  d.status === 'verified'
                    ? 'text-emerald-700 dark:text-emerald-400'
                    : d.status === 'rejected'
                      ? 'text-destructive'
                      : 'text-amber-700 dark:text-amber-400';
                return (
                  <div
                    key={d.id}
                    className={`flex items-center justify-between gap-3 rounded-xl border p-3 ${
                      d.id === row?.id ? 'border-primary/60 bg-primary/5' : 'border-border'
                    }`}
                  >
                    <div className="min-w-0">
                      <p className="truncate text-sm font-bold">
                        {i + 1}. {label}
                      </p>
                      <p className={`text-xs font-semibold uppercase tracking-wide ${tone}`}>
                        {d.status === 'waiting' ? 'Waiting' : d.status === 'verified' ? 'Verified' : 'Rejected'}
                        {d.decided_at ? ` · ${format(new Date(d.decided_at), 'd MMM yyyy')}` : ''}
                      </p>
                    </div>
                    {d.id === row?.id ? (
                      <span className="shrink-0 text-[10px] font-bold uppercase tracking-wide text-primary">
                        On screen
                      </span>
                    ) : inQueueIdx >= 0 ? (
                      <Button
                        variant="outline"
                        className="h-9 shrink-0"
                        onClick={() => {
                          setIndex(inQueueIdx);
                          setPersonNumbersOpen(false);
                        }}
                      >
                        Open
                      </Button>
                    ) : null}
                  </div>
                );
              })}
            {!personNumbers.isLoading && (personNumbers.data ?? []).length === 0 && (
              <p className="text-sm text-muted-foreground">No payout numbers recorded.</p>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
