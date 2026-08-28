import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
import { toast } from 'sonner';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';

import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from '@/components/ui/sheet';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { GraduationCap, Search, Users } from 'lucide-react';
import { format } from 'date-fns';

/** The nine values allowed by the database check constraint — defined once. */
const ALL_STATUSES = [
  'new',
  'screening',
  'interviewing',
  'offered',
  'placed',
  'declined',
  'not_selected',
  'retained',
  'withdrawn',
] as const;
type AppStatus = (typeof ALL_STATUSES)[number];

/** Sort rank of a status; unknown or missing values sort last. */
function statusRank(status: string | null | undefined): number {
  const i = ALL_STATUSES.indexOf(status as AppStatus);
  return i === -1 ? ALL_STATUSES.length : i;
}

/** Row tint by pipeline stage. Empty string means no tint. */
function internshipToneClass(status: string | null | undefined): string {
  switch (status) {
    case 'screening':
      return 'bg-sky-500/10 border-l-2 border-sky-400/70 hover:bg-sky-500/20 dark:bg-sky-500/10 dark:border-sky-400/80 dark:hover:bg-sky-500/20';
    case 'interviewing':
      return 'bg-teal-500/10 border-l-2 border-teal-400/70 hover:bg-teal-500/20 dark:bg-teal-500/10 dark:border-teal-400/80 dark:hover:bg-teal-500/20';
    case 'offered':
      return 'bg-violet-500/10 border-l-2 border-violet-400/70 hover:bg-violet-500/20 dark:bg-violet-500/10 dark:border-violet-400/80 dark:hover:bg-violet-500/20';
    case 'placed':
      return 'bg-emerald-500/10 border-l-2 border-emerald-400/70 hover:bg-emerald-500/20 dark:bg-emerald-500/10 dark:border-emerald-400/80 dark:hover:bg-emerald-500/20';
    case 'retained':
      return 'bg-amber-500/10 border-l-2 border-amber-400/70 hover:bg-amber-500/20 dark:bg-amber-500/10 dark:border-amber-400/80 dark:hover:bg-amber-500/20';
    case 'declined':
    case 'not_selected':
    case 'withdrawn':
      return 'bg-neutral-500/10 border-l-2 border-neutral-400/60 hover:bg-neutral-500/20 dark:bg-neutral-500/10 dark:border-neutral-400/70 dark:hover:bg-neutral-500/20';
    case 'new':
    case null:
    default:
      return '';
  }
}

/** Statuses that mean the applicant has been contacted or moved past contact. */
const CONTACTED_OR_LATER: AppStatus[] = ['screening', 'interviewing', 'offered', 'placed', 'retained'];

const GROUPS = [
  { key: 'active', label: 'Active', statuses: ['new', 'screening', 'interviewing', 'offered'] as AppStatus[] },
  { key: 'retained', label: 'Retained', statuses: ['retained'] as AppStatus[] },
  { key: 'placed', label: 'Placed', statuses: ['placed'] as AppStatus[] },
  { key: 'closed', label: 'Closed', statuses: ['declined', 'not_selected', 'withdrawn'] as AppStatus[] },
] as const;





const CLOSED_STATUSES = GROUPS.find((g) => g.key === 'closed')!.statuses;
const ACTIVE_STATUSES = GROUPS.find((g) => g.key === 'active')!.statuses;

const NEW_ARRIVAL_MS = 20_000;
const QUERY_KEY = ['internship-applications'] as const;

type ApplicationRow = Record<string, any>;

const dash = (v: unknown) => {
  if (v === null || v === undefined || v === '') return '—';
  if (typeof v === 'boolean') return v ? 'Yes' : 'No';
  return String(v);
};

const dateText = (v: unknown, withTime = false) =>
  v ? format(new Date(String(v)), withTime ? 'MMM d, yyyy h:mm a' : 'MMM d, yyyy') : '—';

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="space-y-0.5">
      <p className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="text-sm break-words">{value}</p>
    </div>
  );
}

function FieldGroup({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="space-y-3">
      <h4 className="text-xs font-semibold uppercase tracking-wide text-primary">{title}</h4>
      <div className="grid grid-cols-2 gap-3">{children}</div>
    </div>
  );
}

export default function HRInternshipApplications() {
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | AppStatus>('all');
  const [selected, setSelected] = useState<ApplicationRow | null>(null);
  const [pendingStatus, setPendingStatus] = useState<AppStatus | ''>('');
  const [reason, setReason] = useState('');
  const [saving, setSaving] = useState(false);
  const [newArrivals, setNewArrivals] = useState<Record<string, number>>({});
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);

  const queryClient = useQueryClient();
  const { user, role, roles } = useAuth();
  const canEdit = ['hr', 'super_admin'].some((r) => role === r || roles?.includes(r as any));

  const { data: applications = [], isLoading } = useQuery({
    queryKey: ['internship-applications'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('internship_applications')
        .select('*')
        .order('created_at', { ascending: false });
      if (error) throw error;
      return data;
    },
  });

  // Realtime: refresh on insert/update, flag inserts as newly arrived for 20s.
  useEffect(() => {
    const channel = supabase
      .channel('hr-internship-applications')
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'internship_applications' },
        (payload) => {
          const id = (payload.new as ApplicationRow)?.id;
          if (id) {
            setNewArrivals((prev) => ({ ...prev, [id]: Date.now() }));
            const t = setTimeout(() => {
              setNewArrivals((prev) => {
                const next = { ...prev };
                delete next[id];
                return next;
              });
            }, NEW_ARRIVAL_MS);
            timers.current.push(t);
          }
          queryClient.invalidateQueries({ queryKey: QUERY_KEY });
        },
      )
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'internship_applications' },
        () => queryClient.invalidateQueries({ queryKey: QUERY_KEY }),
      )
      .subscribe();

    return () => {
      timers.current.forEach(clearTimeout);
      timers.current = [];
      supabase.removeChannel(channel);
    };
  }, [queryClient]);

  const searched = applications.filter((app: ApplicationRow) => {
    const q = search.toLowerCase();
    return (
      app.full_name.toLowerCase().includes(q) ||
      app.phone.toLowerCase().includes(q) ||
      (app.email?.toLowerCase().includes(q) ?? false) ||
      (app.referral_code?.toLowerCase().includes(q) ?? false)
    );
  });

  const statusCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const app of searched) {
      const status = (app.status ?? ACTIVE_STATUSES[0]) as AppStatus;
      counts[status] = (counts[status] ?? 0) + 1;
    }
    return counts;
  }, [searched]);

  const visibleRows = statusFilter === 'all'
    ? searched
    : searched.filter(
        (app: ApplicationRow) => (app.status ?? ACTIVE_STATUSES[0]) === statusFilter,
      );


  const [sortConfig, setSortConfig] = useState<{ key: 'status' | 'created'; dir: 'asc' | 'desc' }>({
    key: 'created',
    dir: 'desc',
  });

  const toggleSort = (key: 'status' | 'created') => {
    setSortConfig((prev) =>
      prev.key === key ? { key, dir: prev.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'asc' },
    );
  };

  const sortIndicator = (key: 'status' | 'created') =>
    sortConfig.key === key ? (sortConfig.dir === 'asc' ? '↑' : '↓') : '';

  const arrivedCount = Object.keys(newArrivals).length;


  const openRow = (app: ApplicationRow) => {
    setSelected(app);
    setPendingStatus((app.status as AppStatus) ?? '');
    setReason(app.decision_reason ?? '');
  };

  const saveStatus = useCallback(async () => {
    if (!selected || !pendingStatus) return;
    const closing = CLOSED_STATUSES.includes(pendingStatus);
    if (closing && reason.trim().length < 10) {
      toast.error('A decision reason of at least 10 characters is required.');
      return;
    }
    setSaving(true);
    const patch: Record<string, any> = { status: pendingStatus };
    if (CONTACTED_OR_LATER.includes(pendingStatus)) {
      patch.contacted_at = new Date().toISOString();
      patch.contacted_by = user?.id ?? null;
    }
    if (closing) {
      patch.decided_at = new Date().toISOString();
      patch.decided_by = user?.id ?? null;
      patch.decision_reason = reason.trim();
    }
    const { error } = await supabase
      .from('internship_applications')
      .update(patch)
      .eq('id', selected.id)
      .select('id');
    setSaving(false);
    if (error) {
      toast.error(`Could not update status: ${error.message}`);
      return;
    }
    toast.success('Status updated.');
    setSelected({ ...selected, ...patch });
    queryClient.invalidateQueries({ queryKey: QUERY_KEY });
  }, [selected, pendingStatus, reason, user?.id, queryClient]);

  const renderTable = (rows: ApplicationRow[]) => {
    const mult = sortConfig.dir === 'asc' ? 1 : -1;
    const sortedRows = [...rows].sort((a, b) =>
      sortConfig.key === 'status'
        ? (statusRank(a.status) - statusRank(b.status)) * mult
        : (new Date(a.created_at).getTime() - new Date(b.created_at).getTime()) * mult,
    );
    return (
    <Card>
      <CardContent className="p-0">
        {isLoading ? (
          <div className="p-8 text-center text-muted-foreground">Loading applications...</div>
        ) : rows.length === 0 ? (
          <div className="p-8 text-center text-muted-foreground">No applications found.</div>
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Full Name</TableHead>
                  <TableHead>Phone</TableHead>
                  <TableHead>Email</TableHead>
                  <TableHead>Institution</TableHead>
                  <TableHead className="cursor-pointer select-none" onClick={() => toggleSort('status')}>
                    Status <span>{sortIndicator('status')}</span>
                  </TableHead>
                  <TableHead>Referral Code</TableHead>
                  <TableHead className="cursor-pointer select-none" onClick={() => toggleSort('created')}>
                    Applied At <span>{sortIndicator('created')}</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {sortedRows.map((app) => {
                  const isNew = Boolean(newArrivals[app.id]);
                  return (
                    <TableRow
                      key={app.id}
                      onClick={() => openRow(app)}
                      className={`cursor-pointer ${isNew ? 'border-l-4 border-l-emerald-500 animate-pulse bg-emerald-500/5' : internshipToneClass(app.status)}`}
                    >

                      <TableCell className="font-medium">
                        <span className="inline-flex items-center gap-2">
                          {app.full_name}
                          {isNew && (
                            <Badge className="bg-emerald-500/15 text-emerald-700 border-0 text-[10px]">New</Badge>
                          )}
                        </span>
                      </TableCell>
                      <TableCell>{app.phone}</TableCell>
                      <TableCell className="text-muted-foreground">{dash(app.email)}</TableCell>
                      <TableCell className="max-w-[200px] truncate" title={app.institution || ''}>
                        {dash(app.institution)}
                      </TableCell>
                      <TableCell>
                        <Badge variant="outline" className="text-xs capitalize">
                          {(app.status ?? ACTIVE_STATUSES[0]).replace('_', ' ')}
                        </Badge>
                      </TableCell>
                      <TableCell className="font-mono text-xs">{dash(app.referral_code)}</TableCell>
                      <TableCell className="text-muted-foreground text-xs">
                        {dateText(app.created_at, true)}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
    );
  };


  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <GraduationCap className="h-6 w-6 text-primary" />
          <h2 className="text-2xl font-bold tracking-tight">Internship Applications</h2>
          <Badge variant="secondary" className="text-xs">
            <Users className="h-3 w-3 mr-1" />
            {applications.length}
          </Badge>
          {arrivedCount > 0 && (
            <span className="text-[10px] font-semibold text-emerald-600">+{arrivedCount}</span>
          )}
        </div>
        <div className="flex items-center gap-3">
          <Select value={statusFilter} onValueChange={(v) => setStatusFilter(v as 'all' | AppStatus)}>
            <SelectTrigger className="w-56">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All ({searched.length})</SelectItem>
              {ALL_STATUSES.map((s) => (
                <SelectItem key={s} value={s} className="capitalize">
                  {s.replace('_', ' ')} ({statusCounts[s] ?? 0})
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <div className="relative w-72">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Search by name, phone, email..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="pl-9"
            />
          </div>
        </div>
      </div>

      {renderTable(visibleRows)}



      <Sheet open={Boolean(selected)} onOpenChange={(open) => !open && setSelected(null)}>
        <SheetContent className="w-full sm:max-w-lg overflow-y-auto">
          {selected && (
            <>
              <SheetHeader>
                <SheetTitle>{selected.full_name}</SheetTitle>
                <SheetDescription>
                  Applied {dateText(selected.created_at, true)}
                </SheetDescription>
              </SheetHeader>

              <div className="mt-6 space-y-6">
                <FieldGroup title="Contact">
                  <Field label="Phone" value={dash(selected.phone)} />
                  <Field label="Email" value={dash(selected.email)} />
                  <Field label="Preferred channel" value={dash(selected.preferred_contact_channel)} />
                  <Field label="Referral code" value={dash(selected.referral_code)} />
                  <Field label="Reference" value={dash(selected.public_ref)} />
                </FieldGroup>

                <FieldGroup title="Education">
                  <Field label="Institution" value={dash(selected.institution)} />
                  <Field label="Course" value={dash(selected.course)} />
                  <Field label="Year of study" value={dash(selected.year_of_study)} />
                  <Field label="Expected completion" value={dateText(selected.expected_completion)} />
                </FieldGroup>

                <FieldGroup title="Availability">
                  <Field label="Start" value={dateText(selected.availability_start)} />
                  <Field label="Weeks" value={dash(selected.availability_weeks)} />
                  <Field label="Days per week" value={dash(selected.availability_days_per_week)} />
                </FieldGroup>

                <FieldGroup title="Consent">
                  <Field label="Consent text version" value={dash(selected.consent_text_version)} />
                  <Field label="Consented at" value={dateText(selected.consented_at, true)} />
                  <Field label="Future roles consent" value={dash(selected.future_roles_consent)} />
                </FieldGroup>

                <FieldGroup title="Application">
                  <Field label="Motivation" value={dash(selected.motivation)} />
                  <Field label="Skills" value={dash(selected.skills)} />
                  <Field label="Ready to learn" value={dash(selected.ready_to_learn)} />
                  <Field label="Cohort" value={dash(selected.cohort)} />
                </FieldGroup>

                <FieldGroup title="Workflow">
                  <Field label="Status" value={dash(selected.status ?? ACTIVE_STATUSES[0])} />
                  <Field label="Contacted at" value={dateText(selected.contacted_at, true)} />
                  <Field label="Decided at" value={dateText(selected.decided_at, true)} />
                  <Field label="Decision reason" value={dash(selected.decision_reason)} />
                </FieldGroup>

                <div className="space-y-3 rounded-lg border p-4">
                  <Label className="text-xs uppercase tracking-wide text-muted-foreground">Update status</Label>
                  <TooltipProvider>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <div>
                          <Select
                            value={pendingStatus}
                            onValueChange={(v) => setPendingStatus(v as AppStatus)}
                            disabled={!canEdit || saving}
                          >
                            <SelectTrigger>
                              <SelectValue placeholder="Select status" />
                            </SelectTrigger>
                            <SelectContent className="z-[200]">
                              {ALL_STATUSES.map((s) => (
                                <SelectItem key={s} value={s} className="capitalize">
                                  {s.replace('_', ' ')}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </div>
                      </TooltipTrigger>
                      {!canEdit && <TooltipContent>Read only for your role</TooltipContent>}
                    </Tooltip>
                  </TooltipProvider>

                  {pendingStatus && CLOSED_STATUSES.includes(pendingStatus) && (
                    <div className="space-y-1">
                      <Label htmlFor="decision-reason" className="text-xs">
                        Decision reason (min 10 characters)
                      </Label>
                      <Textarea
                        id="decision-reason"
                        value={reason}
                        onChange={(e) => setReason(e.target.value)}
                        disabled={!canEdit || saving}
                        rows={3}
                      />
                    </div>
                  )}

                  <Button
                    onClick={saveStatus}
                    disabled={!canEdit || saving || !pendingStatus || pendingStatus === selected.status}
                    className="w-full"
                  >
                    {saving ? 'Saving...' : 'Save status'}
                  </Button>
                </div>
              </div>
            </>
          )}
        </SheetContent>
      </Sheet>
    </div>
  );
}
