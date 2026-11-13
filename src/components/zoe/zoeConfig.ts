/**
 * Role-scoped suggestion chips and source-to-screen deep-link mappings for Zoe
 * (My Space Staff Assistant).
 *
 * Rules:
 *   - No emojis anywhere in labels or descriptions.
 *   - Mandatory Welile regulatory terminology ("Rent Plan", "Supporter", "Returns").
 */

export interface ZoeSuggestion {
  id: string;
  label: string;
  prompt: string;
  category:
    | 'my_space'
    | 'tenant_ops'
    | 'landlord_ops'
    | 'agent_ops'
    | 'partner_ops'
    | 'finance'
    | 'executive'
    | 'hr';
}

export interface ZoeScreenLink {
  to: string;
  label: string;
}

const MY_SPACE_SUGGESTIONS: readonly ZoeSuggestion[] = [
  {
    id: 'my-tasks',
    label: 'My open tasks',
    prompt: 'What tasks are currently assigned to me in My Space?',
    category: 'my_space',
  },
  {
    id: 'my-payslips',
    label: 'My recent payslips',
    prompt: 'Show my most recent payslips and net pay.',
    category: 'my_space',
  },
  {
    id: 'my-requisitions',
    label: 'My requisitions status',
    prompt: 'What is the approval stage of my staff requisitions?',
    category: 'my_space',
  },
  {
    id: 'my-concerns',
    label: 'My pending concerns',
    prompt: 'Do I have any pending Calling Center concerns assigned to me?',
    category: 'my_space',
  },
  {
    id: 'my-canteen',
    label: "Today's canteen menu",
    prompt: "What is on today's canteen menu and my recent food orders?",
    category: 'my_space',
  },
  {
    id: 'my-wallet',
    label: 'My wallet balance',
    prompt: 'What is my personal wallet balance in My Space?',
    category: 'my_space',
  },
];

const TENANT_OPS_SUGGESTIONS: readonly ZoeSuggestion[] = [
  {
    id: 'tops-arrears',
    label: 'Tenant Ops arrears ageing',
    prompt: 'Show the Tenant Ops arrears ageing summary as of today.',
    category: 'tenant_ops',
  },
  {
    id: 'tops-first-seven',
    label: 'First 7 Days summary',
    prompt: 'How are newly funded Rent Plans performing in the First 7 Days report?',
    category: 'tenant_ops',
  },
  {
    id: 'tops-uncovered',
    label: 'Landlords awaiting payout',
    prompt: 'How many funded Rent Plans are awaiting landlord payout in Tenant Ops?',
    category: 'tenant_ops',
  },
  {
    id: 'tops-no-payment',
    label: '20+ days without payment',
    prompt: 'Show the Tenant Ops report for Rent Plans with 20 or more days without payment.',
    category: 'tenant_ops',
  },
];

const LANDLORD_OPS_SUGGESTIONS: readonly ZoeSuggestion[] = [
  {
    id: 'lops-home',
    label: 'Landlord Ops summary',
    prompt: 'Show the Landlord Ops pipeline and payout summary for this month.',
    category: 'landlord_ops',
  },
  {
    id: 'lops-paid-lists',
    label: 'Paid & repaying landlords',
    prompt: 'Show the Landlord Ops paid and repaying landlords list.',
    category: 'landlord_ops',
  },
  {
    id: 'lops-principal',
    label: 'Float vs principal collected',
    prompt: 'Compare Landlord Ops float allocations against principal collected.',
    category: 'landlord_ops',
  },
  {
    id: 'lops-calling',
    label: 'Landlord Calling Center summary',
    prompt: 'Show the Landlord Calling Center daily and weekly summary.',
    category: 'landlord_ops',
  },
];

const AGENT_OPS_SUGGESTIONS: readonly ZoeSuggestion[] = [
  {
    id: 'aops-totals',
    label: 'Agent Ops metrics totals',
    prompt: 'Show Agent Ops house listing and advance totals for the last 30 days.',
    category: 'agent_ops',
  },
  {
    id: 'aops-silent',
    label: 'Silent collectors today',
    prompt: 'Which agents with expected collections today have been silent for 3 or more days?',
    category: 'agent_ops',
  },
];

const PARTNER_OPS_SUGGESTIONS: readonly ZoeSuggestion[] = [
  {
    id: 'pops-overview',
    label: 'Supporter portfolio summary',
    prompt: 'Show the Partner Ops Supporter portfolio and Rent profit share summary.',
    category: 'partner_ops',
  },
  {
    id: 'pops-pending',
    label: 'Pending Supporter portfolios',
    prompt: 'How many pending Supporter portfolios are waiting in Partner Ops?',
    category: 'partner_ops',
  },
];

const FINANCE_SUGGESTIONS: readonly ZoeSuggestion[] = [
  {
    id: 'cfo-cash',
    label: 'Treasury cash position',
    prompt: 'What is the current Treasury cash position across A1, A5, and Landlord Float Pools?',
    category: 'finance',
  },
  {
    id: 'cfo-receivables-payables',
    label: 'Receivables & payables forecast',
    prompt: 'Show company Receivables, Payables, and the weekly Payables forecast.',
    category: 'finance',
  },
];

const EXECUTIVE_SUGGESTIONS: readonly ZoeSuggestion[] = [
  {
    id: 'coo-overview',
    label: 'COO Command Center',
    prompt: 'Show the COO Command Center summary and Rent Coverage Statement.',
    category: 'executive',
  },
  {
    id: 'ceo-growth',
    label: 'CEO growth quality',
    prompt: 'Show the CEO growth quality summary for the last 30 days.',
    category: 'executive',
  },
  {
    id: 'advisor-desk-wait',
    label: 'How to improve desk wait times',
    prompt: 'Where do Rent Plan requests wait longest by desk and week, and how could we improve turnaround?',
    category: 'executive',
  },
  {
    id: 'advisor-coverage',
    label: 'Areas dropping in collection coverage',
    prompt: 'Which agents and areas are dropping week on week in collection coverage, and what do you suggest?',
    category: 'executive',
  },
];

const HR_CALLING_SUGGESTIONS: readonly ZoeSuggestion[] = [
  {
    id: 'hr-calling-report',
    label: 'Staff calling report',
    prompt: 'Show the Staff Calling and Pipeline Feedback report for the last 7 days.',
    category: 'hr',
  },
  {
    id: 'hr-contracts',
    label: 'Expiring contracts & birthdays',
    prompt: 'Which staff contracts are expiring in the next 60 days and whose birthday is coming up?',
    category: 'hr',
  },
];

const TENANT_OPS_ROLE_SET = new Set([
  'tenant_ops',
  'operations',
  'coo',
  'ceo',
  'cfo',
  'cto',
  'manager',
  'super_admin',
]);

const LANDLORD_OPS_ROLE_SET = new Set([
  'landlord_ops',
  'coo',
  'cfo',
  'ceo',
  'manager',
  'super_admin',
]);

const AGENT_OPS_ROLE_SET = new Set([
  'agent_ops',
  'operations',
  'coo',
  'ceo',
  'cfo',
  'cto',
  'manager',
  'super_admin',
]);

const PARTNER_OPS_ROLE_SET = new Set([
  'partner_ops',
  'cfo',
  'ceo',
  'coo',
  'manager',
  'super_admin',
]);

const FINANCE_ROLE_SET = new Set([
  'cfo',
  'financial_ops',
  'ceo',
  'coo',
  'manager',
  'cto',
  'super_admin',
]);

const EXECUTIVE_ROLE_SET = new Set(['coo', 'ceo', 'cfo', 'manager', 'super_admin']);

/**
 * Returns up to 8 suggestion chips tailored to the signed-in staff member's enabled roles.
 */
export function getSuggestionsForRoles(roles: readonly string[] = []): ZoeSuggestion[] {
  const normalized = new Set(roles.map((r) => r.toLowerCase().trim()));
  const out: ZoeSuggestion[] = [...MY_SPACE_SUGGESTIONS.slice(0, 3)];

  const hasFinance = [...normalized].some((r) => FINANCE_ROLE_SET.has(r));
  const hasExecutive = [...normalized].some((r) => EXECUTIVE_ROLE_SET.has(r));
  const hasTenantOps = [...normalized].some((r) => TENANT_OPS_ROLE_SET.has(r));
  const hasLandlordOps = [...normalized].some((r) => LANDLORD_OPS_ROLE_SET.has(r));
  const hasAgentOps = [...normalized].some((r) => AGENT_OPS_ROLE_SET.has(r));
  const hasPartnerOps = [...normalized].some((r) => PARTNER_OPS_ROLE_SET.has(r));
  const hasHr = normalized.has('hr');

  if (hasFinance) {
    out.push(...FINANCE_SUGGESTIONS);
  }
  if (hasExecutive) {
    out.push(...EXECUTIVE_SUGGESTIONS.slice(0, 2));
  }
  if (hasTenantOps) {
    out.push(...TENANT_OPS_SUGGESTIONS.slice(0, 2));
  }
  if (hasLandlordOps) {
    out.push(...LANDLORD_OPS_SUGGESTIONS.slice(0, 2));
  }
  if (hasAgentOps) {
    out.push(...AGENT_OPS_SUGGESTIONS.slice(0, 2));
  }
  if (hasPartnerOps) {
    out.push(...PARTNER_OPS_SUGGESTIONS.slice(0, 2));
  }
  if (hasHr) {
    out.push(...HR_CALLING_SUGGESTIONS);
  }

  if (out.length < 6) {
    for (const item of MY_SPACE_SUGGESTIONS.slice(3)) {
      if (out.length >= 6) break;
      out.push(item);
    }
  }

  return out.slice(0, 8);
}

/**
 * Returns at most `limit` (default 3) starter prompts for an empty chat,
 * chosen from the person's active roles and recent conversation topics.
 */
export function getStarterSuggestionsForRoles(
  roles: readonly string[] = [],
  recentTopics: readonly string[] = [],
  limit = 3,
): ZoeSuggestion[] {
  const pool = getSuggestionsForRoles(roles);
  if (pool.length <= limit) return pool;

  const cleanTopics = recentTopics
    .map((t) => (t ?? '').trim().toLowerCase())
    .filter((t) => t.length >= 3 && t !== 'new chat');

  // Build a balanced base of up to 2 my_space + role-specific items first
  const personal = pool.filter((item) => item.category === 'my_space');
  const department = pool.filter((item) => item.category !== 'my_space');

  const baseOrder: ZoeSuggestion[] = [];
  if (department.length > 0) {
    baseOrder.push(...personal.slice(0, 2), ...department, ...personal.slice(2));
  } else {
    baseOrder.push(...pool);
  }

  if (cleanTopics.length === 0) {
    return baseOrder.slice(0, limit);
  }

  const scored = baseOrder.map((item, idx) => {
    const haystack = `${item.label} ${item.prompt} ${item.category}`.toLowerCase();
    let score = 0;
    for (const topic of cleanTopics) {
      const words = topic.split(/\s+/).filter((w) => w.length >= 4);
      for (const word of words) {
        if (haystack.includes(word)) score += 2;
      }
    }
    return { item, score, idx };
  });

  scored.sort((a, b) => (b.score !== a.score ? b.score - a.score : a.idx - b.idx));
  return scored.slice(0, limit).map((s) => s.item);
}

/**
 * Translates raw or generic error strings into calm, plain-language explanations
 * suitable for an inline note inside the chat.
 */
export function formatPlainZoeErrorMessage(rawError?: string | null): string {
  const text = (rawError ?? '').trim();
  if (!text) return "Zoe's data service is being updated. Please try again in a moment.";

  const lower = text.toLowerCase();
  if (
    lower.includes('having trouble reading that report') ||
    lower.includes('zoe_database_behind') ||
    lower.includes('schema cache') ||
    lower.includes('could not find the function') ||
    lower.includes('does not exist') ||
    lower.includes('service is being updated')
  ) {
    return "Zoe's data service is being updated. Please try again shortly.";
  }
  if (lower.includes('failed to fetch') || lower.includes('networkerror') || lower.includes('network')) {
    return 'Connection was interrupted before Zoe finished answering.';
  }
  if (lower.includes('429') || lower.includes('daily limit') || lower.includes('rate limit')) {
    return 'You have reached the question limit for right now.';
  }
  return text;
}

/**
 * Maps an official RPC/table `source` label returned by Zoe to the matching My Space
 * or department screen link so the user can jump directly to the live screen.
 */
export function resolveSourceScreenLink(source?: string | null): ZoeScreenLink {
  const s = (source ?? '').toLowerCase();

  if (s.includes('hr_pay_my_payslips') || s.includes('payslip')) {
    return { to: '/me/payslips', label: 'Open My payslips' };
  }
  if (s.includes('hr_tasks')) {
    return { to: '/me/work', label: 'Open My work' };
  }
  if (s.includes('hr_tickets') || s.includes('hr_ticket_people')) {
    return { to: '/me/tickets', label: 'Open Tickets' };
  }
  if (s.includes('staff_requisitions') || s.includes('usage_report_notices')) {
    return { to: '/me/requisitions', label: 'Open Requisitions' };
  }
  if (s.includes('hr_pay_advances')) {
    return { to: '/me', label: 'Open My space advances' };
  }
  if (s.includes('cc_my_pending_concerns')) {
    return { to: '/me/concerns', label: 'Open Concerns' };
  }
  if (s.includes('food_menu_for_day') || s.includes('food_orders')) {
    return { to: '/me/food', label: 'Open Canteen' };
  }
  if (s.includes('wallets')) {
    return { to: '/me', label: 'Open My space' };
  }
  if (s.includes('profiles') || s.includes('hr_assignments')) {
    return { to: '/your-profile', label: 'Open My profile' };
  }
  if (s.includes('get_treasury_cash_position')) {
    return { to: '/cfo/cash-position', label: 'Open Cash Position' };
  }
  if (s.includes('get_receivables_total')) {
    return { to: '/cfo/receivables-analysis', label: 'Open Receivables Analysis' };
  }
  if (s.includes('get_payables_total') || s.includes('get_payables_predictive_forecast')) {
    return { to: '/cfo/payables-forecast', label: 'Open Payables Forecast' };
  }
  if (
    s.includes('get_cfo_money_received') ||
    s.includes('get_cfo_money_paid_out') ||
    s.includes('get_cfo_seven_day_expenses') ||
    s.includes('budget_revised_position')
  ) {
    return { to: '/cfo-dashboard', label: 'Open CFO Dashboard' };
  }
  if (s.includes('finops_payout_verification_counts') || s.includes('cfo_approved_requisitions')) {
    return { to: '/financial-ops', label: 'Open Financial Ops' };
  }
  if (
    s.includes('get_coo_command_center') ||
    s.includes('get_coo_overview_snapshot') ||
    s.includes('get_coo_rent_coverage_statement')
  ) {
    return { to: '/coo-dashboard', label: 'Open COO Dashboard' };
  }
  if (s.includes('get_ceo_growth_quality') || s.includes('staff_requisition_pending_prompt')) {
    return { to: '/ceo-dashboard', label: 'Open CEO Dashboard' };
  }
  if (
    s.includes('get_agent_ops_network_overview') ||
    s.includes('agent_ops_metrics_') ||
    s.includes('agent_ops_silent_collectors')
  ) {
    return { to: '/executive-hub?tab=agent-ops', label: 'Open Agent Ops' };
  }
  if (s.includes('partner_ops_') || s.includes('pso_')) {
    return { to: '/executive-hub?tab=partner-ops', label: 'Open Partner Ops' };
  }
  if (s.includes('staff_calling_detailed_report') || s.includes('cc_weekly_all_calls_report')) {
    return { to: '/me/staff-reports', label: 'Open Calling Reports' };
  }
  if (
    s.includes('hr_contracts_expiring') ||
    s.includes('hr_list_staff_birthdays') ||
    s.includes('hr_pay_cost_by_department')
  ) {
    return { to: '/hr-dashboard', label: 'Open HR Dashboard' };
  }
  if (
    s.includes('tops_') ||
    s.includes('am_new_tenant_first7') ||
    s.includes('am_uncovered_plans') ||
    s.includes('tenant_ops_')
  ) {
    return { to: '/tenant-ops/workspace', label: 'Open Tenant Ops Workspace' };
  }
  if (s.includes('landlord_ops_principal_comparison')) {
    return { to: '/landlord-ops/principal-recovered', label: 'Open Principal Recovered' };
  }
  if (s.includes('landlord_ops') || s.includes('landlord_cc_')) {
    return { to: '/landlord-ops', label: 'Open Landlord Ops' };
  }
  if (s.includes('rent_request_timing')) {
    return { to: '/coo-dashboard', label: 'Open COO Dashboard' };
  }
  if (s.includes('staff_assistant_ideas') || s.includes('staff_assistant_insights')) {
    return { to: '/me/ideas', label: 'Open Ideas for Welile' };
  }

  return { to: '/me', label: 'Open My space' };
}

export interface ZoePageContext {
  route: string;
  title?: string;
  filters?: Record<string, string | number | boolean | null>;
  period?: string;
}

const ROUTE_TITLE_MAP: Record<string, string> = {
  '/me': 'My Space Home',
  '/me/work': 'My Space Work & Tasks',
  '/me/payslips': 'My Space Payslips',
  '/me/requisitions': 'My Space Requisitions',
  '/me/concerns': 'My Space Calling Concerns',
  '/me/food': 'My Space Canteen',
  '/me/staff-reports': 'Calling & Pipeline Feedback Reports',
  '/tenant-ops': 'Tenant Ops Dashboard',
  '/tenant-ops/workspace': 'Tenant Ops Workspace',
  '/landlord-ops': 'Landlord Ops Dashboard',
  '/landlord-ops/principal-recovered': 'Landlord Ops Principal Recovered',
  '/executive-hub': 'Executive Operations Hub',
  '/cfo-dashboard': 'CFO Dashboard',
  '/cfo/cash-position': 'CFO Cash Position',
  '/cfo/receivables-analysis': 'CFO Receivables Analysis',
  '/cfo/payables-forecast': 'CFO Payables Forecast',
  '/financial-ops': 'Financial Ops Workspace',
  '/coo-dashboard': 'COO Command Center',
  '/ceo-dashboard': 'CEO Dashboard',
  '/hr-dashboard': 'HR Dashboard',
  '/crm': 'CRM & Communications',
};

/**
 * Part C item (4) — Page awareness:
 * Extracts ONLY the route name, visible URL query filters, and period from the current browser location.
 * Never reads or forwards any screen data, DOM tables, or client state.
 */
export function derivePageContextFromLocation(
  pathname: string,
  search = '',
): ZoePageContext {
  const cleanRoute = (pathname || '/me').slice(0, 160);
  const params = new URLSearchParams(search || '');
  const filters: Record<string, string | number | boolean | null> = {};
  let period: string | undefined;

  const allowedFilterKeys = [
    'tab',
    'section',
    'period',
    'from',
    'to',
    'region',
    'district',
    'status',
    'bucket',
    'frequency',
  ];

  for (const key of allowedFilterKeys) {
    const val = params.get(key);
    if (!val) continue;
    const trimmed = val.trim().slice(0, 60);
    if (key === 'period') {
      period = trimmed;
    } else {
      filters[key] = trimmed;
    }
  }

  return {
    route: cleanRoute,
    title: ROUTE_TITLE_MAP[cleanRoute] ?? cleanRoute,
    ...(Object.keys(filters).length > 0 ? { filters } : {}),
    ...(period ? { period } : {}),
  };
}

/**
 * Part D item (5) — "What can Zoe do for my role?" gallery of 10 example questions per role
 * shown on the empty chat.
 */
export function getRoleGalleryQuestions(roles: readonly string[] = []): ZoeSuggestion[] {
  const pool: ZoeSuggestion[] = [
    ...getSuggestionsForRoles(roles),
    ...MY_SPACE_SUGGESTIONS,
    {
      id: 'my-coaching',
      label: 'How am I doing this month?',
      prompt: 'How am I doing on my work over the last 28 days, and what 3 suggestions do you have?',
      category: 'my_space',
    },
    {
      id: 'kb-expected-collected',
      label: 'Expected vs Collected Rent',
      prompt: 'What is the difference between Expected Rent and Collected Rent in Welile reports?',
      category: 'my_space',
    },
    {
      id: 'kb-cash-vs-float',
      label: 'Treasury Cash vs Agent Float',
      prompt: 'What is the difference between Treasury Cash Position (A1 + A5) and Agent Float (A2)?',
      category: 'my_space',
    },
    {
      id: 'my-tickets',
      label: 'My open HR tickets',
      prompt: 'Show my open HR tickets in My Space.',
      category: 'my_space',
    },
    {
      id: 'my-advances',
      label: 'My salary advances',
      prompt: 'Show my salary advances and remaining balance in My Space.',
      category: 'my_space',
    },
  ];

  const seen = new Set<string>();
  const unique: ZoeSuggestion[] = [];
  for (const item of pool) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    unique.push(item);
    if (unique.length >= 10) break;
  }
  return unique;
}

/**
 * Prompt 3 Deliverable (1) — Two-line note to managers pointing their teams at Zoe.
 */
export const ZOE_MANAGER_ADOPTION_NOTE_LINES: readonly [string, string] = [
  'For managers and team leads: point your team to Ask Zoe in My Space for instant read-only department reports, plain-English explanations, and call or email drafts.',
  'Every figure comes straight from a live role-checked report and Zoe never changes business data — check weekly team adoption anytime in the Zoe Real-Use Dashboard.',
];

const MANAGER_OR_LEAD_ROLES = new Set([
  'manager',
  'coo',
  'cfo',
  'ceo',
  'cto',
  'hr',
  'crm',
  'super_admin',
  'tenant_ops',
  'landlord_ops',
  'agent_ops',
  'partner_ops',
  'financial_ops',
]);

export function isZoeManagerOrLeadRole(roles: readonly string[] = []): boolean {
  return roles.some((r) => MANAGER_OR_LEAD_ROLES.has(r.toLowerCase().trim()));
}

/**
 * Prompt 3 Deliverable (1) — 10 example questions shown directly on Zoe's empty-chat
 * screen, pulled from what people actually ask Clara (`assistant_messages` where
 * `persona = 'agent'`) and what Zoe's own `staff_assistant_unanswered` log showed
 * staff wanted answered.
 */
export const ZOE_EMPTY_CHAT_EXAMPLE_QUESTIONS: readonly ZoeSuggestion[] = [
  {
    id: 'clara-wallet-balance',
    label: 'What is my personal wallet balance in My Space?',
    prompt: 'What is my personal wallet balance in My Space?',
    category: 'my_space',
  },
  {
    id: 'clara-advances-requisitions',
    label: 'Do I have any salary advances or pending requisitions?',
    prompt: 'Do I have any salary advances or pending requisitions in My Space?',
    category: 'my_space',
  },
  {
    id: 'unanswered-explain-receivables',
    label: 'Explain what receivables mean in Welile in plain English',
    prompt: 'Explain what receivables mean in Welile in plain, simple English.',
    category: 'my_space',
  },
  {
    id: 'unanswered-where-to-call-tenants',
    label: 'If I want to call tenants or landlords, where do I go?',
    prompt: 'If I want to call tenants or landlords in Welile, which screen do I open?',
    category: 'my_space',
  },
  {
    id: 'unanswered-find-tenants-list',
    label: 'How do I find the tenants list and check who is behind?',
    prompt: 'How do I find the tenants list and check which Rent Plans are behind?',
    category: 'tenant_ops',
  },
  {
    id: 'unanswered-first-seven-days',
    label: 'How are newly funded Rent Plans performing in the First 7 Days report?',
    prompt: 'How are newly funded Rent Plans performing in the First 7 Days report?',
    category: 'tenant_ops',
  },
  {
    id: 'unanswered-arrears-ageing',
    label: 'Show the Tenant Ops arrears ageing summary as of today',
    prompt: 'Show the Tenant Ops arrears ageing summary as of today.',
    category: 'tenant_ops',
  },
  {
    id: 'unanswered-calling-report',
    label: 'Show the Staff Calling and Pipeline Feedback report for the last 7 days',
    prompt: 'Show the Staff Calling and Pipeline Feedback report for the last 7 days.',
    category: 'hr',
  },
  {
    id: 'unanswered-receivables-payables',
    label: 'Show company Receivables, Payables, and the weekly Payables forecast',
    prompt: 'Show company Receivables, Payables, and the weekly Payables forecast.',
    category: 'finance',
  },
  {
    id: 'clara-my-work-coaching',
    label: 'How is my work this week compared to my 4-week average?',
    prompt: 'How is my work this week compared to my 4-week average?',
    category: 'my_space',
  },
];

export function getEmptyChatExampleQuestions(
  _roles: readonly string[] = [],
  limit = 10,
): ZoeSuggestion[] {
  return ZOE_EMPTY_CHAT_EXAMPLE_QUESTIONS.slice(0, Math.min(Math.max(limit, 8), 10));
}
