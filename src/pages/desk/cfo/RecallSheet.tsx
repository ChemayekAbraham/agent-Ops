import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { CALM, FOCUS, LABEL, statusGlass } from '../deskTheme';
import { DecisionButton, Sheet, stackLayout } from '../ui';
import {
  RECALL_LEVELS,
  RECALL_NOTE_MIN,
  RECALL_REASONS,
  recallConfirmText,
  recallFunded,
  recallNoteOk,
  recallToastText,
  type RecallLevel,
  type RecallReason,
} from './planDrawerApi';

const chip = (on: boolean) =>
  `desk-pill border px-3 py-1.5 text-xs text-left ${CALM} ${FOCUS} ${
    on ? 'border-[hsl(var(--primary)/0.6)] bg-[hsl(var(--primary)/0.18)] text-foreground' : 'border-[var(--desk-line-color)] bg-[var(--desk-surface)] text-muted-foreground hover:text-foreground'
  }`;

/**
 * E86 recall of a funded tenant whose money is still with the agent: the
 * landlord float comes back and the funder's wallet is refunded, all inside
 * funded_recall. A reason, a 10+ character note and where the tenant goes,
 * then one confirm. A refusal is shown exactly as the server words it.
 */
export function RecallSheet({
  requestId,
  amount,
  agent,
  funder,
  onClose,
}: {
  requestId: string;
  amount: number | null;
  agent: string | null;
  funder: string | null;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const [reason, setReason] = useState<RecallReason | null>(null);
  const [note, setNote] = useState('');
  const [level, setLevel] = useState<RecallLevel>('board');
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);
  const ready = !!reason && recallNoteOk(note);

  const submit = async () => {
    if (!reason || !ready || busy) return;
    setBusy(true);
    setRefusal(null);
    const out = await recallFunded(requestId, reason, note, level);
    setBusy(false);
    if (!out.ok) {
      setRefusal(out.message ?? 'The recall was refused.');
      setConfirming(false);
      return;
    }
    toast.success(recallToastText(out));
    void qc.invalidateQueries({ queryKey: ['desk-feed'] });
    onClose();
  };

  return (
    <Sheet title="Recall this funded tenant" onClose={onClose}>
      <div data-recall-sheet style={stackLayout(14)}>
        {refusal && (
          <p role="alert" data-recall-refusal className={`rounded-xl border px-3 py-2 text-sm font-medium ${statusGlass.bad}`} style={{ margin: 0, overflowWrap: 'anywhere' }}>
            {refusal}
          </p>
        )}

        <fieldset style={{ ...stackLayout(6), border: 0, margin: 0, padding: 0 }}>
          <legend className={LABEL}>Reason</legend>
          <div className="flex flex-wrap gap-1.5">
            {RECALL_REASONS.map((r) => (
              <button key={r.code} type="button" aria-pressed={reason === r.code} data-reason={r.code} onClick={() => setReason(r.code)} className={chip(reason === r.code)} disabled={confirming}>
                {r.label}
              </button>
            ))}
          </div>
        </fieldset>

        <label style={stackLayout(6)}>
          <span className={LABEL}>Note (at least {RECALL_NOTE_MIN} characters)</span>
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            rows={3}
            required
            disabled={confirming}
            data-recall-note
            className={`w-full rounded-xl border border-[var(--desk-line-color)] bg-[var(--desk-surface)] px-3 py-2 text-sm text-foreground ${FOCUS}`}
            placeholder="What went wrong with this funding"
          />
        </label>

        <fieldset style={{ ...stackLayout(6), border: 0, margin: 0, padding: 0 }}>
          <legend className={LABEL}>Where the tenant goes</legend>
          <div className="flex flex-wrap gap-1.5">
            {RECALL_LEVELS.map((l) => (
              <button key={l.value} type="button" aria-pressed={level === l.value} data-level={l.value} onClick={() => setLevel(l.value)} className={chip(level === l.value)} disabled={confirming}>
                {l.label}
              </button>
            ))}
          </div>
        </fieldset>

        {confirming ? (
          <div className={`rounded-xl border p-3 ${statusGlass.warn}`} style={stackLayout(10)} data-recall-confirm>
            <p className="text-sm font-medium" style={{ margin: 0 }}>
              {recallConfirmText(amount, agent, funder)}
            </p>
            <div className="flex flex-wrap justify-end gap-2">
              <DecisionButton size="md" variant="quiet" onClick={() => setConfirming(false)} disabled={busy}>
                Back
              </DecisionButton>
              <DecisionButton size="md" variant="danger" onClick={() => void submit()} disabled={busy} aria-busy={busy}>
                {busy ? 'Recalling…' : 'Yes, recall'}
              </DecisionButton>
            </div>
          </div>
        ) : (
          <div className="flex flex-wrap justify-end gap-2">
            <DecisionButton size="md" variant="quiet" onClick={onClose}>
              Cancel
            </DecisionButton>
            <DecisionButton size="md" variant="danger" onClick={() => setConfirming(true)} disabled={!ready}>
              Recall…
            </DecisionButton>
          </div>
        )}
      </div>
    </Sheet>
  );
}
