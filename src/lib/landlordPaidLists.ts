// Types and wording for the Landlord Ops "Paid & Repaying" and "Completed" tabs, which load from landlord_ops_paid_lists.
// The server decides who is in each tab, the counts and every figure; the browser only shows them.

export type PaidListTab = 'paid_repaying' | 'completed';

export const PAID_LIST_TABS: readonly PaidListTab[] = ['paid_repaying', 'completed'];

export const PAID_LIST_LABEL: Record<PaidListTab, string> = {
  paid_repaying: 'Paid & Repaying',
  completed: 'Completed',
};

export const PAID_LIST_HELP: Record<PaidListTab, string> = {
  paid_repaying: 'Landlords who received money and whose tenants are repaying now.',
  completed: 'Landlords whose tenants paid off fully, with no active Rent Plan.',
};

export function isPaidListTab(v: string | null | undefined): v is PaidListTab {
  return v === 'paid_repaying' || v === 'completed';
}

/** The note shown under the Funded tab. */
export const FUNDED_TAB_NOTE = 'Money is with the agent, not yet paid to the landlord';

/** One landlord row, as landlord_ops_paid_lists returns it. */
export interface PaidListRow {
  landlord_id: string;
  landlord_name: string;
  landlord_phone: string | null;
  mobile_money_number: string | null;
  district: string | null;
  village: string | null;
  property_address: string | null;
  verified: boolean | null;
  verification_status: string | null;
  plans_total: number;
  repaying_plans: number;
  completed_plans: number;
  active_plans: number;
  tenant_count: number;
  total_rent: number;
  total_repaid: number;
  balance_left: number;
  received_amount: number;
  last_paid_at: string | null;
  agent_name: string | null;
  agent_phone: string | null;
}

export interface PaidListResponse {
  tab: PaidListTab;
  search: string | null;
  limit: number;
  offset: number;
  /** landlords matching the tab and the search */
  total: number;
  /** size of each tab, whatever the search */
  counts: { paid_repaying: number; completed: number };
  rows: PaidListRow[];
}

export function paidListErrorMessage(err: unknown): string {
  const raw = String((err as { message?: string } | null)?.message ?? err ?? '');
  if (raw.includes('NOT_AUTHORISED')) return "You don't have access to this list. Only Landlord Ops, COO, CFO, CEO and super admin can see it.";
  return "We couldn't load this list. Check your connection and try again.";
}
