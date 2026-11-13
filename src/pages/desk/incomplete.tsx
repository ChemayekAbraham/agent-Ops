import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
import { familySizeProblem, parseFamilySize, saveIntakeDetails, workProblem } from '@/lib/agentIntakeDetails';
import { rpc } from './reviewApi';
import { fmt } from './format';
import { CALM, FOCUS, LABEL, PANEL, statusGlass, type Status } from './deskTheme';
import { Skeleton } from './Skeleton';
import { Chip, DecisionButton, EmptyState, ErrorLine, LoadingRows, Sheet, moneyFull, stackLayout } from './ui';
import { PhotoReview } from './PhotoReview';

/**
 * E82: requirements are re-checked at Tenant Ops, Landlord Ops and the COO
 * push. A row's `incomplete` lists what is still missing; while it is not
 * empty the server refuses the pass or push (E82_INCOMPLETE).
 *
 * Agent Ops completes them in place: `pipeline_incomplete_queue(p_limit)` is
 * the list; the drawer does the photo review (agent_ops_review_photos), saves
 * family size / work (agent_save_intake_details) and attaches documents
 * (request_attach_document). The request stays where it is and moves on once
 * complete. The COO desk and the Command Centre show the count.
 */

/** "Missing: photo review, family size". Null when nothing is missing. */
export function missingText(list: string[] | null | undefined): string | null {
  const l = (list ?? []).filter(Boolean);
  return l.length ? `Missing: ${l.join(', ')}` : null;
}

export const hasMissing = (list: string[] | null | undefined): boolean => (list ?? []).filter(Boolean).length > 0;

export type IncompleteItem = {
  id: string;
  short_id: string;
  desk: string | null;
  tenant: string | null;
  agent: string | null;
  rent: number | null;
  missing: string[];
  /** E89: who should complete it — the server's suggestion for the send-back. */
  suggest_send_to?: SendBackTarget | string | null;
  /** E89: the request's status; 'coo_approved' is on the funders board. */
  status?: string | null;
};
export type IncompleteQueue = { count: number; by_desk: Record<string, number>; items: IncompleteItem[] };

export const INCOMPLETE_LIMIT = 200;

export function useIncompleteQueue(enabled = true) {
  return useQuery({
    queryKey: ['desk-feed', 'incomplete-queue', INCOMPLETE_LIMIT],
    enabled,
    queryFn: async (): Promise<IncompleteQueue> => {
      const { data, error } = await rpc('pipeline_incomplete_queue', { p_limit: INCOMPLETE_LIMIT });
      if (error) throw error;
      const d = (data ?? {}) as Partial<IncompleteQueue>;
      return {
        count: Number(d.count ?? 0),
        by_desk: (d.by_desk ?? {}) as Record<string, number>,
        items: Array.isArray(d.items) ? d.items.map((i) => ({ ...i, missing: Array.isArray(i.missing) ? i.missing : [] })) : [],
      };
    },
    refetchInterval: 60_000,
    staleTime: 20_000,
    retry: 1,
  });
}

const asIs = (e: unknown) => String((e as { message?: string } | null)?.message ?? e ?? 'Something went wrong.');
const notAuthorized = (e: unknown) => {
  const x = e as { code?: string; message?: string } | null;
  return x?.code === '42501' || /not authori[sz]ed|is for Agent Ops/i.test(String(x?.message ?? ''));
};

const BY_DESK: [string, string][] = [
  ['tenant_ops', 'Tenant Ops'],
  ['landlord_ops', 'Landlord Ops'],
  ['coo', 'COO'],
  ['funders_board', 'Funders board'],
];

function byDeskLine(by: Record<string, number>): string {
  return BY_DESK.filter(([k]) => Number(by[k] ?? 0) > 0)
    .map(([k, label]) => `${label} ${fmt('int', Number(by[k]))}`)
    .join(' · ');
}

/* ───────────── the list (Agent Ops section, and the tile's sheet) ───────────── */

function ItemList({
  items,
  onPick,
  onSendBack,
  canDemote,
}: {
  items: IncompleteItem[];
  onPick?: (i: IncompleteItem) => void;
  /** E89: "Send back" on each row (Agent Ops' list). */
  onSendBack?: (i: IncompleteItem) => void;
  /** Rows on the funders board offer it only to someone who may take them off it. */
  canDemote?: boolean;
}) {
  return (
    <ul style={{ margin: 0, padding: 0, listStyle: 'none' }} aria-label="Incomplete requests">
      {items.map((it) => {
        const body = (
          <>
            <span className="font-medium text-foreground" style={{ minWidth: 0, overflowWrap: 'anywhere' }}>
              {it.tenant ?? '—'} <span className="font-mono text-xs text-muted-foreground">{it.short_id}</span>
            </span>
            <span className="tabular-nums text-foreground" style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
              {moneyFull(it.rent)}
            </span>
            <span style={{ gridColumn: '1 / -1', display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
              <span className="desk-pill border border-[var(--desk-line-color)] px-2 py-0.5 text-[11px] text-foreground">At {it.desk ?? '—'}</span>
              <Chip tone="bad" strong>
                {missingText(it.missing)}
              </Chip>
              <span className={LABEL}>Agent {it.agent ?? '—'}</span>
            </span>
          </>
        );
        const grid = { display: 'grid', gridTemplateColumns: 'minmax(0,1fr) auto', columnGap: 12, rowGap: 4 } as const;
        return (
          <li key={it.id} data-incomplete={it.short_id} className="border-t border-[var(--desk-line-color)] first:border-t-0">
            {onPick ? (
              <button type="button" onClick={() => onPick(it)} className={`w-full rounded-xl px-2 py-2.5 text-left hover:bg-[var(--desk-surface-hover)] ${CALM} ${FOCUS}`} style={grid}>
                {body}
              </button>
            ) : (
              <div className="px-2 py-2.5" style={grid}>
                {body}
              </div>
            )}
            {onSendBack && (it.status !== ON_FUNDERS_BOARD || canDemote) && (
              <div className="px-2 pb-2.5">
                <DecisionButton size="sm" variant="quiet" onClick={() => onSendBack(it)}>
                  Send back…
                </DecisionButton>
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/** Agent Ops: "Complete missing items" — every request past Agent Ops that still lacks something. */
export function IncompleteSection({ board }: { board: boolean }) {
  const q = useIncompleteQueue();
  const [open, setOpen] = useState<IncompleteItem | null>(null);
  const [sending, setSending] = useState<IncompleteItem | null>(null);
  const demote = useCanDemote();
  if (q.error && notAuthorized(q.error)) return null;
  const d = q.data;
  return (
    <section className={`${PANEL} space-y-3 p-4 sm:p-5`} aria-label="Complete missing items" data-incomplete-section>
      <h2 className={`${board ? 'text-lg' : 'text-base'} font-semibold text-foreground`}>
        Complete missing items{d ? ` (${fmt('int', d.count)})` : ''}
      </h2>
      <p className={LABEL}>
        These requests are past Agent Ops but still miss something. Complete them here: the request stays where it is and moves on once complete.
      </p>
      {q.isLoading ? (
        <LoadingRows rows={3} height={52} label="Loading incomplete requests" />
      ) : q.error ? (
        <ErrorLine>{asIs(q.error)}</ErrorLine>
      ) : !d || d.items.length === 0 ? (
        <EmptyState>Nothing is missing.</EmptyState>
      ) : (
        <>
          {byDeskLine(d.by_desk) && <p className="text-sm text-foreground">{byDeskLine(d.by_desk)}</p>}
          <ItemList items={d.items} onPick={setOpen} onSendBack={setSending} canDemote={demote.data === true} />
        </>
      )}
      {open && <CompleteMissingSheet item={open} onClose={() => setOpen(null)} />}
      {sending && (
        <SendBackIncompleteSheet
          requestId={sending.id}
          tenant={sending.tenant}
          missing={sending.missing}
          suggest={sending.suggest_send_to}
          onClose={() => setSending(null)}
        />
      )}
    </section>
  );
}

/** COO desk and Command Centre: "Incomplete requests: {count}"; tap for the list. */
export function IncompleteCard({ board }: { board: boolean }) {
  const q = useIncompleteQueue();
  const [open, setOpen] = useState(false);
  const title = 'Incomplete requests';
  if (q.error && notAuthorized(q.error)) return null;
  const d = q.data;
  const tone: Status = d && d.count > 0 ? 'bad' : 'ok';
  return (
    <section className={`${PANEL} scroll-mt-4 space-y-2 p-4 sm:p-5`} aria-label={title} data-incomplete-card>
      <h2 className={`${board ? 'text-lg' : 'text-base'} font-semibold text-foreground`}>{title}</h2>
      {q.isLoading ? (
        <Skeleton className="h-8 w-56" />
      ) : q.error ? (
        <ErrorLine>{asIs(q.error)}</ErrorLine>
      ) : d ? (
        <>
          <button
            type="button"
            onClick={() => setOpen(true)}
            data-tone={tone}
            className={`w-full rounded-xl border px-3 py-2 text-left ${board ? 'text-lg' : 'text-base'} leading-snug ${CALM} ${FOCUS} ${statusGlass[tone]}`}
          >
            Incomplete requests: {fmt('int', d.count)}
            {byDeskLine(d.by_desk) && <span className="block text-xs opacity-90">{byDeskLine(d.by_desk)}</span>}
          </button>
          <p className={LABEL}>Agent Ops completes them in place; the COO push waits until they are complete.</p>
        </>
      ) : null}
      {open && d && (
        <Sheet title={title} onClose={() => setOpen(false)}>
          {d.items.length === 0 ? <EmptyState>Nothing is missing.</EmptyState> : <ItemList items={d.items} />}
        </Sheet>
      )}
    </section>
  );
}

/* ───────────── completing one request ───────────── */

export type DocKind = 'id_front' | 'id_back' | 'lc1_letter';
export const DOC_KINDS: { kind: DocKind; label: string; bucket: 'tenant-ids' | 'lc-letters' }[] = [
  { kind: 'id_front', label: 'Tenant ID, front', bucket: 'tenant-ids' },
  { kind: 'id_back', label: 'Tenant ID, back', bucket: 'tenant-ids' },
  { kind: 'lc1_letter', label: 'LC1 letter', bucket: 'lc-letters' },
];

/**
 * Upload into the reviewer's own folder (the buckets only take uploads under
 * `<uid>/…`), then attach it to the request. Returns the server's words on a refusal.
 */
/** Flat on purpose: the app's tsconfig is not strict, so a union would not narrow on `ok`. */
export type AttachOutcome = { ok: boolean; message?: string };

export async function attachDocument(userId: string, requestId: string, kind: DocKind, file: File): Promise<AttachOutcome> {
  const spec = DOC_KINDS.find((k) => k.kind === kind)!;
  const ext = (file.name.split('.').pop() || 'jpg').toLowerCase().replace(/[^a-z0-9]/g, '') || 'jpg';
  const path = `${userId}/${requestId}/${kind}_${Date.now()}.${ext}`;
  const up = await supabase.storage.from(spec.bucket).upload(path, file, { upsert: false, contentType: file.type || undefined });
  if (up.error) return { ok: false, message: up.error.message };
  const { error } = await rpc('request_attach_document', { p_request_id: requestId, p_kind: kind, p_bucket: spec.bucket, p_path: path });
  return error ? { ok: false, message: asIs(error) } : { ok: true };
}

function IntakeBlock({ requestId, onSaved }: { requestId: string; onSaved: () => void }) {
  const [family, setFamily] = useState('');
  const [work, setWork] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const familyOn = family.trim().length > 0;
  const workOn = work.trim().length > 0;
  const problem = !familyOn && !workOn ? 'Enter the family size or the tenant’s work.' : (familyOn && familySizeProblem(family)) || (workOn && workProblem(work)) || null;

  const save = async () => {
    if (problem) return;
    setBusy(true);
    setError(null);
    const out = await saveIntakeDetails(requestId, { familySize: familyOn ? parseFamilySize(family) : null, workBusiness: workOn ? work.trim() : null });
    setBusy(false);
    if (!out.ok) return setError(out.message);
    toast.success('Details saved');
    setFamily('');
    setWork('');
    onSaved();
  };

  return (
    <div style={stackLayout(8)} data-intake-block>
      <h3 className="text-sm font-semibold text-foreground" style={{ margin: 0 }}>
        Family size and work
      </h3>
      <label className="block space-y-1">
        <span className={LABEL}>Family size (people)</span>
        <input type="number" inputMode="numeric" min={1} max={30} value={family} onChange={(e) => setFamily(e.target.value)} aria-label="Family size" className={`desk-pill h-9 w-32 border border-[var(--desk-line-color)] bg-[var(--desk-surface)] px-3 text-sm text-foreground ${FOCUS}`} />
      </label>
      <label className="block space-y-1">
        <span className={LABEL}>Tenant’s work or business (and where)</span>
        <input type="text" value={work} onChange={(e) => setWork(e.target.value)} aria-label="Tenant’s work or business" className={`desk-pill h-9 w-full max-w-sm border border-[var(--desk-line-color)] bg-[var(--desk-surface)] px-3 text-sm text-foreground ${FOCUS}`} />
      </label>
      {problem && (familyOn || workOn) && <p className={LABEL}>{problem}</p>}
      {error && <ErrorLine>{error}</ErrorLine>}
      <div>
        <DecisionButton variant="primary" disabled={!!problem || busy} onClick={save}>
          {busy ? 'Saving…' : 'Save details'}
        </DecisionButton>
      </div>
    </div>
  );
}

function DocumentBlock({ requestId, onSaved }: { requestId: string; onSaved: () => void }) {
  const { user } = useAuth();
  const [kind, setKind] = useState<DocKind>('id_front');
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [inputKey, setInputKey] = useState(0);

  const send = async () => {
    if (!file || !user) return;
    setBusy(true);
    setError(null);
    const out = await attachDocument(user.id, requestId, kind, file);
    setBusy(false);
    if (!out.ok) return setError(out.message ?? 'The document was not attached.');
    toast.success(`${DOC_KINDS.find((k) => k.kind === kind)?.label} attached`);
    setFile(null);
    setInputKey((n) => n + 1);
    onSaved();
  };

  return (
    <div style={stackLayout(8)} data-document-block>
      <h3 className="text-sm font-semibold text-foreground" style={{ margin: 0 }}>
        Documents
      </h3>
      <div role="radiogroup" aria-label="Document" style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
        {DOC_KINDS.map((k) => (
          <button
            key={k.kind}
            type="button"
            role="radio"
            aria-checked={kind === k.kind}
            onClick={() => setKind(k.kind)}
            className={`desk-pill border px-3 py-1 text-xs ${CALM} ${FOCUS} ${kind === k.kind ? statusGlass.ok : 'border-[var(--desk-line-color)] bg-[var(--desk-surface)] text-muted-foreground'}`}
          >
            {k.label}
          </button>
        ))}
      </div>
      <input key={inputKey} type="file" accept="image/*,application/pdf" aria-label="Choose the file" onChange={(e) => setFile(e.target.files?.[0] ?? null)} className="text-sm" />
      {error && <ErrorLine>{error}</ErrorLine>}
      <div>
        <DecisionButton variant="primary" disabled={!file || busy || !user} onClick={send}>
          {busy ? 'Attaching…' : 'Attach'}
        </DecisionButton>
      </div>
    </div>
  );
}

/** What Agent Ops can do for one incomplete request, without moving it. */
export function CompleteMissingSheet({ item, onClose }: { item: IncompleteItem; onClose: () => void }) {
  const queryClient = useQueryClient();
  const q = useIncompleteQueue();
  // The list is refetched after every save; the request drops out once nothing is missing.
  const live = q.data?.items.find((i) => i.id === item.id);
  const missing = live ? live.missing : q.isFetched && q.data ? [] : item.missing;
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['desk-feed'] });
  };
  return (
    <Sheet title={`Complete ${item.tenant ?? 'this request'} · ${item.short_id}`} onClose={onClose}>
      <div data-complete-sheet style={stackLayout(16)}>
        <p className="text-sm text-foreground" style={{ margin: 0 }}>
          At {item.desk ?? '—'}. It stays there and moves on once complete.
        </p>
        {hasMissing(missing) ? (
          <Chip tone="bad" strong>
            {missingText(missing)}
          </Chip>
        ) : (
          <Chip tone="ok" strong>
            Nothing missing now
          </Chip>
        )}
        <div style={stackLayout(8)}>
          <h3 className="text-sm font-semibold text-foreground" style={{ margin: 0 }}>
            Photo review
          </h3>
          <PhotoReview requestId={item.id} />
        </div>
        <IntakeBlock requestId={item.id} onSaved={refresh} />
        <DocumentBlock requestId={item.id} onSaved={refresh} />
      </div>
    </Sheet>
  );
}

/**
 * Under a row that misses something: the list in red and, where the desk may
 * send it back, "Send back…" (E89: Agent Ops, the Service Centre or the agent).
 */
export function MissingLine({ list, onSendBack }: { list: string[] | null | undefined; onSendBack?: () => void }) {
  const text = missingText(list);
  if (!text) return null;
  return (
    <div data-missing-line style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, minWidth: 0 }}>
      <span className="text-xs font-medium text-[hsl(var(--desk-bad))]" style={{ overflowWrap: 'anywhere' }}>
        {text}
      </span>
      {onSendBack && (
        <DecisionButton size="sm" variant="quiet" onClick={onSendBack}>
          Send back…
        </DecisionButton>
      )}
    </div>
  );
}

/* ───────────── E89: send an incomplete request back to whoever completes it ───────────── */

export type SendBackTarget = 'agent_ops' | 'service_centre' | 'agent';
export const SEND_BACK_TARGETS: { code: SendBackTarget; label: string }[] = [
  { code: 'agent_ops', label: 'Agent Ops' },
  { code: 'service_centre', label: 'Service Centre' },
  { code: 'agent', label: 'Agent' },
];
/** The status a request has while it sits on the funders board. */
export const ON_FUNDERS_BOARD = 'coo_approved';

const isTarget = (t: unknown): t is SendBackTarget => SEND_BACK_TARGETS.some((x) => x.code === t);

/** May this person take a request off the funders board (`funders_board_can_demote`)? */
export function useCanDemote(enabled = true) {
  return useQuery({
    queryKey: ['desk-feed', 'funders-board-can-demote'],
    enabled,
    queryFn: async (): Promise<boolean> => {
      const { data, error } = await rpc('funders_board_can_demote', {});
      if (error) return false;
      return data === true;
    },
    staleTime: 5 * 60_000,
    retry: false,
  });
}

/** `pipeline_send_back_incomplete`: the server's "sent_to" on success, its own words on a refusal. */
export async function sendBackIncomplete(input: { requestId: string; to: SendBackTarget; note: string }): Promise<{ ok: boolean; sentTo?: string; message?: string }> {
  const { data, error } = await rpc('pipeline_send_back_incomplete', {
    p_request_id: input.requestId,
    p_to: input.to,
    p_note: input.note.trim() || null,
  });
  if (error) return { ok: false, message: asIs(error) };
  const sentTo = (data as { sent_to?: string } | null)?.sent_to ?? SEND_BACK_TARGETS.find((t) => t.code === input.to)?.label;
  return { ok: true, sentTo };
}

/**
 * "Send back…" for a request that misses something: Agent Ops, the Service
 * Centre or the agent (the server's suggestion picked), an optional note, then
 * "Send back to {target}? Missing: …". On success: "Sent back to {sent_to}",
 * and the list and the board refetch.
 */
export function SendBackIncompleteSheet({
  requestId,
  tenant,
  missing,
  suggest,
  onDone,
  onClose,
}: {
  requestId: string;
  tenant: string | null;
  missing: string[] | null | undefined;
  suggest?: string | null;
  onDone?: (message: string) => void;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [to, setTo] = useState<SendBackTarget>(isTarget(suggest) ? suggest : 'agent_ops');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const target = SEND_BACK_TARGETS.find((t) => t.code === to)!;

  const send = async () => {
    setBusy(true);
    setError(null);
    const out = await sendBackIncomplete({ requestId, to, note });
    setBusy(false);
    if (!out.ok) return setError(out.message ?? 'The send-back did not go through.');
    const message = `Sent back to ${out.sentTo}`;
    toast.success(message);
    void queryClient.invalidateQueries({ queryKey: ['desk-feed'] });
    onDone?.(message);
    onClose();
  };

  return (
    <Sheet title={`Send back ${tenant ?? 'this request'}`} onClose={onClose}>
      <div data-send-back-incomplete style={stackLayout(12)}>
        <div role="radiogroup" aria-label="Send it back to" style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {SEND_BACK_TARGETS.map((t) => (
            <button
              key={t.code}
              type="button"
              role="radio"
              aria-checked={to === t.code}
              data-target={t.code}
              onClick={() => setTo(t.code)}
              className={`desk-pill border px-3 py-1.5 text-sm ${CALM} ${FOCUS} ${to === t.code ? statusGlass.ok : 'border-[var(--desk-line-color)] bg-[var(--desk-surface)] text-muted-foreground'}`}
            >
              {t.label}
              {suggest === t.code ? <span className="ml-1 text-xs opacity-80">· suggested</span> : null}
            </button>
          ))}
        </div>
        <label className="block space-y-1">
          <span className={LABEL}>Note (optional)</span>
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            rows={2}
            className={`w-full rounded-xl border border-[var(--desk-line-color)] bg-[var(--desk-surface)] px-3 py-2 text-sm text-foreground ${FOCUS}`}
          />
        </label>
        <p className="text-sm text-foreground" style={{ margin: 0 }} data-confirm-line>
          Send back to {target.label}? {missingText(missing) ?? ''}
        </p>
        {error && <ErrorLine>{error}</ErrorLine>}
        <div>
          <DecisionButton variant="primary" disabled={busy} onClick={send}>
            {busy ? 'Sending back…' : `Send back to ${target.label}`}
          </DecisionButton>
        </div>
      </div>
    </Sheet>
  );
}
