import type { Fmt } from './format';
import { fmt } from './format';
import type { Row } from './useDeskFeed';
import { DESK_ROLES } from './deskRoles';

export type Col = { field: string; label: string; fmt?: Fmt; right?: boolean };
export type TableSpec = {
  id: string;
  feed: string;
  title: string;
  note?: string;
  rowKey: string;
  columns: Col[];
  /** Show decision chips above the table (count and the sum of this field per decision). */
  summarySum?: string;
};
type Ref = { feed: string; field: string; where?: [string, string]; fmt?: Fmt };
export type Tile = Ref & { label: string; sub?: Ref & { label: string } };
export type Getter = (ref: Ref) => string;
export type Desk = {
  id: string;
  name: string;
  question: string;
  roles: string[];
  lead: (g: Getter) => string;
  tiles: Tile[];
  tables: TableSpec[];
};

export function pick(rows: Row[], ref: Ref): unknown {
  const row = ref.where ? rows.find((r) => String(r[ref.where![0]]) === ref.where![1]) : rows[0];
  return row ? row[ref.field] : undefined;
}
export const show = (rows: Row[], ref: Ref) => fmt(ref.fmt, pick(rows, ref));

const REQ: Col = { field: 'req', label: 'Request' };
const DAYS: Col = { field: 'age_days', label: 'Days waiting', fmt: 'days', right: true };
const RENT: Col = { field: 'rent_ugx', label: 'Rent (UGX)', fmt: 'ugxfull', right: true };
const DEC: Col = { field: 'decision', label: 'Decision', fmt: 'decision' };
const st = (ord: string, field: string, f: Fmt): Ref => ({ feed: 'pipeline', field, where: ['ord', ord], fmt: f });
const kp = (metric: string, f: Fmt): Ref => ({ feed: 'coo_kpis', field: 'value', where: ['metric', metric], fmt: f });
/** Ontology summary is a single-row feed, so tiles and the lead read its first row. */
const os = (field: string, f?: Fmt): Ref => ({ feed: 'onto_summary', field, fmt: f });
/** Ontology change summary is a single-row feed, so its tiles read the first row. */
const ocs = (field: string, f?: Fmt): Ref => ({ feed: 'onto_chg_summary', field, fmt: f });

const PAYMENT_GAPS: TableSpec = {
  id: 'payment-gaps', feed: 'payment_gaps', title: 'Money out: landlord payment gaps', rowKey: 'ord',
  note: 'Funded money is finished only when the landlord is paid and the payment is evidenced.',
  columns: [{ field: 'gap', label: 'Gap' }, { field: 'n', label: 'Count', fmt: 'int', right: true }, { field: 'ugx', label: 'UGX', fmt: 'ugxfull', right: true }, { field: 'oldest_days', label: 'Oldest days', fmt: 'days', right: true }, { field: 'owner', label: 'Owner' }, { field: 'next_step', label: 'Next step', fmt: 'decision' }],
};
const CAPITAL: TableSpec = {
  id: 'partner-capital', feed: 'portfolio_watch', title: 'Partner capital that needs action', rowKey: 'ord',
  columns: [{ field: 'issue', label: 'Issue' }, { field: 'n', label: 'Count', fmt: 'int', right: true }, { field: 'ugx', label: 'UGX', fmt: 'ugxfull', right: true }, { field: 'owner', label: 'Owner' }, { field: 'next_step', label: 'Next step', fmt: 'decision' }],
};

/** Is the business in balance? Shared by the COO desk and the command centre. */
const BALANCE_TILES: Tile[] = [
  { label: 'Requests submitted, 30 days', ...kp('requests_30d', 'int'), sub: { label: 'Previous 30 days', ...kp('requests_prev30d', 'int') } },
  { label: 'Requests funded, 30 days', ...kp('funded_30d', 'int'), sub: { label: 'Previous 30 days', ...kp('funded_prev30d', 'int') } },
  { label: 'Funded with a funder tag', ...kp('funder_tagged_30d', 'pct'), sub: { label: 'Linked to a portfolio', ...kp('portfolio_linked_30d', 'pct') } },
  { label: 'Landlord paid with proof', ...kp('paid_with_proof_30d', 'pct') },
  { label: 'Repaid against amount due', ...kp('repaid_vs_due', 'pct'), sub: { label: 'Arrears', ...kp('arrears_ugx', 'ugx') } },
  { label: 'Returns credited to one wallet, 30 days', ...kp('roi_top_wallet_share_30d', 'pct') },
];

/** Other names a desk answers to in the URL: /desk/funders opens the cfo desk. */
export const DESK_ALIASES: Record<string, string> = { funders: 'cfo' };

export const DESKS: Desk[] = [
  {
    id: 'command', name: 'Command centre', question: 'What is blocked today, and is the business in balance?', roles: DESK_ROLES['coo'],
    lead: () => 'Every desk at a glance: what is blocked today, where requests are waiting, and whether the money balances.',
    tiles: BALANCE_TILES,
    tables: [PAYMENT_GAPS],
  },
  {
    id: 'service-centre', name: 'Service Centre', question: 'Verify complete requests; send incomplete ones back.', roles: DESK_ROLES['service-centre'],
    lead: (g) => `${g(st('0b', 'n', 'int'))} new requests wait at Service Centre; the oldest has waited ${g(st('0b', 'oldest_days', 'days'))} days. ${g(st('0a', 'n', 'int'))} more from the August 2026 batch wait for the COO decision.`,
    tiles: [
      { label: 'New requests waiting', ...st('0b', 'n', 'int') },
      { label: 'Rent waiting (new)', ...st('0b', 'ugx', 'ugx') },
      { label: 'Median days (new)', ...st('0b', 'median_days', 'days') },
      { label: 'August 2026 batch', ...st('0a', 'n', 'int') },
    ],
    tables: [
      { id: 'sc-managers', feed: 'sc_managers', title: 'Service centre managers', rowKey: 'mgr', note: 'New items should be cleared within two days (assumption until agreed).', columns: [{ field: 'manager', label: 'Manager' }, { field: 'waiting_new', label: 'New waiting', fmt: 'int', right: true }, { field: 'waiting_batch', label: 'August batch', fmt: 'int', right: true }, { field: 'oldest_new_days', label: 'Oldest new (days)', fmt: 'days', right: true }, { field: 'reviews_30d', label: 'Reviews, 30 days', fmt: 'int', right: true }, DEC] },
      { id: 'sc-queue', feed: 'sc_queue', title: 'New Service Centre queue, oldest first', rowKey: 'req', summarySum: 'rent_ugx', note: '"Send back" needs the return option (E17); today the system offers only verify or reject.', columns: [REQ, { field: 'tenant', label: 'Tenant' }, { field: 'agent', label: 'Agent' }, { field: 'manager', label: 'Manager' }, DAYS, RENT, { field: 'missing', label: 'Missing' }, DEC] },
    ],
  },
  {
    id: 'agent-ops', name: 'Agent Ops', question: 'Pass, return, or move the tenant to a stronger agent.', roles: DESK_ROLES['agent-ops'],
    lead: (g) => `${g(st('1', 'n', 'int'))} requests wait for Agent Ops; the oldest has waited ${g(st('1', 'oldest_days', 'days'))} days.`,
    tiles: [{ label: 'Waiting', ...st('1', 'n', 'int') }, { label: 'Rent waiting', ...st('1', 'ugx', 'ugx') }, { label: 'Median days in stage', ...st('1', 'median_days', 'days') }],
    tables: [
      { id: 'agent-ops-queue', feed: 'agent_ops_queue', title: 'Agent Ops queue, oldest first', rowKey: 'req', summarySum: 'rent_ugx', note: 'Return when an item is missing. Transfer when the agent\'s tenants repaid under half of what is due across three or more plans, or the agent holds overdue float (assumption until agreed with the Agent Ops lead).', columns: [REQ, { field: 'tenant', label: 'Tenant' }, { field: 'agent', label: 'Agent' }, DAYS, RENT, { field: 'agent_plans', label: 'Agent plans', fmt: 'int', right: true }, { field: 'agent_recovery', label: 'Agent repaid vs due', fmt: 'pct', right: true }, { field: 'agent_overdue_float', label: 'Overdue float alerts', fmt: 'int', right: true }, { field: 'missing', label: 'Missing' }, DEC] },
      { id: 'agent-scorecard', feed: 'agent_scorecard', title: 'Agent scorecard', rowKey: 'agent', summarySum: 'overdue_ugx', note: 'Agents with a request in the last 90 days or one in the pipeline.', columns: [{ field: 'agent_name', label: 'Agent' }, { field: 'req_30d', label: 'Requests, 30 days', fmt: 'int', right: true }, { field: 'in_pipeline', label: 'In pipeline', fmt: 'int', right: true }, { field: 'plans', label: 'Plans', fmt: 'int', right: true }, { field: 'recovery', label: 'Repaid vs due', fmt: 'pct', right: true }, { field: 'overdue_alerts', label: 'Overdue float alerts', fmt: 'int', right: true }, { field: 'overdue_ugx', label: 'Overdue float (UGX)', fmt: 'ugxfull', right: true }, DEC] },
    ],
  },
  {
    id: 'tenant-ops', name: 'Tenant Ops', question: 'Call the tenant, then approve or hold.', roles: DESK_ROLES['tenant-ops'],
    lead: (g) => `${g(st('2', 'n', 'int'))} requests worth ${g(st('2', 'ugx', 'ugx'))} wait for Tenant Ops; the oldest has waited ${g(st('2', 'oldest_days', 'days'))} days.`,
    tiles: [{ label: 'Waiting', ...st('2', 'n', 'int') }, { label: 'Rent waiting', ...st('2', 'ugx', 'ugx') }, { label: 'Median days in stage', ...st('2', 'median_days', 'days') }],
    tables: [
      { id: 'tenant-ops-queue', feed: 'tenant_ops_queue', title: 'Tenant Ops queue, oldest first', rowKey: 'req', summarySum: 'rent_ugx', note: 'The call covers rent support up to UGX 30M, paying by merchant code, smartphone access, the tenant dashboard, and confirming the rent amount.', columns: [REQ, { field: 'tenant', label: 'Tenant' }, { field: 'agent', label: 'Agent' }, DAYS, RENT, { field: 'smartphone', label: 'Smartphone' }, { field: 'tenant_call', label: 'Tenant call' }, { field: 'aware_30m', label: 'Knows 30M offer' }, { field: 'merchant_pay', label: 'Knows merchant pay' }, { field: 'other_open', label: 'Other open requests', fmt: 'int', right: true }, DEC] },
    ],
  },
  {
    id: 'landlord-ops', name: 'Landlord Ops', question: 'Call and verify the landlord, then approve.', roles: DESK_ROLES['landlord-ops'],
    lead: (g) => `${g(st('3', 'n', 'int'))} requests wait for Landlord Ops; the oldest has waited ${g(st('3', 'oldest_days', 'days'))} days.`,
    tiles: [{ label: 'Waiting', ...st('3', 'n', 'int') }, { label: 'Rent waiting', ...st('3', 'ugx', 'ugx') }, { label: 'Oldest days in stage', ...st('3', 'oldest_days', 'days') }],
    tables: [
      { id: 'landlord-ops-queue', feed: 'landlord_ops_queue', title: 'Landlord Ops queue, oldest first', rowKey: 'req', summarySum: 'rent_ugx', note: 'The call confirms the landlord knows the tenant, the rent amount, how and when they are paid, and explains Welile\'s offer.', columns: [REQ, { field: 'tenant', label: 'Tenant' }, { field: 'landlord', label: 'Landlord' }, DAYS, RENT, { field: 'landlord_verified', label: 'Landlord verified' }, { field: 'landlord_call', label: 'Landlord call' }, { field: 'consent', label: 'Consent' }, { field: 'payout_otp_aware', label: 'Knows payout code' }, { field: 'agreement', label: 'Agreement' }, DEC] },
      { id: 'landlord-verify', feed: 'landlord_verify', title: 'Landlords to verify', rowKey: 'landlord', summarySum: 'ugx_waiting', note: 'Only landlords with an open or repaying plan. Funding is blocked until the landlord is verified.', columns: [{ field: 'landlord_name', label: 'Landlord' }, { field: 'live_requests', label: 'Live requests', fmt: 'int', right: true }, { field: 'ugx_waiting', label: 'Rent (UGX)', fmt: 'ugxfull', right: true }, { field: 'oldest_days', label: 'Oldest days', fmt: 'days', right: true }, { field: 'sc_status', label: 'Service Centre' }, { field: 'stages', label: 'Stages' }, DEC] },
    ],
  },
  {
    id: 'coo', name: 'COO', question: 'Push approved requests on, and keep the business in balance.', roles: DESK_ROLES['coo'],
    lead: (g) => `${g(st('5', 'n', 'int'))} requests worth ${g(st('5', 'ugx', 'ugx'))} wait for your push.`,
    tiles: BALANCE_TILES,
    tables: [
      {
        id: 'coo-queue', feed: 'coo_queue', title: 'Your approval queue, oldest first', rowKey: 'req', summarySum: 'rent_ugx',
        note: 'Return when the landlord is unverified or a funder-visible request has no funder tag; otherwise approve oldest first. A signed agreement is shown but not required (policy pending).',
        columns: [REQ, { field: 'tenant', label: 'Tenant' }, { field: 'agent', label: 'Agent' }, { field: 'landlord', label: 'Landlord' }, DAYS, RENT, { field: 'funder_tag', label: 'Funder tag' }, { field: 'landlord_verified', label: 'Landlord verified' }, { field: 'agreement', label: 'Agreement' }, DEC],
      },
      {
        id: 'pipeline', feed: 'pipeline', title: 'Where requests are waiting', rowKey: 'ord',
        note: 'Days count from the moment a request entered its current stage. The August 2026 batch is shown apart.',
        columns: [{ field: 'stage', label: 'Stage' }, { field: 'desk', label: 'Acts next' }, { field: 'n', label: 'Waiting', fmt: 'int', right: true }, { field: 'ugx', label: 'UGX', fmt: 'bar', right: true }, { field: 'median_days', label: 'Median days', fmt: 'days', right: true }, { field: 'oldest_days', label: 'Oldest days', fmt: 'days', right: true }],
      },
      PAYMENT_GAPS,
      {
        id: 'monthly-flow', feed: 'monthly_flow', title: 'Demand against funding by month', rowKey: 'ym',
        note: 'Submitted counts requests created in the month; funded counts requests funded in the month. August 2026 includes the one-off batch.',
        columns: [{ field: 'ym', label: 'Month' }, { field: 'submitted', label: 'Submitted', fmt: 'int', right: true }, { field: 'funded', label: 'Funded', fmt: 'bar', right: true }, { field: 'funder_tagged', label: 'Funder-tagged', fmt: 'int', right: true }],
      },
    ],
  },
  {
    // The id stays 'cfo' so the switch key stays desk_live:cfo; /desk/funders is an alias (DESK_ALIASES).
    id: 'cfo', name: 'Funders Dashboard', question: 'Which approved requests are funders taking, and which should Welile fund?', roles: DESK_ROLES['cfo'],
    // The lead comes from funders_dashboard itself (fundersLead), so it matches the tiles and the list;
    // the pipeline feed's count still included a request a funder had claimed.
    lead: () => '',
    // The Funders Dashboard draws its own tiles from funders_dashboard.
    tiles: [],
    tables: [
      { id: 'cfo-queue', feed: 'cfo_queue', title: 'Funding queue, oldest first', rowKey: 'req', summarySum: 'rent_ugx', note: 'Fund today unless the landlord is unverified, which the system blocks at funding.', columns: [REQ, { field: 'tenant', label: 'Tenant' }, { field: 'agent', label: 'Agent' }, { field: 'landlord', label: 'Landlord' }, DAYS, RENT, { field: 'landlord_verified', label: 'Landlord verified' }, DEC] },
      PAYMENT_GAPS,
      { ...CAPITAL, id: 'cfo-capital', title: 'Partner capital to verify' },
    ],
  },
  {
    id: 'partner-ops', name: 'Partner Ops', question: 'Which listed tenants are funders taking, and what still needs a push?', roles: DESK_ROLES['partner-ops'],
    // The lead comes from partner_ops_board itself, so the sales desk writes it (partnerLead); nothing here.
    lead: () => '',
    tiles: [],
    tables: [
      { id: 'partner-queue', feed: 'partner_ops_queue', title: 'Partner Ops queue', rowKey: 'req', summarySum: 'rent_ugx', note: 'Funders choosing tenants themselves is planned for new tenants, alongside this model, once the team agrees the logic.', columns: [REQ, { field: 'tenant', label: 'Tenant' }, { field: 'agent', label: 'Agent' }, DAYS, RENT, { field: 'funder_visibility', label: 'Funder visibility' }, { field: 'proxy', label: 'Proxy partner' }, DEC] },
      CAPITAL,
    ],
  },
  {
    id: 'customer-care', name: 'Customer Care', question: 'Answer every concern before it is due.', roles: DESK_ROLES['customer-care'],
    lead: () => 'Open forwarded concerns, overdue first. Anything past its due date is chased today; concerns an owner has not accepted are re-assigned.',
    tiles: [],
    tables: [
      { id: 'cc-owners', feed: 'cc_owners', title: 'Who holds the open concerns', rowKey: 'owner', columns: [{ field: 'owner', label: 'Owner' }, { field: 'open_concerns', label: 'Open', fmt: 'int', right: true }, { field: 'overdue', label: 'Overdue', fmt: 'int', right: true }, { field: 'not_accepted', label: 'Not accepted', fmt: 'int', right: true }, { field: 'oldest_days', label: 'Oldest (days)', fmt: 'days', right: true }] },
      { id: 'cc-queue', feed: 'cc_queue', title: 'Open concerns, overdue first', rowKey: 'concern', summarySum: 'days_open', columns: [{ field: 'caller', label: 'Caller' }, { field: 'subject', label: 'About' }, { field: 'title', label: 'Concern' }, { field: 'priority', label: 'Priority' }, { field: 'owner', label: 'Owner' }, { field: 'status', label: 'Status' }, { field: 'days_open', label: 'Days open', fmt: 'days', right: true }, { field: 'due', label: 'Due' }, DEC] },
    ],
  },
  {
    id: 'ontology', name: 'Ontology', question: 'What happened on the mapped day, how much of it says why, and what runs outside the ontology?', roles: DESK_ROLES['coo'],
    lead: (g) => `Map of ${g(os('map_day'))} (ontology ${g(os('version'))}, built ${g(os('built_at'))} EAT). Last nightly run: ${g(os('last_night_run'))}. ${g(os('explained_share', 'pct'))} of recorded changes say why; the target is 95%.`,
    tiles: [
      { label: 'Audit rows with a reason', ...os('audit_share', 'pct'), sub: { label: 'Audit rows', ...os('audit_rows', 'int') } },
      { label: 'System events with a description', ...os('events_share', 'pct'), sub: { label: 'Events', ...os('event_rows', 'int') } },
      { label: 'Tables written', ...os('tables_written', 'int'), sub: { label: 'In the ontology', ...os('tables_registered', 'int') } },
      { label: 'Scheduled jobs acting', ...os('jobs_active', 'int'), sub: { label: 'With a named owner', ...os('jobs_registered', 'int') } },
      { label: 'Ontology changes to decide', ...os('open_proposals', 'int'), sub: { label: 'New last night', ...os('new_proposals', 'int') } },
      { label: 'System changes, 7 days', ...ocs('changes_7d', 'int'), sub: { label: 'Not published', ...ocs('not_published', 'int') } },
      { label: 'Changes that say why', ...ocs('changes_explained_share', 'pct'), sub: { label: 'Builder not recorded', ...ocs('builder_unknown', 'int') } },
    ],
    tables: [
      {
        id: 'onto-trend', feed: 'onto_trend', title: 'Last 7 days', rowKey: 'day_iso',
        note: 'Newest first. Explained = share of recorded changes that say why. Desk actions = rent-request approvals across all desks that day.',
        columns: [{ field: 'day_label', label: 'Day' }, { field: 'explained_share', label: 'Explained', fmt: 'pct', right: true }, { field: 'desk_actions', label: 'Desk actions', fmt: 'int', right: true }, { field: 'coo_approved', label: 'COO approved', fmt: 'int', right: true }, { field: 'funded', label: 'Funded', fmt: 'int', right: true }, { field: 'receipts_missing', label: 'Receipts missing', fmt: 'int', right: true }, { field: 'receipts_missing_ugx', label: 'Receipts missing (UGX)', fmt: 'ugx', right: true }, { field: 'funded_not_paid', label: 'Funded, not paid', fmt: 'int', right: true }, { field: 'failed_payouts', label: 'Failed payouts', fmt: 'int', right: true }, { field: 'idle_float', label: 'Idle float', fmt: 'int', right: true }],
      },
      {
        id: 'onto-heartbeat', feed: 'onto_actions', title: 'Desk heartbeat on the mapped day', rowKey: 'ord',
        note: 'Clearing: actions covered the whole queue. Moving: at least a quarter of the queue cleared that day. Slow: under a quarter (assumption until desk leads agree). Stalled: requests waiting, no action. Days to clear = requests waiting ÷ that day\'s actions. Service Centre excludes the August 2026 batch.',
        columns: [{ field: 'action', label: 'Ontology action' }, { field: 'desk', label: 'Desk' }, { field: 'n', label: 'Actions that day', fmt: 'int', right: true }, { field: 'waiting', label: 'Waiting', fmt: 'int', right: true }, { field: 'days_to_clear', label: 'Days to clear', fmt: 'days', right: true }, DEC],
      },
      {
        id: 'onto-clocks', feed: 'onto_clocks', title: 'Open money clocks', rowKey: 'ord',
        columns: [{ field: 'clock', label: 'Clock' }, { field: 'n', label: 'Count', fmt: 'int', right: true }, { field: 'ugx', label: 'UGX', fmt: 'ugxfull', right: true }, { field: 'owner', label: 'Owner' }],
      },
      {
        id: 'onto-audit', feed: 'onto_top_audit', title: 'Most frequent actions: do they say why?', rowKey: 'action_name',
        columns: [{ field: 'action_name', label: 'Recorded action' }, { field: 'n', label: 'Times', fmt: 'int', right: true }, { field: 'reason_share', label: 'With reason', fmt: 'pct', right: true }, { field: 'ontology_action', label: 'Ontology action' }, DEC],
      },
      {
        id: 'onto-drift', feed: 'onto_drift', title: 'Drift: reality outside the ontology', rowKey: 'grp_key',
        note: 'Each group is decided at once, with one reason, by a staff account holding the COO position. Decisions are stamped with name, staff number and position.',
        columns: [{ field: 'what', label: 'Proposal' }, { field: 'suggested', label: 'Suggested type' }, { field: 'n', label: 'Items', fmt: 'int', right: true }, { field: 'examples', label: 'Examples' }, DEC],
      },
      {
        id: 'onto-changes', feed: 'onto_chg_list', title: 'System changes, last 7 days', rowKey: 'change_ref',
        note: 'Every change to the system itself. Database changes are picked up automatically each night; app changes are recorded when made. A change without a reason shows as such.',
        columns: [{ field: 'when_eat', label: 'When (EAT)' }, { field: 'kind_label', label: 'Type' }, { field: 'title', label: 'Change' }, { field: 'built_by', label: 'Built by' }, { field: 'approved_by', label: 'Approved by' }, { field: 'why', label: 'Why' }, { field: 'status_label', label: 'Status' }, DEC],
      },
    ],
  },
];

/** The desk a person lands on first, by their strongest role. */
const LANDING: [string, string][] = [
  ['coo', 'command'], ['ceo', 'command'], ['super_admin', 'command'], ['cto', 'command'], ['cfo', 'cfo'], ['financial_ops', 'cfo'],
  ['partner_ops', 'partner-ops'], ['landlord_ops', 'landlord-ops'], ['tenant_ops', 'tenant-ops'], ['agent_ops', 'agent-ops'],
  ['crm', 'customer-care'], ['operations', 'service-centre'], ['manager', 'service-centre'],
];
export function landingDesk(roles: string[], allowed: Desk[]): Desk {
  for (const [role, desk] of LANDING) {
    if (roles.includes(role)) {
      const d = allowed.find((x) => x.id === desk);
      if (d) return d;
    }
  }
  return allowed[0];
}

export function feedsOf(desk: Desk): string[] {
  const s = new Set<string>();
  desk.tiles.forEach((t) => { s.add(t.feed); if (t.sub) s.add(t.sub.feed); });
  desk.tables.forEach((t) => s.add(t.feed));
  if (desk.id !== 'customer-care' && desk.id !== 'ontology') s.add('pipeline');
  if (['coo', 'partner-ops', 'cfo', 'command'].includes(desk.id)) s.add('coo_kpis');
  // The command centre also carries a Customer Care card.
  if (desk.id === 'command') s.add('cc_owners');
  // The Ontology desk's day picker lists the mapped days.
  if (desk.id === 'ontology') s.add('onto_days');
  return Array.from(s);
}
