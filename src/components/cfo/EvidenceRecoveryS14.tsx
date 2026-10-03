import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { supabase } from '@/integrations/supabase/client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { formatUGX } from '@/lib/businessAdvanceCalculations';
import { Lock, ShieldAlert } from 'lucide-react';
import { S12CaseEvidencePanel } from './S12CaseEvidencePanel';

const POP = { count: 267, amount: 24915393 };
const STATUSES = ['Awaiting Evidence Recovery', 'Evidence Collected', 'Confirmed Duplicate', 'Valid Separate Payment', 'Confirmed Agent Mismatch', 'Confirmed Genuine', 'Insufficient Evidence'];
const EV_TYPES = ['Tenant confirmation', 'Agent receipt', 'Cash handover record', 'Mobile-money/payment reference', 'Deposit evidence', 'Uploaded document', 'Other independently verifiable evidence'];
const CHECK_LABEL: Record<string, string> = {
  'Tenant confirmation': 'Tenant confirmation', 'Agent receipt': 'Agent receipt', 'Cash handover record': 'Cash handover',
  'Mobile-money/payment reference': 'Payment reference', 'Deposit evidence': 'Linked deposit', 'Uploaded document': 'Supporting document',
  'Other independently verifiable evidence': 'Other independent evidence',
};
const DUP_ANSWERS = ['One payment', 'Two separate payments', 'More than two payments', 'Tenant cannot confirm'];
const MIS_ANSWERS = ['Recorded agent', 'Other agent', 'Cannot confirm'];

type Ev = Record<string, any>;
type Match = { id: string; collected_at: string; agent_name: string | null; seconds_apart: number; reversed_at: string | null; in_population: boolean };
type Case = {
  collection_id: string; collected_at: string; case_type: 'duplicate' | 'agent_mismatch'; tenant_name: string; tenant_phone: string | null;
  rent_plan_id: string; amount: number; agent_id: string; agent_name: string; plan_agent_id: string | null; plan_agent_name: string | null;
  stage11: string; stage12: string; reversed_at: string | null; status: string; correction_status: string; confirmed_agent_id: string | null;
  valid_original_id: string | null; ledger_receipt: number | null; ledger_repayment: number | null; ledger_commission: number | null;
  evidence: Ev[]; matches: Match[];
};

const eat = (d: string) => new Date(d).toLocaleString('en-GB', { timeZone: 'Africa/Kampala' });
const short = (id?: string | null) => (id ? id.slice(0, 8) : '—');
const ugx = (v: number | null | undefined) => (v == null ? '—' : formatUGX(Number(v)));
const mins = (s: number) => `${s >= 0 ? '+' : '−'}${Math.round(Math.abs(s) / 60)} min`;
const sum = (xs: Case[]) => xs.reduce((a, c) => a + Number(c.amount), 0);

export function EvidenceRecoveryS14() {
  const qc = useQueryClient();
  const [evFor, setEvFor] = useState<Case | null>(null);
  const [decFor, setDecFor] = useState<Case | null>(null);
  const q = useQuery({
    queryKey: ['cfo-s14-list'],
    queryFn: async () => {
      const { data, error } = await (supabase.rpc as any)('cfo_s14_list');
      if (error) throw error;
      return data as { controls: Record<string, number>; cases: Case[] };
    },
  });
  const refresh = () => qc.invalidateQueries({ queryKey: ['cfo-s14-list'] });

  if (q.isLoading) return <Card><CardContent className="p-4 text-sm text-muted-foreground">Loading Stage 14…</CardContent></Card>;
  if (q.error) return <Card><CardContent className="p-4 text-sm text-destructive">Stage 14 queue refused to load: {(q.error as Error).message}</CardContent></Card>;

  const cases = q.data!.cases;
  const ctl = q.data!.controls;
  const dups = cases.filter((c) => c.case_type === 'duplicate');
  const mis = cases.filter((c) => c.case_type === 'agent_mismatch');
  const ready = cases.filter((c) => c.correction_status === 'Ready for Correction Review');
  const balanced = cases.length === POP.count && sum(cases) === POP.amount;

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle className="text-base">Stage 14 — Evidence Recovery & Case Resolution</CardTitle>
        <Badge variant="outline">Evidence only · Nothing posts</Badge>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className={`flex items-start gap-2 rounded-md border p-3 text-sm ${balanced ? 'border-border bg-muted' : 'border-destructive text-destructive'}`}>
          <ShieldAlert className="h-4 w-4 mt-0.5 shrink-0" />
          <span>
            Stage 14 population: {cases.length} / {formatUGX(sum(cases))} (expected {POP.count} / {formatUGX(POP.amount)}). Stage 11: {ctl.stage11_count} / {formatUGX(Number(ctl.stage11_amount))}.
            {' '}Evidence items {ctl.evidence_items} · decisions {ctl.decisions}. Financial records changed by Stage 14: none.
          </span>
        </div>

        <table className="w-full text-xs rounded-md border border-border">
          <thead><tr className="text-left text-muted-foreground"><th className="p-1">Status</th><th className="text-right p-1">Count</th><th className="text-right p-1">Amount</th></tr></thead>
          <tbody>
            {STATUSES.map((st) => { const xs = cases.filter((c) => c.status === st); return <tr key={st} className="border-t border-border"><td className="p-1">{st}</td><td className="text-right p-1">{xs.length}</td><td className="text-right p-1">{formatUGX(sum(xs))}</td></tr>; })}
            <tr className="border-t border-border text-muted-foreground"><td className="p-1">Ready for Correction Review (already counted above)</td><td className="text-right p-1">{ready.length}</td><td className="text-right p-1">{formatUGX(sum(ready))}</td></tr>
            <tr className="border-t border-border font-semibold"><td className="p-1">Total</td><td className="text-right p-1">{cases.length}</td><td className="text-right p-1">{formatUGX(sum(cases))}</td></tr>
          </tbody>
        </table>

        <Tabs defaultValue="dups">
          <TabsList className="flex-wrap h-auto">
            <TabsTrigger value="dups">A. Duplicate recovery ({dups.length})</TabsTrigger>
            <TabsTrigger value="mis">B. Agent mismatch recovery ({mis.length})</TabsTrigger>
            <TabsTrigger value="preview">Correction impact preview ({ready.length})</TabsTrigger>
          </TabsList>
          <TabsContent value="dups" className="max-h-[560px] overflow-auto space-y-2">
            {dups.map((c) => <CaseCard key={c.collection_id} c={c} disabled={!balanced} onEvidence={() => setEvFor(c)} onDecide={() => setDecFor(c)} />)}
          </TabsContent>
          <TabsContent value="mis" className="max-h-[560px] overflow-auto space-y-2">
            {mis.map((c) => <CaseCard key={c.collection_id} c={c} disabled={!balanced} onEvidence={() => setEvFor(c)} onDecide={() => setDecFor(c)} />)}
          </TabsContent>
          <TabsContent value="preview" className="space-y-2">
            <div className="flex items-center gap-2 text-xs font-medium"><Lock className="h-3 w-3" />Preview only — no financial records have been changed.</div>
            {ready.length === 0 ? <p className="text-sm text-muted-foreground">No case is Ready for Correction Review. Only Confirmed Duplicate and Confirmed Agent Mismatch outcomes appear here.</p>
              : ready.map((c) => <PreviewCard key={c.collection_id} c={c} />)}
          </TabsContent>
        </Tabs>
      </CardContent>
      {evFor && <EvidenceForm c={evFor} onClose={() => setEvFor(null)} onSaved={() => { setEvFor(null); refresh(); }} />}
      {decFor && <DecisionForm c={decFor} onClose={() => setDecFor(null)} onSaved={() => { setDecFor(null); refresh(); }} />}
    </Card>
  );
}

function CaseCard({ c, disabled, onEvidence, onDecide }: { c: Case; disabled: boolean; onEvidence: () => void; onDecide: () => void }) {
  const [show, setShow] = useState<string | null>(null);
  const [hist, setHist] = useState(false);
  const open = c.status === 'Awaiting Evidence Recovery' || c.status === 'Evidence Collected';
  const has = (t: string) => c.evidence.some((e) => e.evidence_type === t);
  const isDup = c.case_type === 'duplicate';
  const lines: [string, React.ReactNode][] = [
    ['Collection', <span className="font-mono">{c.collection_id}</span>],
    ['Collected (EAT)', eat(c.collected_at)],
    ['Tenant', `${c.tenant_name}${c.tenant_phone ? ` · ${c.tenant_phone}` : ''}`],
    ['Rent Plan', <span className="font-mono">{c.rent_plan_id}</span>],
    ['Amount', ugx(c.amount)],
    ['Recorded agent', c.agent_name],
    ...(!isDup ? [['Rent Plan agent', c.plan_agent_name ?? '—'] as [string, React.ReactNode]] : []),
    ['Stage 11', c.stage11],
    ['Reversal', c.reversed_at ? `Reversed ${eat(c.reversed_at)}` : 'Not reversed'],
    ['Stage 12 conclusion', c.stage12],
    ['Stage 14 status', `${c.status}${c.correction_status !== 'Not Ready' ? ` · ${c.correction_status}` : ''}`],
  ];
  return (
    <div className="rounded-md border border-border p-3 text-xs">
      <table className="w-full"><tbody>{lines.map(([k, v]) => <tr key={k}><td className="py-0.5 pr-3 text-muted-foreground whitespace-nowrap align-top">{k}</td><td>{v}</td></tr>)}</tbody></table>
      {isDup && (
        <table className="w-full mt-2">
          <thead><tr className="text-left text-muted-foreground"><th>Possible match</th><th>Collected (EAT)</th><th>Difference</th><th>Agent</th><th>Stage 11</th><th>Reversal</th><th /></tr></thead>
          <tbody>{c.matches.map((m) => (
            <tr key={m.id} className="border-t border-border">
              <td className="font-mono">{short(m.id)}</td><td className="whitespace-nowrap">{eat(m.collected_at)}</td><td>{mins(m.seconds_apart)}</td><td>{m.agent_name ?? '—'}</td>
              <td>{m.in_population ? 'Inside' : 'Outside'}</td><td>{m.reversed_at ? 'Reversed' : 'Not reversed'}</td>
              <td><Button size="sm" variant="ghost" onClick={() => setShow(show === m.id ? null : m.id)}>{show === m.id ? 'Hide' : 'Inspect'}</Button></td>
            </tr>))}</tbody>
        </table>
      )}
      <div className="mt-2 flex flex-wrap gap-1">{EV_TYPES.map((t) => <Badge key={t} variant={has(t) ? 'secondary' : 'outline'}>{CHECK_LABEL[t]}: {has(t) ? 'Present' : 'Missing'}</Badge>)}</div>
      {c.evidence.length > 0 && (
        <div className="mt-2 space-y-1">{c.evidence.map((e) => (
          <div key={e.id} className="border-t border-border pt-1">
            <span className="font-medium">{e.evidence_type}</span> · {e.evidence_date} · {e.evidence_source}{e.reference_number ? ` · ref ${e.reference_number}` : ''}
            {e.tenant_confirmation?.answer ? ` · tenant: ${e.tenant_confirmation.answer}` : ''}{e.contact_person ? ` · contacted ${e.contact_person} (${e.contact_method}, ${e.contact_date})` : ''}
            {e.attachment_path ? <FileLink path={e.attachment_path} /> : null} · {e.notes}
          </div>))}</div>
      )}
      <div className="mt-2 flex flex-wrap gap-2">
        <Button size="sm" variant="secondary" onClick={() => setShow(show === c.collection_id ? null : c.collection_id)}>{show === c.collection_id ? 'Hide existing records' : 'Inspect existing records'}</Button>
        <Button size="sm" variant="ghost" onClick={() => setHist((v) => !v)}>{hist ? 'Hide history' : 'Decision history'}</Button>
        <Button size="sm" variant="outline" disabled={disabled || !open} onClick={onEvidence}>Record evidence</Button>
        <Button size="sm" variant="outline" disabled={disabled || !open} onClick={onDecide}>Record outcome</Button>
      </div>
      {show && <div className="mt-2"><p className="text-muted-foreground mb-1">Existing system records. Collection entries, system accounting entries and system agent visits are not independent confirmation.</p><S12CaseEvidencePanel collectionId={show} recordedName={c.agent_name} planName={c.plan_agent_name} /></div>}
      {hist && <History id={c.collection_id} />}
    </div>
  );
}

function FileLink({ path }: { path: string }) {
  const open = async () => {
    const { data, error } = await supabase.storage.from('collection-evidence').createSignedUrl(path, 300);
    if (error) return toast.error(error.message);
    window.open(data.signedUrl, '_blank');
  };
  return <Button size="sm" variant="link" className="h-auto px-1 py-0 text-xs" onClick={open}>Open file</Button>;
}

function History({ id }: { id: string }) {
  const h = useQuery({
    queryKey: ['cfo-s14-history', id],
    queryFn: async () => {
      const { data, error } = await (supabase.rpc as any)('cfo_s14_history', { p_collection_id: id });
      if (error) throw error;
      return data as { stage14: Ev[]; stage12: Ev[] };
    },
  });
  if (!h.data) return <p className="mt-2 text-muted-foreground">Loading history…</p>;
  return (
    <div className="mt-2 space-y-1">
      {h.data.stage12.map((a, i) => <div key={`s12-${i}`} className="border-t border-border pt-1"><Badge variant="outline" className="mr-1">Stage 12</Badge>{eat(a.created_at)} · {a.reviewer_name} · {a.previous_status} → {a.new_status} · {a.reason}</div>)}
      {h.data.stage14.map((a) => <div key={a.id} className="border-t border-border pt-1"><Badge variant="secondary" className="mr-1">Stage 14</Badge>{eat(a.created_at)} · {a.reviewer_name} ({a.reviewer_role}) · {a.previous_status} → {a.new_status} · {a.reason}{a.evidence_refs?.length ? ` · refs ${a.evidence_refs.join(', ')}` : ''} · financial records changed: {a.financial_records_changed ? 'Yes' : 'No'}</div>)}
    </div>
  );
}

function EvidenceForm({ c, onClose, onSaved }: { c: Case; onClose: () => void; onSaved: () => void }) {
  const isDup = c.case_type === 'duplicate';
  const [f, setF] = useState<Record<string, string>>({ evidence_type: '', evidence_date: '', evidence_source: '', reference_number: '', contact_person: '', contact_date: '', contact_method: '', notes: '' });
  const [tc, setTc] = useState<Record<string, string>>({ payment_made: '', payments_count: '', amount_paid: '', approx_paid_at: '', person_paid: '', payment_method: '', statement: '', answer: '' });
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (k: string) => (v: string) => setF((p) => ({ ...p, [k]: v }));
  const setT = (k: string) => (v: string) => setTc((p) => ({ ...p, [k]: v }));
  const isTc = f.evidence_type === 'Tenant confirmation';
  const save = async () => {
    setBusy(true);
    try {
      let attachment_path = '';
      if (file) {
        attachment_path = `${c.collection_id}/s14/${Date.now()}-${file.name.replace(/[^\w.-]/g, '_')}`;
        const { error } = await supabase.storage.from('collection-evidence').upload(attachment_path, file);
        if (error) throw error;
      }
      const { error } = await (supabase.rpc as any)('cfo_s14_add_evidence', { p_collection_id: c.collection_id, p_item: { ...f, attachment_path, tenant_confirmation: isTc ? tc : null } });
      if (error) throw error;
      toast.success('Evidence recorded. No financial record was changed.');
      onSaved();
    } catch (err) { toast.error((err as Error).message); } finally { setBusy(false); }
  };
  const field = (k: string, label: string, type = 'text') => <label className="space-y-1"><span className="text-xs">{label}</span><Input type={type} value={f[k]} onChange={(e) => set(k)(e.target.value)} /></label>;
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader><DialogTitle>Record evidence — {short(c.collection_id)} · {ugx(c.amount)}</DialogTitle></DialogHeader>
        <div className="grid gap-2 sm:grid-cols-2 text-sm">
          <label className="space-y-1"><span className="text-xs">Evidence type</span>
            <Select value={f.evidence_type || undefined} onValueChange={set('evidence_type')}><SelectTrigger><SelectValue placeholder="Choose" /></SelectTrigger>
              <SelectContent>{EV_TYPES.map((t) => <SelectItem key={t} value={t}>{t}</SelectItem>)}</SelectContent></Select></label>
          {field('evidence_date', 'Evidence date', 'date')}
          {field('evidence_source', 'Evidence source')}
          {field('reference_number', 'Reference number (if any)')}
          {field('contact_person', 'Person / source contacted')}
          {field('contact_date', 'Contact date', 'date')}
          {field('contact_method', 'Contact method (call, visit, SMS…)')}
          <label className="space-y-1"><span className="text-xs">File (photo or PDF)</span><Input type="file" accept="image/*,application/pdf" onChange={(e) => setFile(e.target.files?.[0] ?? null)} /></label>
          {isTc && (
            <fieldset className="sm:col-span-2 grid gap-2 sm:grid-cols-2 rounded-md border border-border p-2">
              <legend className="text-xs font-medium px-1">Tenant confirmation</legend>
              <label className="space-y-1"><span className="text-xs">Was payment made?</span>
                <Select value={tc.payment_made || undefined} onValueChange={setT('payment_made')}><SelectTrigger><SelectValue placeholder="Choose" /></SelectTrigger>
                  <SelectContent>{['Yes', 'No', 'Cannot say'].map((x) => <SelectItem key={x} value={x}>{x}</SelectItem>)}</SelectContent></Select></label>
              <label className="space-y-1 sm:col-span-2"><span className="text-xs">{isDup ? 'Did the tenant make one payment or two separate payments?' : 'Which agent did the tenant confirm receiving the payment?'}</span>
                <Select value={tc.answer || undefined} onValueChange={setT('answer')}><SelectTrigger><SelectValue placeholder="Choose" /></SelectTrigger>
                  <SelectContent>{(isDup ? DUP_ANSWERS : MIS_ANSWERS).map((x) => <SelectItem key={x} value={x}>{x}</SelectItem>)}</SelectContent></Select></label>
              {([['payments_count', 'Number of payments involved'], ['amount_paid', 'Amount paid (UGX)'], ['approx_paid_at', 'Approximate payment date/time'], ['person_paid', 'Agent / person paid'], ['payment_method', 'Payment method']] as const).map(([k, l]) => (
                <label key={k} className="space-y-1"><span className="text-xs">{l}</span><Input value={tc[k]} onChange={(e) => setT(k)(e.target.value)} /></label>))}
              <label className="space-y-1 sm:col-span-2"><span className="text-xs">Tenant statement</span><Textarea value={tc.statement} onChange={(e) => setT('statement')(e.target.value)} /></label>
            </fieldset>
          )}
          <label className="space-y-1 sm:col-span-2"><span className="text-xs">Notes (at least 10 characters)</span><Textarea value={f.notes} onChange={(e) => set('notes')(e.target.value)} /></label>
        </div>
        <p className="text-xs text-muted-foreground">Recording evidence never decides the case and never changes any financial record.</p>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button disabled={busy || !f.evidence_type || !f.evidence_date || !f.evidence_source.trim() || f.notes.trim().length < 10} onClick={save}>Save evidence</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function DecisionForm({ c, onClose, onSaved }: { c: Case; onClose: () => void; onSaved: () => void }) {
  const isDup = c.case_type === 'duplicate';
  const outcomes = isDup ? ['Confirmed Duplicate', 'Valid Separate Payment', 'Insufficient Evidence'] : ['Confirmed Agent Mismatch', 'Confirmed Genuine', 'Insufficient Evidence'];
  const [outcome, setOutcome] = useState('');
  const [reason, setReason] = useState('');
  const [ids, setIds] = useState<string[]>([]);
  const [orig, setOrig] = useState('');
  const [agent, setAgent] = useState('');
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    const { error } = await (supabase.rpc as any)('cfo_s14_decide', { p_collection_id: c.collection_id, p_outcome: outcome, p_reason: reason, p_fields: { evidence_ids: ids, valid_original_id: orig, confirmed_agent_id: agent } });
    setBusy(false);
    if (error) return toast.error(error.message);
    toast.success('Outcome recorded. Nothing was posted.');
    onSaved();
  };
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader><DialogTitle>Record outcome — {short(c.collection_id)} · {ugx(c.amount)}</DialogTitle></DialogHeader>
        <div className="space-y-2 text-sm">
          <Select value={outcome || undefined} onValueChange={setOutcome}><SelectTrigger><SelectValue placeholder="Choose an outcome" /></SelectTrigger>
            <SelectContent>{outcomes.map((o) => <SelectItem key={o} value={o}>{o}</SelectItem>)}</SelectContent></Select>
          <fieldset className="space-y-1"><legend className="text-xs">Evidence used</legend>
            {c.evidence.length === 0 ? <p className="text-xs text-muted-foreground">No Stage 14 evidence recorded. Only Insufficient Evidence is possible.</p> : c.evidence.map((e) => (
              <label key={e.id} className="flex items-start gap-2 text-xs"><input type="checkbox" checked={ids.includes(e.id)} onChange={(ev) => setIds((p) => ev.target.checked ? [...p, e.id] : p.filter((x) => x !== e.id))} />
                {e.evidence_type} · {e.evidence_date}{e.reference_number ? ` · ref ${e.reference_number}` : ''}{e.attachment_path ? ' · file' : ''}{e.tenant_confirmation?.answer ? ` · tenant: ${e.tenant_confirmation.answer}` : ''}</label>))}
          </fieldset>
          {outcome === 'Confirmed Duplicate' && (
            <Select value={orig || undefined} onValueChange={setOrig}><SelectTrigger><SelectValue placeholder="Valid original collection" /></SelectTrigger>
              <SelectContent>{c.matches.filter((m) => !m.reversed_at).map((m) => <SelectItem key={m.id} value={m.id}>{short(m.id)} · {eat(m.collected_at)} · {mins(m.seconds_apart)}</SelectItem>)}</SelectContent></Select>
          )}
          {outcome === 'Confirmed Agent Mismatch' && (
            <label className="space-y-1 block"><span className="text-xs">Confirmed collecting agent ID (recorded: {c.agent_name}; Rent Plan agent: {c.plan_agent_name ?? '—'})</span><Input value={agent} onChange={(e) => setAgent(e.target.value)} /></label>
          )}
          <label className="space-y-1 block"><span className="text-xs">Reason (at least 10 characters)</span><Textarea value={reason} onChange={(e) => setReason(e.target.value)} /></label>
          <p className="text-xs text-muted-foreground">Confirmed outcomes need a supporting tenant confirmation plus a corroborating item with a reference or file; the server refuses anything less. No outcome changes a financial record.</p>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button disabled={busy || !outcome || reason.trim().length < 10} onClick={save}>Record outcome</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function PreviewCard({ c }: { c: Case }) {
  const isDup = c.status === 'Confirmed Duplicate';
  const lines: [string, string][] = [
    ['Collection', `${c.collection_id} · ${ugx(c.amount)}`],
    ['Current recorded agent', c.agent_name],
    ['Confirmed outcome', c.status + (isDup ? ` · original ${short(c.valid_original_id)}` : ` · confirmed agent ${short(c.confirmed_agent_id)}`)],
    ['Evidence supporting outcome', c.evidence.map((e) => `${e.evidence_type}${e.reference_number ? ` (${e.reference_number})` : ''}`).join(', ') || '—'],
    ['Potential accounting impact', isDup ? `Duplicate legs would be countered (receipt ${ugx(c.ledger_receipt)}, repayment ${ugx(c.ledger_repayment)}, commission ${ugx(c.ledger_commission)})` : 'Collection and commission would be reattributed between agents; amounts unchanged'],
    ['Potential wallet / float impact', isDup ? `Agent commission ${ugx(c.ledger_commission)} in question` : 'Commission would move between agents'],
    ['Potential receivable impact', isDup ? `Tenant Rent Plan receivable would rise by ${ugx(c.amount)}` : 'None'],
    ['Potential ledger impact', 'To be designed in a later, separately approved correction stage'],
  ];
  return (
    <div className="rounded-md border border-border p-3 text-xs">
      <p className="font-medium mb-1">Preview only — no financial records have been changed.</p>
      <table className="w-full"><tbody>{lines.map(([k, v]) => <tr key={k}><td className="py-0.5 pr-3 text-muted-foreground whitespace-nowrap align-top">{k}</td><td>{v}</td></tr>)}</tbody></table>
    </div>
  );
}
