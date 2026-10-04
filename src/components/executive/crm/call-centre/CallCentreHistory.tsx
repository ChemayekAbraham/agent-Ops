import { useMemo, useState } from 'react';
import { FileText, PhoneCall, Search, Timer } from 'lucide-react';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { cn } from '@/lib/utils';
import {
  CALLEE_ROLE_LABEL, computeKpis, deriveOutcome, formatCallStamp, formatTalkTime, labelTemperatures,
  OUTCOME_LABEL, type CallOutcome, type CallRecord,
  type CallSection,
} from '@/lib/callCentre';
import { useSectionCallRecords } from '@/hooks/useCrmCallCentre';
import { useRestoreBodyPointerEvents } from '@/hooks/useRestoreBodyPointerEvents';
import { CallDrawer } from './CallDrawer';
import { useCallDialer, type DialTarget } from './useCallDialer';

const initials = (name: string) =>
  name.trim().split(/\s+/).slice(0, 2).map((p) => p[0]?.toUpperCase() ?? '').join('') || '??';

const OUTCOME_TONE: Record<CallOutcome, string> = {
  answered: 'border-success/40 text-success',
  rejected: 'border-destructive/40 text-destructive',
  not_reachable: 'border-warning/40 text-warning',
  in_progress: 'border-primary/40 text-primary',
};

const FILTERS: { value: CallOutcome | 'all'; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'answered', label: 'Answered' },
  { value: 'rejected', label: 'Rejected' },
  { value: 'not_reachable', label: 'Not reachable' },
];

/** Day heading key, in the same local-day terms the KPIs bucket on. */
const dayHeading = (iso: string) => {
  const d = new Date(iso);
  const today = new Date();
  const yesterday = new Date(today.getTime() - 86_400_000);
  const sameDay = (a: Date, b: Date) =>
    a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

  if (sameDay(d, today)) return 'Today';
  if (sameDay(d, yesterday)) return 'Yesterday';
  return d.toLocaleDateString('en-GB', {
    weekday: 'short', day: '2-digit', month: 'short', timeZone: 'Africa/Kampala',
  });
};

interface CallCentreHistoryProps {
  /** Which queue's calls to list. */
  section: CallSection;
}

export function CallCentreHistory({ section }: CallCentreHistoryProps) {
  // The dialer sheet can leave <body> pointer-events:none behind on close.
  useRestoreBodyPointerEvents();
  // Membership resolved server-side - see useSectionCallRecords.
  const { records, isLoading, error } = useSectionCallRecords(section);
  const { target, dial, close } = useCallDialer();

  const [query, setQuery] = useState('');
  const [outcome, setOutcome] = useState<CallOutcome | 'all'>('all');
  const [visible, setVisible] = useState(40);

  const temperatures = useMemo(() => labelTemperatures(records), [records]);
  const kpis = useMemo(() => computeKpis(records), [records]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return records.filter((r) => {
      if (outcome !== 'all' && deriveOutcome(r) !== outcome) return false;
      if (!q) return true;
      return [r.calleeName, r.calleePhone, r.location ?? '', r.staffName ?? '', r.summary ?? '']
        .some((v) => v.toLowerCase().includes(q));
    });
  }, [records, query, outcome]);

  /** Group the visible slice by day so the log reads as a timeline. */
  const grouped = useMemo(() => {
    const out: { heading: string; calls: CallRecord[] }[] = [];
    for (const call of filtered.slice(0, visible)) {
      const heading = dayHeading(call.calledAt);
      const last = out[out.length - 1];
      if (last && last.heading === heading) last.calls.push(call);
      else out.push({ heading, calls: [call] });
    }
    return out;
  }, [filtered, visible]);

  if (isLoading) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-10 w-full rounded-lg" />
        {[0, 1, 2].map((i) => <Skeleton key={i} className="h-20 w-full rounded-xl" />)}
      </div>
    );
  }

  if (error) {
    return (
      <Card>
        <CardContent className="p-6 text-sm text-destructive">
          Could not load call history. Refresh to try again.
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-3">
      <div>
        <h2 className="text-base font-bold text-foreground">Call history</h2>
        <p className="text-xs text-muted-foreground">
          {kpis.totalCalls} calls · {kpis.answered} answered · {formatTalkTime(kpis.totalTalkSeconds)} total talk time
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-[12rem] flex-1">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search person, caller, or words in a summary"
            className="pl-9"
            aria-label="Search call history"
          />
        </div>
        <ToggleGroup
          type="single"
          value={outcome}
          onValueChange={(v) => v && setOutcome(v as CallOutcome | 'all')}
          aria-label="Filter by outcome"
        >
          {FILTERS.map((f) => (
            <ToggleGroupItem key={f.value} value={f.value} size="sm" className="px-2.5 text-[11px]">
              {f.label}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      </div>

      {filtered.length === 0 ? (
        <Card>
          <CardContent className="p-8 text-center text-sm text-muted-foreground">
            {records.length === 0 ? 'No calls recorded yet.' : 'No calls match those filters.'}
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-4">
          {grouped.map((group) => (
            <div key={group.heading}>
              <h3 className="mb-1.5 px-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                {group.heading}
              </h3>
              <Card>
                <CardContent className="divide-y divide-border/60 p-0">
                  {group.calls.map((call) => {
                    const settled = deriveOutcome(call);
                    return (
                      <div key={call.id} className="flex items-start gap-2.5 p-3">
                        <Avatar className="mt-0.5 h-9 w-9 shrink-0">
                          <AvatarImage src={call.calleeAvatarUrl ?? undefined} alt="" />
                          <AvatarFallback className="bg-primary/10 text-[11px] text-primary">
                            {initials(call.calleeName)}
                          </AvatarFallback>
                        </Avatar>

                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-1.5">
                            <span className="truncate text-sm font-semibold text-foreground">
                              {call.calleeName}
                            </span>
                            <Badge variant="outline" className={cn('text-[10px]', OUTCOME_TONE[settled])}>
                              {OUTCOME_LABEL[settled]}
                            </Badge>
                            <Badge variant="secondary" className="text-[10px]">
                              {temperatures.get(call.id) === 'warm' ? 'Warm' : 'Cold'}
                            </Badge>
                            <Badge variant="outline" className="text-[10px]">
                              {CALLEE_ROLE_LABEL[call.calleeRole]}
                            </Badge>
                          </div>

                          <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-muted-foreground">
                            <span className="tabular-nums">{formatCallStamp(call.calledAt)}</span>
                            <span className="tabular-nums">{call.calleePhone}</span>
                            {settled === 'answered' && (
                              <span className="inline-flex items-center gap-1 tabular-nums">
                                <Timer className="h-3 w-3" aria-hidden />
                                {formatTalkTime(call.durationSeconds)}
                              </span>
                            )}
                            {call.staffName && <span>by {call.staffName}</span>}
                          </div>

                          {call.summary?.trim() && (
                            <p className="mt-1.5 flex gap-1.5 rounded-md bg-muted/40 p-2 text-xs leading-snug text-foreground">
                              <FileText className="mt-0.5 h-3 w-3 shrink-0 text-muted-foreground" aria-hidden />
                              <span className="whitespace-pre-wrap">{call.summary}</span>
                            </p>
                          )}
                        </div>

                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          className="shrink-0 gap-1.5"
                          onClick={() =>
                            dial({
                              calleeId: call.calleeId,
                              name: call.calleeName,
                              phone: call.calleePhone,
                              avatarUrl: call.calleeAvatarUrl,
                              role: call.calleeRole,
                              location: call.location,
                            } satisfies DialTarget)
                          }
                          aria-label={`Call ${call.calleeName} again`}
                        >
                          <PhoneCall className="h-3.5 w-3.5" />
                          Recall
                        </Button>
                      </div>
                    );
                  })}
                </CardContent>
              </Card>
            </div>
          ))}
        </div>
      )}

      {filtered.length > visible && (
        <Button variant="outline" className="w-full" onClick={() => setVisible((v) => v + 40)}>
          Show more ({filtered.length - visible} left)
        </Button>
      )}

      <CallDrawer target={target} open={!!target} onOpenChange={(o) => !o && close()} />
    </div>
  );
}
