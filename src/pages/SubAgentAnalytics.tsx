import { useState, useEffect, useRef, useMemo } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Input } from '@/components/ui/input';
import { 
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { 
  ArrowLeft, 
  Users, 
  TrendingUp, 
  Loader2, 
  UserPlus,
  Calendar,
  Coins,
  Target,
  ChevronRight,
  BarChart3,
  Download,
  FileText,
  FileSpreadsheet,
  Phone,
  Mail,
  MapPin,
  Wallet,
  IdCard,
  Briefcase,
  Search,
  X,
  Filter,
  ArrowUpDown,
  Sparkles,
  Plus,
  CheckCircle2,
  AlertCircle,
  Send,
  Clock,
  ChevronDown,
  History,
  XCircle,
  RefreshCw,
  UserMinus,
} from 'lucide-react';
import { Home } from 'lucide-react';
import { formatUGX } from '@/lib/rentCalculations';
import { format, startOfMonth, endOfMonth, subMonths } from 'date-fns';
import { AddSubAgentSearch } from '@/components/agent/AddSubAgentSearch';
import { ShareSubAgentLink } from '@/components/agent/ShareSubAgentLink';
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from '@/components/ui/sheet';
import { exportToCSV, exportToPDF, formatNumberForExport, formatDateForExport } from '@/lib/exportUtils';
import { useToast } from '@/hooks/use-toast';
import { hapticTap } from '@/lib/haptics';
import { useReducedMotion } from '@/hooks/useCombinedSettings';
import { invokeEdgeFunction } from '@/lib/invokeEdgeFunction';
import { getPublicOrigin } from '@/lib/getPublicOrigin';
import { FloatingActionButton } from '@/components/FloatingActionButton';
import { SubAgentBottomNav, type SubAgentSection } from '@/components/agent/SubAgentBottomNav';
import { SubAgentPayoutAudit } from '@/components/agent/SubAgentPayoutAudit';
import { SubAgentStatusBoard } from '@/components/agent/SubAgentStatusBoard';
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
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  LineChart,
  Line,
  PieChart,
  Pie,
  Cell
} from 'recharts';
import ScreenLoader from '@/components/common/ScreenLoader';

interface SubAgent {
  id: string;
  sub_agent_id: string;
  created_at: string;
  status?: string;
  invite_sms_status?: string | null;
  invite_email_status?: string | null;
  invite_sent_at?: string | null;
  accepted_at?: string | null;
  verified_at?: string | null;
  source?: string | null;
  rejection_reason?: string | null;
  profile?: {
    full_name: string;
    phone: string;
    avatar_url: string | null;
    email?: string | null;
    national_id?: string | null;
    district?: string | null;
    region?: string | null;
    occupation?: string | null;
    joined_at?: string | null;
  };
  wallet?: {
    balance: number;
    withdrawable_balance: number;
    float_balance: number;
    advance_balance: number;
    locked_balance: number;
  };
  totalEarnings: number;
  tenantsCount: number;
  monthlyEarnings: { month: string; amount: number }[];
  tenants: { id: string; name: string; phone: string | null; totalRepaid: number }[];
  facilitatedRentVolume: number;
  accessedFunds: number;
  platformRewards: number;
  serviceFees: number;
  houses: SubAgentHouse[];
  houseOverrideEarnings: number;
  hasOtherParent?: boolean;
}

interface SubAgentHouse {
  id: string;
  title: string | null;
  status: string | null;
  monthly_rent: number;
  verified: boolean;
  tenant_id: string | null;
  region: string | null;
  district: string | null;
  created_at: string;
  overrideEarned: number;
  address: string | null;
  sub_county: string | null;
  village: string | null;
  house_category: string | null;
  number_of_rooms: number | null;
  total_monthly_cost: number;
  transactions: HouseTransaction[];
}

interface HouseTransaction {
  id: string;
  label: string;
  event_type: string;
  amount: number;
  status: string | null;
  occurred_at: string;
}

interface MonthlyData {
  month: string;
  earnings: number;
  subAgentsJoined: number;
}


interface RecruiterSplit {
  trace_id: string;
  created_at: string;
  tracking_id: string | null;
  tenant_name: string;
  amount: number;
  total_commission: number;
  subagent_share: number;
  recruiter_override: number;
}

const COLORS = ['hsl(var(--primary))', 'hsl(var(--success))', 'hsl(var(--warning))', 'hsl(var(--destructive))', 'hsl(142, 76%, 36%)', 'hsl(221, 83%, 53%)'];

type TimelineTone = 'success' | 'destructive' | 'info' | 'muted';
interface TimelineEvent {
  key: string;
  label: string;
  detail?: string;
  at: string | null;
  icon: typeof Send;
  tone: TimelineTone;
}

function buildInviteTimeline(sa: SubAgent): TimelineEvent[] {
  const events: TimelineEvent[] = [];

  // 1. Invite created
  events.push({
    key: 'created',
    label: 'Invite created',
    detail: sa.source ? `Source: ${sa.source}` : undefined,
    at: sa.created_at,
    icon: UserPlus,
    tone: 'muted',
  });

  // 2. SMS delivery
  if (sa.invite_sms_status) {
    const failed = sa.invite_sms_status === 'failed';
    events.push({
      key: 'sms',
      label: failed ? 'SMS delivery failed' : 'SMS invite sent',
      detail: `Status: ${sa.invite_sms_status}`,
      at: sa.invite_sent_at || sa.created_at,
      icon: failed ? XCircle : Send,
      tone: failed ? 'destructive' : 'info',
    });
  }

  // 3. Email delivery
  if (sa.invite_email_status) {
    const failed = sa.invite_email_status === 'failed';
    events.push({
      key: 'email',
      label: failed ? 'Email delivery failed' : 'Email invite sent',
      detail: `Status: ${sa.invite_email_status}`,
      at: sa.invite_sent_at || sa.created_at,
      icon: failed ? XCircle : Mail,
      tone: failed ? 'destructive' : 'info',
    });
  }

  // 4. Acceptance
  const acceptedAt = sa.accepted_at || (sa.status === 'verified' ? sa.verified_at : null);
  if (acceptedAt || sa.status === 'verified') {
    events.push({
      key: 'accepted',
      label: 'Invitation accepted',
      detail: 'User joined your team',
      at: acceptedAt || null,
      icon: CheckCircle2,
      tone: 'success',
    });
  } else if (sa.status === 'rejected') {
    events.push({
      key: 'rejected',
      label: 'Invitation declined',
      detail: sa.rejection_reason || undefined,
      at: sa.verified_at || null,
      icon: XCircle,
      tone: 'destructive',
    });
  }

  return events.sort((a, b) => {
    const ta = a.at ? new Date(a.at).getTime() : 0;
    const tb = b.at ? new Date(b.at).getTime() : 0;
    return ta - tb;
  });
}

const TIMELINE_TONE: Record<TimelineTone, string> = {
  success: 'bg-success/10 text-success',
  destructive: 'bg-destructive/10 text-destructive',
  info: 'bg-blue-500/10 text-blue-600',
  muted: 'bg-muted text-muted-foreground',
};

export default function SubAgentAnalytics() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const { toast } = useToast();
  const { user, loading: authLoading } = useAuth();
  const [subAgents, setSubAgents] = useState<SubAgent[]>([]);
  const [loading, setLoading] = useState(true);
  const [exporting, setExporting] = useState(false);
  const [selectedSubAgent, setSelectedSubAgent] = useState<SubAgent | null>(null);
  const [selectedHouse, setSelectedHouse] = useState<SubAgentHouse | null>(null);
  const [houseTenant, setHouseTenant] = useState<{ full_name: string; phone: string | null } | null>(null);
  const [houseTenantLoading, setHouseTenantLoading] = useState(false);
  const [recruiterSplits, setRecruiterSplits] = useState<RecruiterSplit[]>([]);
  const [splitsLoading, setSplitsLoading] = useState(false);
  
  const [inviteSheetOpen, setInviteSheetOpen] = useState(false);
  const [resendingId, setResendingId] = useState<string | null>(null);
  const [releaseConfirmOpen, setReleaseConfirmOpen] = useState(false);
  const [releasing, setReleasing] = useState(false);
  const [expandedTimelines, setExpandedTimelines] = useState<Set<string>>(new Set());
  const [activeSection, setActiveSection] = useState<SubAgentSection>('subagent-overview');

  const { prefersReducedMotion } = useReducedMotion();

  const scrollToSection = (id: SubAgentSection) => {
    document.getElementById(id)?.scrollIntoView({
      behavior: prefersReducedMotion ? 'auto' : 'smooth',
      block: 'start',
    });
  };

  const toggleTimeline = (id: string) => {
    setExpandedTimelines(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };
  const [totalEarningsFromSubAgents, setTotalEarningsFromSubAgents] = useState(0);
  const reportRef = useRef<HTMLDivElement>(null);
  const [monthlyData, setMonthlyData] = useState<MonthlyData[]>([]);

  // Houses pagination inside sub-agent detail sheet
  const [housesPage, setHousesPage] = useState(1);
  const [housesLoadingMore, setHousesLoadingMore] = useState(false);
  const housesSentinelRef = useRef<HTMLDivElement>(null);
  const HOUSES_PER_PAGE = 10;

  // Pull-to-refresh state for detail sheet
  const detailScrollRef = useRef<HTMLDivElement>(null);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [visualPullProgress, setVisualPullProgress] = useState(0);
  const pullStartYRef = useRef(0);
  const isPullingRef = useRef(false);
  const pullProgressRef = useRef(0);

  // Search & filter state
  const [subAgentSearch, setSubAgentSearch] = useState('');
  const [subAgentStatusFilter, setSubAgentStatusFilter] = useState<'all' | 'with_tenants' | 'no_tenants'>('all');
  const [inviteStatusFilter, setInviteStatusFilter] = useState<'all' | 'accepted' | 'pending' | 'expired' | 'declined' | 'switched'>('all');
  const [tenantSearch, setTenantSearch] = useState('');
  const [subAgentSort, setSubAgentSort] = useState<'newest' | 'name_asc' | 'withdrawable_desc'>('newest');

  useEffect(() => {
    if (!authLoading && !user) {
      navigate('/auth');
    } else if (user) {
      fetchSubAgentAnalytics();
    }
  }, [user, authLoading, navigate]);

  // Auto-open detail when ?id=xxx is present in URL
  useEffect(() => {
    const id = searchParams.get('id');
    if (!id || subAgents.length === 0) return;
    const match = subAgents.find(sa => sa.sub_agent_id === id);
    if (match) setSelectedSubAgent(match);
  }, [searchParams, subAgents]);

  // Load the linked tenant for the open house detail
  useEffect(() => {
    if (!selectedHouse?.tenant_id) {
      setHouseTenant(null);
      return;
    }
    let cancelled = false;
    (async () => {
      setHouseTenantLoading(true);
      try {
        const { data } = await supabase
          .from('profiles')
          .select('full_name, phone')
          .eq('id', selectedHouse.tenant_id)
          .maybeSingle();
        if (!cancelled) setHouseTenant(data ? { full_name: data.full_name, phone: data.phone ?? null } : null);
      } catch {
        if (!cancelled) setHouseTenant(null);
      } finally {
        if (!cancelled) setHouseTenantLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [selectedHouse?.tenant_id]);

  // Load per-transaction recruiter splits (8% sub-agent vs 2% recruiter) for the open sub-agent
  useEffect(() => {
    if (!selectedSubAgent) {
      setRecruiterSplits([]);
      return;
    }
    let cancelled = false;
    (async () => {
      setSplitsLoading(true);
      try {
        const { data, error } = await supabase.rpc('get_subagent_recruiter_splits', {
          p_sub_agent_id: selectedSubAgent.sub_agent_id,
        });
        if (error) throw error;
        if (!cancelled) setRecruiterSplits((data as RecruiterSplit[]) || []);
      } catch (err) {
        console.error('Error fetching recruiter splits:', err);
        if (!cancelled) setRecruiterSplits([]);
      } finally {
        if (!cancelled) setSplitsLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [selectedSubAgent]);

  const closeDetail = () => {
    setSelectedSubAgent(null);
    setTenantSearch('');
    // Clear the id param from URL so back/refresh doesn't reopen
    const next = new URLSearchParams(searchParams);
    next.delete('id');
    setSearchParams(next, { replace: true });
  };

  const handleReleaseSubAgent = async () => {
    if (!selectedSubAgent) return;
    const target = selectedSubAgent;
    setReleasing(true);
    const { error } = await supabase.rpc('release_sub_agent', {
      p_sub_agent_id: target.sub_agent_id,
    });
    setReleasing(false);
    if (error) {
      toast({
        title: 'Could not unlink sub-agent',
        description: error.message,
        variant: 'destructive',
      });
      return;
    }
    setReleaseConfirmOpen(false);
    toast({
      title: `${target.profile?.full_name || 'Sub-agent'} unlinked`,
      description: 'They are no longer your sub-agent. Override commission and benefits have stopped.',
    });
    closeDetail();
    fetchSubAgentAnalytics();
  };

  // Clear tenant search and reset houses pagination when switching sub-agents
  useEffect(() => {
    setTenantSearch('');
    setHousesPage(1);
    setHousesLoadingMore(false);
  }, [selectedSubAgent?.sub_agent_id]);

  // Infinite scroll observer for houses list inside detail sheet
  useEffect(() => {
    if (!selectedSubAgent || selectedSubAgent.houses.length === 0) return;
    const sentinel = housesSentinelRef.current;
    if (!sentinel) return;

    const total = selectedSubAgent.houses.length;
    const visibleCount = housesPage * HOUSES_PER_PAGE;
    const hasMore = visibleCount < total;
    if (!hasMore) return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting) {
          setHousesLoadingMore(true);
          // tiny delay so the spinner appears briefly and the UI feels responsive
          requestAnimationFrame(() => {
            setHousesPage((p) => p + 1);
            setHousesLoadingMore(false);
          });
        }
      },
      { root: null, rootMargin: '120px', threshold: 0 }
    );

    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [selectedSubAgent, housesPage]);

  // Pull-to-refresh on the sub-agent detail sheet
  useEffect(() => {
    const el = detailScrollRef.current;
    if (!el) return;

    const onTouchStart = (e: TouchEvent) => {
      if (el.scrollTop <= 0) {
        pullStartYRef.current = e.touches[0].clientY;
        isPullingRef.current = true;
      }
    };

    const onTouchMove = (e: TouchEvent) => {
      if (!isPullingRef.current) return;
      const diff = e.touches[0].clientY - pullStartYRef.current;
      if (diff > 0 && el.scrollTop <= 0) {
        e.preventDefault();
        const progress = Math.min(diff / 150, 1);
        pullProgressRef.current = progress;
        setVisualPullProgress(progress);
      }
    };

    const onTouchEnd = () => {
      if (pullProgressRef.current >= 1) {
        setIsRefreshing(true);
        fetchSubAgentAnalytics({ silent: true }).finally(() => {
          setIsRefreshing(false);
        });
      }
      isPullingRef.current = false;
      pullProgressRef.current = 0;
      setVisualPullProgress(0);
    };

    el.addEventListener('touchstart', onTouchStart, { passive: true });
    el.addEventListener('touchmove', onTouchMove, { passive: false });
    el.addEventListener('touchend', onTouchEnd, { passive: true });

    return () => {
      el.removeEventListener('touchstart', onTouchStart);
      el.removeEventListener('touchmove', onTouchMove);
      el.removeEventListener('touchend', onTouchEnd);
    };
  }, []);

  // Scroll-spy: highlight the bottom-nav section currently in view
  useEffect(() => {
    if (loading || subAgents.length === 0) return;
    const ids: SubAgentSection[] = ['subagent-overview', 'subagent-invite', 'subagent-team', 'subagent-audit'];
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => b.intersectionRatio - a.intersectionRatio);
        if (visible[0]) setActiveSection(visible[0].target.id as SubAgentSection);
      },
      { rootMargin: '-40% 0px -50% 0px', threshold: [0, 0.25, 0.5, 1] },
    );
    ids.forEach((id) => {
      const el = document.getElementById(id);
      if (el) observer.observe(el);
    });
    return () => observer.disconnect();
  }, [loading, subAgents.length]);


  const fetchSubAgentAnalytics = async (opts?: { silent?: boolean }) => {
    if (!user) return;
    if (!opts?.silent) setLoading(true);

    try {
      // Fetch sub-agents
      const { data: subAgentsData, error } = await supabase
        .from('agent_subagents')
        .select('*')
        .eq('parent_agent_id', user.id)
        .order('created_at', { ascending: false });

      if (error) throw error;

      if (!subAgentsData || subAgentsData.length === 0) {
        setSubAgents([]);
        setLoading(false);
        return;
      }

      const subAgentIds = subAgentsData.map(sa => sa.sub_agent_id);
      const subAgentIdsSet = new Set(subAgentIds);

      // Detect "switched" sub-agents (linked to another parent previously)
      const { data: otherParentLinks } = await supabase
        .from('agent_subagents')
        .select('sub_agent_id')
        .in('sub_agent_id', subAgentIds)
        .neq('parent_agent_id', user.id);
      const otherParentSet = new Set((otherParentLinks || []).map(l => l.sub_agent_id));

      // Fetch sub-agent profiles via a SECURITY DEFINER RPC. A normal agent
      // cannot read their sub-agents' rows directly (profiles RLS only exposes
      // their own tenants), which previously made every sub-agent show as
      // "Unknown". This RPC returns only the caller's own sub-agents.
      const { data: profiles } = await supabase.rpc('get_my_subagent_profiles');

      // Fetch sub-agents' wallets
      const { data: wallets } = await supabase
        .from('wallets')
        .select('user_id, balance, withdrawable_balance, float_balance, advance_balance, locked_balance')
        .in('user_id', subAgentIds);

      // Fetch all earnings attributable to sub-agents (commissions from their
      // tenants + any referral bonus where the referred user is one of our
      // sub-agents). This gives the parent agent a true "total earned over time"
      // figure rather than only the current snapshot.
      const { data: allEarnings } = await supabase
        .from('agent_earnings')
        .select('*')
        .eq('agent_id', user.id)
        .in('earning_type', ['subagent_commission', 'referral_bonus'])
        .order('created_at', { ascending: false });

      // Fetch sub-agents' own earnings (platform rewards)
      const { data: ownEarnings } = await supabase
        .from('agent_earnings')
        .select('agent_id, amount')
        .in('agent_id', subAgentIds);

      // Fetch business advances (accessed funds)
      const { data: advances } = await supabase
        .from('business_advances')
        .select('agent_id, principal')
        .in('agent_id', subAgentIds)
        .in('status', ['active', 'completed', 'cfo_disbursed']);

      // Fetch houses listed by each sub-agent
      const { data: houseRows } = await supabase
        .from('house_listings')
        .select('id, agent_id, title, status, monthly_rent, total_monthly_cost, verified, tenant_id, region, district, sub_county, village, address, house_category, number_of_rooms, created_at')
        .in('agent_id', subAgentIds)
        .order('created_at', { ascending: false });

      // Fetch the parent's recruiter-override earnings on those sub-agents'
      // house listings (e.g. 3,000 when a sub-agent's listing gets verified).
      const { data: overrideRows } = await supabase
        .from('recruiter_override_events')
        .select('id, sub_agent_id, source_table, source_id, amount, status, event_type, label, occurred_at')
        .eq('recruiter_id', user.id)
        .eq('source_table', 'house_listings')
        .in('sub_agent_id', subAgentIds)
        .order('occurred_at', { ascending: false });

      // Broader datasets used ONLY to power the "Monthly Earnings" chart so it
      // reflects every UGX the parent has earned from their sub-agent network
      // over time (any earning_type, plus every credited recruiter override —
      // house listing, landlord verification, LC1 chairperson, etc).
      const chartWindowStart = format(subMonths(new Date(), 5), 'yyyy-MM-01');
      const [{ data: chartEarningsRaw }, { data: chartOverridesRaw }] = await Promise.all([
        supabase
          .from('agent_earnings')
          .select('amount, created_at, earning_type')
          .eq('agent_id', user.id)
          .gte('created_at', chartWindowStart),
        supabase
          .from('recruiter_override_events')
          .select('amount, occurred_at, status')
          .eq('recruiter_id', user.id)
          .in('status', ['credited', 'paid'])
          .gte('occurred_at', chartWindowStart),
      ]);

      // Map override earnings by house listing id (only successful/credited ones)
      const overrideByHouse: Record<string, number> = {};
      const houseOverrideBySubAgent: Record<string, number> = {};
      const txByHouse: Record<string, HouseTransaction[]> = {};
      (overrideRows || []).forEach(o => {
        if (o.status && o.status !== 'credited' && o.status !== 'success' && o.status !== 'paid') return;
        const amt = Number(o.amount || 0);
        if (o.source_id) overrideByHouse[o.source_id] = (overrideByHouse[o.source_id] || 0) + amt;
        if (o.sub_agent_id) houseOverrideBySubAgent[o.sub_agent_id] = (houseOverrideBySubAgent[o.sub_agent_id] || 0) + amt;
        if (o.source_id) {
          const list = txByHouse[o.source_id] || (txByHouse[o.source_id] = []);
          list.push({
            id: o.id,
            label: o.label || 'Override earning',
            event_type: o.event_type || 'override',
            amount: amt,
            status: o.status,
            occurred_at: o.occurred_at || '',
          });
        }
      });

      const housesBySubAgent: Record<string, SubAgentHouse[]> = {};
      (houseRows || []).forEach(h => {
        const list = housesBySubAgent[h.agent_id] || (housesBySubAgent[h.agent_id] = []);
        list.push({
          id: h.id,
          title: h.title,
          status: h.status,
          monthly_rent: Number(h.monthly_rent || 0),
          total_monthly_cost: Number(h.total_monthly_cost || 0),
          verified: !!h.verified,
          tenant_id: h.tenant_id,
          region: h.region,
          district: h.district,
          sub_county: h.sub_county,
          village: h.village,
          address: h.address,
          house_category: h.house_category,
          number_of_rooms: h.number_of_rooms,
          created_at: h.created_at,
          overrideEarned: overrideByHouse[h.id] || 0,
          transactions: txByHouse[h.id] || [],
        });
      });

      // Fetch tenants per sub-agent
      const tenantsData: Record<string, { id: string; name: string; phone: string | null; totalRepaid: number }[]> = {};
      const earningsPerSubAgent: Record<string, number> = {};
      const monthlyEarningsPerSubAgent: Record<string, Record<string, number>> = {};
      const rentVolumePerSubAgent: Record<string, number> = {};
      const serviceFeesPerSubAgent: Record<string, number> = {};

      // Batch all rent requests for every sub-agent in ONE query (avoids the
      // previous N+1 pattern that ran 2 queries per sub-agent and made this
      // page slow for agents with many sub-agents).
      const { data: allRentRequests } = await supabase
        .from('rent_requests')
        .select('agent_id, tenant_id, total_repayment, request_fee')
        .in('agent_id', subAgentIds);

      const rentRequestsBySubAgent: Record<string, { tenant_id: string; total_repayment: number | null; request_fee: number | null }[]> = {};
      (allRentRequests || []).forEach((rr) => {
        const list = rentRequestsBySubAgent[rr.agent_id] || (rentRequestsBySubAgent[rr.agent_id] = []);
        list.push(rr);
      });

      // Fetch every tenant profile grouped by sub-agent through a SECURITY
      // DEFINER RPC. Sub-agents' tenants are not visible to the parent agent
      // under profiles RLS, so this RPC returns only tenants belonging to the
      // caller's sub-agents across all link types (rent request posting,
      // rent request assignment, direct referral, referrals table, managed).
      const { data: tenantProfiles } = await supabase.rpc('get_my_subagent_tenant_profiles');
      (tenantProfiles || []).forEach((tp) => {
        const subAgentId = tp.sub_agent_id;
        if (!subAgentId || !subAgentIdsSet.has(subAgentId)) return;
        const list = tenantsData[subAgentId] || (tenantsData[subAgentId] = []);
        if (!list.some((t) => t.id === tp.id)) {
          list.push({
            id: tp.id,
            name: tp.full_name ?? 'Unnamed',
            phone: tp.phone ?? null,
            totalRepaid: 0,
          });
        }
      });

      for (const subAgentId of subAgentIds) {
        const rentRequests = rentRequestsBySubAgent[subAgentId] || [];

        // Sum facilitated rent volume and service fees
        rentVolumePerSubAgent[subAgentId] = rentRequests.reduce((sum, rr) => sum + Number(rr.total_repayment || 0), 0);
        serviceFeesPerSubAgent[subAgentId] = rentRequests.reduce((sum, rr) => sum + Number(rr.request_fee || 0), 0);

        if (!tenantsData[subAgentId]) {
          tenantsData[subAgentId] = [];
        }

        earningsPerSubAgent[subAgentId] = 0;
        monthlyEarningsPerSubAgent[subAgentId] = {};
      }

      // Calculate earnings per sub-agent from our earnings
      let totalEarnings = 0;
      if (allEarnings) {
        for (const earning of allEarnings) {
          const amount = Number(earning.amount || 0);
          const monthKey = format(new Date(earning.created_at), 'yyyy-MM');

          if (earning.earning_type === 'subagent_commission') {
            // Sub-agent commission is always an earning from the sub-agent
            // team, even if we cannot map the tenant to a current rent request.
            totalEarnings += amount;

            // Try to attribute it to the specific sub-agent whose tenant made
            // the repayment.
            for (const subAgentId of subAgentIds) {
              const tenants = tenantsData[subAgentId] || [];
              const isTenantOfSubAgent = tenants.some(t => t.id === earning.source_user_id);
              if (isTenantOfSubAgent) {
                earningsPerSubAgent[subAgentId] = (earningsPerSubAgent[subAgentId] || 0) + amount;
                monthlyEarningsPerSubAgent[subAgentId] = monthlyEarningsPerSubAgent[subAgentId] || {};
                monthlyEarningsPerSubAgent[subAgentId][monthKey] =
                  (monthlyEarningsPerSubAgent[subAgentId][monthKey] || 0) + amount;
                break;
              }
            }
          } else if (
            earning.earning_type === 'referral_bonus' &&
            earning.source_user_id &&
            subAgentIdsSet.has(earning.source_user_id)
          ) {
            // Referral bonus earned because this parent referred a user who
            // became one of their sub-agents.
            const subAgentId = earning.source_user_id;
            totalEarnings += amount;
            earningsPerSubAgent[subAgentId] = (earningsPerSubAgent[subAgentId] || 0) + amount;
            monthlyEarningsPerSubAgent[subAgentId] = monthlyEarningsPerSubAgent[subAgentId] || {};
            monthlyEarningsPerSubAgent[subAgentId][monthKey] =
              (monthlyEarningsPerSubAgent[subAgentId][monthKey] || 0) + amount;
          }
        }
      }

      // Add recruiter override earnings (e.g. UGX 2,000 when a sub-agent's
      // house listing / landlord / LC1 chairperson is verified).
      (overrideRows || []).forEach(o => {
        if (!o.status || (o.status !== 'credited' && o.status !== 'paid')) return;
        const amt = Number(o.amount || 0);
        totalEarnings += amt;
        if (o.sub_agent_id) {
          earningsPerSubAgent[o.sub_agent_id] = (earningsPerSubAgent[o.sub_agent_id] || 0) + amt;
          const monthKey = format(new Date(o.occurred_at), 'yyyy-MM');
          monthlyEarningsPerSubAgent[o.sub_agent_id] = monthlyEarningsPerSubAgent[o.sub_agent_id] || {};
          monthlyEarningsPerSubAgent[o.sub_agent_id][monthKey] =
            (monthlyEarningsPerSubAgent[o.sub_agent_id][monthKey] || 0) + amt;
        }
      });

      // Pre-compute aggregates from batched queries
      const platformRewardsPerSubAgent: Record<string, number> = {};
      (ownEarnings || []).forEach(e => {
        const id = e.agent_id as string;
        platformRewardsPerSubAgent[id] = (platformRewardsPerSubAgent[id] || 0) + Number(e.amount || 0);
      });

      const accessedFundsPerSubAgent: Record<string, number> = {};
      (advances || []).forEach(a => {
        const id = a.agent_id as string;
        accessedFundsPerSubAgent[id] = (accessedFundsPerSubAgent[id] || 0) + Number(a.principal || 0);
      });

      // Build enriched sub-agents data
      const enrichedSubAgents: SubAgent[] = subAgentsData.map(sa => {
        const monthlyEarnings = Object.entries(monthlyEarningsPerSubAgent[sa.sub_agent_id] || {})
          .map(([month, amount]) => ({ month, amount }))
          .sort((a, b) => a.month.localeCompare(b.month));

        return {
          ...sa,
          profile: (() => {
            const p = profiles?.find(pr => pr.id === sa.sub_agent_id);
            if (!p) return undefined;
            return {
              full_name: p.full_name,
              phone: p.phone,
              avatar_url: p.avatar_url,
              email: p.email,
              national_id: p.national_id,
              district: p.district,
              region: p.region,
              occupation: p.occupation,
              joined_at: p.created_at,
            };
          })(),
          wallet: (() => {
            const w = wallets?.find(wt => wt.user_id === sa.sub_agent_id);
            if (!w) return undefined;
            return {
              balance: Number(w.balance || 0),
              withdrawable_balance: Number(w.withdrawable_balance || 0),
              float_balance: Number(w.float_balance || 0),
              advance_balance: Number(w.advance_balance || 0),
              locked_balance: Number(w.locked_balance || 0),
            };
          })(),
          totalEarnings: earningsPerSubAgent[sa.sub_agent_id] || 0,
          tenantsCount: tenantsData[sa.sub_agent_id]?.length || 0,
          monthlyEarnings,
          tenants: tenantsData[sa.sub_agent_id] || [],
          facilitatedRentVolume: rentVolumePerSubAgent[sa.sub_agent_id] || 0,
          accessedFunds: accessedFundsPerSubAgent[sa.sub_agent_id] || 0,
          platformRewards: platformRewardsPerSubAgent[sa.sub_agent_id] || 0,
          serviceFees: serviceFeesPerSubAgent[sa.sub_agent_id] || 0,
          houses: housesBySubAgent[sa.sub_agent_id] || [],
          houseOverrideEarnings: houseOverrideBySubAgent[sa.sub_agent_id] || 0,
          hasOtherParent: otherParentSet.has(sa.sub_agent_id),
        };
      });

      // Filter out sub-agents whose auth/profile has been deleted so the UI
      // never shows "Unknown" placeholder cards with stale zeroed data.
      const liveSubAgents = enrichedSubAgents.filter(sa => {
        const name = sa.profile?.full_name?.trim() || '';
        return !!sa.profile && name.length > 0 && name.toLowerCase() !== 'unknown';
      });
      setSubAgents(liveSubAgents);
      setTotalEarningsFromSubAgents(totalEarnings);

      // Build monthly overview data (last 6 months)
      const currentMonthKey = format(new Date(), 'yyyy-MM');
      const last6Months: MonthlyData[] = [];
      let thisMonthRegs = 0;
      let thisMonthEarnings = 0;

      for (let i = 5; i >= 0; i--) {
        const monthDate = subMonths(new Date(), i);
        const monthKey = format(monthDate, 'yyyy-MM');
        const monthLabel = format(monthDate, 'MMM');

        // Chart aggregates EVERY earning the parent booked in the month
        // (subagent commission, referral bonus, proxy investment commission,
        // platform rewards, etc.) so the bars reflect real cash flow.
        const agentEarningsMonth = (chartEarningsRaw || [])
          .filter(e => e.created_at && format(new Date(e.created_at), 'yyyy-MM') === monthKey)
          .reduce((sum, e) => sum + Number(e.amount || 0), 0);

        const overrideMonth = (chartOverridesRaw || [])
          .filter(o => o.occurred_at && format(new Date(o.occurred_at), 'yyyy-MM') === monthKey)
          .reduce((sum, o) => sum + Number(o.amount || 0), 0);

        const monthEarnings = agentEarningsMonth + overrideMonth;

        const subAgentsJoined = subAgentsData.filter(sa => 
          format(new Date(sa.created_at), 'yyyy-MM') === monthKey
        ).length;

        if (monthKey === currentMonthKey) {
          thisMonthRegs = subAgentsJoined;
          thisMonthEarnings = monthEarnings;
        }

        last6Months.push({
          month: monthLabel,
          earnings: monthEarnings,
          subAgentsJoined,
        });
      }
      setMonthlyData(last6Months);

    } catch (error) {
      console.error('Error fetching sub-agent analytics:', error);
    } finally {
      if (!opts?.silent) setLoading(false);
    }
  };

    const handleResendInvite = async (subAgent: SubAgent) => {
    setResendingId(subAgent.sub_agent_id);
    try {
      const { error } = await invokeEdgeFunction('add-existing-subagent', {
        body: { subAgentId: subAgent.sub_agent_id, origin: getPublicOrigin() },
        errorTitle: 'Resend failed',
        fallbackMessage: 'Could not resend the invite. Please try again.',
      });
      if (error) return;
      toast({
        title: 'Invite resent',
        description: `A fresh SMS invite was sent to ${subAgent.profile?.full_name || 'the user'}.`,
      });
      fetchSubAgentAnalytics();
    } finally {
      setResendingId(null);
    }
  };

  const handleExportCSV = () => {
    if (subAgents.length === 0) {
      toast({ title: 'No data to export', variant: 'destructive' });
      return;
    }

    const headers = [
      'Sub-Agent Name',
      'Phone',
      'Joined Date',
      'Total Tenants',
      'Your 2% Earnings (UGX)',
    ];

    const rows = subAgents.map(sa => [
      sa.profile?.full_name || 'Unknown',
      sa.profile?.phone || '',
      formatDateForExport(sa.created_at),
      sa.tenantsCount,
      sa.totalEarnings,
    ]);

    // Add summary row
    rows.push([
      'TOTAL',
      '',
      '',
      subAgents.reduce((sum, sa) => sum + sa.tenantsCount, 0),
      totalEarningsFromSubAgents,
    ]);

    exportToCSV({ headers, rows }, 'sub_agent_performance_report');
    toast({ title: '✅ CSV exported successfully!' });
  };

  const handleExportDetailedCSV = () => {
    if (subAgents.length === 0) {
      toast({ title: 'No data to export', variant: 'destructive' });
      return;
    }

    const headers = [
      'Sub-Agent Name',
      'Tenant Name',
      'Total Repaid by Tenant (UGX)',
      'Your 2% Share (UGX)',
    ];

    const rows: (string | number)[][] = [];

    subAgents.forEach(sa => {
      if (sa.tenants.length > 0) {
        sa.tenants.forEach(tenant => {
          rows.push([
            sa.profile?.full_name || 'Unknown',
            tenant.name,
            tenant.totalRepaid,
            Math.round(tenant.totalRepaid * 0.01),
          ]);
        });
      } else {
        rows.push([
          sa.profile?.full_name || 'Unknown',
          'No tenants yet',
          0,
          0,
        ]);
      }
    });

    exportToCSV({ headers, rows }, 'sub_agent_tenant_breakdown');
    toast({ title: '✅ Detailed CSV exported successfully!' });
  };

  const handleExportPDF = async () => {
    if (!reportRef.current || subAgents.length === 0) {
      toast({ title: 'No data to export', variant: 'destructive' });
      return;
    }

    setExporting(true);
    try {
      await exportToPDF(
        reportRef.current,
        'sub_agent_performance_report',
        'Sub-Agent Performance Report'
      );
      toast({ title: '✅ PDF exported successfully!' });
    } catch (error) {
      console.error('PDF export failed:', error);
      toast({ 
        title: 'Export failed', 
        description: 'Try using CSV export instead',
        variant: 'destructive' 
      });
    } finally {
      setExporting(false);
    }
  };

  // Filtered & sorted sub-agents
  const filteredSubAgents = useMemo(() => {
    let result = subAgents;
    const q = subAgentSearch.trim().toLowerCase();
    if (q) {
      result = result.filter(sa =>
        (sa.profile?.full_name?.toLowerCase().includes(q)) ||
        (sa.profile?.phone?.toLowerCase().includes(q))
      );
    }
    if (subAgentStatusFilter === 'with_tenants') {
      result = result.filter(sa => sa.tenantsCount > 0);
    } else if (subAgentStatusFilter === 'no_tenants') {
      result = result.filter(sa => sa.tenantsCount === 0);
    }

    // Invite status filter
    if (inviteStatusFilter === 'accepted') {
      result = result.filter(sa => sa.status === 'verified' || !!sa.accepted_at);
    } else if (inviteStatusFilter === 'pending') {
      result = result.filter(
        sa => (sa.status === 'pending' || sa.status === 'pending_acceptance') && !sa.accepted_at,
      );
    } else if (inviteStatusFilter === 'expired') {
      result = result.filter(sa => sa.status === 'expired');
    } else if (inviteStatusFilter === 'declined') {
      result = result.filter(sa => sa.status === 'rejected');
    } else if (inviteStatusFilter === 'switched') {
      result = result.filter(sa => sa.hasOtherParent);
    }

    // Sort
    const sorted = [...result];
    if (subAgentSort === 'newest') {
      sorted.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
    } else if (subAgentSort === 'name_asc') {
      sorted.sort((a, b) => (a.profile?.full_name || '').localeCompare(b.profile?.full_name || '', undefined, { sensitivity: 'base' }));
    } else if (subAgentSort === 'withdrawable_desc') {
      sorted.sort((a, b) => (b.wallet?.withdrawable_balance || 0) - (a.wallet?.withdrawable_balance || 0));
    }
    return sorted;
  }, [subAgents, subAgentSearch, subAgentStatusFilter, inviteStatusFilter, subAgentSort]);

  // Filtered tenants (inside detail modal)
  const filteredTenants = useMemo(() => {
    if (!selectedSubAgent) return [];
    const q = tenantSearch.trim().toLowerCase();
    if (!q) return selectedSubAgent.tenants;
    return selectedSubAgent.tenants.filter(t =>
      t.name.toLowerCase().includes(q) ||
      (t.phone?.toLowerCase().includes(q) ?? false)
    );
  }, [selectedSubAgent, tenantSearch]);

  if (authLoading || loading) {
    return (
      <ScreenLoader />
    );
  }

  const pieData = subAgents.map((sa, idx) => ({
    name: sa.profile?.full_name?.split(' ')[0] || 'Unknown',
    value: sa.totalEarnings,
    color: COLORS[idx % COLORS.length],
  })).filter(d => d.value > 0 && d.name !== 'Unknown');

  return (
    <div className="min-h-screen bg-background pb-[calc(6rem+_env(safe-area-inset-bottom,0px))]">
      {/* Header */}
      <div className="sticky top-0 z-10 bg-background/80 backdrop-blur-xl border-b border-border/60">
        <div className="flex items-center gap-2 px-3 py-2.5">
          <Button variant="ghost" size="icon" className="h-9 w-9 shrink-0" onClick={() => navigate(-1)}>
            <ArrowLeft className="h-5 w-5" />
          </Button>
          <div className="flex-1 min-w-0">
            <h1 className="font-semibold text-base tracking-tight truncate">Sub-Agents</h1>
            <p className="text-[11px] text-muted-foreground truncate">Your team performance</p>
          </div>

          {subAgents.length > 0 && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon" className="h-9 w-9 shrink-0" disabled={exporting}>
                  {exporting ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Download className="h-[18px] w-[18px]" />
                  )}
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-48">
                <DropdownMenuItem onClick={handleExportCSV} className="gap-2">
                  <FileSpreadsheet className="h-4 w-4 text-green-600" />
                  Summary CSV
                </DropdownMenuItem>
                <DropdownMenuItem onClick={handleExportDetailedCSV} className="gap-2">
                  <FileSpreadsheet className="h-4 w-4 text-blue-600" />
                  Detailed CSV (Tenants)
                </DropdownMenuItem>
                <DropdownMenuItem onClick={handleExportPDF} className="gap-2">
                  <FileText className="h-4 w-4 text-red-600" />
                  PDF Report
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )}

          <Button
            onClick={() => { hapticTap(); setInviteSheetOpen(true); }}
            size="sm"
            className="h-9 gap-1.5 rounded-full bg-orange-500 hover:bg-orange-600 text-white shrink-0"
          >
            <UserPlus className="h-4 w-4" />
            <span className="font-medium">Invite</span>
          </Button>
        </div>
      </div>

      <main className="px-3 py-4 space-y-4">
        {subAgents.length === 0 ? (
          <Card className="border-dashed border-border/60 shadow-none">
            <CardContent className="p-8 text-center">
              <div className="mx-auto w-16 h-16 rounded-full bg-orange-500/10 flex items-center justify-center mb-4">
                <Users className="h-8 w-8 text-orange-500" />
              </div>
              <h3 className="font-semibold text-lg mb-2">No Sub-Agents Yet</h3>
              <p className="text-muted-foreground text-sm mb-4">
                Build your team by registering sub-agents. You'll earn 2% of all their tenants' repayments!
              </p>
              <Button onClick={() => setInviteSheetOpen(true)} className="gap-2">
                <UserPlus className="h-4 w-4" />
                Invite Your First Sub-Agent
              </Button>
            </CardContent>
          </Card>
        ) : (
          <div ref={reportRef} className="space-y-4">
            {/* Overview Stats */}
            <div id="subagent-overview" className="scroll-mt-28">
              <div className="grid grid-cols-3 gap-2">
                <Card className="border-border/60 shadow-none">
                  <CardContent className="p-2.5 sm:p-3.5">
                    <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-orange-500/10 mb-2">
                      <Users className="h-4 w-4 text-orange-500" />
                    </div>
                    <p className="font-semibold text-lg sm:text-xl tracking-tight leading-none">{subAgents.length}</p>
                    <p className="text-[10px] sm:text-[11px] text-muted-foreground mt-1.5">Sub-Agents</p>
                  </CardContent>
                </Card>
                <Card className="border-border/60 shadow-none">
                  <CardContent className="p-2.5 sm:p-3.5">
                    <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-success/10 mb-2">
                      <Coins className="h-4 w-4 text-success" />
                    </div>
                    <p className="font-semibold text-[13px] sm:text-base tracking-tight leading-tight break-words">{formatUGX(totalEarningsFromSubAgents)}</p>
                    <p className="text-[10px] sm:text-[11px] text-muted-foreground mt-1.5">Total Earned</p>
                  </CardContent>
                </Card>
                <Card className="border-border/60 shadow-none">
                  <CardContent className="p-2.5 sm:p-3.5">
                    <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-primary/10 mb-2">
                      <Target className="h-4 w-4 text-primary" />
                    </div>
                    <p className="font-semibold text-lg sm:text-xl tracking-tight leading-none">
                      {subAgents.reduce((sum, sa) => sum + sa.tenantsCount, 0)}
                    </p>
                    <p className="text-[10px] sm:text-[11px] text-muted-foreground mt-1.5">Team Tenants</p>
                  </CardContent>
                </Card>
              </div>
            </div>

            {/* Monthly Earnings Chart */}
            <Card className="border-border/60 shadow-none">
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-semibold flex items-center gap-2">
                  <BarChart3 className="h-4 w-4 text-success" />
                  Monthly Earnings
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="h-48">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={monthlyData}>
                      <CartesianGrid strokeDasharray="3 3" className="opacity-30" />
                      <XAxis dataKey="month" tick={{ fontSize: 12 }} />
                      <YAxis
                        tick={{ fontSize: 10 }}
                        tickFormatter={(v) =>
                          v >= 1000 ? `${(v / 1000).toFixed(v % 1000 === 0 ? 0 : 1)}K` : `${v}`
                        }
                        allowDecimals={false}
                      />
                      <Tooltip 
                        formatter={(value: number) => [formatUGX(value), 'Earnings']}
                        contentStyle={{ 
                          backgroundColor: 'hsl(var(--background))',
                          border: '1px solid hsl(var(--border))',
                          borderRadius: '8px'
                        }}
                      />
                      <Bar dataKey="earnings" fill="hsl(var(--success))" radius={[4, 4, 0, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              </CardContent>
            </Card>

            {/* Earnings Distribution Pie Chart */}
            {pieData.length > 0 && (
              <Card className="border-border/60 shadow-none">
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm font-semibold flex items-center gap-2">
                    <TrendingUp className="h-4 w-4 text-orange-500" />
                    Earnings by Sub-Agent
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="h-48 flex items-center">
                    <div className="w-1/2 h-full">
                      <ResponsiveContainer width="100%" height="100%">
                        <PieChart>
                          <Pie
                            data={pieData}
                            cx="50%"
                            cy="50%"
                            innerRadius={40}
                            outerRadius={70}
                            paddingAngle={2}
                            dataKey="value"
                          >
                            {pieData.map((entry, index) => (
                              <Cell key={`cell-${index}`} fill={entry.color} />
                            ))}
                          </Pie>
                          <Tooltip 
                            formatter={(value: number) => formatUGX(value)}
                            contentStyle={{ 
                              backgroundColor: 'hsl(var(--background))',
                              border: '1px solid hsl(var(--border))',
                              borderRadius: '8px'
                            }}
                          />
                        </PieChart>
                      </ResponsiveContainer>
                    </div>
                    <div className="w-1/2 space-y-2">
                      {pieData.slice(0, 4).map((entry, idx) => (
                        <div key={idx} className="flex items-center gap-2 text-sm">
                          <div 
                            className="w-3 h-3 rounded-full" 
                            style={{ backgroundColor: entry.color }}
                          />
                          <span className="truncate flex-1">{entry.name}</span>
                          <span className="font-medium text-xs">{formatUGX(entry.value)}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                </CardContent>
              </Card>
            )}

            {/* Invite Banner — always visible to encourage growth */}
            <div 
              id="subagent-invite"
              onClick={() => { hapticTap(); setInviteSheetOpen(true); }}
              className="scroll-mt-28 relative overflow-hidden rounded-2xl border border-orange-500/15 bg-orange-500/[0.06] p-4 cursor-pointer active:scale-[0.99] transition-transform"
            >
              <div className="flex items-start gap-3">
                <div className="mt-0.5 p-2 rounded-xl bg-orange-500/10 shrink-0">
                  <Sparkles className="h-5 w-5 text-orange-500" />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="font-semibold text-sm">Grow Your Team</p>
                  <p className="text-xs text-muted-foreground mt-0.5 leading-relaxed">
                    Invite more sub-agents and earn <span className="font-semibold text-orange-500">2%</span> from every tenant they register. More agents = more passive income.
                  </p>
                </div>
                <div className="shrink-0 self-center">
                  <div className="flex items-center justify-center h-9 w-9 rounded-full bg-orange-500 text-white">
                    <Plus className="h-5 w-5" />
                  </div>
                </div>
              </div>
            </div>

            {/* Sub-Agents List */}
            <Card id="subagent-team" className="scroll-mt-28 border-border/60 shadow-none">
              <CardHeader className="pb-2">
                <div className="flex items-center justify-between">
                  <CardTitle className="text-sm font-semibold flex items-center gap-2">
                    <Users className="h-4 w-4 text-orange-500" />
                    Your Sub-Agents
                  </CardTitle>
                  <Badge variant="secondary" className="text-xs">
                    {filteredSubAgents.length} of {subAgents.length}
                  </Badge>
                </div>
              </CardHeader>
              <CardContent className="space-y-3">
                {/* Search & filter bar */}
                <div className="space-y-2">
                  <div className="relative">
                    <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground pointer-events-none" />
                    <Input
                      placeholder="Search by name or phone..."
                      value={subAgentSearch}
                      onChange={(e) => setSubAgentSearch(e.target.value)}
                      className="pl-9 pr-9 h-10"
                    />
                    {subAgentSearch && (
                      <button
                        onClick={() => setSubAgentSearch('')}
                        className="absolute right-3 top-1/2 -translate-y-1/2"
                      >
                        <X className="h-4 w-4 text-muted-foreground" />
                      </button>
                    )}
                  </div>
                  <div className="flex items-center gap-2 overflow-x-auto pb-1">
                    <Button
                      size="sm"
                      variant={subAgentStatusFilter === 'all' ? 'default' : 'outline'}
                      onClick={() => setSubAgentStatusFilter('all')}
                      className="text-xs shrink-0 h-8"
                    >
                      All
                    </Button>
                    <Button
                      size="sm"
                      variant={subAgentStatusFilter === 'with_tenants' ? 'default' : 'outline'}
                      onClick={() => setSubAgentStatusFilter('with_tenants')}
                      className="text-xs shrink-0 h-8"
                    >
                      With Tenants
                    </Button>
                    <Button
                      size="sm"
                      variant={subAgentStatusFilter === 'no_tenants' ? 'default' : 'outline'}
                      onClick={() => setSubAgentStatusFilter('no_tenants')}
                      className="text-xs shrink-0 h-8"
                    >
                      No Tenants
                    </Button>

                    {/* Sort Dropdown */}
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button
                          size="sm"
                          variant="outline"
                          className="text-xs shrink-0 h-8 gap-1 ml-auto"
                        >
                          <ArrowUpDown className="h-3.5 w-3.5" />
                          Sort
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end" className="w-52">
                        <DropdownMenuItem
                          onClick={() => setSubAgentSort('newest')}
                          className={subAgentSort === 'newest' ? 'bg-muted font-medium' : ''}
                        >
                          Newest First
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          onClick={() => setSubAgentSort('name_asc')}
                          className={subAgentSort === 'name_asc' ? 'bg-muted font-medium' : ''}
                        >
                          Name (A–Z)
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          onClick={() => setSubAgentSort('withdrawable_desc')}
                          className={subAgentSort === 'withdrawable_desc' ? 'bg-muted font-medium' : ''}
                        >
                          Highest Withdrawable
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                  {/* Invite status filter chips */}
                  <div className="flex items-center gap-2 overflow-x-auto pb-1">
                    {[
                      { key: 'all', label: 'All Invites' },
                      { key: 'accepted', label: 'Accepted' },
                      { key: 'pending', label: 'Pending' },
                      { key: 'expired', label: 'Expired' },
                      { key: 'declined', label: 'Declined' },
                      { key: 'switched', label: 'Switched' },
                    ].map((opt) => (
                      <Button
                        key={opt.key}
                        size="sm"
                        variant={inviteStatusFilter === (opt.key as any) ? 'default' : 'outline'}
                        onClick={() => setInviteStatusFilter(opt.key as any)}
                        className="text-xs shrink-0 h-8"
                      >
                        {opt.label}
                      </Button>
                    ))}
                  </div>
                </div>

                {filteredSubAgents.length === 0 ? (
                  <div className="text-center py-6">
                    <Search className="h-6 w-6 mx-auto text-muted-foreground mb-2" />
                    <p className="text-sm text-muted-foreground">
                      {subAgentSearch || subAgentStatusFilter !== 'all'
                        ? 'No sub-agents match your search'
                        : 'No sub-agents yet'}
                    </p>
                  </div>
                ) : (
                  <div className="space-y-2">
                    {filteredSubAgents.map((subAgent) => {
                      const accepted = subAgent.status === 'verified' || !!subAgent.accepted_at;
                      const smsStatus = subAgent.invite_sms_status;
                      const timelineOpen = expandedTimelines.has(subAgent.id);
                      const timeline = buildInviteTimeline(subAgent);
                      const openDetail = () => {
                        setSelectedSubAgent(subAgent);
                        const next = new URLSearchParams(searchParams);
                        next.set('id', subAgent.sub_agent_id);
                        setSearchParams(next, { replace: true });
                      };
                      return (
                        <div
                          key={subAgent.id}
                          className="rounded-xl bg-muted/50 hover:bg-muted transition-colors"
                        >
                          <button
                            onClick={openDetail}
                            className="w-full flex items-center justify-between p-3 text-left"
                          >
                            <div className="flex items-center gap-3 min-w-0">
                              <div className="w-10 h-10 rounded-full bg-gradient-to-br from-orange-500 to-amber-500 flex items-center justify-center text-white font-bold shrink-0">
                                {subAgent.profile?.full_name?.charAt(0) || '?'}
                              </div>
                              <div className="min-w-0">
                                <div className="flex items-center gap-2 flex-wrap">
                                  <p className="font-medium text-sm truncate">{subAgent.profile?.full_name || 'Unknown'}</p>
                                  {/* Invite delivery / acceptance status */}
                                  {accepted ? (
                                    <Badge variant="outline" className="gap-1 text-[10px] px-1.5 py-0 h-4 bg-success/10 text-success border-success/20">
                                      <CheckCircle2 className="h-3 w-3" /> Accepted
                                    </Badge>
                                  ) : subAgent.status === 'expired' ? (
                                    <Badge variant="outline" className="gap-1 text-[10px] px-1.5 py-0 h-4 bg-destructive/10 text-destructive border-destructive/20">
                                      <Clock className="h-3 w-3" /> Expired
                                    </Badge>
                                  ) : smsStatus === 'failed' ? (
                                    <Badge variant="outline" className="gap-1 text-[10px] px-1.5 py-0 h-4 bg-destructive/10 text-destructive border-destructive/20">
                                      <AlertCircle className="h-3 w-3" /> Failed
                                    </Badge>
                                  ) : smsStatus === 'sent' ? (
                                    <Badge variant="outline" className="gap-1 text-[10px] px-1.5 py-0 h-4 bg-blue-500/10 text-blue-600 border-blue-500/20">
                                      <Send className="h-3 w-3" /> Sent
                                    </Badge>
                                  ) : (
                                    <Badge variant="outline" className="gap-1 text-[10px] px-1.5 py-0 h-4 bg-warning/10 text-warning border-warning/20">
                                      <Clock className="h-3 w-3" /> Pending
                                    </Badge>
                                  )}
                                  {subAgent.hasOtherParent && (
                                    <Badge variant="outline" className="gap-1 text-[10px] px-1.5 py-0 h-4 bg-purple-500/10 text-purple-600 border-purple-500/20">
                                      <ArrowLeft className="h-3 w-3" /> Switched
                                    </Badge>
                                  )}
                                </div>
                                <p className="text-xs text-muted-foreground flex items-center gap-2">
                                  <span>{subAgent.tenantsCount} tenant{subAgent.tenantsCount !== 1 ? 's' : ''}</span>
                                  <span className="hidden sm:inline">•</span>
                                  <span className="hidden sm:inline">Joined {format(new Date(subAgent.created_at), 'MMM d, yyyy')}</span>
                                </p>
                              </div>
                            </div>
                            <div className="text-right flex items-center gap-2 shrink-0">
                              <div>
                                <p className="font-bold text-sm text-success">{formatUGX(subAgent.totalEarnings)}</p>
                                <p className="text-[10px] text-muted-foreground">your 2%</p>
                              </div>
                              <ChevronRight className="h-4 w-4 text-muted-foreground" />
                            </div>
                          </button>
                          {/* Row actions: invite history toggle + resend */}
                          <div className="px-3 pb-3 -mt-1 flex flex-wrap items-center gap-2">
                            <Button
                              variant="ghost"
                              size="sm"
                              className="h-8 gap-1.5 text-xs"
                              onClick={() => { hapticTap(); toggleTimeline(subAgent.id); }}
                            >
                              <History className="h-3.5 w-3.5" />
                              Invite history
                              <ChevronDown className={`h-3.5 w-3.5 transition-transform ${timelineOpen ? 'rotate-180' : ''}`} />
                            </Button>
                            {!accepted && (
                              <Button
                                variant="outline"
                                size="sm"
                                className="h-8 gap-1.5 text-xs"
                                disabled={resendingId === subAgent.sub_agent_id}
                                onClick={() => { hapticTap(); handleResendInvite(subAgent); }}
                              >
                                {resendingId === subAgent.sub_agent_id ? (
                                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                ) : (
                                  <Send className="h-3.5 w-3.5" />
                                )}
                                {smsStatus === 'failed' ? 'Retry invite SMS' : 'Resend invite'}
                              </Button>
                            )}
                          </div>
                          {/* Expandable invite timeline */}
                          {timelineOpen && (
                            <div className="px-3 pb-3 -mt-1">
                              <div className="rounded-lg border bg-background/60 p-3">
                                <div className="flex items-center justify-between mb-2">
                                  <p className="text-xs font-semibold text-muted-foreground">Invite timeline</p>
                                  {subAgent.invite_sent_at && (
                                    <p className="text-[10px] text-muted-foreground">
                                      Last sent {format(new Date(subAgent.invite_sent_at), 'MMM d, h:mm a')}
                                    </p>
                                  )}
                                </div>
                                <ol className="relative space-y-3">
                                  {timeline.map((ev, idx) => {
                                    const Icon = ev.icon;
                                    const isLast = idx === timeline.length - 1;
                                    return (
                                      <li key={ev.key} className="flex gap-3">
                                        <div className="flex flex-col items-center">
                                          <span className={`flex h-6 w-6 items-center justify-center rounded-full ${TIMELINE_TONE[ev.tone]}`}>
                                            <Icon className="h-3.5 w-3.5" />
                                          </span>
                                          {!isLast && <span className="w-px flex-1 bg-border mt-1" />}
                                        </div>
                                        <div className="pb-1 min-w-0">
                                          <p className="text-xs font-medium leading-tight">{ev.label}</p>
                                          {ev.detail && (
                                            <p className="text-[10px] text-muted-foreground capitalize">{ev.detail}</p>
                                          )}
                                          <p className="text-[10px] text-muted-foreground">
                                            {ev.at ? format(new Date(ev.at), 'MMM d, yyyy • h:mm a') : 'Time not recorded'}
                                          </p>
                                        </div>
                                      </li>
                                    );
                                  })}
                                </ol>
                              </div>
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </CardContent>
            </Card>

            {/* Sub-agent status & recruiter override earnings board */}
            <SubAgentStatusBoard />

            {/* Payout audit: earning leg ↔ withdrawable wallet credit */}
            <SubAgentPayoutAudit />
          </div>
        )}
      </main>

      {/* Mobile bottom navigation */}
      {subAgents.length > 0 && (
        <SubAgentBottomNav
          active={activeSection}
          onNavigate={scrollToSection}
          onInvite={() => setInviteSheetOpen(true)}
        />
      )}

      {/* Sub-Agent Detail Modal */}
      {selectedSubAgent && (
        <div 
          className="fixed inset-0 z-50 bg-background/80 backdrop-blur-sm"
          onClick={closeDetail}
        >
          <div
            ref={detailScrollRef}
            className="fixed bottom-0 left-0 right-0 bg-background border-t rounded-t-3xl max-h-[85vh] overflow-y-auto overscroll-y-contain"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Pull-to-refresh indicator */}
            <div
              className="flex justify-center items-center transition-all duration-200 pointer-events-none"
              style={{
                height: `${Math.max(0, visualPullProgress * 50)}px`,
                opacity: visualPullProgress > 0.1 ? 1 : 0,
              }}
            >
              {isRefreshing ? (
                <Loader2 className="h-5 w-5 animate-spin text-primary" />
              ) : (
                <RefreshCw
                  className="h-5 w-5 text-muted-foreground transition-transform"
                  style={{ transform: `rotate(${visualPullProgress * 180}deg)` }}
                />
              )}
            </div>
            <div className="sticky top-0 bg-background p-4 border-b">
              <div className="w-12 h-1 bg-muted-foreground/30 rounded-full mx-auto mb-3" />
              <div className="flex items-center gap-3">
                <div className="w-12 h-12 rounded-full bg-gradient-to-br from-orange-500 to-amber-500 flex items-center justify-center text-white font-bold text-lg">
                  {selectedSubAgent.profile?.full_name?.charAt(0) || '?'}
                </div>
                <div className="flex-1">
                  <h3 className="font-bold text-lg">{selectedSubAgent.profile?.full_name}</h3>
                  <p className="text-sm text-muted-foreground">{selectedSubAgent.profile?.phone}</p>
                </div>
                <Button variant="ghost" size="sm" onClick={closeDetail}>
                  Close
                </Button>
              </div>
            </div>

            <div className="p-4 space-y-4">
              {/* Quick contact actions */}
              <div className="grid grid-cols-3 gap-3">
                <a
                  href={selectedSubAgent.profile?.phone ? `tel:${selectedSubAgent.profile.phone}` : undefined}
                  className={`flex items-center justify-center gap-2 rounded-xl py-3 text-sm font-medium border transition-colors ${
                    selectedSubAgent.profile?.phone
                      ? 'bg-success/10 text-success border-success/20 active:bg-success/20'
                      : 'bg-muted text-muted-foreground border-border pointer-events-none opacity-60'
                  }`}
                >
                  <Phone className="h-4 w-4" />
                  Call
                </a>
                <a
                  href={selectedSubAgent.profile?.phone ? `https://wa.me/${selectedSubAgent.profile.phone.replace(/[^0-9]/g, '')}` : undefined}
                  target="_blank"
                  rel="noopener noreferrer"
                  className={`flex items-center justify-center gap-2 rounded-xl py-3 text-sm font-medium border transition-colors ${
                    selectedSubAgent.profile?.phone
                      ? 'bg-primary/10 text-primary border-primary/20 active:bg-primary/20'
                      : 'bg-muted text-muted-foreground border-border pointer-events-none opacity-60'
                  }`}
                >
                  <Mail className="h-4 w-4" />
                  WhatsApp
                </a>
                <button
                  type="button"
                  onClick={() => setReleaseConfirmOpen(true)}
                  className="flex items-center justify-center gap-2 rounded-xl py-3 text-sm font-medium border border-destructive/20 bg-destructive/10 text-destructive active:bg-destructive/20 transition-colors"
                >
                  <UserMinus className="h-4 w-4" />
                  Unlink
                </button>
              </div>

              {/* Profile Details */}
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm flex items-center gap-2">
                    <IdCard className="h-4 w-4 text-orange-500" />
                    Profile Details
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-2.5">
                  <div className="flex items-start gap-2 text-sm">
                    <Phone className="h-4 w-4 text-muted-foreground shrink-0 mt-0.5" />
                    <div className="min-w-0">
                      <p className="text-[10px] text-muted-foreground uppercase tracking-wide">Phone</p>
                      <p className="font-medium break-all">{selectedSubAgent.profile?.phone || '—'}</p>
                    </div>
                  </div>
                  <div className="flex items-start gap-2 text-sm">
                    <Mail className="h-4 w-4 text-muted-foreground shrink-0 mt-0.5" />
                    <div className="min-w-0">
                      <p className="text-[10px] text-muted-foreground uppercase tracking-wide">Email</p>
                      <p className="font-medium break-all">{selectedSubAgent.profile?.email || '—'}</p>
                    </div>
                  </div>
                  <div className="flex items-start gap-2 text-sm">
                    <IdCard className="h-4 w-4 text-muted-foreground shrink-0 mt-0.5" />
                    <div className="min-w-0">
                      <p className="text-[10px] text-muted-foreground uppercase tracking-wide">National ID</p>
                      <p className="font-medium break-all">{selectedSubAgent.profile?.national_id || '—'}</p>
                    </div>
                  </div>
                  <div className="flex items-start gap-2 text-sm">
                    <MapPin className="h-4 w-4 text-muted-foreground shrink-0 mt-0.5" />
                    <div className="min-w-0">
                      <p className="text-[10px] text-muted-foreground uppercase tracking-wide">Location</p>
                      <p className="font-medium">
                        {[selectedSubAgent.profile?.district, selectedSubAgent.profile?.region]
                          .filter(Boolean)
                          .join(', ') || '—'}
                      </p>
                    </div>
                  </div>
                  <div className="flex items-start gap-2 text-sm">
                    <Briefcase className="h-4 w-4 text-muted-foreground shrink-0 mt-0.5" />
                    <div className="min-w-0">
                      <p className="text-[10px] text-muted-foreground uppercase tracking-wide">Occupation</p>
                      <p className="font-medium">{selectedSubAgent.profile?.occupation || '—'}</p>
                    </div>
                  </div>
                  <div className="flex items-start gap-2 text-sm">
                    <Calendar className="h-4 w-4 text-muted-foreground shrink-0 mt-0.5" />
                    <div className="min-w-0">
                      <p className="text-[10px] text-muted-foreground uppercase tracking-wide">Joined</p>
                      <p className="font-medium">
                        {selectedSubAgent.profile?.joined_at
                          ? format(new Date(selectedSubAgent.profile.joined_at), 'MMM d, yyyy')
                          : format(new Date(selectedSubAgent.created_at), 'MMM d, yyyy')}
                      </p>
                    </div>
                  </div>
                </CardContent>
              </Card>

              {/* Wallet Details */}
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm flex items-center gap-2">
                    <Wallet className="h-4 w-4 text-success" />
                    Wallet Details
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  {selectedSubAgent.wallet ? (
                    <div className="grid grid-cols-2 gap-3">
                      <div className="bg-success/10 rounded-xl p-3 border border-success/20 col-span-2 text-center">
                        <p className="text-[11px] text-muted-foreground">Withdrawable Balance</p>
                        <p className="font-bold text-success text-xl mt-0.5">
                          {formatUGX(selectedSubAgent.wallet.withdrawable_balance)}
                        </p>
                      </div>
                      <div className="bg-muted/50 rounded-xl p-3 text-center border border-border">
                        <p className="text-[11px] text-muted-foreground">Float Balance</p>
                        <p className="font-bold text-foreground text-base mt-0.5">
                          {formatUGX(selectedSubAgent.wallet.float_balance)}
                        </p>
                      </div>
                      <div className="bg-warning/10 rounded-xl p-3 text-center border border-warning/20">
                        <p className="text-[11px] text-muted-foreground">Advance (owed)</p>
                        <p className="font-bold text-warning text-base mt-0.5">
                          {formatUGX(selectedSubAgent.wallet.advance_balance)}
                        </p>
                      </div>
                    </div>
                  ) : (
                    <p className="text-sm text-muted-foreground text-center py-4">
                      No wallet found for this sub-agent
                    </p>
                  )}
                </CardContent>
              </Card>

              {/* Primary KPI — Parent earnings from this sub-agent */}
              <div className="bg-gradient-to-br from-orange-500/10 to-amber-500/10 border border-orange-500/20 rounded-2xl p-5 text-center">
                <p className="text-xs text-muted-foreground uppercase tracking-wide font-medium">
                  Your Earnings from {selectedSubAgent.profile?.full_name?.split(' ')[0] || 'This Sub-Agent'}
                </p>
                <p className="text-3xl font-bold text-orange-600 mt-1">
                  {formatUGX(selectedSubAgent.totalEarnings)}
                </p>
                <p className="text-[11px] text-muted-foreground mt-1">
                  2% of all collections facilitated
                </p>
              </div>

              {/* KPI Grid */}
              <div className="grid grid-cols-2 gap-3">
                <div className="bg-success/10 rounded-xl p-3 text-center border border-success/20">
                  <p className="text-[11px] text-muted-foreground">Facilitated Rent Volume</p>
                  <p className="font-bold text-success text-base mt-0.5">{formatUGX(selectedSubAgent.facilitatedRentVolume)}</p>
                </div>
                <div className="bg-primary/10 rounded-xl p-3 text-center border border-primary/20">
                  <p className="text-[11px] text-muted-foreground">Accessed Funds</p>
                  <p className="font-bold text-primary text-base mt-0.5">{formatUGX(selectedSubAgent.accessedFunds)}</p>
                </div>
                <div className="bg-warning/10 rounded-xl p-3 text-center border border-warning/20">
                  <p className="text-[11px] text-muted-foreground">Platform Rewards</p>
                  <p className="font-bold text-warning text-base mt-0.5">{formatUGX(selectedSubAgent.platformRewards)}</p>
                </div>
                <div className="bg-muted rounded-xl p-3 text-center border border-border">
                  <p className="text-[11px] text-muted-foreground">Service Fees Generated</p>
                  <p className="font-bold text-foreground text-base mt-0.5">{formatUGX(selectedSubAgent.serviceFees)}</p>
                </div>
              </div>

              {/* Tenants & Joined mini row */}
              <div className="flex items-center justify-between text-sm px-1">
                <div className="flex items-center gap-2">
                  <Users className="h-4 w-4 text-orange-500" />
                  <span className="text-muted-foreground">{selectedSubAgent.tenantsCount} tenant{selectedSubAgent.tenantsCount !== 1 ? 's' : ''}</span>
                </div>
                <span className="text-muted-foreground text-xs">
                  Joined {format(new Date(selectedSubAgent.created_at), 'MMM yyyy')}
                </span>
              </div>

              {/* Recruiter-split breakdown (8% sub-agent vs 2% recruiter) */}
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm flex items-center gap-2">
                    <Coins className="h-4 w-4 text-orange-500" />
                    Recruiter Split Breakdown
                  </CardTitle>
                  <p className="text-[11px] text-muted-foreground">
                    Sub-agent keeps 8% · you earn 2% on each rent allocation
                  </p>
                </CardHeader>
                <CardContent>
                  {splitsLoading ? (
                    <div className="flex justify-center py-6">
                      <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
                    </div>
                  ) : recruiterSplits.length === 0 ? (
                    <p className="text-sm text-muted-foreground text-center py-4">
                      No rent allocations yet
                    </p>
                  ) : (
                    <>
                      {/* Totals */}
                      <div className="grid grid-cols-3 gap-2 mb-3">
                        <div className="bg-muted/50 rounded-lg p-2 text-center">
                          <p className="text-[10px] text-muted-foreground">Allocated</p>
                          <p className="text-xs font-bold">
                            {formatUGX(recruiterSplits.reduce((s, r) => s + Number(r.amount), 0))}
                          </p>
                        </div>
                        <div className="bg-primary/10 rounded-lg p-2 text-center border border-primary/20">
                          <p className="text-[10px] text-muted-foreground">Sub-agent 8%</p>
                          <p className="text-xs font-bold text-primary">
                            {formatUGX(recruiterSplits.reduce((s, r) => s + Number(r.subagent_share), 0))}
                          </p>
                        </div>
                        <div className="bg-orange-500/10 rounded-lg p-2 text-center border border-orange-500/20">
                          <p className="text-[10px] text-muted-foreground">Your 2%</p>
                          <p className="text-xs font-bold text-orange-600">
                            {formatUGX(recruiterSplits.reduce((s, r) => s + Number(r.recruiter_override), 0))}
                          </p>
                        </div>
                      </div>

                      {/* Per-transaction rows */}
                      <div className="space-y-2">
                        {recruiterSplits.map((r) => (
                          <div key={r.trace_id} className="rounded-lg border border-border p-2.5">
                            <div className="flex items-center justify-between mb-1.5">
                              <div className="min-w-0">
                                <p className="text-xs font-medium truncate">{r.tenant_name}</p>
                                <p className="text-[10px] text-muted-foreground">
                                  {format(new Date(r.created_at), 'dd MMM yyyy · HH:mm')}
                                  {r.tracking_id ? ` · ${r.tracking_id}` : ''}
                                </p>
                              </div>
                              <span className="text-xs font-semibold shrink-0 ml-2">
                                {formatUGX(Number(r.amount))}
                              </span>
                            </div>
                            <div className="flex items-center gap-2">
                              <div className="flex-1 bg-primary/10 rounded-md px-2 py-1 text-center">
                                <span className="text-[10px] text-muted-foreground">8% </span>
                                <span className="text-xs font-semibold text-primary">
                                  {formatUGX(Number(r.subagent_share))}
                                </span>
                              </div>
                              <div className="flex-1 bg-orange-500/10 rounded-md px-2 py-1 text-center">
                                <span className="text-[10px] text-muted-foreground">2% </span>
                                <span className="text-xs font-semibold text-orange-600">
                                  {formatUGX(Number(r.recruiter_override))}
                                </span>
                              </div>
                            </div>
                          </div>
                        ))}
                      </div>
                    </>
                  )}
                </CardContent>
              </Card>

              {/* Monthly Earnings Chart */}
              {selectedSubAgent.monthlyEarnings.length > 0 && (
                <Card>
                  <CardHeader className="pb-2">
                    <CardTitle className="text-sm">Monthly Earnings History</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <div className="h-32">
                      <ResponsiveContainer width="100%" height="100%">
                        <LineChart data={selectedSubAgent.monthlyEarnings}>
                          <XAxis 
                            dataKey="month" 
                            tick={{ fontSize: 10 }}
                            tickFormatter={(v) => format(new Date(v + '-01'), 'MMM')}
                          />
                          <YAxis tick={{ fontSize: 10 }} tickFormatter={(v) => `${(v / 1000).toFixed(0)}K`} />
                          <Tooltip 
                            formatter={(value: number) => [formatUGX(value), 'Your Earnings']}
                            labelFormatter={(label) => format(new Date(label + '-01'), 'MMMM yyyy')}
                            contentStyle={{ 
                              backgroundColor: 'hsl(var(--background))',
                              border: '1px solid hsl(var(--border))',
                              borderRadius: '8px'
                            }}
                          />
                          <Line 
                            type="monotone" 
                            dataKey="amount" 
                            stroke="hsl(var(--success))" 
                            strokeWidth={2}
                            dot={{ fill: 'hsl(var(--success))' }}
                          />
                        </LineChart>
                      </ResponsiveContainer>
                    </div>
                  </CardContent>
                </Card>
              )}

              {/* Tenants List */}
              <Card>
                <CardHeader className="pb-2 space-y-2">
                  <div className="flex items-center justify-between">
                    <CardTitle className="text-sm">Tenants ({filteredTenants.length})</CardTitle>
                  </div>
                  {selectedSubAgent.tenants.length > 0 && (
                    <div className="relative">
                      <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground pointer-events-none" />
                      <Input
                        placeholder="Find tenant by name or phone..."
                        value={tenantSearch}
                        onChange={(e) => setTenantSearch(e.target.value)}
                        className="pl-9 pr-9 h-9 text-sm"
                      />
                      {tenantSearch && (
                        <button
                          onClick={() => setTenantSearch('')}
                          className="absolute right-3 top-1/2 -translate-y-1/2"
                        >
                          <X className="h-4 w-4 text-muted-foreground" />
                        </button>
                      )}
                    </div>
                  )}
                </CardHeader>
                <CardContent>
                  {selectedSubAgent.tenants.length === 0 ? (
                    <p className="text-sm text-muted-foreground text-center py-4">
                      No tenants registered yet
                    </p>
                  ) : filteredTenants.length === 0 ? (
                    <div className="text-center py-6">
                      <Search className="h-6 w-6 mx-auto text-muted-foreground mb-2" />
                      <p className="text-sm text-muted-foreground">No tenants match your search</p>
                    </div>
                  ) : (
                    <div className="space-y-2">
                      {filteredTenants.map((tenant) => (
                        <div key={tenant.id} className="flex items-center justify-between gap-2 p-2.5 bg-muted/50 rounded-lg">
                          <div className="min-w-0">
                            <p className="text-sm font-medium truncate">{tenant.name}</p>
                            {tenant.phone ? (
                              <a
                                href={`tel:${tenant.phone}`}
                                className="inline-flex items-center gap-1 text-xs text-primary mt-0.5"
                              >
                                <Phone className="h-3 w-3" />
                                {tenant.phone}
                              </a>
                            ) : (
                              <p className="text-[11px] text-muted-foreground mt-0.5">No phone</p>
                            )}
                          </div>
                          <div className="flex items-center gap-2 shrink-0">
                            <div className="text-right">
                              <p className="text-xs font-medium">{formatUGX(tenant.totalRepaid)}</p>
                              <p className="text-[10px] text-muted-foreground">total repaid</p>
                            </div>
                            {tenant.phone && (
                              <a
                                href={`tel:${tenant.phone}`}
                                className="flex items-center justify-center h-9 w-9 rounded-full bg-success/10 text-success active:bg-success/20"
                                aria-label={`Call ${tenant.name}`}
                              >
                                <Phone className="h-4 w-4" />
                              </a>
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </CardContent>
              </Card>

              {/* Houses Listed by this sub-agent */}
              <Card>
                <CardHeader className="pb-2">
                  <div className="flex items-center justify-between">
                    <CardTitle className="text-sm flex items-center gap-2">
                      <Home className="h-4 w-4 text-orange-500" />
                      Houses Listed ({selectedSubAgent.houses.length})
                    </CardTitle>
                    {selectedSubAgent.houseOverrideEarnings > 0 && (
                      <span className="text-xs font-bold text-orange-600">
                        +{formatUGX(selectedSubAgent.houseOverrideEarnings)}
                      </span>
                    )}
                  </div>
                  <p className="text-[11px] text-muted-foreground">
                    Your override earnings when their listings get verified
                  </p>
                </CardHeader>
                <CardContent>
                  {selectedSubAgent.houses.length === 0 ? (
                    <p className="text-sm text-muted-foreground text-center py-4">
                      No houses listed yet
                    </p>
                  ) : (
                    <div className="space-y-2">
                      {(() => {
                        const total = selectedSubAgent.houses.length;
                        const visibleCount = housesPage * HOUSES_PER_PAGE;
                        const visibleHouses = selectedSubAgent.houses.slice(0, visibleCount);
                        const hasMore = visibleCount < total;
                        return (
                          <>
                            <div className="space-y-2">
                              {visibleHouses.map((house) => (
                                <button
                                  key={house.id}
                                  onClick={() => { hapticTap(); setSelectedHouse(house); }}
                                  className="w-full flex items-start justify-between gap-2 p-2.5 bg-muted/50 rounded-lg text-left transition-colors hover:bg-muted active:bg-muted/70"
                                >
                                  <div className="min-w-0">
                                    <p className="text-sm font-medium truncate">
                                      {house.title || 'Untitled listing'}
                                    </p>
                                    <div className="flex items-center gap-1 text-[11px] text-muted-foreground mt-0.5 truncate">
                                      <MapPin className="h-3 w-3 shrink-0" />
                                      <span className="truncate">
                                        {[house.district, house.region].filter(Boolean).join(', ') || 'No location'}
                                      </span>
                                    </div>
                                    <div className="flex items-center gap-1.5 mt-1 flex-wrap">
                                      {house.verified ? (
                                        <span className="inline-flex items-center gap-0.5 text-[10px] px-1.5 py-0.5 rounded-full bg-success/10 text-success border border-success/20">
                                          <CheckCircle2 className="h-2.5 w-2.5" /> Verified
                                        </span>
                                      ) : (
                                        <span className="inline-flex items-center gap-0.5 text-[10px] px-1.5 py-0.5 rounded-full bg-amber-500/10 text-amber-600 border border-amber-500/20">
                                          <Clock className="h-2.5 w-2.5" /> Pending
                                        </span>
                                      )}
                                      {house.tenant_id && (
                                        <span className="inline-flex items-center gap-0.5 text-[10px] px-1.5 py-0.5 rounded-full bg-primary/10 text-primary border border-primary/20">
                                          <Users className="h-2.5 w-2.5" /> Occupied
                                        </span>
                                      )}
                                    </div>
                                  </div>
                                  <div className="text-right shrink-0">
                                    <p className="text-xs font-medium">{formatUGX(house.monthly_rent)}</p>
                                    <p className="text-[10px] text-muted-foreground">/month</p>
                                    {house.overrideEarned > 0 && (
                                      <p className="text-[11px] font-bold text-orange-600 mt-1">
                                        +{formatUGX(house.overrideEarned)}
                                      </p>
                                    )}
                                    <div className="flex items-center justify-end gap-0.5 text-[10px] text-muted-foreground mt-1">
                                      Details <ChevronRight className="h-3 w-3" />
                                    </div>
                                  </div>
                                </button>
                              ))}
                            </div>
                            {total > HOUSES_PER_PAGE && (
                              <p className="text-[11px] text-muted-foreground text-center">
                                Showing {visibleHouses.length} of {total} houses
                              </p>
                            )}
                            {hasMore && (
                              <div ref={housesSentinelRef} className="flex justify-center py-3">
                                {housesLoadingMore ? (
                                  <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
                                ) : (
                                  <span className="text-[11px] text-muted-foreground">
                                    Scroll for more
                                  </span>
                                )}
                              </div>
                            )}
                          </>
                        );
                      })()}
                    </div>
                  )}
                </CardContent>
              </Card>
            </div>
          </div>
        </div>
      )}


      {/* House details */}
      <Sheet open={!!selectedHouse} onOpenChange={(open) => { if (!open) setSelectedHouse(null); }}>
        <SheetContent side="bottom" className="h-[88vh] rounded-t-3xl overflow-y-auto pb-8">
          {selectedHouse && (
            <>
              <SheetHeader className="pb-3 text-left">
                <SheetTitle className="flex items-center gap-2 text-lg">
                  <Home className="h-5 w-5 text-orange-500" />
                  {selectedHouse.title || 'Untitled listing'}
                </SheetTitle>
                <SheetDescription>
                  {selectedHouse.house_category || 'House'}
                  {selectedHouse.number_of_rooms ? ` · ${selectedHouse.number_of_rooms} room${selectedHouse.number_of_rooms === 1 ? '' : 's'}` : ''}
                </SheetDescription>
              </SheetHeader>

              <div className="space-y-4">
                {/* Status */}
                <div className="flex items-center gap-2 flex-wrap">
                  {selectedHouse.verified ? (
                    <span className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded-full bg-success/10 text-success border border-success/20">
                      <CheckCircle2 className="h-3 w-3" /> Verified
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded-full bg-amber-500/10 text-amber-600 border border-amber-500/20">
                      <Clock className="h-3 w-3" /> Pending verification
                    </span>
                  )}
                  <span className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded-full bg-muted text-muted-foreground border border-border capitalize">
                    {(selectedHouse.status || 'unknown').replace(/_/g, ' ')}
                  </span>
                  {selectedHouse.tenant_id && (
                    <span className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded-full bg-primary/10 text-primary border border-primary/20">
                      <Users className="h-3 w-3" /> Occupied
                    </span>
                  )}
                </div>

                {/* Address */}
                <Card>
                  <CardHeader className="pb-2">
                    <CardTitle className="text-sm flex items-center gap-2">
                      <MapPin className="h-4 w-4 text-orange-500" /> Address
                    </CardTitle>
                  </CardHeader>
                  <CardContent>
                    <p className="text-sm">
                      {[selectedHouse.address, selectedHouse.village, selectedHouse.sub_county, selectedHouse.district, selectedHouse.region]
                        .filter(Boolean)
                        .join(', ') || 'No address recorded'}
                    </p>
                  </CardContent>
                </Card>

                {/* Rent / cost */}
                <div className="grid grid-cols-2 gap-3">
                  <div className="bg-success/10 rounded-xl p-3 text-center border border-success/20">
                    <p className="text-[11px] text-muted-foreground">Monthly Rent</p>
                    <p className="font-bold text-success text-base mt-0.5">{formatUGX(selectedHouse.monthly_rent)}</p>
                  </div>
                  <div className="bg-primary/10 rounded-xl p-3 text-center border border-primary/20">
                    <p className="text-[11px] text-muted-foreground">Total Monthly Cost</p>
                    <p className="font-bold text-primary text-base mt-0.5">{formatUGX(selectedHouse.total_monthly_cost)}</p>
                  </div>
                </div>

                {/* Linked tenant */}
                <Card>
                  <CardHeader className="pb-2">
                    <CardTitle className="text-sm flex items-center gap-2">
                      <Users className="h-4 w-4 text-orange-500" /> Linked Tenant
                    </CardTitle>
                  </CardHeader>
                  <CardContent>
                    {!selectedHouse.tenant_id ? (
                      <p className="text-sm text-muted-foreground">No tenant linked yet</p>
                    ) : houseTenantLoading ? (
                      <div className="flex items-center gap-2 text-sm text-muted-foreground">
                        <Loader2 className="h-4 w-4 animate-spin" /> Loading…
                      </div>
                    ) : houseTenant ? (
                      <div className="flex items-center justify-between gap-2">
                        <div className="min-w-0">
                          <p className="text-sm font-medium truncate">{houseTenant.full_name}</p>
                          {houseTenant.phone ? (
                            <a href={`tel:${houseTenant.phone}`} className="inline-flex items-center gap-1 text-xs text-primary mt-0.5">
                              <Phone className="h-3 w-3" /> {houseTenant.phone}
                            </a>
                          ) : (
                            <p className="text-[11px] text-muted-foreground mt-0.5">No phone</p>
                          )}
                        </div>
                        {houseTenant.phone && (
                          <a
                            href={`tel:${houseTenant.phone}`}
                            className="flex items-center justify-center h-9 w-9 rounded-full bg-success/10 text-success active:bg-success/20"
                            aria-label={`Call ${houseTenant.full_name}`}
                          >
                            <Phone className="h-4 w-4" />
                          </a>
                        )}
                      </div>
                    ) : (
                      <p className="text-sm text-muted-foreground">Tenant details unavailable</p>
                    )}
                  </CardContent>
                </Card>

                {/* Per-transaction breakdown */}
                <Card>
                  <CardHeader className="pb-2">
                    <div className="flex items-center justify-between">
                      <CardTitle className="text-sm flex items-center gap-2">
                        <Coins className="h-4 w-4 text-orange-500" /> Earnings Breakdown
                      </CardTitle>
                      {selectedHouse.overrideEarned > 0 && (
                        <span className="text-xs font-bold text-orange-600">+{formatUGX(selectedHouse.overrideEarned)}</span>
                      )}
                    </div>
                    <p className="text-[11px] text-muted-foreground">Your override earnings from this listing</p>
                  </CardHeader>
                  <CardContent>
                    {selectedHouse.transactions.length === 0 ? (
                      <p className="text-sm text-muted-foreground text-center py-4">
                        No earnings recorded for this house yet
                      </p>
                    ) : (
                      <div className="space-y-2">
                        {selectedHouse.transactions.map((tx) => (
                          <div key={tx.id} className="flex items-center justify-between gap-2 p-2.5 bg-muted/50 rounded-lg">
                            <div className="min-w-0">
                              <p className="text-sm font-medium truncate">{tx.label}</p>
                              <p className="text-[10px] text-muted-foreground mt-0.5">
                                {tx.occurred_at ? format(new Date(tx.occurred_at), 'dd MMM yyyy · HH:mm') : '—'}
                              </p>
                            </div>
                            <span className="text-xs font-bold text-orange-600 shrink-0">+{formatUGX(tx.amount)}</span>
                          </div>
                        ))}
                      </div>
                    )}
                  </CardContent>
                </Card>

                <p className="text-[11px] text-muted-foreground text-center">
                  Listed {format(new Date(selectedHouse.created_at), 'MMM d, yyyy')}
                </p>
              </div>
            </>
          )}
        </SheetContent>
      </Sheet>

      {/* Invite an existing user as a sub-agent — searches any user and
          auto-sends an SMS + email invite they must accept. */}
      <Sheet open={inviteSheetOpen} onOpenChange={setInviteSheetOpen}>
        <SheetContent side="bottom" className="h-[88vh] rounded-t-3xl overflow-y-auto pb-8">
          <SheetHeader className="pb-4">
            <SheetTitle className="flex items-center gap-2 text-xl">
              <UserPlus className="h-6 w-6 text-orange-500" />
              Invite a Sub-Agent
            </SheetTitle>
            <SheetDescription>
              Search any registered user by name, phone, or email. They'll get an
              SMS (and email) inviting them to accept becoming your sub-agent.
            </SheetDescription>
          </SheetHeader>

          <div className="space-y-4">
            <AddSubAgentSearch
              onAdded={() => {
                fetchSubAgentAnalytics();
                setInviteSheetOpen(false);
              }}
            />

            <div className="flex items-center gap-3">
              <div className="h-px flex-1 bg-border" />
              <span className="text-xs text-muted-foreground">or</span>
              <div className="h-px flex-1 bg-border" />
            </div>

            {/* Shareable short invite link — clicking it and registering auto-links
                the new user as a sub-agent of the inviting agent. */}
            <ShareSubAgentLink />

          </div>
        </SheetContent>
      </Sheet>

      <FloatingActionButton
        actions={[
          {
            icon: UserPlus,
            label: 'Invite Sub-Agent',
            onClick: () => { hapticTap(); setInviteSheetOpen(true); },
            variant: 'default',
          },
        ]}
        position="bottom-right"
      />

      <AlertDialog
        open={releaseConfirmOpen}
        onOpenChange={(open) => {
          if (!releasing) setReleaseConfirmOpen(open);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Unlink {selectedSubAgent?.profile?.full_name || 'this sub-agent'}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              They will no longer be your sub-agent. All parent benefits stop
              immediately — you will no longer earn the 2% override on their
              collections and they will leave your team. This does not remove
              their own agent account or their tenants.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={releasing}>Keep sub-agent</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                handleReleaseSubAgent();
              }}
              disabled={releasing}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {releasing ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" /> Unlinking…
                </>
              ) : (
                'Unlink sub-agent'
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
