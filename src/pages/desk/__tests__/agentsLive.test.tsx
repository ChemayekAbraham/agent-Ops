import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

vi.mock('@/integrations/supabase/client', () => ({ supabase: { rpc: vi.fn(), from: vi.fn(), storage: { from: vi.fn() } } }));
vi.mock('@/hooks/useAuth', () => ({ useAuth: () => ({ user: null, roles: [] }) }));

import {
  intakeTone,
  openPills,
  rowsForDesk,
  sortAgents,
  summaryText,
  todayLineText,
  type AgentLiveRow,
  type AgentsLiveSummary,
} from '../agents/agentsApi';
import { AgentsTable, EMPTY_TEXT, INTAKE_CLASS } from '../agents/AgentsLive';

/* ───────────── fixtures ───────────── */

const NO_OPEN = { service_centre: 0, agent_ops: 0, tenant_ops: 0, landlord_ops: 0, coo: 0, funders_board: 0 };

const agent = (agent_id: string, extra: Partial<AgentLiveRow> = {}): AgentLiveRow => ({
  agent_id,
  agent: `Agent ${agent_id}`,
  phone: null,
  grade: 'B',
  grade_week_ago: 'B',
  score: 70,
  flags: [],
  submitted_today: 0,
  submitted_period: 0,
  last_submitted_at: null,
  open: NO_OPEN,
  funded_30d: 0,
  funded_30d_ugx: 0,
  bounced_30d: 0,
  intake_complete_pct: null,
  service_centre_person: null,
  ...extra,
});

const SUMMARY: AgentsLiveSummary = {
  agents_active_today: 12,
  submitted_today: 20,
  agents_active_period: 29,
  submitted_period: 70,
  flagged_agents_with_open: 10,
  intake_complete_pct: 0,
};

/* ───────────── summary ───────────── */

describe('summary text', () => {
  it('reads the period figures', () => {
    expect(summaryText(SUMMARY, 7)).toBe('29 agents · 70 requests in 7 days · 0% complete at submission · 10 flagged agents with open requests');
  });

  it('reads the today figures for Today', () => {
    expect(summaryText({ ...SUMMARY, intake_complete_pct: 0.4 }, 'today')).toBe(
      '12 agents · 20 requests today · 40% complete at submission · 10 flagged agents with open requests',
    );
  });

  it('shows a dash when completeness is unknown', () => {
    expect(summaryText({ ...SUMMARY, intake_complete_pct: null }, 30)).toContain('— complete at submission');
  });

  it('command centre line', () => {
    expect(todayLineText({ ...SUMMARY, intake_complete_pct: 40 })).toBe('Today: 20 requests from 12 agents · intake complete 40%');
  });
});

/* ───────────── sort ───────────── */

describe('sort order', () => {
  it('flagged with open first, then most submitted, then name', () => {
    const rows = [
      agent('a', { submitted_period: 9 }),
      agent('b', { submitted_period: 1, flags: ['late receipts'], open: { ...NO_OPEN, coo: 1 } }),
      agent('c', { submitted_period: 30 }),
      agent('d', { submitted_period: 50, flags: ['late receipts'] }), // flagged, nothing open
      agent('e', { submitted_period: 3, flags: ['x'], open: { ...NO_OPEN, service_centre: 2 } }),
      agent('f', { submitted_period: 9 }),
    ];
    expect(sortAgents(rows, 7).map((r) => r.agent_id)).toEqual(['e', 'b', 'd', 'c', 'a', 'f']);
  });

  it('Today sorts on today’s submissions', () => {
    const rows = [agent('a', { submitted_period: 40, submitted_today: 1 }), agent('b', { submitted_period: 2, submitted_today: 5 })];
    expect(sortAgents(rows, 'today').map((r) => r.agent_id)).toEqual(['b', 'a']);
    expect(sortAgents(rows, 30).map((r) => r.agent_id)).toEqual(['a', 'b']);
  });
});

/* ───────────── intake colour ───────────── */

describe('intake colour', () => {
  it('red under 50%, plain from 50%, grey when unknown', () => {
    expect(intakeTone(0)).toBe('bad');
    expect(intakeTone(0.49)).toBe('bad');
    expect(intakeTone(49)).toBe('bad');
    expect(intakeTone(0.5)).toBe('plain');
    expect(intakeTone(50)).toBe('plain');
    expect(intakeTone(null)).toBe('idle');
    expect(INTAKE_CLASS.bad).toContain('--desk-bad');
  });

  it('paints the cell', () => {
    render(
      <MemoryRouter>
        <AgentsTable rows={[agent('a', { intake_complete_pct: 0.3 }), agent('b', { intake_complete_pct: 0.8 })]} w={7} deskId="agent-ops" />
      </MemoryRouter>,
    );
    expect(screen.getByText('30%').className).toContain('--desk-bad');
    expect(screen.getByText('80%').className).not.toContain('--desk-bad');
  });
});

/* ───────────── empty state and Service Centre filter ───────────── */

describe('empty state', () => {
  it('Agent Ops with no rows', () => {
    render(
      <MemoryRouter>
        <AgentsTable rows={[]} w={7} deskId="agent-ops" />
      </MemoryRouter>,
    );
    expect(screen.getByText(EMPTY_TEXT['agent-ops'])).not.toBeNull();
  });

  it('Service Centre keeps only agents with something open there', () => {
    const rows = [agent('a', { open: { ...NO_OPEN, coo: 3 } }), agent('b', { open: { ...NO_OPEN, service_centre: 1 } })];
    expect(rowsForDesk(rows, 'service-centre').map((r) => r.agent_id)).toEqual(['b']);
    expect(rowsForDesk(rows, 'agent-ops')).toHaveLength(2);
    render(
      <MemoryRouter>
        <AgentsTable rows={rowsForDesk([rows[0]], 'service-centre')} w={7} deskId="service-centre" />
      </MemoryRouter>,
    );
    expect(screen.getByText(EMPTY_TEXT['service-centre'])).not.toBeNull();
  });

  it('open pills show only stages with something open, in pipeline order', () => {
    expect(openPills(agent('a', { open: { ...NO_OPEN, coo: 2, service_centre: 1 } })).map((p) => `${p.short} ${p.n}`)).toEqual(['SC 1', 'COO 2']);
  });
});
