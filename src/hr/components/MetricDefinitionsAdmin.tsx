import { useEffect, useMemo, useState } from 'react';
import { ArrowDown, ArrowUp, Gauge, Plus } from 'lucide-react';
import { toast } from 'sonner';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { getDepartments, getMetricDefinitions } from '@/hr/api';
import type {
  Department,
  MetricDefinition,
  MetricDirection,
  MetricPeriodType,
  MetricSourceKey,
  MetricUnit,
} from '@/hr/types';

const ALL = '__all__';
const UNIVERSAL = '__universal__';

const UNITS: MetricUnit[] = ['count', 'percent', 'currency_ugx', 'hours', 'days', 'ratio'];
const UNIT_LABELS: Record<MetricUnit, string> = {
  count: 'Count',
  percent: 'Percent',
  currency_ugx: 'Currency (UGX)',
  hours: 'Hours',
  days: 'Days',
  ratio: 'Ratio',
};

const PERIODS: MetricPeriodType[] = ['weekly', 'monthly', 'quarterly'];
const PERIOD_LABELS: Record<MetricPeriodType, string> = {
  weekly: 'Weekly',
  monthly: 'Monthly',
  quarterly: 'Quarterly',
};

const SOURCE_LABELS: Record<MetricDefinition['source'], string> = {
  derived_task: 'Derived from tasks',
  manual_entry: 'Entered manually',
  external_system: 'External system',
};

const BASIS_LABELS: Record<MetricDefinition['target_basis'], string> = {
  target: 'target',
  sla: 'SLA',
  own_trend: 'own trend',
};

function formatTarget(value: number | null, unit: MetricUnit): string {
  if (value === null || value === undefined) return '—';
  switch (unit) {
    case 'percent':
      return `${value}%`;
    case 'hours':
      return `${value} hrs`;
    case 'currency_ugx':
      return `UGX ${value.toLocaleString('en-US')}`;
    case 'days':
      return `${value} days`;
    case 'ratio':
      return value.toFixed(2);
    case 'count':
    default:
      return `${value.toLocaleString('en-US')}`;
  }
}

interface FormState {
  name: string;
  description: string;
  department_id: string;
  unit: MetricUnit;
  direction: MetricDirection;
  target_value: string;
  target_basis: MetricDefinition['target_basis'];
  period_type: MetricPeriodType;
  source: MetricDefinition['source'];
  source_key: MetricSourceKey;
}

const EMPTY_FORM: FormState = {
  name: '',
  description: '',
  department_id: UNIVERSAL,
  unit: 'percent',
  direction: 'higher_is_better',
  target_value: '',
  target_basis: 'target',
  period_type: 'monthly',
  source: 'derived_task',
  source_key: '',
};

export default function MetricDefinitionsAdmin() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [definitions, setDefinitions] = useState<MetricDefinition[]>([]);
  const [departments, setDepartments] = useState<Department[]>([]);
  const [filter, setFilter] = useState<string>(ALL);
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        setLoading(true);
        setError(null);
        const [defs, deps] = await Promise.all([getMetricDefinitions(), getDepartments()]);
        if (!alive) return;
        setDefinitions(defs);
        setDepartments(deps);
      } catch (e) {
        if (alive) setError(e instanceof Error ? e.message : 'Could not load metric definitions');
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  const departmentName = (id: string | null) =>
    departments.find((d) => d.id === id)?.name ?? id ?? '';

  const rows = useMemo(() => {
    if (filter === ALL) return definitions;
    if (filter === UNIVERSAL) return definitions.filter((d) => d.department_id === null);
    return definitions.filter((d) => d.department_id === filter);
  }, [definitions, filter]);

  const setField = <K extends keyof FormState>(key: K, value: FormState[K]) =>
    setForm((prev) => ({ ...prev, [key]: value }));

  const handleSourceChange = (source: MetricDefinition['source']) => {
    setForm((prev) => ({ ...prev, source, source_key: prev.source_key }));
  };

  const handleSave = () => {
    const payload = {
      name: form.name.trim(),
      description: form.description.trim(),
      department_id: form.department_id === UNIVERSAL ? null : form.department_id,
      unit: form.unit,
      direction: form.direction,
      target_value: form.target_value === '' ? null : Number(form.target_value),
      target_basis: form.target_basis,
      period_type: form.period_type,
      source: form.source,
      source_key: form.source_key,
    };
    // eslint-disable-next-line no-console
    console.log('New metric definition', payload);
    toast.success('Metric definition captured');
    setOpen(false);
    setForm(EMPTY_FORM);
  };

  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-primary/20 bg-primary/5 p-3">
        <p className="text-xs text-muted-foreground leading-relaxed">
          Universal metrics are derived automatically from task timestamps and apply to every
          department. Department metrics are configured here. Adding a new department never
          requires a code change.
        </p>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2">
        <Select value={filter} onValueChange={setFilter}>
          <SelectTrigger className="h-9 w-[220px]">
            <SelectValue placeholder="All" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>All</SelectItem>
            <SelectItem value={UNIVERSAL}>Universal only</SelectItem>
            {departments.map((d) => (
              <SelectItem key={d.id} value={d.id}>
                {d.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Button size="sm" onClick={() => setOpen(true)}>
          <Plus className="h-4 w-4 mr-1.5" />
          New metric
        </Button>
      </div>

      <Card>
        <CardContent className="p-0">
          {loading ? (
            <div className="p-4 space-y-2">
              {Array.from({ length: 5 }).map((_, i) => (
                <Skeleton key={i} className="h-10 w-full" />
              ))}
            </div>
          ) : error ? (
            <div className="p-8 text-center">
              <p className="text-sm text-destructive">{error}</p>
            </div>
          ) : rows.length === 0 ? (
            <div className="p-10 text-center">
              <Gauge className="h-8 w-8 mx-auto text-muted-foreground/40" />
              <p className="text-sm font-medium text-foreground mt-2">No metrics yet</p>
              <p className="text-xs text-muted-foreground mt-1">
                Nothing is configured for this filter.
              </p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Name</TableHead>
                    <TableHead>Department</TableHead>
                    <TableHead>Unit</TableHead>
                    <TableHead>Direction</TableHead>
                    <TableHead>Target</TableHead>
                    <TableHead>Period</TableHead>
                    <TableHead>Source</TableHead>
                    <TableHead>Version</TableHead>
                    <TableHead>Active</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((m) => (
                    <TableRow key={m.id}>
                      <TableCell>
                        <div className="font-medium text-foreground">{m.name}</div>
                        <div className="text-xs text-muted-foreground line-clamp-1">
                          {m.description}
                        </div>
                      </TableCell>
                      <TableCell>
                        {m.department_id === null ? (
                          <span className="text-muted-foreground">Universal</span>
                        ) : (
                          departmentName(m.department_id)
                        )}
                      </TableCell>
                      <TableCell>{UNIT_LABELS[m.unit]}</TableCell>
                      <TableCell>
                        <span className="inline-flex items-center gap-1 text-xs">
                          {m.direction === 'higher_is_better' ? (
                            <>
                              <ArrowUp className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400" />
                              higher is better
                            </>
                          ) : (
                            <>
                              <ArrowDown className="h-3.5 w-3.5 text-blue-600 dark:text-blue-400" />
                              lower is better
                            </>
                          )}
                        </span>
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center gap-2">
                          <span className="font-medium">{formatTarget(m.target_value, m.unit)}</span>
                          <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                            {BASIS_LABELS[m.target_basis]}
                          </span>
                        </div>
                      </TableCell>
                      <TableCell>{PERIOD_LABELS[m.period_type]}</TableCell>
                      <TableCell className="text-xs">{SOURCE_LABELS[m.source]}</TableCell>
                      <TableCell>v{m.version}</TableCell>
                      <TableCell>
                        <span
                          className={`inline-block h-2.5 w-2.5 rounded-full ${
                            m.active ? 'bg-emerald-500' : 'bg-muted-foreground/40'
                          }`}
                          aria-label={m.active ? 'Active' : 'Inactive'}
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

      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent side="right" className="w-full sm:max-w-md overflow-y-auto">
          <SheetHeader>
            <SheetTitle>New metric</SheetTitle>
            <SheetDescription>
              Metrics are rows, not code. Any department can be measured without a release.
            </SheetDescription>
          </SheetHeader>

          <div className="space-y-4 py-4">
            <div className="space-y-1.5">
              <Label htmlFor="metric-name">Name</Label>
              <Input
                id="metric-name"
                value={form.name}
                onChange={(e) => setField('name', e.target.value)}
                placeholder="On-time completion rate"
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="metric-desc">Description</Label>
              <Textarea
                id="metric-desc"
                value={form.description}
                onChange={(e) => setField('description', e.target.value)}
                rows={3}
              />
            </div>

            <div className="space-y-1.5">
              <Label>Department</Label>
              <Select
                value={form.department_id}
                onValueChange={(v) => setField('department_id', v)}
              >
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value={UNIVERSAL}>Universal</SelectItem>
                  {departments.map((d) => (
                    <SelectItem key={d.id} value={d.id}>{d.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label>Unit</Label>
                <Select value={form.unit} onValueChange={(v) => setField('unit', v as MetricUnit)}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {UNITS.map((u) => (
                      <SelectItem key={u} value={u}>{UNIT_LABELS[u]}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label>Direction</Label>
                <Select
                  value={form.direction}
                  onValueChange={(v) => setField('direction', v as MetricDirection)}
                >
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="higher_is_better">Higher is better</SelectItem>
                    <SelectItem value="lower_is_better">Lower is better</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="metric-target">Target value</Label>
              <Input
                id="metric-target"
                type="number"
                value={form.target_value}
                onChange={(e) => setField('target_value', e.target.value)}
                placeholder="Leave blank for no target"
              />
            </div>

            <div className="space-y-1.5">
              <Label>Target basis</Label>
              <Select
                value={form.target_basis}
                onValueChange={(v) => setField('target_basis', v as FormState['target_basis'])}
              >
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="target">Target</SelectItem>
                  <SelectItem value="sla">SLA</SelectItem>
                  <SelectItem value="own_trend">Own trend</SelectItem>
                </SelectContent>
              </Select>
              <p className="text-[11px] text-muted-foreground leading-relaxed">
                A target must be a stated target, an SLA, or a change in a person's own trend. Do
                not use team averages — half of any team is below average by definition.
              </p>
            </div>

            <div className="space-y-1.5">
              <Label>Period type</Label>
              <Select
                value={form.period_type}
                onValueChange={(v) => setField('period_type', v as MetricPeriodType)}
              >
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {PERIODS.map((p) => (
                    <SelectItem key={p} value={p}>{PERIOD_LABELS[p]}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1.5">
              <Label>Source</Label>
              <Select
                value={form.source}
                onValueChange={(v) => handleSourceChange(v as MetricDefinition['source'])}
              >
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="derived_task">Derived from tasks</SelectItem>
                  <SelectItem value="manual_entry">Entered manually</SelectItem>
                  <SelectItem value="external_system">External system</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {form.source === 'derived_task' && (
              <div className="space-y-1.5">
                <Label>Source key</Label>
                <Input
                  value={form.source_key}
                  placeholder="Machine key for this metric"
                  onChange={(e) => setField('source_key', e.target.value as MetricSourceKey)}
                />
              </div>
            )}

            <div className="flex justify-end gap-2 pt-2">
              <Button variant="outline" size="sm" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button size="sm" onClick={handleSave} disabled={!form.name.trim()}>
                Save
              </Button>
            </div>
          </div>
        </SheetContent>
      </Sheet>
    </div>
  );
}
