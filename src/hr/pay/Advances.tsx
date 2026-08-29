import { useCallback, useEffect, useMemo, useState } from 'react';
import { ChevronRight, Loader2, User } from 'lucide-react';
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
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
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

/** Display-only reference derived from the advance id. Not stored anywhere. */
function advanceRef(id: string): string {
  return `ADV-${id.replace(/-/g, '').slice(0, 8).toUpperCase()}`;
}

const STATUS_CLASS: Record<string, string> = {
  requested: 'bg-amber-100 text-amber-800',
  approved: 'bg-green-100 text-green-800',
  rejected: 'bg-muted text-muted-foreground',
  settled: 'bg-blue-100 text-blue-800',
};

const STATUS_LABEL: Record<string, string> = {
  requested: 'Requested',
  approved: 'Approved',
  rejected: 'Rejected',
  settled: 'Settled',
};

function Kpi({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-border p-3">
      <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">{label}</p>
      <p className="mt-0.5 font-mono text-sm font-semibold text-foreground">{value}</p>
    </div>
  );
}

export default function Advances() {
  const [rows, setRows] = useState<AdvanceRow[]>([]);
  const [staff, setStaff] = useState<PayrollStaffOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isPreparer, setIsPreparer] = useState(false);
  const [isApprover, setIsApprover] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  // Details sheet
  const [detailRow, setDetailRow] = useState<AdvanceRow | null>(null);

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

  // Load the staff directory for every viewer (not just preparers) so the table
  // can show the Department column and a reliable requester name. Failure is
  // non-fatal: the department column falls back to a dash.
  useEffect(() => {
    if (staff.length > 0) return;
    listStaffForPayroll()
      .then(setStaff)
      .catch(() => {
        /* department column falls back to '—' */
      });
  }, [staff.length]);

  const staffLabel = useMemo(() => {
    const map = new Map<string, string>();
    staff.forEach((s) => map.set(s.staffId, s.name));
    return map;
  }, [staff]);

  const staffDepartment = useMemo(() => {
    const map = new Map<string, string>();
    staff.forEach((s) => map.set(s.staffId, s.department));
    return map;
  }, [staff]);

  const requesterName = useCallback(
    (row: AdvanceRow) => row.staff_name ?? staffLabel.get(row.staff_id) ?? '—',
    [staffLabel],
  );

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
      setDetailRow(null);
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

  function openEdit(row: AdvanceRow) {
    setEditRow(row);
    setEditPurpose(row.purpose);
    setEditMode(row.recovery_mode);
    setEditRecoveryValue(String(row.recovery_value));
    setEditFirstOn(row.first_recovery_on);
    setEditError('');
  }

  function openReject(row: AdvanceRow) {
    setRejectRow(row);
    setRejectNote('');
    setRejectError('');
  }

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
      setDetailRow(null);
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
        <div className="flex items-center gap-2 py-2 text-xs text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading advance requests…
        </div>
      )}
      {error && (
        <p role="alert" className="text-sm font-medium text-destructive">
          {error}
        </p>
      )}

      {!loading && !error && rows.length === 0 && (
        <div className="rounded-lg border border-dashed border-border bg-muted/30 p-6 text-center">
          <p className="text-sm text-muted-foreground">No salary advances recorded.</p>
        </div>
      )}

      {!loading && !error && rows.length > 0 && (
        <div className="overflow-x-auto rounded-lg border border-border">
          <Table>
            <TableHeader>
              <TableRow className="bg-muted/50 hover:bg-muted/50">
                <TableHead className="h-9 text-[11px] uppercase tracking-wider">Requester</TableHead>
                <TableHead className="h-9 text-[11px] uppercase tracking-wider">Department</TableHead>
                <TableHead className="h-9 text-[11px] uppercase tracking-wider">Advance Reference</TableHead>
                <TableHead className="h-9 text-[11px] uppercase tracking-wider">Purpose</TableHead>
                <TableHead className="h-9 text-right text-[11px] uppercase tracking-wider">Amount (UGX)</TableHead>
                <TableHead className="h-9 whitespace-nowrap text-[11px] uppercase tracking-wider">Required Date</TableHead>
                <TableHead className="h-9 whitespace-nowrap text-[11px] uppercase tracking-wider">Submitted Date</TableHead>
                <TableHead className="h-9 text-[11px] uppercase tracking-wider">Status</TableHead>
                <TableHead className="h-9 text-right text-[11px] uppercase tracking-wider">Action</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => (
                <TableRow
                  key={row.id}
                  role="button"
                  tabIndex={0}
                  className="cursor-pointer border-border/60"
                  onClick={() => setDetailRow(row)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      setDetailRow(row);
                    }
                  }}
                >
                  <TableCell className="py-2.5">
                    <div className="flex items-center gap-2">
                      <User className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium text-foreground">{requesterName(row)}</p>
                        <p className="font-mono text-[11px] text-muted-foreground">{row.staff_ref ?? '—'}</p>
                      </div>
                    </div>
                  </TableCell>
                  <TableCell className="max-w-[160px] truncate py-2.5 text-sm text-muted-foreground">
                    {staffDepartment.get(row.staff_id) || '—'}
                  </TableCell>
                  <TableCell className="whitespace-nowrap py-2.5 font-mono text-xs text-muted-foreground">
                    {advanceRef(row.id)}
                  </TableCell>
                  <TableCell className="max-w-[220px] truncate py-2.5 text-sm text-muted-foreground">
                    {row.purpose}
                  </TableCell>
                  <TableCell className="whitespace-nowrap py-2.5 text-right font-mono text-sm font-semibold tabular-nums text-foreground">
                    {formatAmount(row.principal)}
                  </TableCell>
                  <TableCell className="whitespace-nowrap py-2.5 text-sm text-muted-foreground">
                    {formatDate(row.first_recovery_on)}
                  </TableCell>
                  <TableCell className="whitespace-nowrap py-2.5 text-sm text-muted-foreground">
                    {formatDate(row.requested_at)}
                  </TableCell>
                  <TableCell className="py-2.5">
                    <span
                      className={`inline-flex rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase ${
                        STATUS_CLASS[row.status] ?? 'bg-muted text-muted-foreground'
                      }`}
                    >
                      {STATUS_LABEL[row.status] ?? row.status}
                    </span>
                  </TableCell>
                  <TableCell className="py-2.5 text-right">
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-7 gap-1 px-2 text-[11px]"
                      onClick={(e) => {
                        e.stopPropagation();
                        setDetailRow(row);
                      }}
                    >
                      Review <ChevronRight className="h-3.5 w-3.5" />
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      <Sheet open={Boolean(detailRow)} onOpenChange={(next) => !next && setDetailRow(null)}>
        <SheetContent side="center" className="flex max-h-[90vh] w-[95vw] flex-col sm:max-w-2xl">
          {detailRow && (
            <>
              <SheetHeader>
                <SheetTitle className="pr-6 text-base">Advance Details</SheetTitle>
                <SheetDescription>
                  {requesterName(detailRow)} · {advanceRef(detailRow.id)} · UGX {formatAmount(detailRow.principal)}
                </SheetDescription>
              </SheetHeader>

              <div className="mt-2 flex-1 space-y-5 overflow-y-auto pr-1">
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                  <Kpi label="Requester" value={requesterName(detailRow)} />
                  <Kpi label="Staff ref" value={detailRow.staff_ref ?? '—'} />
                  <Kpi label="Department" value={staffDepartment.get(detailRow.staff_id) || '—'} />
                  <Kpi label="Advance reference" value={advanceRef(detailRow.id)} />
                  <Kpi label="Amount (UGX)" value={formatAmount(detailRow.principal)} />
                  <Kpi label="Required date" value={formatDate(detailRow.first_recovery_on)} />
                  <Kpi label="Submitted" value={formatDate(detailRow.requested_at)} />
                  <Kpi label="Currency" value={detailRow.currency} />
                  <div className="rounded-lg border border-border p-3">
                    <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Status</p>
                    <p className="mt-1">
                      <span
                        className={`inline-flex rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase ${
                          STATUS_CLASS[detailRow.status] ?? 'bg-muted text-muted-foreground'
                        }`}
                      >
                        {STATUS_LABEL[detailRow.status] ?? detailRow.status}
                      </span>
                    </p>
                  </div>
                </div>

                <div className="space-y-1.5">
                  <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Purpose / Justification</p>
                  <p className="whitespace-pre-wrap rounded-lg border border-border bg-muted/30 p-3 text-sm leading-relaxed text-foreground">
                    {detailRow.purpose}
                  </p>
                </div>

                <div className="space-y-1.5">
                  <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Recovery plan</p>
                  <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                    <Kpi
                      label="Recovery mode"
                      value={detailRow.recovery_mode === 'fixed' ? 'Fixed monthly' : 'Percent of gross'}
                    />
                    <Kpi
                      label={detailRow.recovery_mode === 'fixed' ? 'Per month (UGX)' : 'Percent of gross'}
                      value={
                        detailRow.recovery_mode === 'fixed'
                          ? formatAmount(detailRow.recovery_value)
                          : `${detailRow.recovery_value}%`
                      }
                    />
                    <Kpi label="First recovery" value={formatDate(detailRow.first_recovery_on)} />
                    <Kpi label="Recovered so far (UGX)" value={formatAmount(detailRow.recovered)} />
                    <Kpi label="Outstanding (UGX)" value={formatAmount(detailRow.outstanding)} />
                  </div>
                </div>

                {detailRow.decision_note && (
                  <div className="space-y-1.5">
                    <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Decision note</p>
                    <p className="whitespace-pre-wrap rounded-lg border border-border bg-muted/30 p-3 text-sm leading-relaxed text-foreground">
                      {detailRow.decision_note}
                    </p>
                  </div>
                )}
              </div>

              {detailRow.status === 'requested' && (isApprover || isPreparer) && (
                <div className="mt-4 flex flex-wrap justify-end gap-2 border-t border-border pt-4">
                  {isPreparer && (
                    <Button
                      variant="outline"
                      disabled={busyId === detailRow.id}
                      onClick={() => {
                        const row = detailRow;
                        setDetailRow(null);
                        openEdit(row);
                      }}
                    >
                      Edit
                    </Button>
                  )}
                  {isApprover && (
                    <>
                      <Button
                        variant="outline"
                        disabled={busyId === detailRow.id}
                        onClick={() => openReject(detailRow)}
                      >
                        Reject
                      </Button>
                      <Button
                        disabled={busyId === detailRow.id}
                        onClick={() => void approve(detailRow)}
                      >
                        {busyId === detailRow.id && <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />}
                        Approve
                      </Button>
                    </>
                  )}
                </div>
              )}
            </>
          )}
        </SheetContent>
      </Sheet>

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
              <Label>Recovery mode</Label>
              <Select value={editMode} onValueChange={setEditMode}>
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
              <Label>{editMode === 'fixed' ? 'Amount per month (UGX)' : 'Percent of gross'}</Label>
              <Input
                inputMode="numeric"
                value={editRecoveryValue}
                onChange={(e) => setEditRecoveryValue(e.target.value)}
              />
            </div>
            {editInstallmentInfo && (
              <p className="text-xs text-muted-foreground">
                {editInstallmentInfo.installments} installments; final installment{' '}
                {formatAmount(editInstallmentInfo.final)} UGX
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
              disabled={
                !editRow ||
                Number(editRecoveryValue) <= 0 ||
                editPurpose.trim().length === 0 ||
                editSaving
              }
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
