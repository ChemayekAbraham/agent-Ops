import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useAuth } from '@/hooks/useAuth';
import { FOCUS, LABEL, statusText } from '../deskTheme';
import { DecisionButton, ErrorLine, Fold, LoadingRows, Segmented, stackLayout } from '../ui';
import { readableError, rpc } from '../reviewApi';
import { RESPONSIBILITY_DESKS, isCooOrCeo, stepsFromText, useDeskRules, type Responsibilities } from './ontologyApi';

/**
 * COO/CEO only: set what each desk is responsible for. Loads through
 * `ontology_rules_for_desk(p_desk)` and saves through
 * `desk_responsibilities_set(...)`; the server checks the role as well.
 * Steps are one per line.
 */

export type ResponsibilitiesArgs = {
  p_desk: string;
  p_title: string;
  p_role_line: string;
  p_steps: string[];
  p_must_not: string | null;
  p_accountability: string;
};

export function responsibilitiesArgs(
  desk: string,
  f: { title: string; roleLine: string; steps: string; mustNot: string; accountability: string },
): ResponsibilitiesArgs {
  return {
    p_desk: desk,
    p_title: f.title.trim(),
    p_role_line: f.roleLine.trim(),
    p_steps: stepsFromText(f.steps),
    p_must_not: f.mustNot.trim() || null,
    p_accountability: f.accountability.trim(),
  };
}

const EMPTY = { title: '', roleLine: '', steps: '', mustNot: '', accountability: '' };

function formFrom(r: Responsibilities | null | undefined) {
  if (!r) return EMPTY;
  return {
    title: r.title ?? '',
    roleLine: r.role_line ?? '',
    steps: (r.steps ?? []).join('\n'),
    mustNot: r.must_not ?? '',
    accountability: r.accountability ?? '',
  };
}

function DeskForm({ desk }: { desk: string }) {
  const queryClient = useQueryClient();
  const q = useDeskRules(desk);
  const [f, setF] = useState(EMPTY);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    if (!q.data || loaded) return;
    setF(formFrom(q.data.responsibilities));
    setLoaded(true);
  }, [q.data, loaded]);

  const set = (k: keyof typeof EMPTY) => (e: { target: { value: string } }) => setF((prev) => ({ ...prev, [k]: e.target.value }));
  const args = responsibilitiesArgs(desk, f);
  const ready = !!args.p_title && !!args.p_role_line && args.p_steps.length > 0 && !!args.p_accountability;

  const save = async () => {
    setBusy(true);
    setMessage(null);
    const { data, error } = await rpc('desk_responsibilities_set', args);
    setBusy(false);
    if (error) {
      setMessage({ ok: false, text: readableError(error) });
      return;
    }
    const v = (data as { version?: number | string } | null)?.version;
    setMessage({ ok: true, text: v ? `Saved as version ${v}. The desk sees it next time its rules load.` : 'Saved.' });
    queryClient.invalidateQueries({ queryKey: ['desk-feed', 'ontology-rules-for-desk'] });
  };

  if (q.isLoading) return <LoadingRows rows={3} height={32} label="Loading the responsibilities" />;
  if (q.error) return <ErrorLine>The responsibilities could not load: {readableError(q.error)}</ErrorLine>;

  const r = q.data?.responsibilities;
  const input = `w-full rounded-xl border border-[var(--desk-line-color)] bg-[var(--desk-surface)] px-3 py-2 text-sm text-foreground ${FOCUS}`;
  return (
    <div style={stackLayout(8)}>
      <p className={LABEL} style={{ margin: 0 }}>
        {r?.version ? `Now version ${r.version}. ` : 'Nothing set for this desk yet. '}Shown first in "Rules for this desk". Only the COO or CEO can save.
      </p>
      <label style={stackLayout(4)}>
        <span className={LABEL}>Title</span>
        <input value={f.title} onChange={set('title')} className={input} aria-label="Title" />
      </label>
      <label style={stackLayout(4)}>
        <span className={LABEL}>Role line</span>
        <input value={f.roleLine} onChange={set('roleLine')} className={input} aria-label="Role line" />
      </label>
      <label style={stackLayout(4)}>
        <span className={LABEL}>Steps, one per line</span>
        <textarea value={f.steps} onChange={set('steps')} rows={6} className={input} aria-label="Steps" />
      </label>
      <label style={stackLayout(4)}>
        <span className={LABEL}>Not allowed (optional)</span>
        <textarea value={f.mustNot} onChange={set('mustNot')} rows={2} className={input} aria-label="Not allowed" />
      </label>
      <label style={stackLayout(4)}>
        <span className={LABEL}>Accountability</span>
        <textarea value={f.accountability} onChange={set('accountability')} rows={2} className={input} aria-label="Accountability" />
      </label>
      {message &&
        (message.ok ? (
          <p className={`text-sm ${statusText.ok}`} role="status" style={{ margin: 0 }}>
            {message.text}
          </p>
        ) : (
          <ErrorLine>{message.text}</ErrorLine>
        ))}
      <div>
        <DecisionButton variant="primary" disabled={busy || !ready} onClick={save}>
          {busy ? 'Saving…' : 'Save responsibilities'}
        </DecisionButton>
      </div>
    </div>
  );
}

export function ResponsibilitiesEditor() {
  const [desk, setDesk] = useState(RESPONSIBILITY_DESKS[1].key);
  return (
    <div style={stackLayout(14)}>
      <Segmented
        options={RESPONSIBILITY_DESKS.map((d) => ({ value: d.key, label: d.name }))}
        value={desk}
        onChange={(d) => d !== null && setDesk(d)}
        ariaLabel="Desk"
      />
      {/* Keyed on the desk, so switching never carries one desk's draft onto another. */}
      <DeskForm key={desk} desk={desk} />
    </div>
  );
}

/** "Edit responsibilities" on the Ontology desk: the COO and CEO only. */
export function EditResponsibilitiesFold({ board }: { board: boolean }) {
  const { roles } = useAuth();
  if (!isCooOrCeo(roles as readonly unknown[])) return null;
  return (
    <Fold title="Edit responsibilities" board={board} hint="What each desk is responsible for, and who answers for it">
      <ResponsibilitiesEditor />
    </Fold>
  );
}
