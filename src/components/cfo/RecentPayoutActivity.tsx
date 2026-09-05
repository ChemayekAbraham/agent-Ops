import { useState } from 'react';
import { useQuery, keepPreviousData } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Calendar } from '@/components/ui/calendar';
import { cn } from '@/lib/utils';
import {
  Loader2,
  ArrowDownLeft,
  ArrowUpRight,
  History,
  ChevronLeft,
  ChevronRight,
  CalendarIcon,
  X,
} from 'lucide-react';
import { formatUGX } from '@/lib/rentCalculations';
import { format } from 'date-fns';

const PAGE_SIZE = 10;

interface CorrectionRow {
  id: string;
  operation: string;
  amount: number;
  evidence: string | null;
  reference_id: string | null;
  created_at: string;
  target_user_id: string;
  metadata: Record<string, unknown> | null;
}

function pageWindow(current: number, total: number): (number | 'gap')[] {
  if (total <= 7) return Array.from({ length: total }, (_, i) => i + 1);
  const pages: (number | 'gap')[] = [1];
  const start = Math.max(2, current - 1);
  const end = Math.min(total - 1, current + 1);
  if (start > 2) pages.push('gap');
  for (let p = start; p <= end; p++) pages.push(p);
  if (end < total - 1) pages.push('gap');
  pages.push(total);
  return pages;
}

function startOfDay(d: Date): Date {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

function endOfDay(d: Date): Date {
  const x = new Date(d);
  x.setHours(23, 59, 59, 999);
  return x;
}

function FilterDatePicker({
  label,
  value,
  onChange,
  onClear,
}: {
  label: string;
  value: Date | undefined;
  onChange: (d: Date | undefined) => void;
  onClear: () => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="flex flex-col gap-1.5">
      <Label className="text-xs text-muted-foreground">{label}</Label>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            variant="outline"
            className={cn(
              'h-9 w-full justify-start px-3 text-left text-xs font-normal sm:w-[160px]',
              !value && 'text-muted-foreground',
            )}
          >
            <CalendarIcon className="mr-2 h-3.5 w-3.5" />
            {value ? format(value, 'dd MMM yyyy') : <span>Pick date</span>}
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-auto p-0" align="start">
          <Calendar
            mode="single"
            selected={value}
            onSelect={(d) => {
              onChange(d);
              setOpen(false);
            }}
            initialFocus
            className={cn('p-3 pointer-events-auto')}
          />
          {value && (
            <div className="border-t border-border p-2">
              <Button variant="ghost" size="sm" className="h-8 w-full text-xs" onClick={onClear}>
                <X className="mr-1.5 h-3 w-3" />
                Clear
              </Button>
            </div>
          )}
        </PopoverContent>
      </Popover>
    </div>
  );
}

export function RecentPayoutActivity() {
  const [page, setPage] = useState(1);
  const [nameFilter, setNameFilter] = useState('');
  const [categoryFilter, setCategoryFilter] = useState('');
  const [typeFilter, setTypeFilter] = useState<'all' | 'credit' | 'debit'>('all');
  const [destinationFilter, setDestinationFilter] = useState<'all' | 'user' | 'operational_wallet'>('all');
  const [dateFrom, setDateFrom] = useState<Date | undefined>(undefined);
  const [dateTo, setDateTo] = useState<Date | undefined>(undefined);

  const hasFilters =
    nameFilter.trim() ||
    categoryFilter.trim() ||
    typeFilter !== 'all' ||
    destinationFilter !== 'all' ||
    dateFrom ||
    dateTo;

  const { data, isLoading, isFetching, error } = useQuery({
    queryKey: [
      'cfo-recent-payout-activity',
      page,
      nameFilter.trim(),
      categoryFilter.trim(),
      typeFilter,
      destinationFilter,
      dateFrom?.toISOString(),
      dateTo?.toISOString(),
    ],
    refetchOnWindowFocus: false,
    staleTime: 30_000,
    placeholderData: keepPreviousData,
    queryFn: async () => {
      const from = (page - 1) * PAGE_SIZE;

      let profileIds: string[] | null = null;
      if (nameFilter.trim()) {
        const { data: profiles, error: profileErr } = await supabase
          .from('profiles')
          .select('id')
          .ilike('full_name', `%${nameFilter.trim()}%`)
          .limit(1000);
        if (profileErr) throw profileErr;
        profileIds = (profiles ?? []).map((p: any) => p.id);
        if (profileIds.length === 0) {
          return { rows: [], total: 0 };
        }
      }

      let query = supabase
        .from('platform_wallet_corrections')
        .select('id, operation, amount, evidence, reference_id, created_at, target_user_id, metadata', {
          count: 'exact',
        })
        .eq('tool', 'cfo_direct_credit');

      if (profileIds) {
        query = query.in('target_user_id', profileIds);
      }

      if (categoryFilter.trim()) {
        const term = `%${categoryFilter.trim()}%`;
        query = query.or(`metadata->>category_label.ilike.${term},evidence.ilike.${term}`);
      }

      if (typeFilter !== 'all') {
        query = query.eq('operation', typeFilter);
      }

      if (destinationFilter !== 'all') {
        query = query.eq('metadata->>recipient_type', destinationFilter);
      }

      if (dateFrom) {
        query = query.gte('created_at', startOfDay(dateFrom).toISOString());
      }

      if (dateTo) {
        query = query.lte('created_at', endOfDay(dateTo).toISOString());
      }

      const { data: rows, error: rowsErr, count } = await query
        .order('created_at', { ascending: false })
        .range(from, from + PAGE_SIZE - 1);
      if (rowsErr) throw rowsErr;

      const list = (rows ?? []) as unknown as CorrectionRow[];
      const ids = Array.from(new Set(list.map((r) => r.target_user_id).filter(Boolean)));
      let names: Record<string, { full_name: string | null; phone: string | null }> = {};
      if (ids.length) {
        const { data: profiles } = await supabase
          .from('profiles')
          .select('id, full_name, phone')
          .in('id', ids);
        names = Object.fromEntries(
          (profiles ?? []).map((p: any) => [p.id, { full_name: p.full_name, phone: p.phone }]),
        );
      }
      return {
        rows: list.map((r) => ({ ...r, recipient: names[r.target_user_id] ?? null })),
        total: count ?? 0,
      };
    },
  });

  const resetFilters = () => {
    setNameFilter('');
    setCategoryFilter('');
    setTypeFilter('all');
    setDestinationFilter('all');
    setDateFrom(undefined);
    setDateTo(undefined);
    setPage(1);
  };

  const total = data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const rangeStart = total === 0 ? 0 : (page - 1) * PAGE_SIZE + 1;
  const rangeEnd = Math.min(page * PAGE_SIZE, total);

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base font-semibold flex items-center gap-2">
          <History className="h-4 w-4 text-muted-foreground" />
          Recent Payout Activity
          {isFetching && !isLoading && (
            <span className="text-xs font-normal text-muted-foreground">Updating…</span>
          )}
        </CardTitle>
        <p className="text-xs text-muted-foreground">
          Every wallet movement made from this page, with who received it and why.
        </p>
      </CardHeader>
      <CardContent className="p-0">
        <div className="border-b border-border bg-muted/30 px-4 py-3">
          <div className="flex flex-col gap-3 lg:flex-row lg:flex-wrap lg:items-end">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="payout-filter-name" className="text-xs text-muted-foreground">
                Recipient name
              </Label>
              <Input
                id="payout-filter-name"
                placeholder="Search name…"
                value={nameFilter}
                onChange={(e) => {
                  setNameFilter(e.target.value);
                  setPage(1);
                }}
                className="h-9 text-xs sm:w-[180px]"
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="payout-filter-category" className="text-xs text-muted-foreground">
                Category
              </Label>
              <Input
                id="payout-filter-category"
                placeholder="Search category…"
                value={categoryFilter}
                onChange={(e) => {
                  setCategoryFilter(e.target.value);
                  setPage(1);
                }}
                className="h-9 text-xs sm:w-[180px]"
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label className="text-xs text-muted-foreground">Type</Label>
              <Select
                value={typeFilter}
                onValueChange={(v) => {
                  setTypeFilter(v as 'all' | 'credit' | 'debit');
                  setPage(1);
                }}
              >
                <SelectTrigger className="h-9 text-xs sm:w-[150px]">
                  <SelectValue placeholder="All types" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All types</SelectItem>
                  <SelectItem value="credit">Sent</SelectItem>
                  <SelectItem value="debit">Taken out</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label className="text-xs text-muted-foreground">Destination</Label>
              <Select
                value={destinationFilter}
                onValueChange={(v) => {
                  setDestinationFilter(v as 'all' | 'user' | 'operational_wallet');
                  setPage(1);
                }}
              >
                <SelectTrigger className="h-9 text-xs sm:w-[170px]">
                  <SelectValue placeholder="All destinations" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All destinations</SelectItem>
                  <SelectItem value="user">User wallet</SelectItem>
                  <SelectItem value="operational_wallet">Operational float</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <FilterDatePicker
              label="Date from"
              value={dateFrom}
              onChange={(d) => {
                setDateFrom(d);
                setPage(1);
              }}
              onClear={() => {
                setDateFrom(undefined);
                setPage(1);
              }}
            />
            <FilterDatePicker
              label="Date to"
              value={dateTo}
              onChange={(d) => {
                setDateTo(d);
                setPage(1);
              }}
              onClear={() => {
                setDateTo(undefined);
                setPage(1);
              }}
            />
            {hasFilters && (
              <Button variant="ghost" size="sm" className="h-9 text-xs" onClick={resetFilters}>
                <X className="mr-1.5 h-3.5 w-3.5" />
                Clear filters
              </Button>
            )}
          </div>
        </div>

        {isLoading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : error ? (
          <p className="px-5 pb-5 pt-5 text-sm text-destructive">Could not load recent activity.</p>
        ) : !data || data.rows.length === 0 ? (
          <p className="px-5 pb-5 pt-5 text-sm text-muted-foreground">
            {hasFilters ? 'No payouts match the selected filters.' : 'No payouts recorded yet.'}
          </p>
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border text-left text-muted-foreground">
                    <th className="px-4 py-2.5 font-medium">Recipient</th>
                    <th className="px-4 py-2.5 font-medium text-right">Amount</th>
                    <th className="px-4 py-2.5 font-medium">Type</th>
                    <th className="px-4 py-2.5 font-medium">Destination</th>
                    <th className="px-4 py-2.5 font-medium">Category</th>
                    <th className="px-4 py-2.5 font-medium">Reference</th>
                    <th className="px-4 py-2.5 font-medium whitespace-nowrap">Date &amp; time</th>
                  </tr>
                </thead>
                <tbody>
                  {data.rows.map((row) => {
                    const isDebit = row.operation === 'debit';
                    const meta = (row.metadata ?? {}) as Record<string, any>;
                    const destination =
                      meta.recipient_type === 'operational_wallet' ? 'Operational float' : 'User wallet';
                    return (
                      <tr key={row.id} className="border-b border-border last:border-0">
                        <td className="px-4 py-2.5">
                          <div className="font-medium">{row.recipient?.full_name || 'Unknown'}</div>
                          <div className="text-xs text-muted-foreground">{row.recipient?.phone || '—'}</div>
                        </td>
                        <td
                          className={`px-4 py-2.5 text-right font-semibold ${
                            isDebit ? 'text-destructive' : 'text-emerald-600'
                          }`}
                        >
                          {isDebit ? '−' : '+'}
                          {formatUGX(Number(row.amount))}
                        </td>
                        <td className="px-4 py-2.5">
                          <Badge variant={isDebit ? 'destructive' : 'secondary'} className="gap-1 text-xs">
                            {isDebit ? (
                              <ArrowUpRight className="h-3 w-3" />
                            ) : (
                              <ArrowDownLeft className="h-3 w-3" />
                            )}
                            {isDebit ? 'Taken out' : 'Sent'}
                          </Badge>
                        </td>
                        <td className="px-4 py-2.5 text-muted-foreground">{destination}</td>
                        <td className="px-4 py-2.5 max-w-[260px] truncate text-muted-foreground">
                          {meta.category_label || row.evidence || '—'}
                        </td>
                        <td className="px-4 py-2.5 font-mono text-xs text-muted-foreground">
                          {row.reference_id || '—'}
                        </td>
                        <td className="px-4 py-2.5 text-muted-foreground whitespace-nowrap">
                          {format(new Date(row.created_at), 'dd MMM yyyy, HH:mm')}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            <div className="flex flex-col gap-3 border-t border-border px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
              <p className="text-xs text-muted-foreground">
                Showing {rangeStart}–{rangeEnd} of {total} records
              </p>
              <div className="flex flex-wrap items-center gap-1">
                <Button
                  variant="outline"
                  size="sm"
                  className="h-8 px-2"
                  disabled={page <= 1}
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                >
                  <ChevronLeft className="h-4 w-4" />
                  <span className="hidden sm:inline">Previous</span>
                </Button>
                {pageWindow(page, totalPages).map((p, i) =>
                  p === 'gap' ? (
                    <span key={`gap-${i}`} className="px-1 text-xs text-muted-foreground">
                      …
                    </span>
                  ) : (
                    <Button
                      key={p}
                      variant={p === page ? 'default' : 'outline'}
                      size="sm"
                      className="h-8 w-8 p-0 text-xs"
                      onClick={() => setPage(p)}
                    >
                      {p}
                    </Button>
                  ),
                )}
                <Button
                  variant="outline"
                  size="sm"
                  className="h-8 px-2"
                  disabled={page >= totalPages}
                  onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                >
                  <span className="hidden sm:inline">Next</span>
                  <ChevronRight className="h-4 w-4" />
                </Button>
              </div>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
