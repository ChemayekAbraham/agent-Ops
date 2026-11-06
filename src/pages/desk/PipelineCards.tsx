import { fmt } from './format';
import { CALM, LABEL, PANEL, statusGlass, statusText } from './deskTheme';
import { Skeleton } from './Skeleton';
import { readableError, useDeskDaily, useOverrides, useSendBackReasons } from './reviewApi';

/**
 * The three pipeline cards on the command centre: how each desk worked today,
 * who went against the system, and what keeps sending requests back.
 *
 * All three read only — nothing here can change a request.
 */

const STAGE_NAME: Record<string, string> = {
  service_centre: 'Service Centre',
  agent_ops: 'Agent Ops',
  tenant_ops: 'Tenant Ops',
  landlord_ops: 'Landlord Ops',
  partner_ops: 'Partner Ops',
  coo: 'COO',
};

const DECISION_NAME: Record<string, string> = {
  pass: 'Pass',
  send_back: 'Send back',
  reject: 'Reject',
  transfer: 'Transfer',
  call_again: 'Call again',
  attach_funder: 'Attach funder',
  to_coo_bucket: 'To the COO bucket',
  fund: 'Fund',
  hold: 'Hold',
};

function Card({ title, note, board, children }: { title: string; note?: string; board: boolean; children: React.ReactNode }) {
  return (
    <section className={`${PANEL} flex min-h-0 flex-col gap-3 p-4 sm:p-5`}>
      <div className="shrink-0 space-y-1">
        <h2 className={`${board ? 'text-lg' : 'text-base'} font-semibold text-foreground`}>{title}</h2>
        {note && <p className="max-w-3xl text-xs leading-snug text-muted-foreground">{note}</p>}
      </div>
      <div className="min-h-0 flex-1 overflow-auto">{children}</div>
    </section>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <p className="text-sm text-muted-foreground">{children}</p>;
}

function Failed({ error }: { error: unknown }) {
  return (
    <p className={`text-sm ${statusText.bad}`} role="alert">
      {readableError(error)}
    </p>
  );
}

type DailyRow = {
  stage: string;
  reviews: number | null;
  followed_pct: number | null;
  overrides: number | null;
  top_override_reason: string | null;
  passed: number | null;
  sent_back: number | null;
  rejected: number | null;
  dashboards_activated: number | null;
  calls_logged: number | null;
};

export function TodayByDesk({ board, enabled }: { board: boolean; enabled: boolean }) {
  const q = useDeskDaily(enabled);
  const rows = (q.data ?? []) as unknown as DailyRow[];

  return (
    <Card
      title="Today by desk"
      note="Reviews recorded today, how often each desk followed the system, and what the calls achieved."
      board={board}
    >
      {q.isLoading && <Skeleton className="h-32 w-full" />}
      {q.error && <Failed error={q.error} />}
      {!q.isLoading && !q.error && rows.length === 0 && <Empty>No desk has recorded a review today yet.</Empty>}

      {rows.length > 0 && (
        <ul className="space-y-3">
          {rows.map((r) => {
            const followed = r.followed_pct === null ? null : Math.round(Number(r.followed_pct));
            const tone = followed === null ? 'idle' : followed >= 90 ? 'ok' : followed >= 70 ? 'warn' : 'bad';
            return (
              <li key={r.stage} className="space-y-1.5">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <span className="text-sm font-medium text-foreground">{STAGE_NAME[r.stage] ?? r.stage}</span>
                  <span className={`desk-pill border px-2.5 py-0.5 text-xs ${statusGlass[tone]}`}>
                    {followed === null ? 'no reviews' : `${followed}% followed`}
                  </span>
                </div>
                <p className={LABEL}>
                  {fmt('int', r.reviews)} reviews · {fmt('int', r.passed)} passed · {fmt('int', r.sent_back)} sent back ·{' '}
                  {fmt('int', r.rejected)} rejected
                </p>
                <p className={LABEL}>
                  {fmt('int', r.overrides)} went against the system
                  {r.top_override_reason ? ` (most often ${r.top_override_reason})` : ''} · {fmt('int', r.calls_logged)} calls
                  logged · {fmt('int', r.dashboards_activated)} dashboards activated
                </p>
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}

type OverrideRow = {
  reviewed_at: string;
  stage: string;
  rent_request_id: string;
  tenant_name: string | null;
  recommended: string | null;
  decision: string | null;
  reason_code: string | null;
  note: string | null;
  reviewer_name: string | null;
  staff_ref: string | null;
};

export function WentAgainstTheSystem({ board, enabled }: { board: boolean; enabled: boolean }) {
  const q = useOverrides(enabled);
  const rows = (q.data ?? []) as unknown as OverrideRow[];

  return (
    <Card
      title="Went against the system"
      note="Every decision today that differed from the system's recommendation, with the reason the reviewer gave."
      board={board}
    >
      {q.isLoading && <Skeleton className="h-32 w-full" />}
      {q.error && <Failed error={q.error} />}
      {!q.isLoading && !q.error && rows.length === 0 && (
        <Empty>Every desk followed the system today. Nothing to review here.</Empty>
      )}

      {rows.length > 0 && (
        <ul className="space-y-3">
          {rows.map((r, i) => (
            <li key={`${r.rent_request_id}-${r.reviewed_at}-${i}`} className="space-y-1">
              <p className="text-sm text-foreground">
                <span className="font-medium">{STAGE_NAME[r.stage] ?? r.stage}</span> chose{' '}
                <span className={statusText.warn}>{DECISION_NAME[r.decision ?? ''] ?? r.decision}</span> where the system said{' '}
                {DECISION_NAME[r.recommended ?? ''] ?? r.recommended ?? '—'} — {r.tenant_name ?? 'tenant'}{' '}
                <span className="font-mono text-xs text-muted-foreground">{r.rent_request_id.slice(0, 8)}</span>
              </p>
              <p className={LABEL}>
                {r.reason_code ?? 'no reason code'}
                {r.reviewer_name ? ` · ${r.reviewer_name}` : ''}
                {r.staff_ref ? ` (${r.staff_ref})` : ''}
                {r.note ? ` — ${r.note}` : ''}
              </p>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

type BounceRow = {
  agent_name: string | null;
  check_code: string;
  check_label: string | null;
  times: number | null;
  share_pct: number | null;
  requests_reviewed: number | null;
};

export function WhyRequestsBounce({ board, enabled, days = 30 }: { board: boolean; enabled: boolean; days?: number }) {
  const q = useSendBackReasons(days, enabled);
  const rows = (q.data ?? []) as unknown as BounceRow[];

  return (
    <Card
      title="Why requests bounce"
      note={`The items that failed most often over the last ${days} days, by agent. This is what to teach, not who to blame.`}
      board={board}
    >
      {q.isLoading && <Skeleton className="h-32 w-full" />}
      {q.error && <Failed error={q.error} />}
      {!q.isLoading && !q.error && rows.length === 0 && (
        <Empty>Nothing has failed a check in this window.</Empty>
      )}

      {rows.length > 0 && (
        <div className="overflow-auto rounded-xl border border-[var(--desk-line-color)]">
          <table className="w-full border-collapse text-sm tabular-nums">
            <thead className="desk-thead">
              <tr>
                {['Agent', 'What failed', 'Times', 'Share of their requests', 'Requests reviewed'].map((h, i) => (
                  <th
                    key={h}
                    scope="col"
                    className={`sticky top-0 z-10 border-b border-[var(--desk-line-color)] px-3 py-2 font-medium text-muted-foreground whitespace-nowrap ${
                      i >= 2 ? 'text-right' : 'text-left'
                    }`}
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={`${r.agent_name ?? 'agent'}-${r.check_code}-${i}`} className={`desk-row border-b border-[var(--desk-line-soft)] last:border-0 ${CALM}`}>
                  <td className="px-3 py-2 text-foreground">{r.agent_name ?? '—'}</td>
                  <td className="px-3 py-2 text-foreground">{r.check_label ?? r.check_code}</td>
                  <td className="px-3 py-2 text-right text-foreground">{fmt('int', r.times)}</td>
                  <td className="px-3 py-2 text-right text-foreground">
                    {r.share_pct === null ? '—' : `${Math.round(Number(r.share_pct))}%`}
                  </td>
                  <td className="px-3 py-2 text-right text-muted-foreground">{fmt('int', r.requests_reviewed)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}
