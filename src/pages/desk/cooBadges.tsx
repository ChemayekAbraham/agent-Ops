import { useState, type ReactNode } from 'react';
import { CALM, FOCUS, LABEL, statusText } from './deskTheme';
import { DeskPopover, GradeBadge, Sheet, atLeast, gradeStyle, stackLayout, useBreakpoint } from './ui';
import { hoursUntil, ownerLabel, type BoardWaiting } from './boardApi';
import { timeLeftText } from './waitOn';
import type { ConcernSummary } from './concerns';
import { kindText, type RequestKind } from './KindChip';

/**
 * COO desk: every badge on a row explains itself (E74). A tap opens a small
 * panel — a popover from md, a bottom sheet on a phone — built only from the
 * fields `pipeline_coo_board` already sends. The pieces here are pure so the
 * wording is tested without a screen.
 */

/* ───────────────────────── the words ───────────────────────── */

export type RedFlag = { code: string; label: string | null; detail: string | null };
export type CooRatingsFull = {
  agent_ops: number | null;
  tenant_ops: number | null;
  landlord_ops: number | null;
  average: number | null;
  grade: string | null;
  partly_rated: boolean;
  /** Agent Ops is half its checks, half the agent's grade points. */
  agent_ops_checks?: number | null;
  agent_points?: number | null;
  rated_desks?: number | null;
};

/** The agent badge's words: grade X is a red flag, not a block — the push still goes. */
export function agentGradeText(grade: string | null | undefined): string {
  return (grade ?? '').trim().toUpperCase() === 'X' ? 'Red flag' : gradeStyle(grade).text;
}

/** "Collected 62% of what was due"; null when the server has no figure. */
export function agentPctText(pct: number | null | undefined): string | null {
  if (pct === null || pct === undefined || !Number.isFinite(Number(pct))) return null;
  return `Collected ${Math.round(Number(pct))}% of what was due`;
}

const DESKS: { key: 'agent_ops' | 'tenant_ops' | 'landlord_ops'; name: string; short: string }[] = [
  { key: 'agent_ops', name: 'Agent Ops', short: 'AO' },
  { key: 'tenant_ops', name: 'Tenant Ops', short: 'TO' },
  { key: 'landlord_ops', name: 'Landlord Ops', short: 'LO' },
];

/** Each desk's rating, or null when that desk has not rated yet. */
export function ratingRows(r: CooRatingsFull | null | undefined): { name: string; short: string; value: number | null }[] {
  return DESKS.map((d) => {
    const v = r?.[d.key];
    return { name: d.name, short: d.short, value: v === null || v === undefined || !Number.isFinite(Number(v)) ? null : Math.round(Number(v)) };
  });
}

/** The desks that have not rated this request yet, in pipeline order. */
export function notRatedDesks(r: CooRatingsFull | null | undefined): string[] {
  return ratingRows(r).filter((x) => x.value === null).map((x) => x.name);
}

/** The request grade's bands (E28): A ≥ 85, B ≥ 70, C ≥ 55, D below. */
export const GRADE_BANDS = 'A ≥ 85 · B ≥ 70 · C ≥ 55 · D below 55';

/** "12 Nov 2026" in Kampala; "—" with no date. */
export function kampalaDay(iso: string | null | undefined): string {
  if (!iso || !Number.isFinite(Date.parse(iso))) return '—';
  return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Africa/Kampala' });
}

/** A frozen row: why, since when, and the day it goes back to Agent Ops. */
export function frozenFacts(f: { reason: string | null; since: string | null; returns_to_agent_ops_at: string | null }) {
  return {
    reason: f.reason ?? 'No reason given',
    since: kampalaDay(f.since),
    returns: kampalaDay(f.returns_to_agent_ops_at),
  };
}

/** A held row: who it waits on, why, and when the hold ends. */
export function holdFacts(w: BoardWaiting, now = Date.now()) {
  const h = hoursUntil(w.until_at, now);
  const up = w.expired || (h ?? 1) <= 0;
  return {
    owner: ownerLabel(w.owner_kind, 'coo'),
    reason: w.note ?? w.reason_code ?? 'No reason given',
    until: kampalaDay(w.until_at),
    left: up ? 'Time up' : timeLeftText(h),
    up,
  };
}

/* ───────────────────────── the panel ───────────────────────── */

const TAP = `inline-flex items-center rounded-full ${CALM} ${FOCUS} hover:opacity-85`;
/** 44 px tall and wide: the badge sits inside a full-size tap target. */
const TAP_STYLE = { minHeight: 44, minWidth: 44, padding: '0 2px', border: 0, background: 'none', cursor: 'pointer', justifyContent: 'center' } as const;

/**
 * A badge that explains itself: the badge is the trigger; a popover from md,
 * a bottom sheet below. `label` names the panel for screen readers and is the
 * sheet's title.
 */
export function Explain({ label, badge, children }: { label: string; badge: ReactNode; children: ReactNode }) {
  const md = atLeast(useBreakpoint(), 'md');
  const [open, setOpen] = useState(false);
  if (md) {
    return (
      <DeskPopover label={label} trigger={badge} triggerClass={TAP} triggerStyle={TAP_STYLE}>
        {() => <span style={{ ...stackLayout(8), display: 'flex' }} data-explain>{children}</span>}
      </DeskPopover>
    );
  }
  return (
    <>
      <button type="button" aria-label={label} aria-haspopup="dialog" onClick={() => setOpen(true)} className={TAP} style={TAP_STYLE}>
        {badge}
      </button>
      {open && (
        <Sheet title={label} onClose={() => setOpen(false)}>
          <div style={stackLayout(10)} data-explain>
            {children}
          </div>
        </Sheet>
      )}
    </>
  );
}

const Row = ({ k, v, strong }: { k: string; v: ReactNode; strong?: boolean }) => (
  <span style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }} className="text-sm">
    <span className="text-muted-foreground">{k}</span>
    <span className={`tabular-nums text-foreground ${strong ? 'font-semibold' : ''}`} style={{ textAlign: 'right' }}>
      {v}
    </span>
  </span>
);
const Note = ({ children }: { children: ReactNode }) => (
  <span className={LABEL} style={{ display: 'block' }}>
    {children}
  </span>
);

/** The agent badge ("Red flag" for grade X) and why. */
export function AgentGradeBody({ grade, pct, flags }: { grade: string | null; pct: number | null | undefined; flags: RedFlag[] }) {
  const red = (grade ?? '').toUpperCase() === 'X';
  const p = agentPctText(pct);
  return (
    <>
      <Row k="Agent grade" v={<AgentGradeBadge grade={grade} />} />
      {p && <Row k="Collections" v={p} />}
      {red && (
        <>
          <span className={`text-sm font-semibold ${statusText.bad}`}>Red flags</span>
          {flags.length === 0 ? (
            <Note>The nightly agent grade raised a red flag; no detail was sent.</Note>
          ) : (
            <ul style={{ margin: 0, padding: 0, ...stackLayout(6) }} data-red-flags>
              {flags.map((f) => (
                <li key={f.code} style={{ listStyle: 'none' }} className="text-sm">
                  <span className="font-medium text-foreground">{f.label ?? f.code}</span>
                  {f.detail && <span className="block text-muted-foreground">{f.detail}</span>}
                </li>
              ))}
            </ul>
          )}
          <Note>A red flag does not block the push. It tells you to look before you send this to the funders.</Note>
        </>
      )}
    </>
  );
}

/** The kit's GradeBadge, except grade X reads "Red flag" on the COO rows. */
export function AgentGradeBadge({ grade }: { grade: string | null | undefined }) {
  if ((grade ?? '').trim().toUpperCase() !== 'X') return <GradeBadge grade={grade} />;
  const s = gradeStyle('X');
  return (
    <span data-grade="X" className={`desk-pill text-[11px] font-semibold leading-5 ${s.cls}`} style={{ display: 'inline-flex', alignItems: 'center', padding: '0 6px', borderRadius: 999, borderWidth: 1, borderStyle: 'solid', lineHeight: '20px', whiteSpace: 'nowrap' }}>
      Red flag
    </span>
  );
}

export function KindBody({ kind }: { kind: RequestKind }) {
  return (
    <>
      <span className="text-sm font-semibold text-foreground">{kind.label ?? kindText(kind)}</span>
      {kind.detail && <span className="text-sm text-foreground">{kind.detail}</span>}
      {kind.via && <Note>Came in via {kind.via}.</Note>}
      {kind.needs_agent && <Note>No agent yet: Agent Ops assigns one.</Note>}
    </>
  );
}

/** "AO · TO · LO" and "partly rated": each desk's rating and who has not rated yet. */
export function RatingsBody({ ratings }: { ratings: CooRatingsFull | null | undefined }) {
  const rows = ratingRows(ratings);
  const missing = notRatedDesks(ratings);
  const checks = ratings?.agent_ops_checks;
  const points = ratings?.agent_points;
  return (
    <>
      {rows.map((r) => (
        <Row key={r.short} k={`${r.name} (${r.short})`} v={r.value === null ? 'not rated yet' : r.value} />
      ))}
      {(checks !== null && checks !== undefined) || (points !== null && points !== undefined) ? (
        <Note>
          Agent Ops = half its checks{checks !== null && checks !== undefined ? ` (${Math.round(Number(checks))})` : ''}, half the agent&apos;s grade points
          {points !== null && points !== undefined ? ` (${Math.round(Number(points))})` : ''}.
        </Note>
      ) : null}
      {missing.length > 0 ? (
        <span className={`text-sm ${statusText.warn}`} data-not-rated>
          Not rated yet: {missing.join(', ')}
        </span>
      ) : (
        <Note>All three desks have rated it.</Note>
      )}
    </>
  );
}

/** The request grade circle: the average and the three ratings behind it. */
export function GradeBody({ grade, avg, ratings }: { grade: string | null; avg: number | null | undefined; ratings: CooRatingsFull | null | undefined }) {
  const a = avg ?? ratings?.average ?? null;
  return (
    <>
      <Row k="Request grade" v={<GradeBadge grade={grade} />} />
      <Row k="Average rating" v={a === null || a === undefined ? '—' : Math.round(Number(a))} strong />
      {ratingRows(ratings).map((r) => (
        <Row key={r.short} k={r.name} v={r.value === null ? 'not rated yet' : r.value} />
      ))}
      <Note>{GRADE_BANDS}. The average uses the desks that have rated.</Note>
    </>
  );
}

export function FrozenBody({ frozen, onAgent }: { frozen: { reason: string | null; since: string | null; returns_to_agent_ops_at: string | null }; onAgent?: () => void }) {
  const f = frozenFacts(frozen);
  return (
    <>
      <span className="text-sm text-foreground">{f.reason}</span>
      <Row k="Frozen since" v={f.since} />
      <Row k="Back to Agent Ops on" v={f.returns} strong />
      <Note>Frozen rows are never pushed. The agent&apos;s collections must come back above 50%.</Note>
      {onAgent && (
        <button type="button" onClick={onAgent} className={`text-left text-sm underline underline-offset-2 ${CALM} ${FOCUS}`} style={{ minHeight: 44, background: 'none', border: 0, padding: 0, cursor: 'pointer' }}>
          Open the agent&apos;s rent plans
        </button>
      )}
    </>
  );
}

export function HoldBody({ waiting }: { waiting: BoardWaiting }) {
  const h = holdFacts(waiting);
  return (
    <>
      <span className="text-sm text-foreground">{h.reason}</span>
      <Row k="Waiting on" v={h.owner} />
      <Row k="Until" v={h.until} />
      <Row k="Time left" v={<span className={h.up ? statusText.bad : undefined}>{h.left}</span>} strong />
      <Note>Held rows are not pushed until the hold ends or is cleared.</Note>
    </>
  );
}

export function ConcernBody({ summary, blocking }: { summary: ConcernSummary | null | undefined; blocking: boolean }) {
  const open = Number(summary?.open ?? 0);
  const serious = Number(summary?.serious ?? 0);
  return (
    <>
      <Row k="Open concerns" v={open} />
      <Row k="Serious" v={serious} strong />
      {summary?.latest && <span className="text-sm text-foreground">Latest: {summary.latest}</span>}
      <Note>{blocking ? 'A serious concern blocks the push until it is resolved in the review, or the row is held.' : 'Open concerns do not block the push; read them in the review.'}</Note>
    </>
  );
}

export function DemotedBody({ note }: { note: string | null | undefined }) {
  return (
    <>
      <span className="text-sm text-foreground">Demoted from the funders board.</span>
      {note && <span className="text-sm text-foreground">{note}</span>}
      <Note>Choose its level in &quot;Demoted from the funders board&quot; above. It is not pushed until then.</Note>
    </>
  );
}

export function FailingBody({ failing, passes, total }: { failing: string[]; passes: number | null | undefined; total: number | null | undefined }) {
  return (
    <>
      {passes !== null && passes !== undefined && total ? <Row k="Checks passed" v={`${passes} of ${total}`} strong /> : null}
      <ul style={{ margin: 0, padding: 0, ...stackLayout(4) }} data-failing>
        {failing.map((f) => (
          <li key={f} style={{ listStyle: 'none' }} className={`text-sm ${statusText.warn}`}>
            ✗ {f}
          </li>
        ))}
      </ul>
      <Note>These are the tenant checks the desks before you could not confirm.</Note>
    </>
  );
}
