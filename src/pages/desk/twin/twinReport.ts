import { STATUS_LABEL, copy, copyDeep, eat, int, orderChecks, orderNeeds, orderRulings, screenLabel, ugx, type HistoryDay, type Twin } from './twinModel';

/**
 * Keep and share: a Markdown report of what is on screen, and a self-contained
 * offline HTML copy built from public/twin-offline-template.html. Both are made
 * in the browser from the payload already loaded; nothing is sent anywhere.
 */

const cell = (v: unknown) => String(v ?? '').replace(/\|/g, '/').replace(/\r?\n/g, ' ');

export function toMarkdown(t: Twin, loadedAt: number | null): string {
  const p = t.payload;
  const k = p.kpis;
  const m = p.money;
  const c = p.chain30;
  const tt = p.totals;
  const names = new Map(p.nodes.map((n) => [n.id, n.name]));
  const lanesByKey = new Map(p.lanes.map((l) => [l.key, copy(l.label)]));
  const L: string[] = [];
  L.push(`# Welile digital twin`, '', `${screenLabel(t, loadedAt)}  `, `Window: ${p.windowLabel}  `, `Built: ${eat(t.runAt)}`, '');
  if (p.reconstructed && p.note) L.push(`> ${copy(p.note)}`, '');
  if (p.redacted.includes('partner')) L.push('> Partner detail is limited to the COO, CEO and CFO.', '');

  if (p.lanes.length) {
    L.push('## Lanes', '', '| Lane | Owner | Nodes | Gaps | Checks failed | Gap checks failed |', '|---|---|---|---|---|---|');
    p.lanes.forEach((l) => L.push(`| ${cell(copy(l.label))} | ${cell(l.owner)} | ${l.nodes} | ${l.gap} | ${l.failed} of ${l.checks} | ${l.gap_failed} |`));
    L.push('');
  }
  if (!p.reconstructed) {
    L.push('## Totals', '', '| Measure | Count |', '|---|---|');
    (
      [
        ['Nodes', tt.nodes], ['Objects', tt.objects], ['Actions', tt.actions], ['Links', tt.links], ['Verified', tt.verified], ['Partial', tt.partial],
        ['Gap', tt.gap], ['Draft', tt.draft], ['Not started', tt.not_started], ['Checks failed', `${int(tt.checks_failed)} of ${int(tt.checks)}`], ['Decisions open', tt.needs_open],
      ] as [string, unknown][]
    ).forEach(([a, b]) => L.push(`| ${a} | ${typeof b === 'number' ? int(b) : cell(b ?? '—')} |`));
    L.push('');
  }
  L.push('## The 24 hours', '', '| Measure | Value |', '|---|---|');
  (
    [
      ['Submitted / resubmitted', `${int(k.submitted)} / ${int(k.resubmitted)}`],
      ['Service Centre pass / reject', `${int(k.sc_pass)} / ${int(k.sc_reject)}`],
      ['Agent Ops pass / back', `${int(k.ao_pass)} / ${int(k.ao_back)}`],
      ['Tenant Ops pass / back', `${int(k.to_pass)} / ${int(k.to_back)}`],
      ['Landlord Ops pass / back', `${int(k.lo_pass)} / ${int(k.lo_back)}`],
      ['COO push / back / demoted', `${int(k.coo_push)} / ${int(k.coo_back)} / ${int(k.demoted)}`],
      ['Funded', `${int(m.funded_n)} (${ugx(m.funded_ugx)})`],
      ['Recalled', int(k.recalled)],
      ['Landlord payouts completed', `${int(m.landlord_paid_n)} (${ugx(m.landlord_paid_ugx)})`],
      ['Withdrawals paid', `${int(m.withdrawals_n)} (${ugx(m.withdrawals_ugx)})`],
      ['Promissory notes entered', `${int(m.promissory_new_n)} (${ugx(m.promissory_new_ugx)})`],
      ['Ledger in / out', `${ugx(m.gl_in)} / ${ugx(m.gl_out)}`],
      ['30-day funded', `${int(c.funded_n)} (${ugx(c.funded_ugx)})`],
      ['30-day with funder claim', int(c.funder_claim)],
      ['30-day landlord paid within 24 h', int(c.paid_24h)],
      ['Median days submit to funding', c.median_days ?? '—'],
    ] as [string, unknown][]
  ).forEach(([a, b]) => L.push(`| ${a} | ${cell(b)} |`));

  L.push('', '## Checks that failed, with recommendations', '');
  const failed = orderChecks(p.checks).filter((x) => !x.ok);
  if (!failed.length) L.push('Every check passed in this window.');
  failed.forEach((x) =>
    L.push(
      `- **${x.severity === 'gap' ? 'Gap' : 'Watch'}: ${copy(x.label)}** = ${int(x.value)}${x.detail ? ` (${copy(x.detail)})` : ''}. Recommendation: ${copy(x.rec)}${x.owner ? ` Owner: ${x.owner}.` : ''}`,
    ),
  );

  if (p.needs.length) {
    L.push('', '## Decisions waiting', '');
    orderNeeds(p.needs).forEach((n) => {
      const tags = [n.priority === 1 ? 'answer first' : null, lanesByKey.get(n.lane) ?? n.lane, n.kind === 'rule' ? 'a rule to set' : null, n.source ? `raised by ${n.source}` : null]
        .filter(Boolean)
        .join(', ');
      L.push(`${n.id}. ${copy(n.question)} (${tags})`);
      if (n.lean) L.push(`   - Recommendation: ${copy(n.lean)}`);
      if (n.evidence) L.push(`   - Evidence: ${copy(n.evidence)}`);
    });
  }
  if (p.rulings.length) {
    L.push('', '## Rulings in force', '');
    orderRulings(p.rulings).forEach((r) => {
      const tags = [lanesByKey.get(r.lane) ?? r.lane, r.kind === 'rule' ? 'a rule' : 'a decision', r.source || null, r.decidedAt ? `decided ${eat(r.decidedAt)}` : null]
        .filter(Boolean)
        .join(', ');
      L.push(`- **${copy(r.question)}**: ${copy(r.ruling)} (${tags})${r.nodes.length ? ` Applies to ${r.nodes.map((id) => names.get(id) ?? id).join(', ')}.` : ''}`);
    });
  }
  if (p.nodes.length) {
    L.push('', '## Nodes', '', '| ID | Name | Type | Lane | Status | Owner | Evidence | Note |', '|---|---|---|---|---|---|---|---|');
    p.nodes.forEach((n) =>
      L.push(`| ${[n.id, n.name, n.kind, n.lane, STATUS_LABEL[n.status], n.owner, n.source, copy(n.note)].map(cell).join(' | ')} |`),
    );
  }
  if (p.links.length) {
    L.push('', '## Links', '', '| # | From | Link | To |', '|---|---|---|---|');
    p.links.forEach((l) => L.push(`| ${cell(l.id)} | ${cell(names.get(l.from) ?? l.from)} | ${cell(l.label)} | ${cell(names.get(l.to) ?? l.to)} |`));
  }
  return `${L.join('\n')}\n`;
}

/** The contract the offline template reads from its snapshot tag. */
export type OfflineSnapshot = { run_id: string | null; run_at: string | null; payload: unknown; history: unknown[] };

export function offlineSnapshot(t: Twin, history: HistoryDay[], loadedAt: number | null): OfflineSnapshot {
  return {
    run_id: t.runId ?? `live ${screenLabel(t, loadedAt).replace(/^Live, /, '')}`,
    run_at: t.runAt,
    payload: copyDeep(t.raw),
    history: history.map((h) => ({ run_id: h.runId, run_at: h.runAt, reconstructed: h.reconstructed, totals: h.totals, kpis: h.kpis, money: h.money })),
  };
}

const SNAPSHOT_RE = /(<script type="application\/json" id="snapshot">)([\s\S]*?)(<\/script>)/;

const LINE_SEP = new RegExp(String.fromCharCode(0x2028), 'g');
const PARA_SEP = new RegExp(String.fromCharCode(0x2029), 'g');

/** JSON that is safe inside a <script> element: no "</script>", no "<!--", no line separators. */
export function scriptSafeJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(LINE_SEP, '\\u2028')
    .replace(PARA_SEP, '\\u2029');
}

/** Put the snapshot into the template. Throws when the template has no snapshot tag. */
export function fillOfflineTemplate(template: string, snapshot: OfflineSnapshot): string {
  if (!SNAPSHOT_RE.test(template)) throw new Error('The offline template has no snapshot tag.');
  const json = scriptSafeJson(snapshot);
  return template.replace(SNAPSHOT_RE, (_m, open: string, _old: string, close: string) => `${open}${json}${close}`);
}

export function downloadText(filename: string, text: string, type: string) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
