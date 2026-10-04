import { supabase } from '@/integrations/supabase/client';
import welileWordmark from '@/assets/welile-wordmark.png.asset.json';
import { formatUGX } from '@/lib/rentCalculations';
import { archivePdfBlob } from '@/lib/pdfVault';

export type RangeKey = 'weekly' | 'monthly' | 'yearly';

interface CollectionRow {
  amount: number;
  created_at: string;
  payment_method: string | null;
  location_name: string | null;
  tenant_id: string | null;
  momo_provider: string | null;
}

interface TenantLite { id: string; full_name: string | null; phone: string | null }

function rangeFor(range: RangeKey): { from: Date; to: Date; label: string } {
  const to = new Date();
  const from = new Date();
  if (range === 'weekly') {
    from.setDate(to.getDate() - 6);
    from.setHours(0, 0, 0, 0);
    return { from, to, label: 'Weekly (last 7 days)' };
  }
  if (range === 'monthly') {
    from.setDate(1);
    from.setHours(0, 0, 0, 0);
    return { from, to, label: to.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' }) };
  }
  from.setMonth(0, 1);
  from.setHours(0, 0, 0, 0);
  return { from, to, label: `Year ${to.getFullYear()}` };
}

async function loadLogoDataUrl(): Promise<string | null> {
  try {
    const res = await fetch(welileWordmark.url);
    const blob = await res.blob();
    return await new Promise<string>((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result as string);
      r.onerror = () => reject(new Error('logo read failed'));
      r.readAsDataURL(blob);
    });
  } catch {
    return null;
  }
}

export async function generateAgentRentCollectionsPdf(params: {
  agentId: string;
  agentName: string;
  range: RangeKey;
}): Promise<Blob> {
  const { agentId, agentName, range } = params;
  const { from, to, label } = rangeFor(range);

  const { data, error } = await supabase
    .from('agent_collections')
    .select('amount, created_at, payment_method, location_name, tenant_id, momo_provider').is('reversed_at', null)
    .eq('agent_id', agentId)
    .gte('created_at', from.toISOString())
    .lte('created_at', to.toISOString())
    .order('created_at', { ascending: false });

  if (error) throw error;
  const rows: CollectionRow[] = (data as CollectionRow[]) || [];
  const totalCollected = rows.reduce((s, r) => s + Number(r.amount || 0), 0);

  // Expected daily target for the same period
  const fromDate = from.toISOString().split('T')[0];
  const toDate = to.toISOString().split('T')[0];
  const { data: expectedRows, error: expectedError } = await supabase
    .from('agent_daily_eligibility_history')
    .select('expected_daily')
    .eq('agent_id', agentId)
    .gte('day', fromDate)
    .lte('day', toDate);

  if (expectedError) throw expectedError;
  const totalExpected = ((expectedRows as { expected_daily: number }[]) || [])
    .reduce((s, r) => s + Number(r.expected_daily || 0), 0);
  const collectionRate = totalExpected > 0
    ? Math.round((totalCollected / totalExpected) * 100)
    : 0;


  // Fetch tenant names
  const tenantIds = Array.from(new Set(rows.map(r => r.tenant_id).filter((v): v is string => !!v)));
  const tenantMap = new Map<string, string>();
  if (tenantIds.length > 0) {
    const { data: tenants } = await supabase
      .from('profiles')
      .select('id, full_name, phone')
      .in('id', tenantIds);
    ((tenants as TenantLite[]) || []).forEach(t => {
      tenantMap.set(t.id, t.full_name || t.phone || '—');
    });
  }

  const { jsPDF } = await import('jspdf');
  const pdf = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4', compress: true });
  const pw = pdf.internal.pageSize.getWidth();
  const ph = pdf.internal.pageSize.getHeight();
  const margin = 12;

  // Header band — purple
  pdf.setFillColor(107, 33, 168); // welile purple
  pdf.rect(0, 0, pw, 30, 'F');

  // White wordmark text (avoids relying on colored logo asset)
  pdf.setTextColor(255, 255, 255);
  pdf.setFont('helvetica', 'bold');
  pdf.setFontSize(22);
  pdf.text('Welile', margin, 20);

  pdf.setTextColor(255, 255, 255);
  pdf.setFont('helvetica', 'bold');
  pdf.setFontSize(14);
  pdf.text('Rent Collections Report', pw - margin, 14, { align: 'right' });
  pdf.setFont('helvetica', 'normal');
  pdf.setFontSize(9);
  pdf.text(label, pw - margin, 20, { align: 'right' });
  pdf.text(`Generated: ${new Date().toLocaleString('en-GB')}`, pw - margin, 25, { align: 'right' });

  // Meta
  pdf.setTextColor(0, 0, 0);
  let y = 38;
  pdf.setFontSize(10);
  pdf.setFont('helvetica', 'bold');
  pdf.text(`Agent: ${agentName}`, margin, y);
  y += 5;
  pdf.setFont('helvetica', 'normal');
  pdf.text(`Period: ${from.toLocaleDateString('en-GB')} — ${to.toLocaleDateString('en-GB')}`, margin, y);
  y += 8;

  // Summary cards
  const cardH = 16;
  const gap = 4;
  const cardW = (pw - margin * 2 - gap * 2) / 3;

  const summaries = [
    { label: 'Total Expected', value: formatUGX(totalExpected), color: 107, sub: `${(expectedRows || []).length} day${(expectedRows || []).length === 1 ? '' : 's'}` },
    { label: 'Total Collected', value: formatUGX(totalCollected), color: 22, sub: `${rows.length} payment${rows.length === 1 ? '' : 's'}` },
    { label: 'Collection Rate', value: `${collectionRate}%`, color: collectionRate >= 80 ? 22 : collectionRate >= 50 ? 180 : 239, sub: 'of expected target' },
  ];

  summaries.forEach((s, i) => {
    const x = margin + i * (cardW + gap);
    pdf.setFillColor(243, 232, 255);
    pdf.roundedRect(x, y, cardW, cardH, 2, 2, 'F');
    pdf.setTextColor(107, 33, 168);
    pdf.setFont('helvetica', 'bold');
    pdf.setFontSize(8);
    pdf.text(s.label, x + 3, y + 5);
    pdf.setTextColor(s.color === 239 ? 220 : s.color, s.color === 22 ? 163 : s.color === 239 ? 68 : 31, s.color === 239 ? 68 : 168);
    pdf.setFontSize(11);
    pdf.text(s.value, x + 3, y + 12);
    pdf.setTextColor(100, 100, 100);
    pdf.setFont('helvetica', 'normal');
    pdf.setFontSize(7);
    pdf.text(s.sub, x + 3, y + 15.5);
  });
  y += cardH + 8;


  // Table header
  const cols = [margin, margin + 30, margin + 62, margin + 120];
  const labels = ['Date', 'Amount', 'Tenant', 'Method'];
  pdf.setFillColor(243, 244, 246);
  pdf.rect(margin, y, pw - margin * 2, 7, 'F');
  pdf.setFontSize(8);
  pdf.setFont('helvetica', 'bold');
  pdf.setTextColor(55, 65, 81);
  labels.forEach((l, i) => pdf.text(l, cols[i] + 2, y + 5));
  y += 9;

  pdf.setFont('helvetica', 'normal');
  pdf.setTextColor(0, 0, 0);
  const rowH = 7;

  rows.forEach((r, idx) => {
    if (y + rowH > ph - 18) {
      pdf.addPage();
      y = margin;
    }
    if (idx % 2 === 1) {
      pdf.setFillColor(249, 250, 251);
      pdf.rect(margin, y, pw - margin * 2, rowH, 'F');
    }
    const d = new Date(r.created_at).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' });
    pdf.setFontSize(7.5);
    pdf.text(d, cols[0] + 2, y + 5);
    pdf.setFont('helvetica', 'bold');
    pdf.text(formatUGX(Number(r.amount || 0)), cols[1] + 2, y + 5);
    pdf.setFont('helvetica', 'normal');
    const tenantName = (r.tenant_id && tenantMap.get(r.tenant_id)) || '—';
    pdf.text(tenantName.substring(0, 28), cols[2] + 2, y + 5);
    pdf.text((r.payment_method || '—').substring(0, 20), cols[3] + 2, y + 5);
    y += rowH;
  });

  // Footer on each page
  const pageCount = pdf.getNumberOfPages();
  for (let p = 1; p <= pageCount; p++) {
    pdf.setPage(p);
    pdf.setDrawColor(220, 220, 220);
    pdf.line(margin, ph - 12, pw - margin, ph - 12);
    pdf.setFontSize(7.5);
    pdf.setTextColor(120, 120, 120);
    pdf.text('Welile — official rent collections report', margin, ph - 7);
    pdf.text(`Page ${p} of ${pageCount}`, pw - margin, ph - 7, { align: 'right' });
  }

  const blob = pdf.output('blob');
  archivePdfBlob(blob, {
    label: `Rent Collections — ${label}`,
    filename: `welile-rent-collections-${range}-${Date.now()}.pdf`,
    category: 'other',
  }).catch(() => {});
  return blob;
}

export async function downloadAgentRentCollectionsPdf(params: {
  agentId: string;
  agentName: string;
  range: RangeKey;
}): Promise<number> {
  const blob = await generateAgentRentCollectionsPdf(params);
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `welile-rent-collections-${params.range}-${new Date().toISOString().split('T')[0]}.pdf`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return 0;
}