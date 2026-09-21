/**
 * Staff-facing salary advance card for My Space.
 * Requests go through requestOwnAdvance; the approval chain and all
 * actor/timestamp stamping are enforced by the database, never here.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
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
import { listAdvances, requestOwnAdvance, type AdvanceRow } from '@/hr/pay/api/advances';

const STAGE_LABEL: Record<string, string> = {
  requested: 'Awaiting HR',
  hr_approved: 'Awaiting CEO',
  ceo_approved: 'Awaiting CFO',
  approved: 'Disbursed, recovering',
  settled: 'Settled',
  rejected: 'Rejected',
  cancelled: 'Cancelled',
};

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

export default function MyAdvanceCard({ staffId }: { staffId: string }) {
  const [rows, setRows] = useState<AdvanceRow[]>([]);
  const [loading, setLoading] = useState(true);

  const [open, setOpen] = useState(false);
  const [amount, setAmount] = useState('');
  const [purpose, setPurpose] = useState('');
  const [months, setMonths] = useState('');
  const [firstOn, setFirstOn] = useState(firstOfNextMonth());
  const [formError, setFormError] = useState('');
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const all = await listAdvances();
      setRows(all.filter((r) => r.staff_id === staffId));
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [staffId]);

  useEffect(() => {
    void load();
  }, [load]);

  const monthlyDeduction = useMemo(() => {
    const principal = Number(amount);
    const m = Number(months);
    if (!Number.isFinite(principal) || principal <= 0 || !Number.isInteger(m) || m < 1 || m > 3) {
      return null;
    }
    return Math.ceil(principal / m);
  }, [amount, months]);

  function resetForm() {
    setAmount('');
    setPurpose('');
    setMonths('');
    setFirstOn(firstOfNextMonth());
    setFormError('');
  }

  async function submit() {
    const principal = Number(amount);
    const m = Number(months);
    if (!Number.isFinite(principal) || principal <= 0) {
      return setFormError('Enter an amount above zero.');
    }
    if (purpose.trim().length < 10) {
      return setFormError('The purpose must be at least 10 characters.');
    }
    if (!Number.isInteger(m) || m < 1 || m > 3) {
      return setFormError('Choose a recovery period.');
    }
    if (!firstOn) return setFormError('Choose the first recovery date.');
    setFormError('');
    setSaving(true);
    try {
      await requestOwnAdvance(principal, purpose.trim(), m, firstOn);
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

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm">Salary advance</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="hidden">
          <Button onClick={() => setOpen(true)}>Request advance</Button>
        </div>

        {loading ? (
          <p className="text-sm text-muted-foreground">
            <Loader2 className="mr-1 inline h-3.5 w-3.5 animate-spin" />
            Loading…
          </p>
        ) : rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">You have no salary advances.</p>
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Stage</TableHead>
                  <TableHead className="text-right">Principal</TableHead>
                  <TableHead className="text-right">Monthly deduction</TableHead>
                  <TableHead className="text-right">Deducted so far</TableHead>
                  <TableHead className="text-right">Still pending</TableHead>
                  <TableHead>First recovery</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((row) => (
                  <TableRow key={row.id}>
                    <TableCell className="text-xs">
                      {STAGE_LABEL[row.status] ?? '—'}
                    </TableCell>
                    <TableCell className="text-right">{formatAmount(row.principal)}</TableCell>
                    <TableCell className="text-right">{formatAmount(row.recovery_value)}</TableCell>
                    <TableCell className="text-right">{formatAmount(row.recovered)}</TableCell>
                    <TableCell className="text-right font-medium">
                      {formatAmount(row.outstanding)}
                    </TableCell>
                    <TableCell className="text-xs">{formatDate(row.first_recovery_on)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>

      <Dialog open={open} onOpenChange={(next) => (next ? setOpen(true) : (setOpen(false), resetForm()))}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Request a salary advance</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1">
              <Label>Amount (UGX)</Label>
              <Input
                inputMode="numeric"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
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
                  <SelectValue placeholder="Choose a period" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="1">1 month</SelectItem>
                  <SelectItem value="2">2 months</SelectItem>
                  <SelectItem value="3">3 months</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {monthlyDeduction !== null && (
              <p className="text-sm text-muted-foreground">
                Monthly deduction: UGX {formatAmount(monthlyDeduction)}
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
            <Button disabled={saving} onClick={() => void submit()}>
              {saving && <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />}
              Request
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
