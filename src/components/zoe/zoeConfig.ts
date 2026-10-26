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
  category: 'my_space' | 'tenant_ops' | 'landlord_ops';
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

const HR_CALLING_SUGGESTIONS: readonly ZoeSuggestion[] = [
  {
    id: 'hr-lops-calling',
    label: 'Landlord Calling Center summary',
    prompt: 'Show the Landlord Calling Center daily and weekly summary.',
    category: 'landlord_ops',
  },
  {
    id: 'hr-lops-coverage',
    label: 'Landlord calling coverage',
    prompt: 'Show Landlord Calling Center registry coverage by region and district.',
    category: 'landlord_ops',
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

/**
 * Returns up to 8 suggestion chips tailored to the signed-in staff member's enabled roles.
 */
export function getSuggestionsForRoles(roles: readonly string[] = []): ZoeSuggestion[] {
  const normalized = new Set(roles.map((r) => r.toLowerCase().trim()));
  const out: ZoeSuggestion[] = [...MY_SPACE_SUGGESTIONS.slice(0, 4)];

  const hasTenantOps = [...normalized].some((r) => TENANT_OPS_ROLE_SET.has(r));
  const hasLandlordOps = [...normalized].some((r) => LANDLORD_OPS_ROLE_SET.has(r));
  const hasHrOnly = normalized.has('hr') && !hasLandlordOps;

  if (hasTenantOps) {
    out.push(...TENANT_OPS_SUGGESTIONS.slice(0, 2));
  }
  if (hasLandlordOps) {
    out.push(...LANDLORD_OPS_SUGGESTIONS.slice(0, 2));
  } else if (hasHrOnly) {
    out.push(...HR_CALLING_SUGGESTIONS);
  }

  if (out.length < 6) {
    for (const item of MY_SPACE_SUGGESTIONS.slice(4)) {
      if (out.length >= 6) break;
      out.push(item);
    }
  }

  return out.slice(0, 8);
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

  return { to: '/me', label: 'Open My space' };
}
