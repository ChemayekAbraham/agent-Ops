import { useState } from 'react';
import { Banknote, Check, Loader2, RotateCcw } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Table, TableHeader, TableHead, TableRow, TableBody, TableCell } from '@/components/ui/table';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { useLandlordFloatBudgetStatus, useLandlordFloatBudgetHistory, useLandlordFloatBudgetAllocations, useLandlordFloatMiscQueue, useLandlordFloatBudgetActions } from '@/hooks/useLandlordFloatBudget';
import { LANDLORD_FLOAT_MIN_REASON, landlordFloatErrorText, type LandlordFloatBudgetHistoryRow } from '@/lib/landlordFloatBudget';
import { formatUGX } from '@/lib/rentCalculations';
import { LandlordFloatBudgetSetter, budgetTimestamp } from './LandlordFloatBudgetSetter';
import { LandlordFloatBudgetPosition } from '@/components/shared/LandlordFloatBudgetPosition';

function QueryError({ error, retry }: { error: unknown; retry: () => void }) {
  return <div role="alert" className="space-y-2 py-3"><p className="text-sm text-destructive">{landlordFloatErrorText(error)}</p><Button variant="outline" onClick={retry} className="gap-2"><RotateCcw className="h-4 w-4" />Retry</Button></div>;
}
function BudgetHistory() {
  const history = useLandlordFloatBudgetHistory();
  const [period, setPeriod] = useState<LandlordFloatBudgetHistoryRow | null>(null);
  const allocations = useLandlordFloatBudgetAllocations(period?.period_type ?? 'daily', period?.period_start ?? null);
  return <section className="space-y-3 border-t border-border pt-6">
    <h2 className="text-lg font-semibold">Budget history</h2>
    {history.isLoading ? <p className="text-sm text-muted-foreground">Loading budget history…</p> : history.isError ? <QueryError error={history.error} retry={() => void history.refetch()} /> : !history.data?.length ? <p className="text-sm text-muted-foreground">No budgets recorded.</p> : <Table>
      <TableHeader><TableRow>{['Period', 'Amount', 'Used', 'Misc used', 'Excess', 'Set by', 'Reason', 'Status'].map(label => <TableHead key={label}>{label}</TableHead>)}</TableRow></TableHeader>
      <TableBody>{history.data.map(row => <TableRow key={row.id} onClick={() => setPeriod(row)} className="cursor-pointer">
        <TableCell className="min-w-40"><Button variant="link" className="h-auto whitespace-normal p-0 text-left" onClick={e => { e.stopPropagation(); setPeriod(row); }}>{row.period_type === 'daily' ? 'Daily' : 'Weekly'} · {row.period_start}{row.period_type === 'weekly' && ` – ${row.period_end}`}</Button></TableCell>
        <TableCell className="whitespace-nowrap tabular-nums">{formatUGX(row.amount)}</TableCell><TableCell className="whitespace-nowrap tabular-nums">{formatUGX(row.used)}</TableCell><TableCell className="whitespace-nowrap tabular-nums">{formatUGX(row.misc_used)}</TableCell><TableCell className="whitespace-nowrap tabular-nums">{formatUGX(row.excess)}</TableCell><TableCell className="min-w-36">{row.set_by_name || '—'}<p className="text-xs text-muted-foreground">{budgetTimestamp(row.created_at)}</p></TableCell><TableCell className="min-w-48 whitespace-pre-wrap break-words">{row.reason || '—'}</TableCell><TableCell><Badge variant={row.is_current ? 'secondary' : 'outline'}>{row.is_current ? 'Current' : 'Superseded'}</Badge></TableCell>
      </TableRow>)}</TableBody>
    </Table>}
    <Dialog open={!!period} onOpenChange={open => { if (!open) setPeriod(null); }}><DialogContent className="max-h-[85dvh] max-w-4xl overflow-y-auto"><DialogHeader><DialogTitle>Landlord float approvals</DialogTitle><DialogDescription>{period?.period_type === 'weekly' ? 'Weekly' : 'Daily'} · {period?.period_start}{period?.period_type === 'weekly' && ` – ${period.period_end}`}</DialogDescription></DialogHeader>
      {allocations.isLoading ? <p>Loading approvals…</p> : allocations.isError ? <QueryError error={allocations.error} retry={() => void allocations.refetch()} /> : !allocations.data?.length ? <p className="text-sm text-muted-foreground">No approvals for this period.</p> : <Table><TableHeader><TableRow>{['Tenant', 'Landlord', 'Kind', 'Amount', 'Approved by', 'Status'].map(label => <TableHead key={label}>{label}</TableHead>)}</TableRow></TableHeader><TableBody>{allocations.data.map(row => <TableRow key={row.allocation_id}><TableCell className="min-w-32">{row.tenant_name || '—'}</TableCell><TableCell className="min-w-32">{row.landlord_name || '—'}</TableCell><TableCell>{row.kind === 'within_cap' ? 'Within cap' : 'Miscellaneous'}{row.misc_reason && <p className="text-xs whitespace-pre-wrap">{row.misc_reason}</p>}</TableCell><TableCell className="whitespace-nowrap">{formatUGX(row.amount)}</TableCell><TableCell>{row.approved_by_name || '—'}<p className="text-xs text-muted-foreground">{budgetTimestamp(row.approved_at)}</p></TableCell><TableCell>{row.released_at ? <><Badge variant="outline">Released</Badge><p className="text-xs text-muted-foreground">{budgetTimestamp(row.released_at)}</p><p className="text-xs whitespace-pre-wrap">{row.released_reason}</p></> : <Badge variant="secondary">Active</Badge>}</TableCell></TableRow>)}</TableBody></Table>}
    </DialogContent></Dialog>
  </section>;
}
function MiscellaneousApprovals({ canDecide, count }: { canDecide: boolean; count: number }) {
  const queue = useLandlordFloatMiscQueue('pending');
  const { decideMisc } = useLandlordFloatBudgetActions();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [decision, setDecision] = useState<{ ids: string[]; type: 'approve' | 'reject' } | null>(null);
  const [note, setNote] = useState('');
  const [error, setError] = useState('');
  const rows = queue.data ?? [];
  const selectedIds = rows.filter(row => selected.has(row.id)).map(row => row.id);
  function begin(ids: string[], type: 'approve' | 'reject') { setDecision({ ids, type }); setNote(''); setError(''); }
  async function submit() {
    if (!decision || !canDecide || (decision.type === 'reject' && note.trim().length < LANDLORD_FLOAT_MIN_REASON)) return;
    try {
      const result = await decideMisc.mutateAsync({ miscIds: decision.ids, decision: decision.type, note: note.trim() || undefined });
      toast.success('Miscellaneous requests reviewed', { description: `${result.approved.length} approved · ${result.rejected.length} rejected · ${result.skipped.length} skipped` });
      setSelected(prev => new Set([...prev].filter(id => !decision.ids.includes(id))));
      setDecision(null);
    } catch (err) { setError(landlordFloatErrorText(err)); }
  }
  return <section className="space-y-4 border-t border-border pt-6">
    <div className="flex flex-wrap items-center gap-2"><h2 className="text-lg font-semibold">Miscellaneous approvals</h2><Badge variant="secondary">{count}</Badge></div>
    {canDecide && rows.length > 0 && <div className="flex flex-wrap items-center gap-3"><label className="inline-flex items-center gap-2 text-sm"><Checkbox aria-label="Select all miscellaneous requests" checked={selectedIds.length === rows.length ? true : selectedIds.length ? 'indeterminate' : false} onCheckedChange={checked => setSelected(checked === true ? new Set(rows.map(row => row.id)) : new Set())} disabled={decideMisc.isPending} />Select all ({selectedIds.length})</label><Button variant="outline" className="gap-2" disabled={!selectedIds.length || decideMisc.isPending} onClick={() => begin(selectedIds, 'approve')}><Check className="h-4 w-4" />Approve selected</Button><Button variant="outline" disabled={!selectedIds.length || decideMisc.isPending} onClick={() => begin(selectedIds, 'reject')}>Reject selected</Button></div>}
    {queue.isLoading ? <p className="text-sm text-muted-foreground">Loading miscellaneous requests…</p> : queue.isError ? <QueryError error={queue.error} retry={() => void queue.refetch()} /> : !rows.length ? <p className="text-sm text-muted-foreground">No pending miscellaneous requests.</p> : <div className="grid gap-4 lg:grid-cols-2">{rows.map(row => <article key={row.id} className="min-w-0 space-y-3 rounded-lg border border-border bg-card p-4">
      <div className="flex items-start justify-between gap-3"><div className="min-w-0"><h3 className="font-semibold break-words">{row.tenant_name || 'Unnamed tenant'}</h3><p className="text-lg font-semibold tabular-nums">{formatUGX(row.amount)}</p></div>{canDecide && <Checkbox aria-label={`Select ${row.tenant_name || 'request'}`} checked={selected.has(row.id)} disabled={decideMisc.isPending} onCheckedChange={checked => setSelected(prev => { const next = new Set(prev); if (checked === true) next.add(row.id); else next.delete(row.id); return next; })} />}</div>
      <dl className="grid grid-cols-2 gap-3 text-sm">{[['Landlord', row.landlord_name], ['Agent', row.agent_name], ['Requested by', row.requested_by_name], ['Requested at (Kampala)', budgetTimestamp(row.requested_at)], ['Room at request', formatUGX(row.room_at_request)]].map(([label, value]) => <div key={label} className="min-w-0"><dt className="text-muted-foreground">{label}</dt><dd className="break-words">{value || '—'}</dd></div>)}</dl>
      <div><p className="text-xs text-muted-foreground">Reason</p><p className="whitespace-pre-wrap break-words text-sm">{row.reason}</p></div>
      {canDecide && <div className="flex flex-wrap gap-2"><Button className="gap-2" disabled={decideMisc.isPending} onClick={() => begin([row.id], 'approve')}><Check className="h-4 w-4" />Approve</Button><Button variant="outline" disabled={decideMisc.isPending} onClick={() => begin([row.id], 'reject')}>Reject</Button></div>}
    </article>)}</div>}
    <Dialog open={!!decision} onOpenChange={open => { if (!open && !decideMisc.isPending) setDecision(null); }}><DialogContent><DialogHeader><DialogTitle>{decision?.type === 'reject' ? 'Reject' : 'Approve'} miscellaneous requests</DialogTitle><DialogDescription>{decision?.ids.length} request(s). {decision?.type === 'approve' ? 'Approved requests move to the CFO stage outside the cap.' : 'Rejected requests stay at the COO stage.'}</DialogDescription></DialogHeader><Label htmlFor="misc-decision-note">{decision?.type === 'reject' ? 'Required note (at least 10 characters)' : 'Note (optional)'}</Label><Textarea id="misc-decision-note" value={note} onChange={e => setNote(e.target.value)} disabled={decideMisc.isPending} />{error && <p role="alert" className="text-sm text-destructive">{error}</p>}<DialogFooter><Button variant="outline" disabled={decideMisc.isPending} onClick={() => setDecision(null)}>Cancel</Button><Button disabled={decideMisc.isPending || (decision?.type === 'reject' && note.trim().length < LANDLORD_FLOAT_MIN_REASON)} onClick={() => void submit()}>{decideMisc.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}{decision?.type === 'reject' ? 'Reject requests' : 'Approve requests'}</Button></DialogFooter></DialogContent></Dialog>
  </section>;
}
export function LandlordFloatBudgetPanel() {
  const status = useLandlordFloatBudgetStatus();
  return <div className="space-y-6"><div className="flex items-center gap-2"><Banknote className="h-6 w-6 text-primary" /><h1 className="text-xl font-bold">Landlord Float Budget</h1></div>
    {status.isLoading ? <p className="text-muted-foreground">Loading landlord float budgets…</p> : status.isError ? <QueryError error={status.error} retry={() => void status.refetch()} /> : status.data ? <><LandlordFloatBudgetSetter status={status.data} /><LandlordFloatBudgetPosition position={status.data} /><MiscellaneousApprovals canDecide={status.data.can_decide_misc} count={status.data.pending_misc.length} /><BudgetHistory /></> : <p role="alert">Budget status unavailable.</p>}
  </div>;
}
