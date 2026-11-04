import { useEffect, useMemo, useState } from 'react';
import { ExternalLink, FileText, MapPin, X } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { useAuth } from '@/hooks/useAuth';
import { fmt } from './format';
import { CALM, FIGURE, FOCUS, LABEL, PANEL, statusGlass, statusText, type Status } from './deskTheme';
import { Skeleton } from './Skeleton';
import { CallLog } from './CallLog';
import { isRecordOnly, needsNote, runMove } from './deskActions';
import { useCooReasonPicker } from '@/components/coo/CooReasonPicker';
import { RETRY_LABEL, useReviewStatus } from './reviewStatus';
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
  STAGE_DECISIONS,
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
          className={`block overflow-hidden rounded-lg border border-white/12 ${FOCUS}`}
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
}: {
  item: ChecklistItem;
  entry: CheckEntry | undefined;
  /** True when this item needs a written answer even though its value_kind is empty. */
  needsText: boolean;
  onResult: (r: CheckResult) => void;
  onValue: (v: unknown) => void;
}) {
  const kind = item.value_kind;
  const showInput = (!!kind || needsText) && entry?.result === 'pass';
  const numeric = kind === 'number' || kind === 'amount';

  return (
    <li className="space-y-2 border-b border-white/8 py-3 last:border-0">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <p className="text-sm font-medium text-foreground">
            {item.label}
            {item.required && <span className="ml-1.5 text-xs text-muted-foreground">(required)</span>}
          </p>
          <p className="text-xs leading-snug text-muted-foreground">{item.question}</p>
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
                  on ? statusGlass[RESULT_TONE[r]] : 'border-white/12 bg-white/5 text-muted-foreground hover:bg-white/10 hover:text-foreground'
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
            className={`desk-pill h-9 w-full max-w-sm border border-white/12 bg-white/5 px-3 text-sm text-foreground placeholder:text-muted-foreground ${FOCUS}`}
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
}: {
  stage: Stage;
  requestId: string;
  onClose: () => void;
}) {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const { mark, clear } = useReviewStatus();
  const sheet = useReviewSheet(requestId);
  const reasons = useReasonCodes();

  const [entries, setEntries] = useState<Record<string, CheckEntry>>({});
  const [decision, setDecision] = useState<Decision | null>(null);
  const [reasonCode, setReasonCode] = useState<string>('');
  const cooReason = useCooReasonPicker();
  const [note, setNote] = useState('');
  const [targetAgentId, setTargetAgentId] = useState<string | null>(null);
  const [proxyAgentId, setProxyAgentId] = useState<string | null>(null);
  const [callAnswered, setCallAnswered] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<string | null>(null);

  const callDesk = stage === 'tenant_ops' ? 'tenant' : stage === 'landlord_ops' ? 'landlord' : null;
  const suggested = useSuggestedAgents(requestId, decision === 'transfer');
  const proxies = useProxyAgents(decision === 'attach_funder');

  const items = useMemo(() => stageChecklist(sheet.data, stage), [sheet.data, stage]);
  const req = sheet.data?.request;
  const recommended = sheet.data?.recommendation?.recommended ?? null;
  const against = !!decision && !!recommended && decision !== recommended;

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

  const canPass = !callDesk || callAnswered;
  const blockedReason =
    decision === 'pass' && !canPass
      ? `Log an answered ${callDesk} call before passing.`
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

    try {
      // 1. Record the review. This is the step that must never be repeated.
      const { error: recErr } = await rpc('pipeline_record_review', {
        p_request_id: requestId,
        p_stage: stage,
        p_results: results,
        p_decision: decision,
        p_reason_code: against ? reasonCode : reasonCode || null,
        p_note: note.trim() || null,
        p_target_agent_id: decision === 'transfer' ? targetAgentId : null,
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
      setOutcome(moved.message);
      queryClient.invalidateQueries({ queryKey: ['desk-feed'] });
      if (!isRecordOnly(stage, decision)) window.setTimeout(onClose, 900);
    } catch (e) {
      setError(readableError(e));
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
    });
    setBusy(false);
    if (!moved.ok) {
      setError(`${RETRY_LABEL}. ${moved.message}`);
      return;
    }
    clear(requestId);
    mark(requestId, { kind: 'moved', message: moved.message });
    setOutcome(moved.message);
    queryClient.invalidateQueries({ queryKey: ['desk-feed'] });
    window.setTimeout(onClose, 900);
  };

  const recordedButStuck = !!error && error.startsWith(RETRY_LABEL);

  return (
    <div className="fixed inset-0 z-50 flex justify-end" role="dialog" aria-modal="true" aria-label="Review this request">
      <button type="button" aria-label="Close the review" onClick={onClose} className="absolute inset-0 bg-black/60" />
      {stage === 'coo' && cooReason.picker}

      <div className="desk-root relative flex h-full w-full max-w-3xl flex-col overflow-hidden border-l border-white/10 shadow-2xl">
        <header className="flex shrink-0 items-start justify-between gap-4 border-b border-white/10 px-5 py-4">
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
            className={`desk-pill border border-white/12 bg-white/5 p-2 ${CALM} ${FOCUS} hover:bg-white/10`}
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

          {req && (
            <>
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
                    <div className="text-xs text-muted-foreground">
                      {req.tenant?.phone ?? 'no number'}
                      {req.tenant?.occupation ? ` · ${req.tenant.occupation}` : ''}
                    </div>
                  </Fact>
                  <Fact label="Agent">
                    {req.agent?.name ?? '—'}
                    <div className="text-xs text-muted-foreground">{req.agent?.phone ?? 'no number'}</div>
                  </Fact>
                  <Fact label="Landlord">
                    {req.landlord?.name ?? '—'}
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

              {/* ── The call, which must come before the decision ── */}
              {callDesk && (
                <CallLog
                  requestId={requestId}
                  subject={callDesk}
                  subjectUserId={callDesk === 'tenant' ? req.tenant?.id : null}
                  defaultPhone={callDesk === 'tenant' ? (req.tenant?.phone ?? null) : (req.landlord?.phone ?? null)}
                  onLogged={(answered) => setCallAnswered((prev) => prev || answered)}
                />
              )}

              {/* ── The checklist ── */}
              <section className={`${PANEL} space-y-1 p-4`}>
                <h3 className="text-sm font-semibold text-foreground">The checks for this desk</h3>
                <ul>
                  {items.map((c) => (
                    <CheckRow
                      key={c.code}
                      item={c}
                      entry={entries[c.code]}
                      needsText={c.code === 'sc_lc1_letter' && lc1NeedsText}
                      onResult={(r) => setResult(c.code, r)}
                      onValue={(v) => setValue(c.code, v)}
                    />
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
                <div className="flex flex-wrap gap-2">
                  {STAGE_DECISIONS[stage].map((d) => {
                    const on = decision === d;
                    const isRec = recommended === d;
                    const off = d === 'pass' && !canPass;
                    return (
                      <button
                        key={d}
                        type="button"
                        aria-pressed={on}
                        disabled={off}
                        onClick={() => setDecision(d)}
                        title={off ? `Log an answered ${callDesk} call first.` : DECISION_HELP[d]}
                        className={`desk-pill border px-3.5 py-1.5 text-sm ${CALM} ${FOCUS} ${
                          on
                            ? statusGlass.ok
                            : 'border-white/12 bg-white/5 text-muted-foreground hover:bg-white/10 hover:text-foreground'
                        } disabled:cursor-not-allowed disabled:opacity-40`}
                      >
                        {DECISION_LABEL[d]}
                        {isRec && <span className="ml-1.5 text-xs opacity-80">· recommended</span>}
                      </button>
                    );
                  })}
                </div>
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
                                on ? statusGlass.ok : 'border-white/12 bg-white/5 hover:bg-white/10'
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
                      className={`desk-pill h-9 w-full max-w-sm border border-white/12 bg-white/5 px-3 text-sm text-foreground ${FOCUS}`}
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
                      className={`desk-pill h-9 w-full max-w-md border border-white/12 bg-white/5 px-3 text-sm text-foreground ${FOCUS}`}
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
                    className={`w-full rounded-xl border border-white/12 bg-white/5 px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground ${FOCUS}`}
                  />
                </label>

                {decision && blockedReason && !recordedButStuck && (
                  <p className={`text-sm ${statusText.warn}`}>{blockedReason}</p>
                )}
                {error && (
                  <p className={`text-sm ${statusText.bad}`} role="alert">
                    {error}
                  </p>
                )}
                {outcome && !error && <p className={`text-sm ${statusText.ok}`}>{outcome}</p>}

                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    disabled={!decision || !!blockedReason || busy || recordedButStuck}
                    onClick={submit}
                    className={`desk-pill border px-4 py-2 text-sm font-medium ${CALM} ${FOCUS} ${
                      decision && !blockedReason && !busy && !recordedButStuck
                        ? statusGlass.ok
                        : 'border-white/12 bg-white/5 text-muted-foreground'
                    } disabled:cursor-not-allowed`}
                  >
                    {busy ? 'Saving…' : 'Record the review and act'}
                  </button>

                  {recordedButStuck && (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={retryMove}
                      className={`desk-pill border px-4 py-2 text-sm font-medium ${CALM} ${FOCUS} ${statusGlass.warn}`}
                    >
                      Retry the move only
                    </button>
                  )}
                </div>
              </section>

              {/* ── What the desks before this one decided ── */}
              {(sheet.data?.history ?? []).length > 0 && (
                <section className={`${PANEL} space-y-2 p-4`}>
                  <h3 className="text-sm font-semibold text-foreground">What the desks before this one decided</h3>
                  <ul className="space-y-1.5">
                    {(sheet.data?.history ?? []).map((h, i) => (
                      <li key={`${h.stage}-${h.at}-${i}`} className={LABEL}>
                        <span className="text-foreground">{STAGE_NAME[h.stage] ?? h.stage}</span>: {DECISION_LABEL[h.decision] ?? h.decision}
                        {h.followed === false ? ' (went against the system)' : ''}
                        {h.reason_code ? ` · ${h.reason_code}` : ''}
                        {h.by ? ` · ${h.by}` : ''}
                        {h.staff_ref ? ` (${h.staff_ref})` : ''}
                        {h.note ? ` — ${h.note}` : ''}
                      </li>
                    ))}
                  </ul>
                </section>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
