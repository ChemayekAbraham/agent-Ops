import jsPDF from 'jspdf';
import { format } from 'date-fns';

export interface AgentProductsOnlyData {
  periodLabel: string;
  isRange: boolean;
  actor: string;
  bikes: {
    issued_total: number;
    total_value: number;
    paid: number;
    outstanding: number;
    rows: Array<{
      client_name: string | null;
      client_phone: string | null;
      item_name: string;
      value: number;
      paid: number;
      outstanding: number;
      order_status: string | null;
      issued_date: string | null;
    }>;
  };
  phones: {
    issued_total: number;
    total_value: number;
    paid: number;
    outstanding: number;
    rows: Array<{
      client_name: string | null;
      client_phone: string | null;
      item_name: string;
      quantity: number;
      value: number;
      paid: number;
      outstanding: number;
      order_status: string | null;
      issued_date: string | null;
    }>;
  };
  boutique: {
    in_field_items: number;
    in_field_amount: number;
    in_field_repaid: number;
    in_field_outstanding: number;
    breakdown: Array<{
      label: string;
      models: number;
      reference_price: number;
      issued_qty: number;
      issued_value: number;
      outstanding: number;
    }>;
    rows: Array<{
      full_name: string | null;
      phone: string | null;
      location_name: string | null;
      items_held: number;
      held_amount: number;
      repaid_amount: number;
      outstanding_amount: number;
      product_names: string[] | null;
    }>;
  };
  signages: {
    in_field_items: number;
    in_field_amount: number;
    in_field_repaid: number;
    in_field_outstanding: number;
    rows: Array<{
      full_name: string | null;
      phone: string | null;
      location_name: string | null;
      items_held: number;
      held_amount: number;
      repaid_amount: number;
      outstanding_amount: number;
      product_names: string[] | null;
    }>;
  };
  advances: {
    active_count: number;
    issued_count: number;
    submitted: number;
    approved: number;
    rejected: number;
    issued_value: number;
    recovered: number;
    outstanding: number;
    rows: Array<{
      agent_name: string;
      phone: string | null;
      principal: number;
      recovered: number;
      outstanding: number;
      status: string;
      issued_at: string | null;
    }>;
  };
  lendingAgents: {
    onboarded_count: number;
    active_loans_count: number;
    total_lent: number;
    total_repaid: number;
    outstanding: number;
    rows: Array<{
      full_name: string;
      phone: string | null;
      loans_count: number;
      total_lent: number;
      total_repaid: number;
      outstanding: number;
    }>;
  };
}

const ugx = (n: any) => `UGX ${Math.round(Number(n) || 0).toLocaleString()}`;
const num = (n: any) => Math.round(Number(n) || 0).toLocaleString();
const pct = (a: any, b: any) => {
  const an = Number(a) || 0;
  const bn = Number(b) || 0;
  if (bn <= 0) return '0.0%';
  return `${((an / bn) * 100).toFixed(1)}%`;
};
const day = (d?: string | null) => {
  if (!d) return '—';
  try {
    return format(new Date(d.length <= 10 ? `${d}T00:00:00` : d), 'dd MMM yyyy');
  } catch {
    return String(d);
  }
};

export function generateAgentProductsOnlyPdf(data: AgentProductsOnlyData): Blob {
  const doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' });
  const pageWidth = doc.internal.pageSize.getWidth();
  const pageHeight = doc.internal.pageSize.getHeight();
  const margin = 12;
  const contentWidth = pageWidth - margin * 2;
  const brand: [number, number, number] = [88, 28, 135]; // Welile Deep Purple #581c87
  let y = 14;

  const newPage = () => {
    doc.addPage();
    y = 16;
  };

  const ensure = (h: number) => {
    if (y + h > pageHeight - 14) newPage();
  };

  // Header band
  doc.setFillColor(brand[0], brand[1], brand[2]);
  doc.rect(0, 0, pageWidth, 24, 'F');
  doc.setTextColor(255, 255, 255);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(9);
  doc.text('WELILE AGENT OPERATIONS', margin, 9);
  doc.setFontSize(13);
  doc.text('AGENT PRODUCTS & SERVICES — EXECUTIVE PORTFOLIO REPORT', margin, 16.5);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8);
  doc.text(
    `Scope: Motor Bikes · Smart Phones · Boutique · Signages · Agent Advances · Lending Agents  |  ${data.periodLabel}`,
    margin,
    21.5
  );
  y = 30;

  doc.setTextColor(90, 90, 100);
  doc.setFontSize(7.5);
  doc.text('Strictly Agent Products & Services Portfolio — Internal Operations Report', margin, y);
  doc.text(`Generated: ${format(new Date(), 'dd MMM yyyy HH:mm')} (EAT)  ·  By: ${data.actor}`, pageWidth - margin, y, {
    align: 'right',
  });
  y += 6;

  const sectionTitle = (text: string, sub?: string) => {
    ensure(sub ? 12 : 8);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(9.5);
    doc.setTextColor(brand[0], brand[1], brand[2]);
    doc.text(text.toUpperCase(), margin, y);
    y += 4;
    if (sub) {
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(6.8);
      doc.setTextColor(125, 120, 138);
      doc.text(sub, margin, y);
      y += 3.5;
    }
    doc.setDrawColor(brand[0], brand[1], brand[2]);
    doc.line(margin, y, margin + contentWidth, y);
    y += 4;
  };

  const clip = (text: string, widthMm: number, size: number) => {
    const maxChars = Math.floor(widthMm / (size * 0.19));
    return text.length > maxChars ? `${text.slice(0, Math.max(1, maxChars - 1))}…` : text;
  };

  const drawKpiCards = (cards: { label: string; value: string; detail?: string }[], perRow = 4) => {
    if (!cards.length) return;
    const gap = 3;
    const cardW = (contentWidth - gap * (perRow - 1)) / perRow;
    const cardH = 17;
    for (let i = 0; i < cards.length; i += perRow) {
      const row = cards.slice(i, i + perRow);
      ensure(cardH + 2);
      row.forEach((c, idx) => {
        const x = margin + idx * (cardW + gap);
        doc.setFillColor(248, 246, 252);
        doc.setDrawColor(226, 220, 238);
        doc.roundedRect(x, y, cardW, cardH, 1.5, 1.5, 'FD');
        doc.setFillColor(brand[0], brand[1], brand[2]);
        doc.rect(x, y, 1.4, cardH, 'F');
        doc.setFont('helvetica', 'bold');
        doc.setFontSize(6.4);
        doc.setTextColor(110, 100, 125);
        doc.text(clip(c.label.toUpperCase(), cardW - 7, 6.4), x + 4, y + 4.8);
        doc.setFont('helvetica', 'bold');
        doc.setFontSize(10.5);
        doc.setTextColor(30, 30, 42);
        doc.text(clip(c.value, cardW - 7, 10.5), x + 4, y + 11);
        if (c.detail) {
          doc.setFont('helvetica', 'normal');
          doc.setFontSize(6.2);
          doc.setTextColor(120, 115, 130);
          doc.text(clip(c.detail, cardW - 7, 6.2), x + 4, y + 15);
        }
      });
      y += cardH + gap;
    }
    y += 2;
  };

  const drawTable = (
    tblTitle: string,
    head: string[],
    widthRatios: number[],
    body: (string | number)[][],
    aligns: ('left' | 'right')[] = []
  ) => {
    if (!body.length) return;
    const ratioTotal = widthRatios.reduce((a, b) => a + (b > 0 ? b : 0), 0) || 1;
    const widths = widthRatios.map((w) => ((w > 0 ? w : 0) / ratioTotal) * contentWidth);
    ensure(18);
    if (tblTitle) {
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(8);
      doc.setTextColor(70, 60, 90);
      doc.text(tblTitle, margin, y);
      y += 3;
    }
    const drawHead = () => {
      doc.setFillColor(brand[0], brand[1], brand[2]);
      doc.rect(margin, y, contentWidth, 6, 'F');
      doc.setTextColor(255, 255, 255);
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(7.5);
      let hx = margin + 2;
      head.forEach((h, i) => {
        const align = aligns[i] === 'right' ? 'right' : 'left';
        doc.text(h, align === 'right' ? hx + widths[i] - 4 : hx, y + 4, { align });
        hx += widths[i];
      });
      y += 6;
      doc.setFont('helvetica', 'normal');
      doc.setTextColor(35, 35, 45);
    };
    drawHead();
    body.forEach((r, idx) => {
      if (y + 5.6 > pageHeight - 14) {
        newPage();
        drawHead();
      }
      if (idx % 2 === 1) {
        doc.setFillColor(248, 248, 252);
        doc.rect(margin, y, contentWidth, 5.6, 'F');
      }
      let cx = margin + 2;
      r.forEach((c, i) => {
        const align = aligns[i] === 'right' ? 'right' : 'left';
        doc.setFontSize(7.4);
        doc.setTextColor(35, 35, 45);
        doc.text(clip(String(c ?? ''), widths[i] - 4, 7.4), align === 'right' ? cx + widths[i] - 4 : cx, y + 3.8, {
          align,
        });
        cx += widths[i];
      });
      y += 5.6;
    });
    y += 5;
  };

  // 1. CALCULATE TOP-LEVEL PORTFOLIO METRICS ACROSS THE 6 CATEGORIES
  const totalBikesValue = Number(data.bikes.total_value) || 0;
  const totalBikesPaid = Number(data.bikes.paid) || 0;
  const totalBikesOutstanding = Number(data.bikes.outstanding) || 0;

  const totalPhonesValue = Number(data.phones.total_value) || 0;
  const totalPhonesPaid = Number(data.phones.paid) || 0;
  const totalPhonesOutstanding = Number(data.phones.outstanding) || 0;

  const totalBoutiqueValue = Number(data.boutique.in_field_amount) || 0;
  const totalBoutiquePaid = Number(data.boutique.in_field_repaid) || 0;
  const totalBoutiqueOutstanding = Number(data.boutique.in_field_outstanding) || 0;

  const totalSignagesValue = Number(data.signages.in_field_amount) || 0;
  const totalSignagesPaid = Number(data.signages.in_field_repaid) || 0;
  const totalSignagesOutstanding = Number(data.signages.in_field_outstanding) || 0;

  const totalAdvancesValue = Number(data.advances.issued_value) || 0;
  const totalAdvancesPaid = Number(data.advances.recovered) || 0;
  const totalAdvancesOutstanding = Number(data.advances.outstanding) || 0;

  const totalLendingValue = Number(data.lendingAgents.total_lent) || 0;
  const totalLendingPaid = Number(data.lendingAgents.total_repaid) || 0;
  const totalLendingOutstanding = Number(data.lendingAgents.outstanding) || 0;

  const grandTotalIssuedValue =
    totalBikesValue +
    totalPhonesValue +
    totalBoutiqueValue +
    totalSignagesValue +
    totalAdvancesValue +
    totalLendingValue;

  const grandTotalRecovered =
    totalBikesPaid +
    totalPhonesPaid +
    totalBoutiquePaid +
    totalSignagesPaid +
    totalAdvancesPaid +
    totalLendingPaid;

  const grandTotalOutstanding =
    totalBikesOutstanding +
    totalPhonesOutstanding +
    totalBoutiqueOutstanding +
    totalSignagesOutstanding +
    totalAdvancesOutstanding +
    totalLendingOutstanding;

  const grandRecoveryRate = pct(grandTotalRecovered, grandTotalIssuedValue);

  // SECTION 1: EXECUTIVE PORTFOLIO SUMMARY
  sectionTitle(
    '1. Executive Portfolio Summary (Agent Products & Services Only)',
    'Consolidated performance across Motor Bikes, Smart Phones, Boutique, Signages, Advances & Lending Agents'
  );

  drawKpiCards(
    [
      {
        label: 'Total Portfolio Disbursed',
        value: ugx(grandTotalIssuedValue),
        detail: 'Cumulative value across all 6 product/service lines',
      },
      {
        label: 'Total Recovered / Repaid',
        value: ugx(grandTotalRecovered),
        detail: `Overall recovery rate: ${grandRecoveryRate}`,
      },
      {
        label: 'Total Outstanding Balance',
        value: ugx(grandTotalOutstanding),
        detail: 'Active field exposure across all agents',
      },
      {
        label: 'Active Facilities in Field',
        value: num(
          Number(data.bikes.issued_total || 0) +
            Number(data.phones.issued_total || 0) +
            Number(data.boutique.in_field_items || 0) +
            Number(data.signages.in_field_items || 0) +
            Number(data.advances.active_count || 0) +
            Number(data.lendingAgents.active_loans_count || 0)
        ),
        detail: 'Bikes, phones, items, advances & active peer loans',
      },
    ],
    4
  );

  // COMPARISON MATRIX TABLE OF THE 6 PILLARS
  const summaryTableHead = [
    'Category',
    'Scope / Core Function',
    'Units / Active',
    'Total Value',
    'Repaid / Recovered',
    'Outstanding Balance',
    'Recovery %',
  ];
  const summaryTableRatios = [35, 55, 25, 36, 36, 36, 20];
  const summaryTableAligns: ('left' | 'right')[] = ['left', 'left', 'right', 'right', 'right', 'right', 'right'];

  const summaryTableBody: (string | number)[][] = [
    [
      'Agent Motor Bikes',
      'Spiro electric bikes lease-to-own & deliveries',
      `${num(data.bikes.issued_total)} units`,
      ugx(totalBikesValue),
      ugx(totalBikesPaid),
      ugx(totalBikesOutstanding),
      pct(totalBikesPaid, totalBikesValue),
    ],
    [
      'Agent Smart Phones',
      'Device orders & financing installments',
      `${num(data.phones.issued_total)} units`,
      ugx(totalPhonesValue),
      ugx(totalPhonesPaid),
      ugx(totalPhonesOutstanding),
      pct(totalPhonesPaid, totalPhonesValue),
    ],
    [
      'Agent Boutique',
      'Branded merchandise sales & deductions',
      `${num(data.boutique.in_field_items)} items`,
      ugx(totalBoutiqueValue),
      ugx(totalBoutiquePaid),
      ugx(totalBoutiqueOutstanding),
      pct(totalBoutiquePaid, totalBoutiqueValue),
    ],
    [
      'Shop Signages',
      'Shop board production & agent contributions',
      `${num(data.signages.in_field_items)} signages`,
      ugx(totalSignagesValue),
      ugx(totalSignagesPaid),
      ugx(totalSignagesOutstanding),
      pct(totalSignagesPaid, totalSignagesValue),
    ],
    [
      'Agent Advances',
      'Emergency / operational advance facility',
      `${num(data.advances.active_count)} active (${num(data.advances.issued_count)} total)`,
      ugx(totalAdvancesValue),
      ugx(totalAdvancesPaid),
      ugx(totalAdvancesOutstanding),
      pct(totalAdvancesPaid, totalAdvancesValue),
    ],
    [
      'Welile Lending Agents',
      'Agent peer-to-peer micro-lending loan books',
      `${num(data.lendingAgents.active_loans_count)} loans (${num(data.lendingAgents.onboarded_count)} agents)`,
      ugx(totalLendingValue),
      ugx(totalLendingPaid),
      ugx(totalLendingOutstanding),
      pct(totalLendingPaid, totalLendingValue),
    ],
    [
      'TOTAL PORTFOLIO',
      'All 6 Agent Products & Services combined',
      '—',
      ugx(grandTotalIssuedValue),
      ugx(grandTotalRecovered),
      ugx(grandTotalOutstanding),
      grandRecoveryRate,
    ],
  ];

  drawTable('PORTFOLIO BREAKDOWN BY PRODUCT & SERVICE', summaryTableHead, summaryTableRatios, summaryTableBody, summaryTableAligns);

  // SECTION 2: MOTOR BIKES & SMART PHONES (ASSET FINANCING)
  ensure(40);
  sectionTitle(
    '2. Asset Financing: Agent Motor Bikes & Smart Phones',
    'Hardware asset distribution, lease contracts and ongoing balance recovery'
  );

  drawKpiCards(
    [
      { label: 'Bikes in Field', value: num(data.bikes.issued_total), detail: `Total value: ${ugx(totalBikesValue)}` },
      { label: 'Bikes Outstanding', value: ugx(totalBikesOutstanding), detail: `Recovered: ${ugx(totalBikesPaid)} (${pct(totalBikesPaid, totalBikesValue)})` },
      { label: 'Smartphones in Field', value: num(data.phones.issued_total), detail: `Total value: ${ugx(totalPhonesValue)}` },
      { label: 'Smartphones Outstanding', value: ugx(totalPhonesOutstanding), detail: `Recovered: ${ugx(totalPhonesPaid)} (${pct(totalPhonesPaid, totalPhonesValue)})` },
    ],
    4
  );

  // Motor bikes detail rows
  if (data.bikes.rows && data.bikes.rows.length > 0) {
    const bikeHead = ['Agent / Client', 'Phone', 'Bike Model', 'Order / Lease Status', 'Issued Date', 'Valuation', 'Recovered', 'Outstanding'];
    const bikeRatios = [35, 24, 30, 24, 22, 28, 28, 28];
    const bikeAligns: ('left' | 'right')[] = ['left', 'left', 'left', 'left', 'left', 'right', 'right', 'right'];
    const bikeBody = data.bikes.rows.slice(0, 25).map((r) => [
      r.client_name || 'Agent',
      r.client_phone || '—',
      r.item_name || 'Spiro EV Bike',
      r.order_status || 'issued',
      day(r.issued_date),
      ugx(r.value),
      ugx(r.paid),
      ugx(r.outstanding),
    ]);
    drawTable('ACTIVE MOTOR BIKE LEASES (TOP RECORDS)', bikeHead, bikeRatios, bikeBody, bikeAligns);
  }

  // Smartphones detail rows
  if (data.phones.rows && data.phones.rows.length > 0) {
    const phoneHead = ['Agent / Client', 'Phone', 'Phone Model', 'Qty', 'Issued Date', 'Device Value', 'Paid', 'Outstanding'];
    const phoneRatios = [35, 24, 34, 12, 22, 28, 28, 28];
    const phoneAligns: ('left' | 'right')[] = ['left', 'left', 'left', 'right', 'left', 'right', 'right', 'right'];
    const phoneBody = data.phones.rows.slice(0, 25).map((r) => [
      r.client_name || 'Agent',
      r.client_phone || '—',
      r.item_name || 'Smartphone',
      r.quantity || 1,
      day(r.issued_date),
      ugx(r.value),
      ugx(r.paid),
      ugx(r.outstanding),
    ]);
    drawTable('SMARTPHONE ORDERS & DEVICE LEASES (TOP RECORDS)', phoneHead, phoneRatios, phoneBody, phoneAligns);
  }

  // SECTION 3: BOUTIQUE MERCHANDISE & SHOP SIGNAGES
  ensure(40);
  sectionTitle(
    '3. Agent Boutique & Shop Signages',
    'Branded operational apparel, merchandise sales and physical agent location signages'
  );

  drawKpiCards(
    [
      { label: 'Boutique Items Held', value: num(data.boutique.in_field_items), detail: `Sales value: ${ugx(totalBoutiqueValue)}` },
      { label: 'Boutique Outstanding', value: ugx(totalBoutiqueOutstanding), detail: `Recovered: ${ugx(totalBoutiquePaid)}` },
      { label: 'Signages Installed', value: num(data.signages.in_field_items), detail: `Total value: ${ugx(totalSignagesValue)}` },
      { label: 'Signages Outstanding', value: ugx(totalSignagesOutstanding), detail: `Recovered: ${ugx(totalSignagesPaid)}` },
    ],
    4
  );

  // Boutique breakdown table
  if (data.boutique.breakdown && data.boutique.breakdown.length > 0) {
    const bHead = ['Merchandise Item', 'Options / Models', 'Ref Price', 'Units Issued', 'Total Value', 'Outstanding Balance'];
    const bRatios = [40, 20, 24, 18, 30, 30];
    const bAligns: ('left' | 'right')[] = ['left', 'right', 'right', 'right', 'right', 'right'];
    const bBody = data.boutique.breakdown.map((r) => [
      r.label,
      num(r.models),
      ugx(r.reference_price),
      num(r.issued_qty),
      ugx(r.issued_value),
      ugx(r.outstanding),
    ]);
    drawTable('BOUTIQUE MERCHANDISE CATALOG & FIELD INVENTORY', bHead, bRatios, bBody, bAligns);
  }

  // Signage holder rows
  if (data.signages.rows && data.signages.rows.length > 0) {
    const sHead = ['Agent / Shop Owner', 'Phone', 'Service Centre / Location', 'Signages', 'Value', 'Recovered', 'Outstanding'];
    const sRatios = [35, 24, 40, 16, 26, 26, 26];
    const sAligns: ('left' | 'right')[] = ['left', 'left', 'left', 'right', 'right', 'right', 'right'];
    const sBody = data.signages.rows.slice(0, 25).map((r) => [
      r.full_name || 'Agent',
      r.phone || '—',
      r.location_name || '—',
      num(r.items_held),
      ugx(r.held_amount),
      ugx(r.repaid_amount),
      ugx(r.outstanding_amount),
    ]);
    drawTable('SHOP SIGNAGES INSTALLED & BALANCES (TOP LOCATIONS)', sHead, sRatios, sBody, sAligns);
  }

  // SECTION 4: AGENT ADVANCES & LENDING AGENTS
  ensure(40);
  sectionTitle(
    '4. Financial Services: Agent Advances & Lending Agent Books',
    'Direct operational cash advances and peer-to-peer agent lending operations'
  );

  drawKpiCards(
    [
      { label: 'Active Advances', value: num(data.advances.active_count), detail: `${num(data.advances.submitted)} submitted · ${num(data.advances.approved)} approved` },
      { label: 'Advances Outstanding', value: ugx(totalAdvancesOutstanding), detail: `Total recovered: ${ugx(totalAdvancesPaid)}` },
      { label: 'Onboarded Lending Agents', value: num(data.lendingAgents.onboarded_count), detail: `${num(data.lendingAgents.active_loans_count)} active loans disbursed` },
      { label: 'Lending Book Outstanding', value: ugx(totalLendingOutstanding), detail: `Lent: ${ugx(totalLendingValue)} · Repaid: ${ugx(totalLendingPaid)}` },
    ],
    4
  );

  // Active Advances table
  if (data.advances.rows && data.advances.rows.length > 0) {
    const advHead = ['Agent Name', 'Phone', 'Status', 'Issued Date', 'Principal', 'Recovered', 'Outstanding Balance'];
    const advRatios = [35, 24, 20, 22, 28, 28, 28];
    const advAligns: ('left' | 'right')[] = ['left', 'left', 'left', 'left', 'right', 'right', 'right'];
    const advBody = data.advances.rows.slice(0, 25).map((r) => [
      r.agent_name || 'Agent',
      r.phone || '—',
      r.status,
      day(r.issued_at),
      ugx(r.principal),
      ugx(r.recovered),
      ugx(r.outstanding),
    ]);
    drawTable('AGENT ADVANCES LEDGER (TOP ACTIVE ADVANCES)', advHead, advRatios, advBody, advAligns);
  }

  // Lending Agents table
  if (data.lendingAgents.rows && data.lendingAgents.rows.length > 0) {
    const lHead = ['Lending Agent Name', 'Phone', 'Active Loans', 'Total Capital Lent', 'Capital Repaid', 'Outstanding Portfolio'];
    const lRatios = [40, 26, 20, 32, 32, 32];
    const lAligns: ('left' | 'right')[] = ['left', 'left', 'right', 'right', 'right', 'right'];
    const lBody = data.lendingAgents.rows.slice(0, 25).map((r) => [
      r.full_name || 'Lending Agent',
      r.phone || '—',
      num(r.loans_count),
      ugx(r.total_lent),
      ugx(r.total_repaid),
      ugx(r.outstanding),
    ]);
    drawTable('WELILE LENDING AGENTS — PORTFOLIO BOOKS', lHead, lRatios, lBody, lAligns);
  }

  // Add page numbers in footer
  const totalPages = doc.getNumberOfPages();
  for (let i = 1; i <= totalPages; i++) {
    doc.setPage(i);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(6.5);
    doc.setTextColor(140, 135, 150);
    doc.text(
      `Welile Receipts & Agent Ops Hub  ·  Agent Products & Services Portfolio  ·  Confidential`,
      margin,
      pageHeight - 6
    );
    doc.text(`Page ${i} of ${totalPages}`, pageWidth - margin, pageHeight - 6, { align: 'right' });
  }

  return doc.output('blob');
}
