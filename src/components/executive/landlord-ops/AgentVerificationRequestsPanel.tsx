import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useToast } from '@/hooks/use-toast';
import { useAuth } from '@/hooks/useAuth';
import {
  ShieldQuestion, CheckCircle2, XCircle, Loader2, UserCircle,
  MapPin, Home, Banknote, Smartphone, Calendar, Search, Building2,
  FilterX, Clock, RotateCcw, AlertTriangle, FileDown, BarChart3, Ban,
  ChevronLeft, ChevronRight, ArrowLeftRight,
} from 'lucide-react';
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, Legend,
} from 'recharts';
import { format as fmtDay, subDays } from 'date-fns';
import { notifyVerificationResolved } from '@/lib/landlordVerificationNotify';
import { CallButton } from './CallButton';
import { setLandlordVerification } from '@/lib/landlord-ops/verification';
import { generateLandlordVerificationQueuePdf } from '@/lib/landlordVerificationQueuePdf';
import {
  LandlordVerificationGeoBrowser,
  matchesGeoPath,
  type GeoPath,
  type GeoQueueRow,
  type LandlordGeo,
} from './LandlordVerificationGeoBrowser';

/** Location columns read for the geographic navigator (district kept for the existing badge). */
const GEO_COLS =
  'id, country, region, district, county, sub_county, town_council, village, cell, latitude, longitude';

/** Rows shown per page in the queue / history lists. */
const PAGE_SIZE = 20;

interface VerificationRequest {
  id: string;
  landlord_id: string;
  landlord_name: string | null;
  landlord_phone: string | null;
  requested_by: string;
  agent_name: string | null;
  agent_phone: string | null;
  note: string | null;
  created_at: string;
}

interface Props {
  onResolved?: () => void;
}

interface LandlordDetail {
  id: string;
  name: string | null;
  phone: string | null;
  property_address: string | null;
  region: string | null;
  district: string | null;
  county: string | null;
  sub_county: string | null;
  town_council: string | null;
  village: string | null;
  latitude: number | null;
  longitude: number | null;
  number_of_houses: number | null;
  house_category: string | null;
  monthly_rent: number | null;
  bank_name: string | null;
  account_number: string | null;
  mobile_money_number: string | null;
  mobile_money_name: string | null;
  has_smartphone: boolean | null;
  caretaker_name: string | null;
  caretaker_phone: string | null;
  created_at: string | null;
}

interface HouseRow {
  id: string;
  title: string | null;
  region: string | null;
  district: string | null;
  monthly_rent: number | null;
  status: string | null;
}

interface DetailBundle {
  landlord: LandlordDetail | null;
  houses: HouseRow[];
}

/**
 * Read-only decision history for a landlord that is back in the pending queue.
 * A rejected landlord is reopened automatically when the agent resubmits
 * (`sync_landlord_state_on_verification_request`), and the resubmit clears the
 * request's own reject_comment — so without this the card looks like a brand
 * new request and operators believe their rejection never stuck.
 */
interface PriorRejection {
  count: number;
  reason: string | null;
  at: string;
}

/**
 * Decided (historical) request row — read-only. Kept in a separate shape from
 * the live pending queue so none of the existing pending logic changes.
 */
interface DecidedRequest extends VerificationRequest {
  status: string;
  reject_comment: string | null;
  resolved_at: string | null;
}

type QueueTab = 'pending' | 'resubmitted' | 'verified' | 'rejected' | 'cancelled' | 'all';

const TAB_LABEL: Record<QueueTab, string> = {
  pending: 'Pending',
  resubmitted: 'Resubmitted',
  verified: 'Verified',
  rejected: 'Rejected',
  cancelled: 'Cancelled',
  all: 'All requests',
};

const fmtUgx = (n?: number | null) =>
  n == null ? '—' : `UGX ${Number(n).toLocaleString()}`;

/**
 * Agent-initiated landlord verification requests.
 * Shown very prominently on the Landlord Ops dashboard so operators can
 * verify (or reject with a comment) a landlord an agent flagged while trying
 * to post a rent request.
 */
export function AgentVerificationRequestsPanel({ onResolved }: Props) {
  const { user } = useAuth();
  const { toast } = useToast();
  const [requests, setRequests] = useState<VerificationRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [rejectingId, setRejectingId] = useState<string | null>(null);
  const [rejectComment, setRejectComment] = useState('');
  const [verifyComment, setVerifyComment] = useState('');
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [details, setDetails] = useState<Record<string, DetailBundle>>({});
  // Landlord district per pending request — loaded up-front so the queue can be
  // filtered by district without expanding every card.
  const [districtByLandlord, setDistrictByLandlord] = useState<Record<string, string>>({});
  // Landlord -> latest recorded rejection (from the append-only event log).
  const [priorByLandlord, setPriorByLandlord] = useState<Record<string, PriorRejection>>({});
  const [onlyResubmitted, setOnlyResubmitted] = useState(false);
  // ── Tabs / analytics layer (read-only, additive) ──────────────────────────
  const [tab, setTab] = useState<QueueTab>('pending');
  const [decided, setDecided] = useState<DecidedRequest[]>([]);
  const [decidedLoading, setDecidedLoading] = useState(false);
  const [districtByLandlordAll, setDistrictByLandlordAll] = useState<Record<string, string>>({});
  const [showChart, setShowChart] = useState(true);
  const [exporting, setExporting] = useState(false);
  const [fromDate, setFromDate] = useState<string>(() => fmtDay(subDays(new Date(), 29), 'yyyy-MM-dd'));
  const [toDate, setToDate] = useState<string>(() => fmtDay(new Date(), 'yyyy-MM-dd'));
  // ── Geographic navigator (read-only grouping of the rows already loaded) ──
  const [geoByLandlord, setGeoByLandlord] = useState<Record<string, LandlordGeo>>({});
  const [geoPath, setGeoPath] = useState<GeoPath>({});
  // Floating Pending ⇄ History quick toggle: shown once the header tabs have
  // scrolled out of view so reviewers can switch lists without scrolling back.
  const headerRef = useRef<HTMLDivElement | null>(null);
  const [tabsOutOfView, setTabsOutOfView] = useState(false);
  useEffect(() => {
    const el = headerRef.current;
    if (!el) return;
    const io = new IntersectionObserver(
      ([entry]) => setTabsOutOfView(!entry.isIntersecting),
      { threshold: 0 },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);
  const isHistoryView = tab === 'verified' || tab === 'rejected' || tab === 'cancelled' || tab === 'all';
  const togglePendingHistory = useCallback(() => {
    setTab((current) => (
      current === 'verified' || current === 'rejected' || current === 'cancelled' || current === 'all'
        ? 'pending'
        : 'all'
    ));
  }, []);

  /** Merge landlord location rows into the shared geo map (never overwrites with blanks). */
  const mergeGeo = useCallback((locs: unknown) => {
    const rows = (locs ?? []) as (LandlordGeo & { id: string })[];
    if (!rows.length) return;
    setGeoByLandlord(prev => {
      const next = { ...prev };
      for (const l of rows) next[l.id] = l;
      return next;
    });
  }, []);

  const load = useCallback(async () => {
    const { data, error } = await supabase
      .from('landlord_verification_requests')
      .select('id, landlord_id, landlord_name, landlord_phone, requested_by, agent_name, agent_phone, note, created_at')
      .eq('status', 'pending')
      .order('created_at', { ascending: true });
    if (!error) {
      const rows = (data ?? []) as VerificationRequest[];
      setRequests(rows);
      const ids = Array.from(new Set(rows.map(r => r.landlord_id).filter(Boolean)));
      if (ids.length > 0) {
        const { data: locs } = await supabase
          .from('landlords')
          .select(GEO_COLS)
          .in('id', ids);
        mergeGeo(locs);
        setDistrictByLandlord(
          Object.fromEntries(
            ((locs ?? []) as { id: string; district: string | null }[]).map(l => [l.id, l.district || '']),
          ),
        );
        // Append-only transition log — never mutated by the resubmit path, so it
        // is the only reliable source for "this was already rejected once".
        const { data: events } = await supabase
          .from('landlord_verification_events')
          .select('landlord_id, reason, created_at')
          .in('landlord_id', ids)
          .eq('to_status', 'rejected')
          .order('created_at', { ascending: false });
        const prior: Record<string, PriorRejection> = {};
        for (const e of (events ?? []) as { landlord_id: string; reason: string | null; created_at: string }[]) {
          const existing = prior[e.landlord_id];
          if (existing) {
            existing.count += 1; // rows arrive newest-first, so keep the first reason
          } else {
            prior[e.landlord_id] = { count: 1, reason: e.reason, at: e.created_at };
          }
        }
        setPriorByLandlord(prior);
      } else {
        setDistrictByLandlord({});
        setPriorByLandlord({});
      }
    }
    setLoading(false);
  }, [mergeGeo]);

  /**
   * Decided requests (verified / rejected / cancelled) in the selected window.
   * Read-only — used only for the extra tabs, charts and the PDF export.
   */
  const loadDecided = useCallback(async () => {
    setDecidedLoading(true);
    try {
      const startIso = new Date(`${fromDate}T00:00:00`).toISOString();
      const endIso = new Date(`${toDate}T23:59:59.999`).toISOString();
      const { data } = await supabase
        .from('landlord_verification_requests')
        .select('id, landlord_id, landlord_name, landlord_phone, requested_by, agent_name, agent_phone, note, created_at, status, reject_comment, resolved_at')
        .in('status', ['verified', 'rejected', 'cancelled'])
        .gte('created_at', startIso)
        .lte('created_at', endIso)
        .order('created_at', { ascending: false })
        .limit(1000);
      const rows = (data ?? []) as DecidedRequest[];
      setDecided(rows);
      const ids = Array.from(new Set(rows.map((r) => r.landlord_id).filter(Boolean)));
      if (ids.length > 0) {
        const { data: locs } = await supabase.from('landlords').select(GEO_COLS).in('id', ids);
        mergeGeo(locs);
        setDistrictByLandlordAll(
          Object.fromEntries(
            ((locs ?? []) as { id: string; district: string | null }[]).map((l) => [l.id, l.district || '']),
          ),
        );
      } else {
        setDistrictByLandlordAll({});
      }
    } finally {
      setDecidedLoading(false);
    }
  }, [fromDate, toDate, mergeGeo]);

  useEffect(() => { void loadDecided(); }, [loadDecided]);

  useEffect(() => {
    load();
    const channel = supabase
      .channel('landlord-verification-requests')
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'landlord_verification_requests' },
        () => load(),
      )
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
  }, [load]);

  // Load full landlord context (location, houses, finance, agent) so Ops can
  // verify authenticity BEFORE approving — never a blind one-click approve.
  const openDetails = useCallback(async (req: VerificationRequest) => {
    if (expandedId === req.id) { setExpandedId(null); return; }
    setExpandedId(req.id);
    setRejectingId(null);
    setVerifyComment('');
    if (details[req.landlord_id]) return; // cached
    setDetailLoading(true);
    try {
      const [{ data: landlord }, { data: houses }] = await Promise.all([
        supabase
          .from('landlords')
          .select('id, name, phone, property_address, region, district, county, sub_county, town_council, village, latitude, longitude, number_of_houses, house_category, monthly_rent, bank_name, account_number, mobile_money_number, mobile_money_name, has_smartphone, caretaker_name, caretaker_phone, created_at')
          .eq('id', req.landlord_id)
          .maybeSingle(),
        supabase
          .from('house_listings')
          .select('id, title, region, district, monthly_rent, status')
          .eq('landlord_id', req.landlord_id)
          .order('created_at', { ascending: false })
          .limit(20),
      ]);
      setDetails(prev => ({
        ...prev,
        [req.landlord_id]: {
          landlord: (landlord ?? null) as LandlordDetail | null,
          houses: (houses ?? []) as HouseRow[],
        },
      }));
    } catch {
      setDetails(prev => ({ ...prev, [req.landlord_id]: { landlord: null, houses: [] } }));
    } finally {
      setDetailLoading(false);
    }
  }, [expandedId, details]);

  const handleVerify = async (req: VerificationRequest) => {
    if (!user) return;
    // Optional operator comment. When supplied it becomes the recorded decision
    // reason (the same field every report/export already reads); when omitted the
    // existing default reason is kept exactly as before.
    const comment = verifyComment.trim();
    if (comment.length > 0 && comment.length < 10) {
      toast({ title: 'Comment too short', description: 'Either leave the comment empty or give at least 10 characters.', variant: 'destructive' });
      return;
    }
    setBusyId(req.id);
    try {
      // Single authorized write path: state + request + audit + event + notify.
      await setLandlordVerification({
        landlordId: req.landlord_id,
        status: 'verified',
        reason: comment
          ? `${comment} — verified from agent verification request (${req.agent_name || 'agent'})`
          : `Verified from agent verification request (${req.agent_name || 'agent'})`,
        source: 'agent_request',
      });
      toast({ title: '✅ Landlord verified', description: `${req.landlord_name || 'Landlord'} is now verified.` });
      setRequests(prev => prev.filter(r => r.id !== req.id));
      setVerifyComment('');
      void notifyVerificationResolved({
        status: 'verified',
        agentId: req.requested_by,
        landlordId: req.landlord_id,
        landlordName: req.landlord_name,
        landlordPhone: req.landlord_phone,
        comment: comment || undefined,
        requestId: req.id,
      });
      onResolved?.();
    } catch (err: any) {
      toast({ title: 'Verify failed', description: err?.message || 'Could not verify landlord', variant: 'destructive' });
    } finally {
      setBusyId(null);
    }
  };

  const handleReject = async (req: VerificationRequest) => {
    if (!user) return;
    const comment = rejectComment.trim();
    if (comment.length < 10) {
      toast({ title: 'Add a comment', description: 'Please give at least 10 characters explaining the rejection.', variant: 'destructive' });
      return;
    }
    setBusyId(req.id);
    try {
      // Rejection now persists on the landlord too, so the record leaves the
      // pending bucket and shows under Rejected.
      await setLandlordVerification({
        landlordId: req.landlord_id,
        status: 'rejected',
        reason: comment,
        source: 'agent_request',
      });
      toast({ title: 'Request rejected', description: `${req.landlord_name || 'Landlord'} was rejected with a comment.` });
      setRequests(prev => prev.filter(r => r.id !== req.id));
      setRejectingId(null);
      setRejectComment('');
      void notifyVerificationResolved({
        status: 'rejected',
        agentId: req.requested_by,
        landlordId: req.landlord_id,
        landlordName: req.landlord_name,
        landlordPhone: req.landlord_phone,
        comment,
        requestId: req.id,
      });
      onResolved?.();
    } catch (err: any) {
      toast({ title: 'Reject failed', description: err?.message || 'Could not reject request', variant: 'destructive' });
    } finally {
      setBusyId(null);
    }
  };

  const [search, setSearch] = useState('');
  const [page, setPage] = useState(0);

  // Any filter change restarts pagination at the first page.
  useEffect(() => {
    setPage(0);
  }, [search, tab, geoPath, onlyResubmitted, fromDate, toDate]);

  /** Searchable location text for a landlord (approved-dataset columns). */
  const geoText = useCallback(
    (landlordId: string) => {
      const g = geoByLandlord[landlordId];
      if (!g) return '';
      return [g.country, g.region, g.district, g.county, g.sub_county, g.town_council, g.village, g.cell]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
    },
    [geoByLandlord],
  );

  /** Rows feeding the geographic navigator (pending + decided in range). */
  const geoRows = useMemo<GeoQueueRow[]>(() => {
    const toRow = (r: VerificationRequest, status: string): GeoQueueRow => ({
      landlord_id: r.landlord_id,
      landlord_name: r.landlord_name,
      landlord_phone: r.landlord_phone,
      agent_name: r.agent_name,
      agent_phone: r.agent_phone,
      status,
      geo: geoByLandlord[r.landlord_id] ?? null,
    });
    const pending = requests.map((r) => toRow(r, 'pending'));
    const done = decided
      .filter((r) => tab === 'all' || tab === 'pending' || tab === 'resubmitted' ? true : r.status === tab)
      .map((r) => toRow(r, r.status));
    return tab === 'pending' || tab === 'resubmitted' ? pending : [...pending, ...done];
  }, [requests, decided, geoByLandlord, tab]);

  /** Does this request sit inside the chosen location path? */
  const inGeo = useCallback(
    (landlordId: string) =>
      matchesGeoPath(
        { landlord_id: landlordId, landlord_name: null, landlord_phone: null, agent_name: null, agent_phone: null, status: '', geo: geoByLandlord[landlordId] ?? null },
        geoPath,
      ),
    [geoByLandlord, geoPath],
  );

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const base = ((onlyResubmitted || tab === 'resubmitted')
      ? requests.filter((r) => !!priorByLandlord[r.landlord_id])
      : requests
    ).filter((r) => inGeo(r.landlord_id));
    if (!q) return base;
    return base.filter((r) =>
      (r.landlord_name || '').toLowerCase().includes(q) ||
      (r.landlord_phone || '').toLowerCase().includes(q) ||
      (r.agent_name || '').toLowerCase().includes(q) ||
      (r.agent_phone || '').toLowerCase().includes(q) ||
      (districtByLandlord[r.landlord_id] || '').toLowerCase().includes(q) ||
      geoText(r.landlord_id).includes(q)
    );
  }, [requests, search, districtByLandlord, onlyResubmitted, priorByLandlord, tab, inGeo, geoText]);

  const resubmittedCount = useMemo(
    () => requests.filter((r) => !!priorByLandlord[r.landlord_id]).length,
    [requests, priorByLandlord],
  );

  /** Decided rows matching the current search box (read-only tabs). */
  const decidedFiltered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const byStatus = (tab === 'all' || tab === 'pending' || tab === 'resubmitted'
      ? decided
      : decided.filter((r) => r.status === tab)
    ).filter((r) => inGeo(r.landlord_id));
    if (!q) return byStatus;
    return byStatus.filter((r) =>
      (r.landlord_name || '').toLowerCase().includes(q) ||
      (r.landlord_phone || '').toLowerCase().includes(q) ||
      (r.agent_name || '').toLowerCase().includes(q) ||
      (r.agent_phone || '').toLowerCase().includes(q) ||
      (districtByLandlordAll[r.landlord_id] || '').toLowerCase().includes(q) ||
      geoText(r.landlord_id).includes(q)
    );
  }, [decided, search, tab, districtByLandlordAll, inGeo, geoText]);

  // ---- Pagination: one page index shared by the visible list, PAGE_SIZE rows per page ----
  const isPendingList = tab === 'pending' || tab === 'resubmitted' || tab === 'all';
  const activeRows = isPendingList ? filtered : decidedFiltered;
  const pageCount = Math.max(1, Math.ceil(activeRows.length / PAGE_SIZE));
  const safePage = Math.min(page, pageCount - 1);
  const pagedFiltered = useMemo(
    () => filtered.slice(safePage * PAGE_SIZE, safePage * PAGE_SIZE + PAGE_SIZE),
    [filtered, safePage],
  );
  const pagedDecided = useMemo(
    () => decidedFiltered.slice(safePage * PAGE_SIZE, safePage * PAGE_SIZE + PAGE_SIZE),
    [decidedFiltered, safePage],
  );

  const tabCounts = useMemo(() => ({
    pending: requests.length,
    resubmitted: resubmittedCount,
    verified: decided.filter((r) => r.status === 'verified').length,
    rejected: decided.filter((r) => r.status === 'rejected').length,
    cancelled: decided.filter((r) => r.status === 'cancelled').length,
    all: requests.length + decided.length,
  }), [requests.length, resubmittedCount, decided]);

  /** Daily activity for the chart: created vs verified vs rejected. */
  const chartData = useMemo(() => {
    const map = new Map<string, { day: string; created: number; verified: number; rejected: number }>();
    const bump = (iso: string, key: 'created' | 'verified' | 'rejected') => {
      const day = fmtDay(new Date(iso), 'yyyy-MM-dd');
      const row = map.get(day) || { day, created: 0, verified: 0, rejected: 0 };
      row[key] += 1;
      map.set(day, row);
    };
    for (const r of decided) {
      bump(r.created_at, 'created');
      if (r.resolved_at && (r.status === 'verified' || r.status === 'rejected')) {
        bump(r.resolved_at, r.status as 'verified' | 'rejected');
      }
    }
    for (const r of requests) {
      const day = fmtDay(new Date(r.created_at), 'yyyy-MM-dd');
      if (day >= fromDate && day <= toDate) bump(r.created_at, 'created');
    }
    return Array.from(map.values()).sort((a, b) => a.day.localeCompare(b.day));
  }, [decided, requests, fromDate, toDate]);

  const handleExportPdf = useCallback(async () => {
    setExporting(true);
    try {
      const pendingRows = (tab === 'verified' || tab === 'rejected' || tab === 'cancelled')
        ? []
        : filtered.map((r) => ({
            landlordName: r.landlord_name,
            landlordPhone: r.landlord_phone,
            district: districtByLandlord[r.landlord_id] || null,
            agentName: r.agent_name,
            agentPhone: r.agent_phone,
            status: 'pending',
            resubmitted: !!priorByLandlord[r.landlord_id],
            rejectionCount: priorByLandlord[r.landlord_id]?.count ?? 0,
            createdAt: r.created_at,
            resolvedAt: null,
            comment: priorByLandlord[r.landlord_id]?.reason || r.note || null,
          }));
      const decidedRows = tab === 'pending' || tab === 'resubmitted'
        ? []
        : decidedFiltered.map((r) => ({
            landlordName: r.landlord_name,
            landlordPhone: r.landlord_phone,
            district: districtByLandlordAll[r.landlord_id] || null,
            agentName: r.agent_name,
            agentPhone: r.agent_phone,
            status: r.status,
            resubmitted: false,
            rejectionCount: 0,
            createdAt: r.created_at,
            resolvedAt: r.resolved_at,
            comment: r.reject_comment || r.note || null,
          }));
      const doc = generateLandlordVerificationQueuePdf({
        tabLabel: TAB_LABEL[tab],
        from: fromDate,
        to: toDate,
        search: search.trim() || null,
        rows: [...pendingRows, ...decidedRows],
        trend: chartData,
      });
      doc.save(`landlord-verification-${tab}-${fmtDay(new Date(), 'yyyyMMdd-HHmm')}.pdf`);
    } catch (err: any) {
      toast({ title: 'Export failed', description: err?.message || 'Could not build the PDF', variant: 'destructive' });
    } finally {
      setExporting(false);
    }
  }, [tab, filtered, decidedFiltered, districtByLandlord, districtByLandlordAll, priorByLandlord, fromDate, toDate, search, chartData, toast]);

  if (loading || (requests.length === 0 && decided.length === 0)) return null;

  return (
    <div className="overflow-hidden rounded-lg border border-amber-500/40 bg-amber-50/40 shadow-sm dark:bg-amber-950/20 sm:rounded-2xl">
      {/* Header — always visible, never collapsible */}
      <div ref={headerRef} className="border-b border-amber-500/20 bg-amber-500/10 p-3 sm:p-4">
        <div className="flex flex-col sm:flex-row sm:items-center gap-3">
          <div className="flex items-center gap-2.5 flex-1 min-w-0">
            <div className="p-2 rounded-xl bg-amber-500/15">
              <ShieldQuestion className="h-5 w-5 text-amber-600 shrink-0" />
            </div>
            <div className="min-w-0">
              <p className="font-bold text-sm leading-tight flex items-center gap-2">
                Landlord verification queue
                <Badge className="bg-amber-600 text-white hover:bg-amber-600">{requests.length}</Badge>
              </p>
              <p className="text-[11px] text-muted-foreground leading-snug">
                Agents posted rent requests for landlords that still need verification.
              </p>
            </div>
          </div>
          <div className="relative w-full sm:w-64">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search landlord, agent or district…"
              className="h-11 bg-background/80 pl-9 pr-10 text-sm sm:h-9 sm:text-xs"
            />
            {search && (
              <Button
                type="button"
                variant="ghost"
                size="icon"
                onClick={() => setSearch('')}
                aria-label="Clear queue search"
                className="absolute right-0 top-0 h-11 w-11 text-muted-foreground sm:h-9 sm:w-9"
              >
                <FilterX className="h-4 w-4" />
              </Button>
            )}
          </div>
        </div>
        {/* Tabs — pending, resubmitted and the read-only decision history */}
        <Tabs value={tab} onValueChange={(v) => setTab(v as QueueTab)} className="mt-3">
          <TabsList className="grid h-auto grid-cols-2 gap-1 bg-background/70 p-1 sm:flex sm:flex-wrap sm:justify-start">
            {(['pending', 'resubmitted', 'verified', 'rejected', 'cancelled', 'all'] as QueueTab[]).map((t) => (
              <TabsTrigger key={t} value={t} className="min-h-11 gap-1.5 px-2.5 text-xs sm:min-h-8 sm:text-[11px]">
                {TAB_LABEL[t]}
                <Badge variant="secondary" className="h-4 px-1 text-[9px]">{tabCounts[t]}</Badge>
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>

        {/* Location navigator: Country -> Region -> District -> County -> Sub-county -> Village/Cell -> landlord */}
        <div className="mt-2.5">
          <LandlordVerificationGeoBrowser rows={geoRows} path={geoPath} onChange={setGeoPath} />
        </div>

        {/* Date range + export */}
        <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
          <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-1.5 sm:flex">
            <Calendar className="h-3.5 w-3.5 text-muted-foreground" />
            <Input type="date" value={fromDate} max={toDate} onChange={(e) => setFromDate(e.target.value)} className="h-11 min-w-0 bg-background/80 px-2 text-xs sm:h-8 sm:w-[135px]" />
            <span className="text-[11px] text-muted-foreground">to</span>
            <Input type="date" value={toDate} min={fromDate} onChange={(e) => setToDate(e.target.value)} className="h-11 min-w-0 bg-background/80 px-2 text-xs sm:h-8 sm:w-[135px]" />
          </div>
          {([['7d', 6], ['30d', 29], ['90d', 89]] as [string, number][]).map(([label, days]) => (
            <Button
              key={label}
              size="sm"
              variant="outline"
              className="h-11 text-xs sm:h-8 sm:text-[10px]"
              onClick={() => {
                setFromDate(fmtDay(subDays(new Date(), days), 'yyyy-MM-dd'));
                setToDate(fmtDay(new Date(), 'yyyy-MM-dd'));
              }}
            >
              Last {label}
            </Button>
          ))}
          <Button size="sm" variant="outline" className="h-11 gap-1.5 text-xs sm:h-8 sm:text-[10px]" onClick={() => setShowChart((v) => !v)}>
            <BarChart3 className="h-3 w-3" />
            {showChart ? 'Hide chart' : 'Show chart'}
          </Button>
          <Button size="sm" className="h-11 gap-1.5 text-xs sm:ml-auto sm:h-8 sm:text-[10px]" disabled={exporting} onClick={handleExportPdf}>
            {exporting ? <Loader2 className="h-3 w-3 animate-spin" /> : <FileDown className="h-3 w-3" />}
            Export PDF
          </Button>
        </div>

        {showChart && chartData.length > 0 && (
          <div className="mt-2.5 rounded-xl border border-amber-500/25 bg-background/70 p-2">
            <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-1">
              Daily activity · requests created vs decided
            </p>
            <div className="h-[160px]">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={chartData} margin={{ top: 4, right: 6, left: -18, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" opacity={0.2} vertical={false} />
                  <XAxis dataKey="day" tickFormatter={(d) => fmtDay(new Date(d), 'dd MMM')} tick={{ fontSize: 9 }} interval="preserveStartEnd" />
                  <YAxis tick={{ fontSize: 9 }} allowDecimals={false} />
                  <Tooltip contentStyle={{ fontSize: 11 }} labelFormatter={(d) => fmtDay(new Date(String(d)), 'dd MMM yyyy')} />
                  <Legend wrapperStyle={{ fontSize: 10 }} />
                  <Bar dataKey="created" name="Created" fill="hsl(var(--muted-foreground))" radius={[2, 2, 0, 0]} />
                  <Bar dataKey="verified" name="Verified" fill="hsl(142 71% 40%)" radius={[2, 2, 0, 0]} />
                  <Bar dataKey="rejected" name="Rejected" fill="hsl(0 72% 51%)" radius={[2, 2, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>
        )}

        {resubmittedCount > 0 && tab !== 'resubmitted' && (
          <div className="mt-2.5 flex items-center gap-2 flex-wrap">
            <Button
              size="sm"
              variant={onlyResubmitted ? 'default' : 'outline'}
              className="h-7 text-[11px] gap-1.5"
              onClick={() => setOnlyResubmitted((v) => !v)}
            >
              <RotateCcw className="h-3 w-3" />
              {onlyResubmitted ? 'Showing resubmitted only' : `Resubmitted after rejection (${resubmittedCount})`}
            </Button>
            <span className="text-[10px] text-muted-foreground">
              These were rejected before and returned to review by the agent — the original rejection is shown on each card.
            </span>
          </div>
        )}
      </div>

      {/* Proper list — not nested in a collapsible */}
      <div className="space-y-2 p-2.5 sm:p-3">
        {(tab === 'verified' || tab === 'rejected' || tab === 'cancelled') ? null : filtered.length === 0 ? (
          <div className="text-center py-6 text-xs text-muted-foreground">
            No requests match “{search}”.
          </div>
        ) : (
          pagedFiltered.map((req) => (
            <div
              key={req.id}
              className="space-y-3 rounded-lg border border-amber-500/30 bg-background p-3 transition-colors hover:border-amber-500/60 sm:rounded-xl"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="font-bold text-sm text-foreground truncate">
                      {req.landlord_name || 'Unnamed landlord'}
                    </p>
                    <Badge variant="outline" className="shrink-0 border-amber-500/40 text-amber-700 text-[10px]">
                      Pending
                    </Badge>
                    {priorByLandlord[req.landlord_id] && (
                      <Badge variant="outline" className="shrink-0 text-[10px] gap-1 border-rose-500/50 text-rose-700 bg-rose-500/10">
                        <RotateCcw className="h-2.5 w-2.5" />
                        Resubmitted
                        {priorByLandlord[req.landlord_id].count > 1
                          ? ` · rejected ${priorByLandlord[req.landlord_id].count}×`
                          : ''}
                      </Badge>
                    )}
                    {districtByLandlord[req.landlord_id] && (
                      <Badge variant="outline" className="shrink-0 text-[10px] gap-1">
                        <MapPin className="h-2.5 w-2.5" />
                        {districtByLandlord[req.landlord_id]}
                      </Badge>
                    )}
                  </div>
                  {(req.landlord_phone || req.agent_phone) && (
                    <div className="mt-1.5 flex flex-col gap-1.5 min-[420px]:flex-row">
                      <CallButton phone={req.landlord_phone} who="landlord" className="w-full min-[420px]:w-auto" />
                      <CallButton phone={req.agent_phone} who="agent" className="w-full min-[420px]:w-auto" />
                    </div>
                  )}
                  <p className="text-[11px] text-muted-foreground flex items-center gap-1 mt-1 truncate">
                    <UserCircle className="h-3.5 w-3.5 shrink-0" />
                    Requested by <span className="font-medium text-foreground">{req.agent_name || 'Agent'}</span>
                    {req.agent_phone ? ` · ${req.agent_phone}` : ''}
                    <span className="inline-flex items-center gap-1 ml-2 opacity-70">
                      <Clock className="h-3 w-3" />
                      {new Date(req.created_at).toLocaleDateString()}
                    </span>
                  </p>
                </div>
              </div>

              {priorByLandlord[req.landlord_id] && (
                <div className="rounded-lg border border-rose-500/40 bg-rose-50/70 dark:bg-rose-500/10 p-2.5 space-y-1">
                  <p className="text-[10px] font-semibold uppercase tracking-wider text-rose-700 flex items-center gap-1">
                    <AlertTriangle className="h-3 w-3" />
                    Previously rejected · {new Date(priorByLandlord[req.landlord_id].at).toLocaleDateString()}
                  </p>
                  <p className="text-[11px] text-foreground">
                    {priorByLandlord[req.landlord_id].reason || 'No reason recorded.'}
                  </p>
                  <p className="text-[10px] text-muted-foreground">
                    The agent corrected the record and returned it to review, so it is pending again. Verify only if the issue above is fixed.
                  </p>
                </div>
              )}

              {/* Review trigger */}
              <Button
                size="sm"
                variant={expandedId === req.id ? 'secondary' : 'default'}
                className="h-11 w-full"
                onClick={() => openDetails(req)}
              >
                <Search className="h-3.5 w-3.5 mr-1" />
                {expandedId === req.id ? 'Hide details' : 'Review details to verify'}
              </Button>

              {expandedId === req.id && (() => {
                const bundle = details[req.landlord_id];
                const d = bundle?.landlord;
                const houses = bundle?.houses ?? [];
                if (detailLoading && !bundle) {
                  return (
                    <div className="flex items-center justify-center gap-2 py-4 text-xs text-muted-foreground">
                      <Loader2 className="h-4 w-4 animate-spin" /> Loading landlord details…
                    </div>
                  );
                }
                const locationParts = [d?.village, d?.town_council || d?.sub_county, d?.county, d?.district, d?.region]
                  .filter(Boolean);
                const hasGps = d?.latitude != null && d?.longitude != null;
                return (
                  <div className="space-y-2.5 rounded-xl border border-amber-500/30 bg-amber-50/40 dark:bg-amber-500/5 p-3">
                    {/* Location */}
                    <div className="space-y-1">
                      <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider flex items-center gap-1">
                        <MapPin className="h-3 w-3" /> Location
                      </p>
                      <p className="text-xs font-medium text-foreground">
                        {locationParts.length ? locationParts.join(', ') : (d?.property_address || 'No location on file')}
                      </p>
                      {d?.property_address && locationParts.length > 0 && (
                        <p className="text-[11px] text-muted-foreground">{d.property_address}</p>
                      )}
                      {hasGps && (
                        <a
                          href={`https://www.google.com/maps?q=${d!.latitude},${d!.longitude}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-[11px] font-medium text-sky-600 hover:underline inline-flex items-center gap-1"
                        >
                          <MapPin className="h-3 w-3" /> View GPS pin
                        </a>
                      )}
                    </div>

                    {/* Houses */}
                    <div className="space-y-1">
                      <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider flex items-center gap-1">
                        <Home className="h-3 w-3" /> Houses
                        <span className="ml-1 normal-case text-foreground">
                          {d?.number_of_houses ?? houses.length} registered
                          {d?.house_category ? ` · ${String(d.house_category).replace(/_/g, ' ')}` : ''}
                        </span>
                      </p>
                      {houses.length > 0 ? (
                        <ul className="space-y-1">
                          {houses.slice(0, 5).map(h => (
                            <li key={h.id} className="text-[11px] text-muted-foreground flex items-center gap-1.5">
                              <Building2 className="h-3 w-3 shrink-0" />
                              <span className="truncate">{h.title || 'Untitled listing'}</span>
                              {[h.district, h.region].filter(Boolean).length > 0 && (
                                <span className="opacity-70">· {[h.district, h.region].filter(Boolean).join(', ')}</span>
                              )}
                              {h.monthly_rent != null && <span className="opacity-70">· {fmtUgx(h.monthly_rent)}</span>}
                            </li>
                          ))}
                          {houses.length > 5 && (
                            <li className="text-[11px] text-muted-foreground">+{houses.length - 5} more</li>
                          )}
                        </ul>
                      ) : (
                        <p className="text-[11px] text-muted-foreground">No house listings linked yet.</p>
                      )}
                    </div>

                    {/* Agent who registered */}
                    <div className="space-y-1">
                      <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider flex items-center gap-1">
                        <UserCircle className="h-3 w-3" /> Registered by agent
                      </p>
                      <p className="text-xs font-medium text-foreground">{req.agent_name || 'Unknown agent'}</p>
                      {req.agent_phone && (
                        <CallButton phone={req.agent_phone} who="agent" />
                      )}
                    </div>

                    {/* Finance & contact metadata */}
                          <div className="grid grid-cols-1 gap-x-3 gap-y-2 border-t border-amber-500/20 pt-2 min-[420px]:grid-cols-2">
                      <div>
                        <p className="text-[9px] uppercase tracking-wide text-muted-foreground flex items-center gap-1"><Banknote className="h-3 w-3" /> Monthly rent</p>
                        <p className="text-[11px] font-medium">{fmtUgx(d?.monthly_rent)}</p>
                      </div>
                      <div>
                        <p className="text-[9px] uppercase tracking-wide text-muted-foreground flex items-center gap-1"><Smartphone className="h-3 w-3" /> Smartphone</p>
                        <p className="text-[11px] font-medium">{d?.has_smartphone ? 'Yes' : 'No'}</p>
                      </div>
                      {(d?.bank_name || d?.account_number) && (
                        <div className="col-span-2">
                          <p className="text-[9px] uppercase tracking-wide text-muted-foreground">Bank</p>
                          <p className="text-[11px] font-medium">{[d?.bank_name, d?.account_number].filter(Boolean).join(' · ')}</p>
                        </div>
                      )}
                      {(d?.mobile_money_number || d?.mobile_money_name) && (
                        <div className="col-span-2">
                          <p className="text-[9px] uppercase tracking-wide text-muted-foreground">Mobile money</p>
                          <p className="text-[11px] font-medium">{[d?.mobile_money_name, d?.mobile_money_number].filter(Boolean).join(' · ')}</p>
                        </div>
                      )}
                      {(d?.caretaker_name || d?.caretaker_phone) && (
                        <div className="col-span-2">
                          <p className="text-[9px] uppercase tracking-wide text-muted-foreground">Caretaker</p>
                          <p className="text-[11px] font-medium">{[d?.caretaker_name, d?.caretaker_phone].filter(Boolean).join(' · ')}</p>
                        </div>
                      )}
                      {d?.created_at && (
                        <div className="col-span-2">
                          <p className="text-[9px] uppercase tracking-wide text-muted-foreground flex items-center gap-1"><Calendar className="h-3 w-3" /> Registered</p>
                          <p className="text-[11px] font-medium">{new Date(d.created_at).toLocaleDateString()}</p>
                        </div>
                      )}
                    </div>

                    {/* Step 2: decide */}
                    {rejectingId === req.id ? (
                      <div className="space-y-2 pt-1">
                        <Textarea
                          value={rejectComment}
                          onChange={(e) => setRejectComment(e.target.value)}
                          placeholder="Add a comment explaining why this landlord is rejected (min 10 characters)…"
                          className="min-h-[64px] text-sm"
                        />
                        <div className="flex flex-col gap-2 min-[420px]:flex-row">
                          <Button size="sm" variant="destructive" className="flex-1" disabled={busyId === req.id} onClick={() => handleReject(req)}>
                            {busyId === req.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <XCircle className="h-3.5 w-3.5 mr-1" />}
                            Confirm reject
                          </Button>
                          <Button size="sm" variant="ghost" className="flex-1" disabled={busyId === req.id} onClick={() => { setRejectingId(null); setRejectComment(''); }}>
                            Cancel
                          </Button>
                        </div>
                      </div>
                    ) : (
                      <div className="space-y-2 pt-1">
                        <div className="space-y-1">
                          <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">
                            Verification comment <span className="normal-case font-normal">(optional — appears in reports)</span>
                          </p>
                          <Textarea
                            value={verifyComment}
                            onChange={(e) => setVerifyComment(e.target.value)}
                            placeholder="What did you check before verifying this landlord? Leave blank to verify without a comment."
                            className="min-h-[56px] text-sm"
                          />
                        </div>
                        <div className="flex flex-col gap-2 min-[420px]:flex-row">
                        <Button size="sm" className="flex-1 bg-emerald-600 hover:bg-emerald-700 text-white" disabled={busyId === req.id} onClick={() => handleVerify(req)}>
                          {busyId === req.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <CheckCircle2 className="h-3.5 w-3.5 mr-1" />}
                          Verify landlord
                        </Button>
                        <Button size="sm" variant="outline" className="flex-1 border-rose-500/40 text-rose-700 hover:bg-rose-50" disabled={busyId === req.id} onClick={() => { setRejectingId(req.id); setRejectComment(''); }}>
                          <XCircle className="h-3.5 w-3.5 mr-1" />
                          Reject
                        </Button>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })()}
            </div>
          ))
        )}

        {/* Read-only decision history (verified / rejected / cancelled / all) */}
        {tab !== 'pending' && tab !== 'resubmitted' && (
          decidedLoading ? (
            <div className="flex items-center justify-center gap-2 py-6 text-xs text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" /> Loading decision history…
            </div>
          ) : decidedFiltered.length === 0 ? (
            <div className="text-center py-6 text-xs text-muted-foreground">
              No {TAB_LABEL[tab].toLowerCase()} requests in this date range.
            </div>
          ) : (
            pagedDecided.map((r) => (
              <div key={r.id} className="rounded-xl border border-border bg-background p-3 space-y-1.5">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <p className="font-semibold text-sm truncate">{r.landlord_name || 'Unnamed landlord'}</p>
                      <Badge
                        variant="outline"
                        className={
                          r.status === 'verified'
                            ? 'text-[10px] border-emerald-500/50 text-emerald-700 bg-emerald-500/10 gap-1'
                            : r.status === 'rejected'
                              ? 'text-[10px] border-rose-500/50 text-rose-700 bg-rose-500/10 gap-1'
                              : 'text-[10px] gap-1'
                        }
                      >
                        {r.status === 'verified' ? <CheckCircle2 className="h-2.5 w-2.5" />
                          : r.status === 'rejected' ? <XCircle className="h-2.5 w-2.5" />
                            : <Ban className="h-2.5 w-2.5" />}
                        {r.status}
                      </Badge>
                      {districtByLandlordAll[r.landlord_id] && (
                        <Badge variant="outline" className="text-[10px] gap-1">
                          <MapPin className="h-2.5 w-2.5" />
                          {districtByLandlordAll[r.landlord_id]}
                        </Badge>
                      )}
                    </div>
                    {(r.landlord_phone || r.agent_phone) && (
                      <div className="mt-1.5 flex flex-col gap-1.5 min-[420px]:flex-row">
                        <CallButton phone={r.landlord_phone} who="landlord" className="w-full min-[420px]:w-auto" />
                        <CallButton phone={r.agent_phone} who="agent" className="w-full min-[420px]:w-auto" />
                      </div>
                    )}
                    <p className="text-[11px] text-muted-foreground flex items-center gap-1 mt-0.5 flex-wrap">
                      <UserCircle className="h-3.5 w-3.5" />
                      {r.agent_name || 'Agent'}{r.agent_phone ? ` · ${r.agent_phone}` : ''}
                      <span className="inline-flex items-center gap-1 ml-2 opacity-70">
                        <Clock className="h-3 w-3" />
                        requested {new Date(r.created_at).toLocaleDateString()}
                        {r.resolved_at ? ` · decided ${new Date(r.resolved_at).toLocaleDateString()}` : ''}
                      </span>
                    </p>
                  </div>
                </div>
                {(r.reject_comment || r.note) && (
                  <p className="text-[11px] text-foreground bg-muted/50 rounded-lg p-2">
                    {r.reject_comment || r.note}
                  </p>
                )}
              </div>
            ))
          )
        )}

        {/* Pagination */}
        {activeRows.length > PAGE_SIZE && (
          <div className="mt-2 flex flex-col gap-2 border-t border-border/60 pt-3 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-[11px] text-muted-foreground">
              Showing {safePage * PAGE_SIZE + 1}–{Math.min(activeRows.length, safePage * PAGE_SIZE + PAGE_SIZE)} of {activeRows.length}
            </p>
            <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-1.5">
              <Button
                size="sm"
                variant="outline"
                className="h-11 gap-1 text-xs sm:h-8 sm:text-[11px]"
                disabled={safePage === 0}
                onClick={() => setPage(safePage - 1)}
              >
                <ChevronLeft className="h-3 w-3" />
                Prev
              </Button>
              <span className="text-[11px] text-muted-foreground px-1">
                Page {safePage + 1} of {pageCount}
              </span>
              <Button
                size="sm"
                variant="outline"
                className="h-11 gap-1 text-xs sm:h-8 sm:text-[11px]"
                disabled={safePage >= pageCount - 1}
                onClick={() => setPage(safePage + 1)}
              >
                Next
                <ChevronRight className="h-3 w-3" />
              </Button>
            </div>
          </div>
        )}
      </div>

      {/* Floating quick toggle — Pending ⇄ Full history, once the header tabs scroll away */}
      {tabsOutOfView && (
        <div className="pointer-events-none fixed inset-x-0 bottom-24 z-40 flex justify-center px-4 sm:bottom-6">
          <Button
            type="button"
            size="sm"
            onClick={togglePendingHistory}
            className="pointer-events-auto h-11 gap-2 rounded-full bg-amber-600 px-5 text-xs font-semibold text-white shadow-lg shadow-amber-900/30 hover:bg-amber-700"
            aria-label={isHistoryView ? 'Switch to pending verifications' : 'Switch to full history'}
          >
            <ArrowLeftRight className="h-4 w-4" />
            {isHistoryView ? `Pending (${tabCounts.pending})` : `Full history (${tabCounts.all})`}
          </Button>
        </div>
      )}
    </div>
  );
}
