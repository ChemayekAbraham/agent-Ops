import { useCallback, useEffect, useState } from 'react';
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
import { toast } from 'sonner';
import PersonalLayout from '@/components/layout/PersonalLayout';
import { getMyStaff } from '@/hr/api';
import { supabase } from '@/hr/api/client';
import RaiseTicket from '@/hr/components/RaiseTicket';

interface QueueRow {
  id: string;
  ref: string;
  title: string;
  body: string | null;
  severity: string;
  raised_at: string;
  raised_by: string | null;
  task_id?: string | null;
  closed_no_task_at?: string | null;
  hr_ticket_surfaces?: { label: string } | null;
}

const SEVERITY_LABEL: Record<string, string> = {
  critical: 'Critical',
  high: 'High',
  normal: 'Normal',
};

function when(value: string | null) {
  if (!value) return '—';
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString();
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
  const [mine, setMine] = useState<QueueRow[]>([]);
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
      .select('id, ref, title, body, severity, raised_at, raised_by, hr_ticket_surfaces(label)')
      .is('task_id', null)
      .is('closed_no_task_at', null)
      .order('raised_at', { ascending: true });
    if (error) return;
    setQueue((data ?? []) as unknown as QueueRow[]);
  }, []);

  const loadMine = useCallback(async () => {
    if (!staff?.id) return;
    const { data, error } = await supabase
      .from('hr_tickets')
      .select(
        'id, ref, title, body, severity, raised_at, raised_by, task_id, closed_no_task_at, hr_ticket_surfaces(label)',
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

  // Only people who can act on the queue get a live subscription.
  useEffect(() => {
    if (!staff?.id) return;
    if (!(isEngineering || canAssign)) return;

    const channel = supabase
      .channel(`tickets-live-${staff.id}`)
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'hr_tickets' },
        (payload) => {
          void loadQueue();
          const row = payload.new as { title?: string } | null;
          toast('New ticket raised', { description: row?.title ?? undefined });
          playChime();
        },
      )
      .subscribe();

    return () => {
      void supabase.removeChannel(channel);
    };
  }, [staff?.id, isEngineering, canAssign, loadQueue]);

  const claim = async (ticket: QueueRow) => {
    setClaiming(ticket.id);
    try {
      const { error } = await supabase.rpc('hr_claim_ticket', { p_ticket_id: ticket.id });
      if (error) {
        toast.error(error.message);
        return;
      }
      toast.success(`Ticket ${ticket.ref} claimed`);
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

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Waiting to be picked up</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            {queue.length === 0 ? (
              <p className="p-4 text-center text-sm text-muted-foreground">Nothing waiting right now</p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Ref</TableHead>
                    <TableHead>Title</TableHead>
                    <TableHead>Area</TableHead>
                    <TableHead>How bad</TableHead>
                    <TableHead>Raised</TableHead>
                    <TableHead className="text-right">Action</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {queue.map((row) => (
                    <TableRow key={row.id}>
                      <TableCell className="font-mono text-xs">{row.ref}</TableCell>
                      <TableCell className="max-w-[280px] text-sm">{row.title}</TableCell>
                      <TableCell className="text-xs">{row.hr_ticket_surfaces?.label ?? '—'}</TableCell>
                      <TableCell className="text-xs">{SEVERITY_LABEL[row.severity] ?? row.severity}</TableCell>
                      <TableCell className="text-xs">{when(row.raised_at)}</TableCell>
                      <TableCell className="text-right">
                        {isEngineering ? (
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={claiming === row.id}
                            onClick={() => void claim(row)}
                          >
                            Claim
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

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">My tickets</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            {mine.length === 0 ? (
              <p className="p-4 text-center text-sm text-muted-foreground">You have not raised any yet</p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Ref</TableHead>
                    <TableHead>Title</TableHead>
                    <TableHead>Area</TableHead>
                    <TableHead>How bad</TableHead>
                    <TableHead>Raised</TableHead>
                    <TableHead>State</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {mine.map((row) => (
                    <TableRow key={row.id}>
                      <TableCell className="font-mono text-xs">{row.ref}</TableCell>
                      <TableCell className="max-w-[280px] text-sm">{row.title}</TableCell>
                      <TableCell className="text-xs">{row.hr_ticket_surfaces?.label ?? '—'}</TableCell>
                      <TableCell className="text-xs">{SEVERITY_LABEL[row.severity] ?? row.severity}</TableCell>
                      <TableCell className="text-xs">{when(row.raised_at)}</TableCell>
                      <TableCell className="text-xs">{state(row)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      </div>
    </PersonalLayout>
  );
};

export default TicketsPage;
