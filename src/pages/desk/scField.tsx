import { useMemo, useState, type ReactNode } from 'react';
import { CALM, FOCUS, LABEL } from './deskTheme';
import { fmt } from './format';
import { Chip, EmptyState, ErrorLine, LoadingRows, SEG_ACTIVE, SEG_IDLE, Sheet, moneyFull, stackLayout } from './ui';
import { CallButtons } from './arrears/ArrearsParts';
import { plainError } from './arrears/arrearsApi';
import { DeskPrefsProvider, useDeskPrefs } from './deskPrefs';
import { AT_SC, groupOf, useScFieldBoard, type ScFieldGroup, type ScFieldRow } from './scFieldApi';

/**
 * E133: the Service Centre for FIELD AGENTS — a simple, phone-first view of
 * their own and their recruited agents' requests, so they can chase their
 * team. Read-only: Pass, Send back and Waiting stay with Service Centre staff,
 * who keep the full desk.
 *
 *   rpc('sc_field_board') → { allowed, reason?, message?, team_agents,
 *     rows: [{ rent_request_id, ref, tenant { name, phone }, agent { id, name, phone, is_me },
 *              rent, where, to_fix, days_waiting, missing: string[], desk_note }] }
 *
 * The data, the staff test and the menu's check live in scFieldApi.ts.
 * `allowed: false` (AGENTS_ONLY, or HEADS_ONLY once that switch is on) hides
 * the menu entry and the screen says so.
 */

type Person = ScFieldRow['tenant'];
const GROUP_LABEL: Record<ScFieldGroup, string> = { fix: 'To fix', sc: 'At Service Centre', further: 'Further along' };
const GROUPS: ScFieldGroup[] = ['fix', 'sc', 'further'];
const EMPTY: Record<ScFieldGroup, string> = {
  fix: 'Nothing to fix in your team.',
  sc: 'Nothing of your team is at the Service Centre.',
  further: 'Nothing of your team is further along yet.',
};

const daysText = (n: number | null | undefined) => (n === null || n === undefined ? '—' : `${fmt('int', n)} ${n === 1 ? 'day' : 'days'}`);
const agentName = (a: Person) => (a?.is_me ? 'You' : a?.name ?? 'Agent');
const missingOf = (r: ScFieldRow) => (r.missing ?? []).filter((m) => typeof m === 'string' && m.trim());

function WherePill({ row }: { row: ScFieldRow }) {
  const tone = row.to_fix ? 'bad' : row.where === AT_SC ? 'warn' : 'idle';
  return (
    <Chip tone={tone} size="sm" strong={!!row.to_fix}>
      <span data-sc-field-where>{row.where ?? '—'}</span>
    </Chip>
  );
}

function MissingChips({ row }: { row: ScFieldRow }) {
  const m = missingOf(row);
  if (!m.length) return null;
  return (
    <span style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }} data-sc-field-missing>
      {m.map((x) => (
        <Chip key={x} tone="bad">
          {x}
        </Chip>
      ))}
    </span>
  );
}

function FieldCard({ row, onOpen }: { row: ScFieldRow; onOpen: () => void }) {
  const tenant = row.tenant?.name ?? 'Tenant';
  const agent = agentName(row.agent);
  return (
    <li
      data-sc-field-card={row.rent_request_id}
      className="desk-panel"
      style={{ listStyle: 'none', padding: 12, display: 'flex', flexDirection: 'column', gap: 8, minWidth: 0, cursor: 'pointer' }}
      // The card opens its summary; the Call links inside keep their own tap.
      onClick={(e) => {
        if ((e.target as HTMLElement).closest('a,button')) return;
        onOpen();
      }}
    >
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
        <button
          type="button"
          onClick={onOpen}
          aria-label={`Open the summary for ${tenant}`}
          className="text-left text-base font-semibold text-foreground underline-offset-2 hover:underline"
          style={{ padding: 0, border: 0, background: 'none', minWidth: 0, overflowWrap: 'anywhere', minHeight: 32 }}
          data-sc-field-open
        >
          {tenant}
        </button>
        <CallButtons phone={row.tenant?.phone} who={`tenant ${tenant}`} />
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
        <span className="text-sm text-foreground" style={{ minWidth: 0, overflowWrap: 'anywhere' }}>
          <span className={LABEL}>Agent </span>
          <span data-sc-field-agent>{agent}</span>
        </span>
        {!row.agent?.is_me && <CallButtons phone={row.agent?.phone} who={`agent ${agent}`} />}
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8 }}>
        <WherePill row={row} />
        <span className="text-sm tabular-nums text-muted-foreground" data-sc-field-days>
          {daysText(row.days_waiting)}
        </span>
      </div>
      <MissingChips row={row} />
      {row.to_fix && row.desk_note && (
        <p className="text-sm text-foreground" style={{ margin: 0, overflowWrap: 'anywhere' }} data-sc-field-note>
          <span className={LABEL}>Desk note </span>
          {row.desk_note}
        </p>
      )}
    </li>
  );
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', gap: 8 }}>
      <span className={LABEL}>{label}</span>
      <span className="text-sm text-foreground" style={{ textAlign: 'right', overflowWrap: 'anywhere', minWidth: 0 }}>
        {children}
      </span>
    </div>
  );
}

/** Read-only: what the request is, where it sits and what it lacks. No actions. */
function FieldSummary({ row, onClose }: { row: ScFieldRow; onClose: () => void }) {
  const tenant = row.tenant?.name ?? 'Tenant';
  const agent = agentName(row.agent);
  return (
    <Sheet title={tenant} onClose={onClose}>
      <div style={stackLayout(12)} data-sc-field-summary={row.rent_request_id}>
        <Fact label="Request">
          <span className="font-mono">{row.ref ?? '—'}</span>
        </Fact>
        <Fact label="Rent">
          <span className="tabular-nums">{moneyFull(row.rent)}</span>
        </Fact>
        <Fact label="Where">
          <WherePill row={row} />
        </Fact>
        <Fact label="Waiting">{daysText(row.days_waiting)}</Fact>
        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
          <span className="text-sm text-foreground">
            <span className={LABEL}>Tenant </span>
            {tenant}
          </span>
          <CallButtons phone={row.tenant?.phone} whatsapp who={`tenant ${tenant}`} />
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
          <span className="text-sm text-foreground">
            <span className={LABEL}>Agent </span>
            {agent}
          </span>
          {!row.agent?.is_me && <CallButtons phone={row.agent?.phone} whatsapp who={`agent ${agent}`} />}
        </div>
        {missingOf(row).length > 0 && (
          <div style={stackLayout(6)}>
            <span className={LABEL}>Missing</span>
            <MissingChips row={row} />
          </div>
        )}
        {row.to_fix && row.desk_note && (
          <div style={stackLayout(4)}>
            <span className={LABEL}>Why it was sent back</span>
            <p className="text-sm text-foreground" style={{ margin: 0, overflowWrap: 'anywhere' }}>
              {row.desk_note}
            </p>
          </div>
        )}
        <p className={LABEL} style={{ margin: 0 }}>
          Service Centre staff pass or send back requests. Chase your agent to fix what is missing.
        </p>
      </div>
    </Sheet>
  );
}

/** The whole screen: header, three chips, the cards. Nothing else. */
export function ScFieldView() {
  const q = useScFieldBoard();
  const rows = useMemo(() => q.data?.rows ?? [], [q.data]);
  const counts = useMemo(() => {
    const c: Record<ScFieldGroup, number> = { fix: 0, sc: 0, further: 0 };
    for (const r of rows) c[groupOf(r)] += 1;
    return c;
  }, [rows]);
  const [picked, setPicked] = useState<ScFieldGroup | null>(null);
  // First open: the first group with something in it, "To fix" first.
  const group: ScFieldGroup = picked ?? GROUPS.find((g) => counts[g] > 0) ?? 'fix';
  const [open, setOpen] = useState<ScFieldRow | null>(null);
  const shown = rows.filter((r) => groupOf(r) === group);

  return (
    <section style={stackLayout(12)} data-sc-field aria-label="Service Centre — my agents">
      <h1 className="text-xl font-semibold text-foreground" style={{ margin: 0 }}>
        Service Centre — my agents
      </h1>
      {q.isLoading ? (
        <LoadingRows rows={4} height={72} label="Loading your team's requests" />
      ) : q.error ? (
        <ErrorLine>Your team's requests could not load: {plainError(q.error, {})}</ErrorLine>
      ) : q.data && !q.data.allowed ? (
        <EmptyState>{q.data.message ?? 'This view is not open to your account.'}</EmptyState>
      ) : (
        <>
          <p className="text-sm text-foreground" style={{ margin: 0 }} data-sc-field-header>
            Your team: {fmt('int', q.data?.team_agents ?? 0)} agents · {fmt('int', rows.length)} requests
          </p>
          {/* Three chips that wrap on a phone (never a dropdown, never a sideways scroll). */}
          <div role="group" aria-label="Show" data-sc-field-chips style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            {GROUPS.map((g) => {
              const on = g === group;
              return (
                <button
                  key={g}
                  type="button"
                  aria-pressed={on}
                  onClick={() => setPicked(g)}
                  className={`desk-pill border px-3.5 text-sm ${on ? SEG_ACTIVE : SEG_IDLE} ${CALM} ${FOCUS}`}
                  style={{ minHeight: 40 }}
                  data-sc-field-chip={g}
                >
                  {GROUP_LABEL[g]} <span className="tabular-nums">({fmt('int', counts[g])})</span>
                </button>
              );
            })}
          </div>
          {shown.length === 0 ? (
            <EmptyState>{EMPTY[group]}</EmptyState>
          ) : (
            <ol style={{ display: 'flex', flexDirection: 'column', gap: 10, margin: 0, padding: 0 }}>
              {shown.map((r) => (
                <FieldCard key={r.rent_request_id} row={r} onOpen={() => setOpen(r)} />
              ))}
            </ol>
          )}
        </>
      )}
      {open && <FieldSummary row={open} onClose={() => setOpen(null)} />}
    </section>
  );
}

function ScFieldPageBody() {
  const { rootTheme } = useDeskPrefs();
  return (
    <div className="desk-root min-h-screen" data-desk-theme={rootTheme}>
      <main className="mx-auto w-full min-w-0 max-w-2xl px-4 py-4">
        <ScFieldView />
      </main>
    </div>
  );
}

/** `/agent/service-centre`: the same view as its own page, in the desk's look (light unless the viewer chose dark). */
export default function ScFieldPage() {
  return (
    <DeskPrefsProvider>
      <ScFieldPageBody />
    </DeskPrefsProvider>
  );
}
