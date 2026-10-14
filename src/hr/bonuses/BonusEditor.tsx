import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { ArrowLeft, Loader2, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { formatUGX } from '@/lib/creditFeeCalculations';
import {
  approvePool, cancelPool, listPools, payPool, pendingForMe, poolDetail, returnPool, savePool,
  staffOptions, submitPool, type BonusDetailRow, type BonusPool, type StaffOption,
} from './api';
import { allocateBonus, round3, splitEqually } from './bonusMath';
import { StatusBadge } from './BonusList';

interface Row { staff_id: string; staff_ref: string | null; full_name: string | null; department: string | null; position: string | null; pct: string; }

const DEFAULT_DEPT = 'Engineering & Product';
const fmtTime = (iso: string | null) => (iso ? new Date(iso).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' }) : '—');

type Confirm = null | 'approve' | 'pay' | 'return' | 'decline' | 'cancel';

export default function BonusEditor({ id }: { id: string }) {
  const isNew = id === 'new';
  const navigate = useNavigate();
  const [poolId, setPoolId] = useState<string | null>(isNew ? null : id);
  const [pool, setPool] = useState<BonusPool | null>(null);
  const [detail, setDetail] = useState<BonusDetailRow[]>([]);
  const [kinds, setKinds] = useState<string[]>([]);
  const [loading, setLoading] = useState(!isNew);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [title, setTitle] = useState('');
  const [amountText, setAmountText] = useState('');
  const [notes, setNotes] = useState('');
  const [rows, setRows] = useState<Row[]>([]);

  const [options, setOptions] = useState<StaffOption[] | null>(null);
  const [search, setSearch] = useState('');
  const [dept, setDept] = useState<string | null>(DEFAULT_DEPT);
  const [confirm, setConfirm] = useState<Confirm>(null);
  const [returnNote, setReturnNote] = useState('');

  const status = pool?.status ?? 'draft';
  const editable = isNew || status === 'draft' || status === 'returned';

  const load = useCallback(async (pid: string) => {
    setLoading(true); setError(null);
    try {
      const [all, det, pend] = await Promise.all([listPools(), poolDetail(pid), pendingForMe().catch(() => [])]);
      const p = all.find((x) => x.pool_id === pid) ?? null;
      if (!p) throw new Error('Bonus pool not found.');
      setPool(p); setDetail(det);
      setKinds(pend.filter((x) => x.pool_id === pid).map((x) => x.kind));
      setTitle(p.title); setAmountText(Number(p.pool_amount).toLocaleString('en-US')); setNotes(p.notes ?? '');
      setRows(det.map((d) => ({ ...d, pct: String(Number(d.percentage)) })));
    } catch (e) { setError((e as Error).message); }
    setLoading(false);
  }, []);

  useEffect(() => { if (poolId) void load(poolId); }, [poolId, load]);
  useEffect(() => {
    if (editable && options === null) staffOptions().then(setOptions).catch((e: Error) => { setError(e.message); setOptions([]); });
  }, [editable, options]);

  const amount = Number(amountText.replace(/[^0-9]/g, '')) || 0;
  const live = useMemo(
    () => allocateBonus(amount, rows.map((r) => ({ staff_id: r.staff_id, percentage: Number(r.pct) || 0 }))),
    [amount, rows],
  );
  const totalPct = round3(rows.reduce((s, r) => s + round3(Number(r.pct) || 0), 0));
  const allocated = Object.values(live).reduce((s, n) => s + n, 0);

  const departments = useMemo(
    () => Array.from(new Set((options ?? []).map((o) => o.department).filter(Boolean) as string[])).sort(),
    [options],
  );
  const picked = new Set(rows.map((r) => r.staff_id));
  const filtered = (options ?? []).filter((o) => {
    if (picked.has(o.staff_id)) return false;
    if (dept && o.department !== dept) return false;
    const q = search.trim().toLowerCase();
    if (!q) return true;
    return [o.full_name, o.staff_ref, o.department, o.position].some((v) => v?.toLowerCase().includes(q));
  });

  const addPerson = (o: StaffOption) => setRows((r) => [...r, { ...o, pct: '' }]);
  const setPct = (sid: string, v: string) => {
    if (!/^\d{0,3}(\.\d{0,3})?$/.test(v)) return;
    setRows((r) => r.map((x) => (x.staff_id === sid ? { ...x, pct: v } : x)));
  };
  const doSplit = () => {
    const parts = splitEqually(rows.length);
    setRows((r) => r.map((x, i) => ({ ...x, pct: String(parts[i]) })));
  };

  const save = async (): Promise<string | null> => {
    try {
      const newId = await savePool({
        id: poolId, title, amount, notes,
        allocations: rows.map((r) => ({ staff_id: r.staff_id, percentage: Number(r.pct) || 0 })),
      });
      return newId;
    } catch (e) { toast.error((e as Error).message); return null; }
  };

  const onSave = async () => {
    setBusy(true);
    const nid = await save();
    setBusy(false);
    if (!nid) return;
    toast.success('Draft saved');
    if (!poolId) { setPoolId(nid); navigate(`/hr/bonuses/${nid}`, { replace: true }); } else void load(nid);
  };

  const onSubmit = async () => {
    setBusy(true);
    const nid = await save();
    if (!nid) { setBusy(false); return; }
    try { await submitPool(nid); toast.success('Submitted for CEO approval'); }
    catch (e) { toast.error((e as Error).message); }
    setBusy(false);
    if (!poolId) { setPoolId(nid); navigate(`/hr/bonuses/${nid}`, { replace: true }); } else void load(nid);
  };

  const runConfirm = async () => {
    if (!poolId || !confirm) return;
    setBusy(true);
    try {
      if (confirm === 'approve') { await approvePool(poolId); toast.success('Bonus pool approved'); }
      if (confirm === 'return') { await returnPool(poolId, returnNote); toast.success('Returned for rework'); }
      if (confirm === 'decline') { await returnPool(poolId, returnNote); toast.success('Declined and returned to HR'); }
      if (confirm === 'cancel') { await cancelPool(poolId); toast.success('Bonus pool cancelled'); }
      if (confirm === 'pay') {
        const r = await payPool(poolId);
        toast.success(`Paid — ${formatUGX(Number(r.amount))} credited to ${r.people} wallets.`);
      }
      setConfirm(null); setReturnNote('');
      void load(poolId);
    } catch (e) { toast.error((e as Error).message); }
    setBusy(false);
  };

  if (loading) return <div className="p-6"><Loader2 className="h-5 w-5 animate-spin" /></div>;

  const allocatedShown = editable ? allocated : Number(pool?.allocated ?? 0);
  const people = editable ? rows.length : detail.length;

  return (
    <div className="mx-auto max-w-5xl space-y-4 p-4 pb-28">
      <Link to="/hr/bonuses" className="inline-flex items-center text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="mr-1 h-4 w-4" /> Bonuses
      </Link>
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="text-2xl font-bold">{isNew && !poolId ? 'New bonus pool' : pool?.title ?? 'Bonus pool'}</h1>
        {pool && <StatusBadge status={pool.status} />}
      </div>
      {error && <p className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">{error}</p>}
      {status === 'returned' && pool?.return_note && (
        <p className="whitespace-pre-wrap rounded-md border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-800">
          Returned for rework: {pool.return_note}
        </p>
      )}

      {editable ? (
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="space-y-1 text-sm"><span className="font-medium">Title</span>
            <Input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={120} /></label>
          <label className="space-y-1 text-sm"><span className="font-medium">Amount to distribute (UGX)</span>
            <Input inputMode="numeric" value={amountText}
              onChange={(e) => { const n = e.target.value.replace(/[^0-9]/g, ''); setAmountText(n ? Number(n).toLocaleString('en-US') : ''); }} /></label>
          <label className="space-y-1 text-sm sm:col-span-2"><span className="font-medium">Notes</span>
            <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} /></label>
        </div>
      ) : (
        <div className="grid gap-2 rounded-xl border p-3 text-sm sm:grid-cols-3">
          <div><p className="text-muted-foreground">Pool</p><p className="font-semibold">{formatUGX(Number(pool?.pool_amount ?? 0))}</p></div>
          <div><p className="text-muted-foreground">Prepared by</p><p className="font-semibold">{pool?.prepared_by_name ?? '—'}</p></div>
          <div><p className="text-muted-foreground">Approved by</p><p className="font-semibold">{pool?.approved_by_name ?? '—'}</p></div>
          {pool?.notes && <p className="sm:col-span-3 whitespace-pre-wrap text-muted-foreground">{pool.notes}</p>}
        </div>
      )}

      {editable && (
        <div className="space-y-2 rounded-xl border p-3">
          <p className="font-medium">Add people</p>
          <Input placeholder="Search name, staff ref, department or position" value={search} onChange={(e) => setSearch(e.target.value)} />
          <div className="flex flex-wrap gap-1.5">
            <Button size="sm" variant={dept === null ? 'default' : 'outline'} onClick={() => setDept(null)}>All</Button>
            {departments.map((d) => (
              <Button key={d} size="sm" variant={dept === d ? 'default' : 'outline'} onClick={() => setDept(d)}>{d}</Button>
            ))}
          </div>
          <div className="max-h-56 overflow-y-auto divide-y rounded-md border">
            {options === null ? <p className="p-2 text-sm text-muted-foreground">Loading…</p>
              : filtered.length === 0 ? <p className="p-2 text-sm text-muted-foreground">No one matches.</p>
              : filtered.map((o) => (
                <button key={o.staff_id} type="button" onClick={() => addPerson(o)} className="flex w-full items-center justify-between gap-2 p-2 text-left text-sm hover:bg-muted/50">
                  <span><span className="font-medium">{o.full_name ?? 'Unnamed'}</span> <span className="text-muted-foreground">· {o.staff_ref ?? '—'}</span></span>
                  <span className="text-xs text-muted-foreground">{[o.department, o.position].filter(Boolean).join(' · ')}</span>
                </button>
              ))}
          </div>
        </div>
      )}

      <div className="space-y-2">
        {editable && rows.length > 0 && (
          <div className="flex justify-end"><Button size="sm" variant="outline" onClick={doSplit}>Split equally</Button></div>
        )}
        <div className="overflow-x-auto rounded-xl border">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-left text-xs text-muted-foreground">
              <tr><th className="p-3">Name</th><th className="p-3 text-right">%</th><th className="p-3 text-right">Amount</th>
                {editable ? <th className="p-3" /> : <th className="p-3">Paid</th>}</tr>
            </thead>
            <tbody>
              {editable ? rows.map((r) => (
                <tr key={r.staff_id} className="border-t">
                  <td className="p-3"><p className="font-medium">{r.full_name ?? 'Unnamed'}</p>
                    <p className="text-xs text-muted-foreground">{r.staff_ref ?? '—'}{r.department ? ` · ${r.department}` : ''}</p></td>
                  <td className="p-3 text-right"><Input className="ml-auto w-24 text-right" inputMode="decimal" value={r.pct} onChange={(e) => setPct(r.staff_id, e.target.value)} /></td>
                  <td className="p-3 text-right tabular-nums">{formatUGX(live[r.staff_id] ?? 0)}</td>
                  <td className="p-3 text-right"><Button size="icon" variant="ghost" aria-label="Remove" onClick={() => setRows((x) => x.filter((y) => y.staff_id !== r.staff_id))}><Trash2 className="h-4 w-4" /></Button></td>
                </tr>
              )) : detail.map((d) => (
                <tr key={d.staff_id} className="border-t">
                  <td className="p-3"><p className="font-medium">{d.full_name ?? 'Unnamed'}</p>
                    <p className="text-xs text-muted-foreground">{d.staff_ref ?? '—'}{d.department ? ` · ${d.department}` : ''}</p></td>
                  <td className="p-3 text-right tabular-nums">{Number(d.percentage)}%</td>
                  <td className="p-3 text-right tabular-nums">{formatUGX(Number(d.amount))}</td>
                  <td className="p-3 text-xs">{fmtTime(d.paid_at)}</td>
                </tr>
              ))}
              {(editable ? rows.length : detail.length) === 0 && (
                <tr><td colSpan={4} className="p-3 text-center text-muted-foreground">No people added yet.</td></tr>
              )}
            </tbody>
          </table>
        </div>
        <p className="text-xs text-muted-foreground">Paid to each person's Welile wallet, outside payroll.</p>
      </div>

      <div className="fixed inset-x-0 bottom-0 z-20 border-t bg-background/95 backdrop-blur">
        <div className="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-3 p-3 text-sm">
          <div className="flex flex-wrap gap-4">
            <span>Total %: <b className={totalPct > 100 && editable ? 'text-destructive' : ''}>{editable ? totalPct : round3(Number(pool?.total_pct ?? 0))}%</b></span>
            <span>Allocated: <b>{formatUGX(allocatedShown)}</b></span>
            <span>Unallocated: <b>{formatUGX(Math.max(0, (editable ? amount : Number(pool?.pool_amount ?? 0)) - allocatedShown))}</b></span>
          </div>
          <div className="flex flex-wrap gap-2">
            {editable && (
              <>
                {poolId && <Button variant="outline" disabled={busy} onClick={() => setConfirm('cancel')}>Cancel pool</Button>}
                <Button variant="outline" disabled={busy} onClick={() => void onSave()}>Save draft</Button>
                <Button disabled={busy} onClick={() => void onSubmit()}>{busy && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}Submit for CEO approval</Button>
              </>
            )}
            {status === 'submitted' && kinds.includes('approve') && (
              <>
                <Button variant="outline" disabled={busy} onClick={() => setConfirm('return')}>Return with note</Button>
                <Button disabled={busy} onClick={() => setConfirm('approve')}>Approve</Button>
              </>
            )}
            {status === 'approved' && kinds.includes('pay') && (
              <>
                <Button variant="outline" disabled={busy} onClick={() => setConfirm('decline')}>Decline with note</Button>
                <Button disabled={busy} onClick={() => setConfirm('pay')}>Pay bonuses</Button>
              </>
            )}
          </div>
        </div>
      </div>

      <AlertDialog open={confirm !== null} onOpenChange={(o) => { if (!o && !busy) setConfirm(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {confirm === 'approve' && 'Approve this bonus pool?'}
              {confirm === 'pay' && 'Pay bonuses'}
              {confirm === 'return' && 'Return with note'}
              {confirm === 'decline' && 'Decline with note'}
              {confirm === 'cancel' && 'Cancel this bonus pool?'}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {confirm === 'approve' && `${formatUGX(Number(pool?.allocated ?? 0))} to ${people} people.`}
              {confirm === 'pay' && `Credit ${formatUGX(Number(pool?.allocated ?? 0))} to ${people} staff wallets?`}
              {(confirm === 'return' || confirm === 'decline') && 'Say what HR should change.'}
              {confirm === 'cancel' && 'A cancelled pool cannot be reopened.'}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {(confirm === 'return' || confirm === 'decline') && <Textarea value={returnNote} onChange={(e) => setReturnNote(e.target.value)} rows={3} />}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>Back</AlertDialogCancel>
            <AlertDialogAction disabled={busy || ((confirm === 'return' || confirm === 'decline') && !returnNote.trim())}
              onClick={(e) => { e.preventDefault(); void runConfirm(); }}>
              {busy && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}Confirm
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
