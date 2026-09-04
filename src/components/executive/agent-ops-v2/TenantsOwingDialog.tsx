import { useMemo, useState, useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { formatUGX } from '@/lib/rentCalculations';
import { cn } from '@/lib/utils';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { Search, FileDown, Users, Calendar, AlertTriangle, Wallet, ArrowDownWideNarrow } from 'lucide-react';

type TenantsOwingRow = {
  rent_request_id: string;
  tenant_id: string;
  tenant_name: string;
  tenant_phone: string | null;
  agent_id: string;
  agent_name: string;
  agent_phone: string | null;
  daily_amount: number;
  scheduled_today: number;
  arrears: number;
  outstanding: number;
  total_amount: number;
  amount_repaid: number;
  term_start: string;
  term_end: string;
  in_term: boolean;
  days_past_term: number;
  last_paid_on: string | null;
};

type TenantsOwingTotals = {
  tenants_owing: number;
  total_arrears: number;
  total_outstanding: number;
  scheduled_today: number;
  owing_in_term: number;
  owing_past_term: number;
  daily_rate_all_owing: number;
  daily_rate_past_term: number;
};

type TenantsOwingResponse = {
  as_of: string;
  timezone: string;
  totals: TenantsOwingTotals;
  rows: TenantsOwingRow[];
  generated_at: string;
};

type FilterMode = 'all' | 'in_term' | 'past_term';
type SortKey = 'arrears' | 'scheduled_today' | 'days_past_term' | 'outstanding';

const num = (v: any) => Number(v ?? 0);

function csvEscape(value: unknown): string {
  const s = String(value ?? '');
  if (s.includes(',') || s.includes('"') || s.includes('\n') || s.includes('\r')) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

export function TenantsOwingDialog({
  asOf,
  open,
  onOpenChange,
}: {
  asOf: string;
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<FilterMode>('all');
  const [sort, setSort] = useState<SortKey>('arrears');
  const [visible, setVisible] = useState(50);

  const { data, isLoading, error } = useQuery({
    queryKey: ['agent-ops-tenants-owing', asOf],
    queryFn: async () => {
      const { data, error } = await supabase.rpc('agent_ops_tenants_owing', { p_as_of: asOf });
      if (error) throw error;
      return data as unknown as TenantsOwingResponse;
    },
    enabled: open,
    staleTime: 60_000,
  });

  useEffect(() => {
    setVisible(50);
  }, [search, filter, sort]);

  const rows = useMemo(() => data?.rows ?? [], [data]);
  const totals = data?.totals;

  const filteredRows = useMemo(() => {
    const q = search.trim().toLowerCase();
    let list = rows;
    if (filter === 'in_term') list = list.filter(r => r.in_term);
    if (filter === 'past_term') list = list.filter(r => !r.in_term);
    if (q) {
      list = list.filter(
        r =>
          r.tenant_name.toLowerCase().includes(q) ||
          (r.tenant_phone || '').toLowerCase().includes(q) ||
          r.agent_name.toLowerCase().includes(q),
      );
    }
    list = [...list].sort((a, b) => num(b[sort]) - num(a[sort]));
    return list;
  }, [rows, search, filter, sort]);

  const filteredTotals = useMemo(() => {
    return filteredRows.reduce(
      (acc, r) => {
        acc.scheduled_today += num(r.scheduled_today);
        acc.arrears += num(r.arrears);
        acc.outstanding += num(r.outstanding);
        return acc;
      },
      { scheduled_today: 0, arrears: 0, outstanding: 0 },
    );
  }, [filteredRows]);

  const downloadCsv = () => {
    const columns: { key: keyof TenantsOwingRow; label: string }[] = [
      { key: 'tenant_name', label: 'tenant_name' },
      { key: 'tenant_phone', label: 'tenant_phone' },
      { key: 'agent_name', label: 'agent_name' },
      { key: 'agent_phone', label: 'agent_phone' },
      { key: 'scheduled_today', label: 'scheduled_today' },
      { key: 'arrears', label: 'arrears' },
      { key: 'outstanding', label: 'outstanding' },
      { key: 'total_amount', label: 'total_amount' },
      { key: 'amount_repaid', label: 'amount_repaid' },
      { key: 'daily_amount', label: 'daily_amount' },
      { key: 'term_start', label: 'term_start' },
      { key: 'term_end', label: 'term_end' },
      { key: 'in_term', label: 'in_term' },
      { key: 'days_past_term', label: 'days_past_term' },
      { key: 'last_paid_on', label: 'last_paid_on' },
    ];

    const header = columns.map(c => csvEscape(c.label)).join(',');
    const lines = filteredRows.map(row =>
      columns
        .map(c => {
          const v = row[c.key];
          if (c.key === 'in_term') return v ? 'true' : 'false';
          return csvEscape(v);
        })
        .join(','),
    );
    const csv = [header, ...lines].join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `welile-tenants-owing-${asOf}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  };

  const remaining = Math.max(0, filteredRows.length - visible);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-5xl max-h-[85vh] flex flex-col overflow-hidden p-0">
        <DialogHeader className="px-6 pt-6 pb-2 shrink-0">
          <div className="flex items-start justify-between gap-4">
            <div>
              <DialogTitle className="text-base font-semibold">Tenants owing money</DialogTitle>
              <DialogDescription className="text-xs text-muted-foreground mt-1">
                As at {asOf} · East Africa Time
              </DialogDescription>
            </div>
            <Button size="sm" variant="outline" className="h-8 text-xs shrink-0" onClick={downloadCsv}>
              <FileDown className="h-3.5 w-3.5 mr-1" />
              Download CSV
            </Button>
          </div>
        </DialogHeader>

        <div className="px-6 pb-2 space-y-3 overflow-y-auto">
          {error && (
            <Card className="p-4 border-destructive/40">
              <p className="text-sm text-destructive">Could not load tenants owing: {(error as any).message}</p>
            </Card>
          )}

          {isLoading ? (
            <p className="text-sm text-muted-foreground py-6 text-center">Loading tenants owing…</p>
          ) : (
            <>
              {/* Summary strip */}
              <div className="grid grid-cols-2 lg:grid-cols-4 gap-2">
                <Card className="p-3">
                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    <Users className="h-3.5 w-3.5" /> Tenants owing
                  </div>
                  <p className="text-lg font-bold mt-1">{num(totals?.tenants_owing)}</p>
                  <p className="text-[11px] text-muted-foreground">
                    {num(totals?.owing_in_term)} in term · {num(totals?.owing_past_term)} past term
                  </p>
                </Card>
                <Card className="p-3">
                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    <Calendar className="h-3.5 w-3.5" /> Scheduled today
                  </div>
                  <p className="text-lg font-bold mt-1">{formatUGX(num(totals?.scheduled_today))}</p>
                  <p className="text-[11px] text-muted-foreground">Per the agreed payment plans</p>
                </Card>
                <Card className="p-3">
                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    <AlertTriangle className="h-3.5 w-3.5" /> Total arrears
                  </div>
                  <p className="text-lg font-bold mt-1 text-destructive">
                    {formatUGX(num(totals?.total_arrears))}
                  </p>
                  <p className="text-[11px] text-muted-foreground">Unpaid and part-paid to date</p>
                </Card>
                <Card className="p-3">
                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    <Wallet className="h-3.5 w-3.5" /> Total outstanding
                  </div>
                  <p className="text-lg font-bold mt-1">{formatUGX(num(totals?.total_outstanding))}</p>
                  <p className="text-[11px] text-muted-foreground">Full remaining balance</p>
                </Card>
              </div>

              {/* Controls */}
              <div className="flex flex-col gap-2">
                <div className="relative">
                  <Search className="absolute left-2 top-2.5 h-3.5 w-3.5 text-muted-foreground" />
                  <Input
                    value={search}
                    onChange={e => setSearch(e.target.value)}
                    placeholder="Search tenant, phone or agent"
                    className="h-8 pl-7 text-xs"
                  />
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <div className="flex flex-wrap gap-1.5">
                    {(['all', 'in_term', 'past_term'] as FilterMode[]).map(f => (
                      <Button
                        key={f}
                        size="sm"
                        variant={filter === f ? 'default' : 'outline'}
                        className="h-8 text-xs"
                        onClick={() => setFilter(f)}
                      >
                        {f === 'all' ? 'All' : f === 'in_term' ? 'In term today' : 'Past agreed term'}
                      </Button>
                    ))}
                  </div>
                  <div className="flex items-center gap-1 ml-auto">
                    <ArrowDownWideNarrow className="h-3.5 w-3.5 text-muted-foreground" />
                    {([
                      { key: 'arrears', label: 'Arrears' },
                      { key: 'scheduled_today', label: 'Scheduled today' },
                      { key: 'days_past_term', label: 'Days past term' },
                      { key: 'outstanding', label: 'Outstanding' },
                    ] as { key: SortKey; label: string }[]).map(s => (
                      <Button
                        key={s.key}
                        size="sm"
                        variant={sort === s.key ? 'default' : 'outline'}
                        className="h-8 text-xs"
                        onClick={() => setSort(s.key)}
                      >
                        {s.label}
                      </Button>
                    ))}
                  </div>
                </div>
              </div>

              {/* Filtered totals bar */}
              <div className="rounded-md border bg-muted/30 px-3 py-2 text-xs">
                <span className="font-semibold">{filteredRows.length}</span> tenants · scheduled today{' '}
                <span className="font-semibold">{formatUGX(filteredTotals.scheduled_today)}</span> · arrears{' '}
                <span className="font-semibold">{formatUGX(filteredTotals.arrears)}</span> · outstanding{' '}
                <span className="font-semibold">{formatUGX(filteredTotals.outstanding)}</span>
              </div>

              {/* List */}
              {filteredRows.length === 0 ? (
                <p className="text-sm text-muted-foreground py-6 text-center">No tenants match the current filter.</p>
              ) : (
                <div className="space-y-2">
                  {filteredRows.slice(0, visible).map((row, i) => (
                    <Card
                      key={row.rent_request_id}
                      className="p-3 flex flex-col gap-2 border hover:bg-accent/40 transition-colors"
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <p className="text-sm font-medium truncate">{row.tenant_name}</p>
                          <p className="text-[11px] text-muted-foreground truncate">
                            {row.tenant_phone ? `${row.tenant_phone} · ` : ''}via {row.agent_name}
                          </p>
                        </div>
                        <div className="text-right shrink-0">
                          <p className="text-sm font-bold text-destructive">{formatUGX(num(row.arrears))}</p>
                          <p className="text-[11px] text-muted-foreground">of {formatUGX(num(row.outstanding))} outstanding</p>
                        </div>
                      </div>
                      <div className="flex flex-wrap items-center gap-1.5">
                        {row.in_term ? (
                          <Badge variant="outline" className="text-[10px]">
                            Due today {formatUGX(num(row.scheduled_today))}
                          </Badge>
                        ) : (
                          <Badge variant="destructive" className="text-[10px]">
                            {num(row.days_past_term)} days past term
                          </Badge>
                        )}
                        {row.last_paid_on ? (
                          <Badge variant="outline" className="text-[10px]">
                            Last paid {row.last_paid_on}
                          </Badge>
                        ) : (
                          <Badge variant="outline" className="text-[10px]">
                            Never paid
                          </Badge>
                        )}
                      </div>
                    </Card>
                  ))}
                  {remaining > 0 && (
                    <div className="pt-3 text-center">
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-8 text-xs"
                        onClick={() => setVisible(v => v + 50)}
                      >
                        Load more · {remaining} remaining
                      </Button>
                    </div>
                  )}
                </div>
              )}
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
