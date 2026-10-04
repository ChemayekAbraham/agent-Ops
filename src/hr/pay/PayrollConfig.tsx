import { useCallback, useEffect, useState } from 'react';
import { Check, Loader2, Minus, Plus } from 'lucide-react';
import { toast } from 'sonner';
import HRPlaceholderPage from '@/hr/pages/HRPlaceholderPage';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
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
  createGrade,
  listComponents,
  listGrades,
  setComponentActive,
  type PayComponentRow,
  type PayGradeRow,
} from '@/hr/pay/api/config';
import { supabase } from '@/integrations/supabase/client';

/** Whole-shilling display with thousands separators. */
function formatAmount(value: number | string): string {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return '—';
  return new Intl.NumberFormat('en-UG', { maximumFractionDigits: 0 }).format(numeric);
}

type ScheduleRow = {
  id: string;
  day_of_month: number;
  auto_prepare: boolean;
  auto_notify: boolean;
  enabled: boolean;
  last_run_at: string | null;
  last_run_note: string | null;
};

/** Days 29 to 31 do not exist in every month, so the selector stops at 28. */
const SCHEDULE_DAYS = Array.from({ length: 28 }, (_, i) => i + 1);

function PayrollScheduleSection() {
  const [row, setRow] = useState<ScheduleRow | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    const { data, error } = await supabase
      .from('hr_pay_schedule')
      .select('id, day_of_month, auto_prepare, auto_notify, enabled, last_run_at, last_run_note')
      .limit(1)
      .maybeSingle();
    if (error) toast.error(error.message);
    else setRow((data as ScheduleRow) ?? null);
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const patch = async (changes: Partial<ScheduleRow>) => {
    if (!row) return;
    setSaving(true);
    const previous = row;
    setRow({ ...row, ...changes });
    const { error } = await supabase.from('hr_pay_schedule').update(changes).eq('id', row.id);
    if (error) {
      setRow(previous);
      toast.error(error.message);
    } else {
      toast.success('Payroll schedule updated');
    }
    setSaving(false);
  };

  return (
    <Card>
      <CardHeader className="space-y-1">
        <CardTitle className="text-base">Payroll schedule</CardTitle>
        <p className="text-xs text-muted-foreground">
          Automatic preparation. Payment is always released by a person.
        </p>
      </CardHeader>
      <CardContent className="space-y-4">
        {loading ? (
          <div className="flex justify-center py-6">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : !row ? (
          <p className="py-4 text-center text-xs text-muted-foreground">
            No schedule row is configured yet.
          </p>
        ) : (
          <>
            <div className="space-y-1">
              <Label htmlFor="schedule-day">Day of month</Label>
              <Select
                value={String(row.day_of_month)}
                onValueChange={(v) => void patch({ day_of_month: Number(v) })}
                disabled={saving}
              >
                <SelectTrigger id="schedule-day" className="w-32">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {SCHEDULE_DAYS.map((d) => (
                    <SelectItem key={d} value={String(d)}>
                      {d}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                Days 29 to 31 do not exist in every month.
              </p>
            </div>

            <div className="space-y-3 border-t pt-3">
              <div className="flex items-center justify-between gap-3">
                <Label htmlFor="schedule-enabled" className="text-sm font-medium">
                  Scheduler enabled
                </Label>
                <Switch
                  id="schedule-enabled"
                  checked={row.enabled}
                  disabled={saving}
                  onCheckedChange={(next) => void patch({ enabled: next })}
                />
              </div>
              <div className="flex items-center justify-between gap-3">
                <Label htmlFor="schedule-prepare" className="text-sm">
                  Prepare the period and run automatically
                </Label>
                <Switch
                  id="schedule-prepare"
                  checked={row.auto_prepare}
                  disabled={saving}
                  onCheckedChange={(next) => void patch({ auto_prepare: next })}
                />
              </div>
              <div className="flex items-center justify-between gap-3">
                <Label htmlFor="schedule-notify" className="text-sm">
                  Notify when a run is opened
                </Label>
                <Switch
                  id="schedule-notify"
                  checked={row.auto_notify}
                  disabled={saving}
                  onCheckedChange={(next) => void patch({ auto_notify: next })}
                />
              </div>
            </div>

            <div className="space-y-1 border-t pt-3 text-xs text-muted-foreground">
              <p>
                Last run:{' '}
                {row.last_run_at ? new Date(row.last_run_at).toLocaleString('en-UG') : 'Never run'}
              </p>
              <p>Last note: {row.last_run_note ?? 'No note recorded'}</p>
            </div>

            <p className="rounded-md bg-muted p-3 text-xs">
              The scheduler prepares and opens the run. It never releases payment. The position
              holding release authority must always confirm a payment before money moves.
            </p>
          </>
        )}
      </CardContent>
    </Card>
  );
}

function BoolCell({ value }: { value: boolean }) {
  return value ? (
    <Check className="h-4 w-4 text-primary" aria-label="Yes" />
  ) : (
    <Minus className="h-4 w-4 text-muted-foreground" aria-label="No" />
  );
}

function AddGradeDialog({ onCreated }: { onCreated: (row: PayGradeRow) => void }) {
  const [open, setOpen] = useState(false);
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [bandMin, setBandMin] = useState('');
  const [bandMax, setBandMax] = useState('');
  const [currency, setCurrency] = useState('UGX');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const reset = () => {
    setCode('');
    setName('');
    setBandMin('');
    setBandMax('');
    setCurrency('UGX');
    setError(null);
  };

  const save = async () => {
    const min = Number(bandMin);
    const max = Number(bandMax);
    if (!code.trim() || !name.trim()) {
      setError('Code and name are both required.');
      return;
    }
    if (!Number.isFinite(min) || !Number.isFinite(max)) {
      setError('Band minimum and band maximum must both be numbers.');
      return;
    }
    if (!(max > min)) {
      setError('Band maximum must be greater than band minimum.');
      return;
    }
    setError(null);
    setSaving(true);
    try {
      const row = await createGrade({
        code: code.trim(),
        name: name.trim(),
        bandMin: min,
        bandMax: max,
        currency: currency.trim() || 'UGX',
      });
      onCreated(row);
      toast.success(`Grade ${row.code} added`);
      setOpen(false);
      reset();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) reset();
      }}
    >
      <DialogTrigger asChild>
        <Button size="sm" variant="outline">
          <Plus className="mr-1 h-3.5 w-3.5" />
          Add grade
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Add salary grade</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1">
            <Label htmlFor="grade-code">Code</Label>
            <Input id="grade-code" value={code} onChange={(e) => setCode(e.target.value)} />
          </div>
          <div className="space-y-1">
            <Label htmlFor="grade-name">Name</Label>
            <Input id="grade-name" value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label htmlFor="grade-min">Band minimum</Label>
              <Input
                id="grade-min"
                inputMode="numeric"
                value={bandMin}
                onChange={(e) => setBandMin(e.target.value)}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="grade-max">Band maximum</Label>
              <Input
                id="grade-max"
                inputMode="numeric"
                value={bandMax}
                onChange={(e) => setBandMax(e.target.value)}
              />
            </div>
          </div>
          <div className="space-y-1">
            <Label htmlFor="grade-currency">Currency</Label>
            <Input
              id="grade-currency"
              value={currency}
              onChange={(e) => setCurrency(e.target.value)}
            />
          </div>
          {error && (
            <p role="alert" className="text-xs font-medium text-destructive">
              {error}
            </p>
          )}
        </div>
        <DialogFooter>
          <Button size="sm" onClick={save} disabled={saving}>
            {saving && <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />}
            Save grade
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default function PayrollConfig() {
  const [grades, setGrades] = useState<PayGradeRow[]>([]);
  const [components, setComponents] = useState<PayComponentRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [pendingId, setPendingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [g, c] = await Promise.all([listGrades(), listComponents()]);
      setGrades(g);
      setComponents(c);
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const toggleComponent = async (row: PayComponentRow, next: boolean) => {
    setPendingId(row.id);
    try {
      await setComponentActive(row.id, next);
      const fresh = await listComponents();
      setComponents(fresh);
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setPendingId(null);
    }
  };

  return (
    <HRPlaceholderPage
      heading="Payroll configuration"
      subtitle="Grades and salary components. No employee data on this screen."
    >
      <Card>
        <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0">
          <CardTitle className="text-base">Salary grades</CardTitle>
          <AddGradeDialog onCreated={() => void load()} />
        </CardHeader>
        <CardContent>
          {loading ? (
            <div className="flex justify-center py-6">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          ) : grades.length === 0 ? (
            <p className="py-6 text-center text-xs text-muted-foreground">
              No grades yet. Add the first one to define salary bands.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Code</TableHead>
                    <TableHead>Name</TableHead>
                    <TableHead className="text-right">Band minimum</TableHead>
                    <TableHead className="text-right">Band maximum</TableHead>
                    <TableHead>Currency</TableHead>
                    <TableHead>Active</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {grades.map((g) => (
                    <TableRow key={g.id}>
                      <TableCell className="font-medium">{g.code}</TableCell>
                      <TableCell>{g.name}</TableCell>
                      <TableCell className="text-right tabular-nums">{formatAmount(g.band_min)}</TableCell>
                      <TableCell className="text-right tabular-nums">{formatAmount(g.band_max)}</TableCell>
                      <TableCell>{g.currency}</TableCell>
                      <TableCell>
                        <BoolCell value={g.active} />
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="space-y-1">
          <CardTitle className="text-base">Salary components</CardTitle>
          <p className="text-xs text-muted-foreground">
            Components are never deleted. Deactivate instead, so historic payslips still resolve.
          </p>
        </CardHeader>
        <CardContent>
          {loading ? (
            <div className="flex justify-center py-6">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Code</TableHead>
                    <TableHead>Name</TableHead>
                    <TableHead>Kind</TableHead>
                    <TableHead>Taxable</TableHead>
                    <TableHead>NSSF-able</TableHead>
                    <TableHead>LST-able</TableHead>
                    <TableHead>Statutory</TableHead>
                    <TableHead>Active</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {components.map((c) => (
                    <TableRow key={c.id}>
                      <TableCell className="font-medium">{c.code}</TableCell>
                      <TableCell>{c.name}</TableCell>
                      {c.is_statutory ? (
                        <>
                          <TableCell className="text-muted-foreground">{c.kind}</TableCell>
                          <TableCell className="text-muted-foreground">
                            {c.taxable ? 'Yes' : 'No'}
                          </TableCell>
                          <TableCell className="text-muted-foreground">
                            {c.nssf_able ? 'Yes' : 'No'}
                          </TableCell>
                          <TableCell className="text-muted-foreground">
                            {c.lst_able ? 'Yes' : 'No'}
                          </TableCell>
                        </>
                      ) : (
                        <>
                          <TableCell>{c.kind}</TableCell>
                          <TableCell>
                            <BoolCell value={c.taxable} />
                          </TableCell>
                          <TableCell>
                            <BoolCell value={c.nssf_able} />
                          </TableCell>
                          <TableCell>
                            <BoolCell value={c.lst_able} />
                          </TableCell>
                        </>
                      )}
                      <TableCell>
                        <BoolCell value={c.is_statutory} />
                      </TableCell>
                      <TableCell>
                        <Switch
                          checked={c.active}
                          disabled={pendingId === c.id}
                          onCheckedChange={(next) => void toggleComponent(c, next)}
                          aria-label={`Toggle ${c.code}`}
                        />
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      <PayrollScheduleSection />
    </HRPlaceholderPage>
  );
}