import { useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { MessageCircle, Phone } from 'lucide-react';
import { toast } from 'sonner';
import { CALM, FOCUS, LABEL, statusText, type Status } from '../deskTheme';
import { Chip, ErrorLine, Segmented, Sheet, moneyFull, pctWhole, stackLayout } from '../ui';
import {
  ARREARS_KEY,
  MODE_WORDS,
  OUTCOMES,
  daysShortText,
  PARTY_WORDS,
  logArrearsCall,
  needsDate,
  needsNote,
  outcomeWords,
  telHref,
  tierTone,
  tierWords,
  validateCall,
  waHref,
  type ArrearsRow,
  type CallRecord,
  type Outcome,
  type Party,
  type WatchMode,
} from './arrearsApi';

const BTN = `inline-flex items-center gap-1 rounded-md border border-[var(--desk-line-color)] bg-[var(--desk-surface)] px-2.5 py-1 text-xs text-foreground hover:bg-[var(--desk-surface-hover)] ${CALM} ${FOCUS}`;
const PRIMARY = `inline-flex items-center justify-center rounded-md border border-[hsl(var(--primary)/0.6)] bg-[hsl(var(--primary)/0.18)] px-3 py-1.5 text-sm font-medium text-foreground hover:bg-[hsl(var(--primary)/0.28)] disabled:opacity-50 ${CALM} ${FOCUS}`;
export const ACTION_BUTTON = BTN;
export const PRIMARY_BUTTON = PRIMARY;

/** Call (tel:) and, where asked, WhatsApp. Nothing when there is no phone. */
export function CallButtons({ phone, whatsapp, who }: { phone: string | null | undefined; whatsapp?: boolean; who: string }) {
  if (!phone) return <span className={LABEL}>No phone</span>;
  return (
    <span style={{ display: 'inline-flex', flexWrap: 'wrap', gap: 6 }}>
      <a href={telHref(phone)} className={BTN} aria-label={`Call ${who}`} data-call={telHref(phone)}>
        <Phone className="h-3.5 w-3.5" aria-hidden />
        Call
      </a>
      {whatsapp && (
        <a href={waHref(phone)} target="_blank" rel="noreferrer" className={BTN} aria-label={`WhatsApp ${who}`} data-whatsapp>
          <MessageCircle className="h-3.5 w-3.5" aria-hidden />
          WhatsApp
        </a>
      )}
    </span>
  );
}

/** The 50% rule: an agent at or above half collected may take new plans. */
export function EligibleBadge({ pct, eligible }: { pct: number | null | undefined; eligible: boolean | null | undefined }) {
  return (
    <span style={{ display: 'inline-flex', flexWrap: 'wrap', alignItems: 'center', gap: 6 }}>
      <span className="tabular-nums text-foreground" data-collection-pct>{pctWhole(pct)} collected</span>
      {eligible === true && <Chip tone="ok" title="At or above 50% collected">Eligible</Chip>}
      {eligible === false && <Chip tone="bad" title="Below 50% collected">Below 50%</Chip>}
    </span>
  );
}

const when = (v: string | null | undefined) => {
  if (!v || !Number.isFinite(Date.parse(v))) return null;
  return new Date(v).toLocaleString('en-GB', { timeZone: 'Africa/Kampala', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
};
const day = (v: string | null | undefined) => {
  if (!v || !Number.isFinite(Date.parse(v))) return '—';
  return new Date(`${v.slice(0, 10)}T12:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
};
export const dayText = day;

/** "15 Nov 2026", or in week mode "9 Nov 2026 – 15 Nov 2026" from the payload's from / to. */
export function rangeText(mode: WatchMode, d: { day: string; from?: string | null; to?: string | null }): string {
  if (mode === 'week' && d.from && d.to) return `${day(d.from)} – ${day(d.to)}`;
  return day(d.day);
}

/**
 * Yesterday | Last week (E113), and the day it reads: the watch day, or the
 * Sunday that ends the week (Monday to Sunday).
 */
export function WatchControls({ mode, onMode, value, onValue }: { mode: WatchMode; onMode: (m: WatchMode) => void; value: string; onValue: (v: string) => void }) {
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'flex-end', gap: 12 }} data-watch-controls>
      <Segmented<WatchMode>
        ariaLabel="Arrears for"
        value={mode}
        onChange={(m) => m !== null && onMode(m)}
        options={(['day', 'week'] as const).map((m) => ({ value: m, label: MODE_WORDS[m] }))}
      />
      <label style={stackLayout(4)}>
        <span className={LABEL}>{mode === 'week' ? 'Week ending (Sunday)' : 'Watch day'}</span>
        <input
          type="date"
          value={value}
          onChange={(e) => e.target.value && onValue(e.target.value)}
          className="rounded-md border border-[var(--desk-line-color)] bg-[var(--desk-surface)] px-2 py-1.5 text-sm text-foreground"
          data-watch-day
        />
      </label>
    </div>
  );
}

/** "Promised a date (20 Nov) · 14:05 · ST-0042", or "No call yet". */
export function CallLine({ label, call }: { label: string; call: CallRecord }) {
  return (
    <p className="text-sm" style={{ margin: 0, overflowWrap: 'anywhere' }} data-last-call={label}>
      <span className={LABEL}>{label}: </span>
      {call ? (
        <span className="text-foreground">
          {outcomeWords(call.outcome)}
          {call.promised_date ? ` (${day(call.promised_date)})` : ''}
          {when(call.at) ? ` · ${when(call.at)}` : ''}
          {call.staff_ref ? ` · ${call.staff_ref}` : ''}
          {call.note ? ` — ${call.note}` : ''}
        </span>
      ) : (
        <span className="text-muted-foreground">No call yet</span>
      )}
    </p>
  );
}

function Contact({ role, name, phone, whatsapp, extra }: { role: string; name: string | null | undefined; phone?: string | null; whatsapp?: boolean; extra?: ReactNode }) {
  return (
    <li style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: 8 }} data-contact={role.toLowerCase()}>
      <span style={{ minWidth: 0, overflowWrap: 'anywhere' }}>
        <span className={LABEL}>{role} </span>
        <span className="text-sm font-medium text-foreground">{name ?? '—'}</span>
        {phone && <span className="ml-1 font-mono text-xs text-muted-foreground">{phone}</span>}
        {extra && <span className="ml-2">{extra}</span>}
      </span>
      {phone !== undefined && <CallButtons phone={phone} whatsapp={whatsapp} who={`${role.toLowerCase()} ${name ?? ''}`.trim()} />}
    </li>
  );
}

function Figure({ label, value, tone }: { label: string; value: ReactNode; tone?: Status }) {
  return (
    <div style={{ minWidth: 0 }}>
      <div className={LABEL}>{label}</div>
      <div className={`text-sm tabular-nums ${tone ? statusText[tone] : 'text-foreground'}`}>{value}</div>
    </div>
  );
}

/** One plan short on the watch day: who to call, the figures, the tier and today's calls. */
export function TenantCard({ row, tiers, onLog }: { row: ArrearsRow; tiers: Record<string, string | undefined>; onLog: (row: ArrearsRow) => void }) {
  const [why, setWhy] = useState(false);
  const f = row.funder ?? { name: null };
  const pooled = !f.id && !f.phone;
  const ll = row.landlord ?? { name: null };
  const hasCaretaker = !!(ll.caretaker_name || ll.caretaker_phone);
  return (
    <article className="desk-panel min-w-0" style={{ ...stackLayout(10), padding: 16 }} data-tenant-card={row.rent_request_id} data-tier={row.tier}>
      <header style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
        <h3 className="text-base font-semibold text-foreground" style={{ margin: 0, overflowWrap: 'anywhere' }}>
          {row.tenant?.name ?? '—'}
        </h3>
        <button type="button" onClick={() => setWhy((w) => !w)} aria-expanded={why} className={`rounded-full ${FOCUS}`} data-tier-badge={row.tier}>
          <Chip tone={tierTone(row.tier)} strong>
            {tierWords(row.tier)}
          </Chip>
        </button>
      </header>
      {daysShortText(row) && (
        <p className={`text-sm font-medium ${statusText.warn}`} style={{ margin: 0 }} data-days-short>
          {daysShortText(row)}
        </p>
      )}
      {why && (
        <p className="text-sm text-muted-foreground" style={{ margin: 0 }} data-tier-why>
          {tiers[row.tier] ?? tierWords(row.tier)}
        </p>
      )}

      <ul style={{ ...stackLayout(8), margin: 0, padding: 0, listStyle: 'none' }} aria-label="Who to call">
        <Contact role="Tenant" name={row.tenant?.name} phone={row.tenant?.phone ?? null} whatsapp />
        <Contact role="Agent" name={row.agent?.name} phone={row.agent?.phone ?? null} extra={<EligibleBadge pct={row.agent?.collection_pct} eligible={row.agent?.eligible} />} />
        <Contact role="Landlord" name={ll.name} phone={ll.phone ?? null} />
        {hasCaretaker && <Contact role="Caretaker" name={ll.caretaker_name ?? null} phone={ll.caretaker_phone ?? null} />}
        {/* "No named funder (Welile pool)" has nobody to ring. */}
        <Contact role="Funder" name={f.name} phone={pooled ? undefined : (f.phone ?? null)} />
      </ul>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(120px, 1fr))', gap: 10 }} data-figures>
        <Figure label="Due" value={moneyFull(row.window_due)} />
        <Figure label="Collected" value={moneyFull(row.collected)} />
        <Figure label="Collected %" value={pctWhole(row.pct)} tone={row.pct !== null && Number(row.pct) < 50 ? 'bad' : undefined} />
        <Figure label="Arrears to date" value={moneyFull(row.arrears_to_date)} />
        <Figure label="Last paid" value={day(row.last_paid_on)} />
        <Figure label="Days since paid" value={row.days_since_paid ?? '—'} />
        <Figure label="Plan day" value={row.plan_day ?? '—'} />
        <Figure label="Frequency" value={row.frequency ?? '—'} />
      </div>

      <div style={stackLayout(4)}>
        <CallLine label="Tenant Ops" call={row.tenant_ops_call} />
        <CallLine label="Agent Ops" call={row.agent_ops_call} />
      </div>
      <div>
        <button type="button" className={PRIMARY} onClick={() => onLog(row)}>
          Log call
        </button>
      </div>
    </article>
  );
}

/**
 * Log call: who was called, what happened, a promised date (and amount) when
 * they promised one, a note (needed for refused, dispute and other). The form
 * checks what the server checks first; anything the server still refuses
 * comes back in plain words.
 */
export function LogCallSheet({
  title,
  parties,
  defaultParty,
  rentRequestId,
  agentId,
  desk,
  day: watchDay,
  onClose,
}: {
  title: string;
  parties: Party[];
  defaultParty: Party;
  rentRequestId?: string | null;
  agentId?: string | null;
  desk: 'agent-ops' | 'tenant-ops';
  day: string;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const [party, setParty] = useState<Party>(defaultParty);
  const [outcome, setOutcome] = useState<Outcome | ''>('');
  const [promisedDate, setPromisedDate] = useState('');
  const [promisedAmount, setPromisedAmount] = useState('');
  const [note, setNote] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const save = async () => {
    const bad = validateCall({ outcome, note, promisedDate });
    if (bad) {
      setProblem(bad);
      return;
    }
    setSaving(true);
    setProblem(null);
    const r = await logArrearsCall({ party, outcome: outcome as Outcome, rentRequestId, agentId, note, promisedDate, promisedAmount, desk, day: watchDay });
    setSaving(false);
    if (!r.ok) {
      setProblem(r.message ?? 'The call was not recorded.');
      return;
    }
    toast.success(`Call logged: ${outcomeWords(outcome)}`);
    void qc.invalidateQueries({ queryKey: [...ARREARS_KEY] });
    onClose();
  };

  return (
    <Sheet
      title={title}
      onClose={onClose}
      footer={
        <div style={stackLayout(8)}>
          {problem && <ErrorLine>{problem}</ErrorLine>}
          <button type="button" className={PRIMARY} onClick={() => void save()} disabled={saving} data-save-call>
            {saving ? 'Saving…' : 'Save call'}
          </button>
        </div>
      }
    >
      <div style={stackLayout(14)}>
        {parties.length > 1 && (
          <fieldset style={{ border: 0, margin: 0, padding: 0 }}>
            <legend className={LABEL}>Who did you call?</legend>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, marginTop: 6 }}>
              {parties.map((p) => (
                <label key={p} className="flex items-center gap-1.5 text-sm text-foreground">
                  <input type="radio" name="party" value={p} checked={party === p} onChange={() => setParty(p)} data-party={p} />
                  {PARTY_WORDS[p]}
                </label>
              ))}
            </div>
          </fieldset>
        )}
        <label style={stackLayout(4)}>
          <span className={LABEL}>What happened?</span>
          <select
            value={outcome}
            onChange={(e) => {
              setOutcome(e.target.value as Outcome | '');
              setProblem(null);
            }}
            className="rounded-md border border-[var(--desk-line-color)] bg-[var(--desk-surface)] px-2 py-1.5 text-sm text-foreground"
            data-outcome
          >
            <option value="">Choose…</option>
            {OUTCOMES.map((o) => (
              <option key={o.key} value={o.key}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
        {needsDate(outcome) && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12 }}>
            <label style={stackLayout(4)}>
              <span className={LABEL}>Promised date (needed)</span>
              <input type="date" value={promisedDate} onChange={(e) => setPromisedDate(e.target.value)} className="rounded-md border border-[var(--desk-line-color)] bg-[var(--desk-surface)] px-2 py-1.5 text-sm text-foreground" data-promised-date />
            </label>
            <label style={stackLayout(4)}>
              <span className={LABEL}>Amount (optional)</span>
              <input inputMode="numeric" value={promisedAmount} onChange={(e) => setPromisedAmount(e.target.value)} placeholder="UGX" className="rounded-md border border-[var(--desk-line-color)] bg-[var(--desk-surface)] px-2 py-1.5 text-sm text-foreground" data-promised-amount />
            </label>
          </div>
        )}
        <label style={stackLayout(4)}>
          <span className={LABEL}>{needsNote(outcome) ? 'Note (needed)' : 'Note (optional)'}</span>
          <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={3} className="rounded-md border border-[var(--desk-line-color)] bg-[var(--desk-surface)] px-2 py-1.5 text-sm text-foreground" data-note />
        </label>
      </div>
    </Sheet>
  );
}
