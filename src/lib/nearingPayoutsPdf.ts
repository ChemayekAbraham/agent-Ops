import { formatUGX } from '@/lib/rentCalculations';
import { supabase } from '@/integrations/supabase/client';
import welileLogoUrl from '@/assets/welile-logo.png';

export interface NearingPayoutPdfRow {
  investorId?: string;
  portfolioId?: string;
  portfolioCode?: string;
  name: string;
  portfolioName: string;
  phone: string;
  email: string;
  investmentAmount: number;
  roiPercentage: number;
  roiMode: string;
  daysUntil: number;
  nextPayoutDate: string; // YYYY-MM-DD
  createdAt: string;
  durationMonths?: number;
  maturityDate?: string | null;
  nextRoiDate?: string | null;
  status?: string;
  payoutDay?: number;
  autoReinvest?: boolean;
}

export interface NearingPayoutPdfInput {
  /** Human-readable label for the active filter ("Overdue", "Today", "≤ 7 days"…). */
  filterLabel: string;
  /** Free-text search the user had applied, if any. */
  searchQuery?: string;
  /** Total portfolios in the unfiltered list (for context in the summary line). */
  totalCount: number;
  rows: NearingPayoutPdfRow[];
  generatedAt?: Date;
}

const fmtDate = (iso: string) => {
  if (!iso) return '—';
  const d = iso.length === 10 ? new Date(iso + 'T00:00:00') : new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
};

// Format an ISO date (YYYY-MM-DD) as "{day}/{Month}/{Year}" e.g. "2/June/2026".
const dueDateLabel = (iso: string) => {
  if (!iso) return '—';
  const d = iso.length === 10 ? new Date(iso + 'T00:00:00') : new Date(iso);
  if (isNaN(d.getTime())) return iso;
  const month = d.toLocaleDateString('en-GB', { month: 'long' });
  return `${d.getDate()}/${month}/${d.getFullYear()}`;
};

const dueLabel = (d: number, iso: string) => {
  if (d === 0) return 'Due today';
  // Every other case (overdue or upcoming) shows the exact payout date.
  return dueDateLabel(iso);
};

// Human-readable portfolio lifecycle status (active / matured / paused …).
const statusLabel = (s?: string | null) => {
  if (!s) return '—';
  return String(s)
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
};

// Welile theme primary (HSL 271 100% 40% → RGB ≈ 102, 0, 204)
const THEME_PRIMARY: [number, number, number] = [146, 52, 234];
const THEME_PRIMARY_DARK: [number, number, number] = [108, 33, 196];
const THEME_STRIPE: [number, number, number] = [245, 240, 252];

const COMPANY_NAME = 'Welile Technologies Limited';
const COMPANY_ADDRESS = 'Plot 24, Kampala Road, Kampala, Uganda';
const COMPANY_CONTACT = 'info@welile.com  |  +256 700 000 000  |  www.welile.com';

async function loadLogoBase64(): Promise<string | null> {
  try {
    const res = await fetch(welileLogoUrl);
    const blob = await res.blob();
    return new Promise((resolve) => {
      const reader = new FileReader();
      reader.onloadend = () => resolve(reader.result as string);
      reader.onerror = () => resolve(null);
      reader.readAsDataURL(blob);
    });
  } catch {
    return null;
  }
}

interface PayoutDetail {
  mode: 'mobile_money' | 'bank_transfer' | 'cash';
  line1: string;
  line2: string;
  /** Registered account / mobile-money holder name. */
  name?: string;
}

async function fetchPayoutMethodsMap(userIds: string[]): Promise<Map<string, PayoutDetail>> {
  const map = new Map<string, PayoutDetail>();
  if (userIds.length === 0) return map;
  const unique = Array.from(new Set(userIds));
  const { data, error } = await supabase
    .from('saved_payout_methods' as never)
    .select('user_id, payout_mode, momo_provider, momo_number, momo_name, bank_name, bank_account_name, bank_account_number, is_default, last_used_at')
    .in('user_id', unique);
  if (error || !data) return map;
  // Pick default first, then most recently used per user.
  const grouped = new Map<string, any[]>();
  for (const row of data as any[]) {
    const arr = grouped.get(row.user_id) || [];
    arr.push(row);
    grouped.set(row.user_id, arr);
  }
  for (const [uid, rows] of grouped) {
    rows.sort((a, b) => {
      if (a.is_default && !b.is_default) return -1;
      if (!a.is_default && b.is_default) return 1;
      const at = a.last_used_at ? new Date(a.last_used_at).getTime() : 0;
      const bt = b.last_used_at ? new Date(b.last_used_at).getTime() : 0;
      return bt - at;
    });
    const r = rows[0];
    if (r.payout_mode === 'bank_transfer') {
      map.set(uid, {
        mode: 'bank_transfer',
        line1: `BANK: ${r.bank_name || '—'}`,
        line2: `${r.bank_account_name || '—'}\nA/C ${r.bank_account_number || '—'}`,
        name: r.bank_account_name || undefined,
      });
    } else if (r.payout_mode === 'mobile_money') {
      map.set(uid, {
        mode: 'mobile_money',
        line1: `${(r.momo_provider || 'MoMo').toUpperCase()} MOBILE MONEY`,
        line2: `${r.momo_name || '—'}\n${r.momo_number || '—'}`,
        name: r.momo_name || undefined,
      });
    } else {
      map.set(uid, { mode: 'cash', line1: 'CASH PICKUP', line2: '—' });
    }
  }
  return map;
}

// Fetch full DB record for a portfolio (catches any field not in the row payload)
async function fetchPortfolioDetailsMap(portfolioIds: string[]): Promise<Map<string, any>> {
  const map = new Map<string, any>();
  if (portfolioIds.length === 0) return map;
  const unique = Array.from(new Set(portfolioIds));
  const { data } = await supabase
    .from('investor_portfolios')
    .select('id, portfolio_code, account_name, investment_amount, roi_percentage, roi_mode, status, duration_months, maturity_date, next_roi_date, payout_day, auto_reinvest, payment_method, mobile_network, mobile_money_number, bank_name, bank_account_name, account_number, display_currency, created_at, total_roi_earned, investor_id, agent_id')
    .in('id', unique);
  (data || []).forEach((p: any) => map.set(p.id, p));
  return map;
}

// Fetch edit-history rows from audit_logs for these portfolios
/**
 * Build a CFO-style PDF report of portfolios nearing payout, honouring the
 * filter that was active in the Nearing Payouts dialog. The first column is
 * a "Returns Due" computed from principal × ROI%.
 */
export async function generateNearingPayoutsPdf(input: NearingPayoutPdfInput): Promise<Blob> {
  const { default: jsPDF } = await import('jspdf');
  const autoTableMod: any = await import('jspdf-autotable');
  const autoTable = autoTableMod.default || autoTableMod;

  const generatedAt = input.generatedAt || new Date();
  const doc = new jsPDF({ unit: 'mm', format: 'a4', orientation: 'landscape' });
  const pageWidth = doc.internal.pageSize.getWidth();
  const margin = 12;

  // Include ALL portfolios — compounding ones are listed too, but flagged in
  // the "Due" column as "Compounding" (they reinvest instead of cashing out).
  const rows = input.rows;

  // Fetch payment methods + fresh portfolio details in parallel with logo.
  // (Edit history / appendix removed — the export is the nearing-payout list only.)
  const investorIds = rows.map((r) => r.investorId).filter((v): v is string => !!v);
  const portfolioIds = rows.map((r) => r.portfolioId).filter((v): v is string => !!v);
  const [logoBase64, payoutMap, detailsMap] = await Promise.all([
    loadLogoBase64(),
    fetchPayoutMethodsMap(investorIds),
    fetchPortfolioDetailsMap(portfolioIds),
  ]);

  // Effective ROI mode prefers the fresh DB record over the (possibly stale)
  // row payload, mirroring the per-row logic used in the table body below.
  const isCompounding = (r: NearingPayoutPdfRow) => {
    const det = r.portfolioId ? detailsMap.get(r.portfolioId) : null;
    return (det?.roi_mode ?? r.roiMode) === 'monthly_compounding';
  };
  // Cash-payout rows only — used for monetary + overdue/today totals, since
  // compounding portfolios do not receive a cash payout.
  const payoutRows = rows.filter((r) => !isCompounding(r));
  const compoundingCount = rows.length - payoutRows.length;

  // ── Themed Header Band ──
  doc.setFillColor(...THEME_PRIMARY);
  doc.rect(0, 0, pageWidth, 26, 'F');
  // Subtle darker accent stripe
  doc.setFillColor(...THEME_PRIMARY_DARK);
  doc.rect(0, 26, pageWidth, 1.2, 'F');

  if (logoBase64) {
    try { doc.addImage(logoBase64, 'PNG', margin, 5, 16, 16); } catch { /* ignore */ }
  }

  const textX = margin + 20;
  doc.setTextColor(255, 255, 255);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(13);
  doc.text(COMPANY_NAME, textX, 11);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8);
  doc.text(COMPANY_ADDRESS, textX, 16);
  doc.text(COMPANY_CONTACT, textX, 20);

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(11);
  doc.text('Portfolios Nearing Payout', pageWidth - margin, 11, { align: 'right' });
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8);
  doc.text(`Generated: ${generatedAt.toLocaleString('en-GB')}`, pageWidth - margin, 16, { align: 'right' });
  doc.text('COO / Partner Ops · Confidential', pageWidth - margin, 20, { align: 'right' });

  // Summary line
  doc.setTextColor(15, 23, 42);
  let y = 34;
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(11);
  doc.text(`Filter: ${input.filterLabel}`, margin, y);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9);
  y += 5;
  doc.setTextColor(71, 85, 105);
  const parts = [
    `${rows.length} of ${input.totalCount} portfolios`,
    compoundingCount > 0 ? `${compoundingCount} compounding` : null,
    input.searchQuery ? `Search: "${input.searchQuery}"` : null,
  ].filter(Boolean) as string[];
  doc.text(parts.join('   ·   '), margin, y);

  // Aggregate totals — cash figures cover payout rows only.
  const totalPrincipal = payoutRows.reduce((s, r) => s + (r.investmentAmount || 0), 0);
  const totalReturns = payoutRows.reduce(
    (s, r) => s + Math.round((r.investmentAmount || 0) * (r.roiPercentage || 0) / 100),
    0,
  );
  const overdueCount = payoutRows.filter((r) => r.daysUntil < 0).length;
  const todayCount = payoutRows.filter((r) => r.daysUntil === 0).length;

  y += 6;
  doc.setTextColor(15, 23, 42);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(9);
  doc.text(
    `Principal: ${formatUGX(totalPrincipal)}   ·   Returns Due: ${formatUGX(totalReturns)}   ·   Overdue: ${overdueCount}   ·   Due Today: ${todayCount}`,
    margin,
    y,
  );

  // Empty-state guard
  if (rows.length === 0) {
    y += 14;
    doc.setFont('helvetica', 'italic');
    doc.setTextColor(100, 116, 139);
    doc.text('No portfolios match the current filter.', margin, y);
    return doc.output('blob');
  }

  // Resolve the destination institution for grouping: the exact bank name
  // (e.g. "Equity Bank") or the mobile-money network (e.g. "MTN Mobile Money").
  const groupLabelFor = (r: NearingPayoutPdfRow): string => {
    if (isCompounding(r)) return 'Compounding — reinvesting (no payout)';
    const det = r.portfolioId ? detailsMap.get(r.portfolioId) : null;
    const pm = r.investorId ? payoutMap.get(r.investorId) : undefined;
    const method = det?.payment_method || pm?.mode;
    if (method === 'bank_transfer') {
      const bank = det?.bank_name || (pm?.line1 || '').replace(/^BANK:\s*/i, '');
      return bank && bank !== '—' ? String(bank) : 'Bank — not specified';
    }
    if (method === 'mobile_money') {
      const net = det?.mobile_network || (pm?.line1 || '').replace(/\s*MOBILE MONEY$/i, '');
      return `${(net || 'MoMo').toString().toUpperCase()} Mobile Money`;
    }
    if (method === 'cash') return 'Cash pickup';
    return 'Payout method not set';
  };

  // Sort within each destination group: due today → upcoming → overdue.
  const dueSort = (a: NearingPayoutPdfRow, b: NearingPayoutPdfRow) => {
    const bucket = (d: number) => (d === 0 ? 0 : d > 0 ? 1 : 2);
    const ba = bucket(a.daysUntil), bb = bucket(b.daysUntil);
    if (ba !== bb) return ba - bb;
    if (ba === 1) return a.daysUntil - b.daysUntil;   // 1d, 2d, 3d…
    if (ba === 2) return b.daysUntil - a.daysUntil;   // -1, -2, -3…
    return 0;
  };

  // Build ordered groups: payout destinations (A→Z) first, compounding last.
  const groups = new Map<string, NearingPayoutPdfRow[]>();
  for (const r of rows) {
    const key = groupLabelFor(r);
    const arr = groups.get(key) || [];
    arr.push(r);
    groups.set(key, arr);
  }
  const COMPOUNDING_KEY = 'Compounding — reinvesting (no payout)';
  const orderedGroups = Array.from(groups.entries()).sort((a, b) => {
    const ca = a[0] === COMPOUNDING_KEY ? 1 : 0;
    const cb = b[0] === COMPOUNDING_KEY ? 1 : 0;
    if (ca !== cb) return ca - cb;
    return a[0].localeCompare(b[0]);
  });
  orderedGroups.forEach(([, arr]) => arr.sort(dueSort));

  // Body table — only the columns the COO needs for nearing payouts.
  const head = [[
    '#', 'Partner', 'Returns Due', 'Due', 'Payment Details',
  ]];
  const buildRow = (r: NearingPayoutPdfRow, idx: number) => {
    // Prefer FRESH database values over the row payload supplied by the
    // caller — the caller's `rows` can be stale if the operator edited a
    // portfolio between opening the dialog and exporting the PDF.
    const det = r.portfolioId ? detailsMap.get(r.portfolioId) : null;
    const principal = det?.investment_amount ?? r.investmentAmount ?? 0;
    const roiPct = det?.roi_percentage ?? r.roiPercentage ?? 0;
    const roiMode = det?.roi_mode ?? r.roiMode;
    const compounding = roiMode === 'monthly_compounding';
    const returnsDue = Math.round(principal * roiPct / 100);
    const pm = r.investorId ? payoutMap.get(r.investorId) : undefined;
    // Prefer per-portfolio payout details on the portfolio record itself —
    // an edit on the portfolio's account/MoMo fields must show up here.
    let paymentCell: string;
    if (compounding) {
      // Compounding portfolios receive no cash payout — never disclose any
      // bank / mobile-money destination for them on this export.
      paymentCell = '--';
    } else if (det?.payment_method === 'bank_transfer') {
      paymentCell = `BANK: ${det.bank_name || '—'}\nName: ${det.bank_account_name || '—'}\nA/C: ${det.account_number || '—'}`;
    } else if (det?.payment_method === 'mobile_money') {
      // The "name the mobile money shows" is stored on the portfolio's
      // bank_account_name field (reused as the registered account name for
      // both modes); fall back to the saved payout method's MoMo name.
      const momoName = det.bank_account_name || pm?.name || 'Name not set';
      paymentCell = `${(det.mobile_network || 'MoMo').toUpperCase()} MOBILE MONEY\nName: ${momoName}\nNo: ${det.mobile_money_number || '—'}`;
    } else if (det?.payment_method === 'cash') {
      paymentCell = 'CASH PICKUP\n—';
    } else if (pm) {
      // pm.line2 = "<name>\n<number>" — prefix with explicit labels.
      paymentCell = pm.name
        ? `${pm.line1}\nName: ${pm.name}\nNo: ${pm.line2.split('\n').slice(1).join(' ') || '—'}`
        : `${pm.line1}\n${pm.line2}`;
    } else {
      paymentCell = 'Not set\nAdd payout method';
    }
    return [
      String(idx + 1),
      r.name || '—',
      formatUGX(returnsDue),
      compounding ? 'Compounding' : dueLabel(r.daysUntil, r.nextPayoutDate ?? det?.next_roi_date ?? r.nextRoiDate ?? ''),
      paymentCell,
    ];
  };

  // Flatten into a table body with a full-width header row per destination.
  const body: any[] = [];
  let rowNo = 0;
  for (const [label, groupRows] of orderedGroups) {
    const groupTotal = groupRows.reduce((s, r) => {
      const det = r.portfolioId ? detailsMap.get(r.portfolioId) : null;
      const principal = det?.investment_amount ?? r.investmentAmount ?? 0;
      const roiPct = det?.roi_percentage ?? r.roiPercentage ?? 0;
      return s + Math.round(principal * roiPct / 100);
    }, 0);
    body.push([
      {
        content: `${label.toUpperCase()}   ·   ${groupRows.length} portfolio${groupRows.length === 1 ? '' : 's'}   ·   Returns Due: ${formatUGX(groupTotal)}`,
        colSpan: 5,
        styles: {
          fillColor: THEME_PRIMARY_DARK,
          textColor: 255,
          fontStyle: 'bold',
          fontSize: 8,
          halign: 'left',
          cellPadding: 2,
        },
      },
    ]);
    for (const r of groupRows) {
      rowNo += 1;
      body.push(buildRow(r, rowNo - 1));
    }
  }

  autoTable(doc, {
    head,
    body,
    startY: y + 6,
    margin: { left: margin, right: margin },
    tableWidth: pageWidth - margin * 2,
    styles: { fontSize: 7.5, cellPadding: 1.8, overflow: 'linebreak', valign: 'middle' },
    headStyles: { fillColor: THEME_PRIMARY, textColor: 255, fontSize: 7.5, halign: 'left', fontStyle: 'bold' },
    alternateRowStyles: { fillColor: THEME_STRIPE },
    columnStyles: {
      0: { cellWidth: 10, halign: 'right' },
      1: { cellWidth: 60 },
      2: { halign: 'right', fontStyle: 'bold', cellWidth: 42 },
      3: { halign: 'center', cellWidth: 35 },
      4: { cellWidth: 'auto' },
    },
    didParseCell: (data: any) => {
      // Highlight overdue / due-today rows in the Due column.
      if (data.section === 'body' && data.column.index === 3) {
        const status = String(data.cell.raw || '');
        if (status === 'Compounding') {
          // Reinvesting — flag in the brand purple, not a cash-due colour.
          data.cell.styles.textColor = [...THEME_PRIMARY_DARK];
          data.cell.styles.fontStyle = 'bold';
        } else if (status === 'Due today') {
          data.cell.styles.textColor = [180, 83, 9];
          data.cell.styles.fontStyle = 'bold';
        } else if (/^\d{1,2}\/[A-Za-z]+\/\d{4}$/.test(status)) {
          // Overdue rows render as the payout date "{day}/{Month}/{Year}".
          data.cell.styles.textColor = [220, 38, 38];
          data.cell.styles.fontStyle = 'bold';
        }
      }
      // Subtle warning for missing payment methods
      if (data.section === 'body' && data.column.index === 4) {
        const v = String(data.cell.raw || '');
        if (v.startsWith('Not set')) {
          data.cell.styles.textColor = [180, 83, 9];
          data.cell.styles.fontStyle = 'italic';
        }
      }
    },
    didDrawPage: () => {
      const ph = doc.internal.pageSize.getHeight();
      const pageCount = (doc as any).internal.getNumberOfPages();
      const current = (doc as any).internal.getCurrentPageInfo().pageNumber;
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(7.5);
      doc.setTextColor(100, 116, 139);
      doc.text(
        `Welile · Nearing Payouts · ${generatedAt.toLocaleDateString('en-GB')}`,
        margin,
        ph - 6,
      );
      doc.text(`Page ${current} of ${pageCount}`, pageWidth - margin, ph - 6, { align: 'right' });
    },
  });

  // ── Summary: amount to be paid per channel ──
  const returnsFor = (r: NearingPayoutPdfRow) => {
    const det = r.portfolioId ? detailsMap.get(r.portfolioId) : null;
    const principal = det?.investment_amount ?? r.investmentAmount ?? 0;
    const roiPct = det?.roi_percentage ?? r.roiPercentage ?? 0;
    return Math.round(principal * roiPct / 100);
  };

  const summaryRows = orderedGroups
    .filter(([label]) => label !== COMPOUNDING_KEY)
    .map(([label, groupRows]) => [
      label,
      String(groupRows.length),
      formatUGX(groupRows.reduce((s, r) => s + returnsFor(r), 0)),
    ]);

  if (summaryRows.length > 0) {
    const grandCount = payoutRows.length;
    const grandAmount = payoutRows.reduce((s, r) => s + returnsFor(r), 0);
    const prevY = (doc as any).lastAutoTable?.finalY ?? y;
    let summaryStartY = prevY + 10;
    const pageHeight = doc.internal.pageSize.getHeight();
    if (summaryStartY + 30 > pageHeight - 14) {
      doc.addPage();
      summaryStartY = 20;
    }
    doc.setTextColor(15, 23, 42);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(10);
    doc.text('Summary — Amount To Be Paid By Channel', margin, summaryStartY);

    autoTable(doc, {
      head: [['Channel', 'Count', 'Amount']],
      body: summaryRows,
      foot: [['TOTAL', String(grandCount), formatUGX(grandAmount)]],
      startY: summaryStartY + 4,
      margin: { left: margin, right: margin },
      tableWidth: pageWidth * 0.6,
      styles: { fontSize: 8, cellPadding: 2, overflow: 'linebreak', valign: 'middle' },
      headStyles: { fillColor: THEME_PRIMARY, textColor: 255, fontSize: 8, fontStyle: 'bold' },
      footStyles: { fillColor: THEME_PRIMARY_DARK, textColor: 255, fontSize: 8, fontStyle: 'bold' },
      alternateRowStyles: { fillColor: THEME_STRIPE },
      columnStyles: {
        0: { cellWidth: 'auto' },
        1: { cellWidth: 22, halign: 'center' },
        2: { cellWidth: 45, halign: 'right', fontStyle: 'bold' },
      },
    });
  }

  return doc.output('blob');
}

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);

  // Bulk export of all partners nearing payout -- many rows of financial
  // data at once, not logged before this. Plain client-side insert so the
  // audit_logs IP-capture trigger sees the real browser IP directly. Never
  // blocks the actual download.
  (async () => {
    try {
      const { data: { user } } = await supabase.auth.getUser();
      await supabase.from('audit_logs').insert({
        user_id: user?.id ?? null,
        action_type: 'pdf_report_exported',
        table_name: 'export',
        record_id: null,
        metadata: { filename },
      });
    } catch (e) {
      console.warn('[nearingPayoutsPdf] audit log insert failed:', e);
    }
  })();
}