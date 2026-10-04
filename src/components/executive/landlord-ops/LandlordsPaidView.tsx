import { useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import {
  Loader2, Banknote, Search, CheckCircle2, Clock, ChevronRight,
  Phone, Users, CalendarClock, MessageCircle, ShieldCheck, ShieldX, Receipt,
} from 'lucide-react';
import { formatUGX } from '@/lib/rentCalculations';
import { format, formatDistanceToNow } from 'date-fns';
import { cn } from '@/lib/utils';
import {
  Drawer, DrawerContent, DrawerHeader, DrawerTitle, DrawerDescription,
} from '@/components/ui/drawer';
import { toast } from 'sonner';

type Period = 'all' | '30d' | '7d' | 'today';
type ConfFilter = 'all' | 'confirmed' | 'pending';
type Tab = 'paid' | 'due_today';

const PAID_STATUSES = ['funded', 'disbursed', 'repaying', 'completed'] as const;
const DUE_STATUSES = ['coo_approved'] as const;

interface DisbursementRow {
  id: string;
  amount: number;
  disbursed_at: string;
  payout_method: string;
  transaction_reference: string | null;
  agent_confirmed: boolean | null;
  landlord_id: string | null;
  landlord: {
    id: string;
    name: string;
    phone: string | null;
    mobile_money_number: string | null;
    receipt_verification_status?: 'true_landlord' | 'false_landlord' | null;
    receipt_verification_at?: string | null;
    receipt_requested_at?: string | null;
    receipt_request_channel?: 'whatsapp' | 'call' | null;
  } | null;
  delivery: any | null;
  source: 'disbursement' | 'rent_request';
  status: string;
}

interface LandlordGroup {
  landlord_id: string;
  name: string;
  phone: string | null;
  mobile_money_number: string | null;
  total: number;
  count: number;
  confirmedCount: number;
  pendingCount: number;
  lastPaidAt: string;
  records: DisbursementRow[];
  receipt_verification_status: 'true_landlord' | 'false_landlord' | null;
  receipt_verification_at: string | null;
  receipt_requested_at: string | null;
  receipt_request_channel: 'whatsapp' | 'call' | null;
}

function periodCutoff(p: Period): Date | null {
  const now = new Date();
  if (p === 'all') return null;
  if (p === 'today') { const d = new Date(now); d.setHours(0, 0, 0, 0); return d; }
  if (p === '7d') { const d = new Date(now); d.setDate(d.getDate() - 7); return d; }
  if (p === '30d') { const d = new Date(now); d.setDate(d.getDate() - 30); return d; }
  return null;
}

export function LandlordsPaidView() {
  const [search, setSearch] = useState('');
  const [period, setPeriod] = useState<Period>('all');
  const [confFilter, setConfFilter] = useState<ConfFilter>('all');
  const [selectedLandlord, setSelectedLandlord] = useState<LandlordGroup | null>(null);
  const [tab, setTab] = useState<Tab>('paid');

  const { data, isLoading } = useQuery({
    queryKey: ['landlord-ops-paid-landlords-v2'],
    queryFn: async () => {
      // 1. Disbursement records (authoritative for landlords actually paid via CFO)
      const { data: disb, error: dErr } = await supabase
        .from('disbursement_records')
        .select('id, amount, disbursed_at, payout_method, transaction_reference, agent_confirmed, landlord_id, rent_request_id')
        .order('disbursed_at', { ascending: false });
      if (dErr) throw dErr;

      // 2. Rent requests (paid + due-today statuses) — paginated to bypass 1000-row limit
      const PAGE = 1000;
      const allRR: any[] = [];
      let offset = 0;
      let more = true;
      const allStatuses = [...PAID_STATUSES, ...DUE_STATUSES];
      while (more) {
        const { data: rrs, error } = await supabase
          .from('rent_requests')
          .select('id, landlord_id, rent_amount, status, funded_at, disbursed_at, updated_at, created_at')
          .in('status', allStatuses as any)
          .order('updated_at', { ascending: false })
          .range(offset, offset + PAGE - 1);
        if (error) throw error;
        if (rrs && rrs.length > 0) {
          allRR.push(...rrs);
          offset += PAGE;
          more = rrs.length === PAGE;
        } else {
          more = false;
        }
      }

      // 3. Lookup landlords for both sources
      const landlordIds = Array.from(new Set([
        ...((disb || []).map(d => d.landlord_id).filter(Boolean) as string[]),
        ...(allRR.map(r => r.landlord_id).filter(Boolean) as string[]),
      ]));
      const landlordMap = new Map<string, DisbursementRow['landlord']>();
      for (let i = 0; i < landlordIds.length; i += 200) {
        const { data: ll } = await supabase
          .from('landlords')
          .select('id, name, phone, mobile_money_number, receipt_verification_status, receipt_verification_at, receipt_requested_at, receipt_request_channel')
          .in('id', landlordIds.slice(i, i + 200));
        for (const l of ll || []) landlordMap.set(l.id, l as any);
      }

      // 4. Delivery confirmations for disbursement rows
      const ids = (disb || []).map(d => d.id);
      const confMap = new Map<string, any>();
      if (ids.length > 0) {
        for (let i = 0; i < ids.length; i += 200) {
          const { data: confs } = await supabase
            .from('agent_delivery_confirmations')
            .select('*')
            .in('disbursement_id', ids.slice(i, i + 200));
          for (const c of confs || []) confMap.set(c.disbursement_id, c);
        }
      }

      // 5. Merge — use disbursement_records when available, otherwise synthesize from rent_requests
      const disbursedRRIds = new Set((disb || []).map(d => d.rent_request_id).filter(Boolean));
      const merged: DisbursementRow[] = [];

      for (const d of disb || []) {
        merged.push({
          ...d,
          landlord: d.landlord_id ? (landlordMap.get(d.landlord_id) || null) : null,
          delivery: confMap.get(d.id) || null,
          source: 'disbursement',
          status: 'paid',
        });
      }

      // For rent_requests not yet in disbursement_records, synthesize a row
      for (const r of allRR) {
        if (disbursedRRIds.has(r.id)) continue; // already covered by disbursement_records
        const isPaid = (PAID_STATUSES as readonly string[]).includes(r.status);
        const paidAt = r.disbursed_at || r.funded_at || r.updated_at || r.created_at;
        merged.push({
          id: `rr-${r.id}`,
          amount: Number(r.rent_amount || 0),
          disbursed_at: paidAt,
          payout_method: 'rent_pipeline',
          transaction_reference: null,
          agent_confirmed: null,
          landlord_id: r.landlord_id,
          landlord: r.landlord_id ? (landlordMap.get(r.landlord_id) || null) : null,
          delivery: null,
          source: 'rent_request',
          status: isPaid ? 'paid' : 'due_today',
        });
      }

      return merged;
    },
    staleTime: 60_000,
  });

  const records = data || [];

  // Tab split: paid vs due_today
  const tabRecords = useMemo(
    () => records.filter(r => (tab === 'paid' ? r.status === 'paid' : r.status === 'due_today')),
    [records, tab]
  );

  // Apply period filter to underlying records
  const cutoff = periodCutoff(period);
  const periodRecords = useMemo(
    () => cutoff ? tabRecords.filter(r => new Date(r.disbursed_at) >= cutoff) : tabRecords,
    [tabRecords, cutoff]
  );

  // Group by landlord
  const groups: LandlordGroup[] = useMemo(() => {
    const map = new Map<string, LandlordGroup>();
    for (const r of periodRecords) {
      if (!r.landlord_id) continue;
      const key = r.landlord_id;
      let g = map.get(key);
      if (!g) {
        g = {
          landlord_id: r.landlord_id,
          name: r.landlord?.name || 'Unknown Landlord',
          phone: r.landlord?.phone || null,
          mobile_money_number: r.landlord?.mobile_money_number || null,
          total: 0,
          count: 0,
          confirmedCount: 0,
          pendingCount: 0,
          lastPaidAt: r.disbursed_at,
          records: [],
          receipt_verification_status: r.landlord?.receipt_verification_status ?? null,
          receipt_verification_at: r.landlord?.receipt_verification_at ?? null,
          receipt_requested_at: r.landlord?.receipt_requested_at ?? null,
          receipt_request_channel: r.landlord?.receipt_request_channel ?? null,
        };
        map.set(key, g);
      }
      g.total += Number(r.amount);
      g.count += 1;
      if (r.source === 'disbursement' && r.agent_confirmed) g.confirmedCount += 1;
      else g.pendingCount += 1;
      if (new Date(r.disbursed_at) > new Date(g.lastPaidAt)) g.lastPaidAt = r.disbursed_at;
      g.records.push(r);
    }
    return Array.from(map.values()).sort((a, b) => new Date(b.lastPaidAt).getTime() - new Date(a.lastPaidAt).getTime());
  }, [periodRecords]);

  // Filter by search + confirmation
  const filteredGroups = useMemo(() => {
    const q = search.trim().toLowerCase();
    return groups.filter(g => {
      if (confFilter === 'confirmed' && g.pendingCount > 0) return false;
      if (confFilter === 'pending' && g.pendingCount === 0) return false;
      if (!q) return true;
      return (
        g.name.toLowerCase().includes(q) ||
        (g.phone || '').toLowerCase().includes(q) ||
        (g.mobile_money_number || '').toLowerCase().includes(q)
      );
    });
  }, [groups, search, confFilter]);

  // KPIs (over period-filtered, pre-search)
  const totalPaid = periodRecords.reduce((s, r) => s + Number(r.amount), 0);
  const landlordsPaidCount = groups.length;
  const last30 = useMemo(() => {
    const cut = periodCutoff('30d')!;
    const paidOnly = records.filter(r => r.status === 'paid');
    const arr = paidOnly.filter(r => new Date(r.disbursed_at) >= cut);
    return { total: arr.reduce((s, r) => s + Number(r.amount), 0), count: arr.length };
  }, [records]);

  const dueTodayCount = useMemo(
    () => new Set(records.filter(r => r.status === 'due_today').map(r => r.landlord_id)).size,
    [records]
  );
  const paidLandlordsTotal = useMemo(
    () => new Set(records.filter(r => r.status === 'paid').map(r => r.landlord_id)).size,
    [records]
  );

  if (isLoading) {
    return <div className="flex justify-center py-12"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>;
  }

  return (
    <div className="space-y-3">
      <h2 className="text-lg font-bold flex items-center gap-2">
        <Banknote className="h-5 w-5 text-emerald-600" />
        Landlords {tab === 'paid' ? 'Paid' : 'Due Today'} ({landlordsPaidCount})
      </h2>

      {/* Tabs: Paid vs Due Today */}
      <div className="flex gap-1 p-1 bg-muted rounded-lg">
        <Button
          size="sm"
          variant={tab === 'paid' ? 'default' : 'ghost'}
          onClick={() => setTab('paid')}
          className="flex-1 text-xs h-9 gap-1.5"
        >
          <CheckCircle2 className="h-3.5 w-3.5" />
          Already Paid
          <Badge variant="secondary" className="ml-1 text-[10px] h-4 px-1.5">{paidLandlordsTotal}</Badge>
        </Button>
        <Button
          size="sm"
          variant={tab === 'due_today' ? 'default' : 'ghost'}
          onClick={() => setTab('due_today')}
          className="flex-1 text-xs h-9 gap-1.5"
        >
          <CalendarClock className="h-3.5 w-3.5" />
          Due Today
          <Badge variant="secondary" className="ml-1 text-[10px] h-4 px-1.5">{dueTodayCount}</Badge>
        </Button>
      </div>

      {/* KPI bar */}
      <div className="grid grid-cols-3 gap-2">
        <Card>
          <CardContent className="p-3">
            <p className="text-[10px] uppercase tracking-wider text-muted-foreground">{tab === 'paid' ? 'Total Paid Out' : 'Total Due Today'}</p>
            <p className="text-base font-bold font-mono mt-1">{formatUGX(totalPaid)}</p>
            <p className="text-[10px] text-muted-foreground mt-0.5">{periodRecords.length} {tab === 'paid' ? 'disbursements' : 'pending payouts'}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-3">
            <p className="text-[10px] uppercase tracking-wider text-muted-foreground">{tab === 'paid' ? 'Landlords Paid' : 'Landlords Awaiting'}</p>
            <p className="text-base font-bold mt-1 flex items-center gap-1"><Users className="h-3.5 w-3.5 text-sky-600" />{landlordsPaidCount}</p>
            <p className="text-[10px] text-muted-foreground mt-0.5">{period === 'all' ? 'all time' : `last ${period}`}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-3">
            <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Paid · Last 30 days</p>
            <p className="text-base font-bold font-mono mt-1">{formatUGX(last30.total)}</p>
            <p className="text-[10px] text-muted-foreground mt-0.5">{last30.count} disbursements</p>
          </CardContent>
        </Card>
      </div>

      {/* Filters */}
      <div className="space-y-2">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search by name or phone..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-9"
          />
        </div>
        <div className="flex gap-1 overflow-x-auto pb-1">
          {(['all', '30d', '7d', 'today'] as Period[]).map(p => (
            <Button
              key={p}
              size="sm"
              variant={period === p ? 'default' : 'outline'}
              onClick={() => setPeriod(p)}
              className="text-xs h-8 shrink-0"
            >
              {p === 'all' ? 'All time' : p === '30d' ? '30 days' : p === '7d' ? '7 days' : 'Today'}
            </Button>
          ))}
          <div className="w-px bg-border mx-1 shrink-0" />
          {(['all', 'confirmed', 'pending'] as ConfFilter[]).map(c => (
            <Button
              key={c}
              size="sm"
              variant={confFilter === c ? 'default' : 'outline'}
              onClick={() => setConfFilter(c)}
              className="text-xs h-8 shrink-0"
            >
              {c === 'all' ? 'All' : c === 'confirmed' ? '✓ Confirmed' : '⏳ Pending'}
            </Button>
          ))}
        </div>
      </div>

      {/* List */}
      {filteredGroups.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center text-sm text-muted-foreground">
            No landlord payments found for these filters.
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-2">
          {filteredGroups.map(g => (
            <Card key={g.landlord_id} className="overflow-hidden">
              <button
                onClick={() => setSelectedLandlord(g)}
                className="w-full text-left p-3 active:bg-muted/50 transition-colors min-h-[64px]"
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="flex-1 min-w-0">
                    <p className="font-bold text-sm truncate">{g.name}</p>
                    <div className="flex items-center gap-2 mt-0.5 text-[11px] text-muted-foreground">
                      {g.phone && (
                        <span className="flex items-center gap-0.5"><Phone className="h-3 w-3" />{g.phone}</span>
                      )}
                      <span>· {tab === 'paid' ? 'Last paid' : 'Due'} {format(new Date(g.lastPaidAt), 'dd MMM yyyy')}</span>
                      <span className="opacity-70">({formatDistanceToNow(new Date(g.lastPaidAt), { addSuffix: true })})</span>
                    </div>
                  </div>
                  <div className="text-right shrink-0">
                    <p className="font-bold font-mono text-sm">{formatUGX(g.total)}</p>
                    <div className="flex items-center justify-end gap-1 mt-0.5">
                      {g.receipt_verification_status === 'true_landlord' && (
                        <Badge className="bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 border-emerald-500/30 text-[10px] px-1.5 py-0 h-4">
                          <ShieldCheck className="h-2.5 w-2.5 mr-0.5" />True
                        </Badge>
                      )}
                      {g.receipt_verification_status === 'false_landlord' && (
                        <Badge className="bg-red-500/15 text-red-700 dark:text-red-400 border-red-500/30 text-[10px] px-1.5 py-0 h-4">
                          <ShieldX className="h-2.5 w-2.5 mr-0.5" />False
                        </Badge>
                      )}
                      {g.confirmedCount > 0 && (
                        <Badge className="bg-success/10 text-success border-success/30 text-[10px] px-1.5 py-0 h-4">
                          <CheckCircle2 className="h-2.5 w-2.5 mr-0.5" />{g.confirmedCount}
                        </Badge>
                      )}
                      {g.pendingCount > 0 && (
                        <Badge variant="outline" className="text-[10px] px-1.5 py-0 h-4">
                          <Clock className="h-2.5 w-2.5 mr-0.5" />{g.pendingCount}
                        </Badge>
                      )}
                    </div>
                  </div>
                </div>
                <div className="flex items-center justify-between mt-2 text-[11px] text-muted-foreground">
                  <span>{g.count} {tab === 'paid' ? 'disbursement' : 'pending payout'}{g.count === 1 ? '' : 's'} · Tap to view tenants</span>
                  <ChevronRight className="h-4 w-4" />
                </div>
              </button>
            </Card>
          ))}
        </div>
      )}

      <LandlordTenantsDrawer
        landlord={selectedLandlord}
        onClose={() => setSelectedLandlord(null)}
      />
    </div>
  );
}

// ============================================================================
// LandlordTenantsDrawer — bottom drawer showing tenants under a landlord
// ============================================================================

interface TenantRow {
  tenant_id: string;
  full_name: string;
  phone: string | null;
  rent_amount: number;
  status: 'paid' | 'due_today';
  latest_at: string;
}

function LandlordTenantsDrawer({
  landlord,
  onClose,
}: {
  landlord: LandlordGroup | null;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const open = !!landlord;
  const landlordId = landlord?.landlord_id;
  const [busy, setBusy] = useState<null | 'whatsapp' | 'call' | 'true' | 'false'>(null);

  const formatWa = (phone: string) => {
    let p = phone.replace(/\s+/g, '').replace(/[^0-9+]/g, '');
    if (p.startsWith('0')) p = '256' + p.slice(1);
    else if (p.startsWith('+')) p = p.slice(1);
    return p;
  };

  const logRequest = async (channel: 'whatsapp' | 'call') => {
    if (!landlordId) return;
    setBusy(channel);
    try {
      const { data: u } = await supabase.auth.getUser();
      await supabase
        .from('landlords')
        .update({
          receipt_requested_at: new Date().toISOString(),
          receipt_requested_by: u.user?.id ?? null,
          receipt_request_channel: channel,
        } as any)
        .eq('id', landlordId);
      qc.invalidateQueries({ queryKey: ['landlord-ops-paid-landlords-v2'] });
    } catch (e: any) {
      toast.error(e?.message ?? 'Could not log receipt request');
    } finally {
      setBusy(null);
    }
  };

  const handleWhatsApp = async () => {
    if (!landlord?.phone) {
      toast.error('No phone number on file for this landlord');
      return;
    }
    const wa = formatWa(landlord.phone);
    const msg = encodeURIComponent(
      `Hello ${landlord.name}, this is Welile. We sent you a rent payment of ${formatUGX(landlord.total)}. Please reply with a photo of the receipt you issued so we can confirm it. Thank you.`
    );
    window.open(`https://wa.me/${wa}?text=${msg}`, '_blank');
    await logRequest('whatsapp');
  };

  const handleCall = async () => {
    if (!landlord?.phone) {
      toast.error('No phone number on file for this landlord');
      return;
    }
    window.open(`tel:${landlord.phone}`, '_self');
    await logRequest('call');
  };

  const markStatus = async (status: 'true_landlord' | 'false_landlord') => {
    if (!landlordId) return;
    setBusy(status === 'true_landlord' ? 'true' : 'false');
    try {
      const { data: u } = await supabase.auth.getUser();
      const { error } = await supabase
        .from('landlords')
        .update({
          receipt_verification_status: status,
          receipt_verification_at: new Date().toISOString(),
          receipt_verification_by: u.user?.id ?? null,
        } as any)
        .eq('id', landlordId);
      if (error) throw error;
      toast.success(status === 'true_landlord' ? 'Marked as True Landlord' : 'Marked as False Landlord');
      qc.invalidateQueries({ queryKey: ['landlord-ops-paid-landlords-v2'] });
    } catch (e: any) {
      toast.error(e?.message ?? 'Could not update landlord');
    } finally {
      setBusy(null);
    }
  };

  const { data: tenants, isLoading } = useQuery({
    queryKey: ['landlord-tenants-drawer', landlordId],
    enabled: open && !!landlordId,
    staleTime: 60_000,
    queryFn: async (): Promise<TenantRow[]> => {
      if (!landlordId) return [];

      // 1. All rent_requests for this landlord (paid + due-today statuses)
      const allStatuses = [...PAID_STATUSES, ...DUE_STATUSES];
      const PAGE = 1000;
      const rows: any[] = [];
      let offset = 0;
      let more = true;
      while (more) {
        const { data: rr, error } = await supabase
          .from('rent_requests')
          .select('id, tenant_id, rent_amount, status, disbursed_at, funded_at, updated_at, created_at')
          .eq('landlord_id', landlordId)
          .in('status', allStatuses as any)
          .order('updated_at', { ascending: false })
          .range(offset, offset + PAGE - 1);
        if (error) throw error;
        if (rr && rr.length > 0) {
          rows.push(...rr);
          offset += PAGE;
          more = rr.length === PAGE;
        } else {
          more = false;
        }
      }

      // 2. Lookup tenant profiles
      const tenantIds = Array.from(new Set(rows.map(r => r.tenant_id).filter(Boolean)));
      const profileMap = new Map<string, { id: string; full_name: string | null; phone: string | null }>();
      for (let i = 0; i < tenantIds.length; i += 200) {
        const { data: profs } = await supabase
          .from('profiles')
          .select('id, full_name, phone')
          .in('id', tenantIds.slice(i, i + 200));
        for (const p of profs || []) profileMap.set(p.id, p as any);
      }

      // 3. Dedupe by tenant — sum amount, latest status wins
      const tenantMap = new Map<string, TenantRow>();
      for (const r of rows) {
        if (!r.tenant_id) continue;
        const isPaid = (PAID_STATUSES as readonly string[]).includes(r.status);
        const at = r.disbursed_at || r.funded_at || r.updated_at || r.created_at;
        const prof = profileMap.get(r.tenant_id);
        const existing = tenantMap.get(r.tenant_id);
        if (!existing) {
          tenantMap.set(r.tenant_id, {
            tenant_id: r.tenant_id,
            full_name: prof?.full_name || 'Unknown Tenant',
            phone: prof?.phone || null,
            rent_amount: Number(r.rent_amount || 0),
            status: isPaid ? 'paid' : 'due_today',
            latest_at: at,
          });
        } else {
          existing.rent_amount += Number(r.rent_amount || 0);
          if (new Date(at) > new Date(existing.latest_at)) {
            existing.latest_at = at;
            existing.status = isPaid ? 'paid' : 'due_today';
          }
        }
      }

      return Array.from(tenantMap.values()).sort(
        (a, b) => new Date(b.latest_at).getTime() - new Date(a.latest_at).getTime()
      );
    },
  });

  const list = tenants || [];
  const paidCount = list.filter(t => t.status === 'paid').length;
  const dueCount = list.filter(t => t.status === 'due_today').length;

  return (
    <Drawer open={open} onOpenChange={(v) => { if (!v) onClose(); }}>
      <DrawerContent className="max-h-[85vh]">
        <DrawerHeader className="text-left border-b">
          <DrawerTitle className="text-base font-bold">{landlord?.name || 'Landlord'}</DrawerTitle>
          <DrawerDescription className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
            {landlord?.phone && (
              <span className="flex items-center gap-1"><Phone className="h-3 w-3" />{landlord.phone}</span>
            )}
            <span>{list.length} tenant{list.length === 1 ? '' : 's'}</span>
            {landlord && <span className="font-mono font-bold text-foreground">{formatUGX(landlord.total)}</span>}
          </DrawerDescription>
          {(paidCount > 0 || dueCount > 0) && (
            <div className="flex gap-2 pt-2">
              {paidCount > 0 && (
                <Badge className="bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 border-emerald-500/30 text-[10px]">
                  <CheckCircle2 className="h-3 w-3 mr-1" />{paidCount} Paid
                </Badge>
              )}
              {dueCount > 0 && (
                <Badge className="bg-amber-500/10 text-amber-700 dark:text-amber-400 border-amber-500/30 text-[10px]">
                  <CalendarClock className="h-3 w-3 mr-1" />{dueCount} Due Today
                </Badge>
              )}
            </div>
          )}
        </DrawerHeader>

        {/* Receipt verification actions */}
        <div className="border-b bg-muted/30 px-4 py-3 space-y-2">
          <div className="flex items-center justify-between gap-2">
            <p className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground flex items-center gap-1">
              <Receipt className="h-3.5 w-3.5" /> Ask for receipt
            </p>
            {landlord?.receipt_verification_status === 'true_landlord' && (
              <Badge className="bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 border-emerald-500/30 text-[10px]">
                <ShieldCheck className="h-3 w-3 mr-1" />True Landlord
              </Badge>
            )}
            {landlord?.receipt_verification_status === 'false_landlord' && (
              <Badge className="bg-red-500/15 text-red-700 dark:text-red-400 border-red-500/30 text-[10px]">
                <ShieldX className="h-3 w-3 mr-1" />False Landlord
              </Badge>
            )}
          </div>

          <div className="grid grid-cols-2 gap-2">
            <Button
              size="sm"
              variant="outline"
              onClick={handleWhatsApp}
              disabled={!landlord?.phone || busy !== null}
              className="h-9 text-xs gap-1.5 border-emerald-500/30 text-emerald-700 dark:text-emerald-400 hover:bg-emerald-500/10"
            >
              <MessageCircle className="h-4 w-4" /> WhatsApp
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={handleCall}
              disabled={!landlord?.phone || busy !== null}
              className="h-9 text-xs gap-1.5 border-sky-500/30 text-sky-700 dark:text-sky-400 hover:bg-sky-500/10"
            >
              <Phone className="h-4 w-4" /> Call
            </Button>
          </div>

          {landlord?.receipt_requested_at && (
            <p className="text-[10px] text-muted-foreground">
              Last requested via {landlord.receipt_request_channel ?? 'contact'}{' '}
              {formatDistanceToNow(new Date(landlord.receipt_requested_at), { addSuffix: true })}
            </p>
          )}

          <div className="pt-1">
            <p className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground mb-1.5">
              Mark landlord
            </p>
            <div className="grid grid-cols-2 gap-2">
              <Button
                size="sm"
                onClick={() => markStatus('true_landlord')}
                disabled={busy !== null}
                className={cn(
                  'h-9 text-xs gap-1.5',
                  landlord?.receipt_verification_status === 'true_landlord'
                    ? 'bg-emerald-600 hover:bg-emerald-700 text-white'
                    : 'bg-emerald-500/10 hover:bg-emerald-500/20 text-emerald-700 dark:text-emerald-400 border border-emerald-500/30'
                )}
              >
                {busy === 'true' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ShieldCheck className="h-4 w-4" />}
                True Landlord
              </Button>
              <Button
                size="sm"
                onClick={() => markStatus('false_landlord')}
                disabled={busy !== null}
                className={cn(
                  'h-9 text-xs gap-1.5',
                  landlord?.receipt_verification_status === 'false_landlord'
                    ? 'bg-red-600 hover:bg-red-700 text-white'
                    : 'bg-red-500/10 hover:bg-red-500/20 text-red-700 dark:text-red-400 border border-red-500/30'
                )}
              >
                {busy === 'false' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ShieldX className="h-4 w-4" />}
                False Landlord
              </Button>
            </div>
            {landlord?.receipt_verification_at && (
              <p className="text-[10px] text-muted-foreground mt-1.5">
                Last verified {formatDistanceToNow(new Date(landlord.receipt_verification_at), { addSuffix: true })}
              </p>
            )}
          </div>
        </div>

        <div className="overflow-y-auto p-4 space-y-2">
          {isLoading ? (
            <div className="flex justify-center py-12">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          ) : list.length === 0 ? (
            <div className="py-12 text-center text-sm text-muted-foreground">
              <Users className="h-8 w-8 mx-auto mb-2 opacity-40" />
              No tenants found for this landlord.
            </div>
          ) : (
            list.map(t => {
              const isPaid = t.status === 'paid';
              return (
                <div
                  key={t.tenant_id}
                  className={cn(
                    'border rounded-lg p-3 space-y-1.5',
                    isPaid
                      ? 'border-emerald-500/30 bg-emerald-500/5'
                      : 'border-amber-500/30 bg-amber-500/5'
                  )}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex-1 min-w-0">
                      <p className="font-bold text-sm truncate">{t.full_name}</p>
                      {t.phone && (
                        <p className="text-[11px] text-muted-foreground flex items-center gap-1 mt-0.5">
                          <Phone className="h-3 w-3" />{t.phone}
                        </p>
                      )}
                    </div>
                    <div className="text-right shrink-0">
                      <p className="font-bold font-mono text-sm">{formatUGX(t.rent_amount)}</p>
                      <Badge
                        className={cn(
                          'mt-0.5 text-[10px] px-1.5 py-0 h-4',
                          isPaid
                            ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 border-emerald-500/30'
                            : 'bg-amber-500/15 text-amber-700 dark:text-amber-400 border-amber-500/30'
                        )}
                      >
                        {isPaid ? (
                          <><CheckCircle2 className="h-2.5 w-2.5 mr-0.5" />Paid</>
                        ) : (
                          <><Clock className="h-2.5 w-2.5 mr-0.5" />Due Today</>
                        )}
                      </Badge>
                    </div>
                  </div>
                  <p className="text-[10px] text-muted-foreground">
                    {isPaid ? 'Paid ' : 'Due '}
                    {format(new Date(t.latest_at), 'dd MMM yyyy')}
                    <span className="opacity-70"> · {formatDistanceToNow(new Date(t.latest_at), { addSuffix: true })}</span>
                  </p>
                </div>
              );
            })
          )}
        </div>
      </DrawerContent>
    </Drawer>
  );
}