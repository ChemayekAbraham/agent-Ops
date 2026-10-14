// Downloads the signed-in agent's full tenant list as CSV.
//
// Columns requested by the field team: tenant name, phone number, rent plan
// amount and paid so far. All figures come from the same server RPC the
// My Tenants list uses (get_agent_tenants_overview) — never recomputed in the
// client. Amounts are written as plain numbers (UGX) so spreadsheets can sum
// them; the column headers carry the currency.
import { supabase } from '@/integrations/supabase/client';
import { downloadCsv } from '@/lib/csvExport';

interface AgentTenantOverviewRow {
  full_name: string | null;
  phone: string | null;
  total_repayment: number | null;
  amount_repaid: number | null;
}

export async function exportAgentTenantsList(): Promise<{ ok: boolean; count: number }> {
  const { data, error } = await supabase.rpc('get_agent_tenants_overview', {
    p_today_start: new Date(new Date().setHours(0, 0, 0, 0)).toISOString(),
  });
  if (error) throw error;

  const rows = (data || []) as unknown as AgentTenantOverviewRow[];

  const csvRows = rows.map((r) => [
    r.full_name || 'Tenant',
    r.phone || '',
    Number(r.total_repayment || 0),
    Number(r.amount_repaid || 0),
  ]);

  const stamp = new Date().toISOString().slice(0, 10);
  downloadCsv(`welile-tenants-list-${stamp}.csv`, ['Tenant Name', 'Phone Number', 'Rent Plan Amount (UGX)', 'Paid So Far (UGX)'], csvRows);

  return { ok: true, count: csvRows.length };
}
