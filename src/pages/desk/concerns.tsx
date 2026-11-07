import { useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { FOCUS, LABEL, PANEL, statusText, type Status } from './deskTheme';
import { readableError, rpc } from './reviewApi';
import { idsKey } from './paymentHealth';
import { Chip, DecisionButton, EmptyState, ErrorLine, LoadingRows, Segmented, rowLayout, stackLayout } from './ui';

/**
 * Concerns follow a request from desk to desk: any desk can log one (suspected
 * fraud, an inconsistent story…), and every later desk sees it — as a chip on
 * the board row and as a section in the drawer.
 */

export type ConcernDesk = 'service_centre' | 'agent_ops' | 'tenant_ops' | 'landlord_ops' | 'coo';
export type ConcernSeverity = 'note' | 'warning' | 'serious';
export type ConcernCategory = 'suspected_fraud' | 'inconsistent_story' | 'identity_doubt' | 'agent_pressure' | 'affordability' | 'other';

export const CONCERN_CATEGORIES: { value: ConcernCategory; label: string }[] = [
  { value: 'suspected_fraud', label: 'Suspected fraud' },
  { value: 'inconsistent_story', label: 'Inconsistent story' },
  { value: 'identity_doubt', label: 'Identity doubt' },
  { value: 'agent_pressure', label: 'Agent pressure' },
  { value: 'affordability', label: 'Affordability' },
  { value: 'other', label: 'Other' },
];

export const CONCERN_SEVERITIES: { value: ConcernSeverity; label: string; tone: Status }[] = [
  { value: 'note', label: 'Note', tone: 'idle' },
  { value: 'warning', label: 'Warning', tone: 'warn' },
  { value: 'serious', label: 'Serious', tone: 'bad' },
];

export const CONCERN_NOTE_MIN = 10;

const DESK_NAME: Record<string, string> = {
  service_centre: 'Service Centre',
  agent_ops: 'Agent Ops',
  tenant_ops: 'Tenant Ops',
  landlord_ops: 'Landlord Ops',
  coo: 'COO',
};

/* ───────────────────────── the board chip ───────────────────────── */

export type ConcernSummary = { open: number | null; serious: number | null; latest: string | null };
export type ConcernSummaryMap = Record<string, ConcernSummary>;

/** Red "⚠ 2 concerns" when any is serious, amber otherwise; null (hidden) when none is open. */
export function concernsChip(s: ConcernSummary | null | undefined): { text: string; tone: Status; title: string | undefined } | null {
  const open = Number(s?.open ?? 0);
  if (!s || open <= 0) return null;
  return {
    text: `⚠ ${open} ${open === 1 ? 'concern' : 'concerns'}`,
    tone: Number(s.serious ?? 0) > 0 ? 'bad' : 'warn',
    title: s.latest ?? undefined,
  };
}

/** One call per board load: `pipeline_concerns_summary` for every row on the board. */
export function useConcernsSummary(requestIds: (string | null | undefined)[], enabled = true) {
  const ids = idsKey(requestIds);
  return useQuery({
    queryKey: ['desk-feed', 'concerns-summary', ids.join(',')],
    enabled: enabled && ids.length > 0,
    queryFn: async (): Promise<ConcernSummaryMap> => {
      const { data, error } = await rpc('pipeline_concerns_summary', { p_request_ids: ids });
      if (error) throw error;
      return (data ?? {}) as ConcernSummaryMap;
    },
    staleTime: 30_000,
    retry: 1,
  });
}

export function ConcernsChip({ summary }: { summary: ConcernSummary | null | undefined }) {
  const c = concernsChip(summary);
  if (!c) return null;
  return (
    <Chip tone={c.tone} title={c.title} strong={c.tone === 'bad'}>
      {c.text}
    </Chip>
  );
}

/* ───────────────────────── the drawer section ───────────────────────── */

export type Concern = {
  id: string;
  desk: string | null;
  category: string | null;
  severity: ConcernSeverity | string | null;
  note: string | null;
  raised_by: string | null;
  raised_staff_ref: string | null;
  raised_at: string | null;
  resolved_at: string | null;
  resolution: string | null;
  resolved_by: string | null;
};

/** Open concerns first, newest first within each group. */
export function sortConcerns(list: Concern[]): Concern[] {
  return [...list].sort(
    (a, b) => Number(!!a.resolved_at) - Number(!!b.resolved_at) || String(b.raised_at ?? '').localeCompare(String(a.raised_at ?? '')),
  );
}

/** Why "Log the concern" is off, or null. */
export function concernBlocked(v: { category: ConcernCategory | null; severity: ConcernSeverity | null; note: string }): string | null {
  if (!v.category) return 'Choose what the concern is about.';
  if (!v.severity) return 'Choose how serious it is.';
  if (v.note.trim().length < CONCERN_NOTE_MIN) return `Write at least ${CONCERN_NOTE_MIN} characters saying what you saw.`;
  return null;
}

const severityTone = (s: string | null | undefined): Status => CONCERN_SEVERITIES.find((x) => x.value === s)?.tone ?? 'idle';
const severityLabel = (s: string | null | undefined) => CONCERN_SEVERITIES.find((x) => x.value === s)?.label ?? (s || '—');
const categoryLabel = (c: string | null | undefined) => CONCERN_CATEGORIES.find((x) => x.value === c)?.label ?? (c || '—');
const when = (iso: string | null | undefined) =>
  iso ? new Date(iso).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Africa/Kampala' }) : '—';

function useConcernsList(requestId: string) {
  return useQuery({
    queryKey: ['desk-feed', 'concerns-list', requestId],
    queryFn: async (): Promise<Concern[]> => {
      const { data, error } = await rpc('pipeline_concerns_list', { p_request_id: requestId });
      if (error) throw error;
      return Array.isArray(data) ? (data as Concern[]) : [];
    },
    staleTime: 10_000,
    retry: 1,
  });
}

const TEXTAREA = `w-full rounded-xl border border-[var(--desk-line-color)] bg-[var(--desk-surface)] px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground ${FOCUS}`;

function ResolveForm({ concernId, onDone }: { concernId: string; onDone: () => void }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ok = text.trim().length >= CONCERN_NOTE_MIN;
  const save = async () => {
    setBusy(true);
    setError(null);
    const { error: e } = await rpc('pipeline_resolve_concern', { p_concern_id: concernId, p_resolution: text.trim() });
    setBusy(false);
    if (e) setError(readableError(e));
    else onDone();
  };
  return (
    <div style={stackLayout(6)}>
      <textarea value={text} onChange={(e) => setText(e.target.value)} rows={2} aria-label="How it was resolved" placeholder="How it was resolved, in plain words." className={TEXTAREA} />
      {error && <ErrorLine>{error}</ErrorLine>}
      <div style={rowLayout(6)}>
        <DecisionButton variant="ok" disabled={!ok || busy} onClick={save}>
          {busy ? 'Saving…' : 'Mark resolved'}
        </DecisionButton>
        {!ok && <span className={LABEL}>At least {CONCERN_NOTE_MIN} characters.</span>}
      </div>
    </div>
  );
}

export function ConcernsSection({ requestId, desk }: { requestId: string; desk: ConcernDesk }) {
  const queryClient = useQueryClient();
  const list = useConcernsList(requestId);
  const sorted = useMemo(() => sortConcerns(list.data ?? []), [list.data]);
  const [category, setCategory] = useState<ConcernCategory | null>(null);
  const [severity, setSeverity] = useState<ConcernSeverity | null>(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [resolving, setResolving] = useState<string | null>(null);
  const blocked = concernBlocked({ category, severity, note });

  const refresh = () => queryClient.invalidateQueries({ queryKey: ['desk-feed'] });

  const raise = async () => {
    if (blocked || !category || !severity) return;
    setBusy(true);
    setMessage(null);
    const { error } = await rpc('pipeline_raise_concern', {
      p_request_id: requestId,
      p_desk: desk,
      p_category: category,
      p_severity: severity,
      p_note: note.trim(),
    });
    setBusy(false);
    if (error) {
      setMessage({ ok: false, text: readableError(error) });
      return;
    }
    setMessage({ ok: true, text: 'Concern logged. Every desk after this one will see it.' });
    setCategory(null);
    setSeverity(null);
    setNote('');
    refresh();
  };

  return (
    <section className={`${PANEL} p-4`} style={stackLayout(12)} aria-label="Concerns">
      <h3 className="text-sm font-semibold text-foreground" style={{ margin: 0 }}>
        Concerns
      </h3>

      {list.isLoading ? (
        <LoadingRows rows={2} height={24} label="Loading concerns" />
      ) : list.error ? (
        <ErrorLine>Concerns could not load: {readableError(list.error)}</ErrorLine>
      ) : sorted.length === 0 ? (
        <EmptyState>No concerns logged on this request.</EmptyState>
      ) : (
        <ul style={stackLayout(10)}>
          {sorted.map((c) => {
            const open = !c.resolved_at;
            return (
              <li key={c.id} className="border-t border-[var(--desk-line-color)] pt-2 first:border-t-0 first:pt-0" style={stackLayout(4)}>
                <div style={rowLayout(6)}>
                  <Chip tone={severityTone(c.severity)} strong={c.severity === 'serious'}>
                    {severityLabel(c.severity)}
                  </Chip>
                  <span className="text-sm font-medium text-foreground">{categoryLabel(c.category)}</span>
                  {!open && <Chip tone="ok">Resolved</Chip>}
                  <span className={LABEL}>
                    {DESK_NAME[c.desk ?? ''] ?? c.desk ?? '—'} · {c.raised_by ?? '—'}
                    {c.raised_staff_ref ? ` (${c.raised_staff_ref})` : ''} · {when(c.raised_at)}
                  </span>
                </div>
                {c.note && <p className="text-sm text-foreground">{c.note}</p>}
                {!open && (
                  <p className={LABEL}>
                    Resolved {when(c.resolved_at)}
                    {c.resolved_by ? ` by ${c.resolved_by}` : ''}
                    {c.resolution ? ` — ${c.resolution}` : ''}
                  </p>
                )}
                {open &&
                  (resolving === c.id ? (
                    <ResolveForm
                      concernId={c.id}
                      onDone={() => {
                        setResolving(null);
                        refresh();
                      }}
                    />
                  ) : (
                    <div>
                      <DecisionButton variant="quiet" onClick={() => setResolving(c.id)}>
                        Resolve…
                      </DecisionButton>
                    </div>
                  ))}
              </li>
            );
          })}
        </ul>
      )}

      <div className="border-t border-[var(--desk-line-color)] pt-3" style={stackLayout(8)}>
        <h4 className="text-sm font-semibold text-foreground" style={{ margin: 0 }}>
          Log a concern
        </h4>
        <Segmented<ConcernCategory>
          ariaLabel="What the concern is about"
          options={CONCERN_CATEGORIES}
          value={category}
          onChange={(v) => setCategory(v)}
        />
        <Segmented<ConcernSeverity>
          ariaLabel="How serious"
          label="How serious"
          options={CONCERN_SEVERITIES}
          value={severity}
          onChange={(v) => setSeverity(v)}
        />
        <textarea
          value={note}
          onChange={(e) => setNote(e.target.value)}
          rows={3}
          aria-label="What you saw"
          placeholder="What you saw or heard, in plain words."
          className={TEXTAREA}
        />
        {blocked && <p className={`text-sm ${statusText.warn}`}>{blocked}</p>}
        {message && (message.ok ? <p className={`text-sm ${statusText.ok}`} role="status">{message.text}</p> : <ErrorLine>{message.text}</ErrorLine>)}
        <div>
          <DecisionButton variant="primary" disabled={!!blocked || busy} onClick={raise}>
            {busy ? 'Saving…' : 'Log the concern'}
          </DecisionButton>
        </div>
      </div>
    </section>
  );
}

/** The desk a drawer stage logs concerns as, or null where concerns are not taken (Partner Ops, retired). */
export function concernDeskFor(stage: string): ConcernDesk | null {
  return (['service_centre', 'agent_ops', 'tenant_ops', 'landlord_ops', 'coo'] as const).find((d) => d === stage) ?? null;
}
