import { useState, useMemo } from 'react';
import { format, subDays, startOfMonth } from 'date-fns';
import { CalendarIcon, Download, Loader2, Search } from 'lucide-react';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Calendar } from '@/components/ui/calendar';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Badge } from '@/components/ui/badge';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { cn } from '@/lib/utils';
import {
  useCFOImpactDrilldown,
  type ImpactMetric,
  type LandlordFilters,
} from '@/hooks/useCFOImpactDrilldown';
import { toast } from 'sonner';

const META: Record<ImpactMetric, { title: string; emoji: string; amountLabel: string }> = {
  users: { title: 'Total Users', emoji: '👥', amountLabel: '' },
  tenants: { title: 'Tenants Impacted', emoji: '🏠', amountLabel: 'Last Rent (UGX)' },
  agents: { title: 'Agents Earning', emoji: '👤', amountLabel: 'Earned (UGX)' },
  partners: { title: 'Active Partners', emoji: '💼', amountLabel: 'Invested (UGX)' },
  landlords_active: { title: 'Active Landlords (90d)', emoji: '🏘️', amountLabel: 'Last Rent (UGX)' },
  landlords_dormant: { title: 'Dormant Landlords', emoji: '😴', amountLabel: 'Balance Due (UGX)' },
};

const fmtMoney = (n: number) =>
  new Intl.NumberFormat('en-UG', { maximumFractionDigits: 0 }).format(n);

interface Props {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  metric: ImpactMetric | null;
}

export function CFOImpactDrilldownSheet({ open, onOpenChange, metric }: Props) {
  const [from, setFrom] = useState<Date | undefined>(undefined);
  const [to, setTo] = useState<Date | undefined>(undefined);
  const [search, setSearch] = useState('');
  const [propertyQuery, setPropertyQuery] = useState('');
  const [region, setRegion] = useState<string>('all');
  const [accountStatus, setAccountStatus] =
    useState<NonNullable<LandlordFilters['accountStatus']>>('all');

  const isLandlordMetric = metric === 'landlords_active' || metric === 'landlords_dormant';
  const landlordFilters: LandlordFilters | undefined = isLandlordMetric
    ? { property: propertyQuery, region, accountStatus }
    : undefined;

  const { data, isLoading } = useCFOImpactDrilldown(metric, from, to, open, landlordFilters);

  const filtered = useMemo(() => {
    if (!data?.records) return [];
    if (!search.trim()) return data.records;
    const q = search.trim().toLowerCase();
    return data.records.filter(
      (r) => r.name.toLowerCase().includes(q) || (r.phone || '').toLowerCase().includes(q),
    );
  }, [data, search]);

  const setRange = (days: number | 'mtd' | 'all') => {
    if (days === 'all') {
      setFrom(undefined);
      setTo(undefined);
    } else if (days === 'mtd') {
      setFrom(startOfMonth(new Date()));
      setTo(new Date());
    } else {
      setFrom(subDays(new Date(), days));
      setTo(new Date());
    }
  };

  const handleExport = () => {
    if (!metric || !filtered.length) {
      toast.info('Nothing to export');
      return;
    }
    const m = META[metric];
    const headers = ['Name', 'Phone', m.amountLabel || 'Amount', 'Date', 'Notes'];
    const rows = filtered.map((r) => [
      `"${(r.name || '').replace(/"/g, '""')}"`,
      r.phone || '',
      r.amount ?? '',
      r.date ? new Date(r.date).toLocaleDateString() : '',
      r.meta || '',
    ].join(','));
    const csv = [headers.join(','), ...rows].join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${metric}_${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    toast.success(`Exported ${filtered.length} rows`);
  };

  const resetLandlordFilters = () => {
    setPropertyQuery('');
    setRegion('all');
    setAccountStatus('all');
  };

  if (!metric) return null;
  const m = META[metric];

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full sm:max-w-2xl overflow-y-auto p-0">
        <SheetHeader className="px-5 pt-5 pb-3 border-b border-border sticky top-0 bg-background z-10">
          <SheetTitle className="flex items-center gap-2 text-lg">
            <span>{m.emoji}</span>
            <span>{m.title}</span>
            {!isLoading && (
              <Badge variant="secondary" className="ml-2">
                {data?.total ?? 0}
              </Badge>
            )}
          </SheetTitle>
        </SheetHeader>

        <div className="px-5 py-4 space-y-3">
          {/* Quick range chips */}
          <div className="flex flex-wrap gap-1.5">
            <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => setRange('all')}>All time</Button>
            <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => setRange(7)}>7 days</Button>
            <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => setRange(30)}>30 days</Button>
            <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => setRange(90)}>90 days</Button>
            <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => setRange('mtd')}>Month to date</Button>
          </div>

          {/* Date pickers */}
          <div className="grid grid-cols-2 gap-2">
            <Popover>
              <PopoverTrigger asChild>
                <Button
                  variant="outline"
                  className={cn('justify-start text-xs h-9 font-normal', !from && 'text-muted-foreground')}
                >
                  <CalendarIcon className="mr-2 h-3.5 w-3.5" />
                  {from ? format(from, 'PP') : 'From'}
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-auto p-0" align="start">
                <Calendar mode="single" selected={from} onSelect={setFrom} initialFocus className={cn('p-3 pointer-events-auto')} />
              </PopoverContent>
            </Popover>
            <Popover>
              <PopoverTrigger asChild>
                <Button
                  variant="outline"
                  className={cn('justify-start text-xs h-9 font-normal', !to && 'text-muted-foreground')}
                >
                  <CalendarIcon className="mr-2 h-3.5 w-3.5" />
                  {to ? format(to, 'PP') : 'To'}
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-auto p-0" align="start">
                <Calendar mode="single" selected={to} onSelect={setTo} initialFocus className={cn('p-3 pointer-events-auto')} />
              </PopoverContent>
            </Popover>
          </div>

          {/* Landlord-specific filters */}
          {isLandlordMetric && (
            <div className="space-y-2 rounded-lg border border-border bg-muted/30 p-3">
              <div className="flex items-center justify-between">
                <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                  Landlord filters
                </p>
                {(propertyQuery || region !== 'all' || accountStatus !== 'all') && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-6 px-2 text-[11px]"
                    onClick={resetLandlordFilters}
                  >
                    Reset
                  </Button>
                )}
              </div>
              <Input
                placeholder="Property address, house # or district…"
                value={propertyQuery}
                onChange={(e) => setPropertyQuery(e.target.value)}
                className="h-9 text-xs"
              />
              <div className="grid grid-cols-2 gap-2">
                <Select value={region} onValueChange={setRegion}>
                  <SelectTrigger className="h-9 text-xs">
                    <SelectValue placeholder="Region" />
                  </SelectTrigger>
                  <SelectContent className="z-[60] bg-popover">
                    <SelectItem value="all">All regions</SelectItem>
                    {(data?.regions || []).map((r) => (
                      <SelectItem key={r} value={r}>
                        {r}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Select
                  value={accountStatus}
                  onValueChange={(v) => setAccountStatus(v as typeof accountStatus)}
                >
                  <SelectTrigger className="h-9 text-xs">
                    <SelectValue placeholder="Account status" />
                  </SelectTrigger>
                  <SelectContent className="z-[60] bg-popover">
                    <SelectItem value="all">Any status</SelectItem>
                    <SelectItem value="verified">Verified</SelectItem>
                    <SelectItem value="unverified">Unverified</SelectItem>
                    <SelectItem value="ready">Ready to receive</SelectItem>
                    <SelectItem value="not_ready">Not ready</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
          )}

          {/* Search + export */}
          <div className="flex gap-2">
            <div className="relative flex-1">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
              <Input
                placeholder="Search name or phone…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="pl-8 h-9 text-xs"
              />
            </div>
            <Button variant="outline" size="sm" className="h-9 gap-1.5 text-xs" onClick={handleExport}>
              <Download className="h-3.5 w-3.5" />
              CSV
            </Button>
          </div>

          {data?.truncated && (
            <p className="text-[11px] text-warning">
              Showing first 200 records — narrow the date range to see more.
            </p>
          )}

          {/* Records list */}
          {isLoading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="h-5 w-5 animate-spin text-primary" />
            </div>
          ) : filtered.length === 0 ? (
            <p className="text-center text-sm text-muted-foreground py-12">
              No records in this range.
            </p>
          ) : (
            <div className="space-y-1.5">
              {filtered.map((r) => (
                <div
                  key={r.id}
                  className="flex items-center justify-between gap-3 p-3 rounded-lg border border-border bg-card"
                >
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium truncate">{r.name}</p>
                    <p className="text-[11px] text-muted-foreground truncate">
                      {r.phone || 'No phone'}
                      {r.meta ? ` · ${r.meta}` : ''}
                      {r.date ? ` · ${new Date(r.date).toLocaleDateString()}` : ''}
                    </p>
                  </div>
                  {typeof r.amount === 'number' && r.amount > 0 && (
                    <div className="text-right shrink-0">
                      <p className="text-sm font-semibold font-mono">{fmtMoney(r.amount)}</p>
                      <p className="text-[10px] text-muted-foreground uppercase">{m.amountLabel}</p>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}