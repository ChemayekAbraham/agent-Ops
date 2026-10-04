import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  ArrowRight,
  BadgeCheck,
  Briefcase,
  Building2,
  CalendarClock,
  ClipboardList,
  ListChecks,
  TrendingUp,
  UserCheck,
  Users,
} from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import {
  getActiveAssignmentsByStaff,
  getDepartments,
  getMetricDefinitions,
  getMyStaff,
  getSnapshots,
  getStaffDirectory,
  getTasks,
} from '@/hr/api';
import { getJobPostings } from '@/hr/api/recruitment';

const CLOSED = ['completed', 'cancelled'];

function monthBounds() {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), 1);
  const end = new Date(now.getFullYear(), now.getMonth() + 1, 0);
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  return { start: iso(start), end: iso(end) };
}

function formatValue(value: number | null, unit: string) {
  if (value === null || value === undefined || Number.isNaN(value)) return '—';
  const rounded = Math.round(value * 100) / 100;
  if (unit === 'percent') return `${rounded}%`;
  if (unit === 'currency_ugx') return `UGX ${rounded.toLocaleString('en-UG')}`;
  if (unit === 'hours') return `${rounded} h`;
  if (unit === 'days') return `${rounded} d`;
  return `${rounded}`;
}

interface TileProps {
  icon: typeof Users;
  label: string;
  route: string;
  primary: string;
  detail: string;
  badge?: string;
  tone?: 'default' | 'alert';
}

function Tile({ icon: Icon, label, route, primary, detail, badge, tone = 'default' }: TileProps) {
  return (
    <Link
      to={route}
      className="rounded-xl border border-border/50 bg-card hover:bg-muted/40 p-3.5 transition-all active:scale-[0.97] touch-manipulation group block"
    >
      <div className="flex items-start justify-between mb-2">
        <div className={`p-1.5 rounded-lg bg-muted/50 group-hover:bg-muted ${tone === 'alert' ? 'text-destructive' : 'text-primary'}`}>
          <Icon className="h-4 w-4" />
        </div>
        {badge && (
          <Badge variant="secondary" className="text-[10px] h-5 px-1.5 bg-primary/10 text-primary">
            {badge}
          </Badge>
        )}
      </div>
      <p className="text-[10px] text-muted-foreground font-medium uppercase tracking-wider">{label}</p>
      <p className="text-lg font-bold text-foreground leading-tight truncate">{primary}</p>
      <p className="text-[10px] text-muted-foreground mt-0.5 truncate">{detail}</p>
    </Link>
  );
}

/**
 * Landing-page summary for the signed-in staff member. Each tile is fed by the
 * same data source as its sidebar tab and links straight through to it.
 */
export default function MyModuleSummary() {
  const { start, end } = useMemo(monthBounds, []);

  const { data: me, isLoading: meLoading } = useQuery({
    queryKey: ['hr', 'my-staff'],
    queryFn: getMyStaff,
  });

  const staffId = me?.id;

  const { data: assignmentsByStaff } = useQuery({
    queryKey: ['hr', 'active-assignments'],
    queryFn: getActiveAssignmentsByStaff,
    enabled: !!staffId,
  });

  const { data: tasks = [] } = useQuery({
    queryKey: ['hr', 'my-tasks', staffId],
    queryFn: () => getTasks({ assigneeEmployeeId: staffId! }),
    enabled: !!staffId,
  });

  const { data: definitions = [] } = useQuery({
    queryKey: ['hr', 'metric-definitions'],
    queryFn: () => getMetricDefinitions(),
    enabled: !!staffId,
  });

  const { data: snapshots = [] } = useQuery({
    queryKey: ['hr', 'my-snapshots', staffId, start, end],
    queryFn: () => getSnapshots({ staffId: staffId!, periodStart: start, periodEnd: end }),
    enabled: !!staffId,
  });

  const { data: postings = [] } = useQuery({
    queryKey: ['hr', 'job-postings'],
    queryFn: () => getJobPostings(),
  });

  // Second-row figures cover the whole tracked organisation, not just me.
  const { data: allTasks = [] } = useQuery({
    queryKey: ['hr', 'all-tasks'],
    queryFn: () => getTasks(),
  });

  const { data: staffDirectory = [] } = useQuery({
    queryKey: ['hr', 'staff-directory'],
    queryFn: getStaffDirectory,
  });

  const { data: departments = [] } = useQuery({
    queryKey: ['hr', 'departments'],
    queryFn: getDepartments,
  });

  if (meLoading) {
    return (
      <div className="grid grid-cols-2 gap-2">
        {[0, 1, 2, 3].map((i) => (
          <Skeleton key={i} className="h-24 rounded-xl" />
        ))}
      </div>
    );
  }

  if (!me) {
    return (
      <Card className="border-border/40">
        <CardContent className="p-4">
          <p className="text-sm font-semibold text-foreground">You are not enrolled in performance tracking</p>
          <p className="text-xs text-muted-foreground mt-1">
            Once someone enrols you on the Staff tab, your own tasks and metrics will appear here automatically.
          </p>
          <Link to="/hr/people?tab=directory" className="text-[11px] text-primary font-medium inline-flex items-center gap-0.5 mt-2 hover:underline">
            Open Staff <ArrowRight className="h-3 w-3" />
          </Link>
        </CardContent>
      </Card>
    );
  }

  const assignments = assignmentsByStaff?.[me.id] ?? [];
  const primaryAssignment = assignments.find((a) => a.is_primary) ?? assignments[0];

  const openTasks = tasks.filter((t) => !CLOSED.includes(t.status));
  const now = Date.now();
  const overdue = openTasks.filter((t) => t.due_at && new Date(t.due_at).getTime() < now).length;
  const completedThisMonth = tasks.filter(
    (t) => t.completed_at && t.completed_at.slice(0, 10) >= start && t.completed_at.slice(0, 10) <= end,
  ).length;

  const definitionById = new Map(definitions.map((d) => [d.id, d]));
  const scored = snapshots
    .map((s) => ({ snapshot: s, definition: definitionById.get(s.metric_definition_id) }))
    .filter((row) => !!row.definition);
  const topMetric = scored[0];
  const onTarget = scored.filter((row) => {
    const target = row.definition!.target_value;
    if (target === null || target === undefined) return false;
    // No reading for this period — no verdict either way.
    if (row.snapshot.value === null || row.snapshot.value === undefined) return false;
    return row.definition!.direction === 'lower_is_better'
      ? row.snapshot.value <= target
      : row.snapshot.value >= target;
  }).length;

  const orgOpenTasks = allTasks.filter((t) => !CLOSED.includes(t.status));
  const orgOverdue = orgOpenTasks.filter(
    (t) => t.due_at && new Date(t.due_at).getTime() < now,
  );
  const activeStaff = staffDirectory.filter((s) => s.status === 'active').length;
  const departmentsWithStaff = new Set(
    Object.values(assignmentsByStaff ?? {})
      .flat()
      .map((a) => a.department_name)
      .filter(Boolean),
  ).size;

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between px-0.5">
        <p className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider">
          My workspace
        </p>
        <span className="text-[10px] text-muted-foreground">{me.staff_number}</span>
      </div>

      <div className="grid grid-cols-2 gap-2">
        <Tile
          icon={Users}
          label="Staff"
          route="/hr/people?tab=directory"
          primary={primaryAssignment?.position_title || 'No position'}
          detail={primaryAssignment?.department_name || 'No department assigned'}
          badge={assignments.length > 1 ? `${assignments.length} roles` : undefined}
        />
        <Tile
          icon={ClipboardList}
          label="Tasks"
          route="/hr/dashboard/my-work"
          primary={`${openTasks.length} open`}
          detail={`${completedThisMonth} completed this month`}
          badge={overdue > 0 ? `${overdue} overdue` : undefined}
          tone={overdue > 0 ? 'alert' : 'default'}
        />
        <Tile
          icon={TrendingUp}
          label="Productivity"
          route="/hr/dashboard/productivity"
          primary={
            topMetric
              ? formatValue(topMetric.snapshot.value, topMetric.definition!.unit)
              : 'No data'
          }
          detail={
            topMetric
              ? `${topMetric.definition!.name} · ${onTarget}/${scored.length} on target`
              : 'No metrics recorded this month'
          }
        />
        <Tile
          icon={UserCheck}
          label="Recruitment"
          route="/hr/dashboard/recruitment"
          primary={postings.length ? `${postings.length} open roles` : 'No open roles'}
          detail={postings.length ? 'Live job postings' : 'Nothing being recruited for'}
        />
      </div>

      <div className="grid grid-cols-2 gap-2">
        <Tile
          icon={ListChecks}
          label="Open Tasks"
          route="/hr/dashboard/tasks"
          primary={`${orgOpenTasks.length}`}
          detail="Across every tracked assignment"
        />
        <Tile
          icon={CalendarClock}
          label="Overdue Tasks"
          route="/hr/dashboard/tasks"
          primary={`${orgOverdue.length}`}
          detail="Past their due date"
          tone={orgOverdue.length > 0 ? 'alert' : 'default'}
        />
        <Tile
          icon={Users}
          label="Staff Enrolled"
          route="/hr/people?tab=directory"
          primary={`${staffDirectory.length}`}
          detail={`${activeStaff} active`}
        />
        <Tile
          icon={Building2}
          label="Departments Tracked"
          route="/hr/people?tab=directory"
          primary={`${departments.length}`}
          detail={`${departmentsWithStaff} with staff assigned`}
        />
      </div>

      <div className="grid grid-cols-2 gap-2">
        <Link
          to="/hr/dashboard/my-work"
          className="w-full text-left rounded-xl border border-border/50 bg-card hover:bg-muted/40 p-3.5 transition-all active:scale-[0.97] touch-manipulation group block"
        >
          <div className="flex items-start justify-between mb-2">
            <div className="p-1.5 rounded-lg bg-muted/50 group-hover:bg-muted text-primary">
              <Briefcase className="h-4 w-4" />
            </div>
          </div>
          <p className="text-sm font-semibold text-foreground leading-tight">My Work</p>
          <p className="text-[10px] text-muted-foreground mt-0.5">Your tasks and your numbers</p>
        </Link>
        <Link
          to="/hr/people?tab=directory"
          className="w-full text-left rounded-xl border border-border/50 bg-card hover:bg-muted/40 p-3.5 transition-all active:scale-[0.97] touch-manipulation group block"
        >
          <div className="flex items-start justify-between mb-2">
            <div className="p-1.5 rounded-lg bg-muted/50 group-hover:bg-muted text-primary">
              <Users className="h-4 w-4" />
            </div>
          </div>
          <p className="text-sm font-semibold text-foreground leading-tight">Staff</p>
          <p className="text-[10px] text-muted-foreground mt-0.5">Enroll and manage tracked staff</p>
        </Link>
      </div>

      {me.status === 'active' && (
        <p className="text-[10px] text-muted-foreground flex items-center gap-1 px-0.5">
          <BadgeCheck className="h-3 w-3 text-primary" /> Figures are yours only and refresh from each tab.
        </p>
      )}
    </div>
  );
}
