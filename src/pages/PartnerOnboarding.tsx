import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Helmet } from 'react-helmet-async';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
import { roleToSlug } from '@/lib/roleRoutes';
import { format } from 'date-fns';
import {
  Loader2, Phone, Search, Users, Calendar, ShieldCheck, ShieldAlert, CheckCircle2, XCircle, Clock,
  ChevronLeft, ChevronRight, Link2, MousePointerClick, UserCheck,
} from 'lucide-react';
import COODetailLayout, { KPICard } from '@/components/coo/COODetailLayout';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from '@/components/ui/dialog';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import { cn } from '@/lib/utils';
import { buildPartnerReference } from '@/lib/partnerReference';
import { useToast } from '@/hooks/use-toast';
import PartnerAgreementSignOff, { type SignOffPartner } from '@/components/partner/PartnerAgreementSignOff';
import PartnerCompanyDefaultsDialog from '@/components/partner/PartnerCompanyDefaultsDialog';
import { InvitedPortfoliosPanel } from '@/components/executive/InvitedPortfoliosPanel';
import ScreenLoader from '@/components/common/ScreenLoader';

interface FunderProfileRow {
  id: string;
  full_name: string | null;
  phone: string | null;
  email: string | null;
  created_at: string;
  frozen_at: string | null;
  verified: boolean | null;
  funder_verified_at: string | null;
  funder_rejected_at: string | null;
  funder_rejection_reason: string | null;
  referrer_id: string | null;
}

const PAGE_SIZE = 50;

type SourceFilter = 'all' | 'referred' | 'direct';
type ViewTab = 'funders' | 'invited';

export default function FunderOnboarding() {
  const { user, roles, loading, role } = useAuth();
  const navigate = useNavigate();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  // Deep-link target: `/partner-onboarding?focus=<userId>` jumps directly
  // to that partner's row and pre-opens the Approve action so an
  // executive coming from the "Partner Not Approved" gate in the
  // Create Portfolio dialog can verify them in one click.
  const focusUserId = searchParams.get('focus');
  // Surviving copy of the deep-link target so the row-scroll/highlight
  // effect can still match the row after we strip `?focus=` from the
  // URL (we strip it to prevent re-firing on dialog close).
  const [highlightId, setHighlightId] = useState<string | null>(null);
  // Sticky record of which partner (if any) was opened via `?focus=`.
  // Lets the verify-completion telemetry distinguish operator-driven
  // browsing from deep-link verifications coming from the Create
  // Portfolio dialog. Not cleared until the dialog closes.
  const [deepLinkPartnerId, setDeepLinkPartnerId] = useState<string | null>(null);

  const [search, setSearch] = useState('');
  const [page, setPage] = useState(0);
  const [sourceFilter, setSourceFilter] = useState<SourceFilter>('all');
  const [viewTab, setViewTab] = useState<ViewTab>('funders');
  const [selected, setSelected] = useState<FunderProfileRow | null>(null);
  const [signOffPartner, setSignOffPartner] = useState<SignOffPartner | null>(null);
  const [companyDefaultsOpen, setCompanyDefaultsOpen] = useState(false);
  const [actionMode, setActionMode] = useState<null | 'approve' | 'reject'>(null);
  const [actionReason, setActionReason] = useState('');
  const [submitting, setSubmitting] = useState(false);

  // One-shot fetch for the focused partner so the page works even when
  // the row isn't on the current page (search/pagination independent).
  useEffect(() => {
    if (!focusUserId || !user || !roles.includes('manager')) return;
    // Friendly guard: the focus param must look like a UUID. Anything
    // else is almost certainly a stale/copied link and we shouldn't
    // even bother round-tripping the DB for it.
    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const isMalformed = !UUID_RE.test(focusUserId);
    const clearFocusParam = () => {
      const next = new URLSearchParams(searchParams);
      next.delete('focus');
      setSearchParams(next, { replace: true });
    };
    if (isMalformed) {
      toast({
        title: 'Invalid partner link',
        description: "That partner link doesn't look right. Showing the full onboarding list instead.",
        variant: 'destructive',
      });
      clearFocusParam();
      return;
    }
    let cancelled = false;
    (async () => {
      const { data, error } = await supabase
        .from('profiles')
        .select('id, full_name, phone, email, created_at, frozen_at, verified, funder_verified_at, funder_rejected_at, funder_rejection_reason, referrer_id')
        .eq('id', focusUserId)
        .maybeSingle();
      if (cancelled) return;
      if (error || !data) {
        toast({
          title: "We couldn't find that partner",
          description: error
            ? "Something went wrong loading the linked partner. You can search for them below."
            : "That partner may have been removed or never finished signing up. Showing the full onboarding list instead.",
          variant: 'destructive',
        });
        clearFocusParam();
        // Send the user back to where they came from (typically the
        // Create Portfolio dialog) after a brief beat so they can read
        // the toast. Falls back to the manager dashboard if there's no
        // browser history.
        setTimeout(() => {
          if (window.history.length > 1) {
            navigate(-1);
          } else {
            navigate(roleToSlug(role));
          }
        }, 1200);
        return;
      } else {
        setSelected(data as FunderProfileRow);
        setDeepLinkPartnerId(data.id);
        if (!data.funder_verified_at && !data.funder_rejected_at) {
          setActionMode('approve');
        }
        // Mark this row for scroll-into-view + ring highlight once the
        // table renders it. We seed the search box with the partner's
        // phone (most reliable unique field) so the row is guaranteed
        // to appear on page 1 regardless of pagination.
        setHighlightId(data.id);
        if (data.phone) {
          setSearch(data.phone);
        } else if (data.full_name) {
          setSearch(data.full_name);
        }
      }
      // Clear the param so a manual close + re-open doesn't keep re-firing.
      clearFocusParam();
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusUserId, user?.id, roles.join(',')]);


  // Reset to first page whenever search term or source filter changes
  useEffect(() => { setPage(0); }, [search, sourceFilter]);

  // Gate: managers only
  useEffect(() => {
    if (loading) return;
    if (!user || !roles.includes('manager')) {
      navigate(roleToSlug(role));
    }
  }, [user, loading, roles, role, navigate]);

  const trimmedSearch = search.trim();

  // Partners with an agreement still awaiting the company countersign.
  // These must always be visible in this queue even when the profile was
  // not created through the funder-onboarding signup flow (e.g. legacy or
  // ops-created partners), otherwise the countersign step is unreachable.
  const { data: awaitingSignOffIds } = useQuery({
    queryKey: ['partner-agreements-awaiting-countersign-ids'],
    enabled: !!user && roles.includes('manager'),
    queryFn: async () => {
      const { data: ags, error } = await (supabase.from('partner_agreements') as any)
        .select('partner_id, status, countersigned_at')
        .is('countersigned_at', null)
        .limit(500);
      if (error) throw error;
      const ids = Array.from(
        new Set(((ags || []) as Array<{ partner_id: string | null }>)
          .map((a) => a.partner_id)
          .filter((id): id is string => !!id)),
      );
      return ids;
    },
    staleTime: 30_000,
  });

  const awaitingIdsKey = (awaitingSignOffIds || []).join(',');

  const { data, isLoading, isFetching } = useQuery({
    queryKey: ['funder-onboarding-self-registered', page, trimmedSearch, sourceFilter, awaitingIdsKey],
    enabled: !!user && roles.includes('manager'),
    queryFn: async () => {
      const extraIds = awaitingSignOffIds || [];
      let query = supabase
        .from('profiles')
        .select('id, full_name, phone, email, created_at, frozen_at, verified, funder_verified_at, funder_rejected_at, funder_rejection_reason, referrer_id', { count: 'exact' });

      query = extraIds.length
        ? query.or(`signup_source.eq.funder-onboarding,id.in.(${extraIds.join(',')})`)
        : query.eq('signup_source', 'funder-onboarding');

      if (sourceFilter === 'referred') query = query.not('referrer_id', 'is', null);
      if (sourceFilter === 'direct') query = query.is('referrer_id', null);

      if (trimmedSearch) {
        const q = trimmedSearch.replace(/[%,]/g, '');
        query = query.or(
          `full_name.ilike.%${q}%,phone.ilike.%${q}%,email.ilike.%${q}%`
        );
      }

      const from = page * PAGE_SIZE;
      const to = from + PAGE_SIZE - 1;

      const { data: rows, count, error } = await query
        .order('created_at', { ascending: false })
        .range(from, to);

      if (error) throw error;
      return { rows: (rows || []) as FunderProfileRow[], total: count || 0 };
    },
    staleTime: 30_000,
  });

  // Lightweight KPI counts (independent of pagination/search)
  const { data: kpis } = useQuery({
    queryKey: ['funder-onboarding-kpis'],
    enabled: !!user && roles.includes('manager'),
    queryFn: async () => {
      const [
        { count: total }, { count: pending }, { count: verified }, { count: rejected },
        { count: referred }, { count: direct },
      ] = await Promise.all([
        supabase.from('profiles').select('id', { count: 'exact', head: true }).eq('signup_source', 'funder-onboarding'),
        supabase.from('profiles').select('id', { count: 'exact', head: true }).eq('signup_source', 'funder-onboarding').is('funder_verified_at', null).is('funder_rejected_at', null),
        supabase.from('profiles').select('id', { count: 'exact', head: true }).eq('signup_source', 'funder-onboarding').not('funder_verified_at', 'is', null),
        supabase.from('profiles').select('id', { count: 'exact', head: true }).eq('signup_source', 'funder-onboarding').not('funder_rejected_at', 'is', null),
        supabase.from('profiles').select('id', { count: 'exact', head: true }).eq('signup_source', 'funder-onboarding').not('referrer_id', 'is', null),
        supabase.from('profiles').select('id', { count: 'exact', head: true }).eq('signup_source', 'funder-onboarding').is('referrer_id', null),
      ]);
      return {
        total: total || 0, pending: pending || 0, verified: verified || 0, rejected: rejected || 0,
        referred: referred || 0, direct: direct || 0,
      };
    },
    staleTime: 60_000,
  });

  // Invited-portfolio pipeline KPIs (portfolios sent via Ops invite flow
  // that are either waiting on the partner to complete or waiting on
  // Ops to approve the partner's submission). Independent of the
  // funder-onboarding profile counts above so we can group them
  // separately in the KPI header.
  const { data: invitedKpis } = useQuery({
    queryKey: ['invited-portfolios-kpis'],
    enabled: !!user && roles.includes('manager'),
    queryFn: async () => {
      const [{ count: awaiting }, { count: pendingApproval }] = await Promise.all([
        supabase.from('investor_portfolios').select('id', { count: 'exact', head: true }).eq('status', 'awaiting_partner_details'),
        supabase.from('investor_portfolios').select('id', { count: 'exact', head: true }).eq('status', 'pending_ops_approval'),
      ]);
      return {
        awaiting: awaiting || 0,
        pending_approval: pendingApproval || 0,
        total: (awaiting || 0) + (pendingApproval || 0),
      };
    },
    staleTime: 60_000,
  });

  const rows = data?.rows || [];
  const total = data?.total || 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  // Scroll the highlighted (deep-linked) row into view + flash a ring
  // once it renders. Runs whenever the page data changes (e.g. after
  // the seeded search resolves). The ring is removed after 2.5s and
  // highlightId is cleared so subsequent manual interactions are
  // unaffected.
  useEffect(() => {
    if (!highlightId) return;
    if (!rows.some(r => r.id === highlightId)) return;
    const el = document.querySelector<HTMLElement>(`[data-partner-row-id="${highlightId}"]`);
    if (!el) return;
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    el.classList.add('ring-2', 'ring-primary', 'ring-offset-2', 'ring-offset-background');
    const t = setTimeout(() => {
      el.classList.remove('ring-2', 'ring-primary', 'ring-offset-2', 'ring-offset-background');
      setHighlightId(null);
    }, 2500);
    return () => clearTimeout(t);
  }, [highlightId, rows]);

  // Batch-resolve referrer names for the current page
  const referrerIds = Array.from(new Set(rows.map(r => r.referrer_id).filter(Boolean) as string[]));
  const { data: referrerMap } = useQuery({
    queryKey: ['funder-onboarding-referrers', referrerIds.sort().join(',')],
    enabled: referrerIds.length > 0,
    queryFn: async () => {
      const { data: profs } = await supabase
        .from('profiles')
        .select('id, full_name')
        .in('id', referrerIds);
      const map = new Map<string, string>();
      (profs || []).forEach(p => map.set(p.id, p.full_name || '—'));
      return map;
    },
    staleTime: 60_000,
  });

  // Per-share analytics: top sharers by clicks + converted signups
  const { data: shareStats } = useQuery({
    queryKey: ['funder-onboarding-share-stats'],
    enabled: !!user && roles.includes('manager'),
    queryFn: async () => {
      const { data: links } = await supabase
        .from('short_links')
        .select('user_id, click_count')
        .eq('target_path', '/funder-onboarding');
      const agg = new Map<string, { clicks: number }>();
      (links || []).forEach((l: any) => {
        const cur = agg.get(l.user_id) || { clicks: 0 };
        cur.clicks += l.click_count || 0;
        agg.set(l.user_id, cur);
      });
      const userIds = Array.from(agg.keys());
      if (userIds.length === 0) return [] as Array<{ user_id: string; full_name: string; clicks: number; signups: number }>;
      const [{ data: profs }, { data: signups }] = await Promise.all([
        supabase.from('profiles').select('id, full_name').in('id', userIds),
        supabase.from('profiles').select('referrer_id').eq('signup_source', 'funder-onboarding').in('referrer_id', userIds),
      ]);
      const nameMap = new Map<string, string>();
      (profs || []).forEach(p => nameMap.set(p.id, p.full_name || '—'));
      const signupAgg = new Map<string, number>();
      (signups || []).forEach((s: any) => {
        if (!s.referrer_id) return;
        signupAgg.set(s.referrer_id, (signupAgg.get(s.referrer_id) || 0) + 1);
      });
      const out = userIds.map(uid => ({
        user_id: uid,
        full_name: nameMap.get(uid) || uid.slice(0, 8),
        clicks: agg.get(uid)!.clicks,
        signups: signupAgg.get(uid) || 0,
      }));
      // Sort by signups desc, then clicks desc
      out.sort((a, b) => (b.signups - a.signups) || (b.clicks - a.clicks));
      return out.slice(0, 10);
    },
    staleTime: 60_000,
  });

  if (loading || !user) {
    return (
      <>
      <Helmet>
        <link rel="canonical" href="https://welileapp.com/partner-onboarding" />
        <meta property="og:url" content="https://welileapp.com/partner-onboarding" />
      </Helmet>
      <ScreenLoader />
      </>
    );
  }

  const headerStatus: 'green' | 'yellow' | 'red' = (kpis?.pending || 0) > 10 ? 'red' : (kpis?.pending || 0) > 0 ? 'yellow' : 'green';

  const openAction = (mode: 'approve' | 'reject') => {
    setActionMode(mode);
    setActionReason('');
  };

  const submitAction = async () => {
    if (!selected || !actionMode) return;
    if (actionReason.trim().length < 10) {
      toast({ title: 'Reason required', description: 'Please provide at least 10 characters.', variant: 'destructive' });
      return;
    }
    setSubmitting(true);
    const rpcName = actionMode === 'approve' ? 'approve_self_registered_funder' : 'reject_self_registered_funder';
    const { error } = await supabase.rpc(rpcName, {
      _target_user: selected.id,
      _reason: actionReason.trim(),
    });
    setSubmitting(false);
    if (error) {
      toast({ title: 'Action failed', description: error.message, variant: 'destructive' });
      return;
    }
    toast({
      title: actionMode === 'approve' ? 'Funder verified' : 'Funder rejected',
      description: selected.full_name || selected.email || 'Updated',
    });
    // Telemetry: record which partner was verified/rejected from this
    // dashboard, and whether the operator arrived via a deep link from
    // the Create Portfolio dialog. Fire-and-forget; failures only warn.
    const fromDeepLink = deepLinkPartnerId === selected.id;
    supabase.from('audit_logs').insert({
      user_id: user.id,
      action_type: actionMode === 'approve'
        ? 'partner_verification_approved'
        : 'partner_verification_rejected',
      table_name: 'profiles',
      record_id: selected.id,
      metadata: {
        source: fromDeepLink ? 'create_investment_account_dialog' : 'partner_onboarding_dashboard',
        from_deep_link: fromDeepLink,
        partner_name: selected.full_name || null,
        partner_phone: selected.phone || null,
        reason: actionReason.trim(),
      },
    }).then(({ error: auditErr }) => {
      if (auditErr) console.warn('[partner-verify telemetry] insert failed:', auditErr.message);
    });
    setActionMode(null);
    setActionReason('');
    setSelected(null);
    setDeepLinkPartnerId(null);
    queryClient.invalidateQueries({ queryKey: ['funder-onboarding-self-registered'] });
    queryClient.invalidateQueries({ queryKey: ['funder-onboarding-kpis'] });
  };

  return (
    <>
    <Helmet>
      <link rel="canonical" href="https://welileapp.com/partner-onboarding" />
      <meta property="og:url" content="https://welileapp.com/partner-onboarding" />
    </Helmet>
    <COODetailLayout
      title="Partner Onboarding"
      subtitle="Self-Registered Funders"
      status={headerStatus}
    >
      {/* KPIs — grouped: Funders (self-registered) vs Invited Portfolios */}
      <div className="space-y-4">
        <section className="space-y-2">
          <div className="flex items-center gap-2">
            <h3 className="text-xs font-bold uppercase tracking-wide text-muted-foreground">Funders</h3>
            <span className="text-[10px] text-muted-foreground">Self-registered via funder-onboarding</span>
          </div>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-6">
            <KPICard label="Total Funders" value={kpis?.total ?? '—'} status="green" sub="Via funder-onboarding" />
            <KPICard label="Pending Review" value={kpis?.pending ?? '—'} status={(kpis?.pending || 0) > 0 ? 'yellow' : 'green'} />
            <KPICard label="Verified" value={kpis?.verified ?? '—'} status="green" />
            <KPICard label="Rejected" value={kpis?.rejected ?? '—'} status={(kpis?.rejected || 0) > 0 ? 'red' : 'green'} />
            <KPICard label="Referred" value={kpis?.referred ?? '—'} status="green" sub="Via shared link" />
            <KPICard label="Direct" value={kpis?.direct ?? '—'} status="green" sub="Typed URL" />
          </div>
        </section>

        <section className="space-y-2">
          <div className="flex items-center gap-2">
            <h3 className="text-xs font-bold uppercase tracking-wide text-muted-foreground">Invited Portfolios</h3>
            <span className="text-[10px] text-muted-foreground">Ops-initiated portfolio invites</span>
          </div>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-6">
            <KPICard
              label="New Portfolios"
              value={invitedKpis?.total ?? '—'}
              status={(invitedKpis?.total || 0) > 0 ? 'yellow' : 'green'}
              sub="In invite pipeline"
            />
            <KPICard
              label="Awaiting Partner"
              value={invitedKpis?.awaiting ?? '—'}
              status={(invitedKpis?.awaiting || 0) > 0 ? 'yellow' : 'green'}
              sub="Partner to complete"
            />
            <KPICard
              label="Pending Approval"
              value={invitedKpis?.pending_approval ?? '—'}
              status={(invitedKpis?.pending_approval || 0) > 0 ? 'yellow' : 'green'}
              sub="Ops to review"
            />
          </div>
        </section>
      </div>

      <div className="flex justify-end">
        <Button variant="outline" size="sm" className="gap-1.5" onClick={() => setCompanyDefaultsOpen(true)}>
          <ShieldCheck className="h-3.5 w-3.5" /> Company Defaults
        </Button>
      </div>

      {/* Primary view tabs */}
      <div className="inline-flex items-center gap-1 rounded-lg border border-border bg-muted/40 p-1 text-xs">
        {([
          { key: 'funders' as ViewTab, label: 'Self-registered funders' },
          { key: 'invited' as ViewTab, label: `Invited portfolios${invitedKpis?.total ? ` (${invitedKpis.total})` : ''}` },
        ]).map((t) => (
          <button
            key={t.key}
            onClick={() => setViewTab(t.key)}
            className={cn(
              'px-3 py-1.5 rounded-md font-semibold transition-colors',
              viewTab === t.key
                ? 'bg-background shadow-sm text-foreground'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {t.label}
          </button>
        ))}
      </div>

      {viewTab === 'invited' ? (
        <InvitedPortfoliosPanel />
      ) : (
      <>
      {/* Source filter tabs */}
      <div className="inline-flex items-center gap-1 rounded-lg border border-border bg-muted/40 p-1 text-xs">
        {(['all', 'referred', 'direct'] as SourceFilter[]).map((f) => (
          <button
            key={f}
            onClick={() => setSourceFilter(f)}
            className={cn(
              'px-3 py-1.5 rounded-md font-semibold capitalize transition-colors',
              sourceFilter === f
                ? 'bg-background shadow-sm text-foreground'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {f === 'all' ? 'All sources' : f}
          </button>
        ))}
      </div>

      {/* Search */}
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <div className="relative sm:w-72">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
          <Input
            placeholder="Search by name, phone, email…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-8 h-9 text-sm"
          />
        </div>
        <p className="text-xs text-muted-foreground sm:ml-auto">
          {total === 0 ? 'No records' : `Showing ${page * PAGE_SIZE + 1}–${Math.min((page + 1) * PAGE_SIZE, total)} of ${total}`}
        </p>
      </div>

      {/* Table */}
      <Card>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="p-4 space-y-2">
              {[...Array(8)].map((_, i) => <Skeleton key={i} className="h-10 w-full rounded-md" />)}
            </div>
          ) : rows.length === 0 ? (
            <div className="p-10 text-center">
              <Users className="h-8 w-8 mx-auto text-muted-foreground/60" />
              <p className="text-sm text-muted-foreground mt-2">No self-registered funders found.</p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="text-xs">Partner</TableHead>
                    <TableHead className="text-xs hidden lg:table-cell">Reference</TableHead>
                    <TableHead className="text-xs hidden sm:table-cell">Phone</TableHead>
                    <TableHead className="text-xs hidden md:table-cell">Email</TableHead>
                    <TableHead className="text-xs hidden md:table-cell">Source</TableHead>
                    <TableHead className="text-xs">Status</TableHead>
                    <TableHead className="text-xs hidden md:table-cell">Joined</TableHead>
                    <TableHead className="text-xs text-right">Action</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((r) => {
                    const partnerRef = buildPartnerReference(r.id, r.created_at);
                    const verState: 'verified' | 'rejected' | 'pending' =
                      r.funder_verified_at ? 'verified'
                      : r.funder_rejected_at ? 'rejected'
                      : 'pending';
                    return (
                      <TableRow
                        key={r.id}
                        data-partner-row-id={r.id}
                        className="cursor-pointer"
                        onClick={() => setSelected(r)}
                      >
                        <TableCell className="py-2.5">
                          <p className="text-sm font-semibold truncate max-w-[160px]">
                            {r.full_name || '—'}
                          </p>
                          <p className="text-[10px] text-muted-foreground sm:hidden">
                            {r.phone || '—'}
                          </p>
                          <p className="text-[10px] font-mono text-muted-foreground lg:hidden">
                            {partnerRef}
                          </p>
                        </TableCell>
                        <TableCell className="hidden lg:table-cell">
                          <span className="text-[11px] font-mono px-1.5 py-0.5 rounded bg-muted text-muted-foreground">
                            {partnerRef}
                          </span>
                        </TableCell>
                        <TableCell className="hidden sm:table-cell text-xs">
                          {r.phone || '—'}
                        </TableCell>
                        <TableCell className="hidden md:table-cell text-xs truncate max-w-[180px]">
                          {r.email || '—'}
                        </TableCell>
                        <TableCell className="hidden md:table-cell">
                          {r.referrer_id ? (
                            <Badge variant="outline" className="text-[10px] gap-1 bg-primary/10 text-primary border-primary/30">
                              <UserCheck className="h-2.5 w-2.5" />
                              {referrerMap?.get(r.referrer_id) || 'Referred'}
                            </Badge>
                          ) : (
                            <Badge variant="outline" className="text-[10px] text-muted-foreground">
                              Direct
                            </Badge>
                          )}
                        </TableCell>
                        <TableCell>
                          {verState === 'verified' && (
                            <Badge variant="outline" className="text-[10px] gap-1 bg-success/15 text-success border-success/30">
                              <CheckCircle2 className="h-2.5 w-2.5" /> Verified
                            </Badge>
                          )}
                          {verState === 'rejected' && (
                            <Badge variant="outline" className="text-[10px] gap-1 bg-destructive/15 text-destructive border-destructive/30">
                              <XCircle className="h-2.5 w-2.5" /> Rejected
                            </Badge>
                          )}
                          {verState === 'pending' && (
                            <Badge variant="outline" className="text-[10px] gap-1 bg-warning/15 text-warning border-warning/30">
                              <Clock className="h-2.5 w-2.5" /> Pending
                            </Badge>
                          )}
                        </TableCell>
                        <TableCell className="hidden md:table-cell text-xs text-muted-foreground">
                          {format(new Date(r.created_at), 'dd MMM yyyy')}
                        </TableCell>
                        <TableCell className="text-right">
                          <div className="flex items-center justify-end gap-1">
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-7 w-7"
                              title="Review / approve"
                              onClick={(e) => { e.stopPropagation(); setSelected(r); }}
                            >
                              <ShieldCheck className="h-3.5 w-3.5" />
                            </Button>
                            <Button
                              variant="outline"
                              size="sm"
                              className="h-7 text-xs"
                              onClick={(e) => { e.stopPropagation(); setSignOffPartner(r); }}
                            >
                              View
                            </Button>
                          </div>
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

      {/* Per-share analytics */}
      {shareStats && shareStats.length > 0 && (
        <Card>
          <CardContent className="p-4 space-y-3">
            <div className="flex items-center gap-2">
              <Link2 className="h-4 w-4 text-primary" />
              <h3 className="text-sm font-bold">Top sharers — funder onboarding link</h3>
              <span className="ml-auto text-[10px] text-muted-foreground">
                Clicks &amp; converted signups by sharer
              </span>
            </div>
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="text-xs">Sharer</TableHead>
                    <TableHead className="text-xs text-right">
                      <span className="inline-flex items-center gap-1">
                        <MousePointerClick className="h-3 w-3" /> Clicks
                      </span>
                    </TableHead>
                    <TableHead className="text-xs text-right">
                      <span className="inline-flex items-center gap-1">
                        <UserCheck className="h-3 w-3" /> Signups
                      </span>
                    </TableHead>
                    <TableHead className="text-xs text-right">Conv.</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {shareStats.map((s) => {
                    const conv = s.clicks > 0 ? Math.round((s.signups / s.clicks) * 100) : 0;
                    return (
                      <TableRow key={s.user_id}>
                        <TableCell className="text-xs font-medium">{s.full_name}</TableCell>
                        <TableCell className="text-xs text-right">{s.clicks.toLocaleString()}</TableCell>
                        <TableCell className="text-xs text-right font-semibold">{s.signups}</TableCell>
                        <TableCell className="text-xs text-right text-muted-foreground">
                          {s.clicks > 0 ? `${conv}%` : '—'}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Pagination */}
      {total > PAGE_SIZE && (
        <div className="flex items-center justify-between gap-2 pt-1">
          <Button
            variant="outline"
            size="sm"
            className="h-8 gap-1"
            disabled={page === 0 || isFetching}
            onClick={() => setPage(p => Math.max(0, p - 1))}
          >
            <ChevronLeft className="h-3.5 w-3.5" /> Prev
          </Button>
          <p className="text-xs text-muted-foreground">
            Page {page + 1} of {totalPages}
          </p>
          <Button
            variant="outline"
            size="sm"
            className="h-8 gap-1"
            disabled={page >= totalPages - 1 || isFetching}
            onClick={() => setPage(p => Math.min(totalPages - 1, p + 1))}
          >
            Next <ChevronRight className="h-3.5 w-3.5" />
          </Button>
        </div>
      )}
      </>
      )}

      {/* Detail Modal */}
      <Dialog open={!!selected} onOpenChange={(o) => { if (!o) setSelected(null); }}>
        <DialogContent className="max-w-lg">
          {selected && (
            <>
              <DialogHeader>
                <DialogTitle>Partner Details</DialogTitle>
                <DialogDescription className="text-xs">
                  Self-registered via the funder onboarding flow.
                </DialogDescription>
              </DialogHeader>

              <div className="space-y-3">
                <div className="rounded-xl bg-muted/40 p-3 space-y-1">
                  <p className="text-base font-bold">{selected.full_name || 'Unknown'}</p>
                  <p className="text-[11px] font-mono text-muted-foreground">
                    Ref: {buildPartnerReference(selected.id, selected.created_at)}
                  </p>
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                    <span className="inline-flex items-center gap-1">
                      <Phone className="h-3 w-3" />
                      {selected.phone || '—'}
                    </span>
                    {selected.email && <span className="truncate">{selected.email}</span>}
                  </div>
                  <div className="pt-1">
                    {selected.funder_verified_at ? (
                      <Badge variant="outline" className="text-[10px] gap-1 bg-success/15 text-success border-success/30">
                        <CheckCircle2 className="h-2.5 w-2.5" /> Verified
                      </Badge>
                    ) : selected.funder_rejected_at ? (
                      <Badge variant="outline" className="text-[10px] gap-1 bg-destructive/15 text-destructive border-destructive/30">
                        <XCircle className="h-2.5 w-2.5" /> Rejected
                      </Badge>
                    ) : (
                      <Badge variant="outline" className="text-[10px] gap-1 bg-warning/15 text-warning border-warning/30">
                        <Clock className="h-2.5 w-2.5" /> Pending Review
                      </Badge>
                    )}
                  </div>
                </div>

                <div className="grid grid-cols-1 gap-2 text-xs">
                  <Row label="Joined">
                    <span className="inline-flex items-center gap-1">
                      <Calendar className="h-3 w-3" />
                      {format(new Date(selected.created_at), 'dd MMM yyyy, HH:mm')}
                    </span>
                  </Row>
                  <Row label="Verified">{selected.funder_verified_at ? format(new Date(selected.funder_verified_at), 'dd MMM yyyy, HH:mm') : 'No'}</Row>
                  {selected.funder_rejected_at && (
                    <Row label="Rejected reason">{selected.funder_rejection_reason || '—'}</Row>
                  )}
                  <Row label="Source">
                    {selected.referrer_id
                      ? `Referred by ${referrerMap?.get(selected.referrer_id) || selected.referrer_id.slice(0, 8)}`
                      : 'Direct signup'}
                  </Row>
                </div>

                {actionMode && (
                  <div className="rounded-xl border border-border/60 p-3 space-y-2">
                    <p className="text-xs font-semibold">
                      {actionMode === 'approve' ? 'Approve this funder' : 'Reject this funder'}
                    </p>
                    <Textarea
                      value={actionReason}
                      onChange={(e) => setActionReason(e.target.value)}
                      placeholder="Reason (min 10 characters) — required for audit log"
                      className="text-xs min-h-[72px]"
                    />
                    <div className="flex items-center justify-end gap-2">
                      <Button size="sm" variant="ghost" onClick={() => setActionMode(null)} disabled={submitting}>Cancel</Button>
                      <Button
                        size="sm"
                        variant={actionMode === 'approve' ? 'default' : 'destructive'}
                        onClick={submitAction}
                        disabled={submitting || actionReason.trim().length < 10}
                      >
                        {submitting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : (actionMode === 'approve' ? 'Confirm Approval' : 'Confirm Rejection')}
                      </Button>
                    </div>
                  </div>
                )}
              </div>

              <DialogFooter>
                {!actionMode && !selected.funder_verified_at && (
                  <Button size="sm" onClick={() => openAction('approve')} className="gap-1">
                    <CheckCircle2 className="h-3.5 w-3.5" /> Approve
                  </Button>
                )}
                {!actionMode && !selected.funder_rejected_at && (
                  <Button size="sm" variant="destructive" onClick={() => openAction('reject')} className="gap-1">
                    <XCircle className="h-3.5 w-3.5" /> Reject
                  </Button>
                )}
                <Button size="sm" variant="outline" onClick={() => setSelected(null)}>Close</Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>

      {/* Agreement preview & sign-off */}
      <PartnerAgreementSignOff
        open={!!signOffPartner}
        onOpenChange={(o) => { if (!o) setSignOffPartner(null); }}
        partner={signOffPartner}
      />

      <PartnerCompanyDefaultsDialog
        open={companyDefaultsOpen}
        onOpenChange={setCompanyDefaultsOpen}
      />
    </COODetailLayout>
    </>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-3 py-1.5 border-b border-border/40 last:border-0">
      <span className="text-muted-foreground shrink-0">{label}</span>
      <span className="text-right font-medium break-words">{children}</span>
    </div>
  );
}
