import jsPDF from 'jspdf';
import { format } from 'date-fns';
import { supabase } from '@/integrations/supabase/client';
import {
  ACTIVE_RENT_STATUSES,
  AGENT_RENT_CAP_UGX,
  type AgentCapacity,
} from '@/hooks/useAgentCapacityMap';

export interface CapacityTenantRow {
  tenant_name: string;
  tenant_phone: string;
  status: string;
  daily_repayment: number;
  total_repayment: number;
  amount_repaid: number;
  outstanding: number;
  per_tenant_max: number;     // hard cap for this tier
  remaining_eligibility: number; // min(per_tenant_max, fleet headroom snapshot)
}

export interface CapacityAgentInfo {
  full_name: string;
  phone: string | null;
}

/**
 * Loads every active rent-request tenant for an agent and computes the
 * per-tenant capacity figures used in the printable report. Headroom is
 * shared across all tenants — we snapshot it at fetch time so each row's
 * `remaining_eligibility` reflects what could still be funded today.
 */
export async function fetchAgentCapacityTenants(
  agentId: string,
  capacity: AgentCapacity,
): Promise<CapacityTenantRow[]> {
  const { data: rents } = await supabase
    .from('rent_requests')
    .select('tenant_id, status, daily_repayment, total_repayment, amount_repaid, created_at')
    .eq('agent_id', agentId)
    .in('status', ACTIVE_RENT_STATUSES)
    .order('created_at', { ascending: false });

  const tenantIds = [
    ...new Set((rents || []).map((r: any) => r.tenant_id).filter(Boolean)),
  ] as string[];
  const { data: profs } = tenantIds.length
    ? await supabase.from('profiles').select('id, full_name, phone').in('id', tenantIds)
    : { data: [] as any[] };
  const profileMap = new Map<string, { full_name: string; phone: string | null }>(
    (profs || []).map((p: any) => [p.id, { full_name: p.full_name || 'Unknown', phone: p.phone }]),
  );

  const sharedEligibility = Math.min(capacity.per_tenant_max, capacity.headroom);

  return (rents || []).map((r: any) => {
    const prof = profileMap.get(r.tenant_id) || { full_name: 'Unknown', phone: null };
    const outstanding = Math.max(
      (Number(r.total_repayment) || 0) - (Number(r.amount_repaid) || 0),
      0,
    );
    return {
      tenant_name: prof.full_name,
      tenant_phone: prof.phone || '—',
      status: String(r.status || '—').replace(/_/g, ' '),
      daily_repayment: Number(r.daily_repayment) || 0,
      total_repayment: Number(r.total_repayment) || 0,
      amount_repaid: Number(r.amount_repaid) || 0,
      outstanding,
      per_tenant_max: capacity.per_tenant_max,
      remaining_eligibility: Math.max(sharedEligibility, 0),
    };
  });
}

export function generateAgentCapacityPdf(
  agent: CapacityAgentInfo,
  capacity: AgentCapacity,
  tenants: CapacityTenantRow[],
): Blob {
  const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
  const pageWidth = doc.internal.pageSize.getWidth();
  const margin = 12;
  const contentWidth = pageWidth - margin * 2;
  let y = 15;
  const ugx = (n: number) => `UGX ${Math.round(n).toLocaleString()}`;
  const ratePct = Math.round(capacity.response_rate * 100);

  // Brand header
  doc.setFontSize(16);
  doc.setFont('helvetica', 'bold');
  doc.text('WELILE', margin, y);
  doc.setFontSize(8);
  doc.setFont('helvetica', 'normal');
  doc.text(format(new Date(), 'dd MMM yyyy, hh:mm a'), pageWidth - margin, y, { align: 'right' });
  y += 7;

  doc.setFontSize(12);
  doc.setFont('helvetica', 'bold');
  doc.text('Agent Rent-Request Capacity — Per Tenant', margin, y);
  y += 6;

  // Agent block
  doc.setFontSize(9);
  doc.setFont('helvetica', 'bold');
  doc.text(agent.full_name, margin, y);
  doc.setFont('helvetica', 'normal');
  doc.text(agent.phone || '—', margin + 80, y);
  y += 5;

  // Tier banner
  const tierColor: Record<AgentCapacity['tier'], [number, number, number]> = {
    Positive:   [16, 134, 80],
    Fair:       [217, 119, 6],
    Bad:        [234, 88, 12],
    'Very Bad': [200, 30, 30],
    Starter:    [124, 58, 237],
  };
  const [tr, tg, tb] = tierColor[capacity.tier];
  doc.setFillColor(tr, tg, tb);
  doc.rect(margin, y, contentWidth, 9, 'F');
  doc.setTextColor(255, 255, 255);
  doc.setFontSize(10);
  doc.setFont('helvetica', 'bold');
  doc.text(`Tier: ${capacity.tier}  ·  Daily response ${ratePct}%`, margin + 3, y + 6);
  doc.text(`Per-tenant max ${ugx(capacity.per_tenant_max)}`, pageWidth - margin - 3, y + 6, { align: 'right' });
  doc.setTextColor(0, 0, 0);
  y += 13;

  // KPI strip
  doc.setFontSize(8);
  const kpis: [string, string][] = [
    ['Active tenants', String(capacity.active_count)],
    ['Not Funded', String(capacity.unfunded_tenant_count)],
    ['Active exposure', ugx(capacity.used)],
    ['Fleet headroom', ugx(capacity.headroom)],
    ['Hard cap', ugx(AGENT_RENT_CAP_UGX)],
    ['Responses · 7d', `${capacity.responding_tenant_days}/${capacity.expected_tenant_days}`],
  ];
  const kpiW = contentWidth / kpis.length;
  kpis.forEach(([label, value], idx) => {
    const x = margin + idx * kpiW;
    doc.setDrawColor(220, 220, 230);
    doc.rect(x, y, kpiW - 1, 11);
    doc.setFont('helvetica', 'normal');
    doc.setTextColor(110, 110, 120);
    doc.text(label.toUpperCase(), x + 2, y + 4);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(0, 0, 0);
    doc.text(value, x + 2, y + 9);
  });
  y += 16;

  // Table header
  const cols = [
    { label: '#',          x: margin,        w: 7 },
    { label: 'Tenant',     x: margin + 7,    w: 38 },
    { label: 'Phone',      x: margin + 45,   w: 26 },
    { label: 'Daily',      x: margin + 71,   w: 22 },
    { label: 'Outstanding', x: margin + 93,  w: 28 },
    { label: 'Per-Tenant Cap', x: margin + 121, w: 30 },
    { label: 'Can Request Today', x: margin + 151, w: 35 },
  ];
  const drawHeader = () => {
    doc.setFillColor(146, 52, 234);
    doc.rect(margin, y - 4, contentWidth, 6, 'F');
    doc.setTextColor(255, 255, 255);
    doc.setFontSize(7);
    doc.setFont('helvetica', 'bold');
    cols.forEach((c) => doc.text(c.label, c.x + 1, y));
    doc.setTextColor(0, 0, 0);
    y += 5;
  };
  drawHeader();

  if (tenants.length === 0) {
    doc.setFontSize(9);
    doc.setFont('helvetica', 'italic');
    doc.setTextColor(120, 120, 120);
    doc.text('No active rent requests for this agent yet.', margin, y + 6);
    doc.setTextColor(0, 0, 0);
    y += 12;
  } else {
    let totalOutstanding = 0;
    tenants.forEach((t, i) => {
      if (y > 275) { doc.addPage(); y = 15; drawHeader(); }
      if (i % 2 === 0) {
        doc.setFillColor(246, 246, 250);
        doc.rect(margin, y - 3.5, contentWidth, 5, 'F');
      }
      doc.setFontSize(7);
      doc.setFont('helvetica', 'normal');
      doc.setTextColor(0, 0, 0);
      doc.text(`${i + 1}`, cols[0].x + 1, y);
      doc.text(t.tenant_name.slice(0, 24), cols[1].x + 1, y);
      doc.text(t.tenant_phone.slice(0, 16), cols[2].x + 1, y);
      doc.text(ugx(t.daily_repayment), cols[3].x + 1, y);
      doc.setTextColor(t.outstanding > 0 ? 200 : 0, t.outstanding > 0 ? 30 : 130, t.outstanding > 0 ? 30 : 50);
      doc.setFont('helvetica', 'bold');
      doc.text(ugx(t.outstanding), cols[4].x + 1, y);
      doc.setTextColor(0, 0, 0);
      doc.setFont('helvetica', 'normal');
      doc.text(ugx(t.per_tenant_max), cols[5].x + 1, y);
      if (t.remaining_eligibility <= 0) {
        doc.setTextColor(200, 30, 30);
        doc.setFont('helvetica', 'bold');
        doc.text('BLOCKED', cols[6].x + 1, y);
      } else {
        doc.setFont('helvetica', 'bold');
        doc.text(ugx(t.remaining_eligibility), cols[6].x + 1, y);
      }
      doc.setTextColor(0, 0, 0);
      doc.setFont('helvetica', 'normal');
      totalOutstanding += t.outstanding;
      y += 5;
    });

    // Totals row
    y += 1;
    doc.setFillColor(146, 52, 234);
    doc.rect(margin, y - 4, contentWidth, 7, 'F');
    doc.setTextColor(255, 255, 255);
    doc.setFontSize(8);
    doc.setFont('helvetica', 'bold');
    doc.text(`${tenants.length} tenants`, cols[1].x + 1, y);
    doc.text(ugx(totalOutstanding), cols[4].x + 1, y);
    doc.text(ugx(capacity.headroom), cols[6].x + 1, y);
    doc.setTextColor(0, 0, 0);
    y += 8;
  }

  // Policy footnote
  if (y > 250) { doc.addPage(); y = 15; }
  y += 4;
  doc.setFontSize(8);
  doc.setFont('helvetica', 'bold');
  doc.text('How "Can Request Today" is calculated', margin, y);
  y += 4;
  doc.setFont('helvetica', 'normal');
  doc.setTextColor(60, 60, 70);
  const note =
    'Each tenant rent request is capped at the agent\u2019s tier limit (Per-Tenant Cap). The amount the agent can still request today is the lower of (a) the per-tenant cap, and (b) the agent\u2019s remaining fleet headroom — the UGX ' +
    AGENT_RENT_CAP_UGX.toLocaleString() +
    ' aggregate active-exposure ceiling minus current outstanding rent. Tier is set by the Daily Tenant Response Rate over the last 7 days: \u226570% Positive, 40\u201369% Fair, 10\u201339% Bad, <10% Very Bad (blocked). New agents start at Starter (UGX 500,000 / tenant).';
  const lines = doc.splitTextToSize(note, contentWidth);
  doc.text(lines, margin, y);
  y += lines.length * 3.5;

  // Footer
  y += 5;
  doc.setFontSize(7);
  doc.setFont('helvetica', 'italic');
  doc.setTextColor(120, 120, 120);
  doc.text('Generated by Welile Technologies Ltd. Capacity figures refresh daily.', margin, y);
  doc.text(`Report date: ${format(new Date(), 'PPpp')}`, margin, y + 4);

  return doc.output('blob');
}

export function downloadCapacityPdf(blob: Blob, agentName: string) {
  const filename = `Welile_Capacity_${agentName.replace(/[^A-Za-z0-9]+/g, '_')}_${format(new Date(), 'yyyyMMdd')}.pdf`;
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);

  // Used by both an agent's own self-view card and the executive capacity
  // panel viewing another agent's record -- the latter is staff exporting
  // someone else's performance/financial data, worth logging regardless of
  // which caller triggered it. Plain client-side insert so the audit_logs
  // IP-capture trigger sees the real browser IP directly. Never blocks the
  // actual download.
  (async () => {
    try {
      const { data: { user } } = await supabase.auth.getUser();
      await supabase.from('audit_logs').insert({
        user_id: user?.id ?? null,
        action_type: 'pdf_report_exported',
        table_name: 'export',
        record_id: null,
        metadata: { filename, agent_name: agentName },
      });
    } catch (e) {
      console.warn('[generateAgentCapacityPdf] audit log insert failed:', e);
    }
  })();
}