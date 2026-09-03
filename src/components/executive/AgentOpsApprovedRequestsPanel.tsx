import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { Label } from '@/components/ui/label';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { RentPipelineTracker } from './RentPipelineTracker';
import { CheckCircle2, Search, Calendar, Clock, User, Home, Briefcase, ArrowUpDown, Building, Banknote, ShieldCheck } from 'lucide-react';
import { format, subDays, startOfMonth } from 'date-fns';

/**
 * Requests that have cleared Agent Ops review and have entered the Tenant Ops pipeline.
 */
const APPROVED_STATUSES = [
  'agent_ops_approved',
  'agent_verified',
  'tenant_ops_approved',
  'landlord_ops_approved',
  'partner_ops_approved',
  'coo_approved',
  'approved',
  'funded',
  'disbursed',
  'repaying',
  'fully_repaid',
  'completed',
];

const STAGE_LABEL: Record<string, string> = {
  pending: 'Field Verified',
  service_center_review: 'Service Center Check',
  agent_ops_approved: 'Tenant Ops review',
  agent_verified: 'Tenant Ops review',
  tenant_ops_approved: 'Landlord Ops review',
  landlord_ops_approved: 'Partner Ops review',
  partner_ops_approved: 'COO review',
  coo_approved: 'CFO funding',
  approved: 'Approved',
  funded: 'Funded',
  disbursed: 'Disbursed',
  repaying: 'Repaying',
  fully_repaid: 'Fully Repaid',
  completed: 'Completed',
};

const SETTLED = new Set(['funded', 'disbursed', 'repaying', 'fully_repaid', 'completed']);

interface ApprovedRow {
  id: string;
  status: string;
  tenancy_status: string | null;
  registration_type: string | null;
  rent_amount: number;
  duration_days: number;
  daily_repayment: number;
  total_repayment: number;
  amount_repaid: number;
  outstanding: number;
  repayment_progress_pct: number;
  access_fee: number;
  request_fee: number;
  approved_at: string | null;
  created_at: string;
  agent_ops_reviewed_at: string | null;
  tenant_ops_reviewed_at: string | null;
  landlord_ops_reviewed_at: string | null;
  partner_ops_reviewed_at: string | null;
  coo_reviewed_at: string | null;
  funded_at: string | null;
  disbursed_at: string | null;
  agent_ops_comment: string | null;
  tenant_ops_comment: string | null;
  landlord_ops_comment: string | null;
  partner_ops_comment: string | null;
  approval_comment: string | null;
  payout_transaction_reference: string | null;
  tenant_id: string;
  tenant_name: string;
  tenant_phone: string;
  tenant_location: string;
  landlord_id: string;
  landlord_name: string;
  landlord_phone: string;
  landlord_location: string;
  agent_id: string;
  agent_name: string;
  agent_phone: string;
  house_listing_id: string | null;
  house_title: string;
  house_address: string;
  haystack: string;
}

const formatWhatsApp = (phone: string): string => {
  if (!phone) return '';
  let clean = phone.replace(/\D/g, '');
  if (clean.startsWith('0')) clean = '256' + clean.slice(1);
  if (!clean.startsWith('256')) clean = '256' + clean;
  return clean;
};

type DatePreset = 'today' | 'yesterday' | '7d' | '30d' | 'month' | 'all' | 'custom';

const PRESETS: { key: DatePreset; label: string }[] = [
  { key: 'today', label: 'Today' },
  { key: 'yesterday', label: 'Yesterday' },
  { key: '7d', label: 'Last 7 days' },
  { key: '30d', label: 'Last 30 days' },
  { key: 'month', label: 'This month' },
  { key: 'all', label: 'All time' },
];

export function AgentOpsApprovedRequestsPanel() {
  const [search, setSearch] = useState('');
  const [preset, setPreset] = useState<DatePreset>('today');
  const [from, setFrom] = useState(() => format(new Date(), 'yyyy-MM-dd'));
  const [to, setTo] = useState(() => format(new Date(), 'yyyy-MM-dd'));
  const [sortOrder, setSortOrder] = useState<'desc' | 'asc'>('desc');
  const [selectedTrace, setSelectedTrace] = useState<ApprovedRow | null>(null);

  const handleSelectPreset = (p: DatePreset) => {
    setPreset(p);
    const now = new Date();
    if (p === 'today') {
      const d = format(now, 'yyyy-MM-dd');
      setFrom(d);
      setTo(d);
    } else if (p === 'yesterday') {
      const d = format(subDays(now, 1), 'yyyy-MM-dd');
      setFrom(d);
      setTo(d);
    } else if (p === '7d') {
      setFrom(format(subDays(now, 6), 'yyyy-MM-dd'));
      setTo(format(now, 'yyyy-MM-dd'));
    } else if (p === '30d') {
      setFrom(format(subDays(now, 29), 'yyyy-MM-dd'));
      setTo(format(now, 'yyyy-MM-dd'));
    } else if (p === 'month') {
      setFrom(format(startOfMonth(now), 'yyyy-MM-dd'));
      setTo(format(now, 'yyyy-MM-dd'));
    } else if (p === 'all') {
      setFrom('');
      setTo('');
    }
  };

  const { data: rows = [], isLoading } = useQuery({
    queryKey: ['agent-ops-approved-requests', from, to],
    staleTime: 0,
    refetchOnMount: 'always',
    queryFn: async (): Promise<ApprovedRow[]> => {
      let query = supabase
        .from('rent_requests')
        .select(
          'id, status, tenancy_status, registration_type, rent_amount, daily_repayment, duration_days, total_repayment, amount_repaid, access_fee, request_fee, created_at, approved_at, funded_at, disbursed_at, resubmitted_at, returned_at, agent_verified, agent_verified_at, agent_ops_reviewed_at, tenant_ops_reviewed_at, landlord_ops_reviewed_at, partner_ops_reviewed_at, coo_reviewed_at, agent_ops_comment, tenant_ops_comment, landlord_ops_comment, partner_ops_comment, approval_comment, payout_transaction_reference, tenant_id, agent_id, assigned_agent_id, landlord_id, house_listing_id, request_city',
        )
        .or('status.neq.pending,agent_verified.eq.true,agent_verified_at.not.is.null,agent_ops_reviewed_at.not.is.null')
        .neq('status', 'rejected')
        .neq('status', 'cancelled')
        .order('created_at', { ascending: false });

      if (from) {
        query = query.gte('created_at', `${from}T00:00:00.000Z`);
      }
      if (to) {
        query = query.lte('created_at', `${to}T23:59:59.999Z`);
      }
      if (!from && !to) {
        query = query.limit(300);
      } else {
        query = query.limit(1000);
      }

      const { data, error } = await query;
      if (error) throw error;
      if (!data || data.length === 0) return [];

      const profileIds = Array.from(
        new Set(
          (data || []).flatMap((r: any) => [r.tenant_id, r.agent_id, r.assigned_agent_id]).filter(Boolean),
        ),
      );
      const landlordIds = Array.from(
        new Set((data || []).map((r: any) => r.landlord_id).filter(Boolean)),
      );
      const houseIds = Array.from(
        new Set((data || []).map((r: any) => r.house_listing_id).filter(Boolean)),
      );

      const BATCH = 50;
      const fetchProfiles = async () => {
        if (!profileIds.length) return [];
        const res: any[] = [];
        for (let i = 0; i < profileIds.length; i += BATCH) {
          const { data: chunk } = await supabase
            .from('profiles')
            .select('id, full_name, phone, district, village')
            .in('id', profileIds.slice(i, i + BATCH));
          if (chunk) res.push(...chunk);
        }
        return res;
      };
      const fetchLandlords = async () => {
        if (!landlordIds.length) return [];
        const res: any[] = [];
        for (let i = 0; i < landlordIds.length; i += BATCH) {
          const { data: chunk } = await supabase
            .from('landlords')
            .select('id, name, phone, property_address, district')
            .in('id', landlordIds.slice(i, i + BATCH));
          if (chunk) res.push(...chunk);
        }
        return res;
      };
      const fetchHouses = async () => {
        if (!houseIds.length) return [];
        const res: any[] = [];
        for (let i = 0; i < houseIds.length; i += BATCH) {
          const { data: chunk } = await supabase
            .from('house_listings')
            .select('id, title, address, district, village, region')
            .in('id', houseIds.slice(i, i + BATCH));
          if (chunk) res.push(...chunk);
        }
        return res;
      };

      const [profilesList, landlordsList, housesList] = await Promise.all([
        fetchProfiles(),
        fetchLandlords(),
        fetchHouses(),
      ]);

      const profileMap = new Map(profilesList.map((p: any) => [p.id, p]));
      const landlordMap = new Map(landlordsList.map((l: any) => [l.id, l]));
      const houseMap = new Map(housesList.map((h: any) => [h.id, h]));

      return (data || []).map((r: any) => {
        const tenant = profileMap.get(r.tenant_id) as any;
        const landlord = landlordMap.get(r.landlord_id) as any;
        const agent = (profileMap.get(r.assigned_agent_id) || profileMap.get(r.agent_id)) as any;
        const house = r.house_listing_id ? houseMap.get(r.house_listing_id) as any : null;

        const tenant_name = tenant?.full_name || 'Unknown tenant';
        const landlord_name = landlord?.name || '—';
        const agent_name = agent?.full_name || '—';
        const house_title = house?.title || 'Residential Unit';
        const house_address = [house?.address, house?.village, house?.district].filter(Boolean).join(', ') || r.request_city || '—';
        const effectiveApprovalDate = r.agent_ops_reviewed_at || r.approved_at || r.agent_verified_at || null;

        const totalRepay = Number(r.total_repayment) || 0;
        const repaid = Number(r.amount_repaid) || 0;
        const outstanding = Math.max(0, totalRepay - repaid);
        const progressPct = totalRepay > 0 ? Math.min(100, Math.round((repaid / totalRepay) * 100)) : 0;

        return {
          id: r.id,
          status: r.status,
          tenancy_status: r.tenancy_status || null,
          registration_type: r.registration_type || null,
          rent_amount: Number(r.rent_amount) || 0,
          duration_days: Number(r.duration_days) || 30,
          daily_repayment: Number(r.daily_repayment) || 0,
          total_repayment: totalRepay,
          amount_repaid: repaid,
          outstanding,
          repayment_progress_pct: progressPct,
          access_fee: Number(r.access_fee) || 0,
          request_fee: Number(r.request_fee) || 0,
          approved_at: effectiveApprovalDate,
          created_at: r.created_at,
          agent_ops_reviewed_at: r.agent_ops_reviewed_at || null,
          tenant_ops_reviewed_at: r.tenant_ops_reviewed_at || null,
          landlord_ops_reviewed_at: r.landlord_ops_reviewed_at || null,
          partner_ops_reviewed_at: r.partner_ops_reviewed_at || null,
          coo_reviewed_at: r.coo_reviewed_at || null,
          funded_at: r.funded_at || null,
          disbursed_at: r.disbursed_at || null,
          agent_ops_comment: r.agent_ops_comment || null,
          tenant_ops_comment: r.tenant_ops_comment || null,
          landlord_ops_comment: r.landlord_ops_comment || null,
          partner_ops_comment: r.partner_ops_comment || null,
          approval_comment: r.approval_comment || null,
          payout_transaction_reference: r.payout_transaction_reference || null,
          tenant_id: r.tenant_id,
          tenant_name,
          tenant_phone: tenant?.phone || '',
          tenant_location: [tenant?.village, tenant?.district].filter(Boolean).join(', ') || '—',
          landlord_id: r.landlord_id,
          landlord_name,
          landlord_phone: landlord?.phone || '',
          landlord_location: [landlord?.property_address, landlord?.district].filter(Boolean).join(', ') || '—',
          agent_id: r.agent_id,
          agent_name,
          agent_phone: agent?.phone || '',
          house_listing_id: r.house_listing_id || null,
          house_title,
          house_address,
          haystack: `${tenant_name} ${landlord_name} ${agent_name} ${house_title} ${r.id}`.toLowerCase(),
        };
      });
    },
  });

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const fromTs = from ? new Date(`${from}T00:00:00`).getTime() : null;
    const toTs = to ? new Date(`${to}T23:59:59`).getTime() : null;
    return rows
      .filter((r) => {
        if (q && !r.haystack.includes(q)) return false;
        const ref = new Date(r.approved_at || r.created_at).getTime();
        if (fromTs != null && ref < fromTs) return false;
        if (toTs != null && ref > toTs) return false;
        return true;
      })
      .sort((a, b) => {
        const tsA = new Date(a.created_at).getTime();
        const tsB = new Date(b.created_at).getTime();
        return sortOrder === 'desc' ? tsB - tsA : tsA - tsB;
      });
  }, [rows, search, from, to, sortOrder]);

  const total = filtered.reduce((sum, r) => sum + r.rent_amount, 0);
  const totalRepaid = filtered.reduce((sum, r) => sum + r.amount_repaid, 0);
  const hasFilters = !!(search || from || to);

  return (
    <div className="space-y-3">
      {/* Search Bar & Order */}
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <div className="relative flex-1">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
          <Input
            placeholder="Search tenant, landlord, agent, house, or request ID..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-8 h-8 text-xs"
          />
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => setSortOrder(prev => prev === 'desc' ? 'asc' : 'desc')}
          className="h-8 text-xs gap-1 shrink-0"
        >
          <ArrowUpDown className="h-3 w-3" />
          <span>{sortOrder === 'desc' ? 'Newest' : 'Oldest'}</span>
        </Button>
      </div>

      {/* Date-only Filter Bar with Quick Presets */}
      <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-2 p-2.5 rounded-lg border bg-card/60">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground mr-1 flex items-center gap-1">
            <Calendar className="h-3 w-3" /> Date:
          </span>
          {PRESETS.map((p) => (
            <Button
              key={p.key}
              type="button"
              variant={preset === p.key ? 'secondary' : 'ghost'}
              size="sm"
              onClick={() => handleSelectPreset(p.key)}
              className={`h-7 px-2.5 text-xs font-medium ${preset === p.key ? 'font-bold shadow-sm' : ''}`}
            >
              {p.label}
            </Button>
          ))}
        </div>

        <div className="flex items-center gap-2 text-xs flex-wrap">
          <div className="flex items-center gap-1.5">
            <Label htmlFor="approved-from" className="text-[11px] text-muted-foreground">From</Label>
            <Input
              id="approved-from"
              type="date"
              value={from}
              onChange={(e) => {
                setFrom(e.target.value);
                setPreset('custom');
              }}
              className="h-7 w-32 text-xs"
              aria-label="Approved from date"
            />
          </div>
          <span className="text-xs text-muted-foreground">to</span>
          <div className="flex items-center gap-1.5">
            <Label htmlFor="approved-to" className="text-[11px] text-muted-foreground">To</Label>
            <Input
              id="approved-to"
              type="date"
              value={to}
              onChange={(e) => {
                setTo(e.target.value);
                setPreset('custom');
              }}
              className="h-7 w-32 text-xs"
              aria-label="Approved to date"
            />
          </div>
          {hasFilters && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-7 px-2 text-xs text-muted-foreground hover:text-foreground"
              onClick={() => {
                setSearch('');
                handleSelectPreset('all');
              }}
            >
              Reset
            </Button>
          )}
        </div>
      </div>

      <div className="flex items-center justify-between text-xs text-muted-foreground">
        <span>{filtered.length} approved/downstream request{filtered.length !== 1 ? 's' : ''}</span>
        <div className="flex items-center gap-3">
          {totalRepaid > 0 && (
            <span className="text-emerald-600 font-medium">Repaid: UGX {totalRepaid.toLocaleString()}</span>
          )}
          <span className="font-medium text-foreground">Total: UGX {total.toLocaleString()}</span>
        </div>
      </div>

      {isLoading && (
        <div className="text-center py-8 text-muted-foreground text-sm">Loading approved requests...</div>
      )}
      {!isLoading && filtered.length === 0 && (
        <div className="text-center py-8 text-muted-foreground text-sm">
          {rows.length === 0 ? 'No requests approved from Agent Ops yet' : 'No requests match these filters'}
        </div>
      )}

      <div className="space-y-2">
        {filtered.map((r) => (
          <Card
            key={r.id}
            className="border cursor-pointer hover:bg-muted/30 transition-colors"
            onClick={() => setSelectedTrace(r)}
          >
            <CardContent className="p-3 space-y-2">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 space-y-1">
                  <div className="flex items-center gap-2">
                    <User className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                    <span className="font-medium text-sm truncate">{r.tenant_name}</span>
                    {r.tenancy_status && (
                      <Badge variant="outline" size="sm" className="text-[10px] uppercase">
                        {r.tenancy_status}
                      </Badge>
                    )}
                  </div>
                  <div className="flex items-center gap-2">
                    <Home className="h-3 w-3 text-muted-foreground shrink-0" />
                    <span className="text-xs text-muted-foreground truncate">{r.landlord_name}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <Briefcase className="h-3 w-3 text-muted-foreground shrink-0" />
                    <span className="text-xs text-muted-foreground truncate">{r.agent_name}</span>
                  </div>
                  {r.house_title && r.house_title !== 'Residential Unit' && (
                    <div className="flex items-center gap-2">
                      <Building className="h-3 w-3 text-muted-foreground shrink-0" />
                      <span className="text-[11px] text-muted-foreground truncate">{r.house_title} · {r.house_address}</span>
                    </div>
                  )}
                </div>
                <div className="text-right shrink-0 space-y-1">
                  <p className="font-bold text-sm">UGX {r.rent_amount.toLocaleString()}</p>
                  <Badge variant={SETTLED.has(r.status) ? 'primary' : 'outline'} size="sm">
                    {STAGE_LABEL[r.status] ?? r.status.replace(/_/g, ' ')}
                  </Badge>
                  <p className="text-[10px] text-primary underline">Trace Journey →</p>
                </div>
              </div>

              {/* Repayment Progress Bar (for funded/settled/repaying requests) */}
              {SETTLED.has(r.status) && r.total_repayment > 0 && (
                <div className="space-y-1 pt-1 border-t">
                  <div className="flex items-center justify-between text-[10px] text-muted-foreground">
                    <span>Repaid: UGX {r.amount_repaid.toLocaleString()} / {r.total_repayment.toLocaleString()}</span>
                    <span className="font-semibold text-foreground">{r.repayment_progress_pct}%</span>
                  </div>
                  <Progress value={r.repayment_progress_pct} className="h-1.5" />
                </div>
              )}

              <div className="flex items-center gap-3 pt-1 border-t text-[11px] text-muted-foreground font-mono flex-wrap">
                <span className="inline-flex items-center gap-1 font-sans">
                  <CheckCircle2 className="h-3 w-3 text-emerald-600 shrink-0" />
                  Approved{' '}
                  <span className="font-mono">{r.approved_at ? format(new Date(r.approved_at), 'dd MMM yyyy') : 'date not recorded'}</span>
                </span>
                <span className="inline-flex items-center gap-1 font-sans">
                  <Calendar className="h-3 w-3 shrink-0" />
                  Submitted <span className="font-mono">{format(new Date(r.created_at), 'dd MMM yyyy')}</span>
                </span>
                <span className="inline-flex items-center gap-1 font-sans text-muted-foreground">
                  <Clock className="h-3 w-3 shrink-0" />
                  Expiry Date <span className="font-mono">{format(new Date(new Date(r.created_at).getTime() + 30 * 24 * 60 * 60 * 1000), 'dd MMM yyyy')}</span>
                </span>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* End-to-End Request LifeCycle & Audit Tracer Sheet */}
      <Sheet open={!!selectedTrace} onOpenChange={(open) => { if (!open) setSelectedTrace(null); }}>
        <SheetContent side="bottom" className="h-[85vh] rounded-t-2xl max-w-2xl mx-auto">
          <SheetHeader className="pb-3 border-b">
            <SheetTitle className="flex items-center justify-between text-base">
              <span>Rent Request Lifecycle Trace</span>
              {selectedTrace && (
                <Badge variant="primary" size="sm">
                  {STAGE_LABEL[selectedTrace.status] ?? selectedTrace.status.replace(/_/g, ' ')}
                </Badge>
              )}
            </SheetTitle>
          </SheetHeader>

          {selectedTrace && (
            <div className="space-y-4 mt-3 overflow-y-auto max-h-[calc(85vh-90px)] pb-8 text-xs">
              {/* Progress Stepper */}
              <Card className="p-3 bg-muted/40">
                <p className="font-semibold mb-2 text-foreground">Pipeline Stage Progress</p>
                <RentPipelineTracker
                  currentStatus={selectedTrace.status}
                  registrationType={selectedTrace.registration_type || undefined}
                  rentAmount={selectedTrace.rent_amount}
                />
              </Card>

              {/* Parties Involved */}
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                <Card className="p-2.5 space-y-1 border">
                  <p className="text-muted-foreground text-[10px] uppercase font-semibold">Tenant</p>
                  <p className="font-semibold text-sm truncate">{selectedTrace.tenant_name}</p>
                  <p className="text-muted-foreground truncate">{selectedTrace.tenant_phone || 'No phone'}</p>
                  <p className="text-muted-foreground truncate">{selectedTrace.tenant_location}</p>
                  {selectedTrace.tenant_phone && (
                    <a
                      href={`https://wa.me/${formatWhatsApp(selectedTrace.tenant_phone)}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-block mt-1 text-[10px] text-emerald-600 underline font-medium"
                    >
                      WhatsApp Tenant ↗
                    </a>
                  )}
                </Card>

                <Card className="p-2.5 space-y-1 border">
                  <p className="text-muted-foreground text-[10px] uppercase font-semibold">Landlord</p>
                  <p className="font-semibold text-sm truncate">{selectedTrace.landlord_name}</p>
                  <p className="text-muted-foreground truncate">{selectedTrace.landlord_phone || 'No phone'}</p>
                  <p className="text-muted-foreground truncate">{selectedTrace.landlord_location}</p>
                  {selectedTrace.landlord_phone && (
                    <a
                      href={`https://wa.me/${formatWhatsApp(selectedTrace.landlord_phone)}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-block mt-1 text-[10px] text-emerald-600 underline font-medium"
                    >
                      WhatsApp Landlord ↗
                    </a>
                  )}
                </Card>

                <Card className="p-2.5 space-y-1 border">
                  <p className="text-muted-foreground text-[10px] uppercase font-semibold">Originating Agent</p>
                  <p className="font-semibold text-sm truncate">{selectedTrace.agent_name}</p>
                  <p className="text-muted-foreground truncate">{selectedTrace.agent_phone || 'No phone'}</p>
                  {selectedTrace.agent_phone && (
                    <a
                      href={`https://wa.me/${formatWhatsApp(selectedTrace.agent_phone)}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-block mt-1 text-[10px] text-emerald-600 underline font-medium"
                    >
                      WhatsApp Agent ↗
                    </a>
                  )}
                </Card>
              </div>

              {/* Property Details if linked */}
              {selectedTrace.house_title && (
                <Card className="p-2.5 border space-y-1">
                  <p className="text-muted-foreground text-[10px] uppercase font-semibold">Property & House Details</p>
                  <p className="font-medium text-xs">{selectedTrace.house_title}</p>
                  <p className="text-muted-foreground text-[11px]">{selectedTrace.house_address}</p>
                </Card>
              )}

              {/* Financial Terms & Repayment Tracking */}
              <Card className="p-3 border space-y-2">
                <p className="font-semibold">Financial Breakdown & Repayment</p>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                  <div>
                    <p className="text-muted-foreground text-[10px]">Rent Plan Amount</p>
                    <p className="font-bold text-sm">UGX {selectedTrace.rent_amount.toLocaleString()}</p>
                  </div>
                  <div>
                    <p className="text-muted-foreground text-[10px]">Duration</p>
                    <p className="font-bold text-sm">{selectedTrace.duration_days} days</p>
                  </div>
                  <div>
                    <p className="text-muted-foreground text-[10px]">Daily Repayment</p>
                    <p className="font-bold text-sm">UGX {selectedTrace.daily_repayment.toLocaleString()}</p>
                  </div>
                  <div>
                    <p className="text-muted-foreground text-[10px]">Total Repayment</p>
                    <p className="font-bold text-sm">UGX {selectedTrace.total_repayment.toLocaleString()}</p>
                  </div>
                </div>

                {selectedTrace.total_repayment > 0 && (
                  <div className="pt-2 border-t space-y-1.5">
                    <div className="flex items-center justify-between text-xs">
                      <span className="text-muted-foreground">Amount Repaid:</span>
                      <span className="font-bold text-emerald-600">UGX {selectedTrace.amount_repaid.toLocaleString()}</span>
                    </div>
                    <div className="flex items-center justify-between text-xs">
                      <span className="text-muted-foreground">Outstanding Balance:</span>
                      <span className="font-bold text-foreground">UGX {selectedTrace.outstanding.toLocaleString()}</span>
                    </div>
                    <Progress value={selectedTrace.repayment_progress_pct} className="h-2 mt-1" />
                  </div>
                )}
              </Card>

              {/* Audit Timeline */}
              <Card className="p-3 border space-y-3">
                <p className="font-semibold">Step-by-Step System Audit Trail</p>

                <div className="space-y-2.5 border-l-2 border-primary/30 pl-3 ml-1">
                  {/* Step 1: Submission */}
                  <div>
                    <div className="flex items-center gap-1.5 font-medium text-foreground">
                      <span className="h-2 w-2 rounded-full bg-emerald-500 shrink-0" />
                      <span>1. Request Submitted by Agent ({selectedTrace.agent_name})</span>
                    </div>
                    <p className="text-muted-foreground text-[11px] ml-3.5">
                      {format(new Date(selectedTrace.created_at), 'dd MMM yyyy, HH:mm')}
                    </p>
                  </div>

                  {/* Step 2: Agent Ops */}
                  {selectedTrace.agent_ops_reviewed_at && (
                    <div>
                      <div className="flex items-center gap-1.5 font-medium text-foreground">
                        <span className="h-2 w-2 rounded-full bg-emerald-500 shrink-0" />
                        <span>2. Cleared Agent Operations Desk</span>
                      </div>
                      <p className="text-muted-foreground text-[11px] ml-3.5">
                        {format(new Date(selectedTrace.agent_ops_reviewed_at), 'dd MMM yyyy, HH:mm')}
                      </p>
                      {selectedTrace.agent_ops_comment && (
                        <p className="italic text-muted-foreground ml-3.5 mt-0.5">Note: "{selectedTrace.agent_ops_comment}"</p>
                      )}
                    </div>
                  )}

                  {/* Step 3: Tenant Ops */}
                  {selectedTrace.tenant_ops_reviewed_at && (
                    <div>
                      <div className="flex items-center gap-1.5 font-medium text-foreground">
                        <span className="h-2 w-2 rounded-full bg-emerald-500 shrink-0" />
                        <span>3. Cleared Tenant Operations Verification</span>
                      </div>
                      <p className="text-muted-foreground text-[11px] ml-3.5">
                        {format(new Date(selectedTrace.tenant_ops_reviewed_at), 'dd MMM yyyy, HH:mm')}
                      </p>
                      {selectedTrace.tenant_ops_comment && (
                        <p className="italic text-muted-foreground ml-3.5 mt-0.5">Note: "{selectedTrace.tenant_ops_comment}"</p>
                      )}
                    </div>
                  )}

                  {/* Step 4: Landlord Ops */}
                  {selectedTrace.landlord_ops_reviewed_at && (
                    <div>
                      <div className="flex items-center gap-1.5 font-medium text-foreground">
                        <span className="h-2 w-2 rounded-full bg-emerald-500 shrink-0" />
                        <span>4. Landlord Phone Verification Confirmed</span>
                      </div>
                      <p className="text-muted-foreground text-[11px] ml-3.5">
                        {format(new Date(selectedTrace.landlord_ops_reviewed_at), 'dd MMM yyyy, HH:mm')}
                      </p>
                      {selectedTrace.landlord_ops_comment && (
                        <p className="italic text-muted-foreground ml-3.5 mt-0.5">Note: "{selectedTrace.landlord_ops_comment}"</p>
                      )}
                    </div>
                  )}

                  {/* Step 5: Partner Ops */}
                  {selectedTrace.partner_ops_reviewed_at && (
                    <div>
                      <div className="flex items-center gap-1.5 font-medium text-foreground">
                        <span className="h-2 w-2 rounded-full bg-emerald-500 shrink-0" />
                        <span>5. Partner Ops Proxy Agent Assigned</span>
                      </div>
                      <p className="text-muted-foreground text-[11px] ml-3.5">
                        {format(new Date(selectedTrace.partner_ops_reviewed_at), 'dd MMM yyyy, HH:mm')}
                      </p>
                      {selectedTrace.partner_ops_comment && (
                        <p className="italic text-muted-foreground ml-3.5 mt-0.5">Note: "{selectedTrace.partner_ops_comment}"</p>
                      )}
                    </div>
                  )}

                  {/* Step 6: COO */}
                  {selectedTrace.coo_reviewed_at && (
                    <div>
                      <div className="flex items-center gap-1.5 font-medium text-foreground">
                        <span className="h-2 w-2 rounded-full bg-emerald-500 shrink-0" />
                        <span>6. COO Executive Approval</span>
                      </div>
                      <p className="text-muted-foreground text-[11px] ml-3.5">
                        {format(new Date(selectedTrace.coo_reviewed_at), 'dd MMM yyyy, HH:mm')}
                      </p>
                      {selectedTrace.approval_comment && (
                        <p className="italic text-muted-foreground ml-3.5 mt-0.5">Note: "{selectedTrace.approval_comment}"</p>
                      )}
                    </div>
                  )}

                  {/* Step 7: CFO Funding */}
                  {selectedTrace.funded_at && (
                    <div>
                      <div className="flex items-center gap-1.5 font-medium text-emerald-600">
                        <span className="h-2 w-2 rounded-full bg-emerald-600 shrink-0" />
                        <span>7. CFO Funded & Disbursed</span>
                      </div>
                      <p className="text-muted-foreground text-[11px] ml-3.5">
                        {format(new Date(selectedTrace.funded_at), 'dd MMM yyyy, HH:mm')}
                      </p>
                      {selectedTrace.payout_transaction_reference && (
                        <p className="font-mono text-[10px] text-muted-foreground ml-3.5 mt-0.5">
                          Payout Ref: {selectedTrace.payout_transaction_reference}
                        </p>
                      )}
                    </div>
                  )}
                </div>
              </Card>
            </div>
          )}
        </SheetContent>
      </Sheet>
    </div>
  );
}
