import { useEffect, useMemo, useState } from 'react';
import { ChevronLeft, ChevronRight, Eye, FileText, Loader2, PhoneCall, Search, SlidersHorizontal, Users, X } from 'lucide-react';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { cn } from '@/lib/utils';
import {
  CALLEE_ROLES, CALLEE_ROLE_BADGE, CALLEE_ROLE_LABEL, formatCallStamp, OUTCOME_LABEL,
  primaryRole, CALL_SECTION_FILTERS, CALL_SECTION_LABEL,
  type CalleeRole, type CallOutcome, type CallSection,
} from '@/lib/callCentre';
import {
  PEOPLE_PAGE_SIZE, usePlatformPeople, usePlatformPeopleCounts,
  type PeopleSort, type PeopleStatusFilter, type PlatformPerson,
} from '@/hooks/useCrmCallCentre';
import { useRestoreBodyPointerEvents } from '@/hooks/useRestoreBodyPointerEvents';
import { CallDrawer } from './CallDrawer';
import { useCallDialer, type DialTarget } from './useCallDialer';
import { CallSummaryHistorySheet } from './CallSummaryHistorySheet';

const initials = (name: string) =>
  name.trim().split(/\s+/).slice(0, 2).map((p) => p[0]?.toUpperCase() ?? '').join('') || '??';

const OUTCOME_TONE: Record<CallOutcome, string> = {
  answered: 'border-success/40 text-success',
  rejected: 'border-destructive/40 text-destructive',
  not_reachable: 'border-warning/40 text-warning',
  in_progress: 'border-primary/40 text-primary',
};

const ROLE_TONE: Record<CalleeRole, string> = {
  tenant: 'border-primary/30 bg-primary/10 text-primary',
  agent: 'border-success/30 bg-success/10 text-success',
  sub_agent: 'border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-300',
  partner: 'border-warning/30 bg-warning/10 text-warning',
  landlord: 'border-accent bg-accent/40 text-accent-foreground',
  employee: 'border-destructive/30 bg-destructive/10 text-destructive',
};

const STATUS_OPTIONS: { value: PeopleStatusFilter; label: string }[] = [
  { value: 'all', label: 'Any call status' },
  { value: 'never', label: 'Not called yet' },
  { value: 'answered', label: 'Answered' },
  { value: 'rejected', label: 'Rejected' },
  { value: 'not_reachable', label: 'Not reachable' },
  { value: 'in_progress', label: 'In progress' },
];

const SORT_OPTIONS: { value: PeopleSort; label: string }[] = [
  { value: 'name', label: 'Name (A–Z)' },
  { value: 'recent_call', label: 'Most recently called' },
  { value: 'newest', label: 'Newest users first' },
];

/** Every audience this person genuinely belongs to. */
function RoleBadges({ roles }: { roles: CalleeRole[] }) {
  if (!roles.length) {
    return <span className="text-[11px] text-muted-foreground">Platform user</span>;
  }
  return (
    <div className="flex flex-wrap gap-1">
      {roles.map((r) => (
        <Badge key={r} variant="outline" className={cn('px-1.5 py-0 text-[10px] font-semibold', ROLE_TONE[r])}>
          {CALLEE_ROLE_BADGE[r]}
        </Badge>
      ))}
    </div>
  );
}

function StatusBadge({ status }: { status: CallOutcome | null }) {
  return (
    <Badge
      variant="outline"
      className={cn('text-[10px]', status ? OUTCOME_TONE[status] : 'text-muted-foreground')}
    >
      {status ? OUTCOME_LABEL[status] : 'Not called'}
    </Badge>
  );
}

function PersonIdentity({ person, onOpen }: { person: PlatformPerson; onOpen: () => void }) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className="group flex w-full min-w-0 items-center gap-2.5 text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      aria-label={`Open ${person.name} call summaries`}
    >
      <Avatar className="h-8 w-8 shrink-0">
        <AvatarImage src={person.avatarUrl ?? undefined} alt="" />
        <AvatarFallback className="bg-primary/10 text-[10px] text-primary">{initials(person.name)}</AvatarFallback>
      </Avatar>
      <span className="min-w-0">
        <span className="block truncate text-sm font-semibold text-foreground group-hover:text-primary">
          {person.name}
        </span>
        <span className="flex items-center gap-1 text-[10px] text-muted-foreground">
          {person.totalCalls} call{person.totalCalls === 1 ? '' : 's'}
          {person.summaries > 0 && (
            <>
              <FileText className="h-2.5 w-2.5" aria-hidden />
              {person.summaries}
            </>
          )}
        </span>
      </span>
    </button>
  );
}

interface CallCentrePeopleProps {
  /** Which queue's people to list. Locks the audience filter. */
  section: CallSection;
}

export function CallCentrePeople({ section }: CallCentrePeopleProps) {
  // This panel stacks two sheets (dialer over summary history), which is the
  // exact case where Radix leaves <body> pointer-events:none and swallows the
  // next click.
  useRestoreBodyPointerEvents();
  const { target, preview, dial, dialPreview, close } = useCallDialer();
  const counts = usePlatformPeopleCounts();

  const [queryInput, setQueryInput] = useState('');
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState<PeopleStatusFilter>('all');
  // Narrows within the queue. null = the whole queue.
  const [subtype, setSubtype] = useState<string | null>(null);
  const [sort, setSort] = useState<PeopleSort>('name');
  const [page, setPage] = useState(0);
  const [historyFor, setHistoryFor] = useState<PlatformPerson | null>(null);

  // Debounce the search so typing does not fire a query per keystroke.
  useEffect(() => {
    const t = setTimeout(() => setSearch(queryInput), 300);
    return () => clearTimeout(t);
  }, [queryInput]);

  // Any filter change restarts paging — page 3 of the old result set is meaningless.
  useEffect(() => setPage(0), [search, status, section, sort, subtype]);
  // Moving between queues must clear a filter that does not exist there.
  useEffect(() => setSubtype(null), [section]);

  // The audience is now the section you are standing in, so `role` is pinned
  // rather than chosen. `crm_platform_people_page` accepts queue names as well
  // as raw roles, so 'operational_agent' and 'proxy_agent' resolve here too.
  //
  // GEMINI: the role selector this used to drive is now redundant inside a
  // queue - it should come out of the filter bar. Status, sort and search all
  // still apply and should stay.
  const { rows, total, isLoading, isFetching, error } = usePlatformPeople({
    search, role: section, subtype, status, sort, page,
  });

  // Three queues have nothing to narrow by, so they render no filter at all.
  const filters = CALL_SECTION_FILTERS[section];

  const from = total === 0 ? 0 : page * PEOPLE_PAGE_SIZE + 1;
  const to = Math.min(total, (page + 1) * PEOPLE_PAGE_SIZE);
  const hasNext = to < total;
  const hasPrev = page > 0;

  const activeChips = useMemo(() => {
    const chips: { key: string; label: string; clear: () => void }[] = [];
    if (search) chips.push({ key: 'q', label: `Search: ${search}`, clear: () => setQueryInput('') });
    if (subtype !== null) {
      chips.push({
        key: 'subtype',
        label: filters.find((f) => f.value === subtype)?.label ?? String(subtype),
        clear: () => setSubtype(null),
      });
    }
    if (status !== 'all') {
      chips.push({
        key: 'status',
        label: STATUS_OPTIONS.find((s) => s.value === status)?.label ?? status,
        clear: () => setStatus('all'),
      });
    }
    if (sort !== 'name') {
      chips.push({
        key: 'sort',
        label: SORT_OPTIONS.find((s) => s.value === sort)?.label ?? sort,
        clear: () => setSort('name'),
      });
    }
    return chips;
  }, [search, subtype, filters, status, sort]);

  const clearAll = () => {
    setQueryInput('');
    setSubtype(null);
    setStatus('all');
    setSort('name');
  };

  const dialTarget = (person: PlatformPerson): DialTarget => ({
    calleeId: person.calleeId,
    name: person.name,
    phone: person.phone,
    avatarUrl: person.avatarUrl,
    role: primaryRole(person.roles),
    location: person.location,
    roles: person.roles,
  });

  if (error) {
    return (
      <Card>
        <CardContent className="p-6 text-sm text-destructive">
          Could not load the people directory. Refresh to try again.
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div className="min-w-0">
          <h2 className="text-base font-bold text-foreground">People / Calls</h2>
          <p className="text-xs text-muted-foreground">
            Every platform user the call centre can reach. Tap a name to read their call summaries.
          </p>
        </div>
        {counts && (
          <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
            <Users className="h-3.5 w-3.5" aria-hidden />
            <span className="font-semibold text-foreground">{counts.all.toLocaleString()}</span> users
            {CALLEE_ROLES.map((r) => (
              <span key={r} className="rounded-md bg-muted px-1.5 py-0.5">
                {CALLEE_ROLE_LABEL[r]} {(counts[r] ?? 0).toLocaleString()}
              </span>
            ))}
          </div>
        )}
      </div>

      {/* Filter bar — real controls, server-side filtering. */}
      <Card>
        <CardContent className="space-y-2 p-3">
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-4">
            <div className="space-y-1 lg:col-span-2">
              <Label className="text-[11px] text-muted-foreground">Search</Label>
              <div className="relative">
                <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
                <Input
                  value={queryInput}
                  onChange={(e) => setQueryInput(e.target.value)}
                  placeholder="Name or phone number"
                  className="h-9 pl-9 text-sm"
                  aria-label="Search people"
                />
                {queryInput && (
                  <button
                    type="button"
                    onClick={() => setQueryInput('')}
                    className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                    aria-label="Clear search"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                )}
              </div>
            </div>

            {filters.length > 0 && (
              <div className="space-y-1">
                <Label className="text-[11px] text-muted-foreground">
                  {CALL_SECTION_LABEL[section]}
                </Label>
                <Select
                  value={subtype ?? '__all__'}
                  onValueChange={(v) => setSubtype(v === '__all__' ? null : v)}
                >
                  <SelectTrigger className="h-9 text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {filters.map((f) => (
                      <SelectItem
                        key={f.value ?? '__all__'}
                        value={f.value ?? '__all__'}
                        className="text-xs"
                      >
                        {f.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}

            <div className="space-y-1">
              <Label className="text-[11px] text-muted-foreground">Call status</Label>
              <Select value={status} onValueChange={(v) => setStatus(v as PeopleStatusFilter)}>
                <SelectTrigger className="h-9 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {STATUS_OPTIONS.map((s) => (
                    <SelectItem key={s.value} value={s.value} className="text-xs">{s.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1 lg:col-span-1">
              <Label className="text-[11px] text-muted-foreground">Sort</Label>
              <Select value={sort} onValueChange={(v) => setSort(v as PeopleSort)}>
                <SelectTrigger className="h-9 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {SORT_OPTIONS.map((s) => (
                    <SelectItem key={s.value} value={s.value} className="text-xs">{s.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          {activeChips.length > 0 && (
            <div className="flex flex-wrap items-center gap-1.5 rounded-lg bg-muted/60 px-2 py-1.5">
              <SlidersHorizontal className="h-3 w-3 text-primary" aria-hidden />
              <span className="text-[11px] font-semibold">{total.toLocaleString()} matching</span>
              {activeChips.map((c) => (
                <Badge key={c.key} variant="outline" className="gap-1 px-1.5 py-0 text-[10px]">
                  {c.label}
                  <button type="button" onClick={c.clear} aria-label={`Clear ${c.label}`}>
                    <X className="h-2.5 w-2.5" />
                  </button>
                </Badge>
              ))}
              <Button size="sm" variant="ghost" className="h-6 px-2 text-[11px] sm:ml-auto" onClick={clearAll}>
                Clear all
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      {isLoading ? (
        <div className="space-y-2">
          <Skeleton className="h-64 w-full rounded-xl" />
        </div>
      ) : rows.length === 0 ? (
        <Card>
          <CardContent className="p-8 text-center text-sm text-muted-foreground">
            Nobody matches those filters.
          </CardContent>
        </Card>
      ) : (
        <>
          {/* Mobile: stacked cards. Desktop: table. */}
          <div className="space-y-2 lg:hidden">
            {rows.map((person) => (
              <Card key={person.calleeId}>
                <CardContent className="space-y-2 p-3">
                  <div className="flex items-start justify-between gap-2">
                    <PersonIdentity person={person} onOpen={() => setHistoryFor(person)} />
                    <div className="flex shrink-0 items-center gap-1.5">
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        className="gap-1.5"
                        onClick={() => dialPreview(dialTarget(person))}
                        aria-label={`Open the call screen for ${person.name} without dialling`}
                        title="Opens the call screen as it looks while dialling, without calling anyone"
                      >
                        <Eye className="h-3.5 w-3.5" />
                        Test
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        className="gap-1.5"
                        onClick={() => dial(dialTarget(person))}
                        aria-label={`Call ${person.name}`}
                      >
                        <PhoneCall className="h-3.5 w-3.5" />
                        Call
                      </Button>
                    </div>
                  </div>
                  <RoleBadges roles={person.roles} />
                  <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
                    <span className="tabular-nums">{person.phone}</span>
                    <span>{person.location ?? '—'}</span>
                    <span className="flex items-center gap-1">
                      <StatusBadge status={person.status} />
                    </span>
                    <span className="tabular-nums">{formatCallStamp(person.calledAt)}</span>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>

          <Card className="hidden lg:block">
            <CardContent className="p-0">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="py-2.5 pl-4 pr-2 font-medium">User</TableHead>
                    <TableHead className="py-2.5 px-2 font-medium whitespace-nowrap">Phone number</TableHead>
                    <TableHead className="py-2.5 px-2 font-medium whitespace-nowrap">Location</TableHead>
                    <TableHead className="py-2.5 px-2 font-medium whitespace-nowrap">Roles held</TableHead>
                    <TableHead className="py-2.5 px-2 font-medium whitespace-nowrap">Status</TableHead>
                    <TableHead className="py-2.5 px-2 font-medium whitespace-nowrap">Called at</TableHead>
                    <TableHead className="py-2.5 px-2 font-medium whitespace-nowrap">Recalled at</TableHead>
                    <TableHead className="py-2.5 pl-2 pr-4 text-right font-medium">Call</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((person) => (
                    <TableRow key={person.calleeId}>
                      <TableCell className="py-2.5 pl-4 pr-2">
                        <PersonIdentity person={person} onOpen={() => setHistoryFor(person)} />
                      </TableCell>
                      <TableCell className="py-2.5 px-2 text-xs tabular-nums text-muted-foreground whitespace-nowrap">
                        {person.phone}
                      </TableCell>
                      <TableCell className="py-2.5 px-2 text-xs text-muted-foreground">
                        {person.location ?? '—'}
                      </TableCell>
                      <TableCell className="py-2.5 px-2">
                        <RoleBadges roles={person.roles} />
                      </TableCell>
                      <TableCell className="py-2.5 px-2 whitespace-nowrap">
                        <StatusBadge status={person.status} />
                      </TableCell>
                      <TableCell className="py-2.5 px-2 whitespace-nowrap text-xs tabular-nums text-muted-foreground">
                        {formatCallStamp(person.calledAt)}
                      </TableCell>
                      <TableCell className="py-2.5 px-2 whitespace-nowrap text-xs tabular-nums text-muted-foreground">
                        {person.recalledAt ? formatCallStamp(person.recalledAt) : '—'}
                      </TableCell>
                      <TableCell className="py-2.5 pl-2 pr-4 text-right whitespace-nowrap">
                        <div className="flex items-center justify-end gap-1.5">
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            className="h-8 px-2.5 text-xs gap-1.5"
                            onClick={() => dialPreview(dialTarget(person))}
                            aria-label={`Open the call screen for ${person.name} without dialling`}
                            title="Opens the call screen as it looks while dialling, without calling anyone"
                          >
                            <Eye className="h-3.5 w-3.5" />
                            Test
                          </Button>
                          <Button
                            type="button"
                            size="sm"
                            className="h-8 px-2.5 text-xs gap-1.5 shadow-sm"
                            onClick={() => dial(dialTarget(person))}
                            aria-label={`Call ${person.name}`}
                          >
                            <PhoneCall className="h-3.5 w-3.5" />
                            Call
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>

          {/* Server-side paging, 20 per fetch. */}
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
              Showing <span className="font-semibold text-foreground">{from.toLocaleString()}–{to.toLocaleString()}</span>
              of <span className="font-semibold text-foreground">{total.toLocaleString()}</span>
              {isFetching && <Loader2 className="h-3 w-3 animate-spin" aria-hidden />}
            </p>
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={!hasPrev || isFetching}
                onClick={() => setPage((p) => Math.max(0, p - 1))}
              >
                <ChevronLeft className="mr-1 h-3.5 w-3.5" />
                Previous
              </Button>
              <span className="text-[11px] tabular-nums text-muted-foreground">
                Page {page + 1} of {Math.max(1, Math.ceil(total / PEOPLE_PAGE_SIZE)).toLocaleString()}
              </span>
              <Button
                variant="outline"
                size="sm"
                disabled={!hasNext || isFetching}
                onClick={() => setPage((p) => p + 1)}
              >
                Next
                <ChevronRight className="ml-1 h-3.5 w-3.5" />
              </Button>
            </div>
          </div>
        </>
      )}

      <CallSummaryHistorySheet
        calleeId={historyFor?.calleeId ?? null}
        name={historyFor?.name ?? ''}
        phone={historyFor?.phone ?? ''}
        avatarUrl={historyFor?.avatarUrl ?? null}
        open={!!historyFor}
        onOpenChange={(o) => !o && setHistoryFor(null)}
        onCall={() => {
          if (!historyFor) return;
          const next = dialTarget(historyFor);
          setHistoryFor(null);
          dial(next);
        }}
      />

      <CallDrawer target={target} open={!!target} preview={preview} onOpenChange={(o) => !o && close()} />
    </div>
  );
}
