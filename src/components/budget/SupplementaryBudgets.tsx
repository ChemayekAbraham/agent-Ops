import { useCallback, useEffect, useState } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { Loader2, Plus } from 'lucide-react';
import { format } from 'date-fns';
import { formatDynamic as formatUGX } from '@/lib/currencyFormat';

/**
 * Supplementary budgets. Every rule (who may request, route, approval, duplicates,
 * revised totals) is decided by the budget_supplement_* RPCs; this screen only
 * displays results and sends requests. Nothing here moves money.
 */

type Mode = 'department' | 'coo' | 'cfo';

interface Supp {
  id: string; reference: string; submission_reference: string; line_description: string;
  account_code: string | null; department_name: string | null; financial_year: string;
  amount: number; approved_amount: number | null; justification: string; status: string;
  requester_name: string | null; requested_at: string; coo_note: string | null; cfo_note: string | null;
  original_line_amount: number | null; document_count: number;
  can_coo_act: boolean; can_cfo_act: boolean; can_cancel: boolean;
}

interface Position {
  line_id: string; department_name: string | null; submission_reference: string; line_description: string;
  account_code: string | null; original_amount: number; approved_supplements: number; pending_supplements: number;
  revised_amount: number; actual_expenditure: number; remaining_balance: number;
}

const STATUS_LABEL: Record<string, string> = {
  pending_coo: 'Awaiting COO', pending_cfo: 'Awaiting CFO', approved: 'Approved',
  rejected: 'Rejected', cancelled: 'Cancelled',
};

const errMsg = (e: unknown) =>
  (e && typeof e === 'object' && 'message' in e ? String((e as { message: string }).message) : 'Something went wrong');

export default function SupplementaryBudgets({ mode, cycleId = null }: { mode: Mode; cycleId?: string | null }) {
  const [rows, setRows] = useState<Supp[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [requestOpen, setRequestOpen] = useState(false);
  const [deciding, setDeciding] = useState<{ row: Supp; decision: 'approved' | 'rejected' | 'cancel' } | null>(null);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    const { data, error: e } = await supabase.rpc('budget_supplement_list' as never, { p_status: null, p_call_id: cycleId } as never);
    if (e) setError(errMsg(e)); else setRows((data ?? []) as unknown as Supp[]);
    setLoading(false);
  }, [cycleId]);

  useEffect(() => { load(); }, [load]);

  const visible = mode === 'coo' ? rows.filter(r => r.status === 'pending_coo' || r.can_coo_act) : rows;

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="flex flex-row items-center justify-between gap-2 pb-2">
          <CardTitle className="text-sm">Supplementary budget requests</CardTitle>
          {mode === 'department' && (
            <Button size="sm" className="gap-1" onClick={() => setRequestOpen(true)}>
              <Plus className="h-4 w-4" /> Request supplement
            </Button>
          )}
        </CardHeader>
        <CardContent className="space-y-2 pt-0">
          {loading && <div className="flex justify-center py-6"><Loader2 className="h-5 w-5 animate-spin" /></div>}
          {error && <p className="text-sm text-destructive">Could not load supplements: {error}</p>}
          {!loading && !error && visible.length === 0 && (
            <p className="py-6 text-center text-sm text-muted-foreground">No supplementary budget requests.</p>
          )}
          {!loading && visible.map(r => (
            <div key={r.id} className="space-y-1 rounded-lg border border-border p-3 text-xs">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-semibold">{r.department_name ?? 'Department'}</span>
                <span className="font-mono text-muted-foreground">{r.reference}</span>
                <Badge variant={r.status === 'approved' ? 'default' : r.status === 'rejected' ? 'destructive' : 'secondary'}>
                  {STATUS_LABEL[r.status] ?? r.status}
                </Badge>
                <span className="ml-auto text-muted-foreground">{format(new Date(r.requested_at), 'd MMM yyyy, HH:mm')}</span>
              </div>
              <p>
                {r.line_description}{r.account_code ? ` · ${r.account_code}` : ''} · budget {r.submission_reference} · {r.financial_year}
              </p>
              <p>
                Original {formatUGX(Number(r.original_line_amount ?? 0))} · Requested <b>{formatUGX(Number(r.amount))}</b>
                {r.approved_amount != null && <> · Approved <b>{formatUGX(Number(r.approved_amount))}</b></>}
              </p>
              <p className="text-muted-foreground">{r.justification}</p>
              <p className="text-muted-foreground">
                By {r.requester_name ?? 'staff'} · {r.document_count} document(s)
                {r.coo_note && ` · COO: ${r.coo_note}`}{r.cfo_note && ` · CFO: ${r.cfo_note}`}
              </p>
              {(r.can_coo_act || r.can_cfo_act || r.can_cancel) && (
                <div className="flex flex-wrap gap-2 pt-1">
                  {(r.can_coo_act || r.can_cfo_act) && <>
                    <Button size="sm" className="h-7 text-[11px]" onClick={() => setDeciding({ row: r, decision: 'approved' })}>
                      {r.can_coo_act ? 'Approve & forward to CFO' : 'Approve'}
                    </Button>
                    <Button size="sm" variant="destructive" className="h-7 text-[11px]" onClick={() => setDeciding({ row: r, decision: 'rejected' })}>
                      Reject
                    </Button>
                  </>}
                  {r.can_cancel && (
                    <Button size="sm" variant="outline" className="h-7 text-[11px]" onClick={() => setDeciding({ row: r, decision: 'cancel' })}>
                      Cancel request
                    </Button>
                  )}
                </div>
              )}
            </div>
          ))}
        </CardContent>
      </Card>

      {mode === 'cfo' && <RevisedPosition cycleId={cycleId} refreshKey={rows} />}

      {requestOpen && <RequestDialog onClose={() => setRequestOpen(false)} onDone={load} />}
      {deciding && <DecideDialog {...deciding} onClose={() => setDeciding(null)} onDone={load} />}
    </div>
  );
}

function RevisedPosition({ cycleId, refreshKey }: { cycleId: string | null; refreshKey: unknown }) {
  const [rows, setRows] = useState<Position[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!cycleId) { setRows(null); return; }
    let off = false;
    setRows(null); setError(null);
    supabase.rpc('budget_revised_position' as never, { p_call_id: cycleId } as never).then(({ data, error: e }) => {
      if (off) return;
      if (e) setError(errMsg(e)); else setRows((data ?? []) as unknown as Position[]);
    });
    return () => { off = true; };
  }, [cycleId, refreshKey]);

  const sum = (k: keyof Position) => (rows ?? []).reduce((a, r) => a + Number(r[k] ?? 0), 0);

  return (
    <Card>
      <CardHeader className="pb-2"><CardTitle className="text-sm">Revised budget position</CardTitle></CardHeader>
      <CardContent className="pt-0">
        {!cycleId && <p className="text-xs text-muted-foreground">Select a specific budget cycle above to see the revised budget.</p>}
        {cycleId && error && <p className="text-xs text-destructive">{error}</p>}
        {cycleId && !error && !rows && <Loader2 className="h-4 w-4 animate-spin" />}
        {rows && rows.length === 0 && <p className="text-xs text-muted-foreground">No approved budget lines in this cycle yet.</p>}
        {rows && rows.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="text-muted-foreground">
                <tr className="border-b border-border">
                  <th className="py-1.5 text-left">Department / line</th>
                  <th className="text-right">Original</th>
                  <th className="text-right">Approved supplements</th>
                  <th className="text-right">Revised</th>
                  <th className="text-right">Actual spending</th>
                  <th className="text-right">Remaining</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(r => (
                  <tr key={r.line_id} className="border-b border-border/40">
                    <td className="py-1.5">
                      <div className="font-medium">{r.department_name ?? '—'}</div>
                      <div className="text-muted-foreground">{r.line_description}{r.account_code ? ` · ${r.account_code}` : ''}</div>
                      {Number(r.pending_supplements) > 0 && (
                        <div className="text-muted-foreground">Pending supplements {formatUGX(Number(r.pending_supplements))}</div>
                      )}
                    </td>
                    <td className="text-right font-mono">{formatUGX(Number(r.original_amount))}</td>
                    <td className="text-right font-mono">{formatUGX(Number(r.approved_supplements))}</td>
                    <td className="text-right font-mono font-semibold">{formatUGX(Number(r.revised_amount))}</td>
                    <td className="text-right font-mono">{formatUGX(Number(r.actual_expenditure))}</td>
                    <td className={`text-right font-mono ${Number(r.remaining_balance) < 0 ? 'text-destructive' : ''}`}>
                      {formatUGX(Number(r.remaining_balance))}
                    </td>
                  </tr>
                ))}
                <tr className="font-semibold">
                  <td className="py-1.5">Total</td>
                  <td className="text-right font-mono">{formatUGX(sum('original_amount'))}</td>
                  <td className="text-right font-mono">{formatUGX(sum('approved_supplements'))}</td>
                  <td className="text-right font-mono">{formatUGX(sum('revised_amount'))}</td>
                  <td className="text-right font-mono">{formatUGX(sum('actual_expenditure'))}</td>
                  <td className="text-right font-mono">{formatUGX(sum('remaining_balance'))}</td>
                </tr>
              </tbody>
            </table>
            <p className="mt-2 text-[11px] text-muted-foreground">
              Actual spending comes from the books for each account during the cycle period, across the company.
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

interface LineOpt { id: string; label: string; fy: string | null }

function RequestDialog({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [lines, setLines] = useState<LineOpt[] | null>(null);
  const [lineId, setLineId] = useState('');
  const [amount, setAmount] = useState('');
  const [fy, setFy] = useState('');
  const [why, setWhy] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      const { data: subs } = await supabase.from('budget_submissions')
        .select('id,reference,call_id,department_id').eq('status', 'approved').limit(200);
      const s = (subs ?? []) as { id: string; reference: string; call_id: string | null; department_id: string }[];
      if (!s.length) { setLines([]); return; }
      const [{ data: ls }, { data: calls }, { data: depts }] = await Promise.all([
        supabase.from('budget_submission_lines').select('id,submission_id,description,approved_amount')
          .in('submission_id', s.map(x => x.id)).eq('status', 'approved'),
        supabase.from('budget_calls').select('id,financial_year').in('id', s.map(x => x.call_id).filter(Boolean) as string[]),
        supabase.from('hr_departments').select('id,name').in('id', s.map(x => x.department_id)),
      ]);
      const sm = new Map(s.map(x => [x.id, x]));
      const cm = new Map(((calls ?? []) as { id: string; financial_year: string | null }[]).map(c => [c.id, c.financial_year]));
      const dm = new Map(((depts ?? []) as { id: string; name: string }[]).map(d => [d.id, d.name]));
      setLines(((ls ?? []) as { id: string; submission_id: string; description: string; approved_amount: number | null }[]).map(l => {
        const sub = sm.get(l.submission_id)!;
        return {
          id: l.id,
          fy: sub.call_id ? cm.get(sub.call_id) ?? null : null,
          label: `${dm.get(sub.department_id) ?? 'Department'} · ${sub.reference} · ${l.description} (${formatUGX(Number(l.approved_amount ?? 0))})`,
        };
      }));
    })();
  }, []);

  const submit = async () => {
    setError(null);
    const amt = Number(amount);
    if (!lineId) return setError('Choose the budget line');
    if (!(amt > 0)) return setError('Enter an amount greater than zero');
    if (why.trim().length < 20) return setError('Justification must be at least 20 characters');
    setBusy(true);
    try {
      const { data, error: e } = await supabase.rpc('budget_supplement_create' as never, {
        p_line_id: lineId, p_amount: amt, p_justification: why.trim(), p_financial_year: fy.trim() || null,
      } as never);
      if (e) throw e;
      const created = data as unknown as { id: string };
      const { data: u } = await supabase.auth.getUser();
      const failed: string[] = [];
      for (const f of files) {
        const path = `supplements/${u.user?.id}/${created.id}/${Date.now()}-${f.name.replace(/[^\w.-]/g, '_')}`;
        const up = await supabase.storage.from('budget-documents').upload(path, f);
        if (up.error) { failed.push(f.name); continue; }
        const { error: de } = await supabase.rpc('budget_supplement_add_document' as never,
          { p_supplement_id: created.id, p_storage_path: path, p_file_name: f.name } as never);
        if (de) failed.push(f.name);
      }
      onDone();
      if (failed.length) { setError(`Request sent, but these documents failed to attach: ${failed.join(', ')}`); setBusy(false); return; }
      onClose();
    } catch (e) {
      setError(errMsg(e));
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={o => !o && !busy && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader><DialogTitle>Request a supplementary budget</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <div>
            <Label className="text-xs">Approved budget line</Label>
            {lines === null ? <Loader2 className="h-4 w-4 animate-spin" /> : lines.length === 0 ? (
              <p className="text-xs text-muted-foreground">You have no approved budget lines yet. Supplements can only be added to approved budgets.</p>
            ) : (
              <Select value={lineId} onValueChange={v => { setLineId(v); const l = lines.find(x => x.id === v); if (l?.fy && !fy) setFy(l.fy); }}>
                <SelectTrigger className="text-xs"><SelectValue placeholder="Choose a line" /></SelectTrigger>
                <SelectContent className="z-[100]">
                  {lines.map(l => <SelectItem key={l.id} value={l.id} className="text-xs">{l.label}</SelectItem>)}
                </SelectContent>
              </Select>
            )}
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div><Label className="text-xs">Extra amount (UGX)</Label><Input type="number" min={1} value={amount} onChange={e => setAmount(e.target.value)} /></div>
            <div><Label className="text-xs">Financial year</Label><Input value={fy} onChange={e => setFy(e.target.value)} placeholder="FY2027" /></div>
          </div>
          <div><Label className="text-xs">Justification (at least 20 characters)</Label><Textarea rows={3} value={why} onChange={e => setWhy(e.target.value)} /></div>
          <div>
            <Label className="text-xs">Supporting documents</Label>
            <Input type="file" multiple onChange={e => setFiles(Array.from(e.target.files ?? []))} />
          </div>
          {error && <p className="text-xs text-destructive">{error}</p>}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>Close</Button>
          <Button onClick={submit} disabled={busy || !lines?.length}>
            {busy && <Loader2 className="mr-1 h-4 w-4 animate-spin" />} Submit request
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function DecideDialog({ row, decision, onClose, onDone }: {
  row: Supp; decision: 'approved' | 'rejected' | 'cancel'; onClose: () => void; onDone: () => void;
}) {
  const [note, setNote] = useState('');
  const [amount, setAmount] = useState(String(row.amount));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isCfo = row.can_cfo_act;

  const confirm = async () => {
    setError(null);
    if ((decision !== 'approved') && note.trim().length < 10) return setError('Give a reason of at least 10 characters');
    setBusy(true);
    let res;
    if (decision === 'cancel') {
      res = await supabase.rpc('budget_supplement_cancel' as never, { p_supplement_id: row.id, p_note: note.trim() } as never);
    } else if (isCfo) {
      const amt = Number(amount);
      res = await supabase.rpc('budget_supplement_cfo_decide' as never, {
        p_supplement_id: row.id, p_decision: decision, p_note: note.trim() || null,
        p_approved_amount: decision === 'approved' && amt !== Number(row.amount) ? amt : null,
      } as never);
    } else {
      res = await supabase.rpc('budget_supplement_coo_decide' as never,
        { p_supplement_id: row.id, p_decision: decision, p_note: note.trim() || null } as never);
    }
    setBusy(false);
    if (res.error) return setError(errMsg(res.error));
    onDone(); onClose();
  };

  const title = decision === 'cancel' ? 'Cancel supplement request' : decision === 'approved' ? 'Approve supplement' : 'Reject supplement';

  return (
    <Dialog open onOpenChange={o => !o && !busy && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader><DialogTitle>{title}</DialogTitle></DialogHeader>
        <div className="space-y-3 text-xs">
          <p>{row.reference} · {row.department_name} · requested {formatUGX(Number(row.amount))}</p>
          {decision === 'approved' && isCfo && (
            <div>
              <Label className="text-xs">Approved amount (UGX, up to the requested amount)</Label>
              <Input type="number" min={1} max={Number(row.amount)} value={amount} onChange={e => setAmount(e.target.value)} />
            </div>
          )}
          <div>
            <Label className="text-xs">{decision === 'approved' ? 'Note (required if you reduce the amount)' : 'Reason (at least 10 characters)'}</Label>
            <Textarea rows={3} value={note} onChange={e => setNote(e.target.value)} />
          </div>
          <p className="text-muted-foreground">This only changes the budget record. No money is paid or moved.</p>
          {error && <p className="text-destructive">{error}</p>}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>Back</Button>
          <Button variant={decision === 'approved' ? 'default' : 'destructive'} onClick={confirm} disabled={busy}>
            {busy && <Loader2 className="mr-1 h-4 w-4 animate-spin" />} Confirm
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
