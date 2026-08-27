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
import { listAdvances, requestAdvance, decideAdvance, updateAdvance, type AdvanceRow } from '@/hr/pay/api/advances';
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
  approved: 'bg-green-100 text-green-800',
  rejected: 'bg-muted text-muted-foreground',
  settled: 'bg-blue-100 text-blue-800',
};

export default function Advances() {
  const [rows, setRows] = useState<AdvanceRow[]>([]);
  const [staff, setStaff] = useState<PayrollStaffOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isPreparer, setIsPreparer] = useState(false);
  const [isApprover, setIsApprover] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  // Request dialog
  const [open, setOpen] = useState(false);
  const [staffId, setStaffId] = useState('');
  const [principal, setPrincipal] = useState('');
  const [purpose, setPurpose] = useState('');
  const [mode, setMode] = useState('fixed');
  const [recoveryValue, setRecoveryValue] = useState('');
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
  const [editMode, setEditMode] = useState('fixed');
  const [editRecoveryValue, setEditRecoveryValue] = useState('');
  const [editFirstOn, setEditFirstOn] = useState('');
  const [editError, setEditError] = useState('');
  const [editSaving, setEditSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [advances, authority] = await Promise.all([listAdvances(), myPayrollAuthority()]);
      setRows(advances);
      setIsPreparer(authority.preparer);
      setIsApprover(authority.approver);
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
    setMode('fixed');
    setRecoveryValue('');
    setFirstOn(firstOfNextMonth());
    setFormError('');
  }

  async function submitRequest() {
    const amount = Number(principal);
    const value = Number(recoveryValue);
    if (!staffId) return setFormError('Choose the staff member.');
    if (!Number.isFinite(amount) || amount <= 0) return setFormError('Enter a principal above zero.');
    if (purpose.trim().length < 10) return setFormError('The purpose must be at least 10 characters.');
    if (!Number.isFinite(value) || value <= 0) return setFormError('Enter a recovery value above zero.');
    if (mode === 'percent_of_gross' && value > 100) return setFormError('A percentage cannot exceed 100.');
    if (!firstOn) return setFormError('Choose the first recovery date.');
    setFormError('');
    setSaving(true);
    try {
      await requestAdvance(staffId, amount, purpose.trim(), mode, value, firstOn);
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

  async function approve(row: AdvanceRow) {
    setBusyId(row.id);
    try {
      await decideAdvance(row.id, true, '');
      toast.success('Advance approved.');
      await load();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusyId(null);
    }
  }

  const editInstallmentInfo = useMemo(() => {
    if (!editRow || editMode !== 'fixed') return null;
    const value = Number(editRecoveryValue);
    if (!Number.isFinite(value) || value <= 0) return null;
    const installments = Math.ceil(editRow.principal / value);
    const final = editRow.principal - value * (installments - 1);
    return { installments, final };
  }, [editRow, editMode, editRecoveryValue]);

  async function submitEdit() {
    if (!editRow) return;
    const value = Number(editRecoveryValue);
    if (!Number.isFinite(value) || value <= 0) return;
    if (editPurpose.trim().length === 0) return;
    setEditError('');
    setEditSaving(true);
    try {
      await updateAdvance(editRow.id, {
        purpose: editPurpose.trim(),
        recovery_mode: editMode,
        recovery_value: value,
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

  return (
    <HRPlaceholderPage
      heading="Salary advances"
      subtitle="Raised by HR, approved by the position holding approve authority, recovered automatically from payroll."
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
              {isPreparer && <TableHead />}
              {isApprover && <TableHead />}
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.length === 0 && (
              <TableRow>
                <TableCell colSpan={(isApprover ? 10 : 9) + (isPreparer ? 1 : 0)} className="py-8 text-center text-sm text-muted-foreground">
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
                  {row.recovery_mode === 'fixed'
                    ? `${formatAmount(row.recovery_value)} per month`
                    : `${row.recovery_value}% of gross`}
                </TableCell>
                <TableCell className="text-xs">{formatDate(row.first_recovery_on)}</TableCell>
                <TableCell className="text-right">{formatAmount(row.recovered)}</TableCell>
                <TableCell className="text-right font-medium">{formatAmount(row.outstanding)}</TableCell>
                <TableCell>
                  <span
                    className={`inline-flex rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase ${
                      STATUS_CLASS[row.status] ?? 'bg-muted text-muted-foreground'
                    }`}
                  >
                    {row.status}
                  </span>
                </TableCell>
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
                          setEditMode(row.recovery_mode);
                          setEditRecoveryValue(String(row.recovery_value));
                          setEditFirstOn(row.first_recovery_on);
                          setEditError('');
                        }}
                      >
                        Edit
                      </Button>
                    )}
                  </TableCell>
                )}
                {isApprover && (
                  <TableCell className="whitespace-nowrap text-right">
                    {row.status === 'requested' && (
                      <span className="inline-flex gap-2">
                        <Button
                          size="sm"
                          disabled={busyId === row.id}
                          onClick={() => void approve(row)}
                        >
                          Approve
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
                      </span>
                    )}
                  </TableCell>
                )}
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
              <Label>Recovery mode</Label>
              <Select value={mode} onValueChange={setMode}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="fixed">Fixed monthly amount</SelectItem>
                  <SelectItem value="percent_of_gross">Percent of gross</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label>{mode === 'fixed' ? 'Amount per month (UGX)' : 'Percent of gross'}</Label>
              <Input
                inputMode="numeric"
                value={recoveryValue}
                onChange={(e) => setRecoveryValue(e.target.value)}
              />
            </div>
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
    </HRPlaceholderPage>
  );
}