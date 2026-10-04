import { supabase } from '@/integrations/supabase/client';
import { formatUGX } from '@/lib/rentCalculations';
import { format, subDays, startOfDay } from 'date-fns';
import { CATEGORY_DESCRIPTIONS } from '@/lib/ledgerConstants';

interface CategoryEntry {
  id: string;
  amount: number;
  direction: string;
  category: string;
  description: string | null;
  account: string | null;
  classification: string | null;
  transaction_date: string;
  reference_id: string | null;
  user_id: string | null;
  linked_party: string | null;
}

interface PartyMap {
  [userId: string]: { name: string; phone?: string | null };
}

function fmtDate(d: string | Date | null | undefined): string {
  if (!d) return '—';
  return new Date(d).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}

function fmtDateTime(d: string | Date | null | undefined): string {
  if (!d) return '—';
  return new Date(d).toLocaleString('en-GB', {
    day: '2-digit', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

function safeName(name: string): string {
  return name.replace(/[^a-z0-9-_]+/gi, '_').slice(0, 60);
}

function formatLabel(cat: string): string {
  return cat.split('_').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

async function fetchPartyNames(userIds: string[]): Promise<PartyMap> {
  const ids = Array.from(new Set(userIds.filter(Boolean)));
  if (ids.length === 0) return {};
  const { data } = await supabase
    .from('profiles')
    .select('id, full_name, phone_number')
    .in('id', ids);
  const map: PartyMap = {};
  (data || []).forEach((p: any) => {
    map[p.id] = { name: p.full_name || '—', phone: p.phone_number };
  });
  return map;
}

async function fetchCategoryEntries(category: string, days = 30): Promise<CategoryEntry[]> {
  const startDate = startOfDay(subDays(new Date(), days - 1)).toISOString();
  const { data, error } = await supabase
    .from('general_ledger')
    .select('id, amount, direction, category, description, account, classification, transaction_date, reference_id, user_id, linked_party')
    .eq('category', category)
    .eq('ledger_scope', 'platform')
    .gte('transaction_date', startDate)
    .order('transaction_date', { ascending: false })
    .limit(2000);
  if (error) throw error;
  return (data || []) as CategoryEntry[];
}

/** Returns all-time {count, total} for a category — covers full history since launch. */
async function fetchAllTimeTotal(category: string): Promise<{ count: number; total: number }> {
  const { data, error } = await supabase
    .from('general_ledger')
    .select('amount')
    .eq('category', category)
    .eq('ledger_scope', 'platform')
    .limit(50000);
  if (error || !data) return { count: 0, total: 0 };
  return {
    count: data.length,
    total: data.reduce((s: number, r: any) => s + Number(r.amount || 0), 0),
  };
}

function drawHeader(doc: any, pageWidth: number, margin: number, title: string, subtitle: string) {
  doc.setFillColor(146, 52, 234);
  doc.rect(0, 0, pageWidth, 22, 'F');
  doc.setTextColor(255, 255, 255);
  doc.setFontSize(14);
  doc.setFont('helvetica', 'bold');
  doc.text('WELILE', margin, 10);
  doc.setFontSize(10);
  doc.setFont('helvetica', 'normal');
  doc.text(title, margin, 16);
  doc.setFontSize(8);
  doc.text(`Generated: ${new Date().toLocaleString('en-GB')}`, pageWidth - margin, 10, { align: 'right' });
  doc.text(subtitle, pageWidth - margin, 16, { align: 'right' });
  doc.setTextColor(0, 0, 0);
}

function drawFooter(doc: any, auditRef: string) {
  const pageCount = doc.getNumberOfPages();
  const pageWidth = doc.internal.pageSize.getWidth();
  const pageHeight = doc.internal.pageSize.getHeight();
  for (let i = 1; i <= pageCount; i++) {
    doc.setPage(i);
    doc.setFontSize(7);
    doc.setTextColor(100);
    doc.text(`Audit Ref: ${auditRef}`, 14, pageHeight - 6);
    doc.text(`Page ${i} of ${pageCount}`, pageWidth - 14, pageHeight - 6, { align: 'right' });
  }
  doc.setTextColor(0, 0, 0);
}

async function logExport(category: string, type: string) {
  try {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return;
    await supabase.from('audit_logs').insert({
      user_id: user.id,
      action_type: 'cfo_category_report_export',
      record_id: category,
      record_type: type,
      metadata: { category, type, exported_at: new Date().toISOString() },
    } as any);
  } catch (e) {
    console.warn('Audit log failed', e);
  }
}

async function buildCategorySection(
  doc: any,
  autoTable: any,
  category: string,
  label: string,
  entries: CategoryEntry[],
  partyMap: PartyMap,
  margin: number,
  startY: number,
): Promise<number> {
  const pageWidth = doc.internal.pageSize.getWidth();
  let y = startY;

  // Section title
  doc.setFontSize(12);
  doc.setFont('helvetica', 'bold');
  doc.text(label, margin, y);
  y += 5;

  // Summary
  const total = entries.reduce((s, e) => s + Number(e.amount || 0), 0);
  const count = entries.length;
  const avg = count > 0 ? total / 30 : 0;
  const counterCounts: Record<string, number> = {};
  entries.forEach(e => {
    const id = e.linked_party || e.user_id || '';
    if (id) counterCounts[id] = (counterCounts[id] || 0) + Number(e.amount || 0);
  });
  const topCounter = Object.entries(counterCounts).sort((a, b) => b[1] - a[1])[0];
  const topName = topCounter ? (partyMap[topCounter[0]]?.name || topCounter[0].slice(0, 8)) : '—';

  autoTable(doc, {
    startY: y,
    head: [['Metric', 'Value']],
    body: [
      ['Total Amount', formatUGX(total)],
      ['Entry Count', String(count)],
      ['Daily Average (30d)', formatUGX(avg)],
      ['Top Counterparty', `${topName} (${topCounter ? formatUGX(topCounter[1]) : '—'})`],
    ],
    theme: 'striped',
    styles: { fontSize: 8 },
    headStyles: { fillColor: [30, 41, 59], textColor: 255 },
    margin: { left: margin, right: margin },
  });
  y = (doc as any).lastAutoTable.finalY + 6;

  // Daily trend
  const daily: Record<string, { count: number; total: number }> = {};
  entries.forEach(e => {
    const d = e.transaction_date?.slice(0, 10) || 'unknown';
    if (!daily[d]) daily[d] = { count: 0, total: 0 };
    daily[d].count++;
    daily[d].total += Number(e.amount || 0);
  });
  const dailyRows = Object.entries(daily)
    .sort((a, b) => b[0].localeCompare(a[0]))
    .map(([d, v]) => [fmtDate(d), String(v.count), formatUGX(v.total)]);

  if (dailyRows.length > 0) {
    doc.setFontSize(9);
    doc.setFont('helvetica', 'bold');
    doc.text('Daily Trend', margin, y);
    y += 3;
    autoTable(doc, {
      startY: y,
      head: [['Date', 'Entries', 'Daily Total']],
      body: dailyRows,
      theme: 'grid',
      styles: { fontSize: 7 },
      headStyles: { fillColor: [51, 65, 85], textColor: 255 },
      margin: { left: margin, right: margin },
    });
    y = (doc as any).lastAutoTable.finalY + 6;
  }

  // Detailed transactions
  if (entries.length > 0) {
    doc.setFontSize(9);
    doc.setFont('helvetica', 'bold');
    doc.text(`Detailed Transactions (${entries.length})`, margin, y);
    y += 3;
    const txRows = entries.map(e => {
      const partyId = e.linked_party || e.user_id || '';
      const party = partyMap[partyId];
      return [
        fmtDateTime(e.transaction_date),
        e.reference_id ? e.reference_id.slice(0, 12) : '—',
        e.direction || '—',
        formatUGX(Number(e.amount || 0)),
        party?.name?.slice(0, 22) || (partyId ? partyId.slice(0, 8) : '—'),
        (e.description || '—').slice(0, 40),
        e.account || '—',
        e.classification || '—',
      ];
    });
    autoTable(doc, {
      startY: y,
      head: [['Date', 'Ref', 'Dir', 'Amount', 'Party', 'Description', 'Account', 'Class']],
      body: txRows,
      theme: 'striped',
      styles: { fontSize: 6.5, cellPadding: 1.2 },
      headStyles: { fillColor: [30, 41, 59], textColor: 255, fontSize: 7 },
      columnStyles: {
        3: { halign: 'right' },
      },
      margin: { left: margin, right: margin },
    });
    y = (doc as any).lastAutoTable.finalY + 8;
  } else {
    doc.setFontSize(9);
    doc.setFont('helvetica', 'italic');
    doc.setTextColor(120);
    doc.text('No transactions in the last 30 days.', margin, y);
    doc.setTextColor(0, 0, 0);
    y += 8;
  }

  return y;
}

export async function exportCategoryReport(
  category: string,
  label: string,
  type: 'revenue' | 'expense',
): Promise<string> {
  const { default: jsPDF } = await import('jspdf');
  const autoTableMod: any = await import('jspdf-autotable');
  const autoTable = autoTableMod.default || autoTableMod;

  const [entries, allTime] = await Promise.all([
    fetchCategoryEntries(category),
    fetchAllTimeTotal(category),
  ]);
  const partyIds = entries.flatMap(e => [e.user_id, e.linked_party].filter(Boolean) as string[]);
  const partyMap = await fetchPartyNames(partyIds);

  const doc = new jsPDF({ unit: 'mm', format: 'a4' });
  const pageWidth = doc.internal.pageSize.getWidth();
  const margin = 14;
  const auditRef = `CAT-${category.toUpperCase()}-${Date.now().toString(36).toUpperCase()}`;

  drawHeader(doc, pageWidth, margin, `${type === 'revenue' ? 'Revenue' : 'Expense'} Category Report`, 'CFO Export — Confidential');

  let y = 30;
  doc.setFontSize(13);
  doc.setFont('helvetica', 'bold');
  doc.text(label, margin, y);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9);
  y += 5;
  doc.text(`Category code: ${category}`, margin, y);
  y += 4;
  doc.text(`Period: Last 30 days (${fmtDate(subDays(new Date(), 29))} – ${fmtDate(new Date())})`, margin, y);
  y += 4;
  doc.setFont('helvetica', 'bold');
  doc.text(`All-time: ${formatUGX(allTime.total)} across ${allTime.count} entries`, margin, y);
  doc.setFont('helvetica', 'normal');
  y += 6;

  // Plain-English description block
  const description = CATEGORY_DESCRIPTIONS[category];
  if (description) {
    doc.setFillColor(241, 245, 249);
    const descLines = doc.splitTextToSize(description, pageWidth - margin * 2 - 4);
    const boxH = 4 + descLines.length * 4;
    doc.rect(margin, y, pageWidth - margin * 2, boxH, 'F');
    doc.setFontSize(8);
    doc.setTextColor(51, 65, 85);
    doc.text(descLines, margin + 2, y + 4);
    doc.setTextColor(0, 0, 0);
    y += boxH + 4;
  }

  await buildCategorySection(doc, autoTable, category, label, entries, partyMap, margin, y);

  drawFooter(doc, auditRef);

  const filename = `${type}-${safeName(category)}-${format(new Date(), 'yyyy-MM-dd')}.pdf`;
  doc.save(filename);
  await logExport(category, type);
  return filename;
}

export async function exportAllCategoriesReport(
  categories: { category: string; label: string }[],
  type: 'revenue' | 'expense',
): Promise<string> {
  const { default: jsPDF } = await import('jspdf');
  const autoTableMod: any = await import('jspdf-autotable');
  const autoTable = autoTableMod.default || autoTableMod;

  const doc = new jsPDF({ unit: 'mm', format: 'a4' });
  const pageWidth = doc.internal.pageSize.getWidth();
  const margin = 14;
  const typeLabel = type === 'revenue' ? 'Revenue' : 'Expense';
  const auditRef = `ALL-${type.toUpperCase()}-${Date.now().toString(36).toUpperCase()}`;

  drawHeader(doc, pageWidth, margin, `All ${typeLabel} Categories — Detailed Report`, 'CFO Export — Confidential');

  let y = 30;
  doc.setFontSize(12);
  doc.setFont('helvetica', 'bold');
  doc.text(`${typeLabel} Categories (${categories.length})`, margin, y);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9);
  y += 5;
  doc.text(`Period: Last 30 days (${fmtDate(subDays(new Date(), 29))} – ${fmtDate(new Date())})`, margin, y);
  y += 8;

  // Fetch all entries + all-time totals up front (parallel)
  const allData = await Promise.all(
    categories.map(async c => {
      const [entries, allTime] = await Promise.all([
        fetchCategoryEntries(c.category),
        fetchAllTimeTotal(c.category),
      ]);
      return { ...c, entries, allTime };
    }),
  );

  const allPartyIds = allData.flatMap(d =>
    d.entries.flatMap(e => [e.user_id, e.linked_party].filter(Boolean) as string[]),
  );
  const partyMap = await fetchPartyNames(allPartyIds);

  // Overall summary — EVERY canonical category, with 30d + all-time side-by-side
  const grandTotal30d = allData.reduce((s, d) => s + d.entries.reduce((ss, e) => ss + Number(e.amount || 0), 0), 0);
  const grandTotalAllTime = allData.reduce((s, d) => s + d.allTime.total, 0);
  autoTable(doc, {
    startY: y,
    head: [['Category', '30d Entries', '30d Total', 'All-time Entries', 'All-time Total']],
    body: [
      ...allData.map(d => {
        const total30 = d.entries.reduce((s, e) => s + Number(e.amount || 0), 0);
        return [
          d.label,
          String(d.entries.length),
          total30 > 0 ? formatUGX(total30) : '— no activity —',
          String(d.allTime.count),
          formatUGX(d.allTime.total),
        ];
      }),
      [
        'GRAND TOTAL',
        String(allData.reduce((s, d) => s + d.entries.length, 0)),
        formatUGX(grandTotal30d),
        String(allData.reduce((s, d) => s + d.allTime.count, 0)),
        formatUGX(grandTotalAllTime),
      ],
    ],
    theme: 'striped',
    styles: { fontSize: 8 },
    headStyles: { fillColor: [30, 41, 59], textColor: 255 },
    margin: { left: margin, right: margin },
    columnStyles: { 1: { halign: 'right' }, 2: { halign: 'right' }, 3: { halign: 'right' }, 4: { halign: 'right' } },
  });
  y = (doc as any).lastAutoTable.finalY + 8;

  // Per-category sections
  for (const d of allData) {
    if (y > 240) {
      doc.addPage();
      y = 20;
    }
    // Per-section description block
    const description = CATEGORY_DESCRIPTIONS[d.category];
    if (description) {
      doc.setFillColor(241, 245, 249);
      const descLines = doc.splitTextToSize(`${d.label} — ${description}`, pageWidth - margin * 2 - 4);
      const boxH = 4 + descLines.length * 4;
      doc.rect(margin, y, pageWidth - margin * 2, boxH, 'F');
      doc.setFontSize(8);
      doc.setTextColor(51, 65, 85);
      doc.text(descLines, margin + 2, y + 4);
      doc.setTextColor(0, 0, 0);
      y += boxH + 3;
    }
    // All-time line
    doc.setFontSize(8);
    doc.setFont('helvetica', 'italic');
    doc.setTextColor(80);
    doc.text(`All-time total: ${formatUGX(d.allTime.total)} (${d.allTime.count} entries)`, margin, y);
    doc.setTextColor(0, 0, 0);
    doc.setFont('helvetica', 'normal');
    y += 5;
    y = await buildCategorySection(doc, autoTable, d.category, d.label, d.entries, partyMap, margin, y);
  }

  drawFooter(doc, auditRef);

  const filename = `all-${type}-categories-${format(new Date(), 'yyyy-MM-dd')}.pdf`;
  doc.save(filename);
  await logExport(`ALL_${type.toUpperCase()}`, type);
  return filename;
}
