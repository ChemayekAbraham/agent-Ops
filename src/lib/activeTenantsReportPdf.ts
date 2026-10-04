import { format } from 'date-fns';
import { generateTenantOpsExtractPdf, downloadPdfBlob } from './generateTenantOpsExtractPdf';
import { supabase } from '@/integrations/supabase/client';

interface ActiveTenantRow {
  tenant_name: string;
  tenant_phone: string;
  landlord_name: string;
  landlord_phone: string;
  agent_name: string;
  agent_phone: string;
  status_label: string;
  principal: number;
  expected: number;
  repaid: number;
  outstanding: number;
  start_date: string | null;
  end_date: string | null;
}

// Unified active-book definition shared across:
//   • Tenants Report (this file)
//   • Agent Daily Performance (AgentDailyOverviewReportButton.tsx)
// Row set: every rent_request whose status is in ACTIVE_STATUSES, no date
// cutoff, regardless of whether an agent is assigned. Principal uses the
// stored rent_amount; Outstanding uses the stored
// total_repayment − amount_repaid. Do not recompute these locally — keeping
// the math identical is what makes the three reports reconcile.
const ACTIVE_STATUSES = ['funded', 'disbursed', 'repaying', 'active', 'approved'];

async function fetchAllRentRequests() {
  const PAGE = 1000;
  let from = 0;
  const all: any[] = [];
  while (true) {
    const { data, error } = await supabase
      .from('rent_requests')
      .select('id, tenant_id, landlord_id, agent_id, assigned_agent_id, rent_amount, total_repayment, amount_repaid, disbursed_at, duration_days, status, registration_type, initial_outstanding_balance')
      .in('status', ACTIVE_STATUSES)
      .order('disbursed_at', { ascending: false, nullsFirst: false })
      .range(from, from + PAGE - 1);
    if (error) throw error;
    if (!data || data.length === 0) break;
    all.push(...data);
    if (data.length < PAGE) break;
    from += PAGE;
  }
  return all;
}

async function fetchProfilesMap(ids: string[]) {
  const unique = Array.from(new Set(ids.filter(Boolean)));
  const map = new Map<string, { name: string; phone: string }>();
  const PAGE = 500;
  for (let i = 0; i < unique.length; i += PAGE) {
    const slice = unique.slice(i, i + PAGE);
    const { data, error } = await supabase
      .from('profiles')
      .select('id, full_name, phone')
      .in('id', slice);
    if (error) throw error;
    (data ?? []).forEach((p: any) => {
      map.set(p.id, { name: p.full_name ?? '—', phone: p.phone ?? '—' });
    });
  }
  return map;
}

export async function generateAndDownloadActiveTenantsPdf() {
  const requests = await fetchAllRentRequests();

  const personIds: string[] = [];
  requests.forEach((r) => {
    if (r.tenant_id) personIds.push(r.tenant_id);
    if (r.landlord_id) personIds.push(r.landlord_id);
    const aid = r.assigned_agent_id || r.agent_id;
    if (aid) personIds.push(aid);
  });
  const profiles = await fetchProfilesMap(personIds);

  const rows: ActiveTenantRow[] = requests.map((r) => {
    const tenant = profiles.get(r.tenant_id) ?? { name: '—', phone: '—' };
    const landlord = (r.landlord_id && profiles.get(r.landlord_id)) || { name: '—', phone: '—' };
    const agentId = r.assigned_agent_id || r.agent_id;
    const agent = (agentId && profiles.get(agentId)) || { name: 'Unassigned', phone: '—' };

    // Unified math (matches Agent Daily report):
    //  • Outstanding-balance plans = legacy carry-over debt. Principal and
    //    Expected both = initial_outstanding_balance (no 1.33× formula).
    //  • Normal plans = trigger-canonical total_repayment (Rent × 1.33^(days/30) + reg fee).
    const isOB = r.registration_type === 'outstanding_balance';
    const principal = isOB
      ? Number(r.initial_outstanding_balance ?? 0)
      : Number(r.rent_amount ?? 0);
    const expected = isOB
      ? Number(r.initial_outstanding_balance ?? 0)
      : Number(r.total_repayment ?? 0);
    const repaid = Number(r.amount_repaid ?? 0);
    const outstanding = Math.max(0, expected - repaid);

    let endDate: string | null = null;
    if (r.disbursed_at && r.duration_days) {
      const d = new Date(r.disbursed_at);
      d.setDate(d.getDate() + Number(r.duration_days));
      endDate = d.toISOString();
    }

    // Active book only → every row is currently repaying.
    const status_label = outstanding <= 0 ? 'Cleared' : 'Repaying';

    return {
      tenant_name: tenant.name,
      tenant_phone: tenant.phone,
      landlord_name: landlord.name,
      landlord_phone: landlord.phone,
      agent_name: agent.name,
      agent_phone: agent.phone,
      status_label,
      principal,
      expected,
      repaid,
      outstanding,
      start_date: r.disbursed_at,
      end_date: endDate,
    };
  });

  rows.sort((a, b) => (b.start_date ?? '').localeCompare(a.start_date ?? ''));

  const totalPrincipal = rows.reduce((s, r) => s + r.principal, 0);
  const totalExpected = rows.reduce((s, r) => s + r.expected, 0);
  const totalRepaid = rows.reduce((s, r) => s + r.repaid, 0);
  const totalOutstanding = rows.reduce((s, r) => s + r.outstanding, 0);
  const collectionRate = totalExpected > 0 ? Math.round((totalRepaid / totalExpected) * 100) : 0;
  const clearedCount = rows.filter((r) => r.status_label === 'Cleared').length;
  const repayingCount = rows.filter((r) => r.status_label === 'Repaying').length;

  const tableRows = rows.map((r, i) => [
    i + 1,
    r.tenant_name,
    r.tenant_phone,
    r.landlord_name,
    r.landlord_phone,
    r.agent_name,
    r.agent_phone,
    r.status_label,
    r.principal,
    r.expected,
    r.outstanding,
    r.start_date,
    r.end_date,
  ]);

  const blob = generateTenantOpsExtractPdf({
    title: 'Tenants Report — Active Rent Plans',
    subtitle: 'Every tenant on a currently active rent plan. Principal, expected and outstanding use stored ledger values so totals reconcile with the Agent Daily Performance report.',
    kpis: [
      { label: 'Tenants', value: String(rows.length) },
      { label: 'Repaying', value: String(repayingCount) },
      { label: 'Cleared', value: String(clearedCount), color: [22, 130, 80] },
      { label: 'Principal Disbursed', value: `UGX ${Math.round(totalPrincipal).toLocaleString()}` },
      { label: 'Total Expected', value: `UGX ${Math.round(totalExpected).toLocaleString()}` },
      { label: 'Collected', value: `UGX ${Math.round(totalRepaid).toLocaleString()}`, color: [22, 130, 80] },
      { label: 'Outstanding', value: `UGX ${Math.round(totalOutstanding).toLocaleString()}`, color: [180, 60, 50] },
      { label: 'Collection Rate', value: `${collectionRate}%` },
    ],
    columns: [
      { label: '#', width: 8, align: 'right', format: 'number' },
      { label: 'Tenant Name', width: 32 },
      { label: 'Tenant Phone', width: 22 },
      { label: 'Landlord Name', width: 30 },
      { label: 'Landlord Phone', width: 22 },
      { label: 'Agent Name', width: 28 },
      { label: 'Agent Phone', width: 22 },
      { label: 'Status', width: 16 },
      { label: 'Principal Paid', width: 24, format: 'ugx' },
      { label: 'Expected', width: 24, format: 'ugx' },
      { label: 'Outstanding', width: 24, format: 'ugx' },
      { label: 'Start', width: 18, format: 'date' },
      { label: 'End', width: 18, format: 'date' },
    ],
    rows: tableRows,
    totals: ['', 'TOTALS', '', '', '', '', '', '', totalPrincipal, totalExpected, totalOutstanding, '', ''],
    footerNote: 'Active book only (status in funded, disbursed, repaying, active, approved). Normal plans: Principal = rent_amount, Expected = Rent × 1.33^(days/30) + reg fee (trigger-canonical). Outstanding-balance plans: Principal = Expected = initial_outstanding_balance (legacy carry-over debt, no 1.33× formula). Outstanding = Expected − Repaid. Confidential — Welile internal report.',
  });

  downloadPdfBlob(blob, `tenants-active-${format(new Date(), 'yyyy-MM-dd')}.pdf`);
  return rows.length;
}