import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { rpc } from './reviewApi';
import { LABEL, statusText } from './deskTheme';
import { fmt } from './format';
import { Card, Chip, DecisionButton, EmptyState, ErrorLine, LoadingRows, moneyFull, stackLayout } from './ui';
import { TransferPicker } from './TransferPicker';
import { CallButtons, dayText } from './arrears/ArrearsParts';
import { plainError } from './arrears/arrearsApi';

/**
 * E128 / E129: renewals.
 *  - Agent Ops: a renewal posted by a different agent than the tenant's last
 *    plan (`renewal_agent_changes_list`). Approve keeps the new agent; "Send
 *    back to original agent" records the decision and opens the desk's
 *    Transfer action, the original agent picked first when they can take it.
 *  - Agent Ops and Tenant Ops: tenants whose plan is completed and who have
 *    not renewed (`ready_to_renew`), "Tenant asked" first, so the desk can
 *    nudge the agent.
 */

type Person = { id?: string | null; name: string | null; phone: string | null } | null;
export type AgentChange = {
  rent_request_id: string;
  ref: string;
  status: string;
  tenant: Person;
  prev_agent: Person;
  new_agent: Person;
  created_at: string | null;
  decided_at: string | null;
  note: string | null;
};
export type ReadyToRenew = {
  last_request_id: string;
  ref: string;
  tenant: Person;
  agent: Person;
  last_rent: number | null;
  last_days: number | null;
  repaid: number | null;
  total: number | null;
  completed_on: string | null;
  tenant_asked: boolean;
};

export const RENEWAL_WORDS: Record<string, string> = {
  AGENT_OPS_ONLY: 'Only Agent Ops can decide on a renewal by a different agent.',
  NOT_PENDING: 'This renewal has already been decided.',
};
const KEY = ['desk-feed', 'renewals'] as const;
const refused = (e: unknown) => (e as { code?: string } | null)?.code === '42501' || /^AGENT_OPS_ONLY/.test(String((e as { message?: string } | null)?.message ?? ''));

export function useAgentChanges() {
  return useQuery({
    queryKey: [...KEY, 'agent-changes'],
    queryFn: async (): Promise<AgentChange[]> => {
      const { data, error } = await rpc('renewal_agent_changes_list');
      if (error) throw error;
      return Array.isArray(data) ? (data as AgentChange[]) : [];
    },
    staleTime: 60_000,
    retry: 1,
  });
}

export function useReadyToRenew() {
  return useQuery({
    queryKey: [...KEY, 'ready'],
    queryFn: async (): Promise<ReadyToRenew[]> => {
      const { data, error } = await rpc('ready_to_renew', { p_all: true });
      if (error) throw error;
      return Array.isArray(data) ? (data as ReadyToRenew[]) : [];
    },
    staleTime: 60_000,
    retry: 1,
  });
}

/** "Tenant asked" first; otherwise the server's order (most recently completed first). */
export function tenantAskedFirst(rows: ReadyToRenew[]): ReadyToRenew[] {
  return rows
    .map((r, i) => ({ r, i }))
    .sort((a, b) => Number(!!b.r.tenant_asked) - Number(!!a.r.tenant_asked) || a.i - b.i)
    .map((x) => x.r);
}

function PersonLine({ role, p }: { role: string; p: Person }) {
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
      <span className="text-sm" style={{ minWidth: 0, overflowWrap: 'anywhere' }}>
        <span className={LABEL}>{role} </span>
        <span className="text-foreground">{p?.name ?? '—'}</span>
      </span>
      <CallButtons phone={p?.phone ?? null} who={`${role.toLowerCase()} ${p?.name ?? ''}`.trim()} />
    </div>
  );
}

function ChangeRow({ c }: { c: AgentChange }) {
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [transfer, setTransfer] = useState(false);
  const pending = c.status === 'pending';

  const decide = async (approve: boolean) => {
    setBusy(true);
    setProblem(null);
    const { error } = await rpc('renewal_agent_change_decide', { p_request_id: c.rent_request_id, p_approve: approve, p_note: null });
    setBusy(false);
    if (error) return setProblem(plainError(error, RENEWAL_WORDS));
    void qc.invalidateQueries({ queryKey: [...KEY] });
    if (approve) toast.success(`Approved: ${c.new_agent?.name ?? 'the new agent'} keeps ${c.tenant?.name ?? 'the tenant'}`);
    // Sent back: now move the tenant with the desk's Transfer action.
    else setTransfer(true);
  };

  const transferTo = async (agentId: string, note: string, name: string | null): Promise<string | null> => {
    const { error } = await rpc('ops_transfer_pipeline_request_agent', { p_request_id: c.rent_request_id, p_to_agent_id: agentId, p_reason: note });
    if (error) return plainError(error, RENEWAL_WORDS);
    toast.success(`Transferred to ${name ?? 'the agent'}`);
    void qc.invalidateQueries({ queryKey: ['desk-feed'] });
    return null;
  };

  return (
    <li className="desk-panel min-w-0" style={{ ...stackLayout(8), padding: 12 }} data-agent-change={c.ref} data-status={c.status}>
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'baseline', justifyContent: 'space-between', gap: 8 }}>
        <span className="font-mono text-xs text-muted-foreground">{c.ref}</span>
        <span className={LABEL}>{dayText(c.created_at)}</span>
      </div>
      <PersonLine role="Tenant" p={c.tenant} />
      <PersonLine role="Previous agent" p={c.prev_agent} />
      <PersonLine role="New agent" p={c.new_agent} />
      {pending ? (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
          <DecisionButton variant="primary" size="md" disabled={busy} onClick={() => void decide(true)} style={{ minHeight: 44 }}>
            Approve
          </DecisionButton>
          <DecisionButton variant="warn" size="md" disabled={busy} onClick={() => void decide(false)} style={{ minHeight: 44 }}>
            Send back to original agent
          </DecisionButton>
        </div>
      ) : (
        <Chip tone={c.status === 'approved' ? 'ok' : 'warn'}>
          {c.status === 'approved' ? 'Approved' : c.status === 'returned' ? 'Sent back to the original agent' : c.status}
          {c.decided_at ? ` · ${dayText(c.decided_at)}` : ''}
        </Chip>
      )}
      {problem && <ErrorLine>{problem}</ErrorLine>}
      {transfer && (
        <TransferPicker
          requestId={c.rent_request_id}
          tenant={c.tenant?.name ?? null}
          defaultNote={`Renewal by a different agent: back to the original agent${c.prev_agent?.name ? `, ${c.prev_agent.name}` : ''}`}
          preferAgentId={c.prev_agent?.id ?? null}
          onClose={() => setTransfer(false)}
          onConfirm={transferTo}
        />
      )}
    </li>
  );
}

/** Agent Ops. Hidden when there is nothing in the last 60 days, or for a viewer the server refuses. */
export function RenewalAgentChangesCard({ board }: { board: boolean }) {
  const q = useAgentChanges();
  if (q.isLoading) return null;
  if (q.error) return refused(q.error) ? null : <ErrorLine>{plainError(q.error, RENEWAL_WORDS)}</ErrorLine>;
  const rows = q.data ?? [];
  if (rows.length === 0) return null;
  const pending = rows.filter((r) => r.status === 'pending').length;
  return (
    <Card board={board} title="Renewals by a different agent" hint={`${fmt('int', pending)} to decide`} ariaLabel="Renewals by a different agent">
      <ul style={{ ...stackLayout(8), margin: 0, padding: 0, listStyle: 'none' }} data-agent-changes>
        {rows.map((c) => (
          <ChangeRow key={c.rent_request_id} c={c} />
        ))}
      </ul>
    </Card>
  );
}

const SHOW = 20;

/** Agent Ops and Tenant Ops: completed plans not yet renewed, "Tenant asked" first. */
export function ReadyToRenewCard({ board }: { board: boolean }) {
  const q = useReadyToRenew();
  const [all, setAll] = useState(false);
  if (q.error && (q.error as { code?: string }).code === '42501') return null;
  const rows = tenantAskedFirst(q.data ?? []);
  const asked = rows.filter((r) => r.tenant_asked).length;
  const shown = all ? rows : rows.slice(0, SHOW);
  return (
    <Card board={board} title="Ready to renew" hint={q.data ? `${fmt('int', rows.length)} · ${fmt('int', asked)} asked` : undefined} ariaLabel="Ready to renew" busy={q.isLoading}>
      {q.isLoading ? (
        <LoadingRows rows={3} label="Loading tenants ready to renew" />
      ) : q.error ? (
        <ErrorLine>{plainError(q.error)}</ErrorLine>
      ) : rows.length === 0 ? (
        <EmptyState>No tenant is waiting to renew.</EmptyState>
      ) : (
        <div style={stackLayout(8)}>
          <ul style={{ ...stackLayout(8), margin: 0, padding: 0, listStyle: 'none' }} data-ready-to-renew>
            {shown.map((r) => (
              <li key={r.last_request_id} className="desk-panel min-w-0" style={{ ...stackLayout(6), padding: 12 }} data-renew={r.ref} data-asked={r.tenant_asked || undefined}>
                <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8 }}>
                  {r.tenant_asked && (
                    <Chip tone="warn" strong>
                      Tenant asked
                    </Chip>
                  )}
                  <span className={LABEL}>
                    Completed {dayText(r.completed_on)} · last rent {moneyFull(r.last_rent)}
                    {r.last_days ? ` over ${fmt('int', r.last_days)} days` : ''}
                  </span>
                </div>
                <PersonLine role="Tenant" p={r.tenant} />
                <PersonLine role="Agent" p={r.agent} />
              </li>
            ))}
          </ul>
          {rows.length > SHOW && (
            <DecisionButton variant="quiet" onClick={() => setAll((a) => !a)}>
              {all ? 'Show fewer' : `Show all ${fmt('int', rows.length)}`}
            </DecisionButton>
          )}
          {asked > 0 && (
            <p className={`text-xs ${statusText.warn}`} style={{ margin: 0 }}>
              {fmt('int', asked)} {asked === 1 ? 'tenant has' : 'tenants have'} asked to renew: nudge their agents first.
            </p>
          )}
        </div>
      )}
    </Card>
  );
}
