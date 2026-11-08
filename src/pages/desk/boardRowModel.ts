import type { Status } from './deskTheme';
import type { Stage } from './reviewTypes';
import { healthChip, type TenantHealth } from './paymentHealth';
import { concernsChip, type ConcernSummary } from './concerns';
import { eligibilityChip, flagsChip, GROUP_LABEL, ownerWords, primaryLabel, triesToday, type BoardDecision, type BoardRow } from './boardApi';
import { daysShort, moneyCard, plainReason, splitDecisionLabel } from './ui';

/**
 * What one board row shows, worked out once and drawn two ways: a RowCard
 * below md, a compact grid row from md up. Pure, so the wording is tested
 * without a screen.
 */

export type ChipModel = { key: string; text: string; tone: Status; title?: string; strong?: boolean };

/**
 * The row's chips, most important first. The card shows three and counts the
 * rest as "+n":
 *   1. eligibility (Agent Ops) or payment health (Tenant / Landlord Ops)
 *   2. concerns
 *   3. the checks ("5/5 ✓")
 *   then the August batch and "3 tries today".
 */
export function rowChips(row: BoardRow, stage: Stage, health?: TenantHealth, concerns?: ConcernSummary): ChipModel[] {
  const out: ChipModel[] = [];
  if (stage === 'agent_ops') {
    const e = eligibilityChip(row.eligibility);
    if (e) out.push({ key: 'elig', text: e.text, tone: e.tone });
  }
  if (stage === 'tenant_ops' || stage === 'landlord_ops') {
    const h = healthChip(health);
    if (h) out.push({ key: 'health', text: h.text, tone: h.tone, title: h.title });
  }
  const c = concernsChip(concerns);
  if (c) out.push({ key: 'concerns', text: c.text, tone: c.tone, title: c.title, strong: c.tone === 'bad' });
  const f = flagsChip(row.flags);
  out.push({
    key: 'flags',
    text: f.text,
    tone: f.ok ? 'ok' : 'warn',
    title: row.flags.flags.map((x) => `${x.ok ? '✓' : '✗'} ${x.label}${x.detail ? ` — ${x.detail}` : ''}`).join('\n') || undefined,
  });
  if (row.batch) out.push({ key: 'batch', text: 'Aug batch', tone: 'idle' });
  const tries = triesToday(row.call);
  if (tries) out.push({ key: 'tries', text: tries, tone: 'warn' });
  return out;
}

/**
 * The main button's short words and the line under it.
 *   transfer  → "Transfer", "Bena (82%, 2.4 km)"
 *   wait      → "Wait 48 h", "on Agent Ops lead"
 *   others    → "Call and fill", "Review photos", "Forward to COO" …
 * Null for a waiting row, which has no button.
 */
export function shortPrimary(row: BoardRow, stage: Stage): { label: string; detail: string | null } | null {
  if (row.decision === 'wait' && row.wait_suggest) {
    return { label: `Wait ${row.wait_suggest.hours} h`, detail: `on ${ownerWords(row.wait_suggest.owner_kind, stage)}` };
  }
  const full = primaryLabel(row, stage);
  if (!full) return null;
  return splitDecisionLabel(full);
}

/** "UGX 1.2M · 152 d" — whole days, short money. */
export function rowMeta(row: BoardRow): string {
  return `${moneyCard(row.rent)} · ${daysShort(row.days_here)}`;
}

/** The row's reason in plain words; rule codes go only to the tooltip. */
export function rowReason(row: BoardRow): { text: string; title: string | undefined } {
  const r = plainReason(row.why);
  const codes = Array.from(new Set([...(row.rule_id ? [row.rule_id] : []), ...r.codes]));
  const notes = row.flags.notes.length ? ` · ${row.flags.notes.join(' · ')}` : '';
  return { text: `${r.text}${notes}`.replace(/^ · /, ''), title: codes.length ? `Rule ${codes.join(', ')}` : undefined };
}

/** A group's sticky heading words: the same short words its rows' button uses. */
export function groupHeading(d: BoardDecision, stage: Stage): string {
  switch (d) {
    case 'pass':
      return stage === 'tenant_ops' ? 'Forward to Landlord Ops' : stage === 'landlord_ops' ? 'Forward to COO' : 'Pass';
    case 'complete':
      return stage === 'service_centre' || stage === 'agent_ops' ? 'Call and fill' : 'Finish checks';
    case 'call':
      return stage === 'landlord_ops' ? 'Call landlord' : 'Call tenant';
    default:
      return GROUP_LABEL[d];
  }
}

/** Rows grouped by decision, groups in the order the server first sends them, rows in server order. */
export function groupRows(rows: BoardRow[]): { decision: BoardDecision; rows: BoardRow[] }[] {
  const out: { decision: BoardDecision; rows: BoardRow[] }[] = [];
  const at = new Map<BoardDecision, number>();
  for (const r of rows) {
    let i = at.get(r.decision);
    if (i === undefined) {
      i = out.length;
      at.set(r.decision, i);
      out.push({ decision: r.decision, rows: [] });
    }
    out[i].rows.push(r);
  }
  return out;
}

/** Phones page the list 20 at a time. */
export const PHONE_PAGE = 20;
