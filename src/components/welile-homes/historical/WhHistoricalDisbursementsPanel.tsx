import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronDown, Download, FileText, History, Loader2, Plus, Undo2 } from 'lucide-react';
import { toast } from 'sonner';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { cn } from '@/lib/utils';
import { formatUGX } from '@/lib/rentCalculations';
import {
  WH_CHANNELS, breakdown, buildWhCsv, channelLabel, evidenceUrl, fetchWhHistOverview, kampalaToday,
  recordWhHistorical, reverseWhHistorical, searchWhAgents, searchWhPlans, uploadWhEvidence, validateWhEntry,
  type WhHistFilters, type WhManualRow, type WhPlanOption, type WhSystemRow,
} from '@/lib/welileHomesHistorical';

const MANUAL_BADGE = 'border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300';
const SYSTEM_BADGE = 'border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300';

export function ManualBadge({ offSystem }: { offSystem?: boolean }) {
  return (
    <Badge variant="outline" className={cn('text-[10px] font-semibold', MANUAL_BADGE)}>
      {offSystem ? 'Manually entered – off-system, not in ledger' : 'Manually entered – historical'}
    </Badge>
  );
}
export function SystemBadge() {
  return <Badge variant="outline" className={cn('text-[10px] font-semibold', SYSTEM_BADGE)}>System recorded</Badge>;
}

const fmtDateTime = (s?: string | null) =>
  s ? new Date(s).toLocaleString('en-GB', { timeZone: 'Africa/Kampala', dateStyle: 'medium', timeStyle: 'short' }) : '—';

async function openEvidence(path: string) {
  try {
    window.open(await evidenceUrl(path), '_blank', 'noopener');
  } catch (e) {
    toast.error(e instanceof Error ? e.message : 'Could not open evidence');
  }
}

function Totals({ system, manual, offSystem }: { system: number; manual: number; offSystem?: boolean }) {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
      <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/5 p-3">
        <p className="text-[11px] text-muted-foreground">System recorded total</p>
        <p className="text-lg font-bold tabular-nums">{formatUGX(system)}</p>
      </div>
      <div className="rounded-xl border border-amber-500/30 bg-amber-500/5 p-3">
        <p className="text-[11px] text-muted-foreground">
          {offSystem ? 'Manually entered total (off-system, not in ledger)' : 'Manually entered total (historical)'}
        </p>
        <p className="text-lg font-bold tabular-nums">{formatUGX(manual)}</p>
      </div>
      <div className="rounded-xl border border-border p-3">
        <p className="text-[11px] text-muted-foreground">Combined total (system + manual)</p>
        <p className="text-lg font-bold tabular-nums">{formatUGX(system + manual)}</p>
      </div>
    </div>
  );
}

function ManualRowCard({ r, canReverse, onReverse, offSystem }: { r: WhManualRow; canReverse: boolean; onReverse: (r: WhManualRow) => void; offSystem?: boolean }) {
  return (
    <div className={cn('p-3 text-xs space-y-1.5 border-l-4 border-l-amber-500/60', r.reversed && 'opacity-60')}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className={cn('font-bold text-sm tabular-nums', r.reversed && 'line-through')}>{formatUGX(r.amount)}</span>
          <ManualBadge offSystem={offSystem} />
          {r.reversed && <Badge variant="outline" className="text-[10px] border-destructive/40 text-destructive">Reversed</Badge>}
        </div>
        <span className="text-muted-foreground">Paid {r.paid_on}</span>
      </div>
      <p>
        <span className="font-medium">{r.agent_name || 'Agent'}</span>
        <span className="text-muted-foreground"> · Landlord {r.landlord_name || '—'} · Rent Plan {r.tenant_name || '—'}</span>
      </p>
      <p className="text-muted-foreground">{channelLabel(r.channel)} · Ref {r.reference}{r.notes ? ` · ${r.notes}` : ''}</p>
      <p className="text-[11px] text-muted-foreground">Entered by {r.recorded_by_name || 'staff'} on {fmtDateTime(r.recorded_at)}</p>
      {r.reversed && (
        <p className="text-[11px] text-destructive">
          Reversed by {r.reversed_by_name || 'staff'} on {fmtDateTime(r.reversed_at)}: {r.reversal_reason}
        </p>
      )}
      <div className="flex gap-2 pt-1">
        {r.evidence_path && (
          <Button size="sm" variant="outline" className="h-7 text-xs gap-1" onClick={() => openEvidence(r.evidence_path!)}>
            <FileText className="h-3 w-3" /> Evidence
          </Button>
        )}
        {canReverse && !r.reversed && (
          <Button size="sm" variant="outline" className="h-7 text-xs gap-1 text-destructive border-destructive/30" onClick={() => onReverse(r)}>
            <Undo2 className="h-3 w-3" /> Reverse
          </Button>
        )}
      </div>
    </div>
  );
}

function SystemRowCard({ r }: { r: WhSystemRow }) {
  return (
    <div className="p-3 text-xs space-y-1 border-l-4 border-l-emerald-500/60">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-1.5">
          <span className="font-bold text-sm tabular-nums">{formatUGX(r.amount)}</span>
          <SystemBadge />
        </div>
        <span className="text-muted-foreground">Paid {r.paid_on}</span>
      </div>
      <p><span className="font-medium">{r.agent_name || 'Agent'}</span>
        <span className="text-muted-foreground"> · {channelLabel(r.channel)}{r.reference ? ` · Ref ${r.reference}` : ''}</span></p>
      {r.notes && <p className="text-muted-foreground">{r.notes}</p>}
    </div>
  );
}

function BreakdownTable({ rows, label }: { rows: { key: string; system: number; manual: number }[]; label: string }) {
  if (rows.length === 0) return <p className="text-xs text-muted-foreground p-3">Nothing to show yet.</p>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs">
        <thead className="text-muted-foreground">
          <tr className="border-b">
            <th className="text-left p-2 font-medium">{label}</th>
            <th className="text-right p-2 font-medium">System recorded</th>
            <th className="text-right p-2 font-medium">Manually entered</th>
            <th className="text-right p-2 font-medium">Combined</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.key} className="border-b border-border/40">
              <td className="p-2">{r.key}</td>
              <td className="p-2 text-right tabular-nums">{formatUGX(r.system)}</td>
              <td className="p-2 text-right tabular-nums">{formatUGX(r.manual)}</td>
              <td className="p-2 text-right tabular-nums font-semibold">{formatUGX(r.system + r.manual)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function RecordDialog({ open, onClose, onSaved }: { open: boolean; onClose: () => void; onSaved: () => void }) {
  const [planSearch, setPlanSearch] = useState('');
  const [plans, setPlans] = useState<WhPlanOption[]>([]);
  const [plan, setPlan] = useState<WhPlanOption | null>(null);
  const [agentSearch, setAgentSearch] = useState('');
  const [agents, setAgents] = useState<{ id: string; full_name: string | null; phone: string | null }[]>([]);
  const [agent, setAgent] = useState<{ id: string; name: string } | null>(null);
  const [amount, setAmount] = useState('');
  const [channel, setChannel] = useState('');
  const [reference, setReference] = useState('');
  const [paidOn, setPaidOn] = useState('');
  const [notes, setNotes] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [saving, setSaving] = useState(false);
  const [dupAsk, setDupAsk] = useState(false);
  // One reference per submission; kept across retries so a resend never creates a second record.
  const clientRef = useRef<string>(crypto.randomUUID());
  const evidencePath = useRef<string | null>(null);

  useEffect(() => {
    if (!open) return;
    const t = setTimeout(() => {
      searchWhPlans(planSearch).then(setPlans).catch(() => setPlans([]));
    }, 300);
    return () => clearTimeout(t);
  }, [planSearch, open]);

  useEffect(() => {
    if (!open || agentSearch.trim().length < 2) { setAgents([]); return; }
    const t = setTimeout(() => {
      searchWhAgents(agentSearch).then(setAgents).catch(() => setAgents([]));
    }, 300);
    return () => clearTimeout(t);
  }, [agentSearch, open]);

  const reset = () => {
    setPlanSearch(''); setPlan(null); setAgent(null); setAgentSearch(''); setAmount(''); setChannel('');
    setReference(''); setPaidOn(''); setNotes(''); setFile(null); setDupAsk(false);
    clientRef.current = crypto.randomUUID(); evidencePath.current = null;
  };

  const submit = async (confirmDuplicate = false) => {
    const amt = Number(amount.replace(/,/g, ''));
    const err = validateWhEntry({ amount: amt, paidOn, reference, channel, agentId: agent?.id, subscriptionId: plan?.subscription_id });
    if (err) { toast.error(err); return; }
    setSaving(true);
    try {
      if (file && !evidencePath.current) evidencePath.current = await uploadWhEvidence(file);
      const res = await recordWhHistorical({
        clientRef: clientRef.current, agentId: agent!.id, subscriptionId: plan!.subscription_id, amount: amt,
        channel, reference, paidOn, notes, evidencePath: evidencePath.current, confirmDuplicate,
      });
      if (res.duplicate) { setDupAsk(true); return; }
      toast.success(res.already_saved ? 'This entry was already saved' : 'Past disbursement recorded (no money moved)');
      reset(); onSaved(); onClose();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not save');
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <Dialog open={open} onOpenChange={(o) => { if (!o && !saving) onClose(); }}>
        <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto rounded-2xl">
          <DialogHeader>
            <DialogTitle>Record past disbursement</DialogTitle>
            <DialogDescription>
              For float paid outside the app before in-app disbursement existed. This is a record only: it moves no money and does not
              change any ledger, wallet, float, float limit or Rent Plan status.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <Label className="text-xs">Rent Plan (tenant / landlord)</Label>
              {plan ? (
                <div className="mt-1 flex items-center justify-between rounded-xl border p-2 text-xs">
                  <span><b>{plan.tenant_name}</b> · Landlord {plan.landlord_name}</span>
                  <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => setPlan(null)}>Change</Button>
                </div>
              ) : (
                <>
                  <Input className="mt-1" placeholder="Search tenant, landlord or agent" value={planSearch} onChange={(e) => setPlanSearch(e.target.value)} />
                  <div className="mt-1 max-h-40 overflow-y-auto rounded-xl border divide-y">
                    {plans.length === 0 ? <p className="p-2 text-xs text-muted-foreground">No Rent Plans found</p> : plans.map((p) => (
                      <button key={p.subscription_id} type="button" className="w-full text-left p-2 text-xs hover:bg-muted/40"
                        onClick={() => { setPlan(p); if (!agent && p.agent_id) setAgent({ id: p.agent_id, name: p.agent_name || 'Agent' }); }}>
                        <b>{p.tenant_name}</b> · Landlord {p.landlord_name} · Agent {p.agent_name || '—'} · {formatUGX(p.monthly_rent)}/month
                      </button>
                    ))}
                  </div>
                </>
              )}
            </div>
            <div>
              <Label className="text-xs">Agent who received the money</Label>
              {agent ? (
                <div className="mt-1 flex items-center justify-between rounded-xl border p-2 text-xs">
                  <b>{agent.name}</b>
                  <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => setAgent(null)}>Change</Button>
                </div>
              ) : (
                <>
                  <Input className="mt-1" placeholder="Search agent name or phone" value={agentSearch} onChange={(e) => setAgentSearch(e.target.value)} />
                  {agents.length > 0 && (
                    <div className="mt-1 max-h-32 overflow-y-auto rounded-xl border divide-y">
                      {agents.map((a) => (
                        <button key={a.id} type="button" className="w-full text-left p-2 text-xs hover:bg-muted/40"
                          onClick={() => setAgent({ id: a.id, name: a.full_name || a.phone || 'Agent' })}>
                          {a.full_name || 'Agent'} {a.phone ? `· ${a.phone}` : ''}
                        </button>
                      ))}
                    </div>
                  )}
                </>
              )}
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <Label className="text-xs">Amount (UGX)</Label>
                <Input className="mt-1" inputMode="numeric" value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^\d,]/g, ''))} placeholder="e.g. 500,000" />
              </div>
              <div>
                <Label className="text-xs">Date paid</Label>
                <Input className="mt-1" type="date" max={kampalaToday()} value={paidOn} onChange={(e) => setPaidOn(e.target.value)} />
              </div>
              <div>
                <Label className="text-xs">Channel used</Label>
                <Select value={channel} onValueChange={setChannel}>
                  <SelectTrigger className="mt-1"><SelectValue placeholder="Choose channel" /></SelectTrigger>
                  <SelectContent>{WH_CHANNELS.map((c) => <SelectItem key={c.value} value={c.value}>{c.label}</SelectItem>)}</SelectContent>
                </Select>
              </div>
              <div>
                <Label className="text-xs">Transaction / receipt reference</Label>
                <Input className="mt-1" maxLength={120} value={reference} onChange={(e) => setReference(e.target.value)} />
              </div>
            </div>
            <div>
              <Label className="text-xs">Notes (optional)</Label>
              <Textarea className="mt-1" maxLength={1000} rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
            </div>
            <div>
              <Label className="text-xs">Evidence (optional screenshot, receipt or PDF, up to 10 MB)</Label>
              <Input className="mt-1" type="file" accept="image/*,application/pdf"
                onChange={(e) => { setFile(e.target.files?.[0] ?? null); evidencePath.current = null; }} />
            </div>
          </div>
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={onClose} disabled={saving}>Cancel</Button>
            <Button onClick={() => submit(false)} disabled={saving} className="gap-1.5">
              {saving && <Loader2 className="h-4 w-4 animate-spin" />} Save record
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog open={dupAsk} onOpenChange={setDupAsk}>
        <DialogContent className="max-w-sm rounded-2xl">
          <DialogHeader>
            <DialogTitle>This looks like a duplicate</DialogTitle>
            <DialogDescription>
              An entry with the same agent, amount, date and reference already exists. Save this one as well?
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setDupAsk(false)}>Don't save</Button>
            <Button onClick={() => { setDupAsk(false); submit(true); }} disabled={saving}>Save anyway</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function ReverseDialog({ row, onClose, onDone }: { row: WhManualRow | null; onClose: () => void; onDone: () => void }) {
  const [reason, setReason] = useState('');
  const [saving, setSaving] = useState(false);
  const clientRef = useRef<string>(crypto.randomUUID());
  useEffect(() => { if (row) { setReason(''); clientRef.current = crypto.randomUUID(); } }, [row]);
  const submit = async () => {
    if (!row) return;
    setSaving(true);
    try {
      await reverseWhHistorical({ clientRef: clientRef.current, entryId: row.id, reason });
      toast.success('Entry reversed');
      onDone(); onClose();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not reverse');
    } finally { setSaving(false); }
  };
  return (
    <Dialog open={!!row} onOpenChange={(o) => { if (!o && !saving) onClose(); }}>
      <DialogContent className="max-w-sm rounded-2xl">
        <DialogHeader>
          <DialogTitle>Reverse entry</DialogTitle>
          <DialogDescription>
            {row ? `${formatUGX(row.amount)} to ${row.agent_name || 'agent'} on ${row.paid_on}. ` : ''}
            The original stays on record; a linked reversal is saved with your reason.
          </DialogDescription>
        </DialogHeader>
        <Textarea rows={3} maxLength={500} placeholder="Reason (at least 10 characters)" value={reason} onChange={(e) => setReason(e.target.value)} />
        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={onClose} disabled={saving}>Cancel</Button>
          <Button variant="destructive" onClick={submit} disabled={saving || reason.trim().length < 10}>
            {saving && <Loader2 className="h-4 w-4 animate-spin mr-1" />} Reverse
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * mode "ops": Agent Ops form, list, reverse and CSV (writing only if the server says can_write).
 * mode "readonly": COO / CFO view with breakdowns; never shows write actions.
 */
export function WhHistoricalDisbursementsPanel({ mode, offSystem, defaultOpen = false }: { mode: 'ops' | 'readonly'; offSystem?: boolean; defaultOpen?: boolean }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(defaultOpen);
  const [filters, setFilters] = useState<WhHistFilters>({});
  const [recordOpen, setRecordOpen] = useState(false);
  const [reverseRow, setReverseRow] = useState<WhManualRow | null>(null);

  const q = useQuery({
    queryKey: ['wh-hist-overview', filters],
    queryFn: () => fetchWhHistOverview(filters),
    enabled: open,
    staleTime: 30_000,
  });
  const data = q.data;
  const canWrite = mode === 'ops' && !!data?.can_write;
  const refresh = () => qc.invalidateQueries({ queryKey: ['wh-hist-overview'] });

  const agents = useMemo(() => {
    const m = new Map<string, string>();
    [...(data?.manual ?? []), ...(data?.system ?? [])].forEach((r) => m.set(r.agent_id, r.agent_name || 'Agent'));
    return Array.from(m.entries()).sort((a, b) => a[1].localeCompare(b[1]));
  }, [data]);

  const exportCsv = () => {
    if (!data) return;
    const blob = new Blob([buildWhCsv(data.system, data.manual)], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `welile-homes-disbursements-${kampalaToday()}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  if (q.error && open) {
    const msg = (q.error as Error).message;
    if (/not allowed/i.test(msg)) return null;
  }

  return (
    <Card className="p-3 sm:p-4 rounded-2xl space-y-3">
      <button type="button" className="w-full flex items-center justify-between gap-2 text-left" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <span className="flex items-center gap-2">
          <History className="h-4 w-4 text-primary" />
          <span className="font-semibold text-sm">Welile Homes disbursements: system recorded vs manually entered</span>
        </span>
        <ChevronDown className={cn('h-4 w-4 transition-transform', open && 'rotate-180')} />
      </button>
      {open && (
        <div className="space-y-3">
          {offSystem && (
            <p className="text-xs rounded-xl border border-amber-500/30 bg-amber-500/5 p-2.5 text-amber-800 dark:text-amber-200">
              Manually entered disbursements are off-system and not in the ledger. They are never included in Cash Position,
              Money Out, Receivables, Payables or any ledger-based figure.
            </p>
          )}
          {mode === 'readonly' && <p className="text-[11px] text-muted-foreground">View only. Entries are added and reversed by Agent Ops.</p>}
          {q.isLoading ? (
            <div className="p-6 flex justify-center"><Loader2 className="h-5 w-5 animate-spin text-primary" /></div>
          ) : q.error ? (
            <p className="text-xs text-destructive">Could not load disbursements: {(q.error as Error).message}</p>
          ) : data ? (
            <>
              <Totals system={data.system_total} manual={data.manual_total} offSystem={offSystem} />
              <div className="flex flex-wrap items-end gap-2">
                {canWrite && (
                  <Button size="sm" className="gap-1.5" onClick={() => setRecordOpen(true)}><Plus className="h-4 w-4" /> Record past disbursement</Button>
                )}
                <Select value={filters.agentId ?? 'all'} onValueChange={(v) => setFilters((f) => ({ ...f, agentId: v === 'all' ? null : v }))}>
                  <SelectTrigger className="h-9 w-[170px] text-xs"><SelectValue placeholder="Agent" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All agents</SelectItem>
                    {agents.map(([id, name]) => <SelectItem key={id} value={id}>{name}</SelectItem>)}
                  </SelectContent>
                </Select>
                <Select value={filters.channel ?? 'all'} onValueChange={(v) => setFilters((f) => ({ ...f, channel: v === 'all' ? null : v }))}>
                  <SelectTrigger className="h-9 w-[160px] text-xs"><SelectValue placeholder="Channel" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All channels</SelectItem>
                    <SelectItem value="in_app">In-app (system)</SelectItem>
                    {WH_CHANNELS.map((c) => <SelectItem key={c.value} value={c.value}>{c.label}</SelectItem>)}
                  </SelectContent>
                </Select>
                <Input type="date" className="h-9 w-[150px] text-xs" value={filters.from ?? ''} onChange={(e) => setFilters((f) => ({ ...f, from: e.target.value || null }))} aria-label="From" />
                <Input type="date" className="h-9 w-[150px] text-xs" value={filters.to ?? ''} onChange={(e) => setFilters((f) => ({ ...f, to: e.target.value || null }))} aria-label="To" />
                <Button size="sm" variant="outline" className="gap-1.5" onClick={exportCsv}><Download className="h-4 w-4" /> CSV</Button>
              </div>
              <Tabs defaultValue="manual">
                <TabsList className="flex-wrap h-auto">
                  <TabsTrigger value="manual" className="text-xs">Manually entered ({data.manual_count})</TabsTrigger>
                  <TabsTrigger value="system" className="text-xs">System recorded ({data.system_count})</TabsTrigger>
                  {mode === 'readonly' && <>
                    <TabsTrigger value="channel" className="text-xs">By channel</TabsTrigger>
                    <TabsTrigger value="agent" className="text-xs">By agent</TabsTrigger>
                    <TabsTrigger value="month" className="text-xs">By month</TabsTrigger>
                  </>}
                </TabsList>
                <TabsContent value="manual">
                  <p className="text-[11px] text-muted-foreground mb-1">Running total excludes reversed entries: {formatUGX(data.manual_total)}</p>
                  <div className="rounded-xl border divide-y max-h-[60vh] overflow-y-auto">
                    {data.manual.length === 0 ? <p className="p-3 text-xs text-muted-foreground">No manual entries.</p>
                      : data.manual.map((r) => <ManualRowCard key={r.id} r={r} canReverse={canWrite} onReverse={setReverseRow} offSystem={offSystem} />)}
                  </div>
                </TabsContent>
                <TabsContent value="system">
                  <div className="rounded-xl border divide-y max-h-[60vh] overflow-y-auto">
                    {data.system.length === 0 ? <p className="p-3 text-xs text-muted-foreground">No in-app disbursements yet.</p>
                      : data.system.map((r) => <SystemRowCard key={r.id} r={r} />)}
                  </div>
                </TabsContent>
                {mode === 'readonly' && <>
                  <TabsContent value="channel"><BreakdownTable label="Channel" rows={breakdown(data.system, data.manual, (r) => channelLabel(r.channel))} /></TabsContent>
                  <TabsContent value="agent"><BreakdownTable label="Agent" rows={breakdown(data.system, data.manual, (r) => r.agent_name || 'Agent')} /></TabsContent>
                  <TabsContent value="month"><BreakdownTable label="Month" rows={breakdown(data.system, data.manual, (r) => r.paid_on.slice(0, 7)).sort((a, b) => b.key.localeCompare(a.key))} /></TabsContent>
                </>}
              </Tabs>
            </>
          ) : null}
        </div>
      )}
      {canWrite && <RecordDialog open={recordOpen} onClose={() => setRecordOpen(false)} onSaved={refresh} />}
      {canWrite && <ReverseDialog row={reverseRow} onClose={() => setReverseRow(null)} onDone={refresh} />}
    </Card>
  );
}

/** Rent Plan detail: manual entries in their own section under the system funding history. */
export function WhPlanHistoricalSection({ subscriptionId }: { subscriptionId: string }) {
  const q = useQuery({
    queryKey: ['wh-hist-overview', { subscriptionId }],
    queryFn: () => fetchWhHistOverview({ subscriptionId }),
    staleTime: 30_000,
    retry: false,
  });
  if (!q.data || q.data.manual.length === 0) return null;
  return (
    <div className="pt-2">
      <h5 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">Historical disbursements (manually entered)</h5>
      <div className="rounded-xl border divide-y">
        {q.data.manual.map((r) => <ManualRowCard key={r.id} r={r} canReverse={false} onReverse={() => {}} />)}
      </div>
    </div>
  );
}
