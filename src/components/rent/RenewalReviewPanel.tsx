import { lazy, Suspense, useState } from 'react';
import { AlertTriangle, ArrowRight, ExternalLink, History, Loader2, RefreshCw, Send } from 'lucide-react';
import { format } from 'date-fns';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { useAuth } from '@/hooks/useAuth';
import { formatUGX } from '@/lib/rentCalculations';
import { cn } from '@/lib/utils';
import {
  RENEWAL_REASON_LABEL,
  percentChange,
  renewalErrorMessage,
  type RenewalAdvice,
  type RenewalReasonCode,
} from '@/lib/renewalAdvice';
import { REVIEW_NOTE_MIN, REVIEW_NOTE_ROLES, REVIEW_ROLE_LABEL, useRentRequestReviewNotes } from '@/hooks/useRentRequestReviewNotes';

// The drawer renders this panel and the panel can open the drawer for the previous plan, so it loads lazily.
const RentRequestDetailDrawer = lazy(() =>
  import('./RentRequestDetailDrawer').then((m) => ({ default: m.RentRequestDetailDrawer })),
);

/** The renewal columns a reviewer view reads from rent_requests (see the SELECT lists of the pipeline lists). */
export const RENEWAL_REVIEW_COLUMNS =
  'registration_type, renewal_previous_rent, renewal_previous_days, renewal_advice_snapshot, renewal_above_suggestion, renewal_above_by, ' +
  'renewal_change_reason_code, renewal_change_explanation, renewal_evidence_url';

export interface RenewalReviewFields {
  id: string;
  registration_type?: string | null;
  rent_amount: number;
  duration_days: number;
  renewal_previous_rent?: number | null;
  renewal_previous_days?: number | null;
  renewal_advice_snapshot?: unknown;
  renewal_above_suggestion?: boolean | null;
  renewal_above_by?: number | null;
  renewal_change_reason_code?: string | null;
  renewal_change_explanation?: string | null;
  renewal_evidence_url?: string | null;
}

const asAdvice = (v: unknown): Partial<RenewalAdvice> | null => (v && typeof v === 'object' ? (v as Partial<RenewalAdvice>) : null);

/** A renewal whose rent or number of days differs from the plan it renews (the server only fills renewal_previous_* then). */
export function isRenewalChanged(r: Pick<RenewalReviewFields, 'registration_type' | 'renewal_previous_rent' | 'renewal_previous_days'>): boolean {
  return r.registration_type === 'renewal' && (r.renewal_previous_rent != null || r.renewal_previous_days != null);
}

export function renewalChangeLabel(r: RenewalReviewFields): string {
  const rentChanged = r.renewal_previous_rent != null && Number(r.renewal_previous_rent) !== Number(r.rent_amount);
  const daysChanged = r.renewal_previous_days != null && Number(r.renewal_previous_days) !== Number(r.duration_days);
  if (rentChanged && daysChanged) return 'Renewal — rent and days changed';
  if (daysChanged) return 'Renewal — days changed';
  return 'Renewal — rent changed';
}

/** Small tags for a list row: the change badge, and the warning when the rent was above the server's suggestion. */
export function RenewalListTags({ request, className }: { request: RenewalReviewFields; className?: string }) {
  if (!isRenewalChanged(request)) return null;
  const rentChanged = request.renewal_previous_rent != null && Number(request.renewal_previous_rent) !== Number(request.rent_amount);
  return (
    <span className={cn('inline-flex flex-wrap items-center gap-1', className)}>
      <Badge variant="outline" className="gap-1 border-sky-300 bg-sky-50 px-1.5 py-0 text-[10px] font-medium text-sky-800 dark:border-sky-500/40 dark:bg-sky-500/10 dark:text-sky-300">
        <RefreshCw className="h-2.5 w-2.5" />
        {renewalChangeLabel(request)}
        {rentChanged && request.renewal_previous_rent ? ` (${signed(percentChange(Number(request.renewal_previous_rent), Number(request.rent_amount)))}%)` : ''}
      </Badge>
      {request.renewal_above_suggestion && (
        <Badge variant="outline" className="gap-1 border-amber-300 bg-amber-50 px-1.5 py-0 text-[10px] font-medium text-amber-900 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-300">
          <AlertTriangle className="h-2.5 w-2.5" />
          Above suggestion{request.renewal_above_by ? ` by ${formatUGX(Number(request.renewal_above_by))}` : ''}
        </Badge>
      )}
    </span>
  );
}

const signed = (n: number) => (n > 0 ? `+${n}` : String(n));

/**
 * Everything a reviewer needs about a renewal: what changed, the server's advice as it was at renewal time, the agent's reason and
 * explanation, the evidence, a link to the previous plan, and the notes thread every later stage can read and add to.
 * Renders nothing for a request that is not a renewal.
 */
export function RenewalReviewPanel({ request, className }: { request: RenewalReviewFields; className?: string }) {
  const [previousOpen, setPreviousOpen] = useState(false);
  if (request.registration_type !== 'renewal') return null;
  const changed = isRenewalChanged(request);
  const advice = asAdvice(request.renewal_advice_snapshot);
  const prevId = advice?.prev_request_id ?? null;
  const reason = request.renewal_change_reason_code as RenewalReasonCode | null | undefined;
  const rentChanged = request.renewal_previous_rent != null && Number(request.renewal_previous_rent) !== Number(request.rent_amount);
  const daysChanged = request.renewal_previous_days != null && Number(request.renewal_previous_days) !== Number(request.duration_days);

  return (
    <section className={cn('space-y-3 rounded-lg border border-sky-200 bg-sky-50/50 p-3 dark:border-sky-500/30 dark:bg-sky-500/5', className)} aria-label="Renewal details">
      <div className="flex flex-wrap items-center gap-2">
        <Badge className="gap-1 bg-sky-600 text-white hover:bg-sky-600">
          <RefreshCw className="h-3 w-3" />
          {changed ? renewalChangeLabel(request) : 'Renewal — same rent and days'}
        </Badge>
        {request.renewal_above_suggestion && (
          <Badge variant="outline" className="gap-1 border-amber-400 bg-amber-50 text-amber-900 dark:bg-amber-500/10 dark:text-amber-300">
            <AlertTriangle className="h-3 w-3" />
            Above suggestion by {formatUGX(Number(request.renewal_above_by ?? 0))}
          </Badge>
        )}
      </div>

      {changed && (
        <div className="space-y-1 text-sm">
          {rentChanged && (
            <p className="flex flex-wrap items-center gap-1.5">
              <span className="text-muted-foreground">Rent</span>
              <span>{formatUGX(Number(request.renewal_previous_rent))}</span>
              <ArrowRight className="h-3.5 w-3.5 text-muted-foreground" />
              <span className="font-semibold">{formatUGX(Number(request.rent_amount))}</span>
              <span className="text-xs text-muted-foreground">({signed(percentChange(Number(request.renewal_previous_rent), Number(request.rent_amount)))}%)</span>
            </p>
          )}
          {daysChanged && (
            <p className="flex flex-wrap items-center gap-1.5">
              <span className="text-muted-foreground">Days</span>
              <span>{request.renewal_previous_days}</span>
              <ArrowRight className="h-3.5 w-3.5 text-muted-foreground" />
              <span className="font-semibold">{request.duration_days}</span>
            </p>
          )}
        </div>
      )}

      {changed && advice && (
        <div className="rounded-md border bg-background/70 p-2.5">
          <p className="text-sm font-semibold">
            Advice at renewal: suggested up to {formatUGX(Number(advice.suggested_max_rent ?? 0))}
            {advice.chosen_days ? <span className="font-normal text-muted-foreground"> for {advice.chosen_days} days</span> : null}
          </p>
          <ul className="mt-1 space-y-0.5 text-xs text-muted-foreground">
            {(advice.reasons ?? []).filter((_, i, a) => i < a.length - 1).map((line, i) => <li key={i}>{line}</li>)}
          </ul>
          {advice.computed_at && <p className="mt-1 text-[10px] text-muted-foreground">Worked out by the system on {format(new Date(advice.computed_at), 'dd MMM yyyy, HH:mm')}. Advice only.</p>}
        </div>
      )}

      {changed && (reason || request.renewal_change_explanation) && (
        <div className="space-y-1 text-sm">
          <p className="text-xs font-medium text-muted-foreground">Agent&apos;s reason</p>
          {reason && <Badge variant="secondary">{RENEWAL_REASON_LABEL[reason] ?? reason}</Badge>}
          {request.renewal_change_explanation && <p className="whitespace-pre-wrap leading-snug">{request.renewal_change_explanation}</p>}
        </div>
      )}

      {changed && request.renewal_evidence_url && (
        <a href={request.renewal_evidence_url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-2 text-xs text-primary underline-offset-2 hover:underline">
          <img src={request.renewal_evidence_url} alt="Landlord note" loading="lazy" className="h-16 w-16 rounded-md border object-cover" />
          <span className="inline-flex items-center gap-1">Open landlord note <ExternalLink className="h-3 w-3" /></span>
        </a>
      )}

      {prevId && (
        <>
          <Button type="button" variant="outline" size="sm" className="h-9 gap-1.5" onClick={() => setPreviousOpen(true)}>
            <History className="h-3.5 w-3.5" /> View previous plan
          </Button>
          {previousOpen && (
            <Suspense fallback={null}>
              <RentRequestDetailDrawer requestId={prevId} open={previousOpen} onOpenChange={setPreviousOpen} />
            </Suspense>
          )}
        </>
      )}

      <ReviewNotesThread requestId={request.id} />
    </section>
  );
}

/** The append-only notes thread: every stage reads it, reviewers add to it (10+ characters). */
export function ReviewNotesThread({ requestId }: { requestId: string }) {
  const { roles } = useAuth();
  const { notes, loading, error, addNote } = useRentRequestReviewNotes(requestId);
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const canAdd = (roles as string[]).some((r) => (REVIEW_NOTE_ROLES as readonly string[]).includes(r));
  const length = draft.trim().length;

  const submit = async () => {
    if (length < REVIEW_NOTE_MIN) { setProblem(`A note needs at least ${REVIEW_NOTE_MIN} characters.`); return; }
    setSaving(true); setProblem(null);
    try { await addNote(draft); setDraft(''); } catch (e) { setProblem(renewalErrorMessage(e)); } finally { setSaving(false); }
  };

  return (
    <div className="space-y-2 border-t pt-3">
      <p className="text-xs font-medium text-muted-foreground">Review notes</p>
      {loading && notes.length === 0 ? <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" /> : null}
      {error && <p className="text-xs text-destructive">{error}</p>}
      {!loading && !error && notes.length === 0 && <p className="text-xs text-muted-foreground">No notes yet.</p>}
      <ul className="space-y-2">
        {notes.map((n) => (
          <li key={n.id} className="rounded-md border bg-background/70 px-2.5 py-2 text-sm">
            <p className="whitespace-pre-wrap leading-snug">{n.note}</p>
            <p className="mt-1 text-[10px] text-muted-foreground">
              {n.author_name || 'Reviewer'} · {REVIEW_ROLE_LABEL[n.author_role] ?? n.author_role} · {format(new Date(n.created_at), 'dd MMM, HH:mm')}
            </p>
          </li>
        ))}
      </ul>
      {canAdd && (
        <div className="space-y-1.5">
          <Textarea value={draft} onChange={(e) => { setDraft(e.target.value); setProblem(null); }} rows={2} placeholder="Add a note for the next reviewers" className="text-sm" />
          <div className="flex items-center justify-between gap-2">
            <span className={cn('text-xs', length >= REVIEW_NOTE_MIN ? 'text-emerald-700 dark:text-emerald-400' : 'text-muted-foreground')}>{length}/{REVIEW_NOTE_MIN} characters minimum</span>
            <Button type="button" size="sm" className="h-9 gap-1.5" disabled={saving} onClick={() => void submit()}>
              {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />} Add note
            </Button>
          </div>
          {problem && <p role="alert" className="text-xs text-destructive">{problem}</p>}
        </div>
      )}
    </div>
  );
}
