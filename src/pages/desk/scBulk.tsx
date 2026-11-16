import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { rpc } from './reviewApi';
import { CALM, FOCUS, LABEL, statusText } from './deskTheme';
import { fmt } from './format';
import { DecisionButton, ErrorLine, Sheet, stackLayout } from './ui';
import type { BoardRow } from './boardApi';

/**
 * E120: Service Centre bulk Discard / Send back, `sc_bulk_decide`. The
 * officer ticks cards (one by one, the page, or everything matching the
 * filters), picks Discard (fake) or Send back to agent, gives a reason and a
 * note, and the server records a review per request under their staff ID.
 * The result says what was done and lists every request it skipped, with the
 * server's reason. The single-card Pass / Send back / Reject are unchanged.
 */

export const BULK_MAX = 500;
export type BulkDecision = 'reject' | 'send_back';
export const BULK_WORDS: Record<BulkDecision, string> = { reject: 'Discard (fake)', send_back: 'Send back to agent' };
export const SC_BULK_REASONS = [
  { code: 'FAKE_REQUEST', label: 'Fake request' },
  { code: 'STALE_REQUEST', label: 'Old / stale request' },
  { code: 'DUPLICATE_REQUEST', label: 'Duplicate' },
  { code: 'OTHER', label: 'Other' },
] as const;
export const NOTE_MIN = 10;

export type BulkFilter = { older: 7 | 30 | null; agent: string | null; search: string };
export const NO_FILTER: BulkFilter = { older: null, agent: null, search: '' };

/** The cards the filters keep: days at the desk, the agent, and a search over names, phones and the ref. */
export function filterRows(rows: BoardRow[], f: BulkFilter): BoardRow[] {
  const q = f.search.trim().toLowerCase();
  return rows.filter((r) => {
    if (f.older !== null && (r.days_here ?? 0) < f.older) return false;
    if (f.agent && r.agent_id !== f.agent) return false;
    if (q) {
      const hay = [r.tenant, r.tenant_phone, r.agent, r.agent_phone, r.landlord, r.landlord_phone, r.req].filter(Boolean).join(' ').toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

/** The agents on the loaded board, for the agent filter. */
export function agentsOf(rows: BoardRow[]): { id: string; name: string }[] {
  const m = new Map<string, string>();
  for (const r of rows) if (r.agent_id && !m.has(r.agent_id)) m.set(r.agent_id, r.agent ?? r.agent_id);
  return Array.from(m.entries())
    .map(([id, name]) => ({ id, name }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export type BulkResult = { done: number; failed: { id: string; error: string }[]; selected: number };

const INPUT = 'rounded-md border border-[var(--desk-line-color)] bg-[var(--desk-surface)] px-2 py-1.5 text-sm text-foreground';
const PILL = (on: boolean) =>
  `desk-pill border px-3 py-1 text-sm ${CALM} ${FOCUS} ${on ? 'border-[hsl(var(--primary)/0.6)] bg-[hsl(var(--primary)/0.18)] text-foreground' : 'border-[var(--desk-line-color)] bg-[var(--desk-surface)] text-muted-foreground'}`;

/** The filters and the two select-all buttons, above the list while Select is on. */
export function BulkFilters({
  filter,
  onFilter,
  agents,
  onSelectPage,
  onSelectMatching,
  pageCount,
  matchingCount,
  loadedNote,
}: {
  filter: BulkFilter;
  onFilter: (f: BulkFilter) => void;
  agents: { id: string; name: string }[];
  onSelectPage: () => void;
  onSelectMatching: () => void;
  pageCount: number;
  matchingCount: number;
  loadedNote: string | null;
}) {
  return (
    <div className="desk-panel" style={{ ...stackLayout(10), padding: 12 }} data-bulk-filters>
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'flex-end', gap: 10 }}>
        <div role="group" aria-label="Older than" style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {([null, 7, 30] as const).map((d) => (
            <button key={String(d)} type="button" aria-pressed={filter.older === d} className={PILL(filter.older === d)} onClick={() => onFilter({ ...filter, older: d })} data-older={d ?? 'any'}>
              {d === null ? 'Any age' : `Older than ${d} days`}
            </button>
          ))}
        </div>
        <label style={stackLayout(4)}>
          <span className={LABEL}>Agent</span>
          <select value={filter.agent ?? ''} onChange={(e) => onFilter({ ...filter, agent: e.target.value || null })} className={INPUT} data-agent-filter>
            <option value="">All agents</option>
            {agents.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        </label>
        <label style={{ ...stackLayout(4), flex: '1 1 200px' }}>
          <span className={LABEL}>Search</span>
          <input type="search" value={filter.search} onChange={(e) => onFilter({ ...filter, search: e.target.value })} placeholder="Tenant, agent, landlord, phone, ref" className={INPUT} aria-label="Search the board" />
        </label>
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8 }}>
        <DecisionButton variant="quiet" onClick={onSelectPage} disabled={pageCount === 0}>
          Select all on this page ({fmt('int', pageCount)})
        </DecisionButton>
        <DecisionButton variant="quiet" onClick={onSelectMatching} disabled={matchingCount === 0}>
          Select all matching ({fmt('int', Math.min(matchingCount, BULK_MAX))})
        </DecisionButton>
        {loadedNote && <span className={LABEL}>{loadedNote}</span>}
      </div>
    </div>
  );
}

/** "N selected", the two bulk buttons and Clear; sticks to the bottom of the screen. */
export function BulkBar({ count, onDecide, onClear, disabled }: { count: number; onDecide: (d: BulkDecision) => void; onClear: () => void; disabled?: boolean }) {
  if (count === 0) return null;
  return (
    <div
      className="desk-panel shadow-2xl"
      style={{ position: 'sticky', bottom: 8, zIndex: 20, display: 'flex', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: 8, padding: 12 }}
      role="region"
      aria-label="Bulk actions"
      data-bulk-bar
    >
      <span className="text-sm font-semibold text-foreground" data-selected-count>
        {fmt('int', count)} selected
      </span>
      <span style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
        <DecisionButton variant="quiet" onClick={onClear}>
          Clear
        </DecisionButton>
        <DecisionButton variant="warn" disabled={disabled} onClick={() => onDecide('send_back')}>
          {BULK_WORDS.send_back}
        </DecisionButton>
        <DecisionButton variant="danger" disabled={disabled} onClick={() => onDecide('reject')}>
          {BULK_WORDS.reject}
        </DecisionButton>
      </span>
    </div>
  );
}

const asIs = (e: unknown) => String((e as { message?: string } | null)?.message ?? e ?? 'Something went wrong.');

/**
 * The reason, the note (10 characters at least) and, for Discard, the red
 * warning; then one server call for all of them and the result.
 */
export function BulkDialog({
  decision,
  ids,
  tenantOf,
  onDone,
  onClose,
}: {
  decision: BulkDecision;
  ids: string[];
  /** A request's tenant, to name the skipped ones. */
  tenantOf: (id: string) => string | null;
  /** The ids the server did; the desk refreshes. */
  onDone: (doneIds: string[]) => void;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const [reason, setReason] = useState<string>('');
  const [note, setNote] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState<BulkResult | null>(null);
  const n = ids.length;
  const noteShort = note.trim().length < NOTE_MIN;

  const go = async () => {
    if (!reason) return setProblem('Choose a reason.');
    if (noteShort) return setProblem(`Write a note of at least ${NOTE_MIN} characters.`);
    setSaving(true);
    setProblem(null);
    const { data, error } = await rpc('sc_bulk_decide', { p_request_ids: ids, p_decision: decision, p_reason_code: reason, p_note: note.trim() });
    setSaving(false);
    if (error) return setProblem(asIs(error));
    const d = (data ?? {}) as Partial<BulkResult>;
    const failed = Array.isArray(d.failed) ? d.failed : [];
    const r: BulkResult = { done: Number(d.done ?? 0), failed, selected: Number(d.selected ?? n) };
    setResult(r);
    const skipped = new Set(failed.map((f) => f.id));
    onDone(ids.filter((id) => !skipped.has(id)));
    toast.success(`Done: ${fmt('int', r.done)} · Skipped: ${fmt('int', failed.length)}`);
    void qc.invalidateQueries({ queryKey: ['desk-feed'] });
  };

  if (result) {
    return (
      <Sheet title={BULK_WORDS[decision]} onClose={onClose}>
        <div style={stackLayout(10)} data-bulk-result>
          <p className="text-base font-semibold text-foreground" style={{ margin: 0 }} data-bulk-summary>
            Done: {fmt('int', result.done)} · Skipped: {fmt('int', result.failed.length)}
          </p>
          {result.failed.length > 0 && (
            <ul style={{ ...stackLayout(6), margin: 0, padding: 0, listStyle: 'none' }} aria-label="Skipped">
              {result.failed.map((f) => (
                <li key={f.id} className="text-sm" data-skipped={f.id}>
                  <span className="font-medium text-foreground">{tenantOf(f.id) ?? f.id.slice(0, 8).toUpperCase()}</span>
                  <span className={`${statusText.bad} ml-2`}>{f.error}</span>
                </li>
              ))}
            </ul>
          )}
          <div>
            <DecisionButton onClick={onClose}>Close</DecisionButton>
          </div>
        </div>
      </Sheet>
    );
  }

  return (
    <Sheet
      title={`${BULK_WORDS[decision]} · ${fmt('int', n)} ${n === 1 ? 'request' : 'requests'}`}
      onClose={onClose}
      footer={
        <div style={stackLayout(8)}>
          {problem && <ErrorLine>{problem}</ErrorLine>}
          <DecisionButton variant={decision === 'reject' ? 'danger' : 'warn'} disabled={saving || !reason || noteShort} onClick={() => void go()} data-bulk-confirm>
            {saving ? 'Working…' : `${BULK_WORDS[decision]} · ${fmt('int', n)}`}
          </DecisionButton>
        </div>
      }
    >
      <div style={stackLayout(14)}>
        <fieldset style={{ border: 0, margin: 0, padding: 0 }}>
          <legend className={LABEL}>Reason</legend>
          <div style={{ ...stackLayout(6), marginTop: 6 }}>
            {SC_BULK_REASONS.map((r) => (
              <label key={r.code} className="flex items-center gap-2 text-sm text-foreground">
                <input type="radio" name="bulk-reason" value={r.code} checked={reason === r.code} onChange={() => setReason(r.code)} data-reason={r.code} />
                {r.label}
              </label>
            ))}
          </div>
        </fieldset>
        <label style={stackLayout(4)}>
          <span className={LABEL}>Note (at least {NOTE_MIN} characters)</span>
          <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={3} className={INPUT} data-bulk-note />
          <span className={`text-xs ${noteShort ? 'text-muted-foreground' : statusText.ok}`}>
            {note.trim().length} / {NOTE_MIN}
          </span>
        </label>
        {decision === 'reject' && (
          <p className={`rounded-md border border-[hsl(var(--destructive)/0.6)] bg-[hsl(var(--destructive)/0.12)] p-3 text-sm font-semibold ${statusText.bad}`} style={{ margin: 0 }} role="alert" data-discard-warning>
            These {fmt('int', n)} requests will be rejected for good and will NOT go back to the agent.
          </p>
        )}
      </div>
    </Sheet>
  );
}
