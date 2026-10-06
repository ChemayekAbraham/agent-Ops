import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { formatUGX } from '@/lib/businessAdvanceCalculations';
import { toast } from 'sonner';

/**
 * Read-only evidence presentation for one Stage 12 case.
 * Shows what exists, what is missing and what is system-generated (inconclusive).
 * It never classifies, recommends or preselects an outcome, and writes nothing.
 */
type Ev = Record<string, any>;
type State = 'Present' | 'Missing' | 'Inconclusive';
const eat = (d?: string | null) => (d ? new Date(d).toLocaleString('en-GB', { timeZone: 'Africa/Kampala' }) : '—');
const ugx = (v: any) => (v == null ? '—' : formatUGX(Number(v)));

async function openFile(path: string) {
  const { data, error } = await supabase.storage.from('collection-evidence').createSignedUrl(path, 300);
  if (error || !data?.signedUrl) { toast.error('Could not open the evidence file'); return; }
  window.open(data.signedUrl, '_blank', 'noopener,noreferrer');
}

export function S12CaseEvidencePanel({ collectionId, recordedName, planName }: { collectionId: string; recordedName: string; planName: string | null }) {
  const q = useQuery({
    queryKey: ['cfo-s12-case-evidence', collectionId],
    queryFn: async () => {
      const { data, error } = await (supabase.rpc as any)('cfo_s12_case_evidence', { p_collection_id: collectionId });
      if (error) throw error;
      return data as Ev;
    },
  });
  if (q.isLoading) return <p className="text-muted-foreground">Loading evidence…</p>;
  if (q.error) return <p className="text-destructive">{(q.error as Error).message}</p>;
  const d = q.data ?? {};
  const c = d.collection ?? {};
  const who = (id?: string | null, name?: string | null) =>
    !id ? '—' : `${name ?? id.slice(0, 8)} — ${id === d.recorded_agent_id ? 'the recorded agent' : id === d.plan_agent_id ? 'the Rent Plan agent' : 'a different person'}`;

  const sections: { title: string; state: State; note: string; body: React.ReactNode }[] = [
    {
      title: '1. Agent receipt',
      state: d.agent_receipts?.length ? 'Present' : 'Missing',
      note: d.agent_receipts?.length ? 'Receipts by either agent for this amount, or from the tenant\'s phone, within 2 days.' : `No receipt from ${recordedName} or ${planName ?? 'the Rent Plan agent'} for this amount, or from the tenant's phone, within 2 days.`,
      body: (d.agent_receipts ?? []).map((a: Ev) => (
        <Item key={a.id} rows={[['Reference', a.transaction_id ?? a.id], ['Date', eat(a.created_at)], ['Amount', ugx(a.amount)], ['Named agent', who(a.agent_id, a.agent_name)],
          ['Payer', `${a.payer_name ?? '—'} · ${a.payer_phone ?? '—'}`], ['Method', a.method ?? '—'], ['Notes', a.notes ?? '—']]}
          action={a.image_url ? <Button size="sm" variant="outline" onClick={() => window.open(a.image_url, '_blank', 'noopener,noreferrer')}>Open receipt image</Button> : <span className="text-muted-foreground">No image</span>} />
      )),
    },
    {
      title: '2. Tenant confirmation',
      state: d.tenant_receipts?.length ? 'Present' : 'Missing',
      note: d.tenant_receipts?.length ? 'Receipts the tenant submitted within 2 days.' : `No tenant receipt or confirmation on record within 2 days. Payment SMS to tenant: ${c.sms_sent_tenant ? 'sent' : 'not sent'}.`,
      body: (d.tenant_receipts ?? []).map((t: Ev) => (
        <Item key={t.id} rows={[['Reference', t.receipt_number_id ?? t.id], ['Date', eat(t.created_at)], ['Amount', ugx(t.amount)], ['Description', t.description ?? '—'],
          ['Verified', t.verified ? `Yes, ${eat(t.verified_at)}` : 'No'], ['Agent named by tenant', 'Not recorded']]} />
      )),
    },
    {
      title: '3. Cash handover evidence',
      state: 'Missing',
      note: 'No independent handover record exists in the system. The only record is the collection itself, entered by the recorded agent (shown below as system-generated).',
      body: <Item inconclusive rows={[['Recorded by', who(c.initiated_by, c.initiated_by_name)], ['Date/time', eat(c.created_at)], ['Method / channel', `${c.payment_method ?? '—'} · ${c.channel ?? '—'}`],
        ['Tracking ID', c.tracking_id ?? '—'], ['Float before → after', `${ugx(c.float_before)} → ${ugx(c.float_after)}`], ['Notes', c.notes ?? '—']]} />,
    },
    {
      title: '4. Deposit evidence',
      state: d.deposits?.length ? 'Present' : 'Missing',
      note: d.deposits?.length ? 'Linked deposit, or deposits by either agent for this amount within 2 days.' : 'No linked deposit, and no deposit by either agent for this amount within 2 days.',
      body: (d.deposits ?? []).map((x: Ev) => (
        <Item key={x.id} rows={[['Reference', x.transaction_id ?? x.id], ['Date/time', eat(x.transaction_date ?? x.created_at)], ['Amount', ugx(x.amount)],
          ['Depositing agent', who(x.agent_id ?? x.user_id, x.agent_id && x.agent_id !== x.user_id ? null : x.user_name)], ['Account', `${x.user_name ?? short8(x.user_id)} · ${x.provider ?? 'no provider recorded'}`], ['Status', x.status],
          ['Linked to this collection', x.linked ? 'Yes — the collection record points to this deposit' : 'No — same agent, amount and nearby date only; this is not proof the deposit belongs to this collection']]} />
      )),
    },
    {
      title: '5. Other supporting evidence',
      state: d.files?.length || c.momo_transaction_id ? 'Present' : (d.visits?.length || d.ledger?.length) ? 'Inconclusive' : 'Missing',
      note: 'Uploaded files and mobile-money references are independent. Visits created at the same instant as the collection and accounting entries are generated by the system from the agent\'s own entry, so they cannot show who physically collected the cash.',
      body: (
        <>
          {(d.files ?? []).map((f: Ev) => <Item key={f.path} rows={[['File', f.path.split('/').pop()], ['Uploaded', eat(f.uploaded_at)]]} action={<Button size="sm" variant="outline" onClick={() => openFile(f.path)}>Open document</Button>} />)}
          {c.momo_transaction_id && <Item rows={[['Mobile-money reference', c.momo_transaction_id], ['Provider', c.momo_provider ?? '—'], ['Payer', `${c.momo_payer_name ?? '—'} · ${c.momo_phone ?? '—'}`]]} />}
          {(d.visits ?? []).map((v: Ev) => (
            <Item key={v.id} inconclusive={v.same_instant || (Number(v.latitude) === 0 && Number(v.longitude) === 0)} rows={[['Visit', `${eat(v.checked_in_at)} · ${v.location_name ?? '—'}`], ['Agent', who(v.agent_id, v.agent_name)],
              ['GPS', Number(v.latitude) === 0 && Number(v.longitude) === 0 ? 'None (0, 0)' : `${v.latitude}, ${v.longitude} (±${v.accuracy ?? '?'} m)`], ['Created with the collection', v.same_instant ? 'Yes — system-generated' : 'No']]} />
          ))}
          {d.ledger?.length > 0 && (
            <Item inconclusive rows={[['Accounting entries', `${d.ledger.length} entries`]]} extra={
              <table className="w-full mt-1"><tbody>{d.ledger.map((g: Ev, i: number) => (
                <tr key={i} className="border-t border-border"><td>{g.direction}</td><td>{g.category}</td><td className="text-right">{ugx(g.amount)}</td><td>{who(g.user_id, g.user_name)}</td></tr>))}</tbody></table>} />
          )}
        </>
      ),
    },
  ];

  return (
    <div className="space-y-2">
      <Item rows={[['Collection', <span className="font-mono">{collectionId}</span>], ['Date/time', c.created_at ? eat(c.created_at) : '—'], ['Tenant', d.tenant_name ?? '—'],
        ['Rent Plan', <span className="font-mono">{d.rent_plan_id ?? '—'}</span>], ['Amount', ugx(d.amount)], ['Recorded agent', d.agent_name ?? '—'],
        ['Stage 11', d.in_population === false ? 'Outside the 659' : 'Inside the 659'], ['Reversal', d.reversed_at ? `Reversed ${eat(d.reversed_at)}` : 'Not reversed']]} />
      <p className="text-muted-foreground">Read-only. "Present" means a record exists; it is not a conclusion. Inconclusive items are system-generated. Nothing here classifies the case.</p>
      {sections.map((s) => (
        <div key={s.title} className="rounded border border-border p-2">
          <div className="flex items-center justify-between gap-2"><p className="font-medium">{s.title}</p>
            <Badge variant={s.state === 'Present' ? 'secondary' : 'outline'}>{s.state}</Badge></div>
          <p className="text-muted-foreground mt-0.5">{s.note}</p>
          <div className="space-y-1 mt-1">{s.body}</div>
        </div>
      ))}
    </div>
  );
}

const short8 = (id?: string | null) => (id ? id.slice(0, 8) : '—');
function Item({ rows, action, extra, inconclusive }: { rows: [string, React.ReactNode][]; action?: React.ReactNode; extra?: React.ReactNode; inconclusive?: boolean }) {
  return (
    <div className="rounded bg-muted p-2">
      {inconclusive && <Badge variant="outline" className="mb-1">Inconclusive · system-generated</Badge>}
      <table className="w-full"><tbody>{rows.map(([k, v]) => <tr key={k}><td className="pr-3 text-muted-foreground whitespace-nowrap align-top">{k}</td><td>{v}</td></tr>)}</tbody></table>
      {extra}
      {action && <div className="mt-1">{action}</div>}
    </div>
  );
}
