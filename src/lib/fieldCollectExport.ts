/**
 * Export helpers for Field Collection daily totals.
 * Generates CSV or PDF summaries of captured / synced / pending amounts
 * for a given date, working entirely from the local IndexedDB queue.
 */
import jsPDF from 'jspdf';
import { format, eachDayOfInterval, isSameDay } from 'date-fns';
import type { FieldEntry } from '@/lib/fieldCollectStore';
import { formatUGX } from '@/lib/rentCalculations';

export interface DayTotalsExportInput {
  date: Date;
  agentName?: string | null;
  entries: FieldEntry[]; // already filtered to that date
}

export interface RangeTotalsExportInput {
  /** Inclusive start date — time component ignored. */
  startDate: Date;
  /** Inclusive end date — time component ignored. */
  endDate: Date;
  agentName?: string | null;
  /** All entries in the range (caller filters). */
  entries: FieldEntry[];
  /** Optional human label for the file name (e.g. "this-week"). */
  rangeLabel?: string;
}

function summarize(entries: FieldEntry[]) {
  const sum = (arr: FieldEntry[]) => arr.reduce((s, e) => s + Number(e.amount || 0), 0);
  const synced = entries.filter(e => e.syncState === 'synced');
  const pending = entries.filter(e => e.syncState === 'queued');
  const failed = entries.filter(e => e.syncState === 'error');
  const dup = entries.filter(e => e.syncState === 'duplicate');
  return {
    total: sum(entries),
    captured: entries.length,
    synced: { count: synced.length, total: sum(synced) },
    pending: { count: pending.length, total: sum(pending) },
    failed: { count: failed.length, total: sum(failed) },
    duplicate: { count: dup.length, total: sum(dup) },
  };
}

/** Status label shared by daily and range exports. */
function statusLabel(s: FieldEntry['syncState']): string {
  switch (s) {
    case 'synced': return 'Sent';
    case 'queued': return 'Waiting';
    case 'error': return 'Failed';
    case 'duplicate': return 'Duplicate';
    default: return s;
  }
}

/** Reference shared by daily and range exports. */
function referenceFor(e: FieldEntry): string {
  if (e.serverId) return `RCT-${e.serverId.slice(0, 8).toUpperCase()}`;
  if (e.duplicateOfServerId) return `DUP-${e.duplicateOfServerId.slice(0, 8).toUpperCase()}`;
  return `LOC-${e.id.slice(0, 8).toUpperCase()}`;
}

function escapeCsv(v: string | number | null | undefined): string {
  const s = v == null ? '' : String(v);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function triggerDownload(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function exportDailyTotalsCsv({ date, agentName, entries }: DayTotalsExportInput) {
  const summary = summarize(entries);
  const dateLabel = format(date, 'yyyy-MM-dd');
  const lines: string[] = [];

  // Header / summary block
  lines.push(`Welile Field Collection — Daily Totals`);
  lines.push(`Date,${escapeCsv(dateLabel)}`);
  if (agentName) lines.push(`Agent,${escapeCsv(agentName)}`);
  lines.push(`Generated,${escapeCsv(new Date().toISOString())}`);
  lines.push('');
  lines.push('Bucket,Count,Amount (UGX)');
  lines.push(`Captured,${summary.captured},${summary.total}`);
  lines.push(`Synced,${summary.synced.count},${summary.synced.total}`);
  lines.push(`Pending,${summary.pending.count},${summary.pending.total}`);
  lines.push(`Failed,${summary.failed.count},${summary.failed.total}`);
  lines.push(`Duplicate,${summary.duplicate.count},${summary.duplicate.total}`);
  lines.push('');

  // Itemised entries
  lines.push('Captured At,Tenant,Phone,Amount (UGX),Status,Notes,Client ID');
  const sorted = [...entries].sort((a, b) => a.capturedAt - b.capturedAt);
  for (const e of sorted) {
    lines.push([
      escapeCsv(format(new Date(e.capturedAt), 'yyyy-MM-dd HH:mm:ss')),
      escapeCsv(e.tenantName || ''),
      escapeCsv(e.tenantPhone || ''),
      e.amount,
      escapeCsv(e.syncState),
      escapeCsv(e.notes || ''),
      escapeCsv(e.id),
    ].join(','));
  }

  const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8;' });
  triggerDownload(blob, `field-collections-${dateLabel}.csv`);
}

export function exportDailyTotalsPdf({ date, agentName, entries }: DayTotalsExportInput) {
  const summary = summarize(entries);
  const dateLabel = format(date, 'PPP');
  const dateFile = format(date, 'yyyy-MM-dd');
  const doc = new jsPDF({ unit: 'pt', format: 'a4' });
  const pageWidth = doc.internal.pageSize.getWidth();
  const pageHeight = doc.internal.pageSize.getHeight();
  const margin = 40;
  let y = margin;

  // Title
  doc.setFontSize(16);
  doc.setFont('helvetica', 'bold');
  doc.text('Welile — Field Collection Daily Totals', margin, y);
  y += 22;

  doc.setFontSize(10);
  doc.setFont('helvetica', 'normal');
  doc.text(`Date: ${dateLabel}`, margin, y);
  y += 14;
  if (agentName) {
    doc.text(`Agent: ${agentName}`, margin, y);
    y += 14;
  }
  doc.text(`Generated: ${format(new Date(), 'PPpp')}`, margin, y);
  y += 20;

  // Headline total — easy for non-technical readers
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(20);
  doc.text(formatUGX(summary.total), margin, y);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(10);
  doc.setTextColor(110);
  doc.text(`Total collected · ${summary.captured} payment${summary.captured === 1 ? '' : 's'}`, margin, y + 14);
  doc.setTextColor(0);
  y += 36;

  // Status summary in plain language: Sent / Waiting / Needs review
  const needsReview = summary.failed.count + summary.duplicate.count;
  const needsReviewTotal = summary.failed.total + summary.duplicate.total;
  const statusRows: Array<[string, string, string, string]> = [
    ['Sent to office', 'Already in the system', String(summary.synced.count), formatUGX(summary.synced.total)],
    ['Waiting to send', 'Will sync when online', String(summary.pending.count), formatUGX(summary.pending.total)],
    ['Needs review', 'Failed or duplicate', String(needsReview), formatUGX(needsReviewTotal)],
  ];
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(11);
  doc.text('Status', margin, y);
  y += 14;
  doc.setFontSize(9);
  const sCol1 = margin;
  const sCol2 = margin + 130;
  const sCol3 = margin + 320;
  const sCol4 = margin + 380;
  doc.text('Status', sCol1, y);
  doc.text('Meaning', sCol2, y);
  doc.text('Count', sCol3, y);
  doc.text('Amount (UGX)', sCol4, y);
  y += 4;
  doc.line(margin, y, pageWidth - margin, y);
  y += 12;
  doc.setFont('helvetica', 'normal');
  for (const r of statusRows) {
    doc.text(r[0], sCol1, y);
    doc.setTextColor(110);
    doc.text(r[1], sCol2, y);
    doc.setTextColor(0);
    doc.text(r[2], sCol3, y);
    doc.text(r[3], sCol4, y);
    y += 14;
  }

  y += 10;
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(11);
  doc.text('Payments', margin, y);
  y += 14;

  // Entry table header — now includes a Reference column
  doc.setFontSize(9);
  const cTime = margin;
  const cTenant = margin + 60;
  const cAmount = margin + 200;
  const cStatus = margin + 280;
  const cRef = margin + 360;
  const cNotes = margin + 440;
  doc.text('Time', cTime, y);
  doc.text('Tenant', cTenant, y);
  doc.text('Amount', cAmount, y);
  doc.text('Status', cStatus, y);
  doc.text('Reference', cRef, y);
  doc.text('Notes', cNotes, y);
  y += 4;
  doc.line(margin, y, pageWidth - margin, y);
  y += 12;
  doc.setFont('helvetica', 'normal');

  const sorted = [...entries].sort((a, b) => a.capturedAt - b.capturedAt);
  if (sorted.length === 0) {
    doc.setTextColor(120);
    doc.text('No payments captured on this date.', margin, y);
    doc.setTextColor(0);
  } else {
    for (const e of sorted) {
      if (y > pageHeight - margin - 30) {
        doc.addPage();
        y = margin;
      }
      const time = format(new Date(e.capturedAt), 'HH:mm');
      const tenant = (e.tenantName || 'Walk-up').slice(0, 22);
      const amount = formatUGX(e.amount);
      const status = statusLabel(e.syncState);
      const ref = referenceFor(e);
      const notes = (e.notes || '').slice(0, 30);
      doc.text(time, cTime, y);
      doc.text(tenant, cTenant, y);
      doc.text(amount, cAmount, y);
      doc.text(status, cStatus, y);
      doc.setFont('courier', 'normal');
      doc.text(ref, cRef, y);
      doc.setFont('helvetica', 'normal');
      doc.text(notes, cNotes, y);
      y += 12;
    }
  }

  // Footer with page numbers + reference legend
  const total = doc.getNumberOfPages();
  for (let i = 1; i <= total; i++) {
    doc.setPage(i);
    doc.setFontSize(8);
    doc.setTextColor(140);
    doc.text(
      'RCT = server receipt · DUP = matched duplicate · LOC = local-only (not yet sent)',
      margin,
      pageHeight - margin / 2,
    );
    doc.text(
      `Page ${i} of ${total}`,
      pageWidth - margin,
      pageHeight - margin / 2,
      { align: 'right' },
    );
    doc.setTextColor(0);
  }

  doc.save(`field-collections-${dateFile}.pdf`);
}

/* ─────────────────────────────────────────────────────────────────────────
 * Date-range exports (week / month / custom)
 * Same totals + reference column conventions as the daily exports, plus a
 * per-day breakdown so the agent can spot quiet days at a glance.
 * ───────────────────────────────────────────────────────────────────────── */

function entriesForDay(all: FieldEntry[], day: Date): FieldEntry[] {
  return all.filter(e => isSameDay(new Date(e.capturedAt), day));
}

export function exportRangeTotalsCsv({ startDate, endDate, agentName, entries }: RangeTotalsExportInput) {
  const summary = summarize(entries);
  const startLabel = format(startDate, 'yyyy-MM-dd');
  const endLabel = format(endDate, 'yyyy-MM-dd');
  const lines: string[] = [];

  lines.push(`Welile Field Collection — Range Totals`);
  lines.push(`From,${escapeCsv(startLabel)}`);
  lines.push(`To,${escapeCsv(endLabel)}`);
  if (agentName) lines.push(`Agent,${escapeCsv(agentName)}`);
  lines.push(`Generated,${escapeCsv(new Date().toISOString())}`);
  lines.push('');
  lines.push('Bucket,Count,Amount (UGX)');
  lines.push(`Captured,${summary.captured},${summary.total}`);
  lines.push(`Synced,${summary.synced.count},${summary.synced.total}`);
  lines.push(`Pending,${summary.pending.count},${summary.pending.total}`);
  lines.push(`Failed,${summary.failed.count},${summary.failed.total}`);
  lines.push(`Duplicate,${summary.duplicate.count},${summary.duplicate.total}`);
  lines.push('');

  // Per-day breakdown
  lines.push('Day,Date,Count,Total (UGX),Sent,Waiting,Needs Review');
  for (const day of eachDayOfInterval({ start: startDate, end: endDate })) {
    const dayEntries = entriesForDay(entries, day);
    const s = summarize(dayEntries);
    const needsReview = s.failed.count + s.duplicate.count;
    lines.push([
      escapeCsv(format(day, 'EEE')),
      escapeCsv(format(day, 'yyyy-MM-dd')),
      s.captured,
      s.total,
      s.synced.count,
      s.pending.count,
      needsReview,
    ].join(','));
  }
  lines.push('');

  // Itemised entries
  lines.push('Captured At,Tenant,Phone,Amount (UGX),Status,Reference,Notes,Client ID');
  const sorted = [...entries].sort((a, b) => a.capturedAt - b.capturedAt);
  for (const e of sorted) {
    lines.push([
      escapeCsv(format(new Date(e.capturedAt), 'yyyy-MM-dd HH:mm:ss')),
      escapeCsv(e.tenantName || ''),
      escapeCsv(e.tenantPhone || ''),
      e.amount,
      escapeCsv(statusLabel(e.syncState)),
      escapeCsv(referenceFor(e)),
      escapeCsv(e.notes || ''),
      escapeCsv(e.id),
    ].join(','));
  }

  const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8;' });
  triggerDownload(blob, `field-collections-${startLabel}_to_${endLabel}.csv`);
}

export function exportRangeTotalsPdf({ startDate, endDate, agentName, entries, rangeLabel }: RangeTotalsExportInput) {
  const summary = summarize(entries);
  const startLabel = format(startDate, 'PPP');
  const endLabel = format(endDate, 'PPP');
  const startFile = format(startDate, 'yyyy-MM-dd');
  const endFile = format(endDate, 'yyyy-MM-dd');
  const doc = new jsPDF({ unit: 'pt', format: 'a4' });
  const pageWidth = doc.internal.pageSize.getWidth();
  const pageHeight = doc.internal.pageSize.getHeight();
  const margin = 40;
  let y = margin;

  // Helper: ensure room before drawing a row, otherwise add a page
  const ensureRoom = (rowHeight = 14) => {
    if (y > pageHeight - margin - rowHeight) {
      doc.addPage();
      y = margin;
    }
  };

  // ─── Title ───
  doc.setFontSize(16);
  doc.setFont('helvetica', 'bold');
  doc.text('Welile — Field Collection Range Totals', margin, y);
  y += 22;

  doc.setFontSize(10);
  doc.setFont('helvetica', 'normal');
  doc.text(`Range: ${startLabel} → ${endLabel}${rangeLabel ? `  (${rangeLabel})` : ''}`, margin, y);
  y += 14;
  if (agentName) {
    doc.text(`Agent: ${agentName}`, margin, y);
    y += 14;
  }
  doc.text(`Generated: ${format(new Date(), 'PPpp')}`, margin, y);
  y += 20;

  // ─── Headline total ───
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(20);
  doc.text(formatUGX(summary.total), margin, y);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(10);
  doc.setTextColor(110);
  doc.text(`Total collected · ${summary.captured} payment${summary.captured === 1 ? '' : 's'}`, margin, y + 14);
  doc.setTextColor(0);
  y += 36;

  // ─── Status summary (matches daily layout) ───
  const needsReview = summary.failed.count + summary.duplicate.count;
  const needsReviewTotal = summary.failed.total + summary.duplicate.total;
  const statusRows: Array<[string, string, string, string]> = [
    ['Sent to office', 'Already in the system', String(summary.synced.count), formatUGX(summary.synced.total)],
    ['Waiting to send', 'Will sync when online', String(summary.pending.count), formatUGX(summary.pending.total)],
    ['Needs review', 'Failed or duplicate', String(needsReview), formatUGX(needsReviewTotal)],
  ];
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(11);
  doc.text('Status', margin, y);
  y += 14;
  doc.setFontSize(9);
  const sCol1 = margin;
  const sCol2 = margin + 130;
  const sCol3 = margin + 320;
  const sCol4 = margin + 380;
  doc.text('Status', sCol1, y);
  doc.text('Meaning', sCol2, y);
  doc.text('Count', sCol3, y);
  doc.text('Amount (UGX)', sCol4, y);
  y += 4;
  doc.line(margin, y, pageWidth - margin, y);
  y += 12;
  doc.setFont('helvetica', 'normal');
  for (const r of statusRows) {
    doc.text(r[0], sCol1, y);
    doc.setTextColor(110);
    doc.text(r[1], sCol2, y);
    doc.setTextColor(0);
    doc.text(r[2], sCol3, y);
    doc.text(r[3], sCol4, y);
    y += 14;
  }

  // ─── Per-day breakdown ───
  y += 10;
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(11);
  doc.text('Per-day breakdown', margin, y);
  y += 14;
  doc.setFontSize(9);
  const dCol1 = margin;             // Day
  const dCol2 = margin + 60;        // Date
  const dCol3 = margin + 170;       // Count
  const dCol4 = margin + 220;       // Total
  const dCol5 = margin + 340;       // Sent
  const dCol6 = margin + 390;       // Waiting
  const dCol7 = margin + 460;       // Needs review
  doc.text('Day', dCol1, y);
  doc.text('Date', dCol2, y);
  doc.text('Count', dCol3, y);
  doc.text('Total', dCol4, y);
  doc.text('Sent', dCol5, y);
  doc.text('Waiting', dCol6, y);
  doc.text('Review', dCol7, y);
  y += 4;
  doc.line(margin, y, pageWidth - margin, y);
  y += 12;
  doc.setFont('helvetica', 'normal');

  for (const day of eachDayOfInterval({ start: startDate, end: endDate })) {
    ensureRoom(12);
    const dayEntries = entriesForDay(entries, day);
    const s = summarize(dayEntries);
    const review = s.failed.count + s.duplicate.count;
    const muted = s.captured === 0;
    if (muted) doc.setTextColor(160);
    doc.text(format(day, 'EEE'), dCol1, y);
    doc.text(format(day, 'yyyy-MM-dd'), dCol2, y);
    doc.text(String(s.captured), dCol3, y);
    doc.text(formatUGX(s.total), dCol4, y);
    doc.text(String(s.synced.count), dCol5, y);
    doc.text(String(s.pending.count), dCol6, y);
    doc.text(String(review), dCol7, y);
    if (muted) doc.setTextColor(0);
    y += 12;
  }

  // ─── Itemised payments (same columns as daily PDF + a Date column) ───
  y += 14;
  ensureRoom(40);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(11);
  doc.text('Payments', margin, y);
  y += 14;

  doc.setFontSize(9);
  const cDate = margin;
  const cTime = margin + 70;
  const cTenant = margin + 110;
  const cAmount = margin + 240;
  const cStatus = margin + 310;
  const cRef = margin + 370;
  const cNotes = margin + 450;
  doc.text('Date', cDate, y);
  doc.text('Time', cTime, y);
  doc.text('Tenant', cTenant, y);
  doc.text('Amount', cAmount, y);
  doc.text('Status', cStatus, y);
  doc.text('Reference', cRef, y);
  doc.text('Notes', cNotes, y);
  y += 4;
  doc.line(margin, y, pageWidth - margin, y);
  y += 12;
  doc.setFont('helvetica', 'normal');

  const sorted = [...entries].sort((a, b) => a.capturedAt - b.capturedAt);
  if (sorted.length === 0) {
    doc.setTextColor(120);
    doc.text('No payments captured in this range.', margin, y);
    doc.setTextColor(0);
  } else {
    for (const e of sorted) {
      ensureRoom(12);
      const d = new Date(e.capturedAt);
      doc.text(format(d, 'MM-dd'), cDate, y);
      doc.text(format(d, 'HH:mm'), cTime, y);
      doc.text((e.tenantName || 'Walk-up').slice(0, 22), cTenant, y);
      doc.text(formatUGX(e.amount), cAmount, y);
      doc.text(statusLabel(e.syncState), cStatus, y);
      doc.setFont('courier', 'normal');
      doc.text(referenceFor(e), cRef, y);
      doc.setFont('helvetica', 'normal');
      doc.text((e.notes || '').slice(0, 26), cNotes, y);
      y += 12;
    }
  }

  // ─── Footer ───
  const total = doc.getNumberOfPages();
  for (let i = 1; i <= total; i++) {
    doc.setPage(i);
    doc.setFontSize(8);
    doc.setTextColor(140);
    doc.text(
      'RCT = server receipt · DUP = matched duplicate · LOC = local-only (not yet sent)',
      margin,
      pageHeight - margin / 2,
    );
    doc.text(
      `Page ${i} of ${total}`,
      pageWidth - margin,
      pageHeight - margin / 2,
      { align: 'right' },
    );
    doc.setTextColor(0);
  }

  doc.save(`field-collections-${startFile}_to_${endFile}.pdf`);
}
