import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { rpc } from '../reviewApi';
import { LABEL, type Status } from '../deskTheme';
import { fmt } from '../format';
import { Card, Chip, EmptyState, ErrorLine, LoadingRows, stackLayout } from '../ui';
import { plainError } from '../arrears/arrearsApi';
import { PRIMARY_BUTTON, dayText } from '../arrears/ArrearsParts';

/**
 * PRE-MORTEM (E106): before each gate every desk lead lists how the next
 * stage could fail; a gate is not signed off while any of its risks has no
 * answer. Grouped by gate with its date and the server's open count. An
 * answer, once given, is locked.
 */

type Gate = { gate: string; date: string };
type Item = {
  id: number;
  gate: string;
  desk: string | null;
  risk: string;
  likelihood: string;
  raised_by: string | null;
  raised_at: string | null;
  answer: string | null;
  answered_by: string | null;
  answered_at: string | null;
};
type Premortem = { gates: Gate[]; rule: string | null; open_by_gate: Record<string, number>; items: Item[] };

export const PREMORTEM_KEY = ['desk-feed', 'premortem'] as const;
export const LIKELIHOODS = ['low', 'medium', 'high'] as const;
const LIKELY_TONE: Record<string, Status> = { high: 'bad', medium: 'warn', low: 'idle' };
export const PREMORTEM_WORDS: Record<string, string> = {
  STAFF_ID_REQUIRED: 'Your staff ID is not on file, so this cannot be recorded. Ask HR to add your staff ID.',
  STAFF_ONLY: 'Only staff can see and answer gate risks.',
  RISK_TOO_SHORT: 'Describe how the stage could fail in at least 10 characters.',
  ANSWER_TOO_SHORT: 'Say what the plan does about this risk in at least 10 characters.',
  ANSWER_LOCKED_OR_MISSING: 'This risk has already been answered, so the answer is locked.',
};
const INPUT = 'rounded-md border border-[var(--desk-line-color)] bg-[var(--desk-surface)] px-2 py-1.5 text-sm text-foreground';

export function usePremortem(gate: string | null) {
  return useQuery({
    queryKey: [...PREMORTEM_KEY, gate],
    queryFn: async (): Promise<Premortem> => {
      const { data, error } = await rpc('premortem_list', { p_gate: gate });
      if (error) throw error;
      const d = (data ?? {}) as Partial<Premortem>;
      return {
        gates: Array.isArray(d.gates) ? d.gates : [],
        rule: d.rule ?? null,
        open_by_gate: d.open_by_gate ?? {},
        items: Array.isArray(d.items) ? d.items : [],
      };
    },
    retry: 1,
  });
}

function AnswerBox({ item }: { item: Item }) {
  const qc = useQueryClient();
  const [text, setText] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const save = async () => {
    setSaving(true);
    setProblem(null);
    const { error } = await rpc('premortem_answer', { p_id: item.id, p_answer: text });
    setSaving(false);
    if (error) {
      setProblem(plainError(error, PREMORTEM_WORDS));
      return;
    }
    toast.success('Answer saved');
    void qc.invalidateQueries({ queryKey: [...PREMORTEM_KEY] });
  };
  return (
    <div style={stackLayout(6)}>
      <textarea value={text} onChange={(e) => setText(e.target.value)} rows={2} aria-label={`Answer: ${item.risk}`} placeholder="What does the plan do about this risk?" className={INPUT} data-answer-input={item.id} />
      {problem && <ErrorLine>{problem}</ErrorLine>}
      <div>
        <button type="button" className={PRIMARY_BUTTON} disabled={saving || !text.trim()} onClick={() => void save()}>
          {saving ? 'Saving…' : 'Save answer'}
        </button>
      </div>
    </div>
  );
}

function AddRisk({ gates }: { gates: Gate[] }) {
  const qc = useQueryClient();
  const [gate, setGate] = useState(gates[0]?.gate ?? '');
  const [risk, setRisk] = useState('');
  const [likelihood, setLikelihood] = useState<(typeof LIKELIHOODS)[number]>('medium');
  const [problem, setProblem] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const save = async () => {
    setSaving(true);
    setProblem(null);
    const { error } = await rpc('premortem_add', { p_gate: gate, p_risk: risk, p_likelihood: likelihood });
    setSaving(false);
    if (error) {
      setProblem(plainError(error, PREMORTEM_WORDS));
      return;
    }
    toast.success('Risk added');
    setRisk('');
    void qc.invalidateQueries({ queryKey: [...PREMORTEM_KEY] });
  };
  return (
    <div style={stackLayout(8)} data-add-risk>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12 }}>
        <label style={stackLayout(4)}>
          <span className={LABEL}>Gate</span>
          <select value={gate} onChange={(e) => setGate(e.target.value)} className={INPUT} data-add-gate>
            {gates.map((g) => (
              <option key={g.gate} value={g.gate}>
                {g.gate} · {dayText(g.date)}
              </option>
            ))}
          </select>
        </label>
        <label style={stackLayout(4)}>
          <span className={LABEL}>Likelihood</span>
          <select value={likelihood} onChange={(e) => setLikelihood(e.target.value as (typeof LIKELIHOODS)[number])} className={INPUT} data-add-likelihood>
            {LIKELIHOODS.map((l) => (
              <option key={l} value={l}>
                {l[0].toUpperCase() + l.slice(1)}
              </option>
            ))}
          </select>
        </label>
      </div>
      <label style={stackLayout(4)}>
        <span className={LABEL}>How could the next stage fail?</span>
        <textarea value={risk} onChange={(e) => setRisk(e.target.value)} rows={2} className={INPUT} data-add-risk-text />
      </label>
      {problem && <ErrorLine>{problem}</ErrorLine>}
      <div>
        <button type="button" className={PRIMARY_BUTTON} disabled={saving || !gate || !risk.trim()} onClick={() => void save()}>
          {saving ? 'Saving…' : 'Add risk'}
        </button>
      </div>
    </div>
  );
}

export function PremortemTab({ board }: { board: boolean }) {
  const q = usePremortem(null);
  if (q.isLoading) return <LoadingRows rows={4} label="Loading the pre-mortem" />;
  if (q.error) return <ErrorLine>{plainError(q.error, PREMORTEM_WORDS)}</ErrorLine>;
  const d = q.data;
  if (!d) return null;
  return (
    <section aria-label="Pre-mortem" style={stackLayout(16)} data-premortem>
      {d.rule && (
        <p className="text-sm text-muted-foreground" style={{ margin: 0 }}>
          {d.rule}
        </p>
      )}
      {d.gates.length > 0 && (
        <Card board={board} title="Add a risk">
          <AddRisk gates={d.gates} />
        </Card>
      )}
      {d.gates.map((g) => {
        const items = d.items.filter((i) => i.gate === g.gate);
        const open = d.open_by_gate[g.gate] ?? 0;
        return (
          <Card
            key={g.gate}
            board={board}
            title={`${g.gate} · ${dayText(g.date)}`}
            hint={<Chip tone={open > 0 ? 'warn' : 'ok'}>{fmt('int', open)} open</Chip>}
            ariaLabel={`Gate ${g.gate}`}
          >
            <div data-gate={g.gate} style={stackLayout(10)}>
              {items.length === 0 ? (
                <EmptyState>No risk raised for {g.gate} yet.</EmptyState>
              ) : (
                <ul style={{ ...stackLayout(12), margin: 0, padding: 0, listStyle: 'none' }}>
                  {items.map((it) => (
                    <li key={it.id} className="border-t border-[var(--desk-line-color)] pt-3 first:border-t-0 first:pt-0" style={stackLayout(6)} data-risk={it.id} data-answered={!!it.answered_at || undefined}>
                      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8 }}>
                        <Chip tone={LIKELY_TONE[it.likelihood] ?? 'idle'}>{it.likelihood}</Chip>
                        {it.desk && <span className={LABEL}>{it.desk}</span>}
                        <span className={LABEL}>
                          Raised{it.raised_by ? ` by ${it.raised_by}` : ''}
                          {it.raised_at ? ` · ${dayText(it.raised_at)}` : ''}
                        </span>
                      </div>
                      <p className="text-sm text-foreground" style={{ margin: 0, overflowWrap: 'anywhere' }}>
                        {it.risk}
                      </p>
                      {it.answered_at ? (
                        <div className="rounded-md bg-[var(--desk-surface)] p-2" data-locked>
                          <p className="text-sm text-foreground" style={{ margin: 0, overflowWrap: 'anywhere' }}>
                            {it.answer}
                          </p>
                          <p className={LABEL} style={{ margin: 0 }}>
                            Answered{it.answered_by ? ` by ${it.answered_by}` : ''} · {dayText(it.answered_at)} · locked
                          </p>
                        </div>
                      ) : (
                        <AnswerBox item={it} />
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </Card>
        );
      })}
    </section>
  );
}
