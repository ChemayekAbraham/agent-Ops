/**
 * ProxyAgentDirectory — Partner Ops directory of every proxy agent.
 * 4 KPI cards + searchable list (avatar, contacts, notes, partners that came
 * in, join date, referred by) with an inline full-section detail view and bulk
 * removal of proxy rights.
 *
 * One RPC serves KPIs + page rows; the detail view uses one RPC per agent.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useVirtualizer } from '@tanstack/react-virtual';
import { format } from 'date-fns';
import {
  BadgeCheck,
  ChevronLeft,
  ChevronRight,
  Download,
  FileText,
  Link2,
  Handshake,
  Loader2,
  RefreshCw,
  Search,
  SlidersHorizontal,
  ShieldOff,
  Trash2,
  TrendingUp,
  UserCog,
  UserPlus,
  Users,
} from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Textarea } from '@/components/ui/textarea';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { useToast } from '@/hooks/use-toast';
import { useDebouncedValue } from '@/hooks/useDebouncedValue';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { cn } from '@/lib/utils';
import { formatUGX } from '@/lib/rentCalculations';
import {
  fetchProxyDirectory,
  fetchProxyTargetOverview,
  proxyInitials,
  proxyStatusTone,
  PROXY_CONTACT_FILTERS,
  PROXY_DIR_PAGE_SIZE,
  PROXY_TARGET_METRICS,
  type ProxyContactFilter,
  type ProxyDirRow,
} from './proxyAgentDirectory';
import { ProxyAgentDetailPanel } from './ProxyAgentDetailPanel';
import { OnboardProxyAgentDialog } from './OnboardProxyAgentDialog';
import { ProxyOnboardingAuditPanel } from './ProxyOnboardingAuditPanel';
import { ProxyAgentTargetPanel } from './ProxyAgentTargetPanel';
import { ProxyAgentQuickView } from './ProxyAgentQuickView';


const STATUS_TABS: { key: string; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'approved', label: 'Approved' },
  { key: 'pending', label: 'Pending' },
  { key: 'suspended', label: 'Suspended' },
];

function KpiCard({
  icon: Icon,
  label,
  value,
  sub,
}: {
  icon: typeof Users;
  label: string;
  value: string;
  sub: string;
}) {
  return (
    <Card>
      <CardContent className="p-4">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <p className="text-[10px] font-bold uppercase tracking-wide text-muted-foreground">{label}</p>
            <p className="mt-1 truncate text-xl font-bold tabular-nums">{value}</p>
            <p className="mt-0.5 truncate text-[11px] text-muted-foreground">{sub}</p>
          </div>
          <div className="rounded-xl border bg-muted/50 p-2">
            <Icon className="h-4 w-4 text-muted-foreground" />
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

/** Read one shareable-view parameter out of the current address bar. */
function linkParam(key: string): string {
  if (typeof window === 'undefined') return '';
  return new URLSearchParams(window.location.search).get(key) ?? '';
}

export function ProxyAgentDirectory() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [search, setSearch] = useState(() => linkParam('pd_q'));
  const [onboardOpen, setOnboardOpen] = useState(false);
  const [status, setStatus] = useState(() => linkParam('pd_status') || 'all');
  const [activatedFrom, setActivatedFrom] = useState(() => linkParam('pd_from'));
  const [activatedTo, setActivatedTo] = useState(() => linkParam('pd_to'));
  const [contact, setContact] = useState<ProxyContactFilter>(
    () => (linkParam('pd_contact') || 'all') as ProxyContactFilter,
  );
  const [advancedOpen, setAdvancedOpen] = useState(
    () => !!(linkParam('pd_from') || linkParam('pd_to') || linkParam('pd_contact')),
  );
  const [page, setPage] = useState(() => Math.max(0, Number(linkParam('pd_page') || 1) - 1));
  const [pageSize, setPageSize] = useState(
    () => Number(linkParam('pd_size')) || PROXY_DIR_PAGE_SIZE,
  );
  const [selected, setSelected] = useState<ProxyDirRow | null>(null);
  const [quickView, setQuickView] = useState<ProxyDirRow | null>(null);

  const [checked, setChecked] = useState<Record<string, boolean>>({});
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [approveOpen, setApproveOpen] = useState(false);
  const [approveNote, setApproveNote] = useState('');
  const [approveProgress, setApproveProgress] = useState({ done: 0, total: 0 });
  const [approveResults, setApproveResults] = useState<string[]>([]);
  const [exporting, setExporting] = useState(false);
  const [linkCopied, setLinkCopied] = useState(false);



  const query = useDebouncedValue(search, 350);

  const activeFilterCount =
    (activatedFrom ? 1 : 0) + (activatedTo ? 1 : 0) + (contact !== 'all' ? 1 : 0);

  /**
   * Build a shareable address for exactly what is on screen: the search text,
   * the status tab, the advanced filters, the page and — when one is open or
   * given — the agent to preselect.
   */
  const buildViewLink = (agent?: ProxyDirRow | null) => {
    const url = new URL(window.location.href);
    const put = (key: string, value: string) => {
      if (value) url.searchParams.set(key, value);
      else url.searchParams.delete(key);
    };
    put('pd_q', search.trim());
    put('pd_status', status !== 'all' ? status : '');
    put('pd_from', activatedFrom);
    put('pd_to', activatedTo);
    put('pd_contact', contact !== 'all' ? contact : '');
    put('pd_size', pageSize !== PROXY_DIR_PAGE_SIZE ? String(pageSize) : '');
    put('pd_page', page > 0 ? String(page + 1) : '');
    const target = agent ?? quickView ?? selected;
    put('pd_agent', target?.agent_user_id ?? '');
    return url.toString();
  };

  const copyViewLink = async (agent?: ProxyDirRow | null) => {
    const link = buildViewLink(agent);
    try {
      await navigator.clipboard.writeText(link);
      window.history.replaceState(null, '', link);
      setLinkCopied(true);
      setTimeout(() => setLinkCopied(false), 2000);
      toast({
        title: 'Link copied',
        description: 'Anyone on Partner Ops who opens it sees this exact list.',
      });
    } catch {
      toast({
        title: 'Could not copy the link',
        description: link,
        variant: 'destructive',
      });
    }
  };

  const resetPaging = () => {
    setPage(0);
    setChecked({});
  };

  const clearAdvanced = () => {
    setActivatedFrom('');
    setActivatedTo('');
    setContact('all');
    resetPaging();
  };

  // Download the current search results (all pages, not just the one on screen)
  // together with this month's targets, as a spreadsheet-friendly CSV.
  const handleExportCsv = async () => {
    if (exporting) return;
    setExporting(true);
    try {
      const month = format(new Date(), 'yyyy-MM');
      const filters = { search: query, status, activatedFrom, activatedTo, contact };
      const CHUNK = 500;
      const MAX_ROWS = 100_000;

      const [overview, firstChunk] = await Promise.all([
        fetchProxyTargetOverview(month).catch(() => null),
        fetchProxyDirectory(filters, 0, CHUNK),
      ]);

      const allRows: ProxyDirRow[] = [...firstChunk.rows];
      const grandTotal = Math.min(firstChunk.total ?? allRows.length, MAX_ROWS);
      while (allRows.length < grandTotal) {
        const next = await fetchProxyDirectory(filters, allRows.length, CHUNK);
        if (!next.rows.length) break;
        allRows.push(...next.rows);
      }

      const targetCols = PROXY_TARGET_METRICS.map((m) => ({
        label: `Monthly target — ${m.label}`,
        value: overview?.targets?.[m.key]?.target_value ?? null,
      }));

      const headers = [
        'Name',
        'Status',
        'Phone',
        'Email',
        'District',
        'Invite code',
        'Joined',
        'Activated',
        'Referred by',
        'Notes total',
        'Notes pending',
        'Notes activated',
        'Notes amount (UGX)',
        'Notes collected (UGX)',
        'Partners linked',
        'Partners who put in money',
        'Partner funded (UGX)',
        'Earned (UGX)',
        'Target month',
        ...targetCols.map((c) => c.label),
      ];

      const esc = (v: unknown) => {
        const s = v === null || v === undefined ? '' : String(v);
        return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
      };
      const day = (v: string | null) => (v ? format(new Date(v), 'yyyy-MM-dd') : '');

      const lines = [
        headers.join(','),
        ...allRows.map((r) =>
          [
            r.name,
            r.status,
            r.phone,
            r.email,
            r.district,
            r.invite_code,
            day(r.joined_at),
            day(r.approved_at),
            r.referrer_name,
            r.notes_count,
            r.notes_pending,
            r.notes_activated,
            r.notes_amount,
            r.notes_collected,
            r.partners_linked,
            r.partners_came_in,
            r.partner_funded,
            r.earned,
            month,
            ...targetCols.map((c) => c.value ?? ''),
          ]
            .map(esc)
            .join(','),
        ),
      ];

      const blob = new Blob(['\uFEFF' + lines.join('\n')], { type: 'text/csv;charset=utf-8;' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `proxy-agent-directory-${month}.csv`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);

      toast({
        title: 'Download ready',
        description: `${allRows.length.toLocaleString()} proxy agent${allRows.length === 1 ? '' : 's'} exported with this month's targets.`,
      });
    } catch (e) {
      toast({
        title: 'Could not download the list',
        description: e instanceof Error ? e.message : 'Please try again.',
        variant: 'destructive',
      });
    } finally {
      setExporting(false);
    }
  };



  // Exactly ONE page of rows per request — never accumulates, so the screen
  // costs the same with 1,000 or 1,000,000 proxy agents.
  const pageQueries = useQuery({
    queryKey: ['proxy-agent-directory', query, status, activatedFrom, activatedTo, contact, page, pageSize],
    queryFn: () =>
      fetchProxyDirectory(
        { search: query, status, activatedFrom, activatedTo, contact },
        page * pageSize,
        pageSize,
      ),
    staleTime: 30_000,
    placeholderData: (prev) => prev,
  });


  const rows = pageQueries.data?.rows ?? [];

  // A shared link can name an agent — open their quick view once the list
  // that contains them has loaded (only ever the first time).
  const deepLinkAgentId = useRef(linkParam('pd_agent'));
  useEffect(() => {
    const id = deepLinkAgentId.current;
    if (!id || !rows.length) return;
    const match = rows.find((r) => r.agent_user_id === id);
    if (!match) return;
    deepLinkAgentId.current = '';
    setQuickView(match);
  }, [rows]);

  const kpis = pageQueries.data?.kpis;
  const total = pageQueries.data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const firstShown = total === 0 ? 0 : page * pageSize + 1;
  const lastShown = page * pageSize + rows.length;


  const conversion = useMemo(() => {
    if (!kpis || !kpis.partners_linked) return 0;
    return Math.round((kpis.partners_came_in / kpis.partners_linked) * 100);
  }, [kpis]);

  const selectedIds = useMemo(
    () => Object.entries(checked).filter(([, v]) => v).map(([k]) => k),
    [checked],
  );
  const selectedRows = useMemo(
    () => rows.filter((r) => checked[r.agent_user_id]),
    [rows, checked],
  );
  const selectedTotals = useMemo(
    () =>
      selectedRows.reduce(
        (acc, r) => ({
          notes: acc.notes + Number(r.notes_count || 0),
          amount: acc.amount + Number(r.notes_amount || 0),
          partners: acc.partners + Number(r.partners_linked || 0),
        }),
        { notes: 0, amount: 0, partners: 0 },
      ),
    [selectedRows],
  );

  const allOnPage = rows.length > 0 && rows.every((r) => checked[r.agent_user_id]);

  // Virtualized rendering: only the rows actually on screen are mounted, so a
  // 200-row page (or any future larger page) paints as fast as a 30-row one.
  const listRef = useRef<HTMLDivElement | null>(null);
  const virtualize = rows.length > 40;
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => listRef.current,
    estimateSize: () => 66,
    overscan: 8,
  });
  const virtualItems = virtualizer.getVirtualItems();
  const renderList = virtualize
    ? virtualItems.map((v) => ({ r: rows[v.index], v }))
    : rows.map((r) => ({ r, v: null as (typeof virtualItems)[number] | null }));


  const bulkDelete = useMutation({
    mutationFn: async () => {
      const { data, error } = await supabase.rpc('partner_ops_bulk_delete_proxy_agents', {
        p_agent_ids: selectedIds,
        p_reason: reason.trim(),
      });
      if (error) throw error;
      return data as any;
    },
    onSuccess: (res) => {
      toast({
        title: 'Proxy agents removed',
        description: `${res?.agents_deleted ?? 0} agent(s) removed · ${res?.notes_deleted ?? 0} promissory note(s) deleted.`,
      });
      setChecked({});
      setReason('');
      setConfirmOpen(false);
      setSelected(null);
      qc.invalidateQueries({ queryKey: ['proxy-agent-directory'] });
      qc.invalidateQueries({ queryKey: ['proxy-agent-detail'] });
    },
    onError: (e: any) =>
      toast({ title: 'Delete failed', description: e.message, variant: 'destructive' }),
  });

  /**
   * Bulk approve + notify. Each agent goes through the SAME single-agent RPC
   * used by the onboarding dialog (so approval, role grant and audit snapshots
   * stay identical), then gets the proxy role/benefits email. Runs 4 at a time
   * so a large selection never floods the backend.
   */
  const bulkApprove = useMutation({
    mutationFn: async () => {
      const targets = selectedRows.length ? selectedRows : [];
      const note = approveNote.trim() || null;
      const today = new Date().toISOString().slice(0, 10);
      const summary = { approved: 0, emailed: 0, skipped: 0, failed: [] as string[] };
      setApproveProgress({ done: 0, total: targets.length });

      const queue = [...targets];
      const worker = async () => {
        for (;;) {
          const r = queue.shift();
          if (!r) return;
          try {
            const { data, error } = await supabase.rpc('partner_ops_onboard_proxy_agent', {
              p_agent_user_id: r.agent_user_id,
              p_nin: null,
              p_notes: note,
            });
            if (error) throw new Error(error.message);
            summary.approved += 1;
            const res = (data ?? {}) as { email?: string | null; full_name?: string | null };
            const recipientEmail = (res.email ?? r.email ?? '').trim();
            if (recipientEmail) {
              const { error: mailError } = await supabase.functions.invoke('send-transactional-email', {
                body: {
                  templateName: 'proxy-agent-onboarded',
                  recipientEmail,
                  idempotencyKey: `proxy-agent-onboarded-${r.agent_user_id}-${today}`,
                  templateData: {
                    recipient_name: res.full_name ?? r.name ?? 'there',
                    onboarded_on: new Date().toLocaleDateString('en-GB', {
                      day: '2-digit',
                      month: 'long',
                      year: 'numeric',
                    }),
                  },
                },
              });
              if (mailError) summary.skipped += 1;
              else summary.emailed += 1;
            } else {
              summary.skipped += 1;
            }
          } catch (err) {
            summary.failed.push(`${r.name}: ${err instanceof Error ? err.message : 'failed'}`);
          } finally {
            setApproveProgress((p) => ({ done: p.done + 1, total: p.total }));
          }
        }
      };
      await Promise.all(Array.from({ length: Math.min(4, targets.length) }, worker));
      return summary;
    },
    onSuccess: (res) => {
      toast({
        title: res.failed.length ? 'Finished with some problems' : 'Proxy agents approved',
        description: `${res.approved} approved · ${res.emailed} emailed · ${res.skipped} without a reachable email${
          res.failed.length ? ` · ${res.failed.length} failed` : ''
        }`,
        variant: res.failed.length ? 'destructive' : undefined,
      });
      setApproveResults(res.failed);
      if (!res.failed.length) {
        setApproveOpen(false);
        setApproveNote('');
        setChecked({});
      }
      void qc.invalidateQueries({ queryKey: ['proxy-agent-directory'] });
      void qc.invalidateQueries({ queryKey: ['proxy-agent-detail'] });
      void qc.invalidateQueries({ queryKey: ['proxy-onboarding-audit'] });
    },
    onError: (e: any) =>
      toast({ title: 'Bulk approval failed', description: e.message, variant: 'destructive' }),
  });



  const goToPage = (p: number) => {
    setPage(Math.min(Math.max(0, p), totalPages - 1));
    setChecked({});
  };


  if (selected) {
    return (
      <ProxyAgentDetailPanel
        agent={selected}
        transferTargets={rows}
        onBack={() => setSelected(null)}
      />
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="flex items-center gap-2 text-lg font-bold">
            <UserCog className="h-5 w-5 text-primary" />
            Proxy Agent Directory
          </h2>
          <p className="text-xs text-muted-foreground">
            Bio data, promissory notes, linked partners and earnings for every proxy agent.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button size="sm" className="h-8 text-xs" onClick={() => setOnboardOpen(true)}>
            <UserPlus className="mr-1.5 h-3.5 w-3.5" />
            Onboard Proxy Agent
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="h-8 text-xs"
            onClick={() => void copyViewLink()}
            title="Copy a link that reopens this exact list"
          >
            <Link2 className="mr-1.5 h-3.5 w-3.5" />
            {linkCopied ? 'Link copied' : 'Copy link to this view'}
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="h-8 text-xs"
            onClick={handleExportCsv}
            disabled={exporting}
          >
            {exporting ? (
              <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
            ) : (
              <Download className="mr-1.5 h-3.5 w-3.5" />
            )}
            {exporting ? 'Preparing…' : 'Download CSV'}
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="h-8 text-xs"
            onClick={() => qc.invalidateQueries({ queryKey: ['proxy-agent-directory'] })}
          >
            <RefreshCw className={cn('mr-1.5 h-3.5 w-3.5', pageQueries.isFetching && 'animate-spin')} />
            Refresh
          </Button>
        </div>
      </div>

      <OnboardProxyAgentDialog open={onboardOpen} onOpenChange={setOnboardOpen} />

      <ProxyAgentTargetPanel />

      {/* KPI cards */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {!kpis ? (
          Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-[104px] rounded-xl" />)
        ) : (
          <>
            <KpiCard
              icon={UserCog}
              label="Proxy agents"
              value={String(kpis.agents_total)}
              sub={`${kpis.agents_approved} approved · ${kpis.agents_suspended} not active`}
            />
            <KpiCard
              icon={Handshake}
              label="Partners came in"
              value={String(kpis.partners_came_in)}
              sub={`${conversion}% of ${kpis.partners_linked} linked`}
            />
            <KpiCard
              icon={FileText}
              label="Promissory pending"
              value={String(kpis.notes_pending)}
              sub={`${formatUGX(Number(kpis.notes_amount || 0))} total written`}
            />
            <KpiCard
              icon={TrendingUp}
              label="Capital raised"
              value={formatUGX(Number(kpis.partner_funded || 0))}
              sub={`${formatUGX(Number(kpis.earned || 0))} commissions paid`}
            />
          </>
        )}
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-[220px] flex-1">
          <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Type a name, phone, email or invite code to find an agent"
            className="h-9 pl-8 text-xs"
          />
        </div>
        <div className="inline-flex rounded-lg border bg-muted/40 p-1">
          {STATUS_TABS.map((t) => (
            <button
              key={t.key}
              type="button"
              className={cn(
                'rounded-md px-3 py-1.5 text-xs font-semibold transition-colors',
                status === t.key
                  ? 'bg-primary text-primary-foreground shadow-sm'
                  : 'text-muted-foreground hover:text-foreground',
              )}
              onClick={() => {
                setPage(0);
                setStatus(t.key);
                setChecked({});
              }}
            >
              {t.label}
            </button>
          ))}
        </div>
        <Button
          size="sm"
          variant={activeFilterCount > 0 ? 'default' : 'outline'}
          className="h-9 text-xs"
          onClick={() => setAdvancedOpen((o) => !o)}
        >
          <SlidersHorizontal className="mr-1.5 h-3.5 w-3.5" />
          More filters
          {activeFilterCount > 0 && (
            <Badge variant="secondary" className="ml-1.5 h-4 px-1.5 text-[10px]">
              {activeFilterCount}
            </Badge>
          )}
        </Button>
      </div>

      {/* Advanced filters */}
      {advancedOpen && (
        <Card>
          <CardContent className="grid gap-3 p-4 sm:grid-cols-2 lg:grid-cols-4">
            <div className="space-y-1">
              <p className="text-[10px] font-bold uppercase tracking-wide text-muted-foreground">
                Approved from
              </p>
              <Input
                type="date"
                value={activatedFrom}
                max={activatedTo || undefined}
                onChange={(e) => {
                  setActivatedFrom(e.target.value);
                  resetPaging();
                }}
                className="h-9 text-xs"
              />
            </div>
            <div className="space-y-1">
              <p className="text-[10px] font-bold uppercase tracking-wide text-muted-foreground">
                Approved to
              </p>
              <Input
                type="date"
                value={activatedTo}
                min={activatedFrom || undefined}
                onChange={(e) => {
                  setActivatedTo(e.target.value);
                  resetPaging();
                }}
                className="h-9 text-xs"
              />
            </div>
            <div className="space-y-1">
              <p className="text-[10px] font-bold uppercase tracking-wide text-muted-foreground">
                Contact details
              </p>
              <Select
                value={contact}
                onValueChange={(v) => {
                  setContact(v as ProxyContactFilter);
                  resetPaging();
                }}
              >
                <SelectTrigger className="h-9 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {PROXY_CONTACT_FILTERS.map((f) => (
                    <SelectItem key={f.key} value={f.key} className="text-xs">
                      {f.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex items-end">
              <Button
                variant="ghost"
                size="sm"
                className="h-9 w-full text-xs"
                disabled={activeFilterCount === 0}
                onClick={clearAdvanced}
              >
                Clear these filters
              </Button>
            </div>
            <p className="text-[11px] text-muted-foreground sm:col-span-2 lg:col-span-4">
              The date range uses the day the agent was approved as a proxy agent. Agents still
              waiting for approval have no approval date, so they are hidden while a date is set.
            </p>
          </CardContent>
        </Card>
      )}


      {/* Bulk action bar */}
      {selectedIds.length > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border bg-muted/40 px-3 py-2">
          <p className="text-xs font-semibold">
            {selectedIds.length} selected
            <span className="ml-1 font-normal text-muted-foreground">
              · {selectedTotals.notes} note(s) worth {formatUGX(selectedTotals.amount)}
            </span>
          </p>
          <div className="flex items-center gap-2">
            <Button size="sm" variant="ghost" className="h-8 text-xs" onClick={() => setChecked({})}>
              Clear
            </Button>
            <Button
              size="sm"
              className="h-8 text-xs"
              onClick={() => {
                setApproveResults([]);
                setApproveOpen(true);
              }}
            >
              <BadgeCheck className="mr-1.5 h-3.5 w-3.5" />
              Approve &amp; email selected
            </Button>

            <Button
              size="sm"
              variant="destructive"
              className="h-8 text-xs"
              onClick={() => setConfirmOpen(true)}
            >
              <Trash2 className="mr-1.5 h-3.5 w-3.5" />
              Delete selected
            </Button>
          </div>
        </div>
      )}

      {/* List */}
      <Card>
        <CardContent className="p-0">
          {pageQueries.isLoading ? (
            <div className="space-y-2 p-4">
              {Array.from({ length: 6 }).map((_, i) => (
                <Skeleton key={i} className="h-14 w-full rounded-lg" />
              ))}
            </div>
          ) : rows.length === 0 ? (
            <p className="py-12 text-center text-xs text-muted-foreground">No proxy agents match this filter.</p>
          ) : (
            <>
              {/* Desktop header */}
              <div className="hidden grid-cols-12 items-center gap-2 border-b bg-muted/40 px-4 py-2 text-[10px] font-bold uppercase tracking-wide text-muted-foreground md:grid">
                <div className="col-span-1 flex items-center">
                  <Checkbox
                    checked={allOnPage}
                    onCheckedChange={(v) => {
                      const next = { ...checked };
                      for (const r of rows) {
                        if (v) next[r.agent_user_id] = true;
                        else delete next[r.agent_user_id];
                      }
                      setChecked(next);
                    }}
                    aria-label="Select every agent on this page"
                  />
                </div>
                <span className="col-span-3">Agent</span>
                <span className="col-span-2">Contacts</span>
                <span className="col-span-2 text-right">Promissory</span>
                <span className="col-span-2 text-right">Partners in</span>
                <span className="col-span-2 text-right">Joined / Referred by</span>
              </div>
              <div ref={listRef} className={cn(virtualize && 'max-h-[70vh] overflow-y-auto')}>
              <ul
                className={cn('divide-y', virtualize && 'relative divide-y-0')}
                style={virtualize ? { height: virtualizer.getTotalSize() } : undefined}
              >
                {renderList.map(({ r, v }) => (
                  <li
                    key={r.agent_user_id}
                    data-index={v?.index}
                    ref={v ? virtualizer.measureElement : undefined}
                    className={cn(
                      'grid grid-cols-1 items-center gap-2 border-b px-4 py-3 transition-colors hover:bg-muted/50 md:grid-cols-12',
                      checked[r.agent_user_id] && 'bg-primary/5',
                      v && 'absolute left-0 top-0 w-full',
                    )}
                    style={v ? { transform: `translateY(${v.start}px)` } : undefined}
                  >
                    <div className="hidden md:col-span-1 md:flex md:items-center">
                      <Checkbox
                        checked={!!checked[r.agent_user_id]}
                        onCheckedChange={(v) =>
                          setChecked((prev) => {
                            const next = { ...prev };
                            if (v) next[r.agent_user_id] = true;
                            else delete next[r.agent_user_id];
                            return next;
                          })
                        }
                        aria-label={`Select ${r.name}`}
                      />
                    </div>
                    <button
                      type="button"
                      onClick={() => setQuickView(r)}

                      className="grid w-full grid-cols-1 gap-2 text-left md:col-span-11 md:grid-cols-11 md:items-center"
                    >
                      <div className="flex items-center gap-2 md:col-span-3">
                        <div className="md:hidden">
                          <Checkbox
                            checked={!!checked[r.agent_user_id]}
                            onClick={(e) => e.stopPropagation()}
                            onCheckedChange={(v) =>
                              setChecked((prev) => {
                                const next = { ...prev };
                                if (v) next[r.agent_user_id] = true;
                                else delete next[r.agent_user_id];
                                return next;
                              })
                            }
                            aria-label={`Select ${r.name}`}
                          />
                        </div>
                        <Avatar className="h-9 w-9 border">
                          <AvatarImage src={r.avatar_url ?? undefined} alt={r.name} />
                          <AvatarFallback className="text-[10px] font-bold">{proxyInitials(r.name)}</AvatarFallback>
                        </Avatar>
                        <div className="min-w-0">
                          <p className="truncate text-xs font-semibold">{r.name}</p>
                          <Badge variant="outline" className={cn('mt-0.5 text-[9px]', proxyStatusTone(r.status))}>
                            {r.status}
                          </Badge>
                        </div>
                      </div>
                      <div className="min-w-0 md:col-span-2">
                        <p className="truncate text-[11px] font-medium">{r.phone || '—'}</p>
                        <p className="truncate text-[11px] text-muted-foreground">{r.email || '—'}</p>
                      </div>
                      <div className="md:col-span-2 md:text-right">
                        <p className="text-xs font-bold tabular-nums">{formatUGX(Number(r.notes_amount || 0))}</p>
                        <p className="text-[11px] text-muted-foreground">
                          {r.notes_count} note(s) · {r.notes_pending} pending
                        </p>
                      </div>
                      <div className="md:col-span-2 md:text-right">
                        <p className="text-xs font-bold tabular-nums text-emerald-600">{r.partners_came_in}</p>
                        <p className="text-[11px] text-muted-foreground">of {r.partners_linked} linked</p>
                      </div>
                      <div className="flex items-center justify-between gap-2 md:col-span-2 md:justify-end">
                        <div className="md:text-right">
                          <p className="text-[11px] font-medium">
                            {r.joined_at ? format(new Date(r.joined_at), 'dd MMM yyyy') : '—'}
                          </p>
                          <p className="truncate text-[11px] text-muted-foreground">{r.referrer_name || 'Direct'}</p>
                        </div>
                        <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
                      </div>
                    </button>
                  </li>
                ))}
              </ul>
              </div>
              <div className="flex flex-wrap items-center justify-between gap-2 border-t px-4 py-3">
                <p className="text-[11px] text-muted-foreground">
                  Showing {firstShown.toLocaleString()}–{lastShown.toLocaleString()} of{' '}
                  {total.toLocaleString()} agents
                  {pageQueries.isFetching && (
                    <Loader2 className="ml-1.5 inline h-3 w-3 animate-spin align-[-2px]" />
                  )}
                </p>
                <div className="flex items-center gap-2">
                  <Select
                    value={String(pageSize)}
                    onValueChange={(v) => {
                      setPageSize(Number(v));
                      setPage(0);
                      setChecked({});
                    }}
                  >
                    <SelectTrigger className="h-8 w-[120px] text-xs">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {[30, 60, 100, 200].map((n) => (
                        <SelectItem key={n} value={String(n)} className="text-xs">
                          {n} per page
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-8 text-xs"
                    disabled={page === 0}
                    onClick={() => goToPage(page - 1)}
                  >
                    <ChevronLeft className="mr-1 h-3.5 w-3.5" />
                    Back
                  </Button>
                  <span className="text-[11px] font-semibold tabular-nums">
                    Page {(page + 1).toLocaleString()} of {totalPages.toLocaleString()}
                  </span>
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-8 text-xs"
                    disabled={page + 1 >= totalPages}
                    onClick={() => goToPage(page + 1)}
                  >
                    Next
                    <ChevronRight className="ml-1 h-3.5 w-3.5" />
                  </Button>
                </div>
              </div>

            </>
          )}
        </CardContent>
      </Card>

      <ProxyAgentQuickView
        agent={quickView}
        open={!!quickView}
        onOpenChange={(o) => {
          if (!o) setQuickView(null);
        }}
        onOpenFullProfile={(a) => {
          setQuickView(null);
          setSelected(a);
        }}
        onOpenAudit={() => {
          setQuickView(null);
          setTimeout(() => {
            document
              .getElementById('proxy-onboarding-audit')
              ?.scrollIntoView({ behavior: 'smooth', block: 'start' });
          }, 120);
        }}
        onCopyLink={(a) => void copyViewLink(a)}
      />

      <div id="proxy-onboarding-audit" className="scroll-mt-24">
        <ProxyOnboardingAuditPanel />
      </div>


      {/* Bulk delete confirmation */}
      <Dialog
        open={confirmOpen}
        onOpenChange={(o) => {
          if (!bulkDelete.isPending) setConfirmOpen(o);
        }}
      >
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-base">
              <ShieldOff className="h-4 w-4 text-destructive" />
              Remove {selectedIds.length} proxy agent{selectedIds.length === 1 ? '' : 's'}?
            </DialogTitle>
            <DialogDescription className="text-xs">
              They will no longer be proxy agents. Their promissory notes are deleted and their
              partner links and invites are switched off. This cannot be undone.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3">
            <div className="grid grid-cols-3 gap-2">
              {[
                { label: 'Agents', value: String(selectedIds.length) },
                { label: 'Notes deleted', value: String(selectedTotals.notes) },
                { label: 'Note value', value: formatUGX(selectedTotals.amount) },
              ].map((s) => (
                <div key={s.label} className="rounded-lg border bg-muted/40 p-2">
                  <p className="text-[10px] font-bold uppercase tracking-wide text-muted-foreground">{s.label}</p>
                  <p className="mt-0.5 truncate text-sm font-bold tabular-nums">{s.value}</p>
                </div>
              ))}
            </div>

            <div className="max-h-40 space-y-1 overflow-y-auto rounded-lg border p-2">
              {selectedRows.map((r) => (
                <div key={r.agent_user_id} className="flex items-center gap-2">
                  <Avatar className="h-6 w-6 border">
                    <AvatarImage src={r.avatar_url ?? undefined} alt={r.name} />
                    <AvatarFallback className="text-[9px]">{proxyInitials(r.name)}</AvatarFallback>
                  </Avatar>
                  <p className="truncate text-[11px] font-medium">{r.name}</p>
                  <p className="ml-auto shrink-0 text-[11px] text-muted-foreground">
                    {r.notes_count} note(s)
                  </p>
                </div>
              ))}
            </div>

            <Textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Reason (minimum 10 characters) — stored on the audit trail"
              className="min-h-[70px] text-xs"
            />
          </div>

          <DialogFooter>
            <Button
              size="sm"
              variant="outline"
              className="h-9 text-xs"
              disabled={bulkDelete.isPending}
              onClick={() => setConfirmOpen(false)}
            >
              Cancel
            </Button>
            <Button
              size="sm"
              variant="destructive"
              className="h-9 text-xs"
              disabled={reason.trim().length < 10 || bulkDelete.isPending}
              onClick={() => bulkDelete.mutate()}
            >
              {bulkDelete.isPending ? (
                <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
              ) : (
                <Trash2 className="mr-1.5 h-3.5 w-3.5" />
              )}
              Delete permanently
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Bulk approve + email confirmation */}
      <Dialog
        open={approveOpen}
        onOpenChange={(v) => {
          if (bulkApprove.isPending) return;
          setApproveOpen(v);
          if (!v) setApproveResults([]);
        }}
      >
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-base">
              <BadgeCheck className="h-4 w-4 text-primary" />
              Approve {selectedRows.length} proxy agent(s) and send their email
            </DialogTitle>
            <DialogDescription className="text-xs">
              Each person is approved as a proxy agent and receives the email explaining their new
              role and its benefits. Anyone already approved simply has their record refreshed.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3">
            <div className="max-h-40 space-y-1 overflow-y-auto rounded-lg border p-2">
              {selectedRows.map((r) => (
                <div key={r.agent_user_id} className="flex items-center gap-2">
                  <Avatar className="h-6 w-6 border">
                    <AvatarImage src={r.avatar_url ?? undefined} alt={r.name} />
                    <AvatarFallback className="text-[9px]">{proxyInitials(r.name)}</AvatarFallback>
                  </Avatar>
                  <p className="truncate text-[11px] font-medium">{r.name}</p>
                  <p className="ml-auto shrink-0 text-[11px] text-muted-foreground">
                    {r.email || 'No email on file'}
                  </p>
                </div>
              ))}
            </div>

            <Textarea
              value={approveNote}
              onChange={(e) => setApproveNote(e.target.value)}
              placeholder="Optional note for the audit trail (e.g. why they were approved)"
              className="min-h-[64px] text-xs"
            />

            {bulkApprove.isPending && (
              <p className="text-[11px] text-muted-foreground">
                Working… {approveProgress.done} of {approveProgress.total} done.
              </p>
            )}

            {approveResults.length > 0 && (
              <div className="space-y-1 rounded-lg border border-destructive/30 bg-destructive/5 p-2">
                <p className="text-[11px] font-semibold text-destructive">
                  These could not be completed:
                </p>
                {approveResults.map((f) => (
                  <p key={f} className="truncate text-[11px] text-muted-foreground">{f}</p>
                ))}
              </div>
            )}
          </div>

          <DialogFooter>
            <Button
              size="sm"
              variant="outline"
              className="h-9 text-xs"
              disabled={bulkApprove.isPending}
              onClick={() => setApproveOpen(false)}
            >
              Cancel
            </Button>
            <Button
              size="sm"
              className="h-9 text-xs"
              disabled={bulkApprove.isPending || selectedRows.length === 0}
              onClick={() => bulkApprove.mutate()}
            >
              {bulkApprove.isPending ? (
                <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
              ) : (
                <BadgeCheck className="mr-1.5 h-3.5 w-3.5" />
              )}
              Approve &amp; send email
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

    </div>
  );
}

export default ProxyAgentDirectory;
