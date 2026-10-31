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
    prompt: 'Show the Partner Ops Supporter portfolio and Returns summary.',
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
