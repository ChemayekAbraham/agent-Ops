import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { ExternalLink, FileText, MapPin, X } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { useAuth } from '@/hooks/useAuth';
import { fmt } from './format';
import { CALM, FIGURE, FOCUS, LABEL, PANEL, statusGlass, statusText, type Status } from './deskTheme';
import { Skeleton } from './Skeleton';
import { CallLog } from './CallLog';
import { asIs, isRecordOnly, needsNote, passMovesOnServer, rejectMovesOnServer, runMove, transferThenPass } from './deskActions';
import { passBlock } from './passBlock';
import { answeredCallOnFile, awarenessCallsKey, callTime, stageSince, useAwarenessCalls } from './callOnFile';
import { toast } from 'sonner';
import { afterServerPass } from './boardApi';
import { SEND_BACK_STAGES, SUGGESTED_OFFICE, SendBackForm, parseSendBackNote } from './sendBack';
import { useCooReasonPicker } from '@/components/coo/CooReasonPicker';
import { RETRY_LABEL, useReviewStatus } from './reviewStatus';
import { WaitOnForm, useWaitingList, waitDeskForStage } from './waitOn';
import { DeskCallButton, RequestCallHistory } from './deskCall';
import { PhotoReview } from './PhotoReview';
import { IntakeForm } from './IntakeForm';
import { PaymentHealthPanel } from './paymentHealth';
import { ConcernsSection, concernDeskFor } from './concerns';
import { LandlordContextPanel, RENT_EXACT_HINT, ScriptPanel, rentOnRequestText, useLandlordContext } from './landlordOps';
import { DecisionButton, atLeast, stackLayout, useBreakpoint } from './ui';
import type { DrawerContext, DrawerStart } from './ReadyBoard';
import {
  lcLetterUrl,
  readableError,
  rpc,
  stageChecklist,
  useProxyAgents,
  useReasonCodes,
  useReviewSheet,
  useSuggestedAgents,
} from './reviewApi';
import {
  DECISION_HELP,
  DECISION_LABEL,
  visibleDecisions,
  type CheckEntry,
  type CheckResult,
  type ChecklistItem,
  type Decision,
  type Stage,
} from './reviewTypes';

/** The reason-code catalogue tags each code with the desks it belongs to. */
const DESK_TAG: Record<Stage, string> = {
  service_centre: 'SC',
  agent_ops: 'Agent Ops',
  tenant_ops: 'Tenant Ops',
  landlord_ops: 'Landlord Ops',
  partner_ops: 'Partner Ops',
  coo: 'COO',
};

const STAGE_NAME: Record<Stage, string> = {
  service_centre: 'Service Centre',
  agent_ops: 'Agent Ops',
  tenant_ops: 'Tenant Ops',
  landlord_ops: 'Landlord Ops',
  partner_ops: 'Partner Ops',
  coo: 'COO',
};

/** A note of at least ten characters, which is what every send-back path asks for. */
const NOTE_MIN = 10;

const RESULT_TONE: Record<CheckResult, Status> = { pass: 'ok', fail: 'bad', na: 'idle' };
const RESULT_LABEL: Record<CheckResult, string> = { pass: 'Pass', fail: 'Fail', na: 'N/A' };

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0 space-y-1">
      <div className={LABEL}>{label}</div>
      <div className="break-words text-sm text-foreground">{children}</div>
    </div>
  );
}

/** The LC1 letter, behind a signed URL fetched only when the drawer is open. */
function LcLetter({ bucket, path }: { bucket: string | null; path: string }) {
  const [url, setUrl] = useState<string | null>(null);
  const [gone, setGone] = useState(false);
  useEffect(() => {
    let live = true;
    lcLetterUrl(bucket, path).then((u) => {
      if (!live) return;
      if (u) setUrl(u);
      else setGone(true);
    });
    return () => {
      live = false;
    };
  }, [bucket, path]);

  if (gone) return <span className={statusText.bad}>The file could not be opened — treat it as missing.</span>;
  if (!url) return <Skeleton className="h-4 w-28" />;
  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      className={`inline-flex items-center gap-1.5 rounded text-[hsl(var(--desk-lavender))] underline underline-offset-4 ${FOCUS}`}
    >
      <FileText className="h-3.5 w-3.5" aria-hidden /> Open the LC1 letter
    </a>
  );
}

function Photos({ urls }: { urls: string[] }) {
  if (!urls.length) return <span className={statusText.bad}>No photos of the house.</span>;
  return (
    <div className="flex flex-wrap gap-2">
      {urls.map((u, i) => (
        <a
          key={u}
          href={u}
          target="_blank"
          rel="noopener noreferrer"
          className={`block overflow-hidden rounded-lg border border-[var(--desk-line-color)] ${FOCUS}`}
          aria-label={`House photo ${i + 1} of ${urls.length}`}
        >
          <img src={u} alt="" loading="lazy" className="h-20 w-28 object-cover" />
        </a>
      ))}
    </div>
  );
}

/** One checklist item: what the system saw, the reviewer's verdict, and any value it asks for. */
function CheckRow({
  item,
  entry,
  needsText,
  onResult,
  onValue,
  extra,
}: {
  item: ChecklistItem;
  entry: CheckEntry | undefined;
  /** True when this item needs a written answer even though its value_kind is empty. */
  needsText: boolean;
  onResult: (r: CheckResult) => void;
  onValue: (v: unknown) => void;
  /** A line under the question: the rent on the request, the arrears hint. */
  extra?: React.ReactNode;
}) {
  // "Rent confirmed by the landlord" always takes the amount the landlord said; it is sent as the check's value.
  const kind = item.value_kind ?? (item.code === 'lo_rent_confirmed' ? 'amount' : null);
  const showInput = (!!kind || needsText) && entry?.result === 'pass';
  const numeric = kind === 'number' || kind === 'amount';

  return (
    <li className="space-y-2 border-b border-[var(--desk-line-color)] py-3 last:border-0">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <p className="text-sm font-medium text-foreground">
            {item.label}
            {item.required && <span className="ml-1.5 text-xs text-muted-foreground">(required)</span>}
          </p>
          <p className="text-xs leading-snug text-muted-foreground">{item.question}</p>
          {extra && <div className="text-xs leading-snug">{extra}</div>}
          {item.system_said && (
            <p className="text-xs leading-snug">
              <span className="text-[hsl(var(--desk-lavender))]">The system sees: {item.system_said}</span>
              {item.system_detail ? <span className="text-muted-foreground"> — {item.system_detail}</span> : null}
            </p>
          )}
          {item.assumption && <p className="text-xs leading-snug text-muted-foreground">{item.assumption}</p>}
          {item.last && (
            <p className="text-xs text-muted-foreground">
              Last time: {RESULT_LABEL[item.last.result]}
              {item.last.by ? ` by ${item.last.by}` : ''}
              {item.last.note ? ` — ${item.last.note}` : ''}
            </p>
          )}
        </div>

        <div className="flex shrink-0 gap-1.5">
          {(['pass', 'fail', 'na'] as CheckResult[]).map((r) => {
            const on = entry?.result === r;
            return (
              <button
                key={r}
                type="button"
                aria-pressed={on}
                onClick={() => onResult(r)}
                className={`desk-pill border px-3 py-1 text-xs ${CALM} ${FOCUS} ${
                  on ? statusGlass[RESULT_TONE[r]] : 'border-[var(--desk-line-color)] bg-[var(--desk-surface)] text-muted-foreground hover:bg-[var(--desk-surface-hover)] hover:text-foreground'
                }`}
              >
                {RESULT_LABEL[r]}
              </button>
            );
          })}
        </div>
      </div>

      {showInput && (
        <label className="block space-y-1">
          <span className={LABEL}>
            {kind === 'number'
              ? 'How many people'
              : kind === 'amount'
                ? 'Amount (UGX)'
                : item.code === 'sc_lc1_letter'
                  ? 'Who confirmed by phone (LC1 chairperson name and number)'
                  : 'Write it here'}
          </span>
          <input
            type={numeric ? 'number' : 'text'}
            inputMode={numeric ? 'numeric' : 'text'}
            value={entry?.value === undefined || entry?.value === null ? '' : String(entry.value)}
            onChange={(e) => {
              const raw = e.target.value;
              if (!numeric) return onValue(raw);
              onValue(raw === '' ? null : Number(raw));
            }}
            className={`desk-pill h-9 w-full max-w-sm border border-[var(--desk-line-color)] bg-[var(--desk-surface)] px-3 text-sm text-foreground placeholder:text-muted-foreground ${FOCUS}`}
          />
        </label>
      )}
    </li>
  );
}

export function ReviewDrawer({
  stage,
  requestId,
  onClose,
  initial,
  ctx,
}: {
  stage: Stage;
  requestId: string;
  onClose: () => void;
  /** Opened from the board: start on this decision, on "Wait on…", or with the call button ready. */
  initial?: DrawerStart;
  /** What the board already knew about the row: missing intake items and the suggested wait. */
  ctx?: DrawerContext;
}) {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const { mark, clear } = useReviewStatus();
  const sheet = useReviewSheet(requestId);
  const reasons = useReasonCodes();

  const [entries, setEntries] = useState<Record<string, CheckEntry>>({});
  // E64: Reject is now "Send back" to the agent in the field; a reject start opens it with that office picked.
  const fromReject = initial === 'reject' && SEND_BACK_STAGES.has(stage);
  const [decision, setDecision] = useState<Decision | null>(() =>
    fromReject ? 'send_back' : initial && visibleDecisions(stage).includes(initial as Decision) ? (initial as Decision) : null,
  );
  const [reasonCode, setReasonCode] = useState<string>('');
  const cooReason = useCooReasonPicker();
  const [note, setNote] = useState('');
  const [targetAgentId, setTargetAgentId] = useState<string | null>(null);
  const [proxyAgentId, setProxyAgentId] = useState<string | null>(null);
  const [callAnswered, setCallAnswered] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<string | null>(null);
  // "Wait on…" is not a review decision: it parks the request here and never calls runMove.
  const [waitMode, setWaitMode] = useState(initial === 'wait');
  // Agent Ops has a second tab for the house photos.
  const [tab, setTab] = useState<'review' | 'photos'>(initial === 'photos' ? 'photos' : 'review');
  // Opened from a card's "Log a concern…": bring the concerns section into view.
  const concernRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (initial !== 'concern') return;
    const t = window.setTimeout(() => concernRef.current?.scrollIntoView({ block: 'start' }), 120);
    return () => window.clearTimeout(t);
  }, [initial]);
  const photosTab = stage === 'agent_ops';
  const showIntake = stage === 'agent_ops' && (initial === 'complete' || (ctx?.itemsMissing?.length ?? 0) > 0);
  // A company call to the tenant/landlord that ended answered pre-selects "Answered" in the call log.
  const [liveAnswered, setLiveAnswered] = useState(false);
  const waitDesk = waitDeskForStage(stage);
  const waitList = useWaitingList(waitDesk);
  const canWait = !!waitDesk && !waitList.missing;

  const callDesk = stage === 'tenant_ops' ? 'tenant' : stage === 'landlord_ops' ? 'landlord' : null;
  // Concerns follow the request; every desk but the retired Partner Ops can log and read them.
  const concernDesk = concernDeskFor(stage);
  // Landlord Ops reads the whole request from one RPC; the panel and the checks share the cached answer.
  const landlordCtx = useLandlordContext(requestId, stage === 'landlord_ops');
  const lctx = landlordCtx.data;
  const suggested = useSuggestedAgents(requestId, decision === 'transfer');
  const proxies = useProxyAgents(decision === 'attach_funder');

  const items = useMemo(() => stageChecklist(sheet.data, stage), [sheet.data, stage]);
  const req = sheet.data?.request;
  const recommended = sheet.data?.recommendation?.recommended ?? null;
  const against = !!decision && !!recommended && decision !== recommended;
  // E63: these desks send back to a chosen office in one server call (pipeline_send_back_to).
  const sendBackTo = decision === 'send_back' && SEND_BACK_STAGES.has(stage);

  // A request whose LC1 letter is missing must carry a written phone confirmation instead.
  const lc1NeedsText = !req?.lc_letter;

  const missingRequired = useMemo(() => {
    if (decision === 'call_again') return [];
    return items.filter((c) => c.required && c.method !== 'system' && !entries[c.code]?.result).map((c) => c.label);
  }, [items, entries, decision]);

  const reasonList = useMemo(() => {
    const all = reasons.data ?? [];
    const tag = DESK_TAG[stage];
    const mine = all.filter((r) => (r.desks ?? []).some((d) => d === tag || d === 'all'));
    return mine.length > 0 ? mine : all;
  }, [reasons.data, stage]);

  const chosenReason = reasonList.find((r) => r.code === reasonCode) ?? null;
  const noteRequired =
    (!!decision && needsNote(decision)) ||
    (against && (reasonCode === 'OTHER' || reasonCode === 'RISK_JUDGEMENT' || !!chosenReason?.requires_text));

  // An answered call already on file counts, as it does on the server: the board's word when opened
  // from the board, the request's own call history otherwise; a call logged here counts too.
  const awareness = useAwarenessCalls(requestId, !!callDesk);
  const onFile = useMemo(
    () => (callDesk ? answeredCallOnFile(awareness.data ?? [], callDesk, stageSince(sheet.data, stage)) : null),
    [awareness.data, callDesk, sheet.data, stage],
  );
  const canPass = !callDesk || callAnswered || ctx?.callAnswered === true || !!onFile;
  // Why Pass cannot go yet, in the desk's short words ("Answer 5 more checks").
  const passAgainst = !!recommended && recommended !== 'pass';
  const passWhy = passBlock({
    callDesk,
    callAnswered: canPass,
    items,
    entries,
    against: passAgainst,
    reasonCode,
    noteRequired: passAgainst && (reasonCode === 'OTHER' || reasonCode === 'RISK_JUDGEMENT' || !!chosenReason?.requires_text),
    note,
    lc1NeedsText,
  });
  const blockedReason =
    decision === 'pass'
      ? passWhy
      : missingRequired.length > 0
        ? `Tick every item first — still open: ${missingRequired.join(', ')}.`
        : against && !reasonCode
          ? 'You are going against the system: choose a reason code.'
          : noteRequired && note.trim().length < NOTE_MIN
            ? `Write at least ${NOTE_MIN} characters explaining the decision.`
            : decision === 'transfer' && !targetAgentId
              ? 'Choose the agent to transfer the tenant to.'
              : decision === 'attach_funder' && !proxyAgentId
                ? 'Choose the proxy partner to attach.'
                : null;

  const setResult = (code: string, result: CheckResult) =>
    setEntries((prev) => ({ ...prev, [code]: { ...(prev[code] ?? { code }), code, result } }));
  const setValue = (code: string, value: unknown) =>
    setEntries((prev) => ({ ...prev, [code]: { ...(prev[code] ?? { code, result: 'pass' }), code, value } }));

  const submit = async () => {
    if (!decision || !user) return;
    setBusy(true);
    setError(null);
    setOutcome(null);

    const results: CheckEntry[] = Object.values(entries)
      .filter((e) => !!e.result)
      .map((e) => (e.value === undefined || e.value === null || e.value === '' ? { code: e.code, result: e.result } : e));

    // Transfer (Agent Ops): the transfer call, then the pass that moves the request (server).
    if (decision === 'transfer') {
      const target = suggested.data?.find((a) => a.agent_id === targetAgentId) ?? null;
      const out = await transferThenPass({
        requestId,
        results,
        targetAgentId,
        note: note.trim(),
        reasonCode: against ? reasonCode : reasonCode || null,
        targetName: target?.agent_name ?? null,
      });
      setBusy(false);
      if (out.kind === 'transfer_failed') {
        setError(out.message);
        return;
      }
      if (out.kind === 'pass_failed') {
        // The tenant is with the new agent; only the pass is left to retry.
        mark(requestId, { kind: 'move_failed', message: out.message, decision });
        setError(`${RETRY_LABEL}. ${out.message}`);
        return;
      }
      clear(requestId);
      mark(requestId, { kind: 'moved', message: out.message });
      afterServerPass(queryClient, stage, requestId, out.message);
      onClose();
      return;
    }

    try {
      // 1. Record the review. This is the step that must never be repeated.
      const { error: recErr } = await rpc('pipeline_record_review', {
        p_request_id: requestId,
        p_stage: stage,
        p_results: results,
        p_decision: decision,
        p_reason_code: against ? reasonCode : reasonCode || null,
        p_note: note.trim() || null,
        p_target_agent_id: null, // a transfer went through transferThenPass above
      });
      if (recErr) throw recErr;

      // 2. Run the move the desk already makes. If it fails the review stands,
      //    so the row says "retry" rather than inviting a second review.
      const moved = await runMove({
        requestId,
        stage,
        decision,
        userId: user.id,
        note: note.trim(),
        targetAgentId,
        proxyAgentId,
        reasonCode: against ? reasonCode : reasonCode || null,
        askReason: cooReason.askReason,
        reasonMeaning: cooReason.meaningOf,
      });

      if (!moved.ok) {
        mark(requestId, { kind: 'move_failed', message: moved.message, decision });
        setError(`${RETRY_LABEL}. ${moved.message}`);
        return;
      }

      clear(requestId);
      mark(requestId, { kind: 'moved', message: moved.message });
      if (passMovesOnServer(stage, decision) || rejectMovesOnServer(stage, decision)) {
        // E64 / E69: the review moved it. The card leaves the board; the toast says where.
        afterServerPass(queryClient, stage, requestId, moved.message);
        onClose();
        return;
      }
      setOutcome(moved.message);
      queryClient.invalidateQueries({ queryKey: ['desk-feed'] });
      if (!isRecordOnly(stage, decision)) {
        toast.success(moved.message);
        window.setTimeout(onClose, 900);
      }
    } catch (e) {
      // The server's message, as-is.
      setError(asIs(e));
    } finally {
      setBusy(false);
    }
  };

  /** Only retry the move — the review is already in. */
  const retryMove = async () => {
    if (!decision || !user) return;
    setBusy(true);
    setError(null);
    const moved = await runMove({
      requestId,
      stage,
      decision,
      userId: user.id,
      note: note.trim(),
      targetAgentId,
      proxyAgentId,
      reasonCode: against ? reasonCode : reasonCode || null,
      askReason: cooReason.askReason,
      reasonMeaning: cooReason.meaningOf,
      results: Object.values(entries)
        .filter((e) => !!e.result)
        .map((e) => (e.value === undefined || e.value === null || e.value === '' ? { code: e.code, result: e.result } : e)),
      targetName: suggested.data?.find((a) => a.agent_id === targetAgentId)?.agent_name ?? null,
    });
    setBusy(false);
    if (!moved.ok) {
      setError(`${RETRY_LABEL}. ${moved.message}`);
      return;
    }
    clear(requestId);
    mark(requestId, { kind: 'moved', message: moved.message });
    if (decision === 'transfer' || passMovesOnServer(stage, decision) || rejectMovesOnServer(stage, decision)) {
      afterServerPass(queryClient, stage, requestId, moved.message);
      onClose();
      return;
    }
    setOutcome(moved.message);
    toast.success(moved.message);
    queryClient.invalidateQueries({ queryKey: ['desk-feed'] });
    window.setTimeout(onClose, 900);
  };

  const recordedButStuck = !!error && error.startsWith(RETRY_LABEL);

  // Below md the drawer is a full-screen sheet and its two main buttons sit in
  // a bar pinned to the bottom; from md it is a side drawer with them inline.
  const bp = useBreakpoint();
  const phone = !atLeast(bp, 'md');
  const canSubmit = !!decision && !blockedReason && !busy && !recordedButStuck;
  const submitButton = (
    <button
      type="button"
      disabled={!decision || !!blockedReason || busy || recordedButStuck}
      onClick={submit}
      className={`desk-pill border px-4 py-2 text-sm font-medium ${CALM} ${FOCUS} ${
        canSubmit ? statusGlass.ok : 'border-[var(--desk-line-color)] bg-[var(--desk-surface)] text-muted-foreground'
      } disabled:cursor-not-allowed`}
      style={phone ? { flex: '1 1 auto', minHeight: 44 } : undefined}
    >
      {busy ? 'Saving…' : 'Record the review and act'}
    </button>
  );
  // Right under the button it disables: why it cannot go yet.
  const whyLine = decision && blockedReason && !recordedButStuck && (
    <p data-blocked-why className={`text-sm ${statusText.warn}`} role="status" style={{ margin: 0 }}>
      {blockedReason}
    </p>
  );
  const retryButton = recordedButStuck && (
    <button
      type="button"
      disabled={busy}
      onClick={retryMove}
      className={`desk-pill border px-4 py-2 text-sm font-medium ${CALM} ${FOCUS} ${statusGlass.warn}`}
      style={phone ? { flex: '1 1 auto', minHeight: 44 } : undefined}
    >
      Retry the move only
    </button>
  );
  const showActionBar = phone && !!req && !waitMode && !sendBackTo && (!photosTab || tab === 'review');

  return (
    <div className="fixed inset-0 z-50 flex justify-end" role="dialog" aria-modal="true" aria-label="Review this request">
      <button type="button" aria-label="Close the review" onClick={onClose} className="absolute inset-0 bg-black/60" />
      {stage === 'coo' && cooReason.picker}

      <div
        data-drawer={phone ? 'sheet' : 'side'}
        className={`desk-root relative flex h-full w-full flex-col overflow-hidden shadow-2xl ${phone ? '' : 'max-w-3xl border-l border-[var(--desk-line-color)]'}`}
        style={phone ? { maxWidth: 'none' } : undefined}
      >
        <header className="flex shrink-0 items-start justify-between gap-4 border-b border-[var(--desk-line-color)] px-5 py-4">
          <div className="min-w-0 space-y-1">
            <h2 className="truncate text-lg font-semibold text-foreground">
              {STAGE_NAME[stage]} review · {req?.tenant?.name ?? 'Request'}
            </h2>
            <p className={LABEL}>
              <span className="font-mono">{requestId.slice(0, 8)}</span>
              {req ? ` · round ${req.round + 1}` : ''}
              {sheet.data?.my_staff_ref ? ` · staff ${sheet.data.my_staff_ref}` : ''}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className={`desk-pill border border-[var(--desk-line-color)] bg-[var(--desk-surface)] p-2 ${CALM} ${FOCUS} hover:bg-[var(--desk-surface-hover)]`}
          >
            <X className="h-4 w-4" aria-hidden />
          </button>
        </header>

        <div className="min-h-0 flex-1 space-y-5 overflow-auto px-5 py-5">
          {sheet.isLoading && (
            <div className="space-y-3" role="status" aria-label="Loading the request">
              <Skeleton className="h-24 w-full" />
              <Skeleton className="h-40 w-full" />
            </div>
          )}

          {sheet.error && (
            <p className={`text-sm ${statusText.bad}`} role="alert">
              {readableError(sheet.error)}
            </p>
          )}

          {req && photosTab && (
            <div role="tablist" aria-label="Review views" className="flex gap-1.5">
              {(['review', 'photos'] as const).map((t) => (
                <button
                  key={t}
                  type="button"
                  role="tab"
                  aria-selected={tab === t}
                  onClick={() => setTab(t)}
                  className={`desk-pill border px-3.5 py-1.5 text-sm ${CALM} ${FOCUS} ${
                    tab === t
                      ? 'border-[hsl(var(--primary)/0.6)] bg-[hsl(var(--primary)/0.18)] text-foreground'
                      : 'border-[var(--desk-line-color)] bg-[var(--desk-surface)] text-muted-foreground hover:text-foreground'
                  }`}
                >
                  {t === 'review' ? 'Review' : 'Photos'}
                </button>
              ))}
            </div>
          )}

          {req && photosTab && tab === 'photos' && <PhotoReview requestId={requestId} />}

          {req && (
            // Hidden rather than unmounted on the Photos tab, so ticks and notes survive a tab switch.
            <div className={photosTab && tab !== 'review' ? 'hidden' : 'space-y-5'}>
              {/* ── The facts, as the agent recorded them ── */}
              <section className={`${PANEL} space-y-4 p-4`}>
                <h3 className="text-sm font-semibold text-foreground">What the agent sent</h3>
                <Photos urls={req.house_photos ?? []} />
                <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                  <Fact label="Rent asked">
                    <span className={`${FIGURE} text-xl`}>UGX {fmt('ugxfull', req.rent_amount)}</span>
                    {req.duration_days ? <span className="ml-2 text-xs text-muted-foreground">over {req.duration_days} days</span> : null}
                  </Fact>
                  <Fact label="Tenant">
                    {req.tenant?.name ?? '—'}
                    {stage === 'tenant_ops' && (
                      <span className="ml-1.5 align-middle">
                        <DeskCallButton
                          target={{ requestId, desk: stage, subject: 'tenant', calleeId: req.tenant?.id ?? null, name: req.tenant?.name ?? null, phone: req.tenant?.phone ?? null }}
                          autoFocus={initial === 'call'}
                          onEnded={(ok) => ok && setLiveAnswered(true)}
                        />
                      </span>
                    )}
                    <div className="text-xs text-muted-foreground">
                      {req.tenant?.phone ?? 'no number'}
                      {req.tenant?.occupation ? ` · ${req.tenant.occupation}` : ''}
                    </div>
                  </Fact>
                  <Fact label="Agent">
                    {req.agent?.name ?? '—'}
                    <span className="ml-1.5 align-middle">
                      <DeskCallButton
                        target={{ requestId, desk: stage, subject: 'agent', calleeId: req.agent?.id ?? null, name: req.agent?.name ?? null, phone: req.agent?.phone ?? null }}
                      />
                    </span>
                    <div className="text-xs text-muted-foreground">{req.agent?.phone ?? 'no number'}</div>
                  </Fact>
                  <Fact label="Landlord">
                    {req.landlord?.name ?? '—'}
                    {stage === 'landlord_ops' && (
                      <span className="ml-1.5 align-middle">
                        <DeskCallButton
                          target={{ requestId, desk: stage, subject: 'landlord', calleeId: null, name: req.landlord?.name ?? null, phone: req.landlord?.phone ?? null }}
                          autoFocus={initial === 'call'}
                          onEnded={(ok) => ok && setLiveAnswered(true)}
                        />
                      </span>
                    )}
                    <div className="text-xs text-muted-foreground">{req.landlord?.phone ?? 'no number'}</div>
                    <span className={`desk-pill mt-1 inline-block border px-2 py-0.5 text-xs ${req.landlord?.verified ? statusGlass.ok : statusGlass.warn}`}>
                      {req.landlord?.verified ? 'Verified' : 'Not verified'}
                    </span>
                  </Fact>
                  <Fact label="LC1">
                    {req.lc1?.name ?? 'No chairperson recorded'}
                    <div className="mt-1">
                      {req.lc_letter ? (
                        <LcLetter bucket={req.lc_letter.bucket} path={req.lc_letter.path} />
                      ) : (
                        <span className={statusText.warn}>No letter file — confirm by phone and write who confirmed.</span>
                      )}
                    </div>
                  </Fact>
                  <Fact label="Where the house is">
                    {req.gps ? (
                      <a
                        href={`https://www.google.com/maps/search/?api=1&query=${req.gps.lat},${req.gps.lng}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className={`inline-flex items-center gap-1.5 rounded text-[hsl(var(--desk-lavender))] underline underline-offset-4 ${FOCUS}`}
                      >
                        <MapPin className="h-3.5 w-3.5" aria-hidden /> Open the pin on the map
                        <ExternalLink className="h-3 w-3" aria-hidden />
                      </a>
                    ) : (
                      <span className={statusText.bad}>No GPS pin.</span>
                    )}
                  </Fact>
                </div>
              </section>

              {stage === 'landlord_ops' && <LandlordContextPanel requestId={requestId} />}

              {/* ── Tenant Ops: how the tenant has paid, and the agent who brought them ── */}
              {stage === 'tenant_ops' && (
                <div className="grid gap-4 sm:grid-cols-2" style={{ display: 'grid', gap: 16 }}>
                  <PaymentHealthPanel tenantId={req.tenant?.id ?? null} />
                  <section className={`${PANEL} p-4`} style={stackLayout(6)} aria-label="Agent">
                    <h3 className="text-sm font-semibold text-foreground" style={{ margin: 0 }}>
                      Agent
                    </h3>
                    <p className="text-sm text-foreground">{req.agent?.name ?? 'No agent recorded'}</p>
                    <p className="font-mono text-xs text-muted-foreground">{req.agent?.phone ?? 'no number'}</p>
                    <span className="inline-flex items-center gap-1.5 text-sm text-foreground">
                      Call agent
                      <DeskCallButton
                        target={{ requestId, desk: stage, subject: 'agent', calleeId: req.agent?.id ?? null, name: req.agent?.name ?? null, phone: req.agent?.phone ?? null }}
                      />
                    </span>
                  </section>
                </div>
              )}

              {showIntake && (
                <IntakeForm
                  requestId={requestId}
                  stage={stage}
                  agent={{ id: req.agent?.id ?? null, name: req.agent?.name ?? null, phone: req.agent?.phone ?? null }}
                  itemsMissing={ctx?.itemsMissing ?? []}
                  waitSuggest={ctx?.waitSuggest ?? null}
                />
              )}

              {initial === 'call' && callDesk && (
                <p className={`rounded-xl border px-3 py-2 text-sm ${statusGlass.warn}`}>
                  Call the {callDesk} first: press the phone button next to their name above, then log the call below.
                </p>
              )}

              {/* ── The call, which must come before the decision ── */}
              {callDesk && (
                <CallLog
                  requestId={requestId}
                  subject={callDesk}
                  subjectUserId={callDesk === 'tenant' ? req.tenant?.id : null}
                  defaultPhone={callDesk === 'tenant' ? (req.tenant?.phone ?? null) : (req.landlord?.phone ?? null)}
                  onLogged={(answered) => {
                    setCallAnswered((prev) => prev || answered);
                    void queryClient.invalidateQueries({ queryKey: awarenessCallsKey(requestId) });
                  }}
                  answeredHint={liveAnswered}
                />
              )}

              <RequestCallHistory requestId={requestId} />

              {concernDesk && (
                <div ref={concernRef}>
                  <ConcernsSection requestId={requestId} desk={concernDesk} />
                </div>
              )}

              {/* ── The checklist ── */}
              <section className={`${PANEL} space-y-1 p-4`}>
                <h3 className="text-sm font-semibold text-foreground">The checks for this desk</h3>
                <ul>
                  {items.map((c) => (
                    <Fragment key={c.code}>
                      {/* The call script sits right above "Value proposition offered". */}
                      {stage === 'landlord_ops' && c.code === 'lo_value_prop' && lctx?.script && (
                        <li className="py-3">
                          <ScriptPanel script={lctx.script} />
                        </li>
                      )}
                      <CheckRow
                        item={c}
                        entry={entries[c.code]}
                        needsText={c.code === 'sc_lc1_letter' && lc1NeedsText}
                        onResult={(r) => setResult(c.code, r)}
                        onValue={(v) => setValue(c.code, v)}
                        extra={
                          stage !== 'landlord_ops' || !lctx ? undefined : c.code === 'lo_rent_confirmed' ? (
                            // The box starts empty: the reviewer types what the landlord says, never the request's figure.
                            <span className="text-foreground">
                              {rentOnRequestText(lctx.rent_on_request)}
                              <span className={`block ${statusText.warn}`}>{RENT_EXACT_HINT}</span>
                            </span>
                          ) : c.code === 'lo_tenant_no_arrears' && lctx.landlord?.arrears_hint ? (
                            <span className={statusText.warn}>Arrears hint: {lctx.landlord.arrears_hint}</span>
                          ) : undefined
                        }
                      />
                    </Fragment>
                  ))}
                  {items.length === 0 && <li className="py-3 text-sm text-muted-foreground">No checks are configured for this desk.</li>}
                </ul>
              </section>

              {/* ── What the system recommends ── */}
              <section className={`desk-panel desk-capsule border p-4 ${against ? statusGlass.warn : statusGlass.ok}`}>
                <p className="text-sm">
                  <span className="font-semibold">The system says: </span>
                  {recommended ? DECISION_LABEL[recommended] : 'no recommendation for this stage'}
                  {sheet.data?.recommendation?.reason_code ? ` (${sheet.data.recommendation.reason_code})` : ''}
                </p>
                {(sheet.data?.recommendation?.failed?.length ?? 0) > 0 && (
                  <p className="mt-1 text-xs">Failing: {(sheet.data?.recommendation?.failed ?? []).join(', ')}</p>
                )}
                {typeof sheet.data?.score?.score === 'number' && (
                  <p className="mt-1 text-xs">Score so far: {sheet.data.score.score}</p>
                )}
              </section>

              {/* ── The decision ── */}
              <section className={`${PANEL} space-y-4 p-4`}>
                <h3 className="text-sm font-semibold text-foreground">Your decision</h3>
                {callDesk && canPass && (
                  <p data-call-on-file className={`text-sm ${statusText.ok}`} style={{ margin: 0 }}>
                    {onFile
                      ? `Answered call on file — ${callTime(onFile.at)}${onFile.by ? `, ${onFile.by}` : ''}`
                      : callAnswered
                        ? 'Answered call logged just now'
                        : 'Answered call on file'}
                  </p>
                )}
                <div className="flex flex-wrap gap-2">
                  {visibleDecisions(stage).map((d) => {
                    const on = decision === d;
                    const isRec = recommended === d;
                    const off = d === 'pass' && !canPass;
                    return (
                      <button
                        key={d}
                        type="button"
                        aria-pressed={on}
                        disabled={off}
                        onClick={() => {
                          setDecision(d);
                          setWaitMode(false);
                        }}
                        title={off ? `Log an answered ${callDesk} call first.` : DECISION_HELP[d]}
                        className={`desk-pill border px-3.5 py-1.5 text-sm ${CALM} ${FOCUS} ${
                          on
                            ? statusGlass.ok
                            : 'border-[var(--desk-line-color)] bg-[var(--desk-surface)] text-muted-foreground hover:bg-[var(--desk-surface-hover)] hover:text-foreground'
                        } disabled:cursor-not-allowed disabled:opacity-40`}
                      >
                        {DECISION_LABEL[d]}
                        {isRec && <span className="ml-1.5 text-xs opacity-80">· recommended</span>}
                      </button>
                    );
                  })}
                  {canWait && (
                    <button
                      type="button"
                      aria-pressed={waitMode}
                      onClick={() => {
                        setWaitMode(true);
                        setDecision(null);
                      }}
                      title="Keep the request at this desk while someone else acts."
                      className={`desk-pill border px-3.5 py-1.5 text-sm ${CALM} ${FOCUS} ${
                        waitMode
                          ? statusGlass.warn
                          : 'border-[var(--desk-line-color)] bg-[var(--desk-surface)] text-muted-foreground hover:bg-[var(--desk-surface-hover)] hover:text-foreground'
                      }`}
                    >
                      Wait on…
                    </button>
                  )}
                </div>
                {/* Why Pass cannot go yet, right under the buttons: the call, open checks, a reason code. */}
                {visibleDecisions(stage).includes('pass') && !!passWhy && (!canPass || decision === 'pass') && (
                  <p data-pass-why className={`text-sm ${statusText.warn}`} style={{ margin: 0 }}>
                    Pass: {passWhy}
                  </p>
                )}
                {waitMode && waitDesk && (
                  <>
                    <WaitOnForm
                      requestId={requestId}
                      desk={waitDesk}
                      deskTag={DESK_TAG[stage]}
                      onDone={(message) => {
                        setOutcome(message);
                        toast.success(message);
                        window.setTimeout(onClose, 1200);
                      }}
                    />
                    {outcome && <p className={`text-sm ${statusText.ok}`}>{outcome}</p>}
                  </>
                )}
                {!waitMode && sendBackTo && (
                  <SendBackForm
                    key={`${requestId}:send-back`}
                    requestId={requestId}
                    stage={stage}
                    initial={fromReject ? { to: SUGGESTED_OFFICE } : undefined}
                    onDone={(message) => {
                      clear(requestId);
                      mark(requestId, { kind: 'moved', message });
                      window.setTimeout(onClose, 1200);
                    }}
                  />
                )}
                {!waitMode && !sendBackTo && (
                <>
                {decision && DECISION_HELP[decision] && (
                  <p className="text-xs text-muted-foreground">{DECISION_HELP[decision]}</p>
                )}

                {decision === 'transfer' && (
                  <div className="space-y-2">
                    <p className={LABEL}>Move the tenant to</p>
                    {suggested.isLoading && <Skeleton className="h-10 w-full" />}
                    {suggested.error && <p className={`text-sm ${statusText.bad}`}>{readableError(suggested.error)}</p>}
                    <ul className="space-y-1.5">
                      {(suggested.data ?? []).map((a) => {
                        const on = targetAgentId === a.agent_id;
                        return (
                          <li key={a.agent_id}>
                            <button
                              type="button"
                              aria-pressed={on}
                              onClick={() => setTargetAgentId(a.agent_id)}
                              className={`w-full rounded-xl border px-3 py-2 text-left ${CALM} ${FOCUS} ${
                                on ? statusGlass.ok : 'border-[var(--desk-line-color)] bg-[var(--desk-surface)] hover:bg-[var(--desk-surface-hover)]'
                              }`}
                            >
                              <span className="text-sm font-medium text-foreground">{a.agent_name ?? 'Agent'}</span>
                              <span className={`${LABEL} block`}>
                                {a.km === null ? 'distance unknown' : `${Number(a.km).toFixed(1)} km away`} ·{' '}
                                {a.in_window_pct === null ? 'no collection record' : `${Math.round(Number(a.in_window_pct) * 100)}% collected`} ·{' '}
                                {fmt('int', a.active_tenants)} active tenants
                              </span>
                            </button>
                          </li>
                        );
                      })}
                      {!suggested.isLoading && (suggested.data ?? []).length === 0 && (
                        <li className="text-sm text-muted-foreground">No agent nearby has room for this tenant.</li>
                      )}
                    </ul>
                  </div>
                )}

                {decision === 'attach_funder' && (
                  <label className="block space-y-1.5">
                    <span className={LABEL}>Proxy partner</span>
                    <select
                      value={proxyAgentId ?? ''}
                      onChange={(e) => setProxyAgentId(e.target.value || null)}
                      className={`desk-pill h-9 w-full max-w-sm border border-[var(--desk-line-color)] bg-[var(--desk-surface)] px-3 text-sm text-foreground ${FOCUS}`}
                    >
                      <option value="">Choose a verified proxy partner…</option>
                      {(proxies.data ?? []).map((p) => (
                        <option key={p.agent_user_id} value={p.agent_user_id}>
                          {p.full_name ?? p.agent_user_id}
                        </option>
                      ))}
                    </select>
                  </label>
                )}

                {against && (
                  <label className="block space-y-1.5">
                    <span className={LABEL}>
                      You are going against the system — why? (reason code)
                    </span>
                    <select
                      value={reasonCode}
                      onChange={(e) => setReasonCode(e.target.value)}
                      className={`desk-pill h-9 w-full max-w-md border border-[var(--desk-line-color)] bg-[var(--desk-surface)] px-3 text-sm text-foreground ${FOCUS}`}
                    >
                      <option value="">Choose a reason code…</option>
                      {reasonList.map((r) => (
                        <option key={r.code} value={r.code}>
                          {r.code} — {r.meaning ?? ''}
                        </option>
                      ))}
                    </select>
                  </label>
                )}

                <label className="block space-y-1.5">
                  <span className={LABEL}>
                    Note{noteRequired ? ` (at least ${NOTE_MIN} characters)` : ' (optional)'}
                  </span>
                  <textarea
                    value={note}
                    onChange={(e) => setNote(e.target.value)}
                    rows={3}
                    placeholder="What you saw, in plain words. The agent reads this when a request is sent back."
                    className={`w-full rounded-xl border border-[var(--desk-line-color)] bg-[var(--desk-surface)] px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground ${FOCUS}`}
                  />
                </label>

                {error && (
                  <p className={`text-sm ${statusText.bad}`} role="alert">
                    {error}
                  </p>
                )}
                {outcome && !error && <p className={`text-sm ${statusText.ok}`}>{outcome}</p>}

                {!phone && (
                  <div style={stackLayout(6)}>
                    <div className="flex flex-wrap gap-2">
                      {submitButton}
                      {retryButton}
                    </div>
                    {whyLine}
                  </div>
                )}
                </>
                )}
              </section>

              {/* ── What the desks before this one decided ── */}
              {(sheet.data?.history ?? []).length > 0 && (
                <section className={`${PANEL} space-y-2 p-4`}>
                  <h3 className="text-sm font-semibold text-foreground">What the desks before this one decided</h3>
                  <ul className="space-y-1.5">
                    {(sheet.data?.history ?? []).map((h, i) => {
                      // E64: a send-back names the office it went to and the reason in words.
                      const sent = h.decision === 'send_back' ? parseSendBackNote(h.note) : null;
                      const meaning = h.reason_code ? (reasons.data ?? []).find((r) => r.code === h.reason_code)?.meaning ?? null : null;
                      return (
                        <li key={`${h.stage}-${h.at}-${i}`} className={LABEL} data-history={h.decision}>
                          <span className="text-foreground">{STAGE_NAME[h.stage] ?? h.stage}</span>: {DECISION_LABEL[h.decision] ?? h.decision}
                          {sent && (
                            <>
                              {' → '}
                              <span className="font-medium text-foreground" data-sent-to>
                                {sent.office}
                              </span>
                            </>
                          )}
                          {h.followed === false ? ' (went against the system)' : ''}
                          {h.reason_code ? ` · ${meaning ?? h.reason_code}` : ''}
                          {h.by ? ` · ${h.by}` : ''}
                          {h.staff_ref ? ` (${h.staff_ref})` : ''}
                          {sent ? (sent.why && sent.why !== meaning ? ` — ${sent.why}` : '') : h.note ? ` — ${h.note}` : ''}
                        </li>
                      );
                    })}
                  </ul>
                </section>
              )}
            </div>
          )}
        </div>

        {showActionBar && (
          <div
            data-action-bar
            className="shrink-0 border-t border-[var(--desk-line-color)] bg-[hsl(var(--background))]"
            style={{ display: 'flex', flexDirection: 'column', gap: 6, padding: 12, paddingBottom: 'calc(12px + env(safe-area-inset-bottom, 0px))' }}
          >
            <div style={{ display: 'flex', gap: 8 }}>
              {submitButton}
              {retryButton || (
                <DecisionButton variant="quiet" size="md" onClick={onClose} style={{ minHeight: 44 }}>
                  Close
                </DecisionButton>
              )}
            </div>
            {whyLine}
          </div>
        )}
      </div>
    </div>
  );
}
