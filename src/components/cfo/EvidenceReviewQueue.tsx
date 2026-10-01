import { useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { supabase } from '@/integrations/supabase/client';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { formatUGX } from '@/lib/businessAdvanceCalculations';
import { AlertTriangle, Lock, ShieldCheck } from 'lucide-react';

type Item = Record<string, any>;
const TYPES = ['Cash receipt', 'Tenant confirmation', 'Agent mobile-money statement', 'Tenant mobile-money statement', 'Bank statement', 'Deposit record', 'Other independently verifiable evidence'];
const RESULTS = ['Confirmed Genuine', 'Confirmed Duplicate', 'Unresolved'];
const PAGE = 25;
const FIELDS = ['evidence_requested', 'evidence_requested_on', 'evidence_received', 'evidence_type', 'evidence_reference', 'evidence_date', 'evidence_amount', 'evidence_holder', 'evidence_location', 'payment_channel', 'payer_identity', 'evidence_group_id', 'shared_receipt_explanation', 'reviewer_notes', 'finance_classification'];

/** Client preview of the server matching checks. Flags only; the server recomputes them on save. */
function previewFlags(item: Item, f: Item, all: Item[]): string[] {
  if (!f.evidence_received) return [];
  const out: string[] = [];
  const amt = f.evidence_amount === '' || f.evidence_amount == null ? null : Number(f.evidence_amount);
  if (!f.evidence_type) out.push('Missing evidence type');
  if (amt == null) out.push('Missing evidence amount');
  else if (amt < Number(item.collection_amount)) out.push('Amount mismatch', 'Partial amount');
  else if (amt > Number(item.collection_amount)) out.push('Amount mismatch', 'Excess amount');
  const first = String(item.tenant_name ?? '').trim().split(' ')[0]?.toLowerCase();
  if (f.payer_identity?.trim() && first && !f.payer_identity.toLowerCase().includes(first)) out.push('Tenant/payer mismatch');
  if (f.evidence_date && item.collected_at) {
    const d = Math.abs(new Date(f.evidence_date).getTime() - new Date(String(item.collected_at).slice(0, 10)).getTime()) / 864e5;
    if (d > 1) out.push('Date mismatch');
  }
  const ref = f.evidence_reference?.trim().toLowerCase();
  if (ref && all.some((x) => x.collection_id !== item.collection_id && String(x.evidence_reference ?? '').trim().toLowerCase() === ref && (x.evidence_group_id ?? '') !== (f.evidence_group_id?.trim() || '#none')))
    out.push('Reused evidence reference');
  if (f.evidence_group_id?.trim()) {
    out.push('Combined/shared payment');
    if (!f.shared_receipt_explanation?.trim()) out.push('Shared receipt without explanation');
  }
  return out;
}

export function EvidenceReviewQueue() {
  const qc = useQueryClient();
  const [open, setOpen] = useState<Item | null>(null);
  const [q, setQ] = useState('');
  const [page, setPage] = useState(0);
  const list = useQuery({
    queryKey: ['cfo-evidence-review-list'],
    queryFn: async () => {
      const { data, error } = await supabase.rpc('cfo_correction_review_list', { p_include_test: true });
      if (error) throw error;
      return (data ?? []) as Item[];
    },
  });
  const rows = useMemo(() => {
    const t = q.trim().toLowerCase();
    return (list.data ?? []).filter((r) => !t || [r.collection_id, r.tenant_name, r.agent_name, r.tenant_phone].some((v) => String(v ?? '').toLowerCase().includes(t)));
  }, [list.data, q]);
  const shown = rows.slice(page * PAGE, page * PAGE + PAGE);

  const onSaved = () => {
    qc.invalidateQueries({ queryKey: ['cfo-evidence-review-list'] });
    qc.invalidateQueries({ queryKey: ['cfo-correction-center'] });
    qc.invalidateQueries({ queryKey: ['cfo-correction-batches'] });
  };

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm font-medium">Finance Review Queue</p>
        <Input className="h-8 max-w-xs" placeholder="Search tenant, agent, phone, ID" value={q} onChange={(e) => { setQ(e.target.value); setPage(0); }} />
      </div>
      {list.isLoading ? <p className="text-sm text-muted-foreground">Loading collections…</p> : list.error ? <p className="text-sm text-destructive">{(list.error as Error).message}</p> : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead><tr className="text-left text-muted-foreground"><th>Date</th><th>Tenant</th><th>Agent</th><th className="text-right">Amount</th><th>Original</th><th>Evidence state</th><th>Finance result</th><th /></tr></thead>
            <tbody>
              {shown.map((r) => (
                <tr key={r.collection_id} className="border-t border-border">
                  <td className="py-1 whitespace-nowrap">{String(r.collected_at).slice(0, 10)}</td>
                  <td>{r.tenant_name}{r.is_test && <Badge variant="outline" className="ml-1">TEST</Badge>}</td>
                  <td>{r.agent_name}</td>
                  <td className="text-right whitespace-nowrap">{formatUGX(Number(r.collection_amount))}</td>
                  <td>{r.original_classification}</td>
                  <td>{r.evidence_state}{(r.review_flags ?? []).length > 0 && <AlertTriangle className="ml-1 inline h-3 w-3 text-destructive" />}</td>
                  <td>{r.finance_classification}</td>
                  <td className="text-right"><Button size="sm" variant="outline" onClick={() => setOpen(r)}>Open Review</Button></td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="mt-2 flex items-center justify-between text-xs text-muted-foreground">
            <span>{rows.length} rows (test rows are excluded from all totals)</span>
            <div className="flex gap-2">
              <Button size="sm" variant="outline" disabled={page === 0} onClick={() => setPage(page - 1)}>Previous</Button>
              <Button size="sm" variant="outline" disabled={(page + 1) * PAGE >= rows.length} onClick={() => setPage(page + 1)}>Next</Button>
            </div>
          </div>
        </div>
      )}
      {open && <ReviewDrawer item={open} all={list.data ?? []} onClose={() => setOpen(null)} onSaved={(it) => { setOpen(it); onSaved(); }} />}
    </div>
  );
}

function ReviewDrawer({ item, all, onClose, onSaved }: { item: Item; all: Item[]; onClose: () => void; onSaved: (it: Item) => void }) {
  const [f, setF] = useState<Item>(() => Object.fromEntries(FIELDS.map((k) => [k, item[k] ?? (k.startsWith('evidence_re') && typeof item[k] === 'boolean' ? false : '')])));
  const [busy, setBusy] = useState(false);
  const set = (k: string, v: unknown) => setF((p) => ({ ...p, [k]: v }));
  const flags = Array.from(new Set(previewFlags(item, f, all)));
  const audit = useQuery({
    queryKey: ['cfo-evidence-review-audit', item.collection_id, item.reviewed_at],
    queryFn: async () => {
      const { data, error } = await supabase.from('fin_correction_review_audit').select('id,logged_at,reviewer_name,previous_value,new_value,flags').eq('collection_id', item.collection_id).order('logged_at', { ascending: false });
      if (error) throw error;
      return data ?? [];
    },
  });

  const save = async () => {
    setBusy(true);
    const { data, error } = await supabase.rpc('cfo_save_evidence_review', { p_collection_id: item.collection_id, p: f });
    setBusy(false);
    if (error) return toast.error(error.message);
    const res = data as any;
    toast.success(`Review saved. ${res.flags?.length ? `${res.flags.length} Finance Review Required warning(s).` : ''} No financial correction made.`);
    onSaved(res.item);
  };

  const ro: [string, React.ReactNode][] = [
    ['Collection ID', <span className="font-mono text-xs">{item.collection_id}</span>],
    ['Date/time', new Date(item.collected_at).toLocaleString('en-GB', { timeZone: 'Africa/Kampala' })],
    ['Agent', item.agent_name], ['Tenant', item.tenant_name], ['Tenant phone', item.tenant_phone ?? '—'],
    ['Rent Plan ID', <span className="font-mono text-xs">{item.rent_plan_id ?? '—'}</span>],
    ['Collection amount', formatUGX(Number(item.collection_amount))],
    ['Original classification', <span className="inline-flex items-center gap-1"><Lock className="h-3 w-3" />{item.original_classification}</span>],
    ['Current Rent Plan status', item.plan_status], ['Amount affecting Rent Plan balance', formatUGX(Number(item.rent_plan_amount))],
    ['Completion-dependent', item.completion_dependent ? 'Yes' : 'No'],
    ['Agent commission', formatUGX(Number(item.agent_commission))], ['Recruiter commission', formatUGX(Number(item.recruiter_commission))],
  ];
  const yn = (k: string) => (
    <Select value={f[k] ? 'yes' : 'no'} onValueChange={(v) => set(k, v === 'yes')}>
      <SelectTrigger className="h-8"><SelectValue /></SelectTrigger>
      <SelectContent><SelectItem value="yes">Yes</SelectItem><SelectItem value="no">No</SelectItem></SelectContent>
    </Select>
  );
  const txt = (k: string, type = 'text') => <Input className="h-8" type={type} value={f[k] ?? ''} onChange={(e) => set(k, e.target.value)} />;
  const field = (label: string, el: React.ReactNode) => <div className="space-y-1"><Label className="text-xs">{label}</Label>{el}</div>;

  return (
    <Sheet open onOpenChange={(o) => !o && onClose()}>
      <SheetContent side="right" className="w-full overflow-y-auto sm:max-w-xl">
        <SheetHeader><SheetTitle>Evidence Review</SheetTitle></SheetHeader>
        <div className="mt-3 flex items-center gap-2 rounded-md border border-primary bg-muted p-2 text-sm font-semibold">
          <ShieldCheck className="h-4 w-4" /> Review Only — No Financial Correction
        </div>
        {item.is_test && <Badge variant="outline" className="mt-2">TEST record — excluded from all totals</Badge>}

        <h3 className="mt-5 text-sm font-semibold">1. Collection Details</h3>
        <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-sm">
          {ro.map(([k, v]) => (<div key={k} className="contents"><dt className="text-muted-foreground">{k}</dt><dd>{v}</dd></div>))}
        </dl>

        <h3 className="mt-5 text-sm font-semibold">2. Evidence</h3>
        <div className="mt-2 grid grid-cols-2 gap-3">
          {field('Evidence requested', yn('evidence_requested'))}
          {field('Evidence requested date', txt('evidence_requested_on', 'date'))}
          {field('Evidence received', yn('evidence_received'))}
          {field('Evidence type', (
            <Select value={f.evidence_type || undefined} onValueChange={(v) => set('evidence_type', v)}>
              <SelectTrigger className="h-8"><SelectValue placeholder="Select type" /></SelectTrigger>
              <SelectContent>{TYPES.map((t) => <SelectItem key={t} value={t}>{t}</SelectItem>)}</SelectContent>
            </Select>
          ))}
          {field('Evidence reference', txt('evidence_reference'))}
          {field('Evidence date', txt('evidence_date', 'date'))}
          {field('Evidence amount (UGX)', txt('evidence_amount', 'number'))}
          {field('Evidence holder', txt('evidence_holder'))}
          {field('Evidence file/location', txt('evidence_location'))}
          {field('Payment channel', txt('payment_channel'))}
          {field('Payer identity', txt('payer_identity'))}
          {field('Shared evidence group ID', txt('evidence_group_id'))}
        </div>
        <div className="mt-3">{field('Shared receipt explanation', <Textarea rows={2} value={f.shared_receipt_explanation ?? ''} onChange={(e) => set('shared_receipt_explanation', e.target.value)} />)}</div>

        <h3 className="mt-5 text-sm font-semibold">3. Matching Checks</h3>
        {flags.length === 0 ? <p className="mt-1 text-sm text-muted-foreground">No warnings.</p> : (
          <div className="mt-2 rounded-md border border-destructive p-2 text-sm">
            <p className="font-medium text-destructive">Finance Review Required</p>
            <ul className="ml-4 list-disc">{flags.map((x) => <li key={x}>{x}</li>)}</ul>
            <p className="mt-1 text-xs text-muted-foreground">Warnings do not block saving and never reject a collection.</p>
          </div>
        )}

        <h3 className="mt-5 text-sm font-semibold">4. Finance Result</h3>
        <div className="mt-2 flex flex-wrap gap-2">
          {RESULTS.map((r) => <Button key={r} size="sm" variant={f.finance_classification === r ? 'default' : 'outline'} onClick={() => set('finance_classification', r)}>{r}</Button>)}
        </div>
        <p className="mt-1 text-xs text-muted-foreground">Original classification stays {item.original_classification} and is never overwritten. Only Confirmed Duplicate appears in Pending CFO Approval.</p>

        <h3 className="mt-5 text-sm font-semibold">5. Reviewer Notes</h3>
        <Textarea className="mt-2" rows={3} value={f.reviewer_notes ?? ''} onChange={(e) => set('reviewer_notes', e.target.value)} />
        {item.reviewed_at && <p className="mt-1 text-xs text-muted-foreground">Last saved by {item.reviewer_name} on {new Date(item.reviewed_at).toLocaleString('en-GB', { timeZone: 'Africa/Kampala' })} — {item.evidence_state}</p>}

        <div className="mt-5 flex justify-end gap-2">
          <Button variant="outline" onClick={onClose}>Close</Button>
          <Button onClick={save} disabled={busy}>{busy ? 'Saving…' : 'Save Review'}</Button>
        </div>

        <h3 className="mt-6 text-sm font-semibold">Audit History</h3>
        {(audit.data ?? []).length === 0 ? <p className="text-sm text-muted-foreground">No saved reviews yet.</p> : (
          <ul className="mt-2 space-y-2 text-xs">
            {(audit.data ?? []).map((a: any) => {
              const changed = FIELDS.filter((k) => String(a.previous_value?.[k] ?? '') !== String(a.new_value?.[k] ?? ''));
              return (
                <li key={a.id} className="rounded border border-border p-2">
                  <p className="font-medium">{new Date(a.logged_at).toLocaleString('en-GB', { timeZone: 'Africa/Kampala' })} — {a.reviewer_name}</p>
                  {changed.length === 0 ? <p>No field changes.</p> : changed.map((k) => <p key={k}>{k.replace(/_/g, ' ')}: {String(a.previous_value?.[k] ?? '—')} → {String(a.new_value?.[k] ?? '—')}</p>)}
                </li>
              );
            })}
          </ul>
        )}
      </SheetContent>
    </Sheet>
  );
}

export default EvidenceReviewQueue;
