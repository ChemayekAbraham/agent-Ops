import { useMemo, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { KPICard } from '../KPICard';
import { ContactActions } from '@/components/ops/ContactActions';
import { TenantCallDrawer } from './TenantCallDrawer';
import { TenantCallReportsPanel } from './TenantCallReportsPanel';
import { formatUGX } from '@/lib/rentCalculations';
import { cn } from '@/lib/utils';
import { format } from 'date-fns';
import {
  CheckCircle2, ChevronRight, PhoneCall, PhoneMissed, RefreshCw, Search, Users, X,
} from 'lucide-react';
import { useTenantCallingList, type CallingListRow } from '@/hooks/useTenantCallingList';
import { TENANT_CALL_STATUS_LABEL, type TenantCallStatus } from '@/hooks/useTenantCallReports';
import { callStatusBadgeClass } from '../LogTenantCallDialog';

type Tab = 'to_call' | 'pending' | 'closed' | 'missed' | 'all';
type SortBy = 'owed' | 'missed_days' | 'name';

const RECALL_OPTIONS = [3, 7, 14] as const;

const ALL = '__all__';

/** Missed-days / payment health buckets, derived from existing figures only. */
const PAYMENT_FILTERS = [
  { key: 'up_to_date', label: 'Up to date (0 missed days)' },
  { key: 'missed_1_3', label: '1-3 missed days' },
  { key: 'missed_4_7', label: '4-7 missed days' },
  { key: 'missed_8_plus', label: '8+ missed days' },
  { key: 'owing', label: 'Has outstanding balance' },
  { key: 'cleared', label: 'Nothing outstanding' },
] as const;
type PaymentFilter = (typeof PAYMENT_FILTERS)[number]['key'];

const statusOf = (r: CallingListRow): TenantCallStatus | null =>
  (r.call?.last_status || (r.call?.last_outcome === 'missed' ? 'missed' : r.call ? 'pending' : null)) as TenantCallStatus | null;

const daysSince = (iso?: string | null) =>
  iso ? Math.floor((Date.now() - new Date(iso).getTime()) / 86400000) : Infinity;


/**
 * Tenant Calling Hub — one complete calling list over the authoritative active
 * plan population. Records calls with three statuses (Pending / Closed /
 * Missed) plus an optional comment; history is append-only and nothing about
 * rent, eligibility or tenant logic is changed here.
 */
export function TenantCallingHub() {
  const { rows, isLoading, refetch } = useTenantCallingList();
  const [tab, setTab] = useState<Tab>('to_call');
  const [search, setSearch] = useState('');
  const [sortBy, setSortBy] = useState<SortBy>('owed');
  const [recallDays, setRecallDays] = useState<(typeof RECALL_OPTIONS)[number]>(3);
  const [open, setOpen] = useState<CallingListRow | null>(null);
  const [district, setDistrict] = useState<string>(ALL);
  const [agentId, setAgentId] = useState<string>(ALL);
  const [callStatus, setCallStatus] = useState<string>(ALL);
  const [payment, setPayment] = useState<string>(ALL);
  const [hasPhone, setHasPhone] = useState<string>(ALL);


  /** A tenant belongs in "To call" when they have never been called, or when
   *  their call state does not place them in any other list (Pending / Closed /
   *  Missed). Re-call window only re-surfaces follow-ups that are already due. */
  const needsCall = (r: CallingListRow) => {
    const s = statusOf(r);
    if (!s) return true;
    if (s === 'closed') return false;
    const follow = r.call?.last_follow_up_at;
    if (follow) return new Date(follow).getTime() <= Date.now();
    return daysSince(r.call?.last_call_at) >= recallDays;
  };

  const buckets = useMemo(() => {
    const b = { to_call: [] as CallingListRow[], pending: [] as CallingListRow[], closed: [] as CallingListRow[], missed: [] as CallingListRow[] };
    rows.forEach(r => {
      const s = statusOf(r);
      if (s === 'pending') b.pending.push(r);
      if (s === 'closed') b.closed.push(r);
      if (s === 'missed') b.missed.push(r);
      if (!s || needsCall(r)) b.to_call.push(r);
    });
    return b;
  }, [rows, recallDays]);


  const calledToday = useMemo(
    () => rows.filter(r => r.call?.last_call_at && daysSince(r.call.last_call_at) === 0).length,
    [rows],
  );

  /** Filter option lists are derived from the rows already loaded — no new queries. */
  const districtOptions = useMemo(
    () => [...new Set(rows.map(r => r.district).filter(Boolean) as string[])].sort((a, b) => a.localeCompare(b)),
    [rows],
  );
  const agentOptions = useMemo(() => {
    const m = new Map<string, string>();
    rows.forEach(r => { if (r.agent_id) m.set(r.agent_id, r.agent_name || '—'); });
    return [...m.entries()].sort((a, b) => a[1].localeCompare(b[1]));
  }, [rows]);

  const matchesPayment = (r: CallingListRow, key: PaymentFilter) => {
    switch (key) {
      case 'up_to_date': return r.missed_days === 0;
      case 'missed_1_3': return r.missed_days >= 1 && r.missed_days <= 3;
      case 'missed_4_7': return r.missed_days >= 4 && r.missed_days <= 7;
      case 'missed_8_plus': return r.missed_days >= 8;
      case 'owing': return r.outstanding_balance > 0;
      case 'cleared': return r.outstanding_balance <= 0;
      default: return true;
    }
  };

  const activeFilters =
    (district !== ALL ? 1 : 0) + (agentId !== ALL ? 1 : 0) + (callStatus !== ALL ? 1 : 0) +
    (payment !== ALL ? 1 : 0) + (hasPhone !== ALL ? 1 : 0);

  const clearFilters = () => {
    setDistrict(ALL); setAgentId(ALL); setCallStatus(ALL); setPayment(ALL); setHasPhone(ALL);
  };

  /** Human-readable chips for whatever is currently selected (display only). */
  const activeChips = useMemo(() => {
    const chips: { key: string; label: string; clear: () => void }[] = [];
    if (district !== ALL) chips.push({ key: 'district', label: `District: ${district}`, clear: () => setDistrict(ALL) });
    if (agentId !== ALL) {
      const name = agentOptions.find(([id]) => id === agentId)?.[1] || 'Agent';
      chips.push({ key: 'agent', label: `Agent: ${name}`, clear: () => setAgentId(ALL) });
    }
    if (payment !== ALL) {
      const label = PAYMENT_FILTERS.find(p => p.key === payment)?.label || payment;
      chips.push({ key: 'payment', label: `Payment: ${label}`, clear: () => setPayment(ALL) });
    }
    if (callStatus !== ALL) {
      const label = callStatus === 'never'
        ? 'Never called'
        : TENANT_CALL_STATUS_LABEL[callStatus as TenantCallStatus] || callStatus;
      chips.push({ key: 'call', label: `Call status: ${label}`, clear: () => setCallStatus(ALL) });
    }
    if (hasPhone !== ALL) {
      chips.push({ key: 'phone', label: hasPhone === 'yes' ? 'Has phone number' : 'No phone number', clear: () => setHasPhone(ALL) });
    }
    return chips;
  }, [district, agentId, payment, callStatus, hasPhone, agentOptions]);


  const visible = useMemo(() => {
    const base = tab === 'all' ? rows : buckets[tab];
    const q = search.trim().toLowerCase();
    const filtered = base.filter(r => {
      if (q &&
        !(r.tenant_name.toLowerCase().includes(q) ||
          r.phone.includes(q) ||
          (r.agent_name || '').toLowerCase().includes(q) ||
          (r.district || '').toLowerCase().includes(q))) return false;
      if (district !== ALL && (r.district || '') !== district) return false;
      if (agentId !== ALL && r.agent_id !== agentId) return false;
      if (callStatus !== ALL) {
        const s = statusOf(r);
        if (callStatus === 'never') { if (s) return false; }
        else if (s !== callStatus) return false;
      }
      if (payment !== ALL && !matchesPayment(r, payment as PaymentFilter)) return false;
      if (hasPhone === 'yes' && !r.phone) return false;
      if (hasPhone === 'no' && r.phone) return false;
      return true;
    });
    const sorted = [...filtered];
    sorted.sort((a, b) =>
      sortBy === 'name'
        ? a.tenant_name.localeCompare(b.tenant_name)
        : sortBy === 'missed_days'
          ? b.missed_days - a.missed_days
          : b.outstanding_balance - a.outstanding_balance);
    return sorted;
  }, [tab, rows, buckets, search, sortBy, district, agentId, callStatus, payment, hasPhone]);


  const tabs: { key: Tab; label: string; count: number }[] = [
    { key: 'to_call', label: 'To call', count: buckets.to_call.length },
    { key: 'pending', label: 'Pending', count: buckets.pending.length },
    { key: 'closed', label: 'Closed', count: buckets.closed.length },
    { key: 'missed', label: 'Missed', count: buckets.missed.length },
    { key: 'all', label: 'All tenants', count: rows.length },
  ];

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-2 sm:gap-3 lg:grid-cols-5">
        <KPICard title="To call" value={isLoading ? '—' : buckets.to_call.length.toLocaleString('en-US')} icon={PhoneCall} color="bg-primary/10 text-primary" subtitle="Still need a call" />
        <KPICard title="Pending follow-up" value={isLoading ? '—' : buckets.pending.length.toLocaleString('en-US')} icon={PhoneCall} color="bg-amber-500/10 text-amber-600" />
        <KPICard title="Closed" value={isLoading ? '—' : buckets.closed.length.toLocaleString('en-US')} icon={CheckCircle2} color="bg-emerald-500/10 text-emerald-600" />
        <KPICard title="Missed" value={isLoading ? '—' : buckets.missed.length.toLocaleString('en-US')} icon={PhoneMissed} color="bg-destructive/10 text-destructive" />
        <KPICard title="Calls logged today" value={isLoading ? '—' : calledToday.toLocaleString('en-US')} icon={Users} color="bg-blue-500/10 text-blue-600" />
      </div>

      {/* Reports are placed first so they are reachable without scrolling through the full calling list. */}
      <TenantCallReportsPanel
        rows={rows}
        filteredRows={visible}
        filterLabel={tabs.find(t => t.key === tab)?.label}
        searchLabel={search.trim() || undefined}
      />

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="flex flex-wrap items-center justify-between gap-2 text-sm">
            <span className="flex items-center gap-2"><PhoneCall className="h-4 w-4 text-primary" /> Calling list</span>
            <Button variant="outline" size="sm" className="h-8 text-xs" onClick={() => refetch()}>
              <RefreshCw className="mr-1.5 h-3 w-3" /> Refresh
            </Button>
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <Tabs value={tab} onValueChange={v => setTab(v as Tab)}>
            <TabsList className="h-auto w-full flex-wrap justify-start gap-1">
              {tabs.map(t => (
                <TabsTrigger key={t.key} value={t.key} className="text-[11px] data-[state=active]:font-bold">
                  {t.label}
                  <span className="ml-1.5 rounded-full bg-muted px-1.5 text-[10px] tabular-nums">{t.count.toLocaleString('en-US')}</span>
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>

          <div className="flex flex-wrap items-center gap-2">
            <div className="relative min-w-[180px] flex-1">
              <Search className="absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={search}
                onChange={e => setSearch(e.target.value)}
                placeholder="Search name, phone, agent or district…"
                className="h-8 pl-9 text-xs"
              />
            </div>
            {(['owed', 'missed_days', 'name'] as SortBy[]).map(s => (
              <Button
                key={s}
                size="sm"
                variant={sortBy === s ? 'default' : 'outline'}
                className="h-8 text-[11px]"
                onClick={() => setSortBy(s)}
              >
                {s === 'owed' ? 'Most owed' : s === 'missed_days' ? 'Most missed days' : 'Name'}
              </Button>
            ))}
            {tab === 'to_call' && (
              <div className="flex items-center gap-1">
                <span className="text-[11px] text-muted-foreground">Call again after</span>
                {RECALL_OPTIONS.map(d => (
                  <Button
                    key={d}
                    size="sm"
                    variant={recallDays === d ? 'default' : 'outline'}
                    className="h-8 px-2 text-[11px]"
                    onClick={() => setRecallDays(d)}
                  >
                    {d}d
                  </Button>
                ))}
              </div>
            )}
          </div>

          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
            <div className="space-y-1">
              <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">District</span>
              <Select value={district} onValueChange={setDistrict}>
                <SelectTrigger className="h-8 text-xs"><SelectValue placeholder="All districts" /></SelectTrigger>
                <SelectContent className="max-h-72">
                  <SelectItem value={ALL} className="text-xs">All districts</SelectItem>
                  {districtOptions.map(d => <SelectItem key={d} value={d} className="text-xs">{d}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1">
              <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Agent</span>
              <Select value={agentId} onValueChange={setAgentId}>
                <SelectTrigger className="h-8 text-xs"><SelectValue placeholder="All agents" /></SelectTrigger>
                <SelectContent className="max-h-72">
                  <SelectItem value={ALL} className="text-xs">All agents</SelectItem>
                  {agentOptions.map(([id, name]) => <SelectItem key={id} value={id} className="text-xs">{name}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1">
              <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Missed days / payment</span>
              <Select value={payment} onValueChange={setPayment}>
                <SelectTrigger className="h-8 text-xs"><SelectValue placeholder="Any payment status" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value={ALL} className="text-xs">Any payment status</SelectItem>
                  {PAYMENT_FILTERS.map(p => <SelectItem key={p.key} value={p.key} className="text-xs">{p.label}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1">
              <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Call status</span>
              <Select value={callStatus} onValueChange={setCallStatus}>
                <SelectTrigger className="h-8 text-xs"><SelectValue placeholder="Any call status" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value={ALL} className="text-xs">Any call status</SelectItem>
                  <SelectItem value="never" className="text-xs">Never called</SelectItem>
                  <SelectItem value="pending" className="text-xs">{TENANT_CALL_STATUS_LABEL.pending}</SelectItem>
                  <SelectItem value="closed" className="text-xs">{TENANT_CALL_STATUS_LABEL.closed}</SelectItem>
                  <SelectItem value="missed" className="text-xs">{TENANT_CALL_STATUS_LABEL.missed}</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1">
              <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Phone</span>
              <Select value={hasPhone} onValueChange={setHasPhone}>
                <SelectTrigger className="h-8 text-xs"><SelectValue placeholder="Phone: any" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value={ALL} className="text-xs">Phone: any</SelectItem>
                  <SelectItem value="yes" className="text-xs">Has phone number</SelectItem>
                  <SelectItem value="no" className="text-xs">No phone number</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          {(activeFilters > 0 || search.trim()) && (
            <div className="flex flex-wrap items-center gap-1.5">
              {search.trim() && (
                <Badge variant="outline" className="gap-1 text-[10px]">
                  Search: {search.trim()}
                  <button type="button" aria-label="Clear search" onClick={() => setSearch('')}>
                    <X className="h-3 w-3" />
                  </button>
                </Badge>
              )}
              {activeChips.map(chip => (
                <Badge key={chip.key} variant="secondary" className="gap-1 text-[10px]">
                  {chip.label}
                  <button type="button" aria-label={`Clear ${chip.label}`} onClick={chip.clear}>
                    <X className="h-3 w-3" />
                  </button>
                </Badge>
              ))}
              <span className="text-[11px] text-muted-foreground">
                {visible.length.toLocaleString('en-US')} tenants match
              </span>
              {(activeFilters > 0 || search.trim()) && (
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 px-2 text-[11px]"
                  onClick={() => { clearFilters(); setSearch(''); }}
                >
                  <X className="mr-1 h-3 w-3" /> Clear all
                </Button>
              )}
            </div>
          )}




          {isLoading ? (
            <div className="space-y-2">
              {Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-16 w-full" />)}
            </div>
          ) : visible.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">
              {tab === 'to_call' ? 'Everyone in this window has been called.' : 'Nothing here yet.'}
            </p>
          ) : (
            <ul className="space-y-1.5">
              {visible.slice(0, 300).map(r => {
                const s = statusOf(r);
                return (
                  <li key={r.tenant_id}>
                    <button
                      onClick={() => setOpen(r)}
                      className="flex w-full items-center gap-2.5 rounded-lg border border-border bg-card p-2.5 text-left transition-colors hover:border-primary/40 hover:bg-muted/40 sm:gap-3 sm:p-3"
                    >
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <p className="text-xs font-semibold break-words">{r.tenant_name}</p>
                          {s && (
                            <Badge variant="outline" className={cn('px-1.5 text-[9px]', callStatusBadgeClass(s))}>
                              {TENANT_CALL_STATUS_LABEL[s]}
                            </Badge>
                          )}
                          {r.missed_days > 0 && (
                            <Badge variant="outline" className="border-destructive/30 bg-destructive/10 px-1.5 text-[9px] text-destructive">
                              {r.missed_days}d missed
                            </Badge>
                          )}
                        </div>
                        <p className="mt-0.5 text-[11px] leading-snug text-muted-foreground break-words">
                          {r.phone || 'No phone'} · Agent {r.agent_name} · {r.district || r.city || '—'}
                        </p>
                        <p className="mt-0.5 text-[11px] leading-snug text-muted-foreground">
                          Owed <span className="font-semibold text-foreground tabular-nums">{formatUGX(r.outstanding_balance)}</span>
                          {' · '}Daily <span className="tabular-nums">{formatUGX(r.daily_repayment)}</span>
                          {r.call?.last_call_at && ` · Last call ${format(new Date(r.call.last_call_at), 'dd MMM')}`}
                        </p>
                      </div>
                      <ContactActions phone={r.phone} size="xs" />
                      <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
          {visible.length > 300 && (
            <p className="text-center text-[11px] text-muted-foreground">
              Showing the first 300 of {visible.length.toLocaleString('en-US')} — narrow the search to see more.
            </p>
          )}
        </CardContent>
      </Card>


      <TenantCallDrawer row={open} open={!!open} onClose={() => setOpen(null)} />
    </div>
  );
}
