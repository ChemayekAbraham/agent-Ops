/**
 * Branded Landscape A4 PDF Generator for Staff Calling & Rent Plan Pipeline Reports
 * (Jane, Winnie, Hanisha & General Team Report).
 *
 * Uses pure 7-bit ASCII text streams (`cleanAscii`) so standard PDF Helvetica
 * never renders `ï¿½` replacement characters in any PDF viewer.
 */
import welileLogoUrl from '@/assets/welile-logo.png';
import {
  cleanAscii,
  formatDayLabel,
  hasWrittenNote,
  ROLE_LABEL,
  themesOf,
  type IndividualStaffReportData,
  type StaffCallingPeriodWindow,
  type TeamCallingReportData,
} from '@/hooks/useStaffCallingReport';

type Rgb = [number, number, number];

const PRIMARY: Rgb = [108, 33, 196];
const PRIMARY_DARK: Rgb = [76, 22, 150];
const ACCENT: Rgb = [239, 176, 46];
const INK: Rgb = [37, 31, 48];
const MUTED: Rgb = [104, 96, 117];
const BORDER: Rgb = [218, 208, 231];
const STRIPE: Rgb = [246, 243, 251];
const BAND: Rgb = [237, 229, 249];
const GOOD: Rgb = [46, 139, 87];
const WARN: Rgb = [214, 120, 30];
const INFO: Rgb = [46, 139, 187];

const STAFF_COL: Record<string, Rgb> = {
  Winnie: [108, 33, 196],
  Hanisha: [239, 176, 46],
  Jane: [46, 139, 187],
};

async function loadLogoBase64(): Promise<string | null> {
  try {
    if (typeof fetch === 'undefined' || typeof FileReader === 'undefined') return null;
    const res = await fetch(welileLogoUrl);
    if (!res.ok) return null;
    const blob = await res.blob();
    return await new Promise((resolve) => {
      const reader = new FileReader();
      reader.onloadend = () => resolve((reader.result as string) || null);
      reader.onerror = () => resolve(null);
      reader.readAsDataURL(blob);
    });
  } catch {
    return null;
  }
}

const stamp = (d: Date) =>
  cleanAscii(
    d.toLocaleString('en-GB', {
      day: '2-digit',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      timeZone: 'Africa/Kampala',
    }),
  );

const pct = (n: number, d: number) => (d ? `${Math.round((n / d) * 100)}%` : '0%');

function toneColor(tone: 'good' | 'warn' | 'info'): Rgb {
  if (tone === 'good') return GOOD;
  if (tone === 'warn') return WARN;
  return INFO;
}

async function createReportDoc(footerLabel: string) {
  const jspdfMod: any = await import('jspdf');
  const JsPDFCtor = jspdfMod.jsPDF || jspdfMod.default;
  const autoTableMod: any = await import('jspdf-autotable');
  const autoTable = autoTableMod.default || autoTableMod.autoTable || autoTableMod;

  const doc = new JsPDFCtor({ unit: 'mm', format: 'a4', orientation: 'landscape' });
  const W: number = doc.internal.pageSize.getWidth();
  const H: number = doc.internal.pageSize.getHeight();
  const M = 12;
  const logoB64 = await loadLogoBase64();

  const ctx = {
    doc,
    W,
    H,
    M,
    cursor: 0,
    footerLabel: cleanAscii(footerLabel),
    banner: (title: string, subtitle: string, rt: string, rb: string) => {
      doc.setFillColor(...PRIMARY_DARK);
      doc.rect(0, 0, W, 30, 'F');
      doc.setFillColor(...PRIMARY);
      doc.rect(0, 0, 5, 30, 'F');
      doc.setFillColor(...ACCENT);
      doc.rect(0, 28.2, W, 1.8, 'F');
      if (logoB64) {
        try {
          doc.addImage(logoB64, 'PNG', M, 6, 16.5, 16.5);
        } catch {
          /* ignore */
        }
      }
      const hx = logoB64 ? M + 20.5 : M + 4;
      doc.setTextColor(255, 255, 255);
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(16.5);
      doc.text(cleanAscii(title), hx, 12.5);
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(9);
      doc.text(cleanAscii(subtitle), hx, 19);
      doc.setFontSize(8);
      doc.text(cleanAscii(rt), W - M, 12.5, { align: 'right' });
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(9);
      doc.text(cleanAscii(rb), W - M, 19.5, { align: 'right' });
      ctx.cursor = 35;
    },
    meta: (cols: Array<[string, string]>) => {
      doc.setFillColor(249, 247, 252);
      doc.setDrawColor(...BORDER);
      doc.roundedRect(M, ctx.cursor, W - M * 2, 18, 2, 2, 'FD');
      doc.setFillColor(...PRIMARY);
      doc.roundedRect(M, ctx.cursor, 3, 18, 1.5, 1.5, 'F');
      const colW = (W - M * 2 - 8) / cols.length;
      cols.forEach(([k, v], i) => {
        const x = M + 6 + i * colW;
        doc.setTextColor(...MUTED);
        doc.setFont('helvetica', 'normal');
        doc.setFontSize(7);
        doc.text(cleanAscii(k), x, ctx.cursor + 6.5);
        doc.setTextColor(...INK);
        doc.setFont('helvetica', 'bold');
        doc.setFontSize(8.8);
        doc.text(doc.splitTextToSize(cleanAscii(v), colW - 4)[0] ?? '-', x, ctx.cursor + 12.8);
      });
      ctx.cursor += 22.5;
    },
    tiles: (list: Array<{ label: string; value: string; sub?: string; color?: Rgb }>) => {
      const tw = (W - M * 2 - (list.length - 1) * 3) / list.length;
      list.forEach((t, i) => {
        const x = M + i * (tw + 3);
        doc.setFillColor(255, 255, 255);
        doc.setDrawColor(...BORDER);
        doc.roundedRect(x, ctx.cursor, tw, 18.5, 2, 2, 'FD');
        doc.setFillColor(...(t.color || PRIMARY));
        doc.roundedRect(x, ctx.cursor, 1.8, 18.5, 0.9, 0.9, 'F');
        doc.setTextColor(...MUTED);
        doc.setFont('helvetica', 'normal');
        doc.setFontSize(6.8);
        doc.text(
          doc.splitTextToSize(cleanAscii(t.label).toUpperCase(), tw - 6)[0] ?? '',
          x + 4,
          ctx.cursor + 5.8,
        );
        doc.setTextColor(...INK);
        doc.setFont('helvetica', 'bold');
        doc.setFontSize(12.5);
        doc.text(cleanAscii(t.value), x + 4, ctx.cursor + 12.4);
        if (t.sub) {
          doc.setFont('helvetica', 'normal');
          doc.setFontSize(6.6);
          doc.setTextColor(...MUTED);
          doc.text(doc.splitTextToSize(cleanAscii(t.sub), tw - 6)[0] ?? '', x + 4, ctx.cursor + 16.4);
        }
      });
      ctx.cursor += 23;
    },
    section: (label: string, needed = 36, newPage = false) => {
      if (newPage || ctx.cursor > H - needed) {
        doc.addPage();
        ctx.cursor = 18;
      }
      doc.setFillColor(...ACCENT);
      doc.rect(M, ctx.cursor - 3.6, 1.8, 5.2, 'F');
      doc.setTextColor(...PRIMARY_DARK);
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(10.8);
      doc.text(cleanAscii(label), M + 4.2, ctx.cursor);
      ctx.cursor += 4.2;
    },
    note: (text: string, size = 8, color: Rgb = MUTED, indent = 0) => {
      doc.setTextColor(...color);
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(size);
      const lines = doc.splitTextToSize(cleanAscii(text), W - M * 2 - indent);
      if (ctx.cursor + lines.length * (size * 0.5) > H - 16) {
        doc.addPage();
        ctx.cursor = 18;
      }
      doc.text(lines, M + indent, ctx.cursor + 3);
      ctx.cursor += 3 + lines.length * (size * 0.46) + 1.8;
    },
    bullet: (text: string, size = 8.6) => {
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(size);
      const lines = doc.splitTextToSize(cleanAscii(text), W - M * 2 - 6);
      if (ctx.cursor + lines.length * (size * 0.5) > H - 16) {
        doc.addPage();
        ctx.cursor = 18;
      }
      doc.setFillColor(...ACCENT);
      doc.circle(M + 1.8, ctx.cursor + 2.1, 1.0, 'F');
      doc.setTextColor(...INK);
      doc.text(lines, M + 5.2, ctx.cursor + 3);
      ctx.cursor += 3 + lines.length * (size * 0.46) + 2.0;
    },
    table: (opts: Record<string, any>) => {
      const tableBase = {
        styles: {
          fontSize: 8,
          cellPadding: 1.8,
          textColor: INK,
          lineColor: BORDER,
          lineWidth: 0.1,
          overflow: 'linebreak',
          valign: 'middle',
        },
        headStyles: {
          fillColor: PRIMARY,
          textColor: [255, 255, 255],
          fontStyle: 'bold',
          fontSize: 8,
        },
        alternateRowStyles: { fillColor: STRIPE },
        margin: { left: M, right: M, top: 18, bottom: 16 },
      };

      const sanitizeCell = (c: any): any => {
        if (c === null || c === undefined) return '-';
        if (typeof c === 'string') return cleanAscii(c);
        if (typeof c === 'number') return c;
        if (typeof c === 'object' && 'content' in c) {
          return { ...c, content: cleanAscii(c.content) };
        }
        return cleanAscii(String(c));
      };

      const sanitizedHead = Array.isArray(opts.head)
        ? opts.head.map((row: any[]) => row.map(sanitizeCell))
        : opts.head;
      const sanitizedBody = Array.isArray(opts.body)
        ? opts.body.map((row: any[]) => row.map(sanitizeCell))
        : opts.body;
      const sanitizedFoot = Array.isArray(opts.foot)
        ? opts.foot.map((row: any[]) => row.map(sanitizeCell))
        : opts.foot;

      autoTable(doc, {
        ...tableBase,
        ...opts,
        head: sanitizedHead,
        body: sanitizedBody,
        foot: sanitizedFoot,
        startY: ctx.cursor,
        styles: { ...tableBase.styles, ...(opts.styles || {}) },
        headStyles: { ...tableBase.headStyles, ...(opts.headStyles || {}) },
      });
      ctx.cursor = (doc as any).lastAutoTable.finalY + 5.5;
    },
    space: (need: number) => {
      if (ctx.cursor + need > H - 15) {
        doc.addPage();
        ctx.cursor = 18;
      }
    },
    stackedBars: ({
      data,
      series,
      height = 34,
    }: {
      data: Array<{ label: string; values: number[] }>;
      series: Array<{ label: string; color: Rgb }>;
      height?: number;
    }) => {
      ctx.space(height + 20);
      const x0 = M + 8;
      const w = W - M * 2 - 10;
      const y0 = ctx.cursor + 3.5;
      const h = height;
      const max = Math.max(1, ...data.map((d) => d.values.reduce((a, b) => a + b, 0)));
      const step = Math.max(5, Math.ceil(max / 4 / 5) * 5);
      const nice = step * 4;
      doc.setDrawColor(...BORDER);
      doc.setLineWidth(0.1);
      for (let i = 0; i <= 4; i += 1) {
        const gy = y0 + h - (h * i) / 4;
        doc.line(x0, gy, x0 + w, gy);
        doc.setFontSize(6.5);
        doc.setTextColor(...MUTED);
        doc.setFont('helvetica', 'normal');
        doc.text(String(Math.round((nice * i) / 4)), x0 - 1.5, gy + 1, { align: 'right' });
      }
      const slot = w / Math.max(1, data.length);
      const bw = Math.min(slot * 0.62, 11);
      data.forEach((d, i) => {
        let acc = 0;
        const bx = x0 + i * slot + (slot - bw) / 2;
        d.values.forEach((v, si) => {
          if (v <= 0) return;
          const bh = (v / nice) * h;
          doc.setFillColor(...series[si].color);
          doc.rect(bx, y0 + h - ((acc + v) / nice) * h, bw, bh, 'F');
          acc += v;
        });
        const total = d.values.reduce((a, b) => a + b, 0);
        if (total > 0) {
          doc.setFontSize(6.5);
          doc.setFont('helvetica', 'bold');
          doc.setTextColor(...INK);
          doc.text(String(total), bx + bw / 2, y0 + h - (acc / nice) * h - 1, { align: 'center' });
        }
        doc.setFontSize(6);
        doc.setFont('helvetica', 'normal');
        doc.setTextColor(...MUTED);
        const lab = cleanAscii(d.label).split(' ');
        if (lab[0]) doc.text(lab[0], bx + bw / 2, y0 + h + 3.3, { align: 'center' });
        if (lab[1]) doc.text(lab[1], bx + bw / 2, y0 + h + 6.0, { align: 'center' });
      });
      let lx = x0;
      const ly = y0 + h + 10.5;
      series.forEach((s) => {
        doc.setFillColor(...s.color);
        doc.rect(lx, ly - 2.4, 3.2, 3.2, 'F');
        doc.setFontSize(7.2);
        doc.setTextColor(...INK);
        doc.text(cleanAscii(s.label), lx + 4.6, ly + 0.2);
        lx += 8 + doc.getTextWidth(cleanAscii(s.label)) + 5;
      });
      ctx.cursor = ly + 5;
    },
    hbars: ({
      items,
      total,
      labelW = 68,
    }: {
      items: Array<{ label: string; value: number; color?: Rgb }>;
      total: number;
      labelW?: number;
    }) => {
      const rowH = 5.2;
      ctx.space(items.length * rowH + 4);
      const x0 = M;
      const bx = M + labelW;
      const bw = W - M * 2 - labelW - 28;
      const max = Math.max(1, ...items.map((i) => i.value));
      items.forEach((it, i) => {
        const y = ctx.cursor + i * rowH;
        doc.setFont('helvetica', 'normal');
        doc.setFontSize(7.8);
        doc.setTextColor(...INK);
        doc.text(doc.splitTextToSize(cleanAscii(it.label), labelW - 3)[0] ?? '', x0, y + 3.5);
        doc.setFillColor(...STRIPE);
        doc.rect(bx, y + 0.6, bw, 3.8, 'F');
        doc.setFillColor(...(it.color || PRIMARY));
        doc.rect(bx, y + 0.6, Math.max(0.6, (it.value / max) * bw), 3.8, 'F');
        doc.setFont('helvetica', 'bold');
        doc.setFontSize(7.8);
        doc.setTextColor(...INK);
        doc.text(`${it.value}  (${pct(it.value, total)})`, bx + bw + 2, y + 3.6);
      });
      ctx.cursor += items.length * rowH + 3.5;
    },
    hblock: (
      noteText: string,
      opts: { items: Array<{ label: string; value: number; color?: Rgb }>; total: number; labelW?: number },
    ) => {
      ctx.space(9 + opts.items.length * 5.2 + 5);
      ctx.note(noteText);
      ctx.hbars(opts);
    },
    finishBlob: (): Blob => {
      const pages = doc.internal.getNumberOfPages();
      for (let i = 1; i <= pages; i += 1) {
        doc.setPage(i);
        doc.setDrawColor(...BORDER);
        doc.setLineWidth(0.2);
        doc.line(M, H - 11, W - M, H - 11);
        doc.setTextColor(...MUTED);
        doc.setFont('helvetica', 'normal');
        doc.setFontSize(7.4);
        doc.text(
          cleanAscii(`Welile  -  Tenant Operations & Landlord Operations  -  ${ctx.footerLabel}`),
          M,
          H - 6.5,
        );
        doc.text(`Confidential - internal use only  -  Page ${i} of ${pages}`, W - M, H - 6.5, {
          align: 'right',
        });
      }
      return doc.output('blob');
    },
  };

  return ctx;
}

// ------------------------------------------------------------------ 1. Individual Staff Report PDF

export async function generateIndividualStaffCallingPdfBlob(
  data: IndividualStaffReportData,
  periodWindow: StaffCallingPeriodWindow,
): Promise<{ blob: Blob; fileName: string }> {
  const { person, rows: rs, stats: st, excludedReveals, channels, outcomes, themes, withWrittenNotesCount, directory } =
    data;
  const days = periodWindow.days;
  const ctx = await createReportDoc(`${person.short} (${person.display})  -  ${periodWindow.shortLabel} call report`);

  ctx.banner(
    `Call Report - ${person.short} (${person.display})`,
    `Tenant Ops  -  Landlord Ops  -  every call, phone number & pipeline feedback  -  ${periodWindow.periodLabel}`,
    'CONFIDENTIAL OPERATIONAL REPORT',
    `${st.total.toLocaleString()} calls  -  ${st.people.toLocaleString()} people called`,
  );

  ctx.meta([
    ['STAFF MEMBER', person.display],
    ['PERIOD', periodWindow.periodLabel],
    ['SCOPE', person.roleLabel],
    ['GENERATED (KAMPALA)', stamp(new Date())],
  ]);

  ctx.tiles([
    {
      label: 'Total calls & reviews',
      value: st.total.toLocaleString(),
      sub: `${st.known} dialed  -  ${st.reviewOnly} review notes`,
    },
    {
      label: 'People called',
      value: st.people.toLocaleString(),
      sub: '100% with phone numbers',
      color: ACCENT,
    },
    {
      label: 'Reached',
      value: `${st.reached.toLocaleString()} (${st.reachPct}%)`,
      sub: 'answered / verified',
      color: GOOD,
    },
    {
      label: 'Not reached',
      value: st.notReached.toLocaleString(),
      sub: 'phone off, no answer, wrong no.',
      color: WARN,
    },
    {
      label: 'Active days',
      value: `${st.activeDays} of ${days.length}`,
      sub: periodWindow.shortLabel,
    },
    {
      label: 'Avg per active day',
      value: st.avg.toFixed(1),
      sub: st.busiest ? `Peak: ${formatDayLabel(st.busiest.day)} (${st.busiest.n})` : '-',
      color: ACCENT,
    },
  ]);

  // Section 1: Calls per day chart
  ctx.section(`1  -  Daily call & pipeline activity (${periodWindow.shortLabel})`);
  ctx.stackedBars({
    data: days.map((d) => {
      const a = st.byDay.get(d) || [];
      const rch = a.filter((r) => r.answered === true || r.outcome === 'review recorded').length;
      return { label: formatDayLabel(d), values: [rch, a.length - rch] };
    }),
    series: [
      { label: 'Reached / pipeline feedback recorded', color: PRIMARY },
      { label: 'Not reached (phone off / no answer / failed)', color: ACCENT },
    ],
    height: 31,
  });

  // Section 2: Where the calls were recorded
  ctx.section('2  -  Where calls & pipeline feedback were recorded', 20 + channels.length * 7);
  ctx.table({
    head: [['Channel / Pipeline stage', 'Calls / Entries', 'Share', 'Reached', 'Reach rate', 'With written feedback']],
    body: channels.length
      ? channels.map((c) => [
          c.source,
          c.count,
          `${c.sharePct}%`,
          c.known ? c.reached : '-',
          c.reachPct !== null ? `${c.reachPct}%` : 'Pipeline review',
          c.withNotes,
        ])
      : [['No calls recorded in this period', 0, '0%', '-', '-', 0]],
    columnStyles: {
      0: { cellWidth: 105 },
      1: { halign: 'center' },
      2: { halign: 'center' },
      3: { halign: 'center' },
      4: { halign: 'center' },
      5: { halign: 'center' },
    },
    headStyles: { halign: 'center' },
    didParseCell: (d: any) => {
      if (d.section === 'head' && d.column.index === 0) d.cell.styles.halign = 'left';
    },
  });

  // Section 3: Feedback at a glance
  ctx.section('3  -  Feedback & outcomes at a glance', 55);
  if (outcomes.length > 0) {
    ctx.hblock('Call & pipeline outcomes across all entries:', {
      items: outcomes.map((o) => ({ label: o.label, value: o.value, color: toneColor(o.tone) })),
      total: st.total,
    });
  } else {
    ctx.note('No call outcomes recorded in this period.');
  }

  if (themes.length > 0) {
    ctx.hblock(
      `Themes in what people told ${person.short} (across ${withWrittenNotesCount.toLocaleString()} entries with written feedback; one call can touch multiple themes):`,
      {
        items: themes.map((t) => ({ label: t.label, value: t.value, color: PRIMARY })),
        total: withWrittenNotesCount,
      },
    );
  }

  // Section 4: Day by day
  ctx.section('4  -  Day by day - dates, call counts & daily feedback summary', 60, true);
  ctx.table({
    head: [
      [
        'Date (Kampala)',
        'Calls',
        'People called',
        'Reached',
        'Not reached',
        'Pipeline reviews',
        'Daily outcome breakdown',
      ],
    ],
    body: days.map((d) => {
      const a = st.byDay.get(d) || [];
      if (!a.length) return [formatDayLabel(d, true), '-', '-', '-', '-', '-', 'No calls recorded'];
      const people = new Set(a.map((r) => r.pk)).size;
      const rch = a.filter((r) => r.answered === true).length;
      const nr = a.filter((r) => r.answered === false).length;
      const rev = a.filter((r) => r.answered === null || r.answered === undefined).length;
      const top = new Map<string, number>();
      a.forEach((r) => top.set(r.ol, (top.get(r.ol) || 0) + 1));
      const topTxt = [...top.entries()]
        .sort((x, y) => y[1] - x[1])
        .slice(0, 4)
        .map(([k, v]) => `${k}: ${v}`)
        .join('  -  ');
      return [formatDayLabel(d, true), a.length, people, rch, nr, rev || '-', topTxt];
    }),
    foot: [
      [
        `Period total (${periodWindow.shortLabel})`,
        st.total,
        st.people,
        st.reached,
        st.notReached,
        st.reviewOnly || '-',
        '',
      ],
    ],
    footStyles: { fillColor: BAND, textColor: INK, fontStyle: 'bold', fontSize: 7.4 },
    showFoot: 'lastPage',
    styles: { fontSize: 7.1, cellPadding: 1.25 },
    headStyles: { fontSize: 7.4, halign: 'center', cellPadding: 1.5 },
    columnStyles: {
      0: { cellWidth: 38 },
      1: { halign: 'center', cellWidth: 18 },
      2: { halign: 'center', cellWidth: 24 },
      3: { halign: 'center', cellWidth: 20 },
      4: { halign: 'center', cellWidth: 22 },
      5: { halign: 'center', cellWidth: 24 },
    },
    didParseCell: (d: any) => {
      if (d.section === 'head' && (d.column.index === 0 || d.column.index === 6)) d.cell.styles.halign = 'left';
      if (d.section === 'body' && d.cell.raw === 'No calls recorded') d.cell.styles.textColor = MUTED;
    },
  });

  // Section 5: Directory of people called
  ctx.section('5  -  Directory of people called - names, phone numbers & latest feedback', 60, true);
  ctx.note(
    `${st.people.toLocaleString()} distinct people (phone numbers) were called by ${person.short} during ${periodWindow.shortLabel}. Every person has a verified phone number listed below.`,
  );
  ctx.table({
    head: [
      [
        '#',
        'Person called',
        'Phone number',
        'Role',
        'Calls',
        'Reached',
        'First date',
        'Last date',
        'Last outcome',
        'Latest feedback summary',
      ],
    ],
    body: directory.length
      ? directory.map((p, i) => [
          i + 1,
          p.name,
          p.phone,
          p.roleLabel,
          p.calls,
          p.reached,
          formatDayLabel(p.firstDay, true).slice(4),
          formatDayLabel(p.lastDay, true).slice(4),
          p.lastOutcome,
          p.lastFeedback,
        ])
      : [['-', 'No people called in this period', '-', '-', 0, 0, '-', '-', '-', '-']],
    styles: { fontSize: 7.0, cellPadding: 1.35 },
    headStyles: { fontSize: 7.3 },
    columnStyles: {
      0: { cellWidth: 9, halign: 'center' },
      1: { cellWidth: 40 },
      2: { cellWidth: 28 },
      3: { cellWidth: 16 },
      4: { cellWidth: 12, halign: 'center' },
      5: { cellWidth: 14, halign: 'center' },
      6: { cellWidth: 21 },
      7: { cellWidth: 21 },
      8: { cellWidth: 25 },
    },
  });

  // Section 6: Complete chronological call & pipeline feedback log
  ctx.section(
    '6  -  Complete chronological call & pipeline feedback log (every call, date, phone number & feedback)',
    60,
    true,
  );
  ctx.note(
    'Every call and Rent Plan pipeline review recorded by date and Kampala time. The Feedback column shows the exact category, awareness answers, verification notes, and written remarks recorded.',
  );
  const body: any[] = [];
  const bandIdx = new Set<number>();
  days.forEach((d) => {
    const a = st.byDay.get(d);
    if (!a || !a.length) return;
    const people = new Set(a.map((r) => r.pk)).size;
    const rch = a.filter((r) => r.answered === true).length;
    const rev = a.filter((r) => r.answered === null || r.answered === undefined).length;
    bandIdx.add(body.length);
    body.push([
      {
        content: `${formatDayLabel(d, true)}    -    ${a.length} entries    -    ${people} distinct phone numbers    -    ${rch} reached${rev ? `    -    ${rev} pipeline review(s)` : ''}`,
        colSpan: 7,
      },
    ]);
    a.forEach((r) =>
      body.push([r.hhmm, r.nm, r.ph || '-', ROLE_LABEL[r.role] || r.role, r.src, r.ol, r.fb]),
    );
  });

  if (body.length === 0) {
    body.push(['-', 'No calls recorded in this period', '-', '-', '-', '-', '-']);
  }

  ctx.table({
    head: [
      ['Time', 'Person called', 'Phone number', 'Role', 'Channel / Pipeline stage', 'Outcome', 'Recorded feedback & notes'],
    ],
    body,
    styles: { fontSize: 6.95, cellPadding: 1.28 },
    headStyles: { fontSize: 7.4 },
    alternateRowStyles: { fillColor: [255, 255, 255] },
    columnStyles: {
      0: { cellWidth: 12 },
      1: { cellWidth: 37 },
      2: { cellWidth: 28 },
      3: { cellWidth: 15 },
      4: { cellWidth: 42 },
      5: { cellWidth: 25 },
    },
    didParseCell: (d: any) => {
      if (d.section === 'body' && bandIdx.has(d.row.index)) {
        d.cell.styles.fillColor = BAND;
        d.cell.styles.fontStyle = 'bold';
        d.cell.styles.textColor = PRIMARY_DARK;
        d.cell.styles.fontSize = 7.8;
      }
    },
  });

  ctx.section('How this report was compiled', 22);
  ctx.note(
    `Scope: Every phone call and Rent Plan pipeline call-feedback entry recorded by ${person.display} during ${periodWindow.timeRangeLabel} (Africa/Kampala time), across Tenant Ops Calling Center, Landlord Ops Calling Center, Landlord Ops Calling Hub, Inbound Calling Center calls, Rent Plan Pipeline Awareness Calls, Landlord Ops Pre-Approval Verification & Review Feedback, Tenant Ops Pre-Approval Review Feedback, and In-App Voice Calls. Duplicate records of the same staff member phoning the same person or reviewing the same role on the same Rent Plan within 15 minutes are merged into one entry so no call is double-counted and no feedback is lost. Excluded: ${excludedReveals} Calling Center phone-reveals and unrecorded Landlord Calling Hub dials older than 24 hours where no call outcome was ever submitted.`,
    7.4,
  );

  const blob = ctx.finishBlob();
  const fileName = `Call-Report-${person.fileSlug}-${periodWindow.fileSlug}.pdf`;
  return { blob, fileName };
}

export async function exportIndividualStaffCallingPdf(
  data: IndividualStaffReportData,
  periodWindow: StaffCallingPeriodWindow,
): Promise<string> {
  const { blob, fileName } = await generateIndividualStaffCallingPdfBlob(data, periodWindow);
  triggerBlobDownload(blob, fileName);
  return fileName;
}

// ------------------------------------------------------------------ 2. General / Team Report PDF

export async function generateGeneralTeamCallingPdfBlob(
  teamData: TeamCallingReportData,
  periodWindow: StaffCallingPeriodWindow,
): Promise<{ blob: Blob; fileName: string }> {
  const {
    rows: all,
    stats: st,
    perStaff,
    outcomes,
    themes,
    withWrittenNotesCount,
    ccCategories,
    ccReachedWithFeedbackCount,
    awareness,
    pipelineDesks,
    verbatimSamples,
  } = teamData;
  const days = periodWindow.days;
  const ctx = await createReportDoc(`Team Call & Pipeline Feedback Report  -  ${periodWindow.shortLabel}`);

  ctx.banner(
    'Team Call & Feedback Report - Jane, Winnie & Hanisha',
    `Tenant Ops  -  Landlord Ops  -  Calling Centers & Rent Plan Pipelines  -  ${periodWindow.periodLabel}`,
    'CONFIDENTIAL OPERATIONAL REPORT',
    `${st.total.toLocaleString()} calls & reviews  -  ${st.people.toLocaleString()} people`,
  );

  ctx.meta([
    ['STAFF COVERED', 'Jane  -  Winnie  -  Hanisha (3 staff)'],
    ['PERIOD', periodWindow.periodLabel],
    ['DEPARTMENTS', 'Tenant Ops & Landlord Ops'],
    ['GENERATED (KAMPALA)', stamp(new Date())],
  ]);

  ctx.tiles([
    {
      label: 'Total calls & reviews',
      value: st.total.toLocaleString(),
      sub: `${st.known} dialed  -  ${st.reviewOnly} pipeline reviews`,
    },
    {
      label: 'People called',
      value: st.people.toLocaleString(),
      sub: '100% with phone numbers',
      color: ACCENT,
    },
    {
      label: 'Reached / verified',
      value: `${st.reached.toLocaleString()} (${st.reachPct}%)`,
      sub: 'person answered the call',
      color: GOOD,
    },
    {
      label: 'Not reached',
      value: st.notReached.toLocaleString(),
      sub: 'phone off, no answer, wrong no.',
      color: WARN,
    },
    {
      label: 'Active calling days',
      value: `${st.activeDays} of ${days.length}`,
      sub: periodWindow.shortLabel,
    },
    {
      label: 'Busiest team day',
      value: st.busiest ? formatDayLabel(st.busiest.day) : '-',
      sub: st.busiest ? `${st.busiest.n} calls & reviews` : '',
      color: ACCENT,
    },
  ]);

  const sb = perStaff.map((r) => ({ p: r.person, s: r.stats, rs: r.rows }));

  // Section 1: Team Scoreboard
  ctx.section(`1  -  Team scoreboard (${periodWindow.shortLabel})`);
  ctx.table({
    head: [
      [
        'Staff member',
        'Total entries',
        'People called (numbers)',
        'Reached',
        'Not reached',
        'Pipeline reviews',
        'Reach rate',
        'Active days',
        'Avg / active day',
        'Tenants',
        'Landlords',
        'Other',
      ],
    ],
    body: [
      ...sb.map(({ p, s, rs }) => [
        `${p.short} - ${p.display}`,
        s.total,
        s.people,
        s.reached,
        s.notReached,
        s.reviewOnly || '-',
        `${s.reachPct}%`,
        s.activeDays,
        s.avg.toFixed(1),
        rs.filter((r) => r.role === 'tenant').length,
        rs.filter((r) => r.role === 'landlord').length,
        rs.filter((r) => r.role !== 'tenant' && r.role !== 'landlord').length,
      ]),
      [
        'Team total',
        st.total,
        st.people,
        st.reached,
        st.notReached,
        st.reviewOnly,
        `${st.reachPct}%`,
        st.activeDays,
        st.avg.toFixed(1),
        all.filter((r) => r.role === 'tenant').length,
        all.filter((r) => r.role === 'landlord').length,
        all.filter((r) => r.role !== 'tenant' && r.role !== 'landlord').length,
      ],
    ],
    columnStyles: {
      0: { cellWidth: 54 },
      1: { halign: 'center' },
      2: { halign: 'center' },
      3: { halign: 'center' },
      4: { halign: 'center' },
      5: { halign: 'center' },
      6: { halign: 'center' },
      7: { halign: 'center' },
      8: { halign: 'center' },
      9: { halign: 'center' },
      10: { halign: 'center' },
      11: { halign: 'center' },
    },
    headStyles: { halign: 'center', fontSize: 7.4 },
    styles: { fontSize: 7.6, cellPadding: 1.6 },
    didParseCell: (d: any) => {
      if (d.section === 'head' && d.column.index === 0) d.cell.styles.halign = 'left';
      if (d.section === 'body' && d.row.index === sb.length) {
        d.cell.styles.fontStyle = 'bold';
        d.cell.styles.fillColor = BAND;
      }
    },
  });

  // Section 2: Where calls & pipeline feedback were recorded
  ctx.section('2  -  Where calls & Rent Plan pipeline feedback were recorded');
  const srcs = [...new Set(all.map((r) => r.src))].sort(
    (a, b) => all.filter((r) => r.src === b).length - all.filter((r) => r.src === a).length,
  );
  ctx.table({
    head: [
      ['Channel / Pipeline stage', ...sb.map(({ p }) => p.short), 'Team total', 'Share of total', 'Reached', 'Reach rate'],
    ],
    body: srcs.length
      ? srcs.map((s) => {
          const a = all.filter((r) => r.src === s);
          const known = a.filter((r) => r.answered !== null && r.answered !== undefined);
          const rch = known.filter((r) => r.answered).length;
          return [
            s,
            ...sb.map(({ rs }) => rs.filter((r) => r.src === s).length || '-'),
            a.length,
            pct(a.length, st.total),
            known.length ? rch : '-',
            known.length ? pct(rch, known.length) : 'Pipeline review',
          ];
        })
      : [['No calls recorded in this period', ...sb.map(() => 0), 0, '0%', '-', '-']],
    columnStyles: {
      0: { cellWidth: 92 },
      ...Object.fromEntries([...Array(sb.length + 4)].map((_, i) => [i + 1, { halign: 'center' }])),
    },
    headStyles: { halign: 'center', fontSize: 7.5 },
    styles: { fontSize: 7.5, cellPadding: 1.5 },
    didParseCell: (d: any) => {
      if (d.section === 'head' && d.column.index === 0) d.cell.styles.halign = 'left';
    },
  });

  // Section 3: Daily trend chart + complete day table
  ctx.section(`3  -  Daily calls & pipeline reviews by staff member (${periodWindow.shortLabel})`, 60, true);
  ctx.stackedBars({
    data: days.map((d) => ({
      label: formatDayLabel(d),
      values: sb.map(({ rs }) => rs.filter((r) => r.dayKey === d).length),
    })),
    series: sb.map(({ p }) => ({ label: `${p.short} (${p.display})`, color: STAFF_COL[p.short] || PRIMARY })),
    height: 27,
  });

  ctx.table({
    head: [
      [
        'Date (Kampala)',
        ...sb.map(({ p }) => p.short),
        'Team total',
        'Distinct people called',
        'Reached',
        'Not reached',
        'Pipeline reviews',
      ],
    ],
    body: days.map((d) => {
      const a = all.filter((r) => r.dayKey === d);
      if (!a.length) return [formatDayLabel(d, true), ...sb.map(() => '-'), '-', '-', '-', '-', '-'];
      return [
        formatDayLabel(d, true),
        ...sb.map(({ rs }) => rs.filter((r) => r.dayKey === d).length || '-'),
        a.length,
        new Set(a.map((r) => r.pk)).size,
        a.filter((r) => r.answered === true).length,
        a.filter((r) => r.answered === false).length,
        a.filter((r) => r.answered === null || r.answered === undefined).length || '-',
      ];
    }),
    foot: [
      [
        `Period total (${periodWindow.shortLabel})`,
        ...sb.map(({ s }) => s.total),
        st.total,
        st.people,
        st.reached,
        st.notReached,
        st.reviewOnly,
      ],
    ],
    footStyles: { fillColor: BAND, textColor: INK, fontStyle: 'bold', fontSize: 7.1 },
    showFoot: 'lastPage',
    styles: { fontSize: 6.8, cellPadding: 1.05 },
    headStyles: { halign: 'center', fontSize: 7.1, cellPadding: 1.2 },
    columnStyles: {
      0: { cellWidth: 42 },
      ...Object.fromEntries([...Array(sb.length + 5)].map((_, i) => [i + 1, { halign: 'center' }])),
    },
    didParseCell: (d: any) => {
      if (d.section === 'head' && d.column.index === 0) d.cell.styles.halign = 'left';
    },
  });

  // Section 4: Feedback & outcomes at a glance (team data)
  ctx.section('4  -  Feedback & outcomes at a glance (team data)', 60, true);
  if (outcomes.length > 0) {
    ctx.hblock(`Call & pipeline outcomes across all team entries (${st.total.toLocaleString()} total):`, {
      items: outcomes.map((o) => ({ label: o.label, value: o.value, color: toneColor(o.tone) })),
      total: st.total,
      labelW: 72,
    });
  } else {
    ctx.note('No call outcomes recorded in this period.');
  }

  if (themes.length > 0) {
    ctx.hblock(
      `Themes in what people told the team (across ${withWrittenNotesCount.toLocaleString()} entries with written feedback; one call can mention multiple themes):`,
      {
        items: themes.map((t) => ({ label: t.label, value: t.value, color: PRIMARY })),
        total: withWrittenNotesCount,
        labelW: 96,
      },
    );
  }

  // Section 5: Comprehensive feedback & outcome breakdown
  ctx.section('5  -  Comprehensive feedback & outcome breakdown', 55);
  ctx.table({
    head: [['Outcome / What happened on the call', ...sb.map(({ p }) => p.short), 'Team total', 'Share of team']],
    body: outcomes.length
      ? outcomes.map((o) => [
          o.label,
          ...sb.map(({ rs, s }) => {
            const n = rs.filter((r) => r.ol === o.label).length;
            return n ? `${n} (${pct(n, s.total)})` : '-';
          }),
          o.value,
          `${o.sharePct}%`,
        ])
      : [['No outcomes recorded', ...sb.map(() => '-'), 0, '0%']],
    columnStyles: {
      0: { cellWidth: 85 },
      ...Object.fromEntries([...Array(sb.length + 2)].map((_, i) => [i + 1, { halign: 'center' }])),
    },
    headStyles: { halign: 'center', fontSize: 7.5 },
    styles: { fontSize: 7.4, cellPadding: 1.4 },
    didParseCell: (d: any) => {
      if (d.section === 'head' && d.column.index === 0) d.cell.styles.halign = 'left';
    },
  });

  // Section 6: Written Feedback Themes Table
  ctx.section('6  -  Themes in written call & pipeline feedback (what tenants & landlords said)', 55);
  ctx.note(
    `Across ${withWrittenNotesCount.toLocaleString()} calls and pipeline reviews with written feedback, the table below groups every recurring theme mentioned by tenants and landlords (one call can mention more than one theme):`,
  );
  ctx.table({
    head: [['Feedback theme', ...sb.map(({ p }) => p.short), 'Team mentions', '% of calls with feedback']],
    body: themes.length
      ? themes.map((t) => [
          t.label,
          ...sb.map(({ p }) => t.byStaff[p.short] || '-'),
          t.value,
          `${t.sharePct}%`,
        ])
      : [['No written feedback themes in this period', ...sb.map(() => '-'), 0, '0%']],
    columnStyles: {
      0: { cellWidth: 98 },
      ...Object.fromEntries([...Array(sb.length + 2)].map((_, i) => [i + 1, { halign: 'center' }])),
    },
    headStyles: { halign: 'center', fontSize: 7.5 },
    styles: { fontSize: 7.4, cellPadding: 1.4 },
    didParseCell: (d: any) => {
      if (d.section === 'head' && d.column.index === 0) d.cell.styles.halign = 'left';
    },
  });

  // Section 7: Calling Center Issue Categories & Rent Plan Pipeline Analysis
  ctx.section('7  -  Calling Center issue categories & Rent Plan pipeline analysis', 60, true);
  ctx.note(
    `A. Calling Center structured feedback categories (${ccReachedWithFeedbackCount.toLocaleString()} reached calls with structured feedback):`,
    8.2,
    INK,
  );
  ctx.table({
    head: [
      [
        'Structured feedback category',
        ...sb.map(({ p }) => p.short),
        'Team total',
        'Share of reached calls',
        'Marked high severity',
      ],
    ],
    body: ccCategories.length
      ? ccCategories.map((c) => [
          c.category,
          ...sb.map(({ p }) => c.byStaff[p.short] || '-'),
          c.total,
          `${c.sharePct}%`,
          c.highSeverity,
        ])
      : [['No structured Calling Center categories recorded in this period', ...sb.map(() => '-'), 0, '0%', 0]],
    columnStyles: {
      0: { cellWidth: 86 },
      ...Object.fromEntries([...Array(sb.length + 3)].map((_, i) => [i + 1, { halign: 'center' }])),
    },
    headStyles: { halign: 'center', fontSize: 7.5 },
    styles: { fontSize: 7.5, cellPadding: 1.5 },
    didParseCell: (d: any) => {
      if (d.section === 'head' && d.column.index === 0) d.cell.styles.halign = 'left';
    },
  });

  ctx.note(
    `B. Rent Plan Pipeline  -  Landlord Awareness Calls (${awareness.totalCalls} calls made; ${awareness.answeredCalls} answered, ${awareness.unreachableCalls} unreachable/wrong number):`,
    8.2,
    INK,
  );
  ctx.table({
    head: [
      [
        'Awareness question / check on the call',
        'Knew / Yes / Consents',
        'Had heard / Partly',
        'Did not know / Unsure',
        'Not applicable / pre-change',
      ],
    ],
    body: awareness.questions.map((q) => [q.question, q.col1, q.col2, q.col3, q.col4]),
    columnStyles: {
      0: { cellWidth: 96 },
      1: { halign: 'center' },
      2: { halign: 'center' },
      3: { halign: 'center' },
      4: { halign: 'center' },
    },
    headStyles: { halign: 'center', fontSize: 7.5 },
    styles: { fontSize: 7.5, cellPadding: 1.5 },
    didParseCell: (d: any) => {
      if (d.section === 'head' && d.column.index === 0) d.cell.styles.halign = 'left';
    },
  });

  ctx.note(
    'C. Rent Plan Pipeline  -  Pre-approval verification calls & review feedback in Landlord Ops and Tenant Ops:',
    8.2,
    INK,
  );
  ctx.table({
    head: [['Pipeline desk & action', 'Staff', 'Entries', 'Outcome / Decision breakdown']],
    body: pipelineDesks.map((d) => [d.deskAction, d.staff, d.entries, d.summary]),
    columnStyles: {
      0: { cellWidth: 74 },
      1: { cellWidth: 20, halign: 'center' },
      2: { cellWidth: 20, halign: 'center' },
    },
    headStyles: { halign: 'center', fontSize: 7.5 },
    styles: { fontSize: 7.5, cellPadding: 1.5 },
    didParseCell: (d: any) => {
      if (d.section === 'head' && (d.column.index === 0 || d.column.index === 3)) d.cell.styles.halign = 'left';
    },
  });

  // Section 8: Verbatim Feedback Highlights & Key Takeaways
  ctx.section('8  -  Representative verbatim feedback samples (with date, caller & phone number)', 60, true);
  ctx.note(
    `Selected verbatim call notes illustrating key operational feedback patterns recorded across Tenant Ops and Landlord Ops during ${periodWindow.shortLabel}:`,
  );
  ctx.table({
    head: [['Date & time', 'Staff', 'Person called / caller', 'Phone number', 'Category / Stage', 'Verbatim feedback recorded']],
    body: verbatimSamples.length
      ? verbatimSamples.map((s) => [s.dateTime, s.staff, s.person, s.phone, s.category, s.feedback])
      : [['-', '-', 'No verbatim notes recorded in this period', '-', '-', '-']],
    styles: { fontSize: 7.1, cellPadding: 1.4 },
    headStyles: { fontSize: 7.4 },
    columnStyles: {
      0: { cellWidth: 23 },
      1: { cellWidth: 16, halign: 'center' },
      2: { cellWidth: 38 },
      3: { cellWidth: 28 },
      4: { cellWidth: 34 },
    },
  });

  // Section 9: Key Takeaways
  ctx.section(`9  -  Key findings & executive summary (${periodWindow.shortLabel})`, 45);
  const staffSummaryBits = perStaff
    .map(
      (p) =>
        `${p.person.short} (${p.stats.total.toLocaleString()} calls/reviews, ${p.stats.people.toLocaleString()} people, ${p.stats.reachPct}% reach rate)`,
    )
    .join(', ');
  ctx.bullet(
    `${st.total.toLocaleString()} total calls and pipeline reviews were completed across ${st.people.toLocaleString()} distinct phone numbers (100% with verified phone numbers): ${staffSummaryBits}.`,
  );

  const disputeCat = ccCategories.find((c) => /dispute/i.test(c.category));
  ctx.bullet(
    `Calling Center structured feedback (${ccReachedWithFeedbackCount.toLocaleString()} reached calls with structured categories): ${
      disputeCat
        ? `${disputeCat.total} calls (${disputeCat.sharePct}%) raised a ${disputeCat.category} (${disputeCat.highSeverity} marked high severity).`
        : 'All structured categories are summarized in Section 7A above.'
    }`,
  );

  ctx.bullet(
    `Landlord Ops & Rent Plan Pipeline (${awareness.totalCalls} Awareness calls, ${awareness.answeredCalls} answered): ${pipelineDesks
      .map((d) => `${d.entries} ${d.deskAction.replace('  -  ', ' ')}`)
      .join('; ')}.`,
  );

  const phoneOffCount = outcomes.find((o) => o.label === 'Phone off')?.value || 0;
  const noAnswerCount = outcomes.find((o) => o.label === 'No answer')?.value || 0;
  ctx.bullet(
    `Reachability hygiene: ${st.reached.toLocaleString()} calls were answered/verified (${st.reachPct}% reach rate on dialed calls), while phones were switched off on ${phoneOffCount.toLocaleString()} calls and unanswered on ${noAnswerCount.toLocaleString()} calls.`,
  );

  const blob = ctx.finishBlob();
  const fileName = `Call-Report-Team-Jane-Winnie-Hanisha-${periodWindow.fileSlug}.pdf`;
  return { blob, fileName };
}

export async function exportGeneralTeamCallingPdf(
  teamData: TeamCallingReportData,
  periodWindow: StaffCallingPeriodWindow,
): Promise<string> {
  const { blob, fileName } = await generateGeneralTeamCallingPdfBlob(teamData, periodWindow);
  triggerBlobDownload(blob, fileName);
  return fileName;
}

function triggerBlobDownload(blob: Blob, fileName: string) {
  if (typeof window === 'undefined' || typeof document === 'undefined') return;
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}
