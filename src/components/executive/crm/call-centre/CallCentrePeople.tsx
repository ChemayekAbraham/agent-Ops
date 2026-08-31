import { useMemo, useState } from 'react';
import { FileText, PhoneCall, Search } from 'lucide-react';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { cn } from '@/lib/utils';
import {
  CALLEE_ROLES, CALLEE_ROLE_LABEL, deriveOutcome, formatCallStamp, OUTCOME_LABEL,
  type CalleeRole, type CallOutcome, type CallRecord,
} from '@/lib/callCentre';
import { useCallRecords } from '@/hooks/useCrmCallCentre';
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

/**
 * One row per person, folded from their call history.
 *
 * `calledAt` is the FIRST call and `recalledAt` the most recent one — a person
 * called once has no recall, which is why `recalledAt` is nullable rather than
 * duplicating `calledAt`.
 */
interface PersonRow {
  calleeId: string;
  name: string;
  phone: string;
  avatarUrl: string | null;
  role: CalleeRole;
  location: string | null;
  status: CallOutcome;
  calledAt: string;
  recalledAt: string | null;
  totalCalls: number;
  summaries: number;
  /** The call id the newest summary belongs to, for the history sheet. */
  lastCallId: string;
}

function foldPeople(records: CallRecord[]): PersonRow[] {
  const byPerson = new Map<string, CallRecord[]>();
  for (const record of records) {
    const list = byPerson.get(record.calleeId);
    if (list) list.push(record);
    else byPerson.set(record.calleeId, [record]);
  }

  const rows: PersonRow[] = [];
  for (const [calleeId, calls] of byPerson) {
    const chronological = [...calls].sort(
      (a, b) => new Date(a.calledAt).getTime() - new Date(b.calledAt).getTime(),
    );
    const first = chronological[0];
    const latest = chronological[chronological.length - 1];

    rows.push({
      calleeId,
      name: latest.calleeName,
      phone: latest.calleePhone,
      avatarUrl: latest.calleeAvatarUrl,
      role: latest.calleeRole,
      location: latest.location,
      // Status reflects the newest attempt — that is what a follow-up acts on.
      status: deriveOutcome(latest),
      calledAt: first.calledAt,
      recalledAt: chronological.length > 1 ? latest.calledAt : null,
      totalCalls: chronological.length,
      summaries: chronological.filter((c) => !!c.summary?.trim()).length,
      lastCallId: latest.id,
    });
  }

  return rows.sort(
    (a, b) =>
      new Date(b.recalledAt ?? b.calledAt).getTime() - new Date(a.recalledAt ?? a.calledAt).getTime() ||
      a.name.localeCompare(b.name),
  );
}

const STATUS_FILTERS: { value: CallOutcome | 'all'; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'answered', label: 'Answered' },
  { value: 'rejected', label: 'Rejected' },
  { value: 'not_reachable', label: 'Not reachable' },
];

export function CallCentrePeople() {
  // This panel stacks two sheets (dialer over summary history), which is the
  // exact case where Radix leaves <body> pointer-events:none and swallows the
  // next click.
  useRestoreBodyPointerEvents();
  const { data: records = [], isLoading, error } = useCallRecords();
  const { target, dial, close } = useCallDialer();

  const [query, setQuery] = useState('');
  const [status, setStatus] = useState<CallOutcome | 'all'>('all');
  const [role, setRole] = useState<CalleeRole | 'all'>('all');
  const [historyFor, setHistoryFor] = useState<PersonRow | null>(null);
  const [visible, setVisible] = useState(25);

  const people = useMemo(() => foldPeople(records), [records]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return people.filter((p) => {
      if (status !== 'all' && p.status !== status) return false;
      if (role !== 'all' && p.role !== role) return false;
      if (!q) return true;
      return [p.name, p.phone, p.location ?? ''].some((v) => v.toLowerCase().includes(q));
    });
  }, [people, query, status, role]);

  if (isLoading) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-10 w-full rounded-lg" />
        <Skeleton className="h-96 w-full rounded-xl" />
      </div>
    );
  }

  if (error) {
    return (
      <Card>
        <CardContent className="p-6 text-sm text-destructive">
          Could not load the call list. Refresh to try again.
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-3">
      <div>
        <h2 className="text-base font-bold text-foreground">People / Calls</h2>
        <p className="text-xs text-muted-foreground">
          Everyone the call centre has dialled. Tap a name to read their call summaries.
        </p>
      </div>

      {/* Filters in one row above the table. */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-[12rem] flex-1">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search name, phone or location"
            className="pl-9"
            aria-label="Search people"
          />
        </div>
        <ToggleGroup
          type="single"
          value={status}
          onValueChange={(v) => v && setStatus(v as CallOutcome | 'all')}
          aria-label="Filter by call status"
        >
          {STATUS_FILTERS.map((f) => (
            <ToggleGroupItem key={f.value} value={f.value} size="sm" className="px-2.5 text-[11px]">
              {f.label}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
        <ToggleGroup
          type="single"
          value={role}
          onValueChange={(v) => v && setRole(v as CalleeRole | 'all')}
          aria-label="Filter by role"
        >
          <ToggleGroupItem value="all" size="sm" className="px-2.5 text-[11px]">Everyone</ToggleGroupItem>
          {CALLEE_ROLES.map((r) => (
            <ToggleGroupItem key={r} value={r} size="sm" className="px-2.5 text-[11px]">
              {CALLEE_ROLE_LABEL[r]}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      </div>

      <Card>
        <CardContent className="p-0">
          {filtered.length === 0 ? (
            <p className="p-8 text-center text-sm text-muted-foreground">
              {people.length === 0 ? 'No calls recorded yet.' : 'Nobody matches those filters.'}
            </p>
          ) : (
            /* Wide table scrolls inside its own container so the page body
               never scrolls sideways. */
            <div className="w-full overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="min-w-[13rem]">Username</TableHead>
                    <TableHead className="min-w-[9rem]">Phone number</TableHead>
                    <TableHead className="min-w-[9rem]">Location</TableHead>
                    <TableHead className="min-w-[6rem]">Active role</TableHead>
                    <TableHead className="min-w-[8rem]">Status</TableHead>
                    <TableHead className="min-w-[8rem]">Called at</TableHead>
                    <TableHead className="min-w-[8rem]">Recalled at</TableHead>
                    <TableHead className="min-w-[6rem] text-right">Call</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filtered.slice(0, visible).map((person) => (
                    <TableRow key={person.calleeId}>
                      <TableCell>
                        <button
                          type="button"
                          onClick={() => setHistoryFor(person)}
                          className="group flex w-full items-center gap-2.5 text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                          aria-label={`Open ${person.name} call summaries`}
                        >
                          <Avatar className="h-8 w-8 shrink-0">
                            <AvatarImage src={person.avatarUrl ?? undefined} alt="" />
                            <AvatarFallback className="bg-primary/10 text-[10px] text-primary">
                              {initials(person.name)}
                            </AvatarFallback>
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
                      </TableCell>
                      <TableCell className="text-xs tabular-nums text-muted-foreground">{person.phone}</TableCell>
                      <TableCell className="text-xs text-muted-foreground">{person.location ?? '—'}</TableCell>
                      <TableCell>
                        <Badge variant="secondary" className="text-[10px]">
                          {CALLEE_ROLE_LABEL[person.role]}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        <Badge variant="outline" className={cn('text-[10px]', OUTCOME_TONE[person.status])}>
                          {OUTCOME_LABEL[person.status]}
                        </Badge>
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-xs tabular-nums text-muted-foreground">
                        {formatCallStamp(person.calledAt)}
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-xs tabular-nums text-muted-foreground">
                        {person.recalledAt ? formatCallStamp(person.recalledAt) : '—'}
                      </TableCell>
                      <TableCell className="text-right">
                        <Button
                          type="button"
                          size="sm"
                          className="gap-1.5"
                          onClick={() =>
                            dial({
                              calleeId: person.calleeId,
                              name: person.name,
                              phone: person.phone,
                              avatarUrl: person.avatarUrl,
                              role: person.role,
                              location: person.location,
                            } satisfies DialTarget)
                          }
                          aria-label={`Call ${person.name}`}
                        >
                          <PhoneCall className="h-3.5 w-3.5" />
                          Call
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      {filtered.length > visible && (
        <Button variant="outline" className="w-full" onClick={() => setVisible((v) => v + 25)}>
          Show more ({filtered.length - visible} left)
        </Button>
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
          const next: DialTarget = {
            calleeId: historyFor.calleeId,
            name: historyFor.name,
            phone: historyFor.phone,
            avatarUrl: historyFor.avatarUrl,
            role: historyFor.role,
            location: historyFor.location,
          };
          setHistoryFor(null);
          dial(next);
        }}
      />

      <CallDrawer target={target} open={!!target} onOpenChange={(o) => !o && close()} />
    </div>
  );
}
