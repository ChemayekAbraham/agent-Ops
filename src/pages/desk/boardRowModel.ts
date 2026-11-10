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
    case 'assign_agent':
      return 'Assign an agent';
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

/* ───────────── Landlord Ops phone card (≤ 430 px and the card layout) ───────────── */

/** The active Landlord Ops checklist (pipeline_check_catalog, stage landlord_ops): eight call checks. */
export const LANDLORD_CHECKS_TOTAL = 8;

/** "N days here": amber over 2 days, red over 5. */
export function daysHere(days: number | null | undefined): { text: string; tone: Status } {
  const d = Number(days ?? 0);
  const n = Math.max(0, Math.floor(Number.isFinite(d) ? d : 0));
  const text = n === 0 ? 'Today' : `${n} ${n === 1 ? 'day' : 'days'} here`;
  return { text, tone: d > 5 ? 'bad' : d > 2 ? 'warn' : 'idle' };
}

/** The last four digits of a phone number, or null. */
export function phoneLast4(phone: string | null | undefined): string | null {
  const digits = String(phone ?? '').replace(/\D/g, '');
  return digits.length >= 4 ? digits.slice(-4) : null;
}

/**
 * How many of the eight landlord checks are settled. The board knows it three ways:
 * a decided row carries the results in its push; a "complete" row says
 * "finish N check(s)"; a row still waiting for an answered call has none.
 */
export function landlordChecks(row: BoardRow): { done: number | null; total: number } {
  const total = LANDLORD_CHECKS_TOTAL;
  const settled = (row.push?.results ?? []).filter((r) => r.code.startsWith('lo_') && (r.result === 'pass' || r.result === 'fail')).length;
  if (settled > 0) return { done: Math.min(settled, total), total };
  if (row.decision === 'complete') {
    const m = /finish (\d+) check/i.exec(row.why ?? '');
    return { done: m ? Math.max(0, total - Number(m[1])) : null, total };
  }
  if (row.decision === 'call' || row.decision === 'call_again') return { done: 0, total };
  return { done: null, total };
}

const LC1_NOTE = /LC1 not (yet )?confirmed/i;

/**
 * The Landlord Ops card's one chip row:
 *   Landlord checks X/8 · Tenant OK (or the failing flag) · LC1 not confirmed
 *   · Repaid before: N% / First plan · Agent grade C / New agent
 */
export function landlordOpsChips(row: BoardRow, health?: TenantHealth): ChipModel[] {
  const out: ChipModel[] = [];
  const c = landlordChecks(row);
  out.push({
    key: 'checks',
    text: `Landlord checks ${c.done ?? '–'}/${c.total}`,
    tone: c.done === c.total ? 'ok' : c.done ? 'warn' : 'idle',
  });

  const f = row.flags;
  if (f.passes >= f.total) out.push({ key: 'tenant', text: 'Tenant OK', tone: 'ok' });
  else {
    const first = f.flags.find((x) => !x.ok && x.level !== 'info') ?? f.flags.find((x) => !x.ok);
    out.push({ key: 'tenant', text: first?.label ?? f.failing[0] ?? 'Tenant check failed', tone: f.hard_fail ? 'bad' : 'warn', title: first?.detail ?? undefined });
  }

  const lc1 = f.notes.find((n) => LC1_NOTE.test(n));
  if (lc1) out.push({ key: 'lc1', text: 'LC1 not confirmed', tone: 'warn', title: lc1 });

  if (health) {
    const pct = health.completed_repaid_pct;
    if ((health.completed_plans ?? 0) > 0 && pct !== null && pct !== undefined) {
      const p = Math.round(Number(pct));
      out.push({ key: 'repaid', text: `Repaid before: ${p}%`, tone: p >= 90 ? 'ok' : p >= 60 ? 'warn' : 'bad', title: health.summary ?? undefined });
    } else out.push({ key: 'repaid', text: 'First plan', tone: 'idle', title: health.summary ?? undefined });
  }

  const g = row.agent_grade;
  if (g) out.push({ key: 'grade', text: `Agent grade ${g}`, tone: g === 'A' || g === 'B' ? 'ok' : g === 'C' ? 'warn' : 'bad' });
  else out.push({ key: 'grade', text: 'New agent', tone: 'idle' });
  return out;
}
