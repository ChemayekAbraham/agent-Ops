import { useMemo, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ArrowLeft, AlertTriangle, Loader2, X } from 'lucide-react';
import { formatUGX } from '@/lib/rentCalculations';
import { format } from 'date-fns';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Checkbox } from '@/components/ui/checkbox';

interface Entry {
  id: string;
  created_at: string;
  classification: string | null;
  category: string;
  direction: string;
  amount: number;
  description: string | null;
  transaction_group_id: string | null;
  linked_party: string | null;
}
interface DetailPayload {
  profile: {
    id: string;
    full_name: string | null;
    phone: string | null;
    cached_withdrawable: number | null;
    cached_float: number | null;
    cached_advance: number | null;
    cached_total: number | null;
  } | null;
  summary: {
    window_days: number;
    since: string;
    admin_net: number;
    admin_abs: number;
    admin_count: number;
    production_net: number;
    production_abs: number;
    production_count: number;
    strict_withdrawable: number;
  };
  entries: Entry[];
}

function signed(e: Entry): number {
  const positive = e.direction === 'cash_in' || e.direction === 'credit';
  return positive ? Number(e.amount) : -Number(e.amount);
}

function EntryTable({ entries, emptyLabel }: { entries: Entry[]; emptyLabel: string }) {
  if (entries.length === 0) {
    return <div className="p-4 text-center text-xs text-muted-foreground border rounded-md">{emptyLabel}</div>;
  }
  return (
    <div className="overflow-x-auto rounded-md border">
      <table className="w-full text-xs">
        <thead className="bg-muted/40 text-left">
          <tr>
            <th className="p-2">When</th>
            <th className="p-2">Category</th>
            <th className="p-2">Direction</th>
            <th className="p-2 text-right">Amount</th>
            <th className="p-2 text-right">Signed</th>
            <th className="p-2">Description</th>
          </tr>
        </thead>
        <tbody>
          {entries.map((e) => {
            const s = signed(e);
            return (
              <tr key={e.id} className="border-t align-top">
                <td className="p-2 whitespace-nowrap text-muted-foreground">
                  {format(new Date(e.created_at), 'MMM d HH:mm')}
                </td>
                <td className="p-2 font-mono">{e.category}</td>
                <td className="p-2">{e.direction}</td>
                <td className="p-2 text-right tabular-nums">{formatUGX(Number(e.amount))}</td>
                <td className={`p-2 text-right tabular-nums ${s < 0 ? 'text-destructive' : 'text-emerald-700'}`}>
                  {s < 0 ? '−' : '+'}
                  {formatUGX(Math.abs(s))}
                </td>
                <td className="p-2 max-w-[420px] truncate" title={e.description ?? ''}>
                  {e.description ?? '—'}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export default function PhantomDriftDetailPage() {
  const { userId = '' } = useParams<{ userId: string }>();
  const [params] = useSearchParams();
  const windowDays = Math.max(1, Number(params.get('window') ?? 30) || 30);

  const { data, isLoading, error } = useQuery({
    queryKey: ['phantom-drift-detail', userId, windowDays],
    queryFn: async (): Promise<DetailPayload> => {
      const { data, error } = await supabase.rpc('get_phantom_correction_drift_detail', {
        p_user_id: userId,
        p_window_days: windowDays,
      });
      if (error) throw error;
      return data as unknown as DetailPayload;
    },
    enabled: !!userId,
    staleTime: 30_000,
  });

  const admin = useMemo(() => (data?.entries ?? []).filter((e) => e.classification === 'admin_correction'), [data]);
  const production = useMemo(() => (data?.entries ?? []).filter((e) => e.classification !== 'admin_correction'), [data]);

  // ---- Filters (presentation only; narrow within the fetched window) ----
  const sinceISO = data?.summary?.since ?? null;
  const windowStart = sinceISO ? format(new Date(sinceISO), 'yyyy-MM-dd') : '';
  const today = format(new Date(), 'yyyy-MM-dd');

  const [fromDate, setFromDate] = useState<string>('');
  const [toDate, setToDate] = useState<string>('');
  const [adminCats, setAdminCats] = useState<string[]>([]);
  const [prodCats, setProdCats] = useState<string[]>([]);

  const adminCategories = useMemo(
    () => Array.from(new Set(admin.map((e) => e.category))).sort(),
    [admin],
  );
  const prodCategories = useMemo(
    () => Array.from(new Set(production.map((e) => e.category))).sort(),
    [production],
  );

  const inDateRange = (e: Entry) => {
    const t = new Date(e.created_at).getTime();
    if (fromDate && t < new Date(fromDate + 'T00:00:00').getTime()) return false;
    if (toDate && t > new Date(toDate + 'T23:59:59').getTime()) return false;
    return true;
  };

  const adminFiltered = useMemo(
    () => admin.filter((e) => inDateRange(e) && (adminCats.length === 0 || adminCats.includes(e.category))),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [admin, adminCats, fromDate, toDate],
  );
  const productionFiltered = useMemo(
    () => production.filter((e) => inDateRange(e) && (prodCats.length === 0 || prodCats.includes(e.category))),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [production, prodCats, fromDate, toDate],
  );

  const filtersActive = !!fromDate || !!toDate || adminCats.length > 0 || prodCats.length > 0;
  const resetFilters = () => {
    setFromDate('');
    setToDate('');
    setAdminCats([]);
    setProdCats([]);
  };

  return (
    <div className="max-w-6xl mx-auto p-4 space-y-4">
      <Button asChild variant="ghost" size="sm">
        <Link to="/cfo/dashboard">
          <ArrowLeft className="h-4 w-4 mr-1" /> Back to CFO Dashboard
        </Link>
      </Button>

      <Card className="border-amber-500/30">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <AlertTriangle className="h-4 w-4 text-amber-600" />
            Phantom Drift Drill-down
          </CardTitle>
          {data?.profile && (
            <p className="text-sm">
              <span className="font-medium">{data.profile.full_name || '—'}</span>{' '}
              <span className="text-muted-foreground">{data.profile.phone}</span>{' '}
              <span className="font-mono text-[11px] text-muted-foreground">{data.profile.id.slice(0, 8)}…</span>
            </p>
          )}
        </CardHeader>
        <CardContent>
          {isLoading && (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" /> Loading drill-down…
            </div>
          )}
          {error && (
            <div className="text-sm text-destructive">{(error as Error).message}</div>
          )}
          {data?.summary && (
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-xs">
              <div className="rounded-md border p-3">
                <div className="text-muted-foreground">Window</div>
                <div className="text-sm font-semibold">{data.summary.window_days} days</div>
                <div className="text-[10px] text-muted-foreground">
                  since {format(new Date(data.summary.since), 'MMM d')}
                </div>
              </div>
              <div className="rounded-md border p-3">
                <div className="text-muted-foreground">Admin / system net</div>
                <div className="text-sm font-semibold text-emerald-700">{formatUGX(data.summary.admin_net)}</div>
                <div className="text-[10px] text-muted-foreground">
                  |Σ| {formatUGX(data.summary.admin_abs)} · {data.summary.admin_count} entries
                </div>
              </div>
              <div className="rounded-md border p-3">
                <div className="text-muted-foreground">Production net</div>
                <div
                  className={`text-sm font-semibold ${data.summary.production_net < 0 ? 'text-destructive' : ''}`}
                >
                  {formatUGX(data.summary.production_net)}
                </div>
                <div className="text-[10px] text-muted-foreground">
                  |Σ| {formatUGX(data.summary.production_abs)} · {data.summary.production_count} entries
                </div>
              </div>
              <div className="rounded-md border p-3">
                <div className="text-muted-foreground">Cached / Strict W</div>
                <div className="text-sm font-semibold">
                  {formatUGX(data.profile?.cached_withdrawable ?? 0)} /{' '}
                  {formatUGX(data.summary.strict_withdrawable)}
                </div>
                <div className="text-[10px] text-muted-foreground">
                  Float {formatUGX(data.profile?.cached_float ?? 0)}
                </div>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">Filters</CardTitle>
        </CardHeader>
        <CardContent className="grid grid-cols-1 md:grid-cols-4 gap-3 text-xs items-end">
          <div className="space-y-1">
            <Label className="text-xs">From</Label>
            <Input
              type="date"
              value={fromDate}
              min={windowStart || undefined}
              max={toDate || today}
              onChange={(e) => setFromDate(e.target.value)}
              className="h-8"
            />
          </div>
          <div className="space-y-1">
            <Label className="text-xs">To</Label>
            <Input
              type="date"
              value={toDate}
              min={fromDate || windowStart || undefined}
              max={today}
              onChange={(e) => setToDate(e.target.value)}
              className="h-8"
            />
          </div>
          <CategoryMultiSelect
            label="Admin categories"
            options={adminCategories}
            selected={adminCats}
            onChange={setAdminCats}
          />
          <CategoryMultiSelect
            label="Production categories"
            options={prodCategories}
            selected={prodCats}
            onChange={setProdCats}
          />
          {filtersActive && (
            <div className="md:col-span-4">
              <Button variant="ghost" size="sm" onClick={resetFilters} className="h-7 text-xs">
                <X className="h-3 w-3 mr-1" /> Clear filters
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm flex items-center gap-2">
            Admin / system corrections
            <Badge variant="destructive">
              {adminFiltered.length}
              {filtersActive && admin.length !== adminFiltered.length ? ` / ${admin.length}` : ''}
            </Badge>
          </CardTitle>
        </CardHeader>
        <CardContent>
          <EntryTable
            entries={adminFiltered}
            emptyLabel={
              admin.length === 0
                ? 'No admin corrections in this window.'
                : 'No admin corrections match the current filters.'
            }
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm flex items-center gap-2">
            Real production activity
            <Badge variant="secondary">
              {productionFiltered.length}
              {filtersActive && production.length !== productionFiltered.length
                ? ` / ${production.length}`
                : ''}
            </Badge>
          </CardTitle>
        </CardHeader>
        <CardContent>
          <EntryTable
            entries={productionFiltered}
            emptyLabel={
              production.length === 0
                ? 'No production activity in this window.'
                : 'No production activity matches the current filters.'
            }
          />
        </CardContent>
      </Card>
    </div>
  );
}

function CategoryMultiSelect({
  label,
  options,
  selected,
  onChange,
}: {
  label: string;
  options: string[];
  selected: string[];
  onChange: (next: string[]) => void;
}) {
  const toggle = (cat: string) => {
    onChange(selected.includes(cat) ? selected.filter((c) => c !== cat) : [...selected, cat]);
  };
  const summary =
    selected.length === 0
      ? options.length === 0
        ? 'No categories'
        : `All (${options.length})`
      : `${selected.length} selected`;
  return (
    <div className="space-y-1">
      <Label className="text-xs">{label}</Label>
      <Popover>
        <PopoverTrigger asChild>
          <Button
            variant="outline"
            size="sm"
            className="h-8 w-full justify-between text-xs font-normal"
            disabled={options.length === 0}
          >
            <span className="truncate">{summary}</span>
          </Button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-64 p-2 max-h-72 overflow-auto bg-popover">
          {options.length === 0 ? (
            <div className="text-xs text-muted-foreground p-2">No categories available.</div>
          ) : (
            <div className="space-y-1">
              {selected.length > 0 && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 w-full justify-start text-[11px]"
                  onClick={() => onChange([])}
                >
                  <X className="h-3 w-3 mr-1" /> Clear
                </Button>
              )}
              {options.map((cat) => (
                <label
                  key={cat}
                  className="flex items-center gap-2 text-xs font-mono px-1 py-1 rounded hover:bg-muted cursor-pointer"
                >
                  <Checkbox
                    checked={selected.includes(cat)}
                    onCheckedChange={() => toggle(cat)}
                  />
                  <span className="truncate">{cat}</span>
                </label>
              ))}
            </div>
          )}
        </PopoverContent>
      </Popover>
    </div>
  );
}