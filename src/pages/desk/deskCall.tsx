import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Phone, PhoneOff } from 'lucide-react';
import { isTerminalCallState, useCrmVoiceCall, useHumanCallingPaused, type CallState } from '@/hooks/useCrmVoiceCall';
import { rpc, readableError } from './reviewApi';
import { CALM, FOCUS, LABEL, PANEL, statusGlass, statusText } from './deskTheme';
import { Skeleton } from './Skeleton';
import { fmt } from './format';

/**
 * The company call button on the desks.
 *
 * No new dialer: this is the CRM's own browser calling (`useCrmVoiceCall` —
 * Africa's Talking WebRTC, `crm_call_sessions`). Once the session id is known
 * the call is tied to the request with `pipeline_link_call`, so the drawer's
 * call history can show it.
 */

export type CallSubjectKind = 'agent' | 'tenant' | 'landlord';

export type DeskCallTarget = {
  requestId: string;
  /** `p_desk`: agent_ops, tenant_ops, … */
  desk: string;
  subject: CallSubjectKind;
  /** The person's user id when they have one. A landlord is never a user. */
  calleeId: string | null;
  name: string | null;
  phone: string | null;
};

const STATE_WORDS: Record<CallState, string> = {
  idle: 'Ready',
  initializing: 'Connecting…',
  calling: 'Calling…',
  ringing: 'Ringing…',
  connected: 'Connected',
  ending: 'Ending…',
  completed: 'Call ended',
  cancelled: 'Cancelled',
  rejected: 'Rejected',
  busy: 'Busy',
  no_answer: 'No answer',
  failed: 'Call failed',
};

const clock = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;

/** The live leg. Mounted only while a call is happening, so idle rows hold no SDK listeners. */
function LiveCall({ target, onDone }: { target: DeskCallTarget; onDone: (answered: boolean) => void }) {
  const call = useCrmVoiceCall();
  const queryClient = useQueryClient();
  const started = useRef(false);
  const linked = useRef<string | null>(null);
  const reported = useRef(false);
  const [linkError, setLinkError] = useState<string | null>(null);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void call.start({ calleeId: target.calleeId, name: target.name ?? target.subject, phone: target.phone, role: target.subject, location: null });
  }, [call, target]);

  // Tie the session to the request as soon as its id exists.
  useEffect(() => {
    const id = call.callId;
    if (!id || linked.current === id) return;
    linked.current = id;
    void rpc('pipeline_link_call', {
      p_call_session_id: id,
      p_request_id: target.requestId,
      p_desk: target.desk,
      p_subject: target.subject,
    }).then(({ error }) => {
      if (error) setLinkError(readableError(error));
      queryClient.invalidateQueries({ queryKey: ['desk-feed', 'request-calls', target.requestId] });
    });
  }, [call.callId, target, queryClient]);

  useEffect(() => {
    if (!isTerminalCallState(call.state) || reported.current) return;
    reported.current = true;
    queryClient.invalidateQueries({ queryKey: ['desk-feed', 'request-calls', target.requestId] });
    onDone(call.state === 'completed');
  }, [call.state, onDone, queryClient, target.requestId]);

  const live = !isTerminalCallState(call.state) && call.state !== 'idle';
  const tone = call.state === 'connected' || call.state === 'completed' ? 'ok' : live ? 'warn' : 'bad';

  return (
    <span className={`desk-pill inline-flex items-center gap-1.5 border px-2 py-0.5 text-[11px] ${statusGlass[tone]}`} role="status">
      {STATE_WORDS[call.state]}
      {(call.state === 'connected' || call.state === 'completed') && <span className="tabular-nums">{clock(call.elapsed)}</span>}
      {live && (
        <button
          type="button"
          onClick={call.end}
          disabled={call.isEnding}
          aria-label={`Hang up on ${target.name ?? `the ${target.subject}`}`}
          className={`rounded-full p-0.5 ${CALM} ${FOCUS} hover:bg-[var(--desk-surface-hover)]`}
        >
          <PhoneOff className="h-3.5 w-3.5" aria-hidden />
        </button>
      )}
      {call.error && <span className={statusText.bad}>{call.error}</span>}
      {linkError && <span className={statusText.bad}>Not linked to the request: {linkError}</span>}
    </span>
  );
}

/**
 * 📞 for one person on one request. `onEnded(answered)` fires once when the
 * call ends — Tenant and Landlord Ops use it to pre-select "Answered".
 */
export function DeskCallButton({
  target,
  onEnded,
  disabled,
  autoFocus,
}: {
  target: DeskCallTarget;
  onEnded?: (answered: boolean) => void;
  disabled?: boolean;
  /** Focus the button on mount — the drawer opened from "Call tenant"/"Call landlord". */
  autoFocus?: boolean;
}) {
  const paused = useHumanCallingPaused();
  const [active, setActive] = useState(false);
  const [last, setLast] = useState<{ answered: boolean } | null>(null);

  const done = (answered: boolean) => {
    setLast({ answered });
    onEnded?.(answered);
  };

  if (active) {
    return (
      <span className="inline-flex items-center gap-1">
        <LiveCall target={target} onDone={done} />
        {last && (
          <button
            type="button"
            onClick={() => {
              setActive(false);
              setLast(null);
            }}
            className={`${LABEL} rounded underline underline-offset-2 ${FOCUS}`}
          >
            Close
          </button>
        )}
      </span>
    );
  }

  const linePaused = paused.data?.paused === true;
  const noPhone = !target.phone;
  const off = disabled || linePaused || noPhone;
  const why = noPhone
    ? 'No number on file'
    : linePaused
      ? paused.data?.reason ?? 'Calling is paused right now'
      : `Call ${target.name ?? `the ${target.subject}`} from the company line`;

  return (
    <button
      type="button"
      disabled={off}
      title={why}
      aria-label={why}
      autoFocus={autoFocus}
      onClick={() => setActive(true)}
      className={`desk-pill inline-flex items-center border border-[var(--desk-line-color)] bg-[var(--desk-surface)] p-1 text-[hsl(var(--desk-lavender))] ${CALM} ${FOCUS} hover:bg-[var(--desk-surface-hover)] disabled:cursor-not-allowed disabled:opacity-40`}
    >
      <Phone className="h-3.5 w-3.5" aria-hidden />
    </button>
  );
}

/* ───────────────────────── call history in the drawer ───────────────────────── */

type RequestCall = {
  call_session_id: string;
  desk: string | null;
  subject: string | null;
  staff_name: string | null;
  status: string | null;
  answered: boolean | null;
  duration_seconds: number | null;
  started_at: string | null;
  recording: string | null;
};

export function useRequestCalls(requestId: string) {
  return useQuery({
    queryKey: ['desk-feed', 'request-calls', requestId],
    queryFn: async (): Promise<RequestCall[]> => {
      const { data, error } = await rpc('pipeline_request_calls', { p_request_id: requestId });
      if (error) throw error;
      return Array.isArray(data) ? (data as RequestCall[]) : [];
    },
    refetchInterval: 30_000,
    staleTime: 10_000,
    retry: 1,
  });
}

const DESK_NAME: Record<string, string> = {
  service_centre: 'Service Centre',
  agent_ops: 'Agent Ops',
  tenant_ops: 'Tenant Ops',
  landlord_ops: 'Landlord Ops',
  coo: 'COO',
  cfo: 'CFO',
};

export function RequestCallHistory({ requestId }: { requestId: string }) {
  const q = useRequestCalls(requestId);
  return (
    <section className={`${PANEL} space-y-2 p-4`}>
      <h3 className="text-sm font-semibold text-foreground">Company calls on this request</h3>
      {q.isLoading && <Skeleton className="h-10 w-full" />}
      {q.error && <p className={`text-sm ${statusText.bad}`}>{readableError(q.error)}</p>}
      {!q.isLoading && !q.error && (q.data ?? []).length === 0 && (
        <p className="text-sm text-muted-foreground">No company calls linked to this request yet.</p>
      )}
      {(q.data ?? []).length > 0 && (
        <ul className="space-y-1.5">
          {(q.data ?? []).map((c) => (
            <li key={c.call_session_id} className={LABEL}>
              <span className="text-foreground">
                {c.started_at
                  ? new Date(c.started_at).toLocaleString('en-GB', { timeZone: 'Africa/Kampala', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })
                  : '—'}
              </span>{' '}
              · {c.subject ?? '—'} · {DESK_NAME[c.desk ?? ''] ?? c.desk ?? '—'} · {c.staff_name ?? '—'} ·{' '}
              <span className={c.answered ? statusText.ok : statusText.warn}>{c.answered ? 'answered' : (c.status ?? 'not answered')}</span>
              {c.duration_seconds ? ` · ${clock(c.duration_seconds)}` : ''}
              {c.recording && (
                <>
                  {' · '}
                  <a href={c.recording} target="_blank" rel="noopener noreferrer" className={`rounded text-[hsl(var(--desk-lavender))] underline underline-offset-2 ${FOCUS}`}>
                    recording
                  </a>
                </>
              )}
            </li>
          ))}
        </ul>
      )}
      {(q.data ?? []).length > 0 && (
        <p className={LABEL}>
          {fmt('int', (q.data ?? []).filter((c) => c.answered).length)} of {fmt('int', (q.data ?? []).length)} answered.
        </p>
      )}
    </section>
  );
}
