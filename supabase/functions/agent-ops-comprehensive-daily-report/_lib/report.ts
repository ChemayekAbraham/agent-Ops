import { format } from 'https://esm.sh/date-fns@3.6.0';
import { AGENT_OPS_REPORT_CSS } from './agentOpsReportStyles.ts';
type ApsReport = any;

/**
 * Agent Operations Comprehensive Report.
 *
 * Renders the approved report template (same CSS, same page structure) filled
 * strictly with values returned by `get_agent_products_services_report`, so the
 * printed PDF matches the HTML template exactly.
 *
 * Data-integrity rules honoured here:
 *  - No metric is invented. Anything the RPC does not expose renders as
 *    "Data source pending mapping".
 *  - Money is never derived from transaction counts.
 *  - Outstanding is never allowed to go negative.
 *  - Every page uses the one reporting window passed in.
 */

export interface AgentPopulation {
  as_of?: string;
  /** Reporting window the activity figures were derived from. */
  window_from?: string;
  window_to?: string;
  total: number;
  /** Agents that recorded a collection inside the reporting window. */
  active: number;
  inactive: number;
  /** Agents that have ever collected (cumulative position, not window-scoped). */
  active_ever?: number;
  primary_total: number;
  primary_active: number;
  primary_inactive: number;
  sub_total: number;
  sub_active: number;
  sub_inactive: number;
  ever_collected: number;
  collected_in_period?: number;
  live_plan_agents: number;
  collected_last_30d: number;
  live_plan_no_collection: number;
  verified_subagent_links: number;
}


export interface AgentOpsReportInput {
  report: ApsReport;
  /** Preceding equal-length window, used only for variance columns. */
  prev?: ApsReport | null;
  /**
   * Canonical operational agent population from
   * `get_agent_operational_population`. An agent is a person who has actually
   * collected rent or currently carries a live (funded / repaying) plan — role
   * records are never counted. When absent, network rows render as pending.
   */
  population?: AgentPopulation | null;
  fromDate: string; // yyyy-MM-dd
  toDate: string;   // yyyy-MM-dd
  periodLabel: string;
  actor: string;
}


const PENDING = '<span class="unavailable">Data source pending mapping</span>';

const esc = (v: unknown) =>
  String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

const n = (v: unknown) => Math.round(Number(v) || 0);
const num = (v: unknown) => n(v).toLocaleString();
const ugx = (v: unknown) => `UGX ${n(v).toLocaleString()}`;
const pos = (v: number) => Math.max(0, v);
const pct = (part: number, whole: number) =>
  whole > 0 ? `${((part / whole) * 100).toFixed(1)}%` : '—';
const pctNum = (part: number, whole: number) => (whole > 0 ? (part / whole) * 100 : 0);
const dayLabel = (d?: string | null) =>
  d ? format(new Date(`${String(d).slice(0, 10)}T00:00:00`), 'dd MMM yyyy') : '—';

const variance = (current: number, previous: number | undefined) => {
  if (previous === undefined || previous === null) return PENDING;
  if (previous === 0) return current === 0 ? '0.0%' : 'New in period';
  const v = ((current - previous) / previous) * 100;
  const colour = v >= 0 ? 'var(--status-success)' : 'var(--status-danger)';
  return `<span style="color:${colour}">${v > 0 ? '+' : ''}${v.toFixed(1)}%</span>`;
};

const badge = (label: string, kind: 'pass' | 'warn' | 'fail') =>
  `<span class="doc-badge badge-${kind}">${esc(label)}</span>`;

// Non-collection rates (product/receivable recovery) keep the generic ladder.
const rateBadge = (rate: number) =>
  rate >= 90 ? badge('On track', 'pass') : rate >= 60 ? badge('Watch', 'warn') : badge('Attention', 'fail');


/**
 * Daily rent collection standing — aligned with the daily eligibility gate and the
 * rating ladder (see agent-collection-coverage-bug-2026-08-28_v2):
 * >= 75% Very Good, >= 50% Good (posting gate), >= 15% Fair, below that Attention.
 */
const collectionRateBadge = (rate: number) =>
  rate >= 75
    ? badge('Very good', 'pass')
    : rate >= 50
      ? badge('Good standing', 'pass')
      : rate >= 15
        ? badge('Watch', 'warn')
        : badge('Attention', 'fail');


function table(headers: { label: string; right?: boolean }[], rows: string[], empty: string) {
  if (!rows.length) {
    return `<p class="empty-state">${esc(empty)}</p>`;
  }
  return `<table class="report-table">
    <thead><tr>${headers
      .map(h => `<th class="${h.right ? 'right' : ''}">${esc(h.label)}</th>`)
      .join('')}</tr></thead>
    <tbody>${rows.join('')}</tbody>
  </table>`;
}

/** Inline SVG column chart — no CDN, so the print window renders offline. */
function barChart(
  series: { key: string; label: string; colour: string }[],
  points: Record<string, number | string>[],
  labelKey: string,
) {
  if (!points.length) return `<p class="empty-state">No activity recorded in this period.</p>`;
  const W = 660;
  const H = 180;
  const pad = { l: 46, r: 8, t: 10, b: 22 };
  const max = Math.max(
    1,
    ...points.flatMap(p => series.map(s => Number(p[s.key]) || 0)),
  );
  const innerW = W - pad.l - pad.r;
  const innerH = H - pad.t - pad.b;
  const slot = innerW / points.length;
  const barW = Math.max(1.5, (slot * 0.7) / series.length);

  const bars = points
    .map((p, i) =>
      series
        .map((s, j) => {
          const v = Number(p[s.key]) || 0;
          const h = (v / max) * innerH;
          const x = pad.l + i * slot + slot * 0.15 + j * barW;
          const y = pad.t + innerH - h;
          return `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${barW.toFixed(1)}" height="${Math.max(0, h).toFixed(1)}" fill="${s.colour}" />`;
        })
        .join(''),
    )
    .join('');

  const gridlines = [0, 0.25, 0.5, 0.75, 1]
    .map(f => {
      const y = pad.t + innerH - f * innerH;
      return `<line x1="${pad.l}" y1="${y}" x2="${W - pad.r}" y2="${y}" stroke="#E5E7EB" stroke-width="0.5" />
        <text x="${pad.l - 4}" y="${y + 3}" text-anchor="end" font-size="7" fill="#6B7280">${Math.round(max * f).toLocaleString()}</text>`;
    })
    .join('');

  const step = Math.ceil(points.length / 12);
  const xLabels = points
    .map((p, i) =>
      i % step === 0
        ? `<text x="${(pad.l + i * slot + slot / 2).toFixed(1)}" y="${H - 6}" text-anchor="middle" font-size="7" fill="#6B7280">${esc(p[labelKey])}</text>`
        : '',
    )
    .join('');

  const legend = series
    .map(
      s =>
        `<span class="legend-item"><span class="legend-swatch" style="background:${s.colour}"></span>${esc(s.label)}</span>`,
    )
    .join('');

  return `<div class="chart-legend">${legend}</div>
    <svg viewBox="0 0 ${W} ${H}" width="100%" height="180" role="img">${gridlines}${bars}${xLabels}</svg>`;
}

function pageShell(index: number, total: number, content: string, meta: string) {
  return `<article class="report-page">
    <div class="page-content">${content}</div>
    <footer class="report-footer">
      <span>${meta}</span>
      <span>Page ${index} of ${total}</span>
    </footer>
  </article>`;
}

export function buildAgentOpsComprehensiveReportHtml(input: AgentOpsReportInput): string {
  const { report, prev, population, fromDate, toDate, periodLabel, actor } = input;
  const generated = new Date();
  const refId = `AOR-${format(generated, 'yyyyMMdd-HHmm')}`;
  const periodText = `${dayLabel(fromDate)} – ${dayLabel(toDate)}`;
  const footerMeta = `Welile Technologies Limited · ${esc(periodText)} · ${esc(refId)}`;

  // ---------- Page 1: network + rent + exposure -----------------------------
  const agents = report.agents;
  const rent = report.rent;
  const adv = report.advances;
  const sc = report.service_centres;

  const subAgents = (report.new_agent_rows || []).filter((r: any) => r.agent_type === 'sub-agent').length;
  const rentRows = report.rent_rows || [];
  const expectedTotal = Number(rent.expected_cumulative) || 0;
  const collected = Number(rent.collected_today) || 0;
  const outstandingRent = pos(Number(rent.outstanding) || 0);
  const collectionRate = pctNum(collected, expectedTotal);
  const agentsCollected = rentRows.filter((r: any) => Number(r.collected_today) > 0).length;
  const agentsShort = rentRows.length - agentsCollected;

  // Canonical network figures. The reporting RPC's `agents.*` block counts a
  // much wider universe (every rent-request agent plus every recruited
  // sub-agent link), so it is never used for network size. Operational agent
  // = has collected rent, or carries a live funded / repaying plan.
  const networkTotal = population ? n(population.total) : null;
  const networkActive = population ? n(population.active) : null;
  const networkInactive = population ? n(population.inactive) : null;

  const narrative = `<strong>EXECUTIVE SUMMARY:</strong> Agent Operations recorded
    <strong class="currency">${ugx(collected)}</strong> in rent collections against
    <strong class="currency">${expectedTotal > 0 ? ugx(expectedTotal) : 'an expected amount that is pending mapping'}</strong>
    for ${esc(periodText)}${expectedTotal > 0 ? `, a <strong class="pct">${collectionRate.toFixed(1)}%</strong> collection rate` : ''}.
    ${networkTotal !== null
      ? `The operational agent network comprised <strong class="num">${num(networkTotal)}</strong> agents —
         <strong class="num">${num(networkActive)}</strong> active and
         <strong class="num">${num(networkInactive)}</strong> inactive — of which
         <strong class="num">${num(agents.active_today)}</strong> transacted inside this reporting window, managing`
      : `The network managed`}
    <strong class="num">${num(rent.live_plans)}</strong> live rent obligations.

    <strong class="currency">${ugx(outstandingRent)}</strong> of rent remained outstanding.
    Agent advances carried <strong class="currency">${ugx(adv.outstanding)}</strong> outstanding across
    <strong class="num">${num(adv.active_count)}</strong> repaying advances, and
    <strong class="num">${num(sc.active_total)}</strong> service centres were operational.`;

  const matrixRow = (
    category: string,
    kpi: string,
    value: string,
    target: string,
    varianceCell: string,
  ) =>
    `<tr><td>${esc(category)}</td><td>${esc(kpi)}</td><td class="right">${value}</td><td class="right">${target}</td><td class="right">${varianceCell}</td></tr>`;

  const page1 = `
    <header class="pdf-header">
      <div class="pdf-header-left">
        <span class="company-name">WELILE TECHNOLOGIES LIMITED</span>
        <h1 class="report-title-main">Agent Operations Comprehensive Report</h1>
      </div>
      <table class="pdf-header-meta-table">
        <tr><td class="meta-lbl">Reporting Period:</td><td class="meta-val">${esc(periodText)}</td></tr>
        <tr><td class="meta-lbl">Period Preset:</td><td class="meta-val">${esc(periodLabel)}</td></tr>
        <tr><td class="meta-lbl">Generated:</td><td class="meta-val">${esc(format(generated, 'dd MMM yyyy • HH:mm'))} EAT</td></tr>
        <tr><td class="meta-lbl">Data as of:</td><td class="meta-val">${esc(report.generated_at ? format(new Date(report.generated_at), 'dd MMM yyyy • HH:mm') : format(generated, 'dd MMM yyyy • HH:mm'))} EAT</td></tr>
        <tr><td class="meta-lbl">Prepared by:</td><td class="meta-val">${esc(actor)}</td></tr>
        <tr><td class="meta-lbl">Reference ID:</td><td class="meta-val font-mono">${esc(refId)}</td></tr>
      </table>
    </header>

    <div class="executive-summary-text">${narrative}</div>

    <h2 class="section-title">Executive Key Performance Indicators</h2>
    <div class="section-subtitle">All values are read from system records for the selected reporting window (${esc(periodText)}, EAT).</div>

    <table class="summary-matrix">
      <thead><tr>
        <th>Metric Category</th><th>Key Performance Indicator</th>
        <th class="right">Value / Total</th><th class="right">Reference</th><th class="right">Variance vs prior period</th>
      </tr></thead>
      <tbody>
        <tr class="group-row"><td colspan="5">1. AGENT NETWORK STRUCTURE</td></tr>
        ${population
          ? [
              matrixRow('Network size', 'Total operational agents (unique individuals)', `<span class="num">${num(population.total)}</span>`, `${num(population.ever_collected)} have ever collected`, `position as at ${esc(dayLabel(population.as_of || toDate))}`),
              matrixRow('Network status', 'Active agents (collected in period)', `<span class="num" style="color:var(--status-success)">${num(population.active)}</span>`, `${pct(n(population.active), n(population.total))} of network`, `${esc(dayLabel(population.window_from || fromDate))} – ${esc(dayLabel(population.window_to || toDate))}`),
              matrixRow('Network status', 'Inactive agents (no collection in period)', `<span class="num" style="color:var(--status-danger)">${num(population.inactive)}</span>`, `${pct(n(population.inactive), n(population.total))} of network`, `${num(population.active_ever ?? population.ever_collected)} have ever collected`),

              matrixRow('Primary agents', 'Primary agents (total / active in period / inactive)', `<span class="num">${num(population.primary_total)}</span> / <span class="num">${num(population.primary_active)}</span> / <span class="num">${num(population.primary_inactive)}</span>`, `${pct(n(population.primary_total), n(population.total))} of network`, `<span class="pct">${pct(n(population.primary_active), n(population.primary_total))} active</span>`),
              matrixRow('Sub-agents', 'Sub-agents register (total / active in period / inactive)', `<span class="num">${num(population.sub_total)}</span> / <span class="num">${num(population.sub_active)}</span> / <span class="num">${num(population.sub_inactive)}</span>`, `${num(population.verified_subagent_links)} verified links recruited`, `<span class="pct">${pct(n(population.sub_active), n(population.sub_total))} active</span>`),
              matrixRow('Collection coverage', 'Agents carrying a live rent plan', `<span class="num">${num(population.live_plan_agents)}</span>`, `${num(population.collected_last_30d)} collected in last 30 days`, `${num(population.live_plan_no_collection)} live plans with no collection in period`),

              matrixRow('Onboarding', 'Agents transacting in period', `<span class="num">${num(agents.active_today)}</span>`, `${num(agents.new_today)} newly qualified · ${num(subAgents)} sub-agent links`, variance(n(agents.active_today), prev ? n(prev.agents.active_today) : undefined)),
            ].join('')
          : `<tr><td colspan="5">${PENDING}</td></tr>`}


        <tr class="group-row"><td colspan="5">2. RENT OPERATIONS &amp; COLLECTIONS</td></tr>
        ${matrixRow('Financial volume', 'Total rent collected', `<span class="currency">${ugx(collected)}</span>`, expectedTotal > 0 ? `<span class="currency">${ugx(expectedTotal)}</span>` : PENDING, expectedTotal > 0 ? `<span class="pct">${collectionRate.toFixed(1)}% collection rate</span>` : PENDING)}
        ${matrixRow('Exposure', 'Outstanding rent balance', `<span class="currency" style="color:var(--status-danger)">${ugx(outstandingRent)}</span>`, `<span class="currency">UGX 0</span>`, variance(outstandingRent, prev ? pos(n(prev.rent.outstanding)) : undefined))}
        ${matrixRow('Obligations', 'Live rent plans under collection', `<span class="num">${num(rent.live_plans)}</span>`, `${num(rent.avg_days_outstanding)} avg days outstanding`, variance(n(rent.live_plans), prev ? n(prev.rent.live_plans) : undefined))}
        ${matrixRow('Agent fulfilment', 'Agents that collected in period', `<span class="num">${num(agentsCollected)}</span>`, `${num(rentRows.length)} with live plans`, pct(agentsCollected, rentRows.length))}

        <tr class="group-row"><td colspan="5">3. FINANCIAL EXPOSURE &amp; RECEIVABLES</td></tr>
        ${matrixRow('Advances', 'Agent advance outstanding balance', `<span class="currency">${ugx(adv.outstanding)}</span>`, `<span class="currency">${ugx(adv.issued_today)}</span> issued in period`, variance(n(adv.outstanding), prev ? n(prev.advances.outstanding) : undefined))}
        ${matrixRow('Service centres', 'Operational service centres', `<span class="num">${num(sc.active_total)}</span>`, `${num(sc.pending_total)} pending`, variance(n(sc.active_total), prev ? n(prev.service_centres.active_total) : undefined))}
        ${matrixRow('Motor bikes', 'Issued device receivable', `<span class="currency">${ugx(report.bikes.outstanding)}</span>`, `${num(report.bikes.issued_total)} issued`, variance(n(report.bikes.outstanding), prev ? n(prev.bikes.outstanding) : undefined))}
        ${matrixRow('Smartphones', 'Issued device receivable', `<span class="currency">${ugx(report.phones.outstanding)}</span>`, `${num(report.phones.issued_total)} issued`, variance(n(report.phones.outstanding), prev ? n(prev.phones.outstanding) : undefined))}
      </tbody>
    </table>

    <div class="methodology-box">
      <div class="methodology-title">Counting definitions &amp; date integrity</div>
      An <strong>operational agent</strong> is a person who has recorded at least one rent collection
      <strong>or</strong> currently carries at least one live (funded / repaying) rent plan. Holding the agent role is
      <strong>not</strong> counted — role records include tens of thousands of signup artefacts and are excluded.
      An agent is <strong>active</strong> when they collected within the last 30 days or hold a live plan, and
      <strong>inactive</strong> when they have neither. A <strong>sub-agent</strong> is identified by a verified
      parent link, not by role; recruited-but-never-operational links are excluded from the network total.
      Individuals are counted once by user ID, never by name or phone. Rent collected uses the collection timestamp,
      rent expected uses the scheduled daily obligation, advances use request / approval / repayment timestamps and
      service centres use the request timestamp. All day boundaries are Africa/Kampala (EAT).
    </div>`;


  // ---------- Page 2: rent collections --------------------------------------
  const perAgentExpected = (r: any) =>
    Number(r.expected_cumulative) || Number(r.daily_receivable) || 0;

  const collectionsRows = [...rentRows]
    .sort((a, b) => pos(Number(b.outstanding)) - pos(Number(a.outstanding)))
    .slice(0, 30)
    .map(r => {
      const exp = perAgentExpected(r);
      const got = Number(r.collected_today) || 0;
      const rate = pctNum(got, exp);
      return `<tr>
        <td>${esc(r.agent_name)}</td>
        <td class="font-mono">${esc(r.phone || '—')}</td>
        <td class="right num">${num(r.live_plans)}</td>
        <td class="right currency">${exp > 0 ? ugx(exp) : PENDING}</td>
        <td class="right currency">${ugx(got)}</td>
        <td class="right currency">${ugx(pos(Number(r.outstanding)))}</td>
        <td class="right pct">${exp > 0 ? `${rate.toFixed(1)}%` : '—'}</td>
        <td class="right num">${num(r.avg_days_outstanding)}</td>
        <td class="right">${exp > 0 ? collectionRateBadge(rate) : PENDING}</td>
      </tr>`;
    });

  const trend = [...(report.trend || [])].sort((a, b) => a.day.localeCompare(b.day)).map(t => ({
    label: format(new Date(`${t.day}T00:00:00`), 'dd MMM'),
    collected: Number(t.collected) || 0,
    advances_issued: Number(t.advances_issued) || 0,
    advances_deducted: Number(t.advances_deducted) || 0,
    new_agents: Number(t.new_agents) || 0,
    service_centres_added: Number(t.service_centres_added) || 0,
  }));

  const ranked = rentRows
    .map((r: any) => ({ r, exp: perAgentExpected(r), got: Number(r.collected_today) || 0 }))
    .filter((x: any) => x.exp > 0)
    .map((x: any) => ({ ...x, rate: pctNum(x.got, x.exp) }));

  const behaviourRow = (x: { r: any; exp: number; got: number; rate: number }) => `<tr>
    <td>${esc(x.r.agent_name)}</td>
    <td class="font-mono">${esc(x.r.phone || '—')}</td>
    <td class="right num">${num(x.r.live_plans)}</td>
    <td class="right currency">${ugx(x.exp)}</td>
    <td class="right currency">${ugx(x.got)}</td>
    <td class="right currency">${ugx(pos(x.exp - x.got))}</td>
    <td class="right pct">${x.rate.toFixed(1)}%</td>
  </tr>`;

  const best = [...ranked].sort((a, b) => b.rate - a.rate).slice(0, 5).map(behaviourRow);
  const attention = [...ranked].sort((a, b) => a.rate - b.rate).slice(0, 5).map(behaviourRow);

  const page2 = `
    <h2 class="section-title">Rent Collections</h2>
    <div class="section-subtitle">Expected rent obligations against actual collections for ${esc(periodText)}.</div>

    <table class="summary-matrix">
      <thead><tr><th>Indicator</th><th class="right">Value</th><th>Indicator</th><th class="right">Value</th></tr></thead>
      <tbody>
        <tr><td>Total rent collected</td><td class="right currency">${ugx(collected)}</td>
            <td>Expected rent (scheduled)</td><td class="right currency">${expectedTotal > 0 ? ugx(expectedTotal) : PENDING}</td></tr>
        <tr><td>Collection rate</td><td class="right pct">${expectedTotal > 0 ? `${collectionRate.toFixed(1)}%` : '—'}</td>
            <td>Missed / outstanding for period</td><td class="right currency">${expectedTotal > 0 ? ugx(pos(expectedTotal - collected)) : PENDING}</td></tr>
        <tr><td>Collection transactions</td><td class="right num">${num(rent.collections_today)}</td>
            <td>Portfolio outstanding balance</td><td class="right currency">${ugx(outstandingRent)}</td></tr>
        <tr><td>Agents collecting</td><td class="right num">${num(agentsCollected)} / ${num(rentRows.length)}</td>
            <td>Agents with no collection</td><td class="right num">${num(agentsShort)}</td></tr>
      </tbody>
    </table>

    <h3 class="chart-header-title">Collections by Agent</h3>
    <div class="chart-header-sub">Ranked by outstanding exposure. Top 30 of ${num(rentRows.length)} agents with live plans.</div>
    ${table(
      [
        { label: 'Agent' }, { label: 'Phone' }, { label: 'Plans', right: true },
        { label: 'Expected', right: true }, { label: 'Collected', right: true },
        { label: 'Outstanding', right: true }, { label: 'Collection rate', right: true },
        { label: 'Avg days', right: true }, { label: 'Status', right: true },
      ],
      collectionsRows,
      'No live rent receivables in this period.',
    )}

    <div class="chart-container-block avoid-break">
      <div class="chart-header-title">Rent Behaviour</div>
      <div class="chart-header-sub">Rent actually collected per day (collection timestamp, EAT). Per-day scheduled obligation is not exposed by the reporting source — shortfall is reported at period level above.</div>
      ${barChart([{ key: 'collected', label: 'Collected (UGX)', colour: '#7B19D4' }], trend, 'label')}
    </div>

    <h3 class="chart-header-title">Agent Payment Behaviour</h3>
    <div class="chart-header-sub">Ranked by collection rate against each agent's own expected daily obligation, not by absolute money collected. Standing follows the daily gate: 50%+ is good standing (agent can post), under 15% needs attention.</div>
    <div class="summary-card-title">Highest 5 by collection rate</div>
    ${table(
      [{ label: 'Agent' }, { label: 'Phone' }, { label: 'Tenants', right: true }, { label: 'Expected', right: true },
       { label: 'Paid', right: true }, { label: 'Outstanding', right: true }, { label: 'Collection rate', right: true }],
      best,
      'Expected amounts are unavailable for this window.',
    )}
    <div class="summary-card-title">Lowest 5 by collection rate</div>
    ${table(
      [{ label: 'Agent' }, { label: 'Phone' }, { label: 'Tenants', right: true }, { label: 'Expected', right: true },
       { label: 'Paid', right: true }, { label: 'Outstanding', right: true }, { label: 'Collection rate', right: true }],
      attention,
      'Expected amounts are unavailable for this window.',
    )}

    <div class="final-summary-grid avoid-break">
      <div class="summary-card">
        <div class="summary-card-title">Financial position</div>
        Expected ${expectedTotal > 0 ? ugx(expectedTotal) : '—'} · Collected ${ugx(collected)} ·
        Outstanding ${ugx(outstandingRent)} · Rate ${expectedTotal > 0 ? `${collectionRate.toFixed(1)}%` : '—'}
      </div>
      <div class="summary-card">
        <div class="summary-card-title">Coverage</div>
        ${num(agentsCollected)} of ${num(rentRows.length)} agents collected · ${num(rent.live_plans)} live plans ·
        ${num(rent.avg_days_outstanding)} average days outstanding
      </div>
    </div>`;

  // ---------- Page 3: advances ----------------------------------------------
  const advRows = report.advance_rows || [];
  const recovered = advRows.reduce((s: number, r: any) => s + (Number(r.recovered) || 0), 0);
  const advOutstanding = pos(Number(adv.outstanding) || 0);
  const recoveryRate = pctNum(recovered, recovered + advOutstanding);
  const agentsWithAdvances = new Set(advRows.map((r: any) => r.agent_name)).size;

  const advRow = (r: any) => `<tr>
    <td>${esc(r.agent_name)}</td>
    <td class="font-mono">${esc(r.phone || '—')}</td>
    <td class="right currency">${ugx(r.principal)}</td>
    <td class="right currency">${ugx(r.recovered)}</td>
    <td class="right currency">${ugx(pos(Number(r.outstanding)))}</td>
    <td class="right currency">${ugx(r.installment)}</td>
    <td class="right pct">${pct(Number(r.recovered) || 0, Number(r.principal) || 0)}</td>
    <td>${esc(r.issued_at ? dayLabel(r.issued_at) : '—')}</td>
    <td>${badge(String(r.status || 'unknown').replace(/_/g, ' '), r.status === 'completed' ? 'pass' : r.status === 'rejected' ? 'fail' : 'warn')}</td>
  </tr>`;

  const advRanked = advRows
    .map((r: any) => ({ r, rate: pctNum(Number(r.recovered) || 0, Number(r.principal) || 0) }))
    .filter((x: any) => (Number(x.r.principal) || 0) > 0);
  const advBest = [...advRanked].sort((a: any, b: any) => b.rate - a.rate).slice(0, 5).map((x: any) => advRow(x.r));
  const advWorst = [...advRanked].sort((a: any, b: any) => a.rate - b.rate).slice(0, 5).map((x: any) => advRow(x.r));

  const page3 = `
    <h2 class="section-title">Agent Advances</h2>
    <div class="section-subtitle">Exposure, approval status and repayment performance of advances issued to agents during ${esc(periodText)}.</div>

    <table class="summary-matrix">
      <thead><tr><th>Indicator</th><th class="right">Value</th><th>Indicator</th><th class="right">Value</th></tr></thead>
      <tbody>
        <tr><td>Advance principal issued in period</td><td class="right currency">${ugx(adv.issued_today)}</td>
            <td>Advances issued (count)</td><td class="right num">${num(adv.issued_count)}</td></tr>
        <tr><td>Outstanding advance balance</td><td class="right currency">${ugx(advOutstanding)}</td>
            <td>Active repaying advances</td><td class="right num">${num(adv.active_count)}</td></tr>
        <tr><td>Recovered (period rows)</td><td class="right currency">${ugx(recovered)}</td>
            <td>Recovery rate</td><td class="right pct">${recovered + advOutstanding > 0 ? `${recoveryRate.toFixed(1)}%` : '—'}</td></tr>
        <tr><td>Deducted in period</td><td class="right currency">${ugx(adv.deducted_today)}</td>
            <td>Agents holding advances</td><td class="right num">${num(agentsWithAdvances)}</td></tr>
      </tbody>
    </table>

    <table class="summary-matrix">
      <thead><tr><th>Application status</th><th class="right">Applications</th><th>Application status</th><th class="right">Applications</th></tr></thead>
      <tbody>
        <tr><td>Submitted</td><td class="right num">${num(adv.submitted)}</td><td>Approved</td><td class="right num">${num(adv.approved)}</td></tr>
        <tr><td>Rejected</td><td class="right num">${num(adv.rejected)}</td><td>Repaying</td><td class="right num">${num(adv.active_count)}</td></tr>
      </tbody>
    </table>

    <div class="chart-container-block avoid-break">
      <div class="chart-header-title">Advance Repayments vs Issuance</div>
      <div class="chart-header-sub">Principal issued (approval timestamp) against amounts recovered (repayment timestamp), per day.</div>
      ${barChart(
        [
          { key: 'advances_issued', label: 'Issued (UGX)', colour: '#B45309' },
          { key: 'advances_deducted', label: 'Recovered (UGX)', colour: '#15803D' },
        ],
        trend,
        'label',
      )}
    </div>

    <div class="summary-card-title">Best 5 repaying agents</div>
    ${table(
      [{ label: 'Agent' }, { label: 'Phone' }, { label: 'Principal', right: true }, { label: 'Repaid', right: true },
       { label: 'Outstanding', right: true }, { label: 'Installment', right: true }, { label: 'Recovery %', right: true },
       { label: 'Issued' }, { label: 'Status' }],
      advBest,
      'No advances recorded in this window.',
    )}
    <div class="summary-card-title">5 agents requiring attention</div>
    ${table(
      [{ label: 'Agent' }, { label: 'Phone' }, { label: 'Principal', right: true }, { label: 'Repaid', right: true },
       { label: 'Outstanding', right: true }, { label: 'Installment', right: true }, { label: 'Recovery %', right: true },
       { label: 'Issued' }, { label: 'Status' }],
      advWorst,
      'No advances recorded in this window.',
    )}`;

  // ---------- Page 4: service centres ---------------------------------------
  const scRows = report.service_centre_rows || [];
  const scTable = scRows.slice(0, 40).map((r: any) => `<tr>
    <td>${esc(r.location_name || '—')}</td>
    <td><div class="agent-stack"><span class="agent-stack-item">${esc(r.agent_name)}</span>
      <span class="agent-stack-sub font-mono">${esc(r.agent_phone || '—')}</span></div></td>
    <td>${esc(dayLabel(r.created_at))}</td>
    <td>${esc(r.verified_at ? dayLabel(r.verified_at) : '—')}</td>
    <td>${esc(r.approved_at ? dayLabel(r.approved_at) : '—')}</td>
    <td>${badge(String(r.status || 'unknown').replace(/_/g, ' '), ['active', 'approved', 'verified'].includes(String(r.status)) ? 'pass' : String(r.status) === 'rejected' ? 'fail' : 'warn')}</td>
  </tr>`);

  const page4 = `
    <h2 class="section-title">Service Centers</h2>
    <div class="section-subtitle">Operational overview of agent service centres for ${esc(periodText)}.</div>

    <table class="summary-matrix">
      <thead><tr><th>Indicator</th><th class="right">Value</th><th>Indicator</th><th class="right">Value</th></tr></thead>
      <tbody>
        <tr><td>Operational service centres</td><td class="right num">${num(sc.active_total)}</td>
            <td>Pending applications</td><td class="right num">${num(sc.pending_total)}</td></tr>
        <tr><td>Added in period</td><td class="right num">${num(sc.new_today)}</td>
            <td>Added this month</td><td class="right num">${num(sc.new_this_month)}</td></tr>
        <tr><td>Monthly target (${esc(sc.target_month || '—')})</td><td class="right num">${num(sc.monthly_target)}</td>
            <td>Target achievement</td><td class="right pct">${pct(n(sc.new_this_month), n(sc.monthly_target))}</td></tr>
        <tr><td>Approved financial value</td><td class="right">${PENDING}</td>
            <td>Service centre receivables</td><td class="right">${PENDING}</td></tr>
      </tbody>
    </table>

    <div class="chart-container-block avoid-break">
      <div class="chart-header-title">Service Centres Added</div>
      <div class="chart-header-sub">New service centre records per day (request timestamp, EAT).</div>
      ${barChart([{ key: 'service_centres_added', label: 'Service centres added', colour: '#7B19D4' }], trend, 'label')}
    </div>

    <h3 class="chart-header-title">Service Centres in period</h3>
    ${table(
      [{ label: 'Service centre / location' }, { label: 'Managing agent' }, { label: 'Requested' },
       { label: 'Verified' }, { label: 'Approved' }, { label: 'Status' }],
      scTable,
      'No service centre activity in this period.',
    )}`;

  // ---------- Page 5: products & services -----------------------------------
  const productRows = report.product_rows || [];
  const byProduct = new Map<string, typeof productRows>();
  for (const r of productRows) {
    const key = r.product === 'bike' ? 'Motor bikes' : r.product === 'smartphone' ? 'Smartphones' : 'Merchandise';
    if (!byProduct.has(key)) byProduct.set(key, []);
    byProduct.get(key)!.push(r);
  }

  const productSummary = [...byProduct.entries()].flatMap(([label, rows]: [string, any[]]) => {
    const issued = rows.filter((r: any) => r.is_issued);
    const value = issued.reduce((s: number, r: any) => s + (Number(r.value) || 0), 0);
    const paid = issued.reduce((s: number, r: any) => s + (Number(r.paid) || 0), 0);
    const out = issued.reduce((s: number, r: any) => s + pos(Number(r.outstanding) || 0), 0);
    const parent = `<tr class="parent-row">
      <td>${esc(label)}</td>
      <td class="right num">${num(rows.length)}</td>
      <td class="right num">${num(issued.length)}</td>
      <td class="right num">${num(rows.length - issued.length)}</td>
      <td class="right currency">${ugx(value)}</td>
      <td class="right currency">${ugx(paid)}</td>
      <td class="right currency">${ugx(out)}</td>
      <td class="right pct">${pct(paid, value)}</td>
    </tr>`;

    const byItem = new Map<string, typeof rows>();
    for (const r of rows) {
      const k = r.item_name || 'Unspecified';
      if (!byItem.has(k)) byItem.set(k, []);
      byItem.get(k)!.push(r);
    }
    const children = [...byItem.entries()].map(([item, items]: [string, any[]]) => {
      const iss = items.filter((r: any) => r.is_issued);
      const v = iss.reduce((s: number, r: any) => s + (Number(r.value) || 0), 0);
      const p = iss.reduce((s: number, r: any) => s + (Number(r.paid) || 0), 0);
      const o = iss.reduce((s: number, r: any) => s + pos(Number(r.outstanding) || 0), 0);
      return `<tr class="child-row">
        <td>→ ${esc(item)}</td>
        <td class="right num">${num(items.length)}</td>
        <td class="right num">${num(iss.length)}</td>
        <td class="right num">${num(items.length - iss.length)}</td>
        <td class="right currency">${ugx(v)}</td>
        <td class="right currency">${ugx(p)}</td>
        <td class="right currency">${ugx(o)}</td>
        <td class="right pct">${pct(p, v)}</td>
      </tr>`;
    });
    return [parent, ...children];
  });

  const page5 = `
    <h2 class="section-title">Agent Products &amp; Services</h2>
    <div class="section-subtitle">Application and financial performance of products issued to agents. Product and model lines are read from system records — nothing is hard-coded.</div>

    <table class="summary-matrix">
      <thead><tr><th>Indicator</th><th class="right">Motor bikes</th><th class="right">Smartphones</th></tr></thead>
      <tbody>
        <tr><td>Issued in period</td><td class="right num">${num(report.bikes.issued_today)}</td><td class="right num">${num(report.phones.issued_today)}</td></tr>
        <tr><td>Issued (cumulative in window)</td><td class="right num">${num(report.bikes.issued_total)}</td><td class="right num">${num(report.phones.issued_total)}</td></tr>
        <tr><td>Applications not yet issued</td><td class="right num">${num(report.bikes.pending_total ?? 0)}</td><td class="right num">${num(report.phones.pending_total ?? 0)}</td></tr>
        <tr><td>Total value (issued + pending issue)</td><td class="right currency">${ugx(report.bikes.total_value)}</td><td class="right currency">${ugx(report.phones.total_value)}</td></tr>
        <tr><td>Collected</td><td class="right currency">${ugx(report.bikes.paid)}</td><td class="right currency">${ugx(report.phones.paid)}</td></tr>
        <tr><td>Outstanding receivable</td><td class="right currency">${ugx(report.bikes.outstanding)}</td><td class="right currency">${ugx(report.phones.outstanding)}</td></tr>
        <tr><td>Collection rate</td><td class="right pct">${pct(n(report.bikes.paid), n(report.bikes.total_value))}</td><td class="right pct">${pct(n(report.phones.paid), n(report.phones.total_value))}</td></tr>
        <tr><td>Daily receivable</td><td class="right currency">${ugx(report.bikes.daily_receivable)}</td><td class="right currency">${ugx(report.phones.daily_receivable)}</td></tr>
      </tbody>
    </table>

    <h3 class="chart-header-title">Product / service performance</h3>
    <div class="chart-header-sub">Financial columns count issued units only; applications that were never handed over are reported separately.</div>
    ${table(
      [{ label: 'Product / model' }, { label: 'Applications', right: true }, { label: 'Issued', right: true },
       { label: 'Not issued', right: true }, { label: 'Approved principal', right: true },
       { label: 'Collected', right: true }, { label: 'Outstanding', right: true }, { label: 'Collection rate', right: true }],
      productSummary,
      'No product applications in this period.',
    )}`;

  // ---------- Page 6: agent performance -------------------------------------
  const floatRows = report.agent_float_rows || [];
  const rentByAgent = new Map(rentRows.map((r: any) => [r.agent_id, r]));
  const perf = floatRows
    .map((f: any) => {
      const r: any = rentByAgent.get(f.agent_id);
      const exp = r ? perAgentExpected(r) : 0;
      const got = Number(f.collections_amount) || 0;
      return { f, r, exp, rate: pctNum(got, exp), got };
    })
    .sort((a: any, b: any) => (b.rate - a.rate) || (b.got - a.got))
    .slice(0, 40)
    .map((x: any, i: number) => `<tr>
      <td class="right num">${i + 1}</td>
      <td>${esc(x.f.agent_name)}</td>
      <td class="font-mono">${esc(x.f.phone || '—')}</td>
      <td>${esc(x.f.location || '—')}</td>
      <td class="right num">${num(x.r?.live_plans ?? 0)}</td>
      <td class="right currency">${x.exp > 0 ? ugx(x.exp) : '—'}</td>
      <td class="right currency">${ugx(x.got)}</td>
      <td class="right num">${num(x.f.collections_count)}</td>
      <td class="right currency">${ugx(x.f.commission_balance)}</td>
      <td class="right pct">${x.exp > 0 ? `${x.rate.toFixed(1)}%` : '—'}</td>
      <td>${x.exp > 0 ? collectionRateBadge(x.rate) : PENDING}</td>
    </tr>`);

  const page6 = `
    <h2 class="section-title">Agent Performance</h2>
    <div class="section-subtitle">Field performance for ${esc(periodText)}, measured on recorded collections against each agent's own expected obligation. Leaderboard scoring is unchanged by this report.</div>

    <table class="summary-matrix">
      <thead><tr><th>Indicator</th><th class="right">Value</th><th>Indicator</th><th class="right">Value</th></tr></thead>
      <tbody>
        <tr><td>Agents with activity in period</td><td class="right num">${num(floatRows.length)}</td>
            <td>Agents that collected</td><td class="right num">${num(floatRows.filter((f: any) => Number(f.collections_count) > 0).length)}</td></tr>
        <tr><td>Total collected by agents</td><td class="right currency">${ugx(floatRows.reduce((s: number, f: any) => s + (Number(f.collections_amount) || 0), 0))}</td>
            <td>Collection transactions</td><td class="right num">${num(floatRows.reduce((s: number, f: any) => s + (Number(f.collections_count) || 0), 0))}</td></tr>
        <tr><td>Commission earned in period</td><td class="right currency">${ugx(floatRows.reduce((s: number, f: any) => s + (Number(f.commission_balance) || 0), 0))}</td>
            <td>Leaderboard score</td><td class="right">${PENDING}</td></tr>
      </tbody>
    </table>

    ${table(
      [{ label: 'Rank', right: true }, { label: 'Agent' }, { label: 'Phone' }, { label: 'Location' },
       { label: 'Plans', right: true }, { label: 'Expected', right: true }, { label: 'Collected', right: true },
       { label: 'Txns', right: true }, { label: 'Commission', right: true }, { label: 'Collection rate', right: true },
       { label: 'Status' }],
      perf,
      'No agent activity recorded in this period.',
    )}

    <div class="observation-callout">
      <strong>Auditability:</strong> every figure in this report is aggregated server-side from the agent operations
      reporting source for the window ${esc(periodText)} (EAT). Metrics with no authoritative source are marked
      "Data source pending mapping" rather than estimated.
    </div>`;

  const pages = [page1, page2, page3, page4, page5, page6];
  const body = pages.map((p, i) => pageShell(i + 1, pages.length, p, footerMeta)).join('');

  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Welile — Agent Operations Comprehensive Report (${esc(periodText)})</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800&family=JetBrains+Mono:wght@400;500;600&display=swap" rel="stylesheet">
<style>${AGENT_OPS_REPORT_CSS}
.unavailable { color: var(--text-muted); font-style: italic; font-size: 8.5px; }
.empty-state { font-size: 9.5px; color: var(--text-muted); border: 1px dashed var(--border-dark); padding: 10px; margin-bottom: 16px; }
.chart-legend { display: flex; gap: 14px; font-size: 9px; color: var(--text-muted); margin-bottom: 4px; }
.legend-item { display: inline-flex; align-items: center; gap: 4px; }
.legend-swatch { width: 8px; height: 8px; display: inline-block; border-radius: 1px; }
.report-toolbar { position: sticky; top: 0; z-index: 10; display: flex; gap: 8px; justify-content: center; padding: 10px; background: #0F172A; }
.report-toolbar button { font: inherit; font-weight: 700; font-size: 12px; padding: 8px 16px; border: 0; border-radius: 4px; background: var(--primary); color: #fff; cursor: pointer; }
@media print { .report-toolbar { display: none !important; } }
</style></head>
<body>
<div class="report-toolbar no-print"><button onclick="window.print()">Save as PDF / Print</button></div>
<main id="agent-operations-report" class="document-wrapper">${body}</main>
</body></html>`;
}

