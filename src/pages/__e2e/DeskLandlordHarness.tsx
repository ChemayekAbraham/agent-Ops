/**
 * Dev-only Playwright harness for the Landlord Ops board on a phone. No auth,
 * no network: the board, payment health and concerns queries are seeded with
 * fixtures, and the real ReadyBoard draws them inside a desk-root with a 56 px
 * top bar (the height the sticky group headings sit under).
 *
 * Mounted at `/__e2e/desk-landlord` only when `import.meta.env.DEV` is true.
 *   theme=dark|light   desk theme (default dark)
 *   count=9            rows per group
 */
import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { ReadyBoard } from '@/pages/desk/ReadyBoard';
import { ReviewStatusProvider } from '@/pages/desk/reviewStatus';
import { boardKey, type Board, type BoardRow } from '@/pages/desk/boardApi';
import { idsKey, type TenantHealth } from '@/pages/desk/paymentHealth';

const NAMES = ['Tina Nakato', 'Brian Ssemwogerere', 'Grace Atim', 'Moses Okello', 'Joan Nabirye', 'Peter Mugisha', 'Ruth Akello', 'Denis Kato', 'Esther Namata', 'Isaac Opio'];

function makeRow(i: number, decision: BoardRow['decision']): BoardRow {
  const pass = decision === 'pass';
  return {
    id: `req-${decision}-${i}`,
    req: `r${i}`,
    tenant: NAMES[i % NAMES.length],
    tenant_id: `t${i % 4}`,
    tenant_phone: '+256700000001',
    agent_id: `a${i}`,
    agent: `Agent ${i}`,
    agent_phone: '+256700000002',
    agent_grade: i % 3 === 0 ? null : ['A', 'B', 'C', 'D'][i % 4],
    agent_grade_week_ago: null,
    agent_flags: [],
    landlord: NAMES[(i + 3) % NAMES.length].replace(/^\S+/, ['Sarah', 'John', 'Annet', 'Robert'][i % 4]),
    landlord_phone: `+256 772 ${String(100 + i).padStart(3, '0')} ${String(4500 + i)}`,
    rent: 350000 + i * 50000,
    days_here: [0.5, 1.4, 2.6, 4.2, 6.8][i % 5],
    rating: null,
    flags:
      i % 4 === 1
        ? {
            passes: 4, total: 5, hard_fail: false, soft_fail: true, failing: ['sc_items'], notes: ['LC1 not yet confirmed (no letter, no phone confirmation)'],
            flags: [{ code: 'sc_items', label: 'Service Centre items complete', level: 'soft', ok: false, detail: 'missing: GPS' }],
          }
        : { passes: 5, total: 5, hard_fail: false, soft_fail: false, failing: [], notes: [], flags: [] },
    decision,
    rule_id: pass ? 'LO-3' : decision === 'complete' ? 'LO-2' : 'LO-1',
    why: pass ? 'Call answered, all checks pass' : decision === 'complete' ? `Call answered: finish ${1 + (i % 4)} check(s)` : 'Call the landlord',
    receiver: null,
    waiting: null,
    wait_suggest: null,
    push: pass
      ? { decision: 'pass', results: Array.from({ length: 8 }, (_, k) => ({ code: `lo_${k}`, result: 'pass' as const })), reason_code: null, note: null, target_agent_id: null }
      : null,
    call: { answered_since_stage: pass || decision === 'complete' ? 'yes' : null, attempts_24h: decision === 'call' ? i % 3 : 1 },
  };
}

export default function DeskLandlordHarness() {
  const [params] = useSearchParams();
  const theme = params.get('theme') === 'light' ? 'light' : 'dark';
  const count = Math.max(1, Number(params.get('count') ?? 9));
  const queryClient = useQueryClient();

  // Seed before the first render, so the board never asks the server.
  useState(() => {
    const rows = [
      ...Array.from({ length: count }, (_, i) => makeRow(i, 'pass')),
      ...Array.from({ length: count }, (_, i) => makeRow(i + 1, 'call')),
      ...Array.from({ length: count }, (_, i) => makeRow(i + 2, 'complete')),
    ];
    const board: Board = {
      stage: 'landlord_ops', can_act: true, staff_ref: 'E-001', sc_only: false,
      counts: { pass: count, call: count, complete: count }, rows, scope: 'new', scope_counts: null,
    };
    queryClient.setQueryData(boardKey('landlord_ops'), board);
    const ids = idsKey(rows.map((r) => r.tenant_id));
    const health: Record<string, TenantHealth> = {
      t0: { status: 'good', summary: 'Repaid 2 plans', completed_plans: 2, completed_repaid_pct: 96, active_plans: 0, active_collected_pct: null, owing: 0 },
      t1: { status: 'new', summary: null, completed_plans: 0, completed_repaid_pct: null, active_plans: 0, active_collected_pct: null, owing: 0 },
      t2: { status: 'watch', summary: null, completed_plans: 1, completed_repaid_pct: 71, active_plans: 1, active_collected_pct: 50, owing: 0 },
      t3: { status: 'poor', summary: null, completed_plans: 1, completed_repaid_pct: 40, active_plans: 0, active_collected_pct: null, owing: 0 },
    };
    queryClient.setQueryData(['desk-feed', 'tenant-health', ids.join(',')], health);
    queryClient.setQueryData(['desk-feed', 'concerns-summary', idsKey(rows.map((r) => r.id)).join(',')], {});
    return true;
  });

  return (
    <div className="desk-root min-h-dvh" data-desk-theme={theme} data-testid="desk-landlord-harness">
      <header
        data-testid="desk-topbar"
        className="text-sm font-semibold text-foreground"
        style={{ position: 'fixed', top: 0, left: 0, right: 0, height: 56, zIndex: 20, display: 'flex', alignItems: 'center', padding: '0 16px', background: theme === 'light' ? '#ffffff' : '#0B0718', borderBottom: '1px solid rgba(128,128,128,0.2)' }}
      >
        Landlord Ops
      </header>
      <div style={{ paddingTop: 64, paddingLeft: 8, paddingRight: 8, paddingBottom: 24 }}>
        <ReviewStatusProvider>
          <ReadyBoard stage="landlord_ops" board={false} onOpen={() => {}} />
        </ReviewStatusProvider>
      </div>
    </div>
  );
}
