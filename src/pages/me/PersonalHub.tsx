import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { FileText, Briefcase, User, Bell, FolderOpen, Ticket } from 'lucide-react';
import { toast } from 'sonner';
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
import { cn } from '@/lib/utils';
import PersonalLayout from '@/components/layout/PersonalLayout';
import NameCompletionReminder from '@/components/notifications/NameCompletionReminder';
import { getMyStaff } from '@/hr/api';
import { supabase } from '@/hr/api/client';
import type { Employee } from '@/hr/types';

interface HubCardProps {
  to?: string;
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  description: string;
  disabled?: boolean;
}

const HubCard = ({ to, icon: Icon, title, description, disabled }: HubCardProps) => {
  const className = cn(
    'group flex flex-col gap-3 rounded-2xl border bg-card p-5 shadow-sm transition-colors',
    disabled
      ? 'cursor-not-allowed opacity-60'
      : 'hover:border-primary/30 hover:bg-accent/50'
  );

  const content = (
    <>
      <div className="flex h-10 w-10 items-center justify-center rounded-full bg-primary/10 text-primary">
        <Icon className="h-5 w-5" />
      </div>
      <div>
        <h2 className="font-semibold text-card-foreground">{title}</h2>
        <p className="mt-1 text-sm text-muted-foreground">{description}</p>
      </div>
      {disabled && (
        <span className="mt-auto self-start rounded-full bg-muted px-2 py-1 text-xs font-medium text-muted-foreground">
          Coming soon
        </span>
      )}
    </>
  );

  if (disabled || !to) {
    return (
      <div className={className} aria-disabled="true">
        {content}
      </div>
    );
  }

  return (
    <Link to={to} className={className}>
      {content}
    </Link>
  );
};

const CARDS = [
  {
    to: '/me/payslips',
    icon: FileText,
    title: 'My payslips',
    description: 'Your own pay records',
  },
  {
    to: '/me/work',
    icon: Briefcase,
    title: 'My work',
    description: 'Tasks assigned to you',
  },
  {
    to: '/me/tickets',
    icon: Ticket,
    title: 'Tickets',
    description: 'Raise a fault or pick one up',
  },
  {
    to: '/your-profile',
    icon: User,
    title: 'My profile',
    description: 'Your personal details',
  },
  {
    to: '/notifications',
    icon: Bell,
    title: 'Notifications',
    description: 'Messages and alerts',
  },
  {
    icon: FolderOpen,
    title: 'My documents',
    description: 'Your contracts, letters and certificates',
    to: '/me/documents',
  },
];

interface UnclaimedTicket {
  id: string;
  ref: string;
  title: string;
  severity: string;
  raised_at: string;
  hr_ticket_surfaces?: { label: string } | null;
}

function formatDateTime(iso: string | null) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString('en-GB', {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}

const PersonalHub = () => {
  const [staffRecord, setStaffRecord] = useState<Employee | null>(null);
  const [unclaimedTickets, setUnclaimedTickets] = useState<UnclaimedTicket[]>([]);
  const [isEngineering, setIsEngineering] = useState(false);
  const [claiming, setClaiming] = useState<string | null>(null);

  const loadUnclaimedTickets = useCallback(async () => {
    const { data } = await supabase
      .from('hr_tickets')
      .select('id, ref, title, severity, raised_at, hr_ticket_surfaces(label)')
      .is('task_id', null)
      .is('closed_no_task_at', null)
      .order('raised_at', { ascending: true });
    setUnclaimedTickets((data ?? []) as unknown as UnclaimedTicket[]);
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      let staff: Employee | null = null;
      try {
        staff = await getMyStaff();
      } catch {
        staff = null;
      }
      if (cancelled) return;
      setStaffRecord(staff);
      if (!staff) return;

      await loadUnclaimedTickets();
    })();
    return () => {
      cancelled = true;
    };
  }, [loadUnclaimedTickets]);

  useEffect(() => {
    if (!staffRecord) return;
    let cancelled = false;
    (async () => {
      const { data, error } = await supabase.rpc('hr_is_engineering');
      if (cancelled) return;
      if (error) {
        console.error('hr_is_engineering', error);
      }
      setIsEngineering(!!data);
    })();
    return () => {
      cancelled = true;
    };
  }, [staffRecord]);

  const claim = async (ticket: UnclaimedTicket) => {
    setClaiming(ticket.id);
    try {
      const { error } = await supabase.rpc('hr_claim_ticket', { p_ticket_id: ticket.id });
      if (error) {
        toast.error(error.message);
        return;
      }
      toast.success(`Ticket ${ticket.ref} claimed`);
      await loadUnclaimedTickets();
    } finally {
      setClaiming(null);
    }
  };

  return (
    <PersonalLayout title="My space">
      <div className="space-y-4">
        <NameCompletionReminder />
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {CARDS.map((card, index) => (
            <HubCard key={index} {...card} />
          ))}
        </div>

        {staffRecord && (
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm">
                Waiting to be picked up ({unclaimedTickets.length})
              </CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              {unclaimedTickets.length === 0 ? (
                <p className="p-4 text-center text-sm text-muted-foreground">
                  Nothing waiting right now.
                </p>
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
                    {unclaimedTickets.map((row) => (
                      <TableRow key={row.id}>
                        <TableCell className="font-mono text-xs">{row.ref}</TableCell>
                        <TableCell>{row.title}</TableCell>
                        <TableCell>{row.hr_ticket_surfaces?.label ?? '—'}</TableCell>
                        <TableCell className="capitalize">{row.severity}</TableCell>
                        <TableCell>{formatDateTime(row.raised_at)}</TableCell>
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
              <div className="border-t p-3">
                <Link
                  to="/me/tickets"
                  className="text-sm font-medium text-primary hover:underline"
                >
                  Open Tickets
                </Link>
              </div>
            </CardContent>
          </Card>
        )}
      </div>
    </PersonalLayout>
  );
};

export default PersonalHub;
