import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  AlertTriangle,
  Check,
  FileText,
  Search,
  Users,
} from 'lucide-react';
import { toast } from 'sonner';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Separator } from '@/components/ui/separator';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import { Textarea } from '@/components/ui/textarea';
import {
  getDepartments,
  getJobPostings,
  setJobPostingStatus,
} from '@/hr/api';
import { getResumeUrl } from '@/hr/api/resumes';
import {
  APPLICATION_DECISIONS,
  archiveApplication,
  recordApplicationDecision,
  markApplicationContacted,
  restoreApplication,
  sendCareersEmails,
  type ApplicationDecision,
} from '@/hr/api/applications';
import type { Database } from '@/integrations/supabase/types';
import type {
  Department,
  JobPosting,
} from '@/hr/types';
import HRInternshipApplications from '@/components/hr/HRInternshipApplications';
import { CoverNoteSections } from '@/hr/components/applications/ApplicationDetailSheet';
import {
  SEGMENT_ALL,
  segmentKeyOfSource,
  segmentLabelOfSource,
  segmentOptionsFrom,
} from '@/hr/api/careersSource';



const ALL = '__all__';
const SHORTLIST_1 = 'shortlist_1';
const SHORTLIST_2 = 'shortlist_2';
const SHORTLIST_3 = 'shortlist_3';
const CONTACTED = 'contacted_filter';
const NOT_CONTACTED = 'not_contacted_filter';


const FILTER_OPTIONS: {
  value: string;
  label: string;
  match: (row: JobApplicationRow) => boolean;
}[] = [
  { value: ALL, label: 'All', match: () => true },
  { value: 'new', label: 'New', match: (r) => stageOf(r) === 'new' },
  { value: SHORTLIST_1, label: 'Shortlist 1', match: (r) => stageOf(r) === 'shortlist_1' },
  { value: SHORTLIST_2, label: 'Shortlist 2', match: (r) => stageOf(r) === 'shortlist_2' },
  { value: SHORTLIST_3, label: 'Shortlist 3', match: (r) => stageOf(r) === 'shortlist_3' },
  { value: 'hold', label: 'Hold', match: (r) => stageOf(r) === 'hold' },
  { value: 'rejected', label: 'Rejected', match: (r) => stageOf(r) === 'rejected' },
  { value: CONTACTED, label: 'Contacted', match: (r) => wasContacted(r) },
  { value: NOT_CONTACTED, label: 'Not yet contacted', match: (r) => !wasContacted(r) },
];



const POSTING_STATUS_CLASS: Record<JobPosting['status'], string> = {
  draft: 'bg-muted text-muted-foreground border-border',
  open: 'bg-emerald-500/10 text-emerald-700 border-emerald-500/30',
  closed: 'bg-muted text-muted-foreground border-border',
};

const EMPLOYMENT_LABELS: Record<JobPosting['employment_type'], string> = {
  permanent: 'Permanent',
  contract: 'Contract',
  intern: 'Internship',
  probation: 'Probation',
};

function fmtDate(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('en-GB', { dateStyle: 'medium' });
}

function fmtDateTime(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' });
}

/** Permanent intake, not a vacancy. Detected by the absence of a closing date. */
function isAlwaysOpen(posting: JobPosting): boolean {
  return posting.requisition_id === null && posting.closes_at === null;
}

type Stage = 'new' | 'shortlist_1' | 'shortlist_2' | 'shortlist_3' | 'hold' | 'rejected' | 'hired';

/**
 * The stage an applicant has reached. `status` is overwritten by the contacted
 * write, so the level is read from `shortlist_round` first — never from
 * `status` alone.
 */
function stageOf(row: { status: string | null; shortlist_round: number | null }): Stage {
  if (row.status === 'hired') return 'hired';
  if (row.status === 'rejected') return 'rejected';
  if (row.status === 'hold') return 'hold';
  const round = row.shortlist_round;
  if (round === 1) return 'shortlist_1';
  if (round === 2) return 'shortlist_2';
  if (round === 3) return 'shortlist_3';
  if (row.status === 'shortlisted') return 'shortlist_1';
  return 'new';
}

/** Contact is a fact of its own, held in `contacted_at`. */
function wasContacted(row: { contacted_at: string | null }): boolean {
  return row.contacted_at != null;
}

const STAGE_ORDER: Stage[] = [
  'new',
  'shortlist_1',
  'shortlist_2',
  'shortlist_3',
  'hold',
  'rejected',
  'hired',
];

const STAGE_META: Record<Stage, { label: string; className: string }> = {
  new: { label: 'New', className: 'bg-muted text-muted-foreground border-border' },
  shortlist_1: {
    label: 'Shortlist 1',
    className: 'bg-violet-500/10 text-violet-700 border-violet-400/70 dark:text-violet-300',
  },
  shortlist_2: {
    label: 'Shortlist 2',
    className: 'bg-violet-500/20 text-violet-800 border-violet-500/80 dark:text-violet-200',
  },
  shortlist_3: {
    label: 'Shortlist 3',
    className: 'bg-violet-600/25 text-violet-900 border-violet-600/90 dark:text-violet-100',
  },
  hold: {
    label: 'Hold',
    className: 'bg-amber-500/10 text-amber-700 border-amber-400/70 dark:text-amber-300',
  },
  rejected: {
    label: 'Rejected',
    className: 'bg-neutral-500/10 text-neutral-700 border-neutral-400/60 dark:text-neutral-300',
  },
  hired: {
    label: 'Hired',
    className: 'bg-emerald-500/10 text-emerald-700 border-emerald-400/70 dark:text-emerald-300',
  },
};

function StageBadge({ stage }: { stage: Stage }) {
  const meta = STAGE_META[stage];
  return (
    <Badge variant="outline" className={`text-xs font-medium ${meta.className}`}>
      {meta.label}
    </Badge>
  );
}

function rowToneClass(stage: Stage, context: 'list' | 'bin' = 'list'): string {
  if (context === 'bin') {
    switch (stage) {
      case 'shortlist_1':
        return 'border-l-2 border-violet-400/70 dark:border-violet-400/80';
      case 'shortlist_2':
        return 'border-l-2 border-violet-500/80 dark:border-violet-400/90';
      case 'shortlist_3':
        return 'border-l-2 border-violet-600/90 dark:border-violet-500';
      case 'hold':
        return 'border-l-2 border-amber-400/70 dark:border-amber-400/80';
      case 'hired':
        return 'border-l-2 border-emerald-400/70 dark:border-emerald-400/80';
      case 'rejected':
        return 'border-l-2 border-neutral-400/60 dark:border-neutral-400/70';
      case 'new':
      default:
        return '';
    }
  }
  switch (stage) {
    case 'shortlist_1':
      return 'bg-violet-500/10 border-l-2 border-violet-400/70 hover:bg-violet-500/20 dark:bg-violet-500/10 dark:border-violet-400/80 dark:hover:bg-violet-500/20';
    case 'shortlist_2':
      return 'bg-violet-500/20 border-l-2 border-violet-500/80 hover:bg-violet-500/30 dark:bg-violet-500/15 dark:border-violet-400/90 dark:hover:bg-violet-500/25';
    case 'shortlist_3':
      return 'bg-violet-600/25 border-l-2 border-violet-600/90 hover:bg-violet-600/35 dark:bg-violet-600/20 dark:border-violet-500 dark:hover:bg-violet-600/30';
    case 'hold':
      return 'bg-amber-500/10 border-l-2 border-amber-400/70 hover:bg-amber-500/20 dark:bg-amber-500/10 dark:border-amber-400/80 dark:hover:bg-amber-500/20';
    case 'hired':
      return 'bg-emerald-500/10 border-l-2 border-emerald-400/70 hover:bg-emerald-500/20 dark:bg-emerald-500/10 dark:border-emerald-400/80 dark:hover:bg-emerald-500/20';
    case 'rejected':
      return 'bg-neutral-500/10 border-l-2 border-neutral-400/60 hover:bg-neutral-500/20 dark:bg-neutral-500/10 dark:border-neutral-400/70 dark:hover:bg-neutral-500/20';
    case 'new':
    default:
      return '';
  }
}


type JobApplicationRow = Database['public']['Tables']['job_applications']['Row'];

/** Labels for the decision vocabulary. Keyed by the constant, so no status is invented here. */
const DECISION_LABELS: Record<ApplicationDecision, string> = {
  shortlisted: 'Shortlist',
  hold: 'Hold',
  rejected: 'Decline',
};

/**
 * One offered action: the status it writes, the shortlist round it targets
 * (null when the round must not change) and the label on its button.
 */
interface DecisionAction {
  status: ApplicationDecision | 'contacted';
  round: number | null;
  label: string;
  writer: 'decision' | 'contacted';
}


/**
 * Only the actions that make sense for where the row already stands are shown.
 * Shortlist level lives in `shortlist_round`, not in the status string, so a
 * shortlisted row with no round recorded is read as level 1. Level 3 is the
 * last level, so it offers no further shortlist step. Contact is a fact of its
 * own held in `contacted_at`, so the Contacted action is withheld on that and
 * never on the status string.
 */
function getAvailableDecisions(status: string | null, round: number | null, contacted: boolean): DecisionAction[] {
  const level = round ?? (status === 'shortlisted' ? 1 : 0);
  const actions: DecisionAction[] = [];

  if (level === 0) actions.push({ status: 'shortlisted', round: 1, label: 'Shortlist', writer: 'decision' });
  else if (level === 1) actions.push({ status: 'shortlisted', round: 2, label: 'Shortlist 2', writer: 'decision' });
  else if (level === 2) actions.push({ status: 'shortlisted', round: 3, label: 'Shortlist 3', writer: 'decision' });

  if (!contacted) {
    actions.push({ status: 'contacted', round: null, label: 'Contacted', writer: 'contacted' });
  }

  actions.push({ status: 'hold', round: null, label: DECISION_LABELS.hold, writer: 'decision' });
  actions.push({ status: 'rejected', round: null, label: DECISION_LABELS.rejected, writer: 'decision' });
  return actions;
}


const SHORTLIST_LEVEL_2_CLASS =
  'border-amber-500/50 bg-amber-500/10 text-amber-700 hover:bg-amber-500/20';


const fmtCount = (n: number) => Math.round(n).toLocaleString();

/**
 * Removal bin. `Remove` stamps `archived_at`, so nothing is destroyed —
 * removed applications are held here and can be restored to the working list.
 */
function RemovedApplicationsPanel({
  refetchList,
  refetchCount,
}: {
  refetchList: () => Promise<unknown>;
  refetchCount: () => Promise<unknown>;
}) {
  const [busyId, setBusyId] = useState<string | null>(null);
  const { data: rows = [], isLoading, error, refetch } = useQuery({
    queryKey: ['job-applications', 'purged'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('job_applications')
        .select('*')
        .not('archived_at', 'is', null)
        .is('purged_at', null)
        .order('archived_at', { ascending: false })
        .limit(500);
      if (error) throw new Error(error.message);
      return (data ?? []) as JobApplicationRow[];
    },
  });

  const restore = async (id: string, name: string) => {
    setBusyId(id);
    try {
      await restoreApplication(id);
      toast.success(`${name || 'Application'} restored to the working list`);
      await Promise.all([refetchList(), refetchCount(), refetch()]);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not restore this application');
    } finally {
      setBusyId(null);
    }
  };

  if (isLoading) return <Skeleton className="h-24 w-full" />;
  if (error) {
    return (
      <Card className="p-4 border-destructive/40 text-xs text-muted-foreground">
        Could not load removed applications: {error.message}
      </Card>
    );
  }
  if (rows.length === 0) {
    return (
      <Card className="p-6 text-center text-sm text-muted-foreground">
        Nothing has been removed. Removed applications are kept here, not deleted.
      </Card>
    );
  }

  return (
    <Card className="overflow-hidden">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-12">#</TableHead>
            <TableHead>Full name</TableHead>
            <TableHead>Role interest</TableHead>
            <TableHead>Came from</TableHead>
            <TableHead>Location</TableHead>
            <TableHead>Status when removed</TableHead>
            <TableHead>Archived</TableHead>
            <TableHead>Reference</TableHead>
            <TableHead className="text-right">Actions</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row, idx) => (
            <TableRow key={row.id} className={`bg-muted/40 ${rowToneClass(stageOf(row), 'bin')}`}>
              <TableCell>{idx + 1}</TableCell>
              <TableCell>{row.full_name || '—'}</TableCell>
              <TableCell>{row.role_interest || '—'}</TableCell>
              <TableCell>{segmentLabelOfSource(row.source)}</TableCell>
              <TableCell>{row.location || '—'}</TableCell>
              <TableCell><StageBadge stage={stageOf(row)} /></TableCell>
              <TableCell>{fmtDateTime(row.archived_at)}</TableCell>
              <TableCell>{row.public_ref || '—'}</TableCell>
              <TableCell className="text-right whitespace-nowrap">
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 px-2 text-xs"
                  disabled={busyId === row.id}
                  onClick={() => void restore(row.id, row.full_name)}
                >
                  {busyId === row.id ? 'Restoring…' : 'Restore'}
                </Button>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </Card>
  );
}

function ApplicationsTab() {
  const [search, setSearch] = useState('');
  const [showRemoved, setShowRemoved] = useState(false);
  const [selected, setSelected] = useState<JobApplicationRow | null>(null);
  const [statusFilter, setStatusFilter] = useState<string>(ALL);
  const [segmentFilter, setSegmentFilter] = useState<string>(SEGMENT_ALL);
  const [groupBy, setGroupBy] = useState<'none' | 'role' | 'stage'>('role');
  const [sortConfig, setSortConfig] = useState<
    { key: 'name' | 'role_interest' | 'stage' | 'created'; dir: 'asc' | 'desc' }
  >({ key: 'created', dir: 'desc' });
  const [pending, setPending] = useState<
    {
      row: JobApplicationRow;
      kind: ApplicationDecision | 'contacted' | 'remove';
      writer?: 'decision' | 'contacted' | null;
      round?: number | null;
    } | null
  >(null);

  const [busy, setBusy] = useState(false);
  // Selection lives as a set of ids so it survives filtering and sorting.
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [composeOpen, setComposeOpen] = useState(false);
  const [emailSubject, setEmailSubject] = useState('');
  const [emailBody, setEmailBody] = useState('');
  const [confirmSend, setConfirmSend] = useState(false);
  const [sending, setSending] = useState(false);

  const { data: rows = [], isLoading, error, refetch } = useQuery({
    queryKey: ['job-applications'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('job_applications')
        .select('*')
        .is('archived_at', null)
        .is('purged_at', null)
        .like('source', '%?c=%')
        .order('created_at', { ascending: false })
        .limit(500);
      if (error) throw new Error(error.message);
      return (data ?? []) as JobApplicationRow[];
    },
  });

  const { data: removedCount = 0, refetch: refetchRemovedCount } = useQuery({
    queryKey: ['job-applications', 'purged-count'],
    queryFn: async () => {
      const { count, error } = await supabase
        .from('job_applications')
        .select('*', { count: 'exact', head: true })
        .not('archived_at', 'is', null)
        .is('purged_at', null);
      if (error) throw new Error(error.message);
      return count ?? 0;
    },
  });

  // Purged-count refetches on tab load. The old Realtime listener was on
  // job_applications, which is not in the publication, so it never fired
  // (doc 147).


  const statuses = useMemo(() => FILTER_OPTIONS, []);

  const segmentOptions = useMemo(
    () => segmentOptionsFrom(rows.map((r) => r.source)),
    [rows],
  );

  const filteredSorted = useMemo(() => {
    let data = rows;

    const term = search.trim().toLowerCase();
    if (term) {
      data = data.filter((r) =>
        [r.full_name, r.email, r.whatsapp_number, r.public_ref].some((v) =>
          (v ?? '').toLowerCase().includes(term),
        ),
      );
    }

    if (statusFilter !== ALL) {
      const option = FILTER_OPTIONS.find((o) => o.value === statusFilter);
      data = data.filter((r) => option?.match(r) ?? false);
    }

    if (segmentFilter !== SEGMENT_ALL) {
      data = data.filter((r) => segmentKeyOfSource(r.source) === segmentFilter);
    }

    const sorted = [...data];
    if (sortConfig.key === 'name') {
      sorted.sort((a, b) => {
        const av = (a.full_name ?? '').toLowerCase();
        const bv = (b.full_name ?? '').toLowerCase();
        return av.localeCompare(bv) * (sortConfig.dir === 'asc' ? 1 : -1);
      });
    } else if (sortConfig.key === 'role_interest') {
      sorted.sort((a, b) => {
        const av = (a.role_interest ?? '').toLowerCase();
        const bv = (b.role_interest ?? '').toLowerCase();
        return av.localeCompare(bv) * (sortConfig.dir === 'asc' ? 1 : -1);
      });
    } else if (sortConfig.key === 'stage') {
      sorted.sort((a, b) => {
        const av = STAGE_ORDER.indexOf(stageOf(a));
        const bv = STAGE_ORDER.indexOf(stageOf(b));
        return (av - bv) * (sortConfig.dir === 'asc' ? 1 : -1);
      });
    } else {
      sorted.sort((a, b) => {
        const av = new Date(a.created_at).getTime();
        const bv = new Date(b.created_at).getTime();
        return (av - bv) * (sortConfig.dir === 'asc' ? 1 : -1);
      });
    }
    return sorted;
  }, [rows, search, statusFilter, segmentFilter, sortConfig]);

  const toggleSort = (key: 'name' | 'role_interest' | 'stage' | 'created') => {
    setSortConfig((prev) =>
      prev.key === key
        ? { key, dir: prev.dir === 'asc' ? 'desc' : 'asc' }
        : { key, dir: 'asc' },
    );
  };

  /** Only the rows currently on screen can be selected or select-all'd. */
  const visibleIds = useMemo(() => filteredSorted.map((r) => r.id), [filteredSorted]);
  const selectedVisibleIds = useMemo(
    () => visibleIds.filter((id) => selectedIds.has(id)),
    [visibleIds, selectedIds],
  );
  const allVisibleSelected =
    visibleIds.length > 0 && selectedVisibleIds.length === visibleIds.length;

  const toggleRowSelected = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleSelectAllVisible = () => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (allVisibleSelected) visibleIds.forEach((id) => next.delete(id));
      else visibleIds.forEach((id) => next.add(id));
      return next;
    });
  };

  const recipients = useMemo(
    () => filteredSorted.filter((r) => selectedIds.has(r.id)),
    [filteredSorted, selectedIds],
  );
  const recipientsWithEmail = recipients.filter((r) => (r.email ?? '').trim().length > 0);

  const runSend = async () => {
    setSending(true);
    try {
      // One id per person. The server expands this into one message per address;
      // no address is ever grouped with another.
      const result = await sendCareersEmails({
        applicationIds: recipientsWithEmail.map((r) => r.id),
        subject: emailSubject,
        body: emailBody,
      });
      const unknown = (result as { unknownPlaceholders?: string[] }).unknownPlaceholders ?? [];
      if (unknown.length) {
        toast.error(
          `Nothing was sent — unrecognised placeholder${unknown.length === 1 ? '' : 's'}: ${unknown.join(', ')}. Use {{name}}, {{role}} or {{reference}}.`,
        );
        setConfirmSend(false);
        return;
      }
      toast.success(
        `${fmtCount(result.sent)} email${result.sent === 1 ? '' : 's'} queued · ` +
          `${fmtCount(result.suppressed)} skipped (suppressed) · ` +
          `${fmtCount(result.failed)} failed`,
      );
      setConfirmSend(false);
      setComposeOpen(false);
      setEmailSubject('');
      setEmailBody('');
      setSelectedIds(new Set());
      await refetch();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not send these emails');
    } finally {
      setSending(false);
    }
  };

  const closeConfirm = () => {
    setPending(null);
  };

  const runPending = async () => {
    if (!pending) return;
    setBusy(true);
    try {
      if (pending.kind === 'remove') {
        await archiveApplication(pending.row.id);
        toast.success(`${pending.row.full_name || 'Application'} removed from the list`);
        setSelected(null);
      } else if (pending.writer === 'contacted') {
        await markApplicationContacted(pending.row.id);
        toast.success(`${pending.row.full_name || 'Applicant'} marked as contacted`);
      } else {
        // The target round travels with the decision in a single write.
        // Hold and Decline carry a null round and therefore leave
        // `shortlist_round` untouched, preserving the level reached.
        await recordApplicationDecision(
          pending.row.id,
          pending.kind as ApplicationDecision,
          undefined,
          pending.round,
        );
        toast.success(
          `${DECISION_LABELS[pending.kind as ApplicationDecision]} recorded for ${pending.row.full_name || 'applicant'}`,
        );
      }
      closeConfirm();
      const fresh = await refetch();
      const next = (fresh.data ?? []).find((r) => r.id === pending.row.id) ?? null;
      setSelected((prev) => (prev && prev.id === pending.row.id ? next : prev));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not record this');
    } finally {
      setBusy(false);
    }
  };




  const openCv = async (path: string) => {
    try {
      const url = await getResumeUrl(path);
      window.open(url, '_blank', 'noopener,noreferrer');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not open CV');
    }
  };

  /** Row groups for the "Group by" selector. Empty groups are omitted. */
  const groups = useMemo(() => {
    if (groupBy === 'role') {
      const map = new Map<string, JobApplicationRow[]>();
      filteredSorted.forEach((r) => {
        const label = (r.role_interest ?? '').trim() || 'Unspecified';
        const list = map.get(label);
        if (list) list.push(r);
        else map.set(label, [r]);
      });
      return [...map.entries()]
        .map(([label, list]) => ({ key: label, label, rows: list }))
        .sort((a, b) => b.rows.length - a.rows.length);
    }
    if (groupBy === 'stage') {
      return STAGE_ORDER.map((stage) => ({
        key: stage,
        label: STAGE_META[stage].label,
        rows: filteredSorted.filter((r) => stageOf(r) === stage),
      })).filter((g) => g.rows.length > 0);
    }
    return [];
  }, [filteredSorted, groupBy]);

  const renderTable = (list: JobApplicationRow[]) => {
    const listIds = list.map((r) => r.id);
    const allInListSelected =
      listIds.length > 0 && listIds.every((id) => selectedIds.has(id));
    const toggleSelectAllInList = () => {
      setSelectedIds((prev) => {
        const next = new Set(prev);
        if (allInListSelected) listIds.forEach((id) => next.delete(id));
        else listIds.forEach((id) => next.add(id));
        return next;
      });
    };

    return (
    <Card className="overflow-hidden">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-10">
              <Checkbox
                checked={allInListSelected}
                onCheckedChange={toggleSelectAllInList}
                aria-label="Select all applications in this group"
              />
            </TableHead>
            <TableHead className="w-12">#</TableHead>
            <TableHead
              className="cursor-pointer select-none"
              onClick={() => toggleSort('name')}
            >
              Full name
              {sortConfig.key === 'name' && (
                <span className="ml-1">{sortConfig.dir === 'asc' ? '↑' : '↓'}</span>
              )}
            </TableHead>
            <TableHead
              className="cursor-pointer select-none"
              onClick={() => toggleSort('role_interest')}
            >
              Role
              {sortConfig.key === 'role_interest' && (
                <span className="ml-1">{sortConfig.dir === 'asc' ? '↑' : '↓'}</span>
              )}
            </TableHead>
            <TableHead
              className="cursor-pointer select-none"
              onClick={() => toggleSort('stage')}
            >
              Stage
              {sortConfig.key === 'stage' && (
                <span className="ml-1">{sortConfig.dir === 'asc' ? '↑' : '↓'}</span>
              )}
            </TableHead>
            <TableHead>Contacted</TableHead>
            <TableHead>Location</TableHead>
            <TableHead>Experience</TableHead>
            <TableHead
              className="cursor-pointer select-none"
              onClick={() => toggleSort('created')}
            >
              Applied
              {sortConfig.key === 'created' && (
                <span className="ml-1">{sortConfig.dir === 'asc' ? '↑' : '↓'}</span>
              )}
            </TableHead>
            <TableHead className="text-right">Actions</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {list.map((row, idx) => (
            <TableRow
              key={row.id}
              className={`cursor-pointer ${rowToneClass(stageOf(row))}`}
              onClick={() => setSelected(row)}
            >
              <TableCell onClick={(e) => e.stopPropagation()}>
                <Checkbox
                  checked={selectedIds.has(row.id)}
                  onCheckedChange={() => toggleRowSelected(row.id)}
                  aria-label={`Select ${row.full_name || 'application'}`}
                />
              </TableCell>
              <TableCell>{idx + 1}</TableCell>
              <TableCell>{row.full_name || '—'}</TableCell>
              <TableCell>{row.role_interest || '—'}</TableCell>
              <TableCell>
                <StageBadge stage={stageOf(row)} />
              </TableCell>
              <TableCell>
                {wasContacted(row) ? (
                  <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                    <Check className="h-3.5 w-3.5" />
                    {fmtDate(row.contacted_at)}
                  </span>
                ) : (
                  <span className="text-xs text-muted-foreground">—</span>
                )}
              </TableCell>
              <TableCell>{row.location || '—'}</TableCell>
              <TableCell>{row.experience_level || '—'}</TableCell>
              <TableCell>{fmtDateTime(row.created_at)}</TableCell>
              <TableCell
                className="text-right whitespace-nowrap"
                onClick={(e) => e.stopPropagation()}
              >
                <div className="inline-flex gap-1">
                  {getAvailableDecisions(row.status, row.shortlist_round ?? null, wasContacted(row)).map((a) => (
                    <Button
                      key={`${a.status}-${a.round ?? 'none'}`}
                      size="sm"
                      variant="outline"
                      className={`h-7 px-2 text-xs ${
                        (a.round ?? 0) >= 2 ? SHORTLIST_LEVEL_2_CLASS : ''
                      }`}
                      onClick={() => {
                        setPending({ row, kind: a.status, writer: a.writer, round: a.round });
                      }}
                    >
                      {a.label}
                    </Button>
                  ))}
                  <Button
                    size="sm"
                    variant="destructive"
                    className="h-7 px-2 text-xs"
                    onClick={() => {
                      setPending({ row, kind: 'remove' });
                    }}
                  >
                    Remove
                  </Button>
                </div>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </Card>
  );
};

  if (isLoading) {

    return (
      <div className="space-y-3">
        <Skeleton className="h-9 w-full" />
        <Skeleton className="h-32 w-full" />
      </div>
    );
  }

  if (error) {
    return (
      <Card className="p-6 border-destructive/40 flex items-start gap-3">
        <AlertTriangle className="h-5 w-5 text-destructive shrink-0 mt-0.5" />
        <div>
          <p className="text-sm font-semibold text-foreground">Could not load applications</p>
          <p className="text-xs text-muted-foreground mt-1">{error.message}</p>
        </div>
      </Card>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <div className="relative flex-1">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search name, email, WhatsApp or reference"
            className="pl-8 h-9"
          />
        </div>
        <Select value={statusFilter} onValueChange={setStatusFilter}>
          <SelectTrigger className="w-full sm:w-44">
            <SelectValue placeholder="Filter by status" />
          </SelectTrigger>
          <SelectContent>
            {statuses.map((s) => (
              <SelectItem key={s.value} value={s.value}>
                {s.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={segmentFilter} onValueChange={setSegmentFilter}>
          <SelectTrigger className="w-full sm:w-44">
            <SelectValue placeholder="Filter by source" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={SEGMENT_ALL}>All sources</SelectItem>
            {segmentOptions.map((s) => (
              <SelectItem key={s.value} value={s.value}>
                {s.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={groupBy} onValueChange={(v) => setGroupBy(v as 'none' | 'role' | 'stage')}>
          <SelectTrigger className="w-full sm:w-40">
            <SelectValue placeholder="Group by" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="none">No grouping</SelectItem>
            <SelectItem value="role">Group by role</SelectItem>
            <SelectItem value="stage">Group by stage</SelectItem>
          </SelectContent>
        </Select>
        <Button
          size="sm"
          variant={showRemoved ? 'default' : 'outline'}
          className="h-9 text-xs whitespace-nowrap"
          onClick={() => setShowRemoved((v) => !v)}
        >
          {showRemoved ? 'Back to applications' : `Removed bin (${fmtCount(removedCount)})`}
        </Button>
      </div>

      {showRemoved ? (
        <div className="space-y-2">
          <p className="text-xs text-muted-foreground">
            Removed applications are kept here indefinitely — nothing is deleted. Put one back to
            return it to the working list.
          </p>
          <RemovedApplicationsPanel refetchList={refetch} refetchCount={refetchRemovedCount} />
        </div>
      ) : (
      <>
      <p className="text-xs text-muted-foreground">
        showing {isLoading ? '—' : fmtCount(filteredSorted.length)} of{' '}
        {isLoading ? '—' : fmtCount(rows.length)} applications
      </p>

      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs font-medium">
          {isLoading ? '—' : fmtCount(selectedVisibleIds.length)} selected
        </span>
        <Button
          size="sm"
          variant="outline"
          className="h-7 text-xs"
          onClick={toggleSelectAllVisible}
          disabled={visibleIds.length === 0}
        >
          {allVisibleSelected ? 'Clear selection' : 'Select all shown'}
        </Button>
        <Button
          size="sm"
          className="h-7 text-xs"
          onClick={() => setComposeOpen(true)}
          disabled={selectedVisibleIds.length === 0}
        >
          Email selected
        </Button>
      </div>

      {filteredSorted.length === 0 ? (
        <div className="text-center py-10 text-muted-foreground">
          <FileText className="h-8 w-8 mx-auto mb-2 opacity-50" />
          No applications match these filters.
        </div>
      ) : groupBy === 'none' ? (
        renderTable(filteredSorted)
      ) : (
        <div className="space-y-4">
          {groups.map((g) => (
            <div key={g.key} className="space-y-1.5">
              <div className="flex items-center gap-2">
                <h4 className="text-sm font-semibold text-foreground">{g.label}</h4>
                <span className="text-xs text-muted-foreground">{fmtCount(g.rows.length)}</span>
              </div>
              {renderTable(g.rows)}
            </div>
          ))}
        </div>
      )}

      </>
      )}

      <Sheet open={!!selected} onOpenChange={(open) => !open && setSelected(null)}>
        <SheetContent className="w-full sm:max-w-md overflow-y-auto">
          <SheetHeader>
            <SheetTitle>{selected?.full_name || 'Application'}</SheetTitle>
          </SheetHeader>
          {selected && <ApplicationDetail app={selected} onOpenCv={openCv} />}
          {selected && (
            <div className="pb-8 space-y-2">
              <Separator />
              <Label className="text-xs text-muted-foreground">Decision</Label>
              <div className="flex flex-wrap gap-2">
                {getAvailableDecisions(selected.status, selected.shortlist_round ?? null, wasContacted(selected)).map((a) => (
                  <Button
                    key={`${a.status}-${a.round ?? 'none'}`}
                    size="sm"
                    variant="outline"
                    className={(a.round ?? 0) >= 2 ? SHORTLIST_LEVEL_2_CLASS : undefined}
                    onClick={() => {
                      setPending({ row: selected, kind: a.status, writer: a.writer, round: a.round });
                    }}
                  >
                    {a.label}
                  </Button>
                ))}

                <Button
                  size="sm"
                  variant="destructive"
                  onClick={() => {
                    setPending({ row: selected, kind: 'remove' });
                  }}
                >
                  Remove
                </Button>
              </div>
            </div>
          )}
        </SheetContent>
      </Sheet>

      <AlertDialog open={!!pending} onOpenChange={(open) => !open && !busy && closeConfirm()}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {pending?.kind === 'remove'
                ? `Remove ${pending?.row.full_name || 'this application'}?`
                : pending?.writer === 'contacted'
                  ? `Mark ${pending?.row.full_name || 'this applicant'} as contacted?`
                  : `${pending ? DECISION_LABELS[pending.kind as ApplicationDecision] : ''} ${
                      pending?.row.full_name || 'this applicant'
                    }?`}
            </AlertDialogTitle>

            <AlertDialogDescription>
              {pending?.kind === 'remove'
                ? 'This hides the application from the list. The record is kept, not deleted.'
                : 'The decision is recorded straight away. No reason is needed.'}
            </AlertDialogDescription>
          </AlertDialogHeader>

          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={busy}
              onClick={(e) => {
                e.preventDefault();
                void runPending();
              }}
              className={pending?.kind === 'remove' ? 'bg-destructive text-destructive-foreground hover:bg-destructive/90' : undefined}
            >
              {busy ? 'Working…' : pending?.kind === 'remove' ? 'Remove' : 'Confirm'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Compose panel. Each selected applicant receives their own separate
          message — there is no cc or bcc field here by design. */}
      <Sheet open={composeOpen} onOpenChange={(open) => !sending && setComposeOpen(open)}>
        <SheetContent side="right" className="w-full sm:max-w-lg overflow-y-auto">
          <SheetHeader>
            <SheetTitle>Email selected applicants</SheetTitle>
          </SheetHeader>

          <div className="space-y-4 mt-4">
            <div className="rounded-lg border p-3 text-xs space-y-1">
              <p>
                <span className="font-semibold">{fmtCount(recipientsWithEmail.length)}</span>{' '}
                individual email{recipientsWithEmail.length === 1 ? '' : 's'} will be sent — one per
                person, each addressed only to that person.
              </p>
              {recipients.length !== recipientsWithEmail.length && (
                <p className="text-muted-foreground">
                  {fmtCount(recipients.length - recipientsWithEmail.length)} selected applicant(s)
                  have no email address on file and will be skipped.
                </p>
              )}
              <p className="text-muted-foreground">
                Suppressed and unsubscribed addresses are skipped automatically.
              </p>
            </div>

            <div className="space-y-1.5">
              <Label className="text-xs">Subject</Label>
              <Input
                value={emailSubject}
                onChange={(e) => setEmailSubject(e.target.value)}
                placeholder="Update on your Welile application"
              />
            </div>

            <div className="space-y-1.5">
              <Label className="text-xs">Message</Label>
              <Textarea
                value={emailBody}
                onChange={(e) => setEmailBody(e.target.value)}
                rows={10}
                placeholder={'Write your message. Use {{name}} for the recipient\'s own name, {{role}} for the role they applied for and {{reference}} for their own application reference.'}
              />
              <p className="text-[11px] text-muted-foreground">
                Supported placeholders: {'{{name}}'}, {'{{role}}'}, {'{{reference}}'} — each is
                replaced with that recipient's own details. If no role was recorded, {'{{role}}'}
                becomes "the role you applied for". Their reference is also printed at the foot of
                every message. Any other {'{{token}}'} stops the send.
              </p>
            </div>

            <Button
              className="w-full"
              disabled={
                sending ||
                recipientsWithEmail.length === 0 ||
                emailSubject.trim().length === 0 ||
                emailBody.trim().length < 10
              }
              onClick={() => setConfirmSend(true)}
            >
              Review and send
            </Button>
          </div>
        </SheetContent>
      </Sheet>

      <AlertDialog open={confirmSend} onOpenChange={(open) => !sending && setConfirmSend(open)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Send {fmtCount(recipientsWithEmail.length)} individual email
              {recipientsWithEmail.length === 1 ? '' : 's'}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              Exactly {fmtCount(recipientsWithEmail.length)} separate message
              {recipientsWithEmail.length === 1 ? '' : 's'} will be queued, one per recipient. No
              recipient can see any other. Suppressed addresses are skipped and every send is
              logged against the applicant.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={sending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={sending}
              onClick={(e) => {
                e.preventDefault();
                void runSend();
              }}
            >
              {sending ? 'Sending…' : `Send ${fmtCount(recipientsWithEmail.length)}`}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function Field({ label, value }: { label: string; value: React.ReactNode }) {
  if (value === null || value === undefined || value === '') return null;
  return (
    <div className="space-y-1">
      <Label className="text-xs text-muted-foreground">{label}</Label>
      <p className="text-sm break-words">{value}</p>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="space-y-3">
      <h4 className="text-sm font-semibold">{title}</h4>
      <div className="grid grid-cols-1 gap-3">{children}</div>
    </div>
  );
}

function ApplicationDetail({
  app,
  onOpenCv,
}: {
  app: JobApplicationRow;
  onOpenCv: (path: string) => void;
}) {
  return (
    <div className="space-y-6 py-4">
      <Section title="Contact">
        <Field label="Full name" value={app.full_name} />
        <Field label="Email" value={app.email} />
        <Field label="WhatsApp" value={app.whatsapp_number} />
        <Field label="Location" value={app.location} />
      </Section>

      <Separator />

      <Section title="Role and experience">
        <Field label="Role interest" value={app.role_interest} />
        <Field label="Category" value={app.category} />
        <Field label="Experience level" value={app.experience_level} />
        <Field label="Employment type" value={app.employment_type} />
        <Field
          label="Availability date"
          value={app.availability_date ? fmtDate(app.availability_date) : null}
        />
        {app.cover_note && (
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">Cover note</Label>
            <CoverNoteSections text={app.cover_note} />
          </div>
        )}
      </Section>

      <Separator />

      <Section title="Education and employer">
        <Field label="Highest education" value={app.highest_education} />
        <Field label="Current employer" value={app.current_employer} />
      </Section>

      <Separator />

      <Section title="Links">
        {app.portfolio_url && (
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">Portfolio</Label>
            <a
              href={app.portfolio_url}
              target="_blank"
              rel="noopener noreferrer"
              className="text-sm text-primary hover:underline break-all block"
            >
              {app.portfolio_url}
            </a>
          </div>
        )}
        {app.linkedin_url && (
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">LinkedIn</Label>
            <a
              href={app.linkedin_url}
              target="_blank"
              rel="noopener noreferrer"
              className="text-sm text-primary hover:underline break-all block"
            >
              {app.linkedin_url}
            </a>
          </div>
        )}
        {app.resume_url ? (
          <div className="space-y-2">
            <Label className="text-xs text-muted-foreground">CV</Label>
            <Button size="sm" variant="outline" onClick={() => onOpenCv(app.resume_url!)}>
              <FileText className="h-4 w-4 mr-2" />
              View CV
            </Button>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">No CV attached</p>
        )}
      </Section>

      <Separator />

      <Section title="Consent">
        <Field label="Consent text version" value={app.consent_text_version} />
        <Field
          label="Consented at"
          value={app.consented_at ? fmtDateTime(app.consented_at) : null}
        />
        <Field label="Future roles consent" value={app.future_roles_consent ? 'Yes' : 'No'} />
      </Section>

      <Separator />

      <Section title="Workflow">
        <Field label="Status" value={app.status} />
        <Field
          label="Contacted at"
          value={app.contacted_at ? fmtDateTime(app.contacted_at) : null}
        />
        <Field
          label="Decided at"
          value={app.decided_at ? fmtDateTime(app.decided_at) : null}
        />
        <Field label="Decision reason" value={app.decision_reason} />
      </Section>

      <Separator />

      <Section title="Source and UTM">
        <Field label="Source" value={app.source} />
        <Field label="UTM source" value={app.utm_source} />
        <Field label="UTM medium" value={app.utm_medium} />
        <Field label="UTM campaign" value={app.utm_campaign} />
      </Section>

      <Separator />

      <Section title="Reference">
        <Field label="Public reference" value={app.public_ref} />
      </Section>

      <Separator />

      <Section title="Record">
        <Field label="Created at" value={fmtDateTime(app.created_at)} />
        <Field label="Updated at" value={fmtDateTime(app.updated_at)} />
      </Section>
    </div>
  );
}

export default function RecruitmentHub() {
  const navigate = useNavigate();

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [postings, setPostings] = useState<JobPosting[]>([]);

  const { data: applicationCount } = useQuery({
    queryKey: ['job-applications-count'],
    queryFn: async () => {
      const { count, error } = await supabase
        .from('job_applications')
        .select('*', { count: 'exact', head: true })
        .is('archived_at', null)
        .is('purged_at', null)
        .like('source', '%?c=%');
      if (error) throw new Error(error.message);
      return count ?? 0;
    },
  });
  const { data: poolRows = [] } = useQuery({
    queryKey: ['job-applications-pool'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('job_applications')
        .select('*')
        .is('archived_at', null)
        .is('purged_at', null)
        .order('created_at', { ascending: false })
        .limit(500);
      if (error) throw new Error(error.message);
      return (data ?? []) as JobApplicationRow[];
    },
  });
  const { data: internshipCount } = useQuery({
    queryKey: ['internship-applications-count'],
    queryFn: async () => {
      const { count, error } = await supabase
        .from('internship_applications')
        .select('*', { count: 'exact', head: true })
        .is('purged_at', null);
      if (error) throw new Error(error.message);
      return count ?? 0;
    },
  });
  const [departments, setDepartments] = useState<Department[]>([]);

  const [tab, setTab] = useState(() => {
    if (typeof window === 'undefined') return 'applications';
    const saved = window.localStorage.getItem('welile-recruitment-active-tab');
    const valid = ['applications', 'internships', 'postings', 'pool'];
    return saved && valid.includes(saved) ? saved : 'applications';
  });

  useEffect(() => {
    window.localStorage.setItem('welile-recruitment-active-tab', tab);
  }, [tab]);

  // ── Internships "new application" beacon ────────────────────────────────
  const INTERNSHIP_SEEN_KEY = 'welile-internships-last-seen';
  const [internshipSeenAt, setInternshipSeenAt] = useState<string>(() => {
    if (typeof window === 'undefined') return new Date(0).toISOString();
    return window.localStorage.getItem(INTERNSHIP_SEEN_KEY) ?? new Date(0).toISOString();
  });
  const { data: latestInternshipAt, refetch: refetchLatestInternship } = useQuery({
    queryKey: ['internships-latest-created-at'],
    refetchInterval: 60_000,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('internship_applications')
        .select('created_at')
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) throw new Error(error.message);
      return (data?.created_at as string | undefined) ?? null;
    },
  });

  useEffect(() => {
    const channel = supabase
      .channel('recruitment-internship-beacon')
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'internship_applications' },
        () => { void refetchLatestInternship(); },
      )
      .subscribe();
    return () => { void supabase.removeChannel(channel); };
  }, [refetchLatestInternship]);

  const hasNewInternships = Boolean(
    latestInternshipAt && new Date(latestInternshipAt) > new Date(internshipSeenAt),
  );

  useEffect(() => {
    if (tab !== 'internships') return;
    const stamp = latestInternshipAt ?? new Date().toISOString();
    window.localStorage.setItem(INTERNSHIP_SEEN_KEY, stamp);
    setInternshipSeenAt(stamp);
  }, [tab, latestInternshipAt]);
  const [confirmClose, setConfirmClose] = useState<JobPosting | null>(null);
  const [togglingId, setTogglingId] = useState<string | null>(null);


  const [poolSearch, setPoolSearch] = useState('');
  const [poolSource, setPoolSource] = useState<string>(ALL);
  const [poolLocation, setPoolLocation] = useState<string>(ALL);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      try {
        const [jobs, deps] = await Promise.all([
          getJobPostings(),
          getDepartments(),
        ]);
        if (cancelled) return;
        setPostings(jobs);
        setDepartments(deps);
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : 'Could not load recruitment data.');
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const departmentName = (id: string) =>
    departments.find((d) => d.id === id)?.name ?? 'Unassigned';
  const activePostingsCount = postings.filter((p) => p.status === 'open').length;


  async function refreshPostings() {
    const jobs = await getJobPostings();
    setPostings(jobs);
  }

  async function applyStatusChange(id: string, status: 'open' | 'closed') {
    setTogglingId(id);
    try {
      await setJobPostingStatus(id, status);
      await refreshPostings();
      toast.success(`Posting ${status === 'open' ? 'opened' : 'closed'}`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not update posting');
    } finally {
      setTogglingId(null);
      setConfirmClose(null);
    }
  }

  function handleStatusToggle(job: JobPosting, nextStatus: 'open' | 'closed') {
    if (nextStatus === 'closed') {
      setConfirmClose(job);
      return;
    }
    applyStatusChange(job.id, 'open');
  }


  /** Candidate currently open in the talent-pool review panel. */
  const [poolSelected, setPoolSelected] = useState<JobApplicationRow | null>(null);

  const openPoolCv = async (path: string) => {
    try {
      const url = await getResumeUrl(path);
      window.open(url, '_blank', 'noopener,noreferrer');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not open CV');
    }
  };

  const poolSpeculative = useMemo(
    () => poolRows.filter((r) => !(r.source ?? '').includes('?c=')),
    [poolRows],
  );


  const poolOptionSources = useMemo(
    () =>
      Array.from(
        new Set(poolSpeculative.map((r) => r.source).filter((s): s is string => Boolean(s))),
      ).sort(),
    [poolSpeculative],
  );

  const poolOptionLocations = useMemo(
    () =>
      Array.from(
        new Set(poolSpeculative.map((r) => r.location).filter((l): l is string => Boolean(l))),
      ).sort(),
    [poolSpeculative],
  );

  const poolVisible = useMemo(() => {
    const term = poolSearch.trim().toLowerCase();
    let data = poolSpeculative;
    if (term) {
      data = data.filter((r) =>
        [r.full_name, r.email, r.whatsapp_number, r.location].some((v) =>
          (v ?? '').toLowerCase().includes(term),
        ),
      );
    }
    if (poolLocation !== ALL) {
      data = data.filter((r) => r.location === poolLocation);
    }
    if (poolSource !== ALL) {
      data = data.filter((r) => r.source === poolSource);
    }
    return data.sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
  }, [poolSpeculative, poolSearch, poolLocation, poolSource]);

  if (loading) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-32 w-full" />
        <Skeleton className="h-32 w-full" />
      </div>
    );
  }

  if (error) {
    return (
      <Card className="p-6 border-destructive/40 flex items-start gap-3">
        <AlertTriangle className="h-5 w-5 text-destructive shrink-0 mt-0.5" />
        <div>
          <p className="text-sm font-semibold text-foreground">Could not load recruitment</p>
          <p className="text-xs text-muted-foreground mt-1">{error}</p>
        </div>
      </Card>
    );
  }

  return (
    <>
      <Tabs value={tab} onValueChange={setTab} className="space-y-4">
        <TabsList className="grid grid-cols-4 w-full">
        <TabsTrigger value="applications">
          Applications {typeof applicationCount === 'number' ? `(${fmtCount(applicationCount)})` : ''}
        </TabsTrigger>
        <TabsTrigger value="internships" className="relative">
          Internships {typeof internshipCount === 'number' ? `(${fmtCount(internshipCount)})` : ''}
          {hasNewInternships && (
            <span className="absolute top-1 right-1 flex h-2 w-2" aria-label="New internship application">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-500 opacity-75" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-500" />
            </span>
          )}
        </TabsTrigger>
        <TabsTrigger value="postings">Postings {activePostingsCount > 0 ? `(${fmtCount(activePostingsCount)})` : ''}</TabsTrigger>
        <TabsTrigger value="pool">Talent Pool {poolSpeculative.length > 0 ? `(${fmtCount(poolSpeculative.length)})` : ''}</TabsTrigger>
      </TabsList>

      {/* ---------------- Applications ---------------- */}
      <TabsContent value="applications" className="space-y-3">
        <ApplicationsTab />
      </TabsContent>

      {/* ---------------- Internships ---------------- */}
      <TabsContent value="internships" className="space-y-3">
        <HRInternshipApplications />
      </TabsContent>

      {/* ---------------- Postings ---------------- */}
      <TabsContent value="postings" className="space-y-3">
        {postings.length === 0 ? (
          <div className="text-center py-10 text-muted-foreground">
            <FileText className="h-8 w-8 mx-auto mb-2 opacity-50" />
            No job postings yet.
          </div>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2">
            {postings.map((job) => {
              const alwaysOpen = isAlwaysOpen(job);
              return (
                <Card
                  key={job.id}
                  className={
                    alwaysOpen
                      ? 'p-4 border-2 border-dashed border-primary/40 bg-primary/5'
                      : 'p-4'
                  }
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <h3 className="font-semibold truncate">{job.title}</h3>
                      <p className="text-xs text-muted-foreground">
                        {departmentName(job.department_id)} · {job.location}
                      </p>
                    </div>
                    {alwaysOpen ? (
                      <Badge
                        variant="outline"
                        className="bg-primary/10 text-primary border-primary/30 shrink-0"
                      >
                        Always open
                      </Badge>
                    ) : (
                      <Badge
                        variant="outline"
                        className={`${POSTING_STATUS_CLASS[job.status]} capitalize shrink-0`}
                      >
                        {job.status}
                      </Badge>
                    )}
                  </div>

                  {alwaysOpen && (
                    <p className="text-xs text-muted-foreground mt-2">
                      Permanent intake, not a vacancy.
                    </p>
                  )}

                  {!alwaysOpen && (
                    <div className="mt-3 flex items-center justify-between gap-3">
                      <span className="text-xs text-muted-foreground">
                        {job.status === 'open'
                          ? 'Accepting applications'
                          : 'Not accepting applications'}
                      </span>
                      <Switch
                        checked={job.status === 'open'}
                        disabled={job.status === 'draft' || togglingId === job.id}
                        onCheckedChange={(checked) =>
                          handleStatusToggle(job, checked ? 'open' : 'closed')
                        }
                      />
                    </div>
                  )}

                  <div className="grid grid-cols-2 gap-2 mt-3 text-xs text-muted-foreground">
                    <div>
                      Employment:{' '}
                      <span className="text-foreground">
                        {EMPLOYMENT_LABELS[job.employment_type]}
                      </span>
                    </div>
                    <div>
                      Applications:{' '}
                      <span className="text-foreground">{job.application_count}</span>
                    </div>
                    <div>
                      Closes:{' '}
                      <span className="text-foreground">
                        {job.closes_at ? fmtDate(job.closes_at) : 'No closing date'}
                      </span>
                    </div>
                  </div>

                  <a
                    href={`https://welile.com/careers?c=${job.public_slug}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="mt-3 font-mono text-xs text-primary break-all hover:underline block"
                  >
                    welile.com/careers?c={job.public_slug}
                  </a>
                </Card>
              );
            })}
          </div>
        )}
      </TabsContent>

      {/* ---------------- Talent pool ---------------- */}
      <TabsContent value="pool" className="space-y-3">
        <Card className="p-4 bg-primary/5 border-primary/30">
          <p className="text-sm text-foreground">
            Before advertising a new role, search here first. Everyone in this pool has already
            applied to Welile and consented to being contacted.
          </p>
        </Card>

        <div className="flex flex-wrap items-center gap-2">
          <div className="relative flex-1 min-w-[200px]">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              value={poolSearch}
              onChange={(e) => setPoolSearch(e.target.value)}
              placeholder="Search name, email, phone or location"
              className="pl-8 h-9"
            />
          </div>
          <Select value={poolSource} onValueChange={setPoolSource}>
            <SelectTrigger className="w-[180px] h-9">
              <SelectValue placeholder="Source" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>All sources</SelectItem>
              {poolOptionSources.map((s) => (
                <SelectItem key={s} value={s}>
                  {s}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={poolLocation} onValueChange={setPoolLocation}>
            <SelectTrigger className="w-[180px] h-9">
              <SelectValue placeholder="Location" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>All locations</SelectItem>
              {poolOptionLocations.map((l) => (
                <SelectItem key={l} value={l}>
                  {l}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {poolVisible.length === 0 ? (
          <div className="text-center py-10 text-muted-foreground">
            <Users className="h-8 w-8 mx-auto mb-2 opacity-50" />
            {poolSpeculative.length === 0
              ? 'Nobody has applied speculatively yet.'
              : 'No candidates match these filters.'}
          </div>
        ) : (
          <Card className="divide-y divide-border">
            {poolVisible.map((row) => (
              <button
                key={row.id}
                type="button"
                onClick={() => setPoolSelected(row)}
                className="w-full text-left flex flex-wrap items-center justify-between gap-3 px-4 py-3 transition-colors hover:bg-muted/50 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <div className="min-w-0">
                  <p className="text-sm font-medium text-foreground truncate">{row.full_name || '—'}</p>
                  <p className="text-xs text-muted-foreground">{row.location || '—'}</p>
                </div>
                <div className="flex items-center gap-3">
                  <Badge variant="outline" className="text-[10px]">
                    {row.role_interest || '—'}
                  </Badge>
                  <div className="text-right">
                    <p className="text-xs text-foreground">
                      Applied {fmtDateTime(row.created_at)}
                    </p>
                    <p className="text-[11px] text-muted-foreground">
                      {row.public_ref || '—'}
                    </p>
                  </div>
                </div>
              </button>
            ))}
          </Card>
        )}

        {/* Read-only review of a pooled candidate. No decision buttons: the
            talent pool is a sourcing list, decisions live on Applications. */}
        <Sheet open={!!poolSelected} onOpenChange={(open) => !open && setPoolSelected(null)}>
          <SheetContent className="w-full sm:max-w-md overflow-y-auto">
            <SheetHeader>
              <SheetTitle>{poolSelected?.full_name || 'Candidate'}</SheetTitle>
            </SheetHeader>
            {poolSelected && <ApplicationDetail app={poolSelected} onOpenCv={openPoolCv} />}
          </SheetContent>
        </Sheet>
      </TabsContent>

    </Tabs>

    <AlertDialog
      open={!!confirmClose}
      onOpenChange={(open) => {
        if (!open) setConfirmClose(null);
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Close posting?</AlertDialogTitle>
          <AlertDialogDescription>
            You are about to close <strong>{confirmClose?.title}</strong>. The public form will
            stop accepting applications immediately.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel onClick={() => setConfirmClose(null)}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            onClick={() =>
              confirmClose && applyStatusChange(confirmClose.id, 'closed')
            }
          >
            Close posting
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
    </>
  );
}
