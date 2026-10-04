// Short branded email body for the Agent Ops Comprehensive Report.
// The full report travels as the PDF attachment — the email only summarises it.

type Any = any;

const n = (v: unknown) => Math.round(Number(v) || 0);
const num = (v: unknown) => n(v).toLocaleString();
const ugx = (v: unknown) => `UGX ${n(v).toLocaleString()}`;
const pos = (v: number) => Math.max(0, v);
const rate = (part: number, whole: number) => (whole > 0 ? `${((part / whole) * 100).toFixed(1)}%` : '—');
const esc = (s: string) => s.replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c] as string));

export function buildReportSummaryEmail(input: {
  report: Any;
  population?: Any;
  fromDate: string;
  toDate: string;
  periodLabel: string;
  attachmentName: string | null;
  pdfError?: string | null;
}): { html: string; text: string } {
  const { report, population, fromDate, toDate, periodLabel, attachmentName, pdfError } = input;
  const rentRows: Any[] = report?.rent_rows || [];
  const advRows: Any[] = report?.advance_rows || [];
  const rent = report?.rent ?? {};
  const adv = report?.advances ?? {};
  const sc = report?.service_centres ?? {};

  const perAgentExpected = (r: Any) => Number(r.expected_cumulative) || Number(r.daily_receivable) || 0;
  const collected = rentRows.reduce((s, r) => s + (Number(r.collected_today) || 0), 0);
  const expected = rentRows.reduce((s, r) => s + perAgentExpected(r), 0);
  const outstanding = rentRows.reduce((s, r) => s + pos(Number(r.outstanding) || 0), 0);
  const agentsCollected = rentRows.filter((r) => (Number(r.collected_today) || 0) > 0).length;
  const recovered = advRows.reduce((s, r) => s + (Number(r.recovered) || 0), 0);
  const advOutstanding = pos(Number(adv.outstanding) || 0);
  const networkSize = population ? n(population.total) : rentRows.length;
  const activeAgents = population ? n(population.active) : n(report?.agents?.active_today);

  const window = fromDate === toDate ? fromDate : `${fromDate} to ${toDate}`;

  const rows: [string, string, string][] = [
    ['Rent collected', ugx(collected), `${num(agentsCollected)} of ${num(rentRows.length)} agents collected`],
    ['Rent expected', expected > 0 ? ugx(expected) : '—', expected > 0 ? `${rate(collected, expected)} collection rate` : 'not exposed'],
    ['Rent outstanding', ugx(outstanding), `${num(rent.collections_today)} collection transactions`],
    ['Advances outstanding', ugx(advOutstanding), `${ugx(recovered)} recovered · ${ugx(adv.issued_today)} issued`],
    ['Service centres', num(sc.active_total), `${num(sc.pending_total)} applications pending`],
    ['Agent network', num(networkSize), `${num(activeAgents)} active in the period`],
  ];

  const rowsHtml = rows.map(([label, value, hint]) => `
    <tr>
      <td style="padding:9px 12px;border-bottom:1px solid #E5E7EB;font:600 13px/1.4 Arial,sans-serif;color:#374151;">${esc(label)}</td>
      <td style="padding:9px 12px;border-bottom:1px solid #E5E7EB;font:700 13px/1.4 Arial,sans-serif;color:#111827;text-align:right;white-space:nowrap;">${esc(value)}</td>
      <td style="padding:9px 12px;border-bottom:1px solid #E5E7EB;font:400 11px/1.4 Arial,sans-serif;color:#6B7280;text-align:right;">${esc(hint)}</td>
    </tr>`).join('');

  const attachmentNote = attachmentName
    ? `<p style="margin:16px 0 0;font:400 13px/1.6 Arial,sans-serif;color:#374151;">The full comprehensive report — network position, agent-level collections, advance portfolio, service centres, products and definitions — is attached as <strong>${esc(attachmentName)}</strong>.</p>`
    : `<p style="margin:16px 0 0;padding:10px 12px;background:#FEF2F2;border:1px solid #FECACA;font:400 13px/1.6 Arial,sans-serif;color:#B91C1C;">The PDF attachment could not be generated for this run${pdfError ? `: ${esc(pdfError)}` : '.'} The figures above are still accurate; open the Comprehensive Report in Agent Operations for the full detail.</p>`;

  const html = `<!DOCTYPE html><html><body style="margin:0;padding:24px 12px;background:#F3F4F6;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:620px;margin:0 auto;background:#FFFFFF;border:1px solid #E5E7EB;border-radius:6px;overflow:hidden;">
    <tr><td style="background:#7B19D4;padding:18px 22px;">
      <div style="font:800 10px/1.3 Arial,sans-serif;letter-spacing:1.4px;color:#E9D5FF;">WELILE TECHNOLOGIES LIMITED</div>
      <div style="font:700 18px/1.3 Arial,sans-serif;color:#FFFFFF;margin-top:4px;">Agent Operations — Comprehensive Report</div>
      <div style="font:400 12px/1.4 Arial,sans-serif;color:#E9D5FF;margin-top:4px;">${esc(periodLabel)} · ${esc(window)} · Africa/Kampala</div>
    </td></tr>
    <tr><td style="padding:20px 22px;">
      <p style="margin:0 0 14px;font:400 13px/1.6 Arial,sans-serif;color:#374151;">Summary of agent operations for ${esc(window)}.</p>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;border-top:1px solid #E5E7EB;">
        ${rowsHtml}
      </table>
      ${attachmentNote}
      <p style="margin:18px 0 0;font:400 11px/1.5 Arial,sans-serif;color:#9CA3AF;">Automated report · figures reconcile to the on-screen Comprehensive Report for the same window. All amounts in UGX.</p>
    </td></tr>
  </table></body></html>`;

  const text = [
    `Welile Agent Operations — Comprehensive Report (${window})`,
    '',
    ...rows.map(([l, v, h]) => `${l}: ${v} (${h})`),
    '',
    attachmentName
      ? `Full report attached as ${attachmentName}.`
      : 'PDF attachment could not be generated for this run.',
  ].join('\n');

  return { html, text };
}
