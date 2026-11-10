import { useMemo, useState } from 'react';
import { useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { readableError, rpc, useReasonCodes } from './reviewApi';
import { isMissingDbObject, logMissingOnce } from './deskLive';
import { CALM, FOCUS, LABEL, statusGlass, statusText } from './deskTheme';
import { Skeleton } from './Skeleton';
import type { Stage } from './reviewTypes';

/**
 * "Wait on…" — park a request at a desk while someone outside it acts.
 *
 * Setting a wait never moves the request: it is one call to
 * `pipeline_set_waiting`, never `runMove`. The three RPCs here are not in the
 * generated Supabase types and may not be applied yet; when one answers "does
 * not exist" the piece hides itself and logs once.
 */

/* ───────────────────────── the vocabulary ───────────────────────── */

/** `p_desk` values the waiting RPCs accept. Partner Ops is retired and has none. */
export type WaitDesk = 'service_centre' | 'agent_ops' | 'tenant_ops' | 'landlord_ops' | 'coo' | 'cfo';

export const WAIT_DESKS: WaitDesk[] = ['service_centre', 'agent_ops', 'tenant_ops', 'landlord_ops', 'coo', 'cfo'];

/** Desk route id → `p_desk`. */
export const WAIT_DESK_OF: Record<string, WaitDesk> = {
  'service-centre': 'service_centre',
  'agent-ops': 'agent_ops',
  'tenant-ops': 'tenant_ops',
  'landlord-ops': 'landlord_ops',
  coo: 'coo',
  cfo: 'cfo',
};

export const WAIT_DESK_NAME: Record<WaitDesk, string> = {
  service_centre: 'Service Centre',
  agent_ops: 'Agent Ops',
  tenant_ops: 'Tenant Ops',
  landlord_ops: 'Landlord Ops',
  coo: 'COO',
  cfo: 'CFO',
};

/** Drawer stage → `p_desk`, or null where waiting is not offered. */
export function waitDeskForStage(stage: Stage): WaitDesk | null {
  return stage === 'partner_ops' ? null : stage;
}

export type OwnerKind = 'agent' | 'tenant' | 'landlord' | 'desk_lead' | 'coo' | 'cfo' | 'funder' | 'other';

/** The owners a reviewer picks from. The RPC also accepts coo and funder. */
export const OWNER_CHOICES: { kind: OwnerKind; label: string }[] = [
  { kind: 'agent', label: 'Agent' },
  { kind: 'tenant', label: 'Tenant' },
  { kind: 'landlord', label: 'Landlord' },
  { kind: 'desk_lead', label: 'Desk lead' },
  { kind: 'cfo', label: 'CFO' },
  { kind: 'other', label: 'Other' },
];

export const OWNER_LABEL: Record<string, string> = {
  agent: 'Agent',
  tenant: 'Tenant',
  landlord: 'Landlord',
  desk_lead: 'Desk lead',
  coo: 'COO',
  cfo: 'CFO',
  funder: 'Funder',
  other: 'Other',
};

/** Always offered, whatever the catalogue tags for the desk. */
export const EXTRA_WAIT_CODES = ['NO_RECEIVER', 'TENANT_ID_MISSING', 'OTHER'] as const;

export const WAIT_HOURS_DEFAULT = 24;
export const WAIT_HOURS_NO_RECEIVER = 48;
export const WAIT_HOURS_MAX = 168;
export const WAIT_NOTE_MIN = 10;

/** Default hours for a reason: 48 for NO_RECEIVER, otherwise 24. */
export function defaultWaitHours(reasonCode: string): number {
  return reasonCode === 'NO_RECEIVER' ? WAIT_HOURS_NO_RECEIVER : WAIT_HOURS_DEFAULT;
}

export type WaitInput = { owner: OwnerKind | ''; reasonCode: string; hours: number; note: string };

/** Why the wait cannot be saved yet, or null when it can. */
export function waitBlocked(w: WaitInput): string | null {
  if (!w.owner) return 'Choose who the request is waiting on.';
  if (!w.reasonCode) return 'Choose a reason code.';
  if (!Number.isFinite(w.hours) || w.hours < 1) return 'Set how many hours to wait (at least 1).';
  if (w.hours > WAIT_HOURS_MAX) return `A wait can last at most ${WAIT_HOURS_MAX} hours (7 days).`;
  if (w.reasonCode === 'OTHER' && w.note.trim().length < WAIT_NOTE_MIN)
    return `Write at least ${WAIT_NOTE_MIN} characters saying what you are waiting for.`;
  return null;
}

/** The desk's catalogue tag (as the drawer reads it) plus the three codes every desk gets. */
export function waitReasonOptions(
  all: { code: string; desks: string[] | null; meaning: string | null }[],
  deskTag: string,
): { code: string; meaning: string }[] {
  const out = new Map<string, string>();
  all
    .filter((r) => (r.desks ?? []).some((d) => d === deskTag || d === 'all'))
    .forEach((r) => out.set(r.code, r.meaning ?? ''));
  const extraMeaning: Record<string, string> = {
    NO_RECEIVER: 'Nobody to receive the payment yet',
    TENANT_ID_MISSING: 'Tenant ID is missing',
    OTHER: 'Something else — say what in the note',
  };
  EXTRA_WAIT_CODES.forEach((c) => {
    if (!out.has(c)) out.set(c, extraMeaning[c]);
  });
  return Array.from(out, ([code, meaning]) => ({ code, meaning }));
}

/* ───────────────────────── the list ───────────────────────── */

/** One row of `pipeline_waiting_list(p_desk)`. */
export type WaitingRow = {
  waiting_id: string;
  rent_request_id: string;
  req: string | null;
  tenant: string | null;
  reason_code: string;
  owner_kind: string;
  owner_name: string | null;
  note: string | null;
  set_by_name: string | null;
  set_by_staff_ref: string | null;
  set_at: string;
  until_at: string;
  expired: boolean;
  hours_left: number | null;
};

export type WaitingItem = {
  waitingId: string;
  requestId: string;
  req: string;
  tenant: string;
  reasonCode: string;
  ownerKind: string;
  ownerName: string | null;
  note: string | null;
  setByName: string;
  setByStaffRef: string | null;
  setAt: string;
  untilAt: string;
  expired: boolean;
  hoursLeft: number | null;
};

export function toWaitingItem(r: WaitingRow): WaitingItem {
  return {
    waitingId: String(r.waiting_id),
    requestId: String(r.rent_request_id),
    req: r.req ?? String(r.rent_request_id).slice(0, 8),
    tenant: r.tenant ?? '—',
    reasonCode: r.reason_code,
    ownerKind: r.owner_kind,
    ownerName: r.owner_name,
    note: r.note,
    setByName: r.set_by_name ?? '—',
    setByStaffRef: r.set_by_staff_ref,
    setAt: r.set_at,
    untilAt: r.until_at,
    expired: r.expired === true,
    hoursLeft: r.hours_left === null || r.hours_left === undefined ? null : Number(r.hours_left),
  };
}

/** The server decides when a wait is up; `expired` is its word for it. */
export const isTimeUp = (w: WaitingItem): boolean => w.expired || (w.hoursLeft !== null && w.hoursLeft <= 0);

export function timeLeftText(h: number | null): string {
  if (h === null) return '—';
  if (h <= 0) return 'Time up';
  if (h < 1) return `${Math.max(1, Math.round(h * 60))} min left`;
  if (h < 48) return `${Math.round(h)} h left`;
  return `${(h / 24).toFixed(1)} days left`;
}

export type WaitingList = { items: WaitingItem[]; loading: boolean; missing: boolean; error: string | null };

const waitingKey = (desk: WaitDesk) => ['desk-feed', 'waiting', desk];

async function loadWaiting(desk: WaitDesk): Promise<{ items: WaitingItem[]; missing: boolean }> {
  const { data, error } = await rpc('pipeline_waiting_list', { p_desk: desk });
  if (error) {
    if (isMissingDbObject(error)) {
      logMissingOnce('pipeline_waiting_list', error);
      return { items: [], missing: true };
    }
    throw error;
  }
  const rows = Array.isArray(data) ? (data as WaitingRow[]) : [];
  return { items: rows.map(toWaitingItem), missing: false };
}

const listOptions = (desk: WaitDesk, enabled: boolean) => ({
  queryKey: waitingKey(desk),
  enabled,
  queryFn: () => loadWaiting(desk),
  refetchInterval: 60_000,
  staleTime: 30_000,
  retry: 1,
});

export function useWaitingList(desk: WaitDesk | null, enabled = true): WaitingList {
  const q = useQuery(listOptions(desk ?? 'coo', enabled && !!desk));
  return {
    items: q.data?.items ?? [],
    loading: q.isLoading && enabled && !!desk,
    missing: !!q.data?.missing,
    error: q.error ? readableError(q.error) : null,
  };
}

/** Every desk's list, for the command centre. */
export function useAllWaiting(enabled: boolean): Record<WaitDesk, WaitingList> {
  const results = useQueries({ queries: WAIT_DESKS.map((d) => listOptions(d, enabled)) });
  const out = {} as Record<WaitDesk, WaitingList>;
  WAIT_DESKS.forEach((d, i) => {
    const q = results[i];
    out[d] = {
      items: q.data?.items ?? [],
      loading: q.isLoading && enabled,
      missing: !!q.data?.missing,
      error: q.error ? readableError(q.error) : null,
    };
  });
  return out;
}

/* ───────────────────────── the form (inside the review drawer) ───────────────────────── */

const INPUT = `desk-pill h-9 w-full max-w-md border border-[var(--desk-line-color)] bg-[var(--desk-surface)] px-3 text-sm text-foreground ${FOCUS}`;

export function WaitOnForm({
  requestId,
  desk,
  deskTag,
  onDone,
}: {
  requestId: string;
  desk: WaitDesk;
  /** The reason-code catalogue's tag for this desk ('SC', 'Agent Ops', …). */
  deskTag: string;
  onDone: (message: string) => void;
}) {
  const queryClient = useQueryClient();
  const reasons = useReasonCodes();
  const [owner, setOwner] = useState<OwnerKind | ''>('');
  const [reasonCode, setReasonCode] = useState('');
  const [hours, setHours] = useState<number>(WAIT_HOURS_DEFAULT);
  const [hoursTouched, setHoursTouched] = useState(false);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const options = useMemo(() => waitReasonOptions(reasons.data ?? [], deskTag), [reasons.data, deskTag]);
  const blocked = waitBlocked({ owner, reasonCode, hours, note });

  const save = async () => {
    if (blocked || !owner) return;
    setBusy(true);
    setError(null);
    const { error: e } = await rpc('pipeline_set_waiting', {
      p_request_id: requestId,
      p_desk: desk,
      p_reason_code: reasonCode,
      p_owner_kind: owner,
      p_hours: Math.round(hours),
      p_note: note.trim() || null,
      p_rule_id: null,
      p_owner_user_id: null,
    });
    setBusy(false);
    if (e) {
      // The server's own words, as-is.
      setError(isMissingDbObject(e) ? 'Waiting is not switched on yet — try again later.' : String(e.message ?? e));
      if (isMissingDbObject(e)) logMissingOnce('pipeline_set_waiting', e);
      return;
    }
    queryClient.invalidateQueries({ queryKey: ['desk-feed'] });
    onDone(`Waiting on ${OWNER_LABEL[owner].toLowerCase()} for ${Math.round(hours)} hours. It stays at this desk.`);
  };

  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground">
        The request stays at this desk and leaves your queue until the time is up or someone puts it back.
      </p>

      <label className="block space-y-1.5">
        <span className={LABEL}>Waiting on</span>
        <select value={owner} onChange={(e) => setOwner(e.target.value as OwnerKind | '')} className={INPUT}>
          <option value="">Choose who must act…</option>
          {OWNER_CHOICES.map((o) => (
            <option key={o.kind} value={o.kind}>
              {o.label}
            </option>
          ))}
        </select>
      </label>

      <label className="block space-y-1.5">
        <span className={LABEL}>Reason code</span>
        <select
          value={reasonCode}
          onChange={(e) => {
            setReasonCode(e.target.value);
            if (!hoursTouched) setHours(defaultWaitHours(e.target.value));
          }}
          className={INPUT}
        >
          <option value="">Choose a reason code…</option>
          {options.map((r) => (
            <option key={r.code} value={r.code}>
              {r.code}
              {r.meaning ? ` — ${r.meaning}` : ''}
            </option>
          ))}
        </select>
      </label>

      <label className="block space-y-1.5">
        <span className={LABEL}>Hours to wait (at most {WAIT_HOURS_MAX})</span>
        <input
          type="number"
          inputMode="numeric"
          min={1}
          max={WAIT_HOURS_MAX}
          value={Number.isFinite(hours) ? hours : ''}
          onChange={(e) => {
            setHoursTouched(true);
            setHours(e.target.value === '' ? Number.NaN : Number(e.target.value));
          }}
          className={`${INPUT} max-w-[10rem]`}
        />
      </label>

      <label className="block space-y-1.5">
        <span className={LABEL}>
          Note{reasonCode === 'OTHER' ? ` (at least ${WAIT_NOTE_MIN} characters)` : ' (optional)'}
        </span>
        <textarea
          value={note}
          onChange={(e) => setNote(e.target.value)}
          rows={2}
          placeholder="What you are waiting for, in plain words."
          className={`w-full rounded-xl border border-[var(--desk-line-color)] bg-[var(--desk-surface)] px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground ${FOCUS}`}
        />
      </label>

      {blocked && <p className={`text-sm ${statusText.warn}`}>{blocked}</p>}
      {error && (
        <p className={`text-sm ${statusText.bad}`} role="alert">
          {error}
        </p>
      )}

      <button
        type="button"
        disabled={!!blocked || busy}
        onClick={save}
        className={`desk-pill border px-4 py-2 text-sm font-medium ${CALM} ${FOCUS} ${
          !blocked && !busy ? statusGlass.ok : 'border-[var(--desk-line-color)] bg-[var(--desk-surface)] text-muted-foreground'
        } disabled:cursor-not-allowed`}
      >
        {busy ? 'Saving…' : 'Set the wait'}
      </button>
    </div>
  );
}

/* ───────────────────────── the section on each stage desk ───────────────────────── */

export function WaitingRows({ desk, list, board }: { desk: WaitDesk; list: WaitingList; board: boolean }) {
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState<string | null>(null);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const backToQueue = async (requestId: string) => {
    setBusy(requestId);
    const { error } = await rpc('pipeline_clear_waiting', {
      p_request_id: requestId,
      p_desk: desk,
      p_reason: 'back to queue',
    });
    setBusy(null);
    if (error) {
      if (isMissingDbObject(error)) logMissingOnce('pipeline_clear_waiting', error);
      setNotes((m) => ({ ...m, [requestId]: isMissingDbObject(error) ? 'Not switched on yet.' : String(error.message ?? error) }));
      return;
    }
    queryClient.invalidateQueries({ queryKey: ['desk-feed'] });
  };

  if (list.loading) return <Skeleton className="h-16 w-full" />;
  if (list.error) return <p className={`text-sm ${statusText.bad}`}>{list.error}</p>;
  if (list.items.length === 0) return <p className="text-sm text-muted-foreground">Nothing is waiting on anyone at this desk.</p>;

  const size = board ? 'text-base' : 'text-sm';
  // Time-up first, then the least time left.
  const sorted = [...list.items].sort(
    (a, b) => Number(isTimeUp(b)) - Number(isTimeUp(a)) || (a.hoursLeft ?? Infinity) - (b.hoursLeft ?? Infinity),
  );

  return (
    <div className="overflow-x-auto">
      <table className={`w-full min-w-[640px] ${size}`}>
        <thead>
          <tr className={`${LABEL} text-left`}>
            <th className="px-2 py-1.5 font-normal">Tenant</th>
            <th className="px-2 py-1.5 font-normal">Reason</th>
            <th className="px-2 py-1.5 font-normal">Waiting on</th>
            <th className="px-2 py-1.5 font-normal">Set by</th>
            <th className="px-2 py-1.5 text-right font-normal">Time left</th>
            <th className="px-2 py-1.5" aria-label="Actions" />
          </tr>
        </thead>
        <tbody>
          {sorted.map((w) => {
            const up = isTimeUp(w);
            return (
              <tr key={w.waitingId} className="border-t border-[var(--desk-line-color)] align-top">
                <td className="px-2 py-2 text-foreground">
                  {w.tenant}
                  <span className={`${LABEL} block font-mono`}>{w.req}</span>
                </td>
                <td className="px-2 py-2 text-foreground">
                  {w.reasonCode}
                  {w.note && <span className={`${LABEL} block`}>{w.note}</span>}
                </td>
                <td className="px-2 py-2 text-foreground">
                  {OWNER_LABEL[w.ownerKind] ?? w.ownerKind}
                  {w.ownerName && <span className={`${LABEL} block`}>{w.ownerName}</span>}
                </td>
                <td className="px-2 py-2 text-foreground">
                  {w.setByName}
                  <span className={`${LABEL} block`}>{w.setByStaffRef ? `Staff ${w.setByStaffRef}` : 'No staff ID'}</span>
                </td>
                <td className="px-2 py-2 text-right tabular-nums">
                  {up ? (
                    <span className={`desk-pill inline-block border px-2 py-0.5 text-xs font-semibold ${statusGlass.bad}`}>Time up</span>
                  ) : (
                    <span className="text-foreground">{timeLeftText(w.hoursLeft)}</span>
                  )}
                </td>
                <td className="px-2 py-2 text-right">
                  <button
                    type="button"
                    disabled={busy === w.requestId}
                    onClick={() => backToQueue(w.requestId)}
                    className={`desk-pill whitespace-nowrap border border-[var(--desk-line-color)] bg-[var(--desk-surface)] px-3 py-1 text-xs ${CALM} ${FOCUS} hover:bg-[var(--desk-surface-hover)] disabled:opacity-60`}
                  >
                    {busy === w.requestId ? 'Moving…' : 'Back to queue'}
                  </button>
                  {notes[w.requestId] && <span className={`block text-[11px] ${statusText.bad}`}>{notes[w.requestId]}</span>}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
