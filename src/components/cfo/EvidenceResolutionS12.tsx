import { useMemo, useState } from 'react';
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

const STATUSES = ['Pending Evidence', 'Confirmed Genuine', 'Confirmed Duplicate', 'Confirmed Agent Mismatch', 'Valid Separate Payment', 'Unresolved'];
const TYPES = ['Agent receipt', 'Tenant confirmation', 'Cash handover record', 'Deposit/bank evidence', 'Mobile-money evidence', 'Other supporting evidence'];
const POP = { count: 659, amount: 56946270 };
const CONFIRMED = ['Confirmed Genuine', 'Confirmed Duplicate', 'Confirmed Agent Mismatch', 'Valid Separate Payment'];
const allowedFor = (result: string) =>
  result === 'System-inconsistent' ? ['Confirmed Agent Mismatch', 'Confirmed Genuine', 'Unresolved']
  : result === 'System duplicate candidate' ? STATUSES
  : STATUSES.filter((x) => x !== 'Confirmed Duplicate');

type Match = { id: string; collected_at: string; agent_id: string; amount: number; seconds_apart: number; reversed_at: string | null; in_population: boolean };
type Ev = Record<string, any>;
type Row = {
  collection_id: string; collected_at: string; agent_id: string; agent_name: string; tenant_name: string; rent_plan_id: string;
  plan_agent_id: string | null; plan_agent_name: string | null; amount: number; original_classification: string; reconciliation_result: string;
  ledger_group: string | null; ledger_receipt: number | null; ledger_repayment: number | null; ledger_commission: number | null;
  access_fee: number | null; registration_fee: number | null; reversed_at: string | null; findings: string; evidence: Ev; matches: Match[] | null;
};

const eat = (d: string) => new Date(d).toLocaleString('en-GB', { timeZone: 'Africa/Kampala' });
const short = (id?: string | null) => (id ? id.slice(0, 8) : '—');
const ugx = (v: number | null | undefined) => (v == null ? '—' : formatUGX(Number(v)));
const mins = (s: number) => `${s >= 0 ? '+' : '−'}${Math.round(Math.abs(s) / 60)} min`;

export function EvidenceResolutionS12() {
  const qc = useQueryClient();
  const [open, setOpen] = useState<Row | null>(null);
  const list = useQuery({
    queryKey: ['cfo-s12-list'],
    queryFn: async () => {
      const { data, error } = await (supabase.rpc as any)('cfo_s12_list');
      if (error) throw error;
      return (data ?? []) as Row[];
    },
  });
  const summary = useQuery({
    queryKey: ['cfo-s12-summary'],
    queryFn: async () => {
      const { data, error } = await (supabase.rpc as any)('cfo_s12_summary');
      if (error) throw error;
      return data as { population: number; amount: number; balanced: boolean; by_status: Record<string, { count: number; amount: number }>; correction_ready: { count: number; amount: number } };
    },
  });
  const rows = list.data ?? [];
  const mismatch = rows.filter((r) => r.reconciliation_result === 'System-inconsistent');
  const dups = rows.filter((r) => r.reconciliation_result === 'System duplicate candidate');
  const consistent = rows.filter((r) => r.reconciliation_result === 'System-consistent');
  const ready = rows.filter((r) => r.evidence?.correction_status === 'Ready for CFO Review');
  const internalPairs = useMemo(() => {
    const s = new Set<string>();
    dups.forEach((r) => (r.matches ?? []).filter((m) => m.in_population).forEach((m) => s.add([r.collection_id, m.id].sort().join('|'))));
    return s.size;
  }, [dups]);
  const s = summary.data;
  const sumCount = s ? Object.values(s.by_status ?? {}).reduce((a, v) => a + Number(v.count), 0) : 0;
  const sumAmt = s ? Object.values(s.by_status ?? {}).reduce((a, v) => a + Number(v.amount), 0) : 0;
  const balanced = !!s && s.balanced && sumCount === POP.count && sumAmt === POP.amount;
  const refresh = () => { qc.invalidateQueries({ queryKey: ['cfo-s12-list'] }); qc.invalidateQueries({ queryKey: ['cfo-s12-summary'] }); };

  if (list.isLoading || summary.isLoading) return <Card><CardContent className="p-4 text-sm text-muted-foreground">Loading Stage 12…</CardContent></Card>;
  if (list.error || summary.error) return <Card><CardContent className="p-4 text-sm text-destructive">{((list.error || summary.error) as Error).message}</CardContent></Card>;

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle className="text-base">Stage 12 — Evidence Resolution</CardTitle>
        <Badge variant="outline">Investigation only · Nothing posts</Badge>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className={`flex items-start gap-2 rounded-md border p-3 text-sm ${balanced ? 'border-border bg-muted' : 'border-destructive text-destructive'}`}>
          <ShieldAlert className="h-4 w-4 mt-0.5 shrink-0" />
          <span>
            {balanced
              ? `Reconciled: ${sumCount} collections / ${formatUGX(sumAmt)} = Stage 11 population ${POP.count} / ${formatUGX(POP.amount)}.`
              : `OUT OF BALANCE: Stage 12 shows ${sumCount} / ${formatUGX(sumAmt)} against ${POP.count} / ${formatUGX(POP.amount)}. Evidence recording is locked until this is resolved.`}
          </span>
        </div>

        <div className="grid gap-2 sm:grid-cols-4">
          {STATUSES.map((k) => (
            <div key={k} className="rounded-md border border-border p-2">
              <p className="text-xs text-muted-foreground">{k}</p>
              <p className="font-semibold">{s?.by_status?.[k]?.count ?? 0}</p>
              <p className="text-xs">{formatUGX(Number(s?.by_status?.[k]?.amount ?? 0))}</p>
            </div>
          ))}
          <div className="rounded-md border border-border p-2">
            <p className="text-xs text-muted-foreground">Ready for CFO Review</p>
            <p className="font-semibold">{s?.correction_ready.count ?? 0}</p>
            <p className="text-xs">{formatUGX(Number(s?.correction_ready.amount ?? 0))}</p>
          </div>
          <div className="rounded-md border border-border p-2">
            <p className="text-xs text-muted-foreground">Stage 11 population</p>
            <p className="font-semibold">{POP.count}</p>
            <p className="text-xs">{formatUGX(POP.amount)}</p>
          </div>
        </div>

        <Tabs defaultValue="mismatch">
          <TabsList className="flex-wrap h-auto">
            <TabsTrigger value="mismatch">A. Agent mismatch ({mismatch.length})</TabsTrigger>
            <TabsTrigger value="dups">B. Duplicate candidates ({dups.length})</TabsTrigger>
            <TabsTrigger value="consistent">C. System-consistent ({consistent.length})</TabsTrigger>
            <TabsTrigger value="preview">Correction Preview ({ready.length})</TabsTrigger>
          </TabsList>

          <TabsContent value="mismatch" className="max-h-[520px] overflow-auto space-y-2">
            <MismatchSummary rows={mismatch} />
            {mismatch.map((r) => <MismatchCaseCard key={r.collection_id} r={r} disabled={!balanced} onOpen={() => setOpen(r)} />)}
          </TabsContent>

          <TabsContent value="dups" className="max-h-[520px] overflow-auto space-y-2">
            <p className="text-xs text-muted-foreground">{dups.filter((r) => (r.matches ?? []).some((m) => m.in_population)).length} candidates have at least one matching collection inside the Stage 11 population (marked "Both in 659"), forming {internalPairs} distinct pairs. Falling inside the 30-minute rule does not make a collection a confirmed duplicate.</p>
            <table className="w-full text-xs">
              <thead className="sticky top-0 bg-background"><tr className="text-left text-muted-foreground">
                <th>Collection</th><th>Tenant</th><th>Rent Plan</th><th>Agent</th><th className="text-right">Amount</th><th>Collected (EAT)</th><th>Suspected match(es)</th><th>Multiple</th><th>Accounting</th><th>Reversal</th><th>Stage 11</th><th>Stage 12 status</th><th />
              </tr></thead>
              <tbody>{dups.map((r) => {
                const both = (r.matches ?? []).some((m) => m.in_population);
                return (
                  <tr key={r.collection_id} className={`border-t border-border align-top ${both ? 'bg-muted' : ''}`}>
                    <td className="py-1 font-mono">{short(r.collection_id)}{both && <Badge className="ml-1" variant="secondary">Both in 659</Badge>}</td>
                    <td>{r.tenant_name}</td><td className="font-mono">{short(r.rent_plan_id)}</td><td>{r.agent_name}</td>
                    <td className="text-right whitespace-nowrap">{ugx(r.amount)}</td><td className="whitespace-nowrap">{eat(r.collected_at)}</td>
                    <td>{(r.matches ?? []).map((m) => (
                      <div key={m.id} className="whitespace-nowrap"><span className="font-mono">{short(m.id)}</span> · {eat(m.collected_at)} · {mins(m.seconds_apart)} · {m.in_population ? 'in 659' : 'outside 659'}{m.reversed_at ? ' · reversed' : ''}</div>
                    ))}</td>
                    <td>{(r.matches ?? []).length > 1 ? `Yes (${(r.matches ?? []).length})` : 'No'}</td>
                    <td>Posted · group {short(r.ledger_group)}</td><td>{r.reversed_at ? 'Reversed' : 'Not reversed'}</td>
                    <td>{r.reconciliation_result}</td><td>{r.evidence.evidence_status}</td>
                    <td><Button size="sm" variant="outline" disabled={!balanced} onClick={() => setOpen(r)}>Evidence</Button></td>
                  </tr>);
              })}</tbody>
            </table>
          </TabsContent>

          <TabsContent value="consistent" className="max-h-[520px] overflow-auto">
            <p className="text-xs text-muted-foreground mb-2">These stay Pending Evidence until independent evidence confirms the cash was collected.</p>
            <table className="w-full text-xs">
              <thead className="sticky top-0 bg-background"><tr className="text-left text-muted-foreground"><th>Collection</th><th>Collected (EAT)</th><th>Agent</th><th>Tenant</th><th className="text-right">Amount</th><th>Original</th><th>Evidence</th><th /></tr></thead>
              <tbody>{consistent.map((r) => (
                <tr key={r.collection_id} className="border-t border-border">
                  <td className="py-1 font-mono">{short(r.collection_id)}</td><td className="whitespace-nowrap">{eat(r.collected_at)}</td><td>{r.agent_name}</td><td>{r.tenant_name}</td>
                  <td className="text-right whitespace-nowrap">{ugx(r.amount)}</td><td>{r.original_classification}</td><td>{r.evidence.evidence_status}</td>
                  <td><Button size="sm" variant="outline" disabled={!balanced} onClick={() => setOpen(r)}>Evidence</Button></td>
                </tr>))}</tbody>
            </table>
          </TabsContent>

          <TabsContent value="preview" className="space-y-2">
            <div className="flex items-center gap-2 text-xs text-muted-foreground"><Lock className="h-3 w-3" />Read-only preview. Nothing on this screen posts, reverses or approves a correction.</div>
            {ready.length === 0 ? <p className="text-sm text-muted-foreground">No collection has been classified as needing correction yet. Only Confirmed Duplicate and Confirmed Agent Mismatch records appear here.</p> : ready.map((r) => <PreviewCard key={r.collection_id} r={r} rows={rows} />)}
          </TabsContent>
        </Tabs>
      </CardContent>
      {open && <EvidenceDialog row={open} onClose={() => setOpen(null)} onSaved={() => { setOpen(null); refresh(); }} />}
    </Card>
  );
}

const CHECKLIST = ['Agent receipt', 'Tenant confirmation', 'Cash handover evidence', 'Deposit evidence', 'Other supporting evidence'];
function MismatchCaseCard({ r, disabled, onOpen }: { r: Row; disabled: boolean; onOpen: () => void }) {
  const e = r.evidence ?? {};
  const have: string[] = e.evidence_checklist ?? [];
  const available = [
    ...have,
    e.evidence_type && `Recorded type: ${e.evidence_type}`,
    e.evidence_reference && `Ref ${e.evidence_reference}`,
    e.attachment_path && 'File attached',
  ].filter(Boolean) as string[];
  const decided = e.evidence_status !== 'Pending Evidence';
  const missing = decided && e.evidence_status !== 'Unresolved' ? [] : ['Who actually collected the cash: at least one of agent receipt, tenant confirmation, cash handover or deposit evidence'];
  const lines: [string, React.ReactNode][] = [
    ['Collection', <span className="font-mono">{r.collection_id}</span>],
    ['Collected (EAT)', eat(r.collected_at)],
    ['Tenant', r.tenant_name],
    ['Rent Plan', <span className="font-mono">{r.rent_plan_id}</span>],
    ['Amount', ugx(r.amount)],
    ['Recorded collecting agent', r.agent_name],
    ['Rent Plan agent', r.plan_agent_name ?? '—'],
    ['Difference', r.plan_agent_id && r.plan_agent_id !== r.agent_id ? `Recorded as ${r.agent_name}, but the Rent Plan belongs to ${r.plan_agent_name ?? 'another agent'}` : 'No agent difference on record'],
    ['Stage 11', r.reconciliation_result],
    ['Accounting entries', `Group ${short(r.ledger_group)} · receipt ${ugx(r.ledger_receipt)} · repayment ${ugx(r.ledger_repayment)} · commission ${ugx(r.ledger_commission)}`],
    ['Reversal', r.reversed_at ? `Reversed ${eat(r.reversed_at)}` : 'Not reversed'],
    ['Stage 12 status', e.evidence_status],
    ['Evidence available', available.length ? available.join(' · ') : 'None yet'],
    ['Evidence still required', missing.length ? missing.join('; ') : 'None'],
    ['Decision status', decided ? `Decided ${e.verified_at ? eat(e.verified_at) : ''}` : 'Awaiting CFO decision'],
  ];
  return (
    <div className="rounded-md border border-border p-3 text-xs">
      <table className="w-full"><tbody>{lines.map(([k, v]) => <tr key={k}><td className="py-0.5 pr-3 text-muted-foreground whitespace-nowrap align-top">{k}</td><td>{v}</td></tr>)}</tbody></table>
      <div className="mt-2 flex flex-wrap gap-1">{CHECKLIST.map((c) => <Badge key={c} variant={have.includes(c) ? 'secondary' : 'outline'}>{have.includes(c) ? '✓ ' : ''}{c}</Badge>)}</div>
      <Button size="sm" variant="outline" className="mt-2" disabled={disabled} onClick={onOpen}>Review evidence</Button>
    </div>
  );
}

const MISMATCH_POP = { count: 14, amount: 1684334 };
function MismatchSummary({ rows }: { rows: Row[] }) {
  const by = (st: string) => rows.filter((r) => r.evidence?.evidence_status === st);
  const tot = (xs: Row[]) => xs.reduce((a, r) => a + Number(r.amount), 0);
  const ready = rows.filter((r) => r.evidence?.correction_status === 'Ready for CFO Review');
  const total = tot(rows);
  const ok = rows.length === MISMATCH_POP.count && total === MISMATCH_POP.amount;
  const outcomes = ['Pending Evidence', 'Confirmed Agent Mismatch', 'Confirmed Genuine', 'Unresolved'];
  return (
    <div className="rounded-md border border-border p-2 text-xs">
      <p className="font-medium mb-1">Stage 12B — agent mismatch outcomes</p>
      <table className="w-full"><tbody>
        {outcomes.map((o) => <tr key={o}><td>{o}</td><td className="text-right">{by(o).length}</td><td className="text-right">{formatUGX(tot(by(o)))}</td></tr>)}
        <tr className="text-muted-foreground"><td>Ready for CFO Review (already counted above)</td><td className="text-right">{ready.length}</td><td className="text-right">{formatUGX(tot(ready))}</td></tr>
        <tr className="border-t border-border font-semibold"><td>Total</td><td className="text-right">{rows.length}</td><td className="text-right">{formatUGX(total)}</td></tr>
      </tbody></table>
      {!ok && <p className="text-destructive mt-1">Expected {MISMATCH_POP.count} / {formatUGX(MISMATCH_POP.amount)} — out of balance.</p>}
    </div>
  );
}

function PreviewCard({ r, rows }: { r: Row; rows: Row[] }) {
  const e = r.evidence;
  const isDup = e.evidence_status === 'Confirmed Duplicate';
  const orig = rows.find((x) => x.collection_id === e.valid_original_id);
  const fees = Number(r.access_fee ?? 0) + Number(r.registration_fee ?? 0);
  const lines: [string, string][] = [
    ['Original collection', `${short(r.collection_id)} · ${eat(r.collected_at)} · ${r.agent_name} · ${r.tenant_name} · ${ugx(r.amount)}`],
    ['Reason', isDup ? `Duplicate of valid original ${short(e.valid_original_id)}${orig ? ` (${eat(orig.collected_at)})` : ''}` : `Collected by a different agent than recorded`],
    ['Evidence', `${e.evidence_type ?? '—'} · ref ${e.evidence_reference ?? '—'} · receipt ${e.receipt_number ?? '—'} · ${e.evidence_source ?? ''}`],
    ['Original accounting impact', `Receipt in transit ${ugx(r.ledger_receipt)} · tenant repayment ${ugx(r.ledger_repayment)} · agent commission ${ugx(r.ledger_commission)}${fees ? ` · fees ${formatUGX(fees)}` : ''}`],
    ['Proposed accounting correction', isDup
      ? `Counter the duplicate's legs (receipt ${ugx(r.ledger_receipt)}, repayment ${ugx(r.ledger_repayment)}, commission ${ugx(r.ledger_commission)}${fees ? `, fees ${formatUGX(fees)}` : ''}); keep the original ${short(e.valid_original_id)}`
      : `Reattribute collection and commission from ${r.agent_name} to the confirmed agent (${short(e.confirmed_agent_id)}); amounts unchanged`],
    ['Wallet impact', 'No change unless separately approved'],
    ['Tenant balance impact', isDup ? `Would reduce recorded repayments by ${ugx(r.amount)} — not applied` : 'None'],
    ['Agent balance / float impact', isDup ? `Commission ${ugx(r.ledger_commission)} would be in question — not applied` : 'Commission would move between agents — not applied'],
    ['Rent Plan impact', isDup ? `Repaid amount would fall by ${ugx(r.amount)} — not applied` : 'None'],
    ['Ledger impact', 'None. Nothing has been posted.'],
    ['Approval status', e.correction_status],
  ];
  return (
    <div className="rounded-md border border-border p-3 text-xs">
      <table className="w-full"><tbody>{lines.map(([k, v]) => <tr key={k}><td className="py-0.5 pr-3 text-muted-foreground whitespace-nowrap align-top">{k}</td><td>{v}</td></tr>)}</tbody></table>
      <Button size="sm" variant="secondary" className="mt-2" disabled><Lock className="mr-1 h-3 w-3" />Post correction (not available in Stage 12)</Button>
    </div>
  );
}

function EvidenceDialog({ row, onClose, onSaved }: { row: Row; onClose: () => void; onSaved: () => void }) {
  const e = row.evidence;
  const allowed = allowedFor(row.reconciliation_result);
  const [f, setF] = useState<Record<string, string>>({
    status: allowed.includes(e.evidence_status) ? e.evidence_status : '', evidence_type: e.evidence_type ?? '', evidence_reference: e.evidence_reference ?? '', receipt_number: e.receipt_number ?? '',
    evidence_date: e.evidence_date ?? '', evidence_source: e.evidence_source ?? '', notes: e.notes ?? '',
    valid_original_id: e.valid_original_id ?? '', confirmed_agent_id: e.confirmed_agent_id ?? '', reason: '',
  });
  const [checks, setChecks] = useState<string[]>(e.evidence_checklist ?? []);
  const isMismatch = row.reconciliation_result === 'System-inconsistent';
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const audit = useQuery({
    queryKey: ['cfo-s12-audit', row.collection_id],
    queryFn: async () => {
      const { data, error } = await (supabase.rpc as any)('cfo_s12_audit', { p_collection_id: row.collection_id });
      if (error) throw error;
      return (data ?? []) as any[];
    },
  });
  const set = (k: string) => (v: string) => setF((p) => ({ ...p, [k]: v }));
  const save = async () => {
    setBusy(true);
    try {
      let attachment_path = '';
      if (file) {
        attachment_path = `${row.collection_id}/${Date.now()}-${file.name.replace(/[^\w.-]/g, '_')}`;
        const { error } = await supabase.storage.from('collection-evidence').upload(attachment_path, file);
        if (error) throw error;
      }
      const { status, reason, ...fields } = f;
      const { error } = await (supabase.rpc as any)('cfo_s12_save_evidence', {
        p_collection_id: row.collection_id, p_status: status, p_reason: reason, p_fields: { ...fields, attachment_path, evidence_checklist: checks, duplicate_collection_id: status === 'Confirmed Duplicate' ? row.collection_id : '' },
      });
      if (error) throw error;
      toast.success('Evidence decision recorded. Nothing was posted.');
      onSaved();
    } catch (err) {
      toast.error((err as Error).message);
    } finally { setBusy(false); }
  };
  const viewFile = async () => {
    const { data, error } = await supabase.storage.from('collection-evidence').createSignedUrl(e.attachment_path, 300);
    if (error) return toast.error(error.message);
    window.open(data.signedUrl, '_blank');
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader><DialogTitle>Evidence — {short(row.collection_id)} · {ugx(row.amount)}</DialogTitle></DialogHeader>
        <p className="text-xs text-muted-foreground">{row.agent_name} · {row.tenant_name} · {eat(row.collected_at)} · Stage 11: {row.reconciliation_result} · Original: {row.original_classification}</p>
        <div className="grid gap-2 sm:grid-cols-2 text-sm">
          <label className="space-y-1"><span className="text-xs">Final evidence status</span>
            <Select value={f.status || undefined} onValueChange={set('status')}><SelectTrigger><SelectValue placeholder="Choose an outcome" /></SelectTrigger>
              <SelectContent>{allowed.map((x) => <SelectItem key={x} value={x}>{x}</SelectItem>)}</SelectContent></Select></label>
          <label className="space-y-1"><span className="text-xs">Evidence type</span>
            <Select value={f.evidence_type || undefined} onValueChange={set('evidence_type')}><SelectTrigger><SelectValue placeholder="Choose" /></SelectTrigger>
              <SelectContent>{TYPES.map((x) => <SelectItem key={x} value={x}>{x}</SelectItem>)}</SelectContent></Select></label>
          <label className="space-y-1"><span className="text-xs">Evidence reference</span><Input value={f.evidence_reference} onChange={(ev) => set('evidence_reference')(ev.target.value)} /></label>
          <label className="space-y-1"><span className="text-xs">Receipt / reference number</span><Input value={f.receipt_number} onChange={(ev) => set('receipt_number')(ev.target.value)} /></label>
          <label className="space-y-1"><span className="text-xs">Evidence date</span><Input type="date" value={f.evidence_date} onChange={(ev) => set('evidence_date')(ev.target.value)} /></label>
          <label className="space-y-1"><span className="text-xs">Evidence source</span><Input value={f.evidence_source} onChange={(ev) => set('evidence_source')(ev.target.value)} /></label>
          {f.status === 'Confirmed Duplicate' && (
            <label className="space-y-1 sm:col-span-2"><span className="text-xs">Valid original collection — this collection ({short(row.collection_id)}) is recorded as the duplicate. Neither collection is changed.</span>
              <Select value={f.valid_original_id || undefined} onValueChange={set('valid_original_id')}><SelectTrigger><SelectValue placeholder="Choose matching collection" /></SelectTrigger>
                <SelectContent>{(row.matches ?? []).map((m) => <SelectItem key={m.id} value={m.id}>{short(m.id)} · {eat(m.collected_at)} · {mins(m.seconds_apart)} · {m.in_population ? 'in 659' : 'outside 659'}{m.reversed_at ? ' · reversed' : ''}</SelectItem>)}</SelectContent></Select></label>
          )}
          {f.status === 'Confirmed Agent Mismatch' && (
            <label className="space-y-1 sm:col-span-2"><span className="text-xs">Confirmed collecting agent ID (recorded: {row.agent_name}; Rent Plan agent: {row.plan_agent_name ?? '—'}). If evidence shows the recorded agent collected, choose Confirmed Genuine instead.</span>
              <Input value={f.confirmed_agent_id} onChange={(ev) => set('confirmed_agent_id')(ev.target.value)} /></label>
          )}
          {isMismatch && (
            <fieldset className="sm:col-span-2 space-y-1"><legend className="text-xs">Evidence on hand (tick only what applies — none is compulsory)</legend>
              <div className="flex flex-wrap gap-3">{CHECKLIST.map((c) => (
                <label key={c} className="flex items-center gap-1 text-xs"><input type="checkbox" checked={checks.includes(c)} onChange={(ev) => setChecks((p) => ev.target.checked ? [...p, c] : p.filter((x) => x !== c))} />{c}</label>
              ))}</div></fieldset>
          )}
          <label className="space-y-1 sm:col-span-2"><span className="text-xs">Attachment (photo or PDF)</span>
            <Input type="file" accept="image/*,application/pdf" onChange={(ev) => setFile(ev.target.files?.[0] ?? null)} />
            {e.attachment_path && <Button type="button" size="sm" variant="link" className="px-0" onClick={viewFile}>View current attachment</Button>}</label>
          <label className="space-y-1 sm:col-span-2"><span className="text-xs">Notes</span><Textarea value={f.notes} onChange={(ev) => set('notes')(ev.target.value)} /></label>
          <label className="space-y-1 sm:col-span-2"><span className="text-xs">Reason for this decision (at least 10 characters)</span><Textarea value={f.reason} onChange={(ev) => set('reason')(ev.target.value)} /></label>
        </div>
        {e.verified_at && <p className="text-xs text-muted-foreground">Last verified {eat(e.verified_at)} by {short(e.verified_by)}</p>}
        <div className="text-xs">
          <p className="font-medium mb-1">Decision history</p>
          {(audit.data ?? []).length === 0 ? <p className="text-muted-foreground">No decisions yet.</p> : audit.data!.map((a) => (
            <div key={a.id} className="border-t border-border py-1">{eat(a.created_at)} · {short(a.actor)} · {a.previous_status} → {a.new_status} · {a.reason}{a.evidence_reference ? ` · ref ${a.evidence_reference}` : ''}{a.details?.evidence_type ? ` · ${a.details.evidence_type}` : ''}{a.details?.evidence_date ? ` · dated ${a.details.evidence_date}` : ''}{a.details?.evidence_source ? ` · source ${a.details.evidence_source}` : ''}{a.new_status === 'Confirmed Agent Mismatch' && a.details?.confirmed_agent_id ? ` · confirmed agent ${short(a.details.confirmed_agent_id)}` : ''}{a.notes ? ` · notes: ${a.notes}` : ''}</div>
          ))}
        </div>
        {CONFIRMED.includes(f.status) && <p className="text-xs text-muted-foreground">Confirmed outcomes need evidence type, reference, date, source and notes.</p>}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button disabled={busy || !f.status || f.reason.trim().length < 10 || (CONFIRMED.includes(f.status) && (!f.evidence_type || !f.evidence_reference.trim() || !f.evidence_date || !f.evidence_source.trim() || !f.notes.trim()))} onClick={save}>Record decision</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
