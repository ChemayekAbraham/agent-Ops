import { useEffect, useState, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { FOCUS, LABEL, PANEL, statusText } from './deskTheme';
import { fmt } from './format';
import { readableError, rpc } from './reviewApi';
import { DeskCallButton } from './deskCall';
import { healthChip, type TenantHealth } from './paymentHealth';
import { Chip, DecisionButton, ErrorLine, LoadingRows, rowLayout, stackLayout } from './ui';

/**
 * Landlord Ops on one screen, from `landlord_ops_context(p_request_id)`: the
 * three people on the request (landlord, tenant, agent) with a call button
 * each, the rent the request asks for, the arrears hint and the call script.
 * The COO edits the script with `desk_script_set`; the server allows the COO only.
 */

export type LandlordContext = {
  rent_on_request: number | null;
  duration_days: number | null;
  tenant: { id: string | null; name: string | null; phone: string | null; payment_health: TenantHealth | null } | null;
  agent: { id: string | null; name: string | null; phone: string | null } | null;
  landlord: {
    id: string | null;
    name: string | null;
    phone: string | null;
    mobile_money_number: string | null;
    mobile_money_name: string | null;
    verified: boolean | null;
    caretaker: { name: string | null; phone: string | null } | null;
    is_agent_managed: boolean | null;
    number_of_houses: number | null;
    arrears_hint: string | null;
    welile_tenants: number | null;
  } | null;
  script: { title: string | null; body: string | null; version: number | null } | null;
};

export function useLandlordContext(requestId: string, enabled = true) {
  return useQuery({
    queryKey: ['desk-feed', 'landlord-context', requestId],
    enabled,
    queryFn: async (): Promise<LandlordContext> => {
      const { data, error } = await rpc('landlord_ops_context', { p_request_id: requestId });
      if (error) throw error;
      return (data ?? {}) as LandlordContext;
    },
    staleTime: 10_000,
    retry: 1,
  });
}

const norm = (s: string | null | undefined) => (s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/** True when the mobile money account is in another name than the landlord's. Unknown is not a mismatch. */
export function mobileMoneyMismatch(landlordName: string | null | undefined, mmName: string | null | undefined): boolean {
  const a = norm(landlordName);
  const b = norm(mmName);
  return !!a && !!b && a !== b;
}

/** "Rent on the request: UGX 500,000". */
export const rentOnRequestText = (rent: number | null | undefined) => `Rent on the request: UGX ${fmt('ugxfull', rent ?? 0)}`;

function Card({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className={`${PANEL} p-4`} style={stackLayout(6)} aria-label={title}>
      <h3 className={LABEL} style={{ margin: 0 }}>
        {title}
      </h3>
      {children}
    </section>
  );
}

function Person({ name, phone, call }: { name: string | null | undefined; phone: string | null | undefined; call: ReactNode }) {
  return (
    <div style={rowLayout(6)}>
      <span className="text-sm font-medium text-foreground">{name ?? '—'}</span>
      {call}
      <span className="font-mono text-xs text-muted-foreground">{phone ?? 'no number'}</span>
    </div>
  );
}

const Line = ({ label, children }: { label: string; children: ReactNode }) => (
  <div style={rowLayout(6)} className="text-sm">
    <span className={LABEL}>{label}</span>
    <span className="text-foreground">{children}</span>
  </div>
);

/** Landlord · Tenant · Agent, each with a call button linked to the request. */
export function ContactCards({ ctx, requestId }: { ctx: LandlordContext; requestId: string }) {
  const l = ctx.landlord;
  const t = ctx.tenant;
  const a = ctx.agent;
  const mismatch = mobileMoneyMismatch(l?.name, l?.mobile_money_name);
  const hc = healthChip(t?.payment_health);
  const desk = 'landlord_ops';

  return (
    <div className="grid gap-3 lg:grid-cols-3" style={{ display: 'grid', gap: 12 }}>
      <Card title="Landlord">
        <Person
          name={l?.name}
          phone={l?.phone}
          call={<DeskCallButton target={{ requestId, desk, subject: 'landlord', calleeId: null, name: l?.name ?? null, phone: l?.phone ?? null }} />}
        />
        <div style={rowLayout(6)}>
          <Chip tone={l?.verified ? 'ok' : 'warn'}>{l?.verified ? 'Verified' : 'Not verified'}</Chip>
          {l?.is_agent_managed && <Chip tone="warn">Managed by the agent</Chip>}
        </div>
        <Line label="Mobile money">
          <span className={mismatch ? statusText.warn : undefined} data-mismatch={mismatch ? 'true' : undefined}>
            {l?.mobile_money_name ?? 'no name'} · {l?.mobile_money_number ?? 'no number'}
            {mismatch ? ' — not the landlord’s name' : ''}
          </span>
        </Line>
        <Line label="Caretaker">{l?.caretaker ? `${l.caretaker.name ?? '—'} · ${l.caretaker.phone ?? 'no number'}` : 'None'}</Line>
        <Line label="Houses">{fmt('int', l?.number_of_houses)}</Line>
        <Line label="Welile tenants">{fmt('int', l?.welile_tenants)}</Line>
      </Card>

      <Card title="Tenant">
        <Person
          name={t?.name}
          phone={t?.phone}
          call={<DeskCallButton target={{ requestId, desk, subject: 'tenant', calleeId: t?.id ?? null, name: t?.name ?? null, phone: t?.phone ?? null }} />}
        />
        {hc && (
          <div>
            <Chip tone={hc.tone} title={hc.title}>
              {hc.text}
            </Chip>
          </div>
        )}
        {t?.payment_health?.summary && <p className="text-sm text-muted-foreground">{t.payment_health.summary}</p>}
      </Card>

      <Card title="Agent">
        <Person
          name={a?.name}
          phone={a?.phone}
          call={<DeskCallButton target={{ requestId, desk, subject: 'agent', calleeId: a?.id ?? null, name: a?.name ?? null, phone: a?.phone ?? null }} />}
        />
      </Card>
    </div>
  );
}

/** The call script the reviewer reads from; the "Value proposition offered" check sits under it. */
export function ScriptPanel({ script }: { script: LandlordContext['script'] }) {
  if (!script || (!script.title && !script.body)) return null;
  return (
    <section className={`${PANEL} p-4`} style={stackLayout(6)} aria-label="Call script">
      <div style={rowLayout(6)}>
        <h3 className="text-sm font-semibold text-foreground" style={{ margin: 0 }}>
          Call script{script.title ? `: ${script.title}` : ''}
        </h3>
        {script.version !== null && script.version !== undefined && <Chip>v{script.version}</Chip>}
      </div>
      <p className="whitespace-pre-line text-sm leading-relaxed text-foreground">{script.body}</p>
    </section>
  );
}

/** The panel at the top of the Landlord Ops drawer: rent on the request and the three contact cards. */
export function LandlordContextPanel({ requestId }: { requestId: string }) {
  const q = useLandlordContext(requestId);
  if (q.isLoading) return <LoadingRows rows={3} height={48} label="Loading the landlord's details" />;
  if (q.error) return <ErrorLine>The landlord&rsquo;s details could not load: {readableError(q.error)}</ErrorLine>;
  const ctx = q.data;
  if (!ctx) return null;
  return (
    <div style={stackLayout(12)}>
      <p className="text-base font-medium text-foreground">
        {rentOnRequestText(ctx.rent_on_request)}
        {ctx.duration_days ? <span className="ml-2 text-sm text-muted-foreground">over {ctx.duration_days} days</span> : null}
      </p>
      <ContactCards ctx={ctx} requestId={requestId} />
    </div>
  );
}

/* ───────────────────────── COO: edit the call script ───────────────────────── */

export function ScriptEditor({ desk }: { desk: 'landlord_ops' }) {
  const queryClient = useQueryClient();
  const q = useQuery({
    queryKey: ['desk-feed', 'desk-script', desk],
    queryFn: async () => {
      const { data, error } = await rpc('desk_script', { p_desk: desk });
      if (error) throw error;
      return (data ?? {}) as { title?: string | null; body?: string | null; version?: number | null };
    },
    staleTime: 60_000,
    retry: false,
  });
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    if (!q.data || loaded) return;
    setTitle(q.data.title ?? '');
    setBody(q.data.body ?? '');
    setLoaded(true);
  }, [q.data, loaded]);

  const save = async () => {
    setBusy(true);
    setMessage(null);
    const { data, error } = await rpc('desk_script_set', { p_desk: desk, p_title: title.trim(), p_body: body.trim() });
    setBusy(false);
    if (error) {
      setMessage({ ok: false, text: readableError(error) });
      return;
    }
    const v = (data as { version?: number } | null)?.version;
    setMessage({ ok: true, text: v ? `Saved as version ${v}. Landlord Ops sees it on the next request they open.` : 'Saved.' });
    queryClient.invalidateQueries({ queryKey: ['desk-feed'] });
  };

  if (q.isLoading) return <LoadingRows rows={2} height={32} label="Loading the call script" />;
  if (q.error) return <ErrorLine>The call script could not load: {readableError(q.error)}</ErrorLine>;

  const input = `w-full rounded-xl border border-[var(--desk-line-color)] bg-[var(--desk-surface)] px-3 py-2 text-sm text-foreground ${FOCUS}`;
  return (
    <div style={stackLayout(8)}>
      <p className={LABEL}>
        Landlord Ops reads this on every landlord call{q.data?.version ? ` · now version ${q.data.version}` : ''}. Only the COO can save it.
      </p>
      <label style={stackLayout(4)}>
        <span className={LABEL}>Title</span>
        <input value={title} onChange={(e) => setTitle(e.target.value)} className={input} aria-label="Script title" />
      </label>
      <label style={stackLayout(4)}>
        <span className={LABEL}>Script</span>
        <textarea value={body} onChange={(e) => setBody(e.target.value)} rows={8} className={input} aria-label="Script text" />
      </label>
      {message && (message.ok ? <p className={`text-sm ${statusText.ok}`} role="status">{message.text}</p> : <ErrorLine>{message.text}</ErrorLine>)}
      <div>
        <DecisionButton variant="primary" disabled={busy || !title.trim() || !body.trim()} onClick={save}>
          {busy ? 'Saving…' : 'Save the call script'}
        </DecisionButton>
      </div>
    </div>
  );
}
