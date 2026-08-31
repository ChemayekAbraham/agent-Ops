import { useEffect, useMemo, useState } from 'react';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Skeleton } from '@/components/ui/skeleton';
import { ChevronLeft, ChevronRight, PhoneCall } from 'lucide-react';
import { toast } from 'sonner';
import { useCcCallingHub, type CcFilterSelection, type CcRow, type CcSubjectType } from '@/hooks/useCcCallingHub';
import { CALLING_TABS, type CallingTabKey } from './callingHubColumns';
import { CallingHubTable } from './CallingHubTable';
import { CallingFilterBar } from './CallingFilterBar';
import { OpenAttemptQueue } from './OpenAttemptQueue';
import { RecordOutcomeDialog } from './RecordOutcomeDialog';
import { CycleControls } from './CycleControls';
import { FollowupsDuePanel } from './FollowupsDuePanel';


const TITLE: Record<CcSubjectType, string> = {
  tenant: 'Tenant Calling Hub',
  landlord: 'Landlord Calling Hub',
  agent: 'Agent Calling Hub',
};

/**
 * One component for all three subject types. Do not fork it per docket.
 * Sorting, searching and paging are all server-side (cc_call_queue_page).
 */
export function CallingHub({ subjectType }: { subjectType: CcSubjectType }) {
  const [tab, setTab] = useState<CallingTabKey>('to_call');
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [sortKey, setSortKey] = useState<string | null>(null);
  const [page, setPage] = useState(0);
  /** Filters persist across tab switches — they are orthogonal to row state. */
  const [filters, setFilters] = useState<CcFilterSelection>({});

  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search), 350);
    return () => clearTimeout(t);
  }, [search]);

  const filtersKey = useMemo(
    () =>
      Object.entries(filters)
        .filter(([, v]) => v)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => `${k}=${v}`)
        .join('&'),
    [filters],
  );

  useEffect(() => setPage(0), [tab, debouncedSearch, sortKey, subjectType, filtersKey]);

  useEffect(() => setFilters({}), [subjectType]);

  const hub = useCcCallingHub(subjectType, { state: tab, sortKey, search: debouncedSearch, page, filters });


  const [revealed, setRevealed] = useState<Record<string, string | null>>({});
  const [formAttempt, setFormAttempt] = useState<{ id: string; cycle_row_id: string; name: string } | null>(null);

  const metricLabel = useMemo(() => hub.rows[0]?.metric_label ?? 'Metric', [hub.rows]);
  const activeTab = CALLING_TABS.find((t) => t.key === tab) ?? CALLING_TABS[0];

  const handleReveal = (row: CcRow) => {
    hub.reveal.mutate(
      { id: row.id },
      {
        onSuccess: ({ phone }) => {
          setRevealed((r) => ({ ...r, [row.id]: phone }));
          toast.success(phone ? `Number revealed: ${phone}` : 'Attempt opened, but no number is on file.');
        },
        onError: (e) => toast.error((e as Error).message),
      },
    );
  };

  return (
    <div className="space-y-3 pb-32 sm:pb-28">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="flex items-center gap-2 text-base font-bold">
          <PhoneCall className="h-4 w-4 text-primary" />
          {TITLE[subjectType]}
        </h2>
        <div className="grid w-full grid-cols-1 gap-2 sm:flex sm:w-auto sm:flex-wrap sm:items-end">
          <div className="space-y-1">
            <Label className="text-[11px] text-muted-foreground">Sort by</Label>
            <Select value={hub.effectiveSortKey ?? ''} onValueChange={(v) => setSortKey(v)}>
              <SelectTrigger className="h-8 w-full text-xs sm:w-[190px]">
                <SelectValue placeholder="Default order" />
              </SelectTrigger>
              <SelectContent>
                {hub.sortOptions.map((o) => (
                  <SelectItem key={o.key} value={o.key} className="text-xs">
                    {o.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search name or district"
            className="h-8 w-full text-xs sm:max-w-xs"
          />
        </div>

      </div>

      <CallingFilterBar
        options={hub.filterOptions}
        loading={hub.filterOptionsLoading}
        error={hub.filterOptionsError}
        selection={filters}
        filteredTotal={hub.total}
        onChange={(key, value) =>
          setFilters((prev) => {
            const next = { ...prev };
            if (value) next[key] = value;
            else delete next[key];
            return next;
          })
        }
        onClearAll={() => setFilters({})}
      />

      <CycleControls hub={hub} />


      <div className="grid grid-cols-1 gap-3 lg:grid-cols-3">
        {/* Side panels come after the queue below lg — a caller needs the list first. */}
        <div className="order-2 space-y-3 lg:order-1 lg:col-span-1">
          <OpenAttemptQueue hub={hub} onOpenForm={setFormAttempt} />
          <FollowupsDuePanel hub={hub} />
        </div>

        <Card className="order-1 min-w-0 rounded-2xl border-border/60 p-2 sm:p-3 lg:order-2 lg:col-span-2">
          {!hub.cycle ? (
            <p className="p-6 text-center text-xs text-muted-foreground">
              No open calling cycle for {subjectType}s. Open one from the cycle controls.
            </p>
          ) : (
            <Tabs value={tab} onValueChange={(v) => setTab(v as CallingTabKey)}>
              {/* All five tabs at every width: wrap, never truncate or overflow. */}
              <TabsList className="flex h-auto w-full flex-wrap justify-start gap-1 bg-transparent p-0">
                {CALLING_TABS.map((t) => (
                  <TabsTrigger
                    key={t.key}
                    value={t.key}
                    className="h-8 shrink-0 gap-1.5 whitespace-nowrap px-2 text-xs data-[state=active]:bg-muted"
                  >
                    {t.label}
                    <Badge variant="secondary" className="px-1.5 py-0 text-[10px]">
                      {hub.counts[t.key]}
                    </Badge>
                  </TabsTrigger>
                ))}
              </TabsList>


              <TabsContent value={tab} className="mt-2">
                {hub.error && (
                  <p className="mb-2 rounded-lg bg-destructive/10 px-2 py-1.5 text-xs font-semibold text-destructive">
                    {hub.error}
                  </p>
                )}
                {hub.isLoading ? (
                  <div className="space-y-2 p-2">
                    <Skeleton className="h-6 w-full" />
                    <Skeleton className="h-6 w-full" />
                    <Skeleton className="h-6 w-full" />
                  </div>
                ) : (
                  <>
                    <CallingHubTable
                      columns={activeTab.columns}
                      rows={hub.rows}
                      metricLabel={metricLabel}
                      revealed={revealed}
                      revealing={hub.reveal.isPending}
                      wipBlocked={hub.wipBlocked}
                      onReveal={handleReveal}
                    />
                    <div className="mt-2 flex flex-wrap items-center justify-between gap-2 px-1 pb-2">
                      <p className="text-[11px] text-muted-foreground">
                        {hub.total === 0
                          ? 'Showing 0 of 0'
                          : `Showing ${hub.pageFrom} to ${hub.pageTo} of ${hub.total.toLocaleString()}`}
                      </p>
                      <div className="flex flex-wrap items-center gap-1.5">

                        <Button
                          size="sm"
                          variant="outline"
                          className="h-7 px-2 text-[11px]"
                          disabled={page === 0 || hub.isFetching}
                          onClick={() => setPage((p) => Math.max(0, p - 1))}
                        >
                          <ChevronLeft className="mr-1 h-3 w-3" /> Previous
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-7 px-2 text-[11px]"
                          disabled={hub.pageTo >= hub.total || hub.isFetching}
                          onClick={() => setPage((p) => p + 1)}
                        >
                          Next <ChevronRight className="ml-1 h-3 w-3" />
                        </Button>
                      </div>
                    </div>
                  </>
                )}
              </TabsContent>
            </Tabs>
          )}
        </Card>
      </div>

      <RecordOutcomeDialog hub={hub} attempt={formAttempt} onClose={() => setFormAttempt(null)} />
    </div>
  );
}

export default CallingHub;
