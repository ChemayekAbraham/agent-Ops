import type { ReactNode } from 'react';
import { LABEL, statusText } from '../deskTheme';
import { readableError } from '../reviewApi';
import { DeskCallButton } from '../deskCall';
import { Chip, EmptyState, ErrorLine, GradeBadge, LoadingRows, Sheet, moneyFull, pctWhole } from '../ui';
import { isBelow, planPct, statusWords, useAgentPlans, useRequestAgent, type AgentPlans } from './agentPortfolioApi';

/**
 * One agent's sheet: may they bring new requests (and why), each rent plan
 * with what is due so far and what was repaid, then their open requests.
 * Opened from the Agents desk, or from the COO board by request.
 */

export type AgentSheetTarget =
  | { kind: 'agent'; agentId: string; name: string | null; phone?: string | null; grade?: string | null }
  | { kind: 'request'; requestId: string; name: string | null; grade?: string | null };

/** "12 Nov 2026", in Kampala time. */
export function dayText(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Africa/Kampala' });
}

function Pct({ v }: { v: number | null }) {
  return <span className={`tabular-nums ${isBelow(v) ? `font-semibold ${statusText.bad}` : 'text-foreground'}`}>{v === null ? '—' : pctWhole(v)}</span>;
}

function Figure({ label, children }: { label: string; children: ReactNode }) {
  return (
    <span style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
      <span className={LABEL}>{label}</span>
      <span className="tabular-nums text-foreground" style={{ whiteSpace: 'nowrap' }}>
        {children}
      </span>
    </span>
  );
}

function SheetBody({ data }: { data: AgentPlans }) {
  const e = data.eligibility;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }} className="text-sm">
      {e && (
        <p data-eligibility style={{ margin: 0, display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8 }}>
          <Chip size="sm" tone={e.eligible ? 'ok' : 'bad'} strong>
            {e.eligible ? 'Eligible' : 'New requests frozen'}
          </Chip>
          <span className="text-foreground">{e.reason ?? '—'}</span>
        </p>
      )}

      <section aria-label="Rent plans" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <h3 className="text-sm font-semibold text-foreground" style={{ margin: 0 }}>
          Rent plans ({data.plans.length.toLocaleString('en')})
        </h3>
        {data.plans.length === 0 ? (
          <EmptyState>No funded rent plans yet.</EmptyState>
        ) : (
          <ul style={{ display: 'flex', flexDirection: 'column', gap: 0, margin: 0, padding: 0 }}>
            {data.plans.map((p) => (
              <li
                key={p.rent_request_id}
                data-plan={p.short_id}
                className="border-t border-[var(--desk-line-color)] first:border-t-0"
                style={{ listStyle: 'none', paddingTop: 10, paddingBottom: 10, display: 'flex', flexDirection: 'column', gap: 6 }}
              >
                <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, minWidth: 0 }}>
                  <span className="font-medium text-foreground" style={{ overflowWrap: 'anywhere' }}>
                    {p.tenant ?? '—'}
                  </span>
                  <Chip tone={p.status === 'defaulted' ? 'bad' : p.status === 'completed' ? 'ok' : 'idle'}>{statusWords(p.status)}</Chip>
                </span>
                <span style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(6.5rem, 1fr))', gap: 8 }}>
                  <Figure label="Plan value">{moneyFull(p.plan_value)}</Figure>
                  <Figure label="Due so far">{moneyFull(p.due_so_far)}</Figure>
                  <Figure label="Repaid">{moneyFull(p.repaid)}</Figure>
                  <Figure label="Repaid vs due">
                    <Pct v={planPct(p)} />
                  </Figure>
                  <Figure label="Start date">{dayText(p.starts_on ?? p.funded_at)}</Figure>
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-label="Open requests" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <h3 className="text-sm font-semibold text-foreground" style={{ margin: 0 }}>
          Open requests ({data.open_requests.length.toLocaleString('en')})
        </h3>
        {data.open_requests.length === 0 ? (
          <EmptyState>No open requests.</EmptyState>
        ) : (
          <ul style={{ display: 'flex', flexDirection: 'column', margin: 0, padding: 0 }}>
            {data.open_requests.map((r) => (
              <li
                key={r.rent_request_id}
                data-open-request={r.short_id}
                className="border-t border-[var(--desk-line-color)] first:border-t-0"
                style={{ listStyle: 'none', paddingTop: 8, paddingBottom: 8, display: 'flex', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}
              >
                <span style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
                  <span className="text-foreground" style={{ overflowWrap: 'anywhere' }}>
                    {r.tenant ?? '—'} <span className={`${LABEL} font-mono`}>{r.short_id}</span>
                  </span>
                  <span className={LABEL}>
                    At {statusWords(r.status)} · since {dayText(r.created_at)}
                  </span>
                </span>
                <span className="tabular-nums text-foreground" style={{ whiteSpace: 'nowrap' }}>
                  {moneyFull(r.rent)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function PlansFor({ agentId, name, phone, grade }: { agentId: string; name: string | null; phone?: string | null; grade?: string | null }) {
  const q = useAgentPlans(agentId);
  const callName = q.data?.agent?.name ?? name;
  const callPhone = q.data?.agent?.phone ?? phone ?? null;
  return (
    <>
      <p style={{ margin: 0, display: 'flex', alignItems: 'center', gap: 8 }}>
        {grade !== undefined && <GradeBadge grade={grade} />}
        <span className={`${LABEL} tabular-nums`}>{callPhone ?? 'No number on file'}</span>
        <DeskCallButton target={{ requestId: null, desk: 'agent_ops', subject: 'agent', calleeId: agentId, name: callName, phone: callPhone }} />
      </p>
      {q.isLoading ? (
        <LoadingRows rows={4} height={56} label="Loading the agent's rent plans" />
      ) : q.error ? (
        <ErrorLine>The agent's rent plans could not load: {readableError(q.error)}</ErrorLine>
      ) : q.data ? (
        <SheetBody data={q.data} />
      ) : null}
    </>
  );
}

function ByRequest({ requestId, name, grade }: { requestId: string; name: string | null; grade?: string | null }) {
  const q = useRequestAgent(requestId, name);
  if (q.isLoading) return <LoadingRows rows={4} height={56} label="Finding the agent" />;
  if (q.error) return <ErrorLine>The agent could not be found: {readableError(q.error)}</ErrorLine>;
  if (!q.data) return <EmptyState>No agent is linked to this request.</EmptyState>;
  return <PlansFor agentId={q.data} name={name} grade={grade} />;
}

export function AgentSheet({ target, onClose }: { target: AgentSheetTarget; onClose: () => void }) {
  return (
    <Sheet title={target.name && target.name !== '—' ? target.name : 'Agent'} onClose={onClose}>
      {target.kind === 'agent' ? (
        <PlansFor agentId={target.agentId} name={target.name} phone={target.phone} grade={target.grade} />
      ) : (
        <ByRequest requestId={target.requestId} name={target.name} grade={target.grade} />
      )}
    </Sheet>
  );
}
