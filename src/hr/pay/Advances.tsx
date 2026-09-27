import { useCallback, useEffect, useMemo, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import HRPlaceholderPage from '@/hr/pages/HRPlaceholderPage';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { listAdvances, requestAdvance, decideAdvance, cancelAdvance, updateAdvance, type AdvanceRow } from '@/hr/pay/api/advances';
import { listStaffForPayroll, type PayrollStaffOption } from '@/hr/pay/api/compensation';
import { myPayrollAuthority } from '@/hr/pay/api/workflow';

function formatAmount(value: number): string {
  return new Intl.NumberFormat('en-UG', { maximumFractionDigits: 0 }).format(value);
}

function formatDate(value: string | null): string {
  if (!value) return '—';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return '—';
  return parsed.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}

function firstOfNextMonth(): string {
  const now = new Date();
  const d = new Date(now.getFullYear(), now.getMonth() + 1, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`;
}

const STATUS_CLASS: Record<string, string> = {
  requested: 'bg-amber-100 text-amber-800',
  hr_approved: 'bg-amber-100 text-amber-800',
  ceo_approved: 'bg-amber-100 text-amber-800',
  approved: 'bg-green-100 text-green-800',
  rejected: 'bg-muted text-muted-foreground',
  settled: 'bg-blue-100 text-blue-800',
  cancelled: 'bg-muted text-muted-foreground',
};

const STAGE_LABEL: Record<string, string> = {
  requested: 'Awaiting HR',
  hr_approved: 'Awaiting CEO',
  ceo_approved: 'Awaiting CFO',
  approved: 'Disbursed, recovering',
  settled: 'Settled',
  rejected: 'Rejected',
  cancelled: 'Cancelled',
};

const ACTION_LABEL: Record<string, string> = {
  requested: 'HR approve',
  hr_approved: 'CEO approve',
  ceo_approved: 'Record disbursement',
};

/** Confirmation shown after each step. Recording a disbursement moves no money. */
const DONE_LABEL: Record<string, string> = {
  requested: 'HR approval recorded.',
  hr_approved: 'CEO approval recorded.',
  ceo_approved: 'Disbursement recorded. No money was moved; recovery starts on the next payroll.',
};

function isActionable(status: string): boolean {
  return status === 'requested' || status === 'hr_approved' || status === 'ceo_approved';
}

export default function Advances() {
  const [rows, setRows] = useState<AdvanceRow[]>([]);
  const [staff, setStaff] = useState<PayrollStaffOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isPreparer, setIsPreparer] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  // Request dialog
  const [open, setOpen] = useState(false);
  const [staffId, setStaffId] = useState('');
  const [principal, setPrincipal] = useState('');
  const [purpose, setPurpose] = useState('');
  const [months, setMonths] = useState('');
  const [firstOn, setFirstOn] = useState(firstOfNextMonth());
  const [formError, setFormError] = useState('');
  const [saving, setSaving] = useState(false);

  // Reject dialog
  const [rejectRow, setRejectRow] = useState<AdvanceRow | null>(null);
  const [rejectNote, setRejectNote] = useState('');
  const [rejectError, setRejectError] = useState('');

  // Edit dialog
  const [editRow, setEditRow] = useState<AdvanceRow | null>(null);
  const [editPurpose, setEditPurpose] = useState('');
  const [editMonths, setEditMonths] = useState('1');
  const [editFirstOn, setEditFirstOn] = useState('');
  const [editError, setEditError] = useState('');
  const [editSaving, setEditSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [advances, authority] = await Promise.all([listAdvances(), myPayrollAuthority()]);
      setRows(advances);
      setIsPreparer(authority.preparer);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!isPreparer || staff.length > 0) return;
    listStaffForPayroll()
      .then(setStaff)
      .catch((err) => toast.error((err as Error).message));
  }, [isPreparer, staff.length]);

  const staffLabel = useMemo(() => {
    const map = new Map<string, string>();
    staff.forEach((s) => map.set(s.staffId, s.name));
    return map;
  }, [staff]);

  function resetForm() {
    setStaffId('');
    setPrincipal('');
    setPurpose('');
    setMonths('');
    setFirstOn(firstOfNextMonth());
    setFormError('');
  }

  const requestMonthly = useMemo(() => {
    const amount = Number(principal);
    const m = Number(months);
    if (!Number.isFinite(amount) || amount <= 0 || !Number.isInteger(m) || m < 1 || m > 3) {
      return null;
    }
    return Math.ceil(amount / m);
  }, [principal, months]);

  async function submitRequest() {
    const amount = Number(principal);
    const m = Number(months);
    if (!staffId) return setFormError('Choose the staff member.');
    if (!Number.isFinite(amount) || amount <= 0) return setFormError('Enter a principal above zero.');
    if (purpose.trim().length < 10) return setFormError('The purpose must be at least 10 characters.');
    if (!Number.isInteger(m) || m < 1 || m > 3) return setFormError('Choose the recovery period.');
    if (!firstOn) return setFormError('Choose the first recovery date.');
    setFormError('');
    setSaving(true);
    try {
      await requestAdvance(staffId, amount, purpose.trim(), 'fixed', Math.ceil(amount / m), firstOn, m);
      toast.success('Advance requested.');
      setOpen(false);
      resetForm();
      await load();
    } catch (err) {
      setFormError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  // Cancel dialog
  const [cancelRow, setCancelRow] = useState<AdvanceRow | null>(null);
  const [cancelReason, setCancelReason] = useState('');
  const [cancelError, setCancelError] = useState('');

  async function approve(row: AdvanceRow) {
    setBusyId(row.id);
    try {
      await decideAdvance(row.id, true, '');
      toast.success(DONE_LABEL[row.status] ?? 'Approval recorded.');
      await load();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusyId(null);
    }
  }

  const editMonthly = useMemo(() => {
    if (!editRow) return null;
    const m = Number(editMonths);
    if (!Number.isInteger(m) || m < 1 || m > 3) return null;
    return Math.ceil(editRow.principal / m);
  }, [editRow, editMonths]);

  async function submitEdit() {
    if (!editRow) return;
    const m = Number(editMonths);
    if (!Number.isInteger(m) || m < 1 || m > 3) return setEditError('Choose the recovery period.');
    if (editPurpose.trim().length === 0) return;
    setEditError('');
    setEditSaving(true);
    try {
      await updateAdvance(editRow.id, {
        purpose: editPurpose.trim(),
        recovery_months: m,
        first_recovery_on: editFirstOn,
      });
      toast.success('Advance updated.');
      setEditRow(null);
      await load();
    } catch (err) {
      setEditError((err as Error).message);
    } finally {
      setEditSaving(false);
    }
  }

  async function reject() {
    if (!rejectRow) return;
    if (rejectNote.trim().length < 10) {
      setRejectError('A note of at least 10 characters is required.');
      return;
    }
    setRejectError('');
    setBusyId(rejectRow.id);
    try {
      await decideAdvance(rejectRow.id, false, rejectNote.trim());
      toast.success('Advance rejected.');
      setRejectRow(null);
      setRejectNote('');
      await load();
    } catch (err) {
      setRejectError((err as Error).message);
    } finally {
      setBusyId(null);
    }
  }

  async function cancel() {
    if (!cancelRow) return;
    if (cancelReason.trim().length < 10) {
      setCancelError('A reason of at least 10 characters is required.');
      return;
    }
    setCancelError('');
    setBusyId(cancelRow.id);
    try {
      await cancelAdvance(cancelRow.id, cancelReason.trim());
      toast.success('Advance cancelled.');
      setCancelRow(null);
      setCancelReason('');
      await load();
    } catch (err) {
      setCancelError((err as Error).message);
    } finally {
      setBusyId(null);
    }
  }

  return (
    <HRPlaceholderPage
      heading="Salary advances"
      subtitle="Requested by staff or raised by HR, approved by HR then the CEO, paid out by the CFO and recorded here, then recovered automatically from payroll. Recording a disbursement sends no money."
    >
      {isPreparer && (
        <div>
          <Button onClick={() => setOpen(true)}>Request advance</Button>
        </div>
      )}

      {loading && (
        <p className="text-sm text-muted-foreground">
          <Loader2 className="mr-1 inline h-3.5 w-3.5 animate-spin" />
          Loading…
        </p>
      )}
      {error && (
        <p role="alert" className="text-sm font-medium text-destructive">
          {error}
        </p>
      )}

      {!loading && !error && (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Staff ref</TableHead>
              <TableHead>Name</TableHead>
              <TableHead className="text-right">Principal</TableHead>
              <TableHead>Purpose</TableHead>
              <TableHead>Recovery</TableHead>
              <TableHead>First recovery</TableHead>
              <TableHead className="text-right">Recovered so far</TableHead>
              <TableHead className="text-right">Outstanding</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>HR approved</TableHead>
              <TableHead>Approved</TableHead>
              <TableHead>Disbursed</TableHead>
              {isPreparer && <TableHead />}
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.length === 0 && (
              <TableRow>
                <TableCell colSpan={13 + (isPreparer ? 1 : 0)} className="py-8 text-center text-sm text-muted-foreground">
                  No salary advances recorded.
                </TableCell>
              </TableRow>
            )}
            {rows.map((row) => (
              <TableRow key={row.id}>
                <TableCell className="font-mono text-xs">{row.staff_ref ?? '—'}</TableCell>
                <TableCell>{row.staff_name ?? staffLabel.get(row.staff_id) ?? '—'}</TableCell>
                <TableCell className="text-right">{formatAmount(row.principal)}</TableCell>
                <TableCell className="max-w-[220px] text-xs">{row.purpose}</TableCell>
                <TableCell className="text-xs">
                  {formatAmount(row.recovery_value)} per month
                  {row.recovery_months ? ` (${row.recovery_months} months)` : ''}
                </TableCell>
                <TableCell className="text-xs">{formatDate(row.first_recovery_on)}</TableCell>
                <TableCell className="text-right">{formatAmount(row.recovered)}</TableCell>
                <TableCell className="text-right font-medium">{formatAmount(row.outstanding)}</TableCell>
                <TableCell>
                  <span
                    className={`inline-flex rounded-full px-2 py-0.5 text-[10px] font-semibold ${
                      STATUS_CLASS[row.status] ?? 'bg-muted text-muted-foreground'
                    }`}
                  >
                    {STAGE_LABEL[row.status] ?? row.status}
                  </span>
                </TableCell>
                <TableCell className="text-xs">{formatDate(row.hr_approved_at)}</TableCell>
                <TableCell className="text-xs">{formatDate(row.approved_at)}</TableCell>
                <TableCell className="text-xs">{formatDate(row.disbursed_at)}</TableCell>
                {isPreparer && (
                  <TableCell className="whitespace-nowrap text-right">
                    {row.status === 'requested' && (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={busyId === row.id}
                        onClick={() => {
                          setEditRow(row);
                          setEditPurpose(row.purpose);
                          setEditMonths(String(row.recovery_months ?? 1));
                          setEditFirstOn(row.first_recovery_on);
                          setEditError('');
                        }}
                      >
                        Edit
                      </Button>
                    )}
                  </TableCell>
                )}
                <TableCell className="whitespace-nowrap text-right">
                  {isActionable(row.status) && (
                    <span className="inline-flex gap-2">
                      <Button
                        size="sm"
                        disabled={busyId === row.id}
                        title={
                          row.status === 'ceo_approved'
                            ? 'Records that this advance has been paid out. It sends no money — pay the staff member first, then record it here.'
                            : undefined
                        }
                        onClick={() => void approve(row)}
                      >
                        {ACTION_LABEL[row.status]}
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={busyId === row.id}
                        onClick={() => {
                          setRejectRow(row);
                          setRejectNote('');
                          setRejectError('');
                        }}
                      >
                        Reject
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={busyId === row.id}
                        onClick={() => {
                          setCancelRow(row);
                          setCancelReason('');
                          setCancelError('');
                        }}
                      >
                        Cancel
                      </Button>
                    </span>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      <Dialog open={open} onOpenChange={(next) => (next ? setOpen(true) : (setOpen(false), resetForm()))}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Request a salary advance</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1">
              <Label>Staff member</Label>
              <Select value={staffId} onValueChange={setStaffId}>
                <SelectTrigger>
                  <SelectValue placeholder="Choose staff" />
                </SelectTrigger>
                <SelectContent>
                  {staff.map((s) => (
                    <SelectItem key={s.staffId} value={s.staffId}>
                      {s.name}
                      {s.department ? ` · ${s.department}` : ''}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label>Principal (UGX)</Label>
              <Input
                inputMode="numeric"
                value={principal}
                onChange={(e) => setPrincipal(e.target.value)}
              />
            </div>
            <div className="space-y-1">
              <Label>Purpose</Label>
              <Textarea
                value={purpose}
                onChange={(e) => setPurpose(e.target.value)}
                placeholder="At least 10 characters"
              />
            </div>
            <div className="space-y-1">
              <Label>Recovery period</Label>
              <Select value={months} onValueChange={setMonths}>
                <SelectTrigger>
                  <SelectValue placeholder="Choose period" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="1">1 month</SelectItem>
                  <SelectItem value="2">2 months</SelectItem>
                  <SelectItem value="3">3 months</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {requestMonthly !== null && (
              <p className="text-xs text-muted-foreground">
                Monthly deduction: {formatAmount(requestMonthly)} UGX
              </p>
            )}
            <div className="space-y-1">
              <Label>First recovery</Label>
              <Input type="date" value={firstOn} onChange={(e) => setFirstOn(e.target.value)} />
            </div>
            {formError && (
              <p role="alert" className="text-sm font-medium text-destructive">
                {formError}
              </p>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => { setOpen(false); resetForm(); }}>
              Cancel
            </Button>
            <Button disabled={saving} onClick={() => void submitRequest()}>
              {saving && <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />}
              Request
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={Boolean(rejectRow)} onOpenChange={(next) => !next && setRejectRow(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Reject this advance</DialogTitle>
          </DialogHeader>
          <div className="space-y-2">
            <Label>Reason</Label>
            <Textarea
              value={rejectNote}
              onChange={(e) => setRejectNote(e.target.value)}
              placeholder="At least 10 characters"
            />
            {rejectError && (
              <p role="alert" className="text-sm font-medium text-destructive">
                {rejectError}
              </p>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRejectRow(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={busyId === rejectRow?.id}
              onClick={() => void reject()}
            >
              Reject
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={Boolean(cancelRow)} onOpenChange={(next) => !next && setCancelRow(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Cancel this advance</DialogTitle>
          </DialogHeader>
          <div className="space-y-2">
            <Label>Reason</Label>
            <Textarea
              value={cancelReason}
              onChange={(e) => setCancelReason(e.target.value)}
              placeholder="At least 10 characters"
            />
            {cancelError && (
              <p role="alert" className="text-sm font-medium text-destructive">
                {cancelError}
              </p>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCancelRow(null)}>
              Keep
            </Button>
            <Button
              variant="destructive"
              disabled={busyId === cancelRow?.id}
              onClick={() => void cancel()}
            >
              Cancel advance
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={Boolean(editRow)} onOpenChange={(next) => !next && setEditRow(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Edit advance</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1">
              <Label className="text-muted-foreground">Staff ref</Label>
              <p className="text-sm font-medium">{editRow?.staff_ref ?? '—'}</p>
            </div>
            <div className="space-y-1">
              <Label className="text-muted-foreground">Name</Label>
              <p className="text-sm font-medium">{editRow?.staff_name ?? '—'}</p>
            </div>
            <div className="space-y-1">
              <Label className="text-muted-foreground">Principal (UGX)</Label>
              <p className="text-sm font-medium">{editRow ? formatAmount(editRow.principal) : '—'}</p>
            </div>
            <div className="space-y-1">
              <Label>Purpose</Label>
              <Textarea
                value={editPurpose}
                onChange={(e) => setEditPurpose(e.target.value)}
              />
            </div>
            <div className="space-y-1">
              <Label>Recovery period</Label>
              <Select value={editMonths} onValueChange={setEditMonths}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="1">1 month</SelectItem>
                  <SelectItem value="2">2 months</SelectItem>
                  <SelectItem value="3">3 months</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {editMonthly !== null && (
              <p className="text-xs text-muted-foreground">
                Monthly deduction: {formatAmount(editMonthly)} UGX
              </p>
            )}
            <div className="space-y-1">
              <Label>First recovery</Label>
              <Input type="date" value={editFirstOn} onChange={(e) => setEditFirstOn(e.target.value)} />
            </div>
            {editError && (
              <p role="alert" className="text-sm font-medium text-destructive">
                {editError}
              </p>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditRow(null)}>
              Cancel
            </Button>
            <Button
              disabled={!editRow || editPurpose.trim().length === 0 || editSaving}
              onClick={() => void submitEdit()}
            >
              {editSaving && <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />}
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </HRPlaceholderPage>
  );
}