import { useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { CALM, FOCUS, LABEL } from '../deskTheme';
import { fmt } from '../format';
import { Chip, EmptyState, ErrorLine, LoadingRows, moneyFull, stackLayout } from '../ui';
import { TIERS, TIER_WORDS, callDay, defaultWatchMode, lastSundayKampala, plainError, tierTone, useArrearsAgents, useArrearsWatch, yesterdayKampala, type ArrearsAgent, type ArrearsRow, type WatchMode } from './arrearsApi';
import { CallButtons, CallLine, EligibleBadge, LogCallSheet, PRIMARY_BUTTON, TenantCard, WatchControls, rangeText } from './ArrearsParts';

/**
 * Agent Ops · Arrears calls (E102): one row per agent with tenants short on
 * the watch day, in the server's order (most new slips, then biggest
 * shortfall). A row opens that agent's tenants (arrears_watch searched by the
 * agent's phone, up to 500); "Log call" records the call to the agent.
 */

export const AGENT_TENANTS_LIMIT = 500;

function AgentTenants({ agent, day, mode, onLog }: { agent: ArrearsAgent; day: string; mode: WatchMode; onLog: (r: ArrearsRow) => void }) {
  const q = useArrearsWatch({ day, mode, search: agent.phone ?? '', limit: AGENT_TENANTS_LIMIT, enabled: !!agent.phone });
  if (!agent.phone) return <p className={LABEL}>No phone on file for this agent, so their tenants cannot be looked up here.</p>;
  if (q.isLoading) return <LoadingRows rows={2} label={`Loading ${agent.name ?? 'the agent'}'s tenants`} />;
  if (q.error) return <ErrorLine>{plainError(q.error)}</ErrorLine>;
  const d = q.data;
  if (!d || d.rows.length === 0) return <EmptyState>No tenant short for this agent for {d ? rangeText(mode, d) : day}.</EmptyState>;
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(min(100%, 380px), 1fr))', gap: 12 }} data-agent-tenants={agent.agent_id}>
      {d.rows.map((r) => (
        <TenantCard key={r.rent_request_id} row={r} tiers={d.tiers} onLog={onLog} />
      ))}
    </div>
  );
}

function AgentRow({ agent, day, mode, onLogAgent, onLogTenant }: { agent: ArrearsAgent; day: string; mode: WatchMode; onLogAgent: (a: ArrearsAgent) => void; onLogTenant: (r: ArrearsRow) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <li className="desk-panel min-w-0" style={{ ...stackLayout(10), padding: 14 }} data-agent-row={agent.agent_id}>
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
        <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} className={`flex min-w-0 items-center gap-1.5 rounded text-left ${CALM} ${FOCUS}`} data-expand>
          {open ? <ChevronDown className="h-4 w-4 shrink-0" aria-hidden /> : <ChevronRight className="h-4 w-4 shrink-0" aria-hidden />}
          <span className="text-base font-semibold text-foreground" style={{ overflowWrap: 'anywhere' }}>
            {agent.name ?? '—'}
          </span>
          {agent.phone && <span className="font-mono text-xs text-muted-foreground">{agent.phone}</span>}
        </button>
        <CallButtons phone={agent.phone} whatsapp who={`agent ${agent.name ?? ''}`.trim()} />
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '6px 14px' }} className="text-sm">
        <span data-tenants-short>
          <span className={LABEL}>Tenants short </span>
          <span className="tabular-nums text-foreground">{fmt('int', agent.tenants_short)}</span>
        </span>
        <span data-shortfall>
          <span className={LABEL}>Shortfall </span>
          <span className="tabular-nums text-foreground">{moneyFull(agent.shortfall)}</span>
        </span>
        <EligibleBadge pct={agent.collection_pct} eligible={agent.eligible} />
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }} data-tier-counts>
        {TIERS.map((t) => (
          <Chip key={t} tone={agent[t] > 0 ? tierTone(t) : 'idle'}>
            {TIER_WORDS[t]} {fmt('int', agent[t])}
          </Chip>
        ))}
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
        <CallLine label="Agent Ops today" call={agent.agent_ops_call} />
        <button type="button" className={PRIMARY_BUTTON} onClick={() => onLogAgent(agent)}>
          Log call
        </button>
      </div>
      {open && <AgentTenants agent={agent} day={day} mode={mode} onLog={onLogTenant} />}
    </li>
  );
}

export function AgentArrearsTab({ board: _board }: { board: boolean }) {
  // Mondays open on last week (E113).
  const [mode, setMode] = useState<WatchMode>(() => defaultWatchMode());
  const [dates, setDates] = useState<Record<WatchMode, string>>(() => ({ day: yesterdayKampala(), week: lastSundayKampala() }));
  const day = dates[mode];
  const [logAgent, setLogAgent] = useState<ArrearsAgent | null>(null);
  const [logTenant, setLogTenant] = useState<ArrearsRow | null>(null);
  const q = useArrearsAgents(day, mode);
  // Calls in week mode belong to the week's last day (the payload's `to`).
  const logDay = callDay(mode, day, q.data);
  return (
    <section aria-label="Arrears calls" data-arrears-tab="agent-ops" style={stackLayout(14)}>
      <WatchControls mode={mode} onMode={setMode} value={day} onValue={(v) => setDates((d) => ({ ...d, [mode]: v }))} />
      {q.data && (
        <p className="text-base font-semibold text-foreground" style={{ margin: 0 }} data-watch-range>
          Arrears for {rangeText(mode, q.data)}
        </p>
      )}
      {q.isLoading ? (
        <LoadingRows rows={4} label="Loading the agents" />
      ) : q.error ? (
        <ErrorLine>{plainError(q.error)}</ErrorLine>
      ) : q.data && q.data.agents.length === 0 ? (
        <EmptyState>No agent had a tenant short for {rangeText(mode, q.data)}.</EmptyState>
      ) : q.data ? (
        <ul style={{ ...stackLayout(10), margin: 0, padding: 0, listStyle: 'none' }} aria-label="Agents with tenants short">
          {q.data.agents.map((a) => (
            <AgentRow key={a.agent_id} agent={a} day={day} mode={mode} onLogAgent={setLogAgent} onLogTenant={setLogTenant} />
          ))}
        </ul>
      ) : null}

      {logAgent && (
        <LogCallSheet title={`Log call · ${logAgent.name ?? 'agent'}`} parties={['agent']} defaultParty="agent" agentId={logAgent.agent_id} desk="agent-ops" day={logDay} onClose={() => setLogAgent(null)} />
      )}
      {logTenant && (
        <LogCallSheet
          title={`Log call · ${logTenant.tenant?.name ?? 'tenant'}`}
          parties={['agent', 'tenant', 'landlord', 'funder']}
          defaultParty="agent"
          rentRequestId={logTenant.rent_request_id}
          desk="agent-ops"
          day={logDay}
          onClose={() => setLogTenant(null)}
        />
      )}
    </section>
  );
}
