import { useCallback, useEffect, useMemo, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  addArrears,
  calculateArrearsRun,
  cancelArrears,
  listArrearsComponentOptions,
  listPendingArrears,
  type ArrearsComponentOption,
  type PendingArrearsRow,
} from '@/hr/pay/api/arrears';
import { supabase } from '@/hr/api/client';

interface StaffOption {
  id: string;
  staffRef: string;
  name: string;
}

function formatAmount(value: number): string {
  return new Intl.NumberFormat('en-UG', { maximumFractionDigits: 0 }).format(value);
}

/** Amounts owed for an earlier period, paid on an off-cycle run. */
export default function ArrearsPanel({
  runId,
  runType,
  status,
  onDone,
}: {
  runId: string;
  runType: string;
  status: string;
  onDone: () => void;
}) {
  const [rows, setRows] = useState<PendingArrearsRow[]>([]);
  const [components, setComponents] = useState<ArrearsComponentOption[]>([]);
  const [staff, setStaff] = useState<StaffOption[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isPreparer, setIsPreparer] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [pending, comps] = await Promise.all([
        listPendingArrears(),
        listArrearsComponentOptions(),
      ]);
      setRows(pending);
      setComponents(comps);
      setSelected(new Set(pending.filter((r) => r.paidInRunId === runId).map((r) => r.id)));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [runId]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    let alive = true;
    void (async () => {
      const res = await (supabase.rpc as any)('hr_pay_is_preparer');
      if (alive) setIsPreparer(res?.data === true);
    })();
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    let alive = true;
    void (async () => {
      const staffRes = await supabase
        .from('hr_staff')
        .select('id, staff_ref, user_id')
        .eq('active', true)
        .order('staff_ref', { ascending: true });
      const staffRows = (staffRes.data ?? []) as Array<{
        id: string;
        staff_ref: string | null;
        user_id: string | null;
      }>;
      const userIds = staffRows.map((s) => s.user_id).filter(Boolean) as string[];
      const nameByUser: Record<string, string> = {};
      if (userIds.length > 0) {
        const profRes = await supabase.from('profiles').select('id, full_name').in('id', userIds);
        for (const p of (profRes.data ?? []) as Array<{ id: string; full_name: string | null }>) {
          if (p.full_name) nameByUser[p.id] = p.full_name;
        }
      }
      if (!alive) return;
      setStaff(
        staffRows.map((s) => ({
          id: s.id,
          staffRef: s.staff_ref ?? '',
          name: s.user_id ? nameByUser[s.user_id] ?? '' : '',
        })),
      );
    })();
    return () => {
      alive = false;
    };
  }, []);

  const selectable = useMemo(
    () => rows.filter((r) => r.paidInRunId === null || r.paidInRunId === runId),
    [rows, runId],
  );

  const selectedTotal = useMemo(
    () => selectable.filter((r) => selected.has(r.id)).reduce((sum, r) => sum + r.amount, 0),
    [selectable, selected],
  );

  const calculable = ['draft', 'calculated', 'returned'].includes(status);

  if (runType !== 'off_cycle') return null;

  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const doCalculate = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await calculateArrearsRun(runId, Array.from(selected));
      toast.success(res.message);
      await load();
      onDone();
    } catch (err) {
      setError((err as Error).message);
      toast.error((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-3 space-y-0">
        <div className="space-y-1">
          <CardTitle className="text-base">Arrears on this run</CardTitle>
          <p className="text-xs text-muted-foreground">
            Amounts owed for an earlier period. Only the people ticked below are paid — this run
            carries no salary, no advance recovery and no Local Service Tax.
          </p>
        </div>
        <AddArrearsDialog
          components={components}
          staff={staff}
          disabled={!isPreparer}
          onAdded={() => void load()}
        />
      </CardHeader>
      <CardContent className="space-y-3">
        {loading ? (
          <div className="flex justify-center py-6">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : rows.length === 0 ? (
          <p className="py-6 text-center text-xs text-muted-foreground">
            Nothing owed. Record an amount to pay it on this run.
          </p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-10">Pay</TableHead>
                <TableHead>Staff ref</TableHead>
                <TableHead>Name</TableHead>
                <TableHead>Component</TableHead>
                <TableHead>Owed for</TableHead>
                <TableHead className="text-right">Amount</TableHead>
                <TableHead>Basis</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r) => {
                const onAnotherRun = r.paidInRunId !== null && r.paidInRunId !== runId;
                return (
                  <TableRow key={r.id} className={onAnotherRun ? 'opacity-50' : undefined}>
                    <TableCell>
                      <input
                        type="checkbox"
                        aria-label={`Pay arrears for ${r.staffRef}`}
                        checked={selected.has(r.id)}
                        disabled={onAnotherRun || !calculable || !isPreparer}
                        onChange={() => toggle(r.id)}
                      />
                    </TableCell>
                    <TableCell className="font-mono text-xs">{r.staffRef || '—'}</TableCell>
                    <TableCell>{r.staffName || '—'}</TableCell>
                    <TableCell className="text-xs">{r.componentCode}</TableCell>
                    <TableCell className="font-mono text-xs">{r.periodOwed}</TableCell>
                    <TableCell className="text-right">{formatAmount(r.amount)}</TableCell>
                    <TableCell className="max-w-xs text-xs">
                      {r.basis}
                      {onAnotherRun && (
                        <span className="block font-semibold text-amber-700">
                          Already on run {r.paidInRunId?.slice(0, 8)}
                        </span>
                      )}
                    </TableCell>
                    <TableCell className="text-right">
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={busy || onAnotherRun || !isPreparer}
                        onClick={() => {
                          if (!window.confirm('Withdraw this arrears entry?')) return;
                          setBusy(true);
                          void cancelArrears(r.id)
                            .then(() => {
                              toast.success('Arrears entry withdrawn.');
                              return load();
                            })
                            .catch((err) => toast.error((err as Error).message))
                            .finally(() => setBusy(false));
                        }}
                      >
                        Withdraw
                      </Button>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}

        {error && (
          <p role="alert" className="whitespace-pre-wrap text-xs font-medium text-destructive">
            {error}
          </p>
        )}

        <div className="flex flex-wrap items-center gap-3 border-t border-border pt-3">
          <Button
            size="sm"
            disabled={busy || selected.size === 0 || !calculable || !isPreparer}
            title={
              !isPreparer
                ? 'Your position does not hold prepare authority for payroll runs.'
                : !calculable
                  ? 'This run can no longer be calculated.'
                  : selected.size === 0
                    ? 'Tick at least one arrears entry.'
                    : 'Write payslips for the ticked entries.'
            }
            onClick={() => void doCalculate()}
          >
            {busy && <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />}
            Calculate arrears run
          </Button>
          <span className="text-xs text-muted-foreground">
            {selected.size} selected · {formatAmount(selectedTotal)}
          </span>
        </div>

        <p className="text-xs text-muted-foreground">
          Recalculating replaces every payslip on this run. An entry stays owed until the run
          records its paid event, so a cancelled or reopened run leaves the money still payable.
        </p>
      </CardContent>
    </Card>
  );
}

function AddArrearsDialog({
  components,
  staff,
  disabled,
  onAdded,
}: {
  components: ArrearsComponentOption[];
  staff: StaffOption[];
  disabled: boolean;
  onAdded: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [staffId, setStaffId] = useState('');
  const [componentId, setComponentId] = useState('');
  const [amount, setAmount] = useState('');
  const [periodOwed, setPeriodOwed] = useState('');
  const [basis, setBasis] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (componentId) return;
    const arrears = components.find((c) => c.code === 'ARREARS');
    if (arrears) setComponentId(arrears.id);
  }, [components, componentId]);

  const amountNumber = Number(amount);
  const invalid =
    !staffId ||
    !componentId ||
    !Number.isFinite(amountNumber) ||
    amountNumber <= 0 ||
    !/^[0-9]{4}-[0-9]{2}$/.test(periodOwed) ||
    basis.trim().length < 10;

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      await addArrears({ staffId, componentId, amount: amountNumber, periodOwed, basis });
      setOpen(false);
      setStaffId('');
      setAmount('');
      setPeriodOwed('');
      setBasis('');
      onAdded();
      toast.success('Arrears recorded.');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button
          size="sm"
          disabled={disabled}
          title={
            disabled
              ? 'Your position does not hold prepare authority for payroll runs.'
              : 'Record an amount owed.'
          }
        >
          Record arrears
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Record arrears</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1">
            <Label htmlFor="arrears-staff">Staff member</Label>
            <select
              id="arrears-staff"
              className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
              value={staffId}
              onChange={(e) => setStaffId(e.target.value)}
            >
              <option value="">Select a staff member</option>
              {staff.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.staffRef}
                  {s.name ? ` — ${s.name}` : ''}
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-1">
            <Label htmlFor="arrears-component">Component</Label>
            <select
              id="arrears-component"
              className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
              value={componentId}
              onChange={(e) => setComponentId(e.target.value)}
            >
              <option value="">Select a component</option>
              {components.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.code} — {c.name}
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-1">
            <Label htmlFor="arrears-amount">Amount</Label>
            <Input
              id="arrears-amount"
              type="number"
              min="1"
              step="1"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="arrears-period">Period owed for</Label>
            <Input
              id="arrears-period"
              placeholder="2026-08"
              value={periodOwed}
              onChange={(e) => setPeriodOwed(e.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              The month the money was owed for, written as YYYY-MM. Not the month it is paid in.
            </p>
          </div>
          <div className="space-y-1">
            <Label htmlFor="arrears-basis">Written basis</Label>
            <Textarea
              id="arrears-basis"
              rows={3}
              value={basis}
              onChange={(e) => setBasis(e.target.value)}
              placeholder="Who authorised this and why. This is the audit record."
            />
            <p className="text-xs text-muted-foreground">At least 10 characters required.</p>
          </div>
          {error && (
            <p role="alert" className="whitespace-pre-wrap text-xs font-medium text-destructive">
              {error}
            </p>
          )}
        </div>
        <DialogFooter>
          <Button size="sm" onClick={() => void save()} disabled={saving || invalid}>
            {saving && <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />}
            Record arrears
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
