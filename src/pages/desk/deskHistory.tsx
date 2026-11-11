import { useQuery } from '@tanstack/react-query';
import { rpc } from './reviewApi';
import { LABEL, PANEL, statusText } from './deskTheme';
import { DECISION_LABEL, type Decision } from './reviewTypes';
import { Chip, ErrorLine, LoadingRows, stackLayout } from './ui';

/**
 * Desk history (E79): `request_desk_history(p_request_id)` — what every desk
 * did with a request. One block per desk in pipeline order, each review in
 * time order with who (staff ID) and when, then each check with its answer;
 * then the calls with their answers; then moves, transfers, documents and
 * concerns in one compact timeline. In the review drawer at every desk and in
 * the read-only view behind the COO / Command Centre search.
 */

export type HistoryCheck = { check: string; question: string | null; result: string | null; system_said: string | null; value: unknown; note: string | null };
export type HistoryReview = {
  desk: string;
  round: number | null;
  decision: string;
  system_said: string | null;
  followed_system: boolean | null;
  reason_code?: string | null;
  reason: string | null;
  note: string | null;
  score: number | null;
  by: string | null;
  staff_id: string | null;
  at: string;
  checks: HistoryCheck[];
};
export type HistoryCall = { at: string; team: string | null; who_called: string | null; subject: string | null; result: string | null; note: string | null; answers: Record<string, unknown> | null };
export type HistoryMove = { at: string; from: string | null; to: string | null; source: string | null; by: string | null };
export type HistoryConcern = { at: string; desk: string | null; severity: string | null; category: string | null; note: string | null; by: string | null; resolved_at: string | null };
export type HistoryAction = { at: string; action: string; reason: string | null; by: string | null; detail: Record<string, unknown> | null };
export type DeskHistoryData = {
  request: { id: string; short_id: string; status: string | null } | null;
  desks: HistoryReview[];
  calls: HistoryCall[];
  moves: HistoryMove[];
  concerns: HistoryConcern[];
  other_actions: HistoryAction[];
};

/** The desks a request passes, in order. Partner Ops (retired) shows only when it has a review. */
export const HISTORY_DESKS: { stage: string; name: string; always: boolean }[] = [
  { stage: 'service_centre', name: 'Service Centre', always: true },
  { stage: 'agent_ops', name: 'Agent Ops', always: true },
  { stage: 'tenant_ops', name: 'Tenant Ops', always: true },
  { stage: 'landlord_ops', name: 'Landlord Ops', always: true },
  { stage: 'partner_ops', name: 'Partner Ops', always: false },
  { stage: 'coo', name: 'COO', always: true },
];

const STATUS_WORDS: Record<string, string> = {
  service_center_review: 'Service Centre', pending: 'Agent Ops', agent_ops_approved: 'Tenant Ops', tenant_ops_approved: 'Landlord Ops',
  landlord_ops_approved: 'Partner Ops', partner_ops_approved: 'COO', coo_approved: 'Funders board', funded: 'Booked (float)',
  repaying: 'Repaying', completed: 'Completed', rejected: 'Back with the agent',
};
const RESULT_WORDS: Record<string, string> = { pass: 'Pass', fail: 'Fail', na: 'N/A' };
const RESULT_TONE: Record<string, 'ok' | 'bad' | 'idle'> = { pass: 'ok', fail: 'bad', na: 'idle' };
const ACTION_WORDS: Record<string, string> = {
  pipeline_tenant_transfer: 'Transferred to another agent',
  tenant_agent_transfer: 'Transferred to another agent',
  RequestDocumentAttached: 'Document attached',
  pipeline_intake_saved: 'Intake details saved',
  SendBackToDesk: 'Sent back',
  PassToNextDesk: 'Passed on',
  AgentOpsReviewPhotos: 'House photos reviewed',
  pipeline_waiting_set: 'Set waiting',
  pipeline_waiting_cleared: 'Waiting cleared',
};

export function useDeskHistory(requestId: string | null, enabled = true) {
  return useQuery({
    queryKey: ['desk-feed', 'desk-history', requestId],
    enabled: enabled && !!requestId,
    queryFn: async (): Promise<DeskHistoryData> => {
      const { data, error } = await rpc('request_desk_history', { p_request_id: requestId });
      if (error) throw error;
      const d = (data ?? {}) as Partial<DeskHistoryData>;
      const arr = <T,>(x: T[] | undefined) => (Array.isArray(x) ? x : []);
      return {
        request: d.request ?? null,
        desks: arr(d.desks),
        calls: arr(d.calls),
        moves: arr(d.moves),
        concerns: arr(d.concerns),
        other_actions: arr(d.other_actions),
      };
    },
    staleTime: 30_000,
    retry: false,
  });
}

export const when = (at: string | null | undefined) =>
  at ? new Date(at).toLocaleString('en-GB', { timeZone: 'Africa/Kampala', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—';

/** A check's value as written: whole numbers with thousands separators, objects as "key: value". */
export function valueText(v: unknown): string | null {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') return Number.isInteger(v) ? v.toLocaleString('en') : String(v);
  if (typeof v === 'string' || typeof v === 'boolean') return String(v);
  if (typeof v === 'object') {
    const parts = Object.entries(v as Record<string, unknown>)
      .filter(([, x]) => x !== null && x !== undefined && x !== '')
      .map(([k, x]) => `${k.replace(/_/g, ' ')}: ${typeof x === 'object' ? JSON.stringify(x) : String(x)}`);
    return parts.length ? parts.join(' · ') : null;
  }
  return String(v);
}

/** A call's answers ("aware 30m: knew · explained: yes"), leaving out empty ones. */
export function answersText(a: Record<string, unknown> | null | undefined): string | null {
  return valueText(a ?? null);
}

const decisionWords = (d: string | null | undefined) => (d ? (DECISION_LABEL[d as Decision] ?? d.replace(/_/g, ' ')) : '—');

function ReviewBlock({ r }: { r: HistoryReview }) {
  return (
    <li data-review={r.desk} style={{ ...stackLayout(6), listStyle: 'none' }}>
      <p className="text-sm text-foreground" style={{ margin: 0 }}>
        <span className="font-semibold">{decisionWords(r.decision)}</span>
        {r.round !== null && r.round !== undefined && r.round > 0 ? ` · round ${r.round + 1}` : ''}
        {' · '}
        {r.by ?? '—'}
        {r.staff_id ? ` (${r.staff_id})` : ''} · {when(r.at)}
      </p>
      <p className={LABEL} style={{ margin: 0 }}>
        System said {decisionWords(r.system_said)}
        {r.followed_system === false ? <span className={statusText.warn}> · went against it</span> : r.followed_system ? ' · followed' : ''}
        {r.reason ? ` · ${r.reason}` : r.reason_code ? ` · ${r.reason_code}` : ''}
        {typeof r.score === 'number' ? ` · score ${Math.round(r.score)}` : ''}
      </p>
      {r.note && <p className="text-sm text-foreground" style={{ margin: 0, overflowWrap: 'anywhere' }}>“{r.note}”</p>}
      {r.checks.length > 0 && (
        <ul style={{ margin: 0, padding: 0, ...stackLayout(4) }} aria-label="Checks">
          {r.checks.map((c, i) => {
            const v = valueText(c.value);
            return (
              <li key={`${c.check}-${i}`} data-check={c.check} style={{ listStyle: 'none', display: 'flex', flexWrap: 'wrap', alignItems: 'baseline', gap: 6 }}>
                <Chip tone={RESULT_TONE[c.result ?? ''] ?? 'idle'}>{RESULT_WORDS[c.result ?? ''] ?? c.result ?? '—'}</Chip>
                <span className="text-sm text-foreground">{c.check}</span>
                {v && <span className="text-sm tabular-nums text-foreground">· {v}</span>}
                {c.system_said && <span className={LABEL}>· system saw {c.system_said}</span>}
                {c.note && <span className={LABEL} style={{ overflowWrap: 'anywhere' }}>· {c.note}</span>}
              </li>
            );
          })}
        </ul>
      )}
    </li>
  );
}

type TimelineItem = { at: string; kind: 'move' | 'concern' | 'action'; text: string };

export function timeline(d: Pick<DeskHistoryData, 'moves' | 'concerns' | 'other_actions'>): TimelineItem[] {
  const out: TimelineItem[] = [
    ...d.moves.map((m) => ({
      at: m.at,
      kind: 'move' as const,
      text: `Moved ${m.from ? `from ${STATUS_WORDS[m.from] ?? m.from} ` : ''}to ${STATUS_WORDS[m.to ?? ''] ?? m.to ?? '—'}${m.by ? ` · ${m.by}` : ''}`,
    })),
    ...d.concerns.map((c) => ({
      at: c.at,
      kind: 'concern' as const,
      text: `Concern (${c.severity ?? '—'}${c.category ? `, ${c.category.replace(/_/g, ' ')}` : ''})${c.by ? ` · ${c.by}` : ''}${c.note ? ` — ${c.note}` : ''}${c.resolved_at ? ' · resolved' : ''}`,
    })),
    ...d.other_actions.map((a) => ({
      at: a.at,
      kind: 'action' as const,
      text: `${ACTION_WORDS[a.action] ?? a.action.replace(/_/g, ' ')}${a.by ? ` · ${a.by}` : ''}${a.reason ? ` — ${a.reason}` : ''}`,
    })),
  ];
  return out.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
}

export function DeskHistory({ requestId }: { requestId: string }) {
  const q = useDeskHistory(requestId);
  if (q.isLoading) return <LoadingRows rows={4} height={44} label="Loading the desk history" />;
  if (q.error) return <ErrorLine>{String((q.error as { message?: string }).message ?? q.error)}</ErrorLine>;
  const d = q.data as DeskHistoryData;
  const byDesk = (stage: string) => d.desks.filter((r) => r.desk === stage).sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  const items = timeline(d);

  return (
    <div data-desk-history style={stackLayout(16)}>
      {HISTORY_DESKS.filter((k) => k.always || byDesk(k.stage).length > 0).map((k) => {
        const reviews = byDesk(k.stage);
        return (
          <section key={k.stage} className={`${PANEL} p-4`} aria-label={k.name} data-history-desk={k.stage} style={stackLayout(8)}>
            <h3 className="text-sm font-semibold text-foreground" style={{ margin: 0 }}>
              {k.name}
            </h3>
            {reviews.length === 0 ? (
              <p className={LABEL} style={{ margin: 0 }}>
                No review recorded at this desk
              </p>
            ) : (
              <ul style={{ margin: 0, padding: 0, ...stackLayout(12) }}>
                {reviews.map((r, i) => (
                  <ReviewBlock key={`${r.at}-${i}`} r={r} />
                ))}
              </ul>
            )}
          </section>
        );
      })}

      <section className={`${PANEL} p-4`} aria-label="Calls" style={stackLayout(8)}>
        <h3 className="text-sm font-semibold text-foreground" style={{ margin: 0 }}>
          Calls
        </h3>
        {d.calls.length === 0 ? (
          <p className={LABEL} style={{ margin: 0 }}>
            No call logged on this request.
          </p>
        ) : (
          <ul style={{ margin: 0, padding: 0, ...stackLayout(8) }}>
            {d.calls.map((c, i) => {
              const ans = answersText(c.answers);
              return (
                <li key={`${c.at}-${i}`} data-call style={{ listStyle: 'none', ...stackLayout(2) }}>
                  <span className="text-sm text-foreground">
                    {when(c.at)} · {c.subject ?? '—'} ·{' '}
                    <span className={c.result === 'answered' ? statusText.ok : statusText.warn}>{(c.result ?? '—').replace(/_/g, ' ')}</span>
                    {c.who_called ? ` · ${c.who_called}` : ''}
                    {c.team ? ` (${c.team.replace(/_/g, ' ')})` : ''}
                  </span>
                  {ans && <span className={LABEL} style={{ overflowWrap: 'anywhere' }}>{ans}</span>}
                  {c.note && <span className={LABEL} style={{ overflowWrap: 'anywhere' }}>“{c.note}”</span>}
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section className={`${PANEL} p-4`} aria-label="Moves, transfers and documents" style={stackLayout(8)}>
        <h3 className="text-sm font-semibold text-foreground" style={{ margin: 0 }}>
          Moves, transfers and documents
        </h3>
        {items.length === 0 ? (
          <p className={LABEL} style={{ margin: 0 }}>
            Nothing recorded yet.
          </p>
        ) : (
          <ol style={{ margin: 0, padding: 0, ...stackLayout(4) }} aria-label="Timeline">
            {items.map((t, i) => (
              <li key={`${t.at}-${i}`} data-timeline={t.kind} className={LABEL} style={{ listStyle: 'none', overflowWrap: 'anywhere' }}>
                <span className="tabular-nums text-foreground">{when(t.at)}</span> · {t.text}
              </li>
            ))}
          </ol>
        )}
      </section>
    </div>
  );
}
