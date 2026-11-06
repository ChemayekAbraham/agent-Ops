import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('@/integrations/supabase/client', () => ({ supabase: { rpc: vi.fn(), from: vi.fn(), storage: { from: vi.fn() } } }));
vi.mock('@/hooks/useAuth', () => ({ useAuth: () => ({ user: null, roles: [] }) }));

import {
  LADDER_EMPTY,
  downloadName,
  followText,
  ladderText,
  rulesByBoard,
  sortDeskRules,
  type DeskRule,
  type OntologyBoard,
  type OntologyRule,
} from '../ontology/ontologyApi';
import { AutomationBadge, BasisBadge, automationClass, basisClass, basisLabel } from '../ontology/badges';
import { RuleLine } from '../DeskRules';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { OntologyTab } from '../ontology/OntologyTab';

/* ───────────── fixtures ───────────── */

const rule = (rule_id: string, all_desks: boolean, extra: Partial<DeskRule> = {}): DeskRule => ({
  rule_id,
  when: `condition ${rule_id}`,
  then: `decision ${rule_id}`,
  automation: 'manual',
  basis: 'decision',
  owner: null,
  notes: null,
  all_desks,
  ...extra,
});

const board = (ord: number, name: string): OntologyBoard => ({
  ord,
  name,
  route: null,
  purpose: null,
  data_rpc: null,
  actions: [],
  owner_roles: [],
  status: 'active',
  notes: null,
  follow: null,
});

const oRule = (rule_id: string, boardName: string | null): OntologyRule => ({
  rule_id,
  board: boardName,
  condition: 'c',
  decision: 'd',
  action: null,
  reason_code: null,
  automation: 'manual',
  basis: 'decision',
  owner: null,
  status: 'active',
  since_version: '0.9',
  notes: null,
});

/* ───────────── follow rate ───────────── */

describe('followText', () => {
  it('an empty follow says "No reviews yet"', () => {
    expect(followText(null)).toBe('No reviews yet');
    expect(followText(undefined)).toBe('No reviews yet');
    expect(followText({ reviews_14d: 0, followed_14d: 0, rate: null, top_overrides: [] })).toBe('No reviews yet');
    expect(followText({ reviews_14d: null, followed_14d: null, rate: null, top_overrides: null })).toBe('No reviews yet');
  });

  it('counts reviews followed over 14 days', () => {
    expect(followText({ reviews_14d: 140, followed_14d: 129, rate: 0.92, top_overrides: [] })).toBe(
      'Follows the system: 92% of 140 reviews (14 days)',
    );
  });

  it('falls back to the rate, as a fraction or a percentage', () => {
    expect(followText({ reviews_14d: 140, followed_14d: null, rate: 0.92, top_overrides: [] })).toBe(
      'Follows the system: 92% of 140 reviews (14 days)',
    );
    expect(followText({ reviews_14d: 140, followed_14d: null, rate: 92, top_overrides: [] })).toBe(
      'Follows the system: 92% of 140 reviews (14 days)',
    );
  });
});

/* ───────────── ladder ───────────── */

describe('ladder', () => {
  it('has the agreed empty state', () => {
    expect(LADDER_EMPTY).toBe('No rule is ready yet — follow rates build as desks use their boards.');
  });

  it('reads one candidate as one line', () => {
    expect(ladderText({ rule_id: 'AO-3', board: 'Agent Ops', from: 'one_push', to: 'auto', follow_rate: 0.95, reviews_14d: 140 })).toBe(
      'AO-3 → auto: 95% followed over 140 reviews',
    );
  });
});

/* ───────────── badges ───────────── */

describe('badge colours', () => {
  it('manual grey, one_push blue, auto green, guard black', () => {
    expect(automationClass('manual')).toContain('text-muted-foreground');
    expect(automationClass('one_push')).toContain('sky');
    expect(automationClass('auto')).toContain('--desk-ok');
    expect(automationClass('guard')).toContain('bg-black');
    // Anything unknown reads as manual.
    expect(automationClass('something-new')).toBe(automationClass('manual'));
    expect(automationClass(null)).toBe(automationClass('manual'));
  });

  it('assumption is amber and names its owner; decision is plain', () => {
    expect(basisClass('assumption')).toContain('--desk-warn');
    expect(basisClass('decision')).not.toContain('--desk-warn');
    expect(basisLabel('assumption', 'CFO')).toBe('assumption · CFO');
    expect(basisLabel('decision', 'CFO')).toBe('decision');
  });

  it('renders the classes on the badge', () => {
    render(
      <>
        <AutomationBadge automation="guard" />
        <AutomationBadge automation="one_push" />
        <BasisBadge basis="assumption" owner="COO" />
      </>,
    );
    expect(screen.getByText('guard').className).toContain('bg-black');
    expect(screen.getByText('one push').className).toContain('sky');
    expect(screen.getByText('assumption · COO').className).toContain('--desk-warn');
  });
});

/* ───────────── download ───────────── */

describe('downloadName', () => {
  it('is WELILE-ONTOLOGY-<version>-<Kampala date>.md', () => {
    // 22:30 UTC on 5 Nov is 01:30 on 6 Nov in Kampala.
    const at = new Date('2026-11-05T22:30:00Z');
    expect(downloadName('v0.9', at)).toBe('WELILE-ONTOLOGY-v0.9-2026-11-06.md');
    expect(downloadName('0.9', new Date('2026-11-05T09:00:00Z'))).toBe('WELILE-ONTOLOGY-0.9-2026-11-05.md');
  });

  it('keeps the file name safe', () => {
    const at = new Date('2026-11-05T09:00:00Z');
    expect(downloadName('v1.0 / draft', at)).toBe('WELILE-ONTOLOGY-v1.0-draft-2026-11-05.md');
    expect(downloadName(null, at)).toBe('WELILE-ONTOLOGY-unversioned-2026-11-05.md');
  });
});

/* ───────────── rules order ───────────── */

describe('rules for this desk', () => {
  it('"All desks" rules come last, each group in the order sent', () => {
    const sorted = sortDeskRules([rule('G-1', true), rule('AO-1', false), rule('G-2', true), rule('AO-4', false)]);
    expect(sorted.map((r) => r.rule_id)).toEqual(['AO-1', 'AO-4', 'G-1', 'G-2']);
    expect(sortDeskRules(null)).toEqual([]);
  });

  it('one line per rule: "AO-4 · When … → Then …" with both badges', () => {
    const { container } = render(
      <ul>
        <RuleLine rule={rule('AO-4', false, { automation: 'auto', basis: 'assumption', owner: 'COO' })} />
      </ul>,
    );
    expect(container.textContent).toContain('AO-4 · When condition AO-4 → Then decision AO-4');
    expect(screen.getByText('auto')).not.toBeNull();
    expect(screen.getByText('assumption · COO')).not.toBeNull();
    expect(screen.queryByText('All desks')).toBeNull();
  });

  it('marks an all-desks rule', () => {
    render(
      <ul>
        <RuleLine rule={rule('G-1', true)} />
      </ul>,
    );
    expect(screen.getByText('All desks')).not.toBeNull();
  });
});

describe('rulesByBoard', () => {
  it('groups in pipeline order, unknown boards last', () => {
    const groups = rulesByBoard(
      [oRule('X-1', 'Elsewhere'), oRule('AO-1', 'Agent Ops'), oRule('SC-1', 'Service Centre'), oRule('AO-2', 'Agent Ops')],
      [board(2, 'Agent Ops'), board(1, 'Service Centre')],
    );
    expect(groups.map((g) => g.board)).toEqual(['Service Centre', 'Agent Ops', 'Elsewhere']);
    expect(groups[1].rules.map((r) => r.rule_id)).toEqual(['AO-1', 'AO-2']);
  });
});

/* ───────────── the tab, from a fixture ───────────── */

/** The supabase mock's rpc, typed loosely: vi.mocked on the full client type is too deep for tsc. */
const rpcMock = supabase.rpc as unknown as ReturnType<typeof vi.fn>;

const VIEW = {
  version: 'v0.9',
  generated_at: '2026-11-05T09:00:00Z',
  days: 7,
  counts: { objects: 38, links: 14, actions: 37, boards: 11, rules: 29, assumptions: 4 },
  boards: [board(1, 'Service Centre')],
  rules: [oRule('SC-1', 'Service Centre')],
  assumptions: [],
  objects: [],
  links: [],
  actions: [],
  reason_codes: [],
  jobs: [],
  switches: [],
  week: { since: '2026-10-29T00:00:00Z', changes: [], added: [], retired: [], ladder_candidates: [] },
  document_md: '# Ontology',
};

describe('OntologyTab', () => {
  it('renders the header, an unreviewed board and the empty ladder', async () => {
    rpcMock.mockResolvedValue({ data: VIEW, error: null });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <OntologyTab board={false} />
      </QueryClientProvider>,
    );
    expect(
      await screen.findByText('Ontology v0.9 · 38 objects · 14 links · 37 actions · 11 boards · 29 rules (4 assumptions)'),
    ).not.toBeNull();
    expect(screen.getByText('No reviews yet')).not.toBeNull();
    expect(screen.getByText(LADDER_EMPTY)).not.toBeNull();
    expect(rpcMock).toHaveBeenCalledWith('ontology_desk_view', { p_days: 7 });
  });
});
