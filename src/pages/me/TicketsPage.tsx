import { useCallback, useEffect, useRef, useState } from 'react';
import { usePolling } from '@/hooks/usePolling';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Eye, Inbox, Ticket, Clock3 } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';
import PersonalLayout from '@/components/layout/PersonalLayout';
import { getMyStaff } from '@/hr/api';
import { supabase } from '@/hr/api/client';
import RaiseTicket from '@/hr/components/RaiseTicket';
import TicketDetailDialog, { type TicketPeople } from '@/hr/components/TicketDetailDialog';

interface QueueRow {
  id: string;
  ref: string;
  title: string;
  body: string | null;
  severity: string;
  raised_at: string;
  raised_by: string | null;
  origin?: string | null;
  reported_at?: string | null;
  reporter_name?: string | null;
  reporter_contact?: string | null;
  reporter_channel?: string | null;
  reporter_words?: string | null;
  severity_basis?: string | null;
  resolution_summary?: string | null;
  close_reason?: string | null;
  task_id?: string | null;
  closed_no_task_at?: string | null;
  hr_ticket_surfaces?: { label: string } | null;
}

const SEVERITY_LABEL: Record<string, string> = {
  critical: 'Critical',
  high: 'High',
  normal: 'Normal',
};

const SEVERITY_BADGE: Record<string, string> = {
  critical: 'bg-destructive/10 text-destructive border-destructive/30',
  high: 'bg-warning/10 text-warning-foreground border-warning/40 dark:text-warning',
  normal: 'bg-muted text-muted-foreground border-border',
};

const STATE_BADGE: Record<string, string> = {
  Closed: 'bg-muted text-muted-foreground border-border',
  'Being worked on': 'bg-primary/10 text-primary border-primary/30',
  'Waiting to be picked up': 'bg-warning/10 text-warning-foreground border-warning/40 dark:text-warning',
};

function SeverityBadge({ severity }: { severity: string }) {
  return (
    <Badge
      variant="outline"
      className={cn(
        'rounded-full px-2.5 py-0.5 text-[11px] font-medium',
        SEVERITY_BADGE[severity] ?? SEVERITY_BADGE.normal,
      )}
    >
      {SEVERITY_LABEL[severity] ?? severity}
    </Badge>
  );
}

function StateBadge({ label }: { label: string }) {
  return (
    <Badge
      variant="outline"
      className={cn(
        'rounded-full px-2.5 py-0.5 text-[11px] font-medium',
        STATE_BADGE[label] ?? 'bg-muted text-muted-foreground border-border',
      )}
    >
      {label}
    </Badge>
  );
}

const headCell =
  'h-10 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground';

function when(value: string | null) {
  if (!value) return '—';
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString();
}

function compactName(fullName?: string | null) {
  if (!fullName) return '';
  const parts = fullName.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '';
  const [first, ...rest] = parts;
  const initials = rest.map((p) => `${p[0]?.toUpperCase()}.`).join(' ');
  return initials ? `${first} ${initials}` : first;
}

/** Short beep for a newly raised ticket. Blocked audio must never break the UI. */
function playChime() {
  try {
    const Ctx =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.frequency.value = 880;
    gain.gain.value = 0.05;
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.15);
    window.setTimeout(() => {
      try {
        void ctx.close();
      } catch {
        /* ignore */
      }
    }, 300);
  } catch {
    /* ignore — audio is optional */
  }
}

const TicketsPage = () => {
  const [staff, setStaff] = useState<Awaited<ReturnType<typeof getMyStaff>>>(null);
  const [loadingStaff, setLoadingStaff] = useState(true);
  const [isEngineering, setIsEngineering] = useState(false);
  const [canAssign, setCanAssign] = useState(false);
  const [queue, setQueue] = useState<QueueRow[]>([]);
  const queueLoadedRef = useRef(false);
  const knownQueueIdsRef = useRef<Set<string> | null>(null);
  const [mine, setMine] = useState<QueueRow[]>([]);
  const [creatorNames, setCreatorNames] = useState<Record<string, string>>({});
  const [ticketPeople, setTicketPeople] = useState<Record<string, TicketPeople>>({});
  const [viewing, setViewing] = useState<QueueRow | null>(null);
  const [claiming, setClaiming] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const me = await getMyStaff();
        if (cancelled) return;
        setStaff(me);
      } finally {
        if (!cancelled) setLoadingStaff(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Ask the backend for the authoritative booleans; definer rights bypass RLS blind spots.
  useEffect(() => {
    if (!staff?.id) return;
    let cancelled = false;
    (async () => {
      const [{ data: engData, error: engError }, { data: assignData, error: assignError }] = await Promise.all([
        supabase.rpc('hr_is_engineering'),
        supabase.rpc('hr_can_assign_tasks'),
      ]);
      if (cancelled) return;
      if (engError) {
        console.error('hr_is_engineering', engError);
      }
      if (assignError) {
        console.error('hr_can_assign_tasks', assignError);
      }
      setIsEngineering(!!engData);
      setCanAssign(!!assignData);
    })();
    return () => {
      cancelled = true;
    };
  }, [staff?.id]);

  const loadQueue = useCallback(async () => {
    const { data, error } = await supabase
      .from('hr_tickets')
      .select(
        'id, ref, title, body, severity, raised_at, raised_by, origin, reported_at, reporter_name, reporter_contact, reporter_channel, reporter_words, severity_basis, resolution_summary, close_reason, task_id, closed_no_task_at, hr_ticket_surfaces(label)',
      )
      .is('task_id', null)
      .is('closed_no_task_at', null)
      .order('raised_at', { ascending: true });
    if (error) return;
    queueLoadedRef.current = true;
    setQueue((data ?? []) as unknown as QueueRow[]);
  }, []);

  const loadMine = useCallback(async () => {
    if (!staff?.id) return;
    const { data, error } = await supabase
      .from('hr_tickets')
      .select(
        'id, ref, title, body, severity, raised_at, raised_by, origin, reported_at, reporter_name, reporter_contact, reporter_channel, reporter_words, severity_basis, resolution_summary, close_reason, task_id, closed_no_task_at, hr_ticket_surfaces(label)',
      )
      .eq('raised_by', staff.id)
      .order('raised_at', { ascending: false });
    if (error) return;
    setMine((data ?? []) as unknown as QueueRow[]);
  }, [staff?.id]);

  useEffect(() => {
    if (!staff?.id) return;
    void loadQueue();
    void loadMine();
  }, [staff?.id, loadQueue, loadMine]);

  // Resolve ticket people through a definer RPC: hr_staff/profiles are RLS-restricted,
  // so a direct client join returns nothing for other people's tickets.
  useEffect(() => {
    const rows = [...queue, ...mine];
    if (!rows.length) return;
    const ids = Array.from(new Set(rows.map((r) => r.id)));
    let cancelled = false;
    (async () => {
      const { data, error } = await supabase.rpc('hr_ticket_people', { p_ticket_ids: ids });
      if (cancelled) return;
      if (error) {
        console.error('hr_ticket_people', error);
        return;
      }
      const people: Record<string, TicketPeople> = {};
      const names: Record<string, string> = {};
      (data ?? []).forEach((r: any) => {
        people[r.ticket_id] = {
          raised_by_name: r.raised_by_name,
          closed_by_name: r.closed_by_name,
          assignee_name: r.assignee_name,
          task_title: r.task_title,
        };
        names[r.ticket_id] = compactName(r.raised_by_name) || '—';
      });
      setTicketPeople(people);
      setCreatorNames(names);
    })();
    return () => {
      cancelled = true;
    };
  }, [queue, mine]);

  // Only people who can act on the queue get the auto-refresh + new-ticket
  // alert. Polled every 60s: hr_tickets is not in the Realtime publication,
  // so the old INSERT listener never fired (doc 147).
  const notifyNewTickets = !!staff?.id && (isEngineering || canAssign);
  const { lastUpdatedAt: queueUpdatedAt, refresh: refreshQueue } = usePolling(
    loadQueue,
    60_000,
    { enabled: notifyNewTickets },
  );

  // Toast + chime for tickets that appear between polls. Skipped until the
  // first real load so the existing queue never alerts.
  useEffect(() => {
    if (!queueLoadedRef.current) return;
    const ids = new Set(queue.map((q) => q.id));
    const known = knownQueueIdsRef.current;
    knownQueueIdsRef.current = ids;
    if (!known || !notifyNewTickets) return;
    const fresh = queue.filter((q) => !known.has(q.id));
    if (fresh.length === 0) return;
    toast('New ticket raised', {
      description: fresh.length === 1 ? fresh[0].title : `${fresh.length} new tickets`,
    });
    playChime();
  }, [queue, notifyNewTickets]);

  const claim = async (ticket: QueueRow) => {
    setClaiming(ticket.id);
    try {
      const { error } = await supabase.rpc('hr_claim_ticket', { p_ticket_id: ticket.id });
      if (error) {
        toast.error(error.message);
        return;
      }
      toast.success(`Ticket ${ticket.ref} claimed`);
      setViewing(null);
      await loadQueue();
      await loadMine();
    } finally {
      setClaiming(null);
    }
  };

  const state = (row: QueueRow) => {
    if (row.closed_no_task_at) return 'Closed';
    if (row.task_id) return 'Being worked on';
    return 'Waiting to be picked up';
  };

  if (!loadingStaff && !staff) {
    return (
      <PersonalLayout title="Tickets">
        <p className="text-sm text-muted-foreground">This page is for members of the team.</p>
      </PersonalLayout>
    );
  }

  return (
    <PersonalLayout title="Tickets">
      <div className="space-y-4">
        <RaiseTicket staffId={staff?.id ?? null} />

        <Card className="overflow-hidden border-border/70 shadow-card">
          <CardHeader className="flex flex-row items-center justify-between gap-3 space-y-0 border-b border-border/60 bg-muted/30 px-4 py-3">
            <div className="flex items-center gap-2.5">
              <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-warning/10 text-warning-foreground dark:text-warning">
                <Clock3 className="h-4 w-4" />
              </span>
              <div>
                <CardTitle className="text-sm font-semibold tracking-tight">
                  Waiting to be picked up
                </CardTitle>
                <p className="text-[11px] text-muted-foreground">Oldest first</p>
              </div>
            </div>
            <Badge
              variant="outline"
              className="rounded-full border-primary/30 bg-primary/10 px-2.5 py-0.5 text-[11px] font-semibold text-primary"
            >
              {queue.length}
            </Badge>
          </CardHeader>
          <CardContent className="p-0">
            {queue.length === 0 ? (
              <div className="flex flex-col items-center gap-2 px-4 py-10 text-center">
                <span className="flex h-10 w-10 items-center justify-center rounded-full bg-muted text-muted-foreground">
                  <Inbox className="h-5 w-5" />
                </span>
                <p className="text-sm font-medium">Nothing waiting right now</p>
                <p className="text-xs text-muted-foreground">New tickets appear here instantly.</p>
              </div>
            ) : (
              <Table>
                <TableHeader className="[&_tr]:border-b [&_tr]:border-border/60">
                  <TableRow className="bg-muted/40 hover:bg-muted/40">
                    <TableHead className={headCell}>Ref</TableHead>
                    <TableHead className={headCell}>Title</TableHead>
                    <TableHead className={headCell}>Raised by</TableHead>
                    <TableHead className={headCell}>Area</TableHead>
                    <TableHead className={headCell}>How bad</TableHead>
                    <TableHead className={headCell}>Raised</TableHead>
                    <TableHead className={cn(headCell, 'w-[64px] text-center')}>View</TableHead>
                    <TableHead className={cn(headCell, 'text-right')}>Action</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {queue.map((row) => (
                    <TableRow
                      key={row.id}
                      className="border-border/50 transition-colors hover:bg-primary/[0.04]"
                    >
                      <TableCell className="py-3 font-mono text-xs font-medium text-muted-foreground">
                        {row.ref}
                      </TableCell>
                      <TableCell className="max-w-[280px] py-3 text-sm font-medium text-foreground">
                        {row.title}
                      </TableCell>
                      <TableCell className="py-3 text-xs text-muted-foreground">
                        {creatorNames[row.id] || '—'}
                      </TableCell>
                      <TableCell className="py-3 text-xs text-muted-foreground">
                        {row.hr_ticket_surfaces?.label ?? '—'}
                      </TableCell>
                      <TableCell className="py-3">
                        <SeverityBadge severity={row.severity} />
                      </TableCell>
                      <TableCell className="py-3 text-xs tabular-nums text-muted-foreground">
                        {when(row.raised_at)}
                      </TableCell>
                      <TableCell className="py-3 text-center">
                        <Button
                          size="icon"
                          variant="ghost"
                          className="h-8 w-8 rounded-full text-muted-foreground transition-colors hover:bg-primary/10 hover:text-primary focus-visible:ring-2 focus-visible:ring-ring"
                          aria-label={`View ticket ${row.ref}`}
                          onClick={() => setViewing(row)}
                        >
                          <Eye className="h-4 w-4" />
                        </Button>
                      </TableCell>
                      <TableCell className="py-3 text-right">
                        {isEngineering ? (
                          <Button
                            size="sm"
                            variant="outline"
                            className="h-8 rounded-full border-primary/30 bg-primary/5 px-3 text-xs font-semibold text-primary transition-colors hover:bg-primary hover:text-primary-foreground"
                            disabled={claiming === row.id}
                            onClick={() => void claim(row)}
                          >
                            {claiming === row.id ? 'Claiming…' : 'Claim'}
                          </Button>
                        ) : null}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>

        <Card className="overflow-hidden border-border/70 shadow-card">
          <CardHeader className="flex flex-row items-center justify-between gap-3 space-y-0 border-b border-border/60 bg-muted/30 px-4 py-3">
            <div className="flex items-center gap-2.5">
              <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary/10 text-primary">
                <Ticket className="h-4 w-4" />
              </span>
              <div>
                <CardTitle className="text-sm font-semibold tracking-tight">My tickets</CardTitle>
                <p className="text-[11px] text-muted-foreground">Everything you raised</p>
              </div>
            </div>
            <Badge
              variant="outline"
              className="rounded-full border-primary/30 bg-primary/10 px-2.5 py-0.5 text-[11px] font-semibold text-primary"
            >
              {mine.length}
            </Badge>
          </CardHeader>
          <CardContent className="p-0">
            {mine.length === 0 ? (
              <div className="flex flex-col items-center gap-2 px-4 py-10 text-center">
                <span className="flex h-10 w-10 items-center justify-center rounded-full bg-muted text-muted-foreground">
                  <Ticket className="h-5 w-5" />
                </span>
                <p className="text-sm font-medium">You have not raised any yet</p>
                <p className="text-xs text-muted-foreground">Use the form above to raise one.</p>
              </div>
            ) : (
              <Table>
                <TableHeader className="[&_tr]:border-b [&_tr]:border-border/60">
                  <TableRow className="bg-muted/40 hover:bg-muted/40">
                    <TableHead className={headCell}>Ref</TableHead>
                    <TableHead className={headCell}>Title</TableHead>
                    <TableHead className={headCell}>Area</TableHead>
                    <TableHead className={headCell}>How bad</TableHead>
                    <TableHead className={headCell}>Raised</TableHead>
                    <TableHead className={headCell}>State</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {mine.map((row) => (
                    <TableRow
                      key={row.id}
                      className="border-border/50 transition-colors hover:bg-primary/[0.04]"
                    >
                      <TableCell className="py-3 font-mono text-xs font-medium text-muted-foreground">
                        {row.ref}
                      </TableCell>
                      <TableCell className="max-w-[280px] py-3 text-sm font-medium text-foreground">
                        {row.title}
                      </TableCell>
                      <TableCell className="py-3 text-xs text-muted-foreground">
                        {row.hr_ticket_surfaces?.label ?? '—'}
                      </TableCell>
                      <TableCell className="py-3">
                        <SeverityBadge severity={row.severity} />
                      </TableCell>
                      <TableCell className="py-3 text-xs tabular-nums text-muted-foreground">
                        {when(row.raised_at)}
                      </TableCell>
                      <TableCell className="py-3">
                        <StateBadge label={state(row)} />
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>

        <TicketDetailDialog
          ticket={viewing}
          people={viewing ? ticketPeople[viewing.id] : undefined}
          creatorLabel={viewing ? creatorNames[viewing.id] : undefined}
          stateLabel={viewing ? state(viewing) : ''}
          severityLabel={
            viewing ? SEVERITY_LABEL[viewing.severity] ?? viewing.severity : ''
          }
          canClaim={
            !!viewing && isEngineering && !viewing.task_id && !viewing.closed_no_task_at
          }
          claiming={claiming === viewing?.id}
          onClaim={() => (viewing ? claim(viewing) : undefined)}
          onOpenChange={(open) => {
            if (!open) setViewing(null);
          }}
        />
      </div>
    </PersonalLayout>
  );
};

export default TicketsPage;
