/** Test fixtures for the twin: a live payload shaped like ops_twin_now() today, cut down. */

export const zeros = () => Array.from({ length: 24 }, () => 0);
export const at = (h: number, n: number) => {
  const a = zeros();
  a[h] = n;
  return a;
};
export const lane = (key: string, failed: number, gap_failed: number) => ({
  key,
  label: key,
  owner: 'Owner',
  note: 'Partner money, ROI and settlements.',
  nodes: 4,
  verified: 1,
  partial: 1,
  gap: 2,
  draft: 0,
  not_started: 0,
  checks: 3,
  failed,
  gap_failed,
  metrics: [{ label: 'ROI credits raised', value: 1200000, unit: 'ugx' }],
});

export const LIVE = {
  run_id: null,
  run_at: '2026-11-16T00:14:00Z',
  live: true,
  last_official: { run_id: 11, run_at: '2026-11-15T17:17:41Z', window_label: 'Sat 14 Nov 20:17 – Sun 15 Nov 20:17 EAT' },
  payload: {
    window_label: 'Sun 15 Nov 03:14 – Mon 16 Nov 03:14 EAT',
    hours: Array.from({ length: 24 }, (_, i) => `${String((3 + i) % 24).padStart(2, '0')}:00`),
    queues: [
      { status: 'service_center_review', n: 3803, ugx: 791384672 },
      { status: 'pending', n: 21, ugx: 7640000 },
      { status: 'tenant_ops_approved', n: 2, ugx: 100 },
      { status: 'landlord_ops_approved', n: 3, ugx: 200 },
      { status: 'partner_ops_approved', n: 3, ugx: 850000 },
      { status: 'coo_approved', n: 18, ugx: 12650000 },
      { status: 'repaying', n: 977, ugx: 1 },
    ],
    desks: [{ desk: 'Service Centre', acted: 7, queue: 3803 }],
    flow: [
      { from: 'service_center_review', to: 'pending', lane: 'service_centre', dir: 'fwd', n: 5, ugx: 1750000, no_actor: 0, actors: 3, first: '09:34', last: '18:32' },
      { from: 'rejected', to: 'service_center_review', lane: 'resubmit', dir: 'fwd', n: 3, ugx: 1500000, no_actor: 0, actors: 3, first: '07:48', last: '00:35' },
      { from: 'new', to: 'service_center_review', lane: 'submit', dir: 'fwd', n: 2, ugx: 1250000, no_actor: 0, actors: 2, first: '14:17', last: '22:53' },
      { from: 'partner_ops_approved', to: 'service_center_review', lane: 'coo', dir: 'back', n: 2, ugx: 3300000, no_actor: 1, actors: 1, first: '01:10', last: '01:10' },
      { from: 'service_center_review', to: 'rejected', lane: 'service_centre', dir: 'back', n: 2, ugx: 1000000, no_actor: 0, actors: 2, first: '08:06', last: '00:14' },
    ],
    hourly: {
      'submit|fwd': at(3, 2),
      'service_centre|fwd': at(23, 5),
      'service_centre|back': at(4, 2),
      'coo|back': at(22, 2),
      'resubmit|fwd': at(17, 3),
      'repayment|fwd': at(5, 4),
      'withdrawals|money': at(0, 2),
      'portfolios|partner': at(2, 1),
    },
    kpis: { moves: 18 },
    money: { funded_ugx: 0 },
    totals: { gap: 40, nodes: 113, links: 78, checks: 49, needs_open: 47 },
    lanes: [lane('controls', 6, 3), lane('pipeline', 7, 1), lane('partner', 3, 0), lane('collections', 0, 0)],
    nodes: [
      { id: 'O1', name: 'Rent request', kind: 'object', family: 'Request', status: 'partial', lane: 'pipeline', owner: 'Agent → desks → COO', checks: ['sc_backlog'], failed: ['sc_backlog'] },
      { id: 'O7', name: 'Service Centre manager', kind: 'object', family: 'Party', status: 'gap', lane: 'pipeline', owner: 'Service Centre' },
      { id: 'O11', name: 'Funder', kind: 'object', family: 'Partner', status: 'partial', lane: 'partner', owner: 'Partner Ops' },
      { id: 'A4', name: 'Service Centre verify', kind: 'action', family: 'Action', status: 'gap', on: 'O1', lane: 'pipeline', owner: 'Service Centre' },
      { id: 'X', name: 'Odd', kind: 'object', family: 'Nowhere', status: 'weird', lane: 'controls', owner: 'CTO and Engineering' },
    ],
    links: [
      { id: 1, from: 'O7', to: 'O1', label: 'verifies' },
      { id: 2, from: 'O11', to: 'O1', label: 'funds' },
      { id: 3, from: 'O7', to: 'NOPE', label: 'dangling' },
    ],
    checks: [
      { key: 'a', label: 'passes', ok: true, severity: 'gap', value: 0, lane: 'pipeline', owner: 'COO' },
      { key: 'b', label: 'watch fail', ok: false, severity: 'watch', value: 5, rec: 'do b', lane: 'pipeline', owner: 'COO' },
      { key: 'sc_review_no_staff_id', label: 'Reviews without a staff ID', ok: false, severity: 'gap', value: 10, rec: 'Give staff IDs.', lane: 'pipeline', owner: 'Service Centre' },
      { key: 'stage_overdue', label: 'Past the time limit', ok: false, severity: 'watch', value: 3834, detail: 'Agent Ops 16, COO 3, Funders board 18, Service Centre 3797', rec: 'Rule on limits.', lane: 'pipeline', owner: 'COO' },
      { key: 'partner_roi_date_past', label: 'ROI payout date passed', ok: false, severity: 'watch', value: 223, rec: 'Pay or reschedule.', lane: 'partner', owner: 'CFO' },
    ],
    needs: [
      { id: 7, question: 'Later question', lean: 'Yes.', source: 'twin', lane: 'pipeline', kind: 'rule', priority: 3, evidence: '', nodes: ['O7', 'A4'] },
      { id: 102, question: 'UGX 50.00M moved with no user recorded. Who approved it?', lean: 'Name the approver.', source: 'mapping cycle 5', lane: 'money', kind: 'decision', priority: 1, evidence: 'Two ledger rows.' },
      { id: 9, question: 'No priority', lean: '', source: '', lane: 'controls', kind: 'decision' },
    ],
    rulings: [
      { id: 201, question: 'Arrears calls', ruling: 'Agent Ops calls the agent and Tenant Ops calls the tenant the next day.', lane: 'collections', kind: 'rule', nodes: ['O1'], source: 'COO ruling', decided_at: '2026-11-15T06:07:00Z' },
      { id: 202, question: 'Service Centre review', ruling: 'Every review carries a staff ID.', lane: 'pipeline', kind: 'decision', nodes: ['O7', 'NOPE'], source: 'COO ruling', decided_at: '2026-11-16T06:07:00Z' },
      { id: 203, question: 'Undated', ruling: 'Kept for the record.', lane: 'controls', kind: 'rule', source: '' },
    ],
  },
};

