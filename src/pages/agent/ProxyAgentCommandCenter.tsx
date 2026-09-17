import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { format } from 'date-fns';
import {
  ArrowLeft, Users, UserCheck, FileText, HandCoins, Wallet, Share2, Loader2,
  RefreshCw, Search, ArrowUpDown, ChevronLeft, ChevronRight, Target, Repeat,
  BarChart3, Download, Copy, Phone, MessageCircle, StickyNote,
} from 'lucide-react';


import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from '@/components/ui/sheet';
import { Progress } from '@/components/ui/progress';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import { hapticTap } from '@/lib/haptics';
import { formatDynamic } from '@/lib/currencyFormat';
import { getPublicOrigin } from '@/lib/getPublicOrigin';
import { createShortLink } from '@/lib/createShortLink';

import { PromissoryNoteDialog } from '@/components/agent/PromissoryNoteDialog';
import { ProxyTargetModeCard } from '@/components/agent/ProxyTargetModeCard';

import { SupportModeChooserDialog, type SupportMode } from '@/components/agent/SupportModeChooserDialog';
import { EmptyHouseOpportunitiesSheet } from '@/components/agent/EmptyHouseOpportunitiesSheet';
import {
  PartnerContactChatSheet, hasDialablePhone, toIntlDigits, initialsOf,
  type PartnerContact,
} from '@/components/agent/PartnerContactChatSheet';


import { WithdrawRequestDialog } from '@/components/wallet/WithdrawRequestDialog';
import { ProxyPerformanceSection } from '@/components/agent/ProxyPerformanceSection';
import { ProxySupportOpportunities } from '@/components/agent/ProxySupportOpportunities';
import {
  useProxyCommandCenterSummary,
  useProxyPartnerList,
  useProxyNoteList,
  type ProxyPartnerRow,
  type ProxyNoteRow,
} from '@/hooks/useProxyAgentCommandCenter';

const PAGE_SIZE = 10;

/** Full money — never abbreviated (no 4.50M). */
const money = (v: unknown) => formatDynamic(Number(v ?? 0));

const sourceLabels: Record<string, string> = {
  invite: 'Invited',
  invite_link: 'Invite link',
  referral: 'Referral',
  proxy: 'Proxy',
  portfolio: 'Portfolio',
  note: 'Promissory',
};

const noteStatusTone: Record<string, string> = {
  pending: 'bg-amber-500/15 text-amber-600 border-amber-500/30',
  activated: 'bg-emerald-500/15 text-emerald-600 border-emerald-500/30',
};

function Metric({
  icon: Icon, label, value, hint,
}: {
  icon: typeof Users; label: string; value: string; hint?: string;
}) {
  return (
    <div className="flex flex-col gap-0.5 min-w-0 px-3 py-2.5">
      <div className="flex items-center gap-1.5 text-muted-foreground">
        <Icon className="h-3 w-3 shrink-0" />
        <span className="text-[10px] font-medium uppercase tracking-wider truncate">{label}</span>
      </div>
      <span className="text-sm font-semibold leading-tight break-words">{value}</span>
      {hint && <span className="text-[10px] text-muted-foreground leading-tight truncate">{hint}</span>}
    </div>
  );
}


export default function ProxyAgentCommandCenter() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const agentId = user?.id ?? null;

  const [tab, setTab] = useState<'partners' | 'notes'>('partners');
  const [mainTab, setMainTab] = useState<'share' | 'notes' | 'more'>('share');


  // Partner list controls
  const [pSearch, setPSearch] = useState('');
  const [pFilter, setPFilter] = useState<'all' | 'came_in' | 'returning' | 'not_yet'>('all');
  const [pSort, setPSort] = useState<'linked_at' | 'name' | 'funded' | 'portfolios'>('linked_at');
  const [pDir, setPDir] = useState<'asc' | 'desc'>('desc');
  const [pPage, setPPage] = useState(0);

  // Note list controls
  const [nSearch, setNSearch] = useState('');
  const [nStatus, setNStatus] = useState<'all' | 'pending' | 'activated'>('all');
  const [nSort, setNSort] = useState<'created_at' | 'amount' | 'partner' | 'status'>('created_at');
  const [nDir, setNDir] = useState<'asc' | 'desc'>('desc');
  const [nPage, setNPage] = useState(0);

  // Dialog / sheet state
  const [noteOpen, setNoteOpen] = useState(false);
  const [supportModeOpen, setSupportModeOpen] = useState(false);
  const [supportMode, setSupportMode] = useState<SupportMode>('self');
  const [houseOppsOpen, setHouseOppsOpen] = useState(false);

  // WhatsApp-style partner conversation
  const [chatContact, setChatContact] = useState<PartnerContact | null>(null);
  const [chatOpen, setChatOpen] = useState(false);
  const openChat = useCallback((c: PartnerContact) => {
    hapticTap();
    setChatContact(c);
    setChatOpen(true);
  }, []);



  const [withdrawOpen, setWithdrawOpen] = useState(false);
  const [reportsOpen, setReportsOpen] = useState(false);
  const [inviting, setInviting] = useState(false);
  const [inviteSheetOpen, setInviteSheetOpen] = useState(false);
  const [inviteUrl, setInviteUrl] = useState<string | null>(null);
  const [inviteCopied, setInviteCopied] = useState(false);

  const summaryQ = useProxyCommandCenterSummary(agentId);
  const partnersQ = useProxyPartnerList({
    agentId, search: pSearch, filter: pFilter, sort: pSort, dir: pDir, page: pPage, pageSize: PAGE_SIZE,
  });
  const notesQ = useProxyNoteList({
    agentId, search: nSearch, status: nStatus, sort: nSort, dir: nDir, page: nPage, pageSize: PAGE_SIZE,
  });

  const s = summaryQ.data;

  const refreshAll = useCallback(() => {
    hapticTap();
    void summaryQ.refetch();
    void partnersQ.refetch();
    void notesQ.refetch();
  }, [summaryQ, partnersQ, notesQ]);

  /** Log the share and hand back the attributed onboarding link. */
  const buildInviteLink = useCallback(async (channel: string) => {
    const { data, error } = await supabase.rpc('log_proxy_partner_invite', {
      p_channel: channel,
      p_invitee_name: null,
      p_invitee_phone: null,
    });
    if (error) throw new Error(error.message);
    const payload = data as unknown as { path: string; code: string };
    const longUrl = `${getPublicOrigin()}${payload.path}`;

    // Always hand out a short branded link (/r/<code>) — never the raw
    // query-string onboarding URL. Falls back to the long form only if the
    // short-link row cannot be created.
    try {
      const parsed = new URL(longUrl);
      const params: Record<string, string> = {};
      parsed.searchParams.forEach((v, k) => { params[k] = v; });
      const short = await createShortLink(agentId!, parsed.pathname, params);
      return { url: short, code: payload.code };
    } catch {
      return { url: longUrl, code: payload.code };
    }
  }, [agentId]);

  /**
   * iOS Safari revokes the user gesture once you `await`, so `window.open` /
   * `navigator.share` are blocked when they run after the invite RPC. The
   * Invite button therefore only opens a sheet (synchronous); the link is
   * generated once inside the sheet and every share action then fires
   * directly from the user's tap on the already-resolved URL — and the invite
   * is logged once, not once per share attempt.
   */
  const openInviteSheet = useCallback(() => {
    hapticTap();
    setInviteSheetOpen(true);
  }, []);

  const inviteRequested = useRef(false);

  useEffect(() => {
    if (!inviteSheetOpen || inviteRequested.current) return;
    inviteRequested.current = true;
    setInviting(true);
    buildInviteLink('link')
      .then(({ url }) => {
        setInviteUrl(url);
        void summaryQ.refetch();
      })
      .catch((e) => {
        inviteRequested.current = false;
        toast.error(e instanceof Error ? e.message : 'Could not create the invite link');
      })
      .finally(() => setInviting(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inviteSheetOpen]);

  const inviteMessage = inviteUrl
    ? `Join Welile as a partner and start earning monthly returns. Register here: ${inviteUrl}`
    : '';

  const handleInviteWhatsApp = useCallback(() => {
    if (!inviteUrl) return;
    hapticTap();
    // Same-tab navigation: iOS blocks new windows far more aggressively.
    window.location.href = `https://wa.me/?text=${encodeURIComponent(inviteMessage)}`;
  }, [inviteUrl, inviteMessage]);

  const handleInviteNativeShare = useCallback(() => {
    if (!inviteUrl) return;
    hapticTap();
    if (typeof navigator !== 'undefined' && navigator.share) {
      // Fired straight from the tap — keeps the iOS transient activation.
      navigator
        .share({ title: 'Join Welile as a partner', text: inviteMessage, url: inviteUrl })
        .catch(() => { /* user dismissed the share sheet */ });
      return;
    }
    void navigator.clipboard?.writeText(inviteUrl);
    toast.success('Partner invite link copied');
  }, [inviteUrl, inviteMessage]);

  const handleCopyInvite = useCallback(async () => {
    if (!inviteUrl) { openInviteSheet(); return; }
    try {
      await navigator.clipboard.writeText(inviteUrl);
      setInviteCopied(true);
      setTimeout(() => setInviteCopied(false), 2000);
      toast.success('Partner invite link copied');
    } catch {
      toast.error('Could not copy the link');
    }
  }, [inviteUrl, openInviteSheet]);

  const exportCsv = useCallback(() => {
    const rows: string[] = [];
    if (tab === 'partners') {
      rows.push('Partner,Phone,Linked on,Portfolios,Total funded (UGX),Came in,Returning,Notes,Sources');
      (partnersQ.data?.rows ?? []).forEach((r) => {
        rows.push([
          `"${r.partner_name}"`, r.partner_phone, format(new Date(r.linked_at), 'yyyy-MM-dd'),
          r.portfolios, Number(r.total_funded), r.came_in ? 'Yes' : 'No',
          r.is_returning ? 'Yes' : 'No', r.notes_count, `"${(r.sources ?? []).join(' | ')}"`,
        ].join(','));
      });
    } else {
      rows.push('Partner,WhatsApp,Amount (UGX),Type,Status,Collected (UGX),Linked partner,Came in,Created');
      (notesQ.data?.rows ?? []).forEach((r) => {
        rows.push([
          `"${r.partner_name}"`, r.whatsapp_number ?? '', Number(r.amount),
          r.contribution_type ?? '', r.status, Number(r.total_collected),
          `"${r.linked_partner_name ?? 'Not linked'}"`, r.partner_came_in ? 'Yes' : 'No',
          format(new Date(r.created_at), 'yyyy-MM-dd'),
        ].join(','));
      });
    }
    const blob = new Blob([rows.join('\n')], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `proxy-${tab}-${format(new Date(), 'yyyy-MM-dd')}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  }, [tab, partnersQ.data, notesQ.data]);

  const quickActions = useMemo(() => ([
    { key: 'note', label: 'Promissory', icon: FileText, onClick: () => { hapticTap(); setSupportModeOpen(true); } },
    { key: 'reports', label: 'Reports', icon: BarChart3, onClick: () => { hapticTap(); setReportsOpen(true); } },
    { key: 'invite', label: 'Invite', icon: Share2, onClick: openInviteSheet },
    { key: 'withdraw', label: 'Withdraw', icon: Wallet, onClick: () => { hapticTap(); setWithdrawOpen(true); } },
  ]), [openInviteSheet]);

  const partnerTotal = partnersQ.data?.total ?? 0;
  const noteTotal = notesQ.data?.total ?? 0;
  const partnerPages = Math.max(1, Math.ceil(partnerTotal / PAGE_SIZE));
  const notePages = Math.max(1, Math.ceil(noteTotal / PAGE_SIZE));

  return (
    <div className="min-h-screen bg-background pb-24">
      {/* Header */}
      <header className="sticky top-0 z-30 bg-background/95 backdrop-blur border-b border-border">
        <div className="flex items-center gap-2 px-3 py-3">
          <Button variant="ghost" size="icon" onClick={() => navigate(-1)} aria-label="Go back">
            <ArrowLeft className="h-5 w-5" />
          </Button>
          <div className="min-w-0 flex-1">
            <h1 className="text-base font-black leading-tight truncate">Proxy Command Center</h1>
            <p className="text-[11px] text-muted-foreground truncate">Partners · notes · commissions</p>
          </div>
          <Button variant="ghost" size="icon" onClick={refreshAll} aria-label="Refresh">
            <RefreshCw className={cn('h-4 w-4', summaryQ.isFetching && 'animate-spin')} />
          </Button>
        </div>
      </header>

      <main className="px-3 pt-3 space-y-3">
        <Tabs
          value={tab === 'notes' ? 'notes' : mainTab}
          onValueChange={(v) => {
            setMainTab(v as 'share' | 'notes' | 'more');
            setTab(v === 'notes' ? 'notes' : 'partners');
          }}
        >
          <TabsList className="sticky top-[57px] z-20 grid w-full grid-cols-3">
            <TabsTrigger value="share">Share link</TabsTrigger>
            <TabsTrigger value="notes">Promissory ({noteTotal})</TabsTrigger>
            <TabsTrigger value="more">More</TabsTrigger>
          </TabsList>

          {/* ---------------- SHARE LINK TO ONBOARD ---------------- */}
          <TabsContent value="share" className="space-y-3 pt-3">
            <ProxyPerformanceSection />
            <ProxySupportOpportunities />
            <ProxyTargetModeCard agentId={agentId} />
            {summaryQ.isLoading ? (

              <Skeleton className="h-56 rounded-2xl" />
            ) : summaryQ.error ? (
              <Card><CardContent className="p-4 text-sm text-destructive">
                {(summaryQ.error as Error).message}
              </CardContent></Card>
            ) : s ? (
              <Card className="border-primary/30 shadow-sm bg-card">
                <CardContent className="p-4 space-y-3">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex items-center gap-1.5 text-primary">
                        <Target className="h-3.5 w-3.5" />
                        <span className="text-[10px] font-semibold uppercase tracking-wider">
                          Your monthly target
                        </span>
                      </div>
                      <p className="mt-1 text-2xl font-semibold leading-none">
                        {s.partners.this_month}
                        <span className="text-base font-normal text-muted-foreground">
                          {' '}/ {s.targets.monthly_partner_target} partners
                        </span>
                      </p>
                      <p className="mt-1 text-[11px] text-muted-foreground">Set by Partner Ops</p>
                    </div>
                    <Badge variant="outline" className="shrink-0 border-primary/30 text-primary text-[10px]">
                      {s.targets.month_progress_pct}%
                    </Badge>
                  </div>

                  <Progress value={s.targets.month_progress_pct} className="h-1.5" />

                  <div className="grid grid-cols-3 divide-x divide-border rounded-lg border border-border">
                    {[
                      { label: 'Today', value: s.partners.today },
                      { label: 'This week', value: s.partners.this_week },
                      { label: 'This month', value: s.partners.this_month },
                    ].map((c) => (
                      <div key={c.label} className="px-2 py-2 text-center">
                        <div className="text-base font-semibold leading-none">{c.value}</div>
                        <div className="mt-1 text-[10px] uppercase tracking-wider text-muted-foreground">{c.label}</div>
                      </div>
                    ))}
                  </div>

                  <div className="flex gap-2">
                    <Button onClick={openInviteSheet} className="flex-1 h-11 gap-2 font-semibold">
                      {inviting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Share2 className="h-4 w-4" />}
                      Share partner link
                    </Button>
                    <Button variant="outline" onClick={handleCopyInvite} className="h-11 gap-2">
                      <Copy className="h-4 w-4" />
                      {inviteCopied ? 'Copied' : 'Copy'}
                    </Button>
                  </div>
                </CardContent>
              </Card>
            ) : null}

            <details className="rounded-lg border border-border bg-card">
              <summary className="cursor-pointer px-4 py-3 text-xs font-semibold">
                My partners ({partnerTotal})
              </summary>
              <div className="space-y-2 border-t border-border p-3">
            <div className="flex gap-2">

              <div className="relative flex-1">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                <Input
                  value={pSearch}
                  onChange={(e) => { setPSearch(e.target.value); setPPage(0); }}
                  placeholder="Search partner name or phone"
                  className="pl-9 h-10"
                />
              </div>
              <Button variant="outline" onClick={openInviteSheet} className="h-10 gap-2 shrink-0">
                {inviting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Share2 className="h-4 w-4" />}
                <span className="hidden sm:inline">Share link</span>
              </Button>
            </div>

            <div className="flex gap-2 overflow-x-auto no-scrollbar">
              {([
                { key: 'all', label: 'All' },
                { key: 'came_in', label: 'Came in' },
                { key: 'returning', label: 'Returning' },
                { key: 'not_yet', label: 'Not yet funded' },
              ] as const).map((f) => (
                <button
                  key={f.key}
                  onClick={() => { setPFilter(f.key); setPPage(0); }}
                  className={cn(
                    'shrink-0 rounded-full border px-3 py-1.5 text-[11px] font-bold',
                    pFilter === f.key ? 'bg-primary text-primary-foreground border-primary' : 'bg-card border-border',
                  )}
                >{f.label}</button>
              ))}
              <button
                onClick={() => setPDir((d) => (d === 'asc' ? 'desc' : 'asc'))}
                className="shrink-0 rounded-full border border-border bg-card px-3 py-1.5 text-[11px] font-bold flex items-center gap-1"
              ><ArrowUpDown className="h-3 w-3" />{pDir === 'asc' ? 'Asc' : 'Desc'}</button>
              {(['linked_at', 'name', 'funded', 'portfolios'] as const).map((sk) => (
                <button
                  key={sk}
                  onClick={() => { setPSort(sk); setPPage(0); }}
                  className={cn(
                    'shrink-0 rounded-full border px-3 py-1.5 text-[11px] font-bold capitalize',
                    pSort === sk ? 'bg-foreground text-background border-foreground' : 'bg-card border-border',
                  )}
                >{sk === 'linked_at' ? 'Recent' : sk}</button>
              ))}
            </div>

            {partnersQ.isLoading ? (
              <div className="space-y-2">{Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-20 rounded-2xl" />)}</div>
            ) : partnersQ.error ? (
              <Card><CardContent className="p-4 text-sm text-destructive">{(partnersQ.error as Error).message}</CardContent></Card>
            ) : (partnersQ.data?.rows.length ?? 0) === 0 ? (
              <Card><CardContent className="p-6 text-center text-sm text-muted-foreground">No partners match this view yet.</CardContent></Card>
            ) : (
              <Card className="overflow-hidden divide-y">
                {partnersQ.data!.rows.map((p: ProxyPartnerRow) => {
                  const dialable = hasDialablePhone(p.partner_phone);
                  const intl = toIntlDigits(p.partner_phone);
                  return (
                    <button
                      key={p.partner_user_id}
                      onClick={() => openChat({
                        partnerUserId: p.partner_user_id,
                        name: p.partner_name,
                        phone: p.partner_phone,
                        subtitle: `${money(p.total_funded)} funded · ${p.notes_count} notes`,
                      })}
                      className="w-full flex items-center gap-3 px-3 py-3 text-left hover:bg-accent/50 transition-colors"
                    >
                      <div className="h-11 w-11 shrink-0 rounded-full bg-primary/15 text-primary grid place-items-center text-sm font-black">
                        {initialsOf(p.partner_name)}
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <p className="text-sm font-bold truncate">{p.partner_name}</p>
                          <span className="ml-auto shrink-0 text-[10px] text-muted-foreground">
                            {format(new Date(p.linked_at), 'dd MMM')}
                          </span>
                        </div>
                        <p className="text-[11px] text-muted-foreground truncate">
                          {p.partner_phone || 'No phone on file'}
                        </p>
                        <div className="mt-1 flex items-center gap-1.5">
                          <span className={cn(
                            'rounded-full px-2 py-0.5 text-[10px] font-bold',
                            p.is_returning ? 'bg-emerald-500/15 text-emerald-600'
                              : p.came_in ? 'bg-primary/10 text-primary' : 'bg-muted text-muted-foreground',
                          )}>
                            {p.is_returning ? 'Returning' : p.came_in ? 'Came in' : 'Not yet funded'}
                          </span>
                          <span className="text-[10px] text-muted-foreground truncate">
                            {money(p.total_funded)} · {p.portfolios} portfolios · {p.notes_count} notes
                          </span>
                        </div>
                      </div>
                      <div className="flex items-center gap-1.5 shrink-0" onClick={(e) => e.stopPropagation()}>
                        <a
                          href={dialable ? `tel:+${intl}` : undefined}
                          aria-disabled={!dialable}
                          aria-label={`Call ${p.partner_name}`}
                          className={cn(
                            'grid place-items-center h-9 w-9 rounded-full border border-border bg-background',
                            !dialable && 'opacity-40 pointer-events-none',
                          )}
                        >
                          <Phone className="h-4 w-4 text-primary" />
                        </a>
                        <a
                          href={dialable ? `https://wa.me/${intl}` : undefined}
                          target="_blank"
                          rel="noopener noreferrer"
                          aria-disabled={!dialable}
                          aria-label={`WhatsApp ${p.partner_name}`}
                          className={cn(
                            'grid place-items-center h-9 w-9 rounded-full bg-[hsl(142,70%,45%)] text-white',
                            !dialable && 'opacity-40 pointer-events-none',
                          )}
                        >
                          <MessageCircle className="h-4 w-4" />
                        </a>
                      </div>
                    </button>
                  );
                })}
              </Card>
            )}


            <Pager page={pPage} pages={partnerPages} total={partnerTotal} onChange={setPPage} />
              </div>
            </details>
          </TabsContent>

          {/* ---------------- REGISTER PROMISSORY NOTES ---------------- */}
          <TabsContent value="notes" className="space-y-2 pt-3">
            <Card className="border-primary/30">
              <CardContent className="p-4 space-y-3">
                <div>
                  <p className="text-sm font-semibold">Register a promissory note</p>
                  <p className="text-[11px] text-muted-foreground">
                    Record a partner commitment and earn your note reward once it is activated.
                  </p>
                </div>
                <div className="flex gap-2">
                  <Button
                    className="flex-1 h-11 gap-2 font-semibold"
                    onClick={() => { hapticTap(); setSupportModeOpen(true); }}
                  >
                    <FileText className="h-4 w-4" /> New promissory note
                  </Button>
                  <Button variant="outline" onClick={openInviteSheet} className="h-11 gap-2">
                    {inviting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Share2 className="h-4 w-4" />}
                    <span className="hidden sm:inline">Share link</span>
                  </Button>
                </div>
              </CardContent>
            </Card>

            <div className="flex gap-2">

              <div className="relative flex-1">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                <Input
                  value={nSearch}
                  onChange={(e) => { setNSearch(e.target.value); setNPage(0); }}
                  placeholder="Search note partner or phone"
                  className="pl-9 h-10"
                />
              </div>
              <Button variant="outline" onClick={openInviteSheet} className="h-10 gap-2 shrink-0">
                {inviting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Share2 className="h-4 w-4" />}
                <span className="hidden sm:inline">Share link</span>
              </Button>
            </div>

            <div className="flex gap-2 overflow-x-auto no-scrollbar">
              {([
                { key: 'all', label: 'All' },
                { key: 'pending', label: 'Pending' },
                { key: 'activated', label: 'Activated' },
              ] as const).map((f) => (
                <button
                  key={f.key}
                  onClick={() => { setNStatus(f.key); setNPage(0); }}
                  className={cn(
                    'shrink-0 rounded-full border px-3 py-1.5 text-[11px] font-bold',
                    nStatus === f.key ? 'bg-primary text-primary-foreground border-primary' : 'bg-card border-border',
                  )}
                >{f.label}</button>
              ))}
              <button
                onClick={() => setNDir((d) => (d === 'asc' ? 'desc' : 'asc'))}
                className="shrink-0 rounded-full border border-border bg-card px-3 py-1.5 text-[11px] font-bold flex items-center gap-1"
              ><ArrowUpDown className="h-3 w-3" />{nDir === 'asc' ? 'Asc' : 'Desc'}</button>
              {(['created_at', 'amount', 'partner', 'status'] as const).map((sk) => (
                <button
                  key={sk}
                  onClick={() => { setNSort(sk); setNPage(0); }}
                  className={cn(
                    'shrink-0 rounded-full border px-3 py-1.5 text-[11px] font-bold capitalize',
                    nSort === sk ? 'bg-foreground text-background border-foreground' : 'bg-card border-border',
                  )}
                >{sk === 'created_at' ? 'Recent' : sk}</button>
              ))}
            </div>

            {notesQ.isLoading ? (
              <div className="space-y-2">{Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-20 rounded-2xl" />)}</div>
            ) : notesQ.error ? (
              <Card><CardContent className="p-4 text-sm text-destructive">{(notesQ.error as Error).message}</CardContent></Card>
            ) : (notesQ.data?.rows.length ?? 0) === 0 ? (
              <Card><CardContent className="p-6 text-center text-sm text-muted-foreground">No promissory notes yet.</CardContent></Card>
            ) : (
              notesQ.data!.rows.map((n: ProxyNoteRow) => (
                <Card key={n.id}>
                  <CardContent className="p-3 space-y-2">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="text-sm font-black truncate">{n.partner_name}</p>
                        <p className="text-[11px] text-muted-foreground">{n.whatsapp_number ?? n.phone_number ?? '—'}</p>
                      </div>
                      <Badge variant="outline" className={cn('shrink-0 text-[10px] capitalize', noteStatusTone[n.status] ?? '')}>
                        {n.status}
                      </Badge>
                    </div>
                    <div className="grid grid-cols-2 gap-2 text-[11px]">
                      <div className="rounded-lg bg-muted/40 px-2 py-1.5">
                        <div className="text-muted-foreground">Committed</div>
                        <div className="font-black break-words">{money(n.amount)}</div>
                      </div>
                      <div className="rounded-lg bg-muted/40 px-2 py-1.5">
                        <div className="text-muted-foreground">Collected</div>
                        <div className="font-black break-words">{money(n.total_collected)}</div>
                      </div>
                    </div>
                    <div className="flex items-center justify-between gap-2">
                      <span className={cn(
                        'rounded-full px-2 py-0.5 text-[10px] font-bold',
                        n.partner_user_id ? 'bg-emerald-500/10 text-emerald-600' : 'bg-muted text-muted-foreground',
                      )}>
                        {n.partner_user_id
                          ? `Linked: ${n.linked_partner_name ?? 'partner account'}${n.partner_came_in ? ' · came in' : ''}`
                          : 'Partner has not registered yet'}
                      </span>
                      <span className="text-[10px] text-muted-foreground shrink-0">
                        {format(new Date(n.created_at), 'dd MMM yyyy')}
                      </span>
                    </div>
                    {(() => {
                      const raw = n.whatsapp_number ?? n.phone_number ?? '';
                      const dialable = hasDialablePhone(raw);
                      const intl = toIntlDigits(raw);
                      return (
                        <div className="flex items-center gap-2 pt-1">
                          <a
                            href={dialable ? `https://wa.me/${intl}` : undefined}
                            target="_blank"
                            rel="noopener noreferrer"
                            aria-disabled={!dialable}
                            className={cn(
                              'flex-1 inline-flex items-center justify-center gap-1.5 h-9 rounded-xl bg-[hsl(142,70%,45%)] text-white text-[11px] font-bold',
                              !dialable && 'opacity-40 pointer-events-none',
                            )}
                          >
                            <MessageCircle className="h-3.5 w-3.5" /> WhatsApp
                          </a>
                          <a
                            href={dialable ? `tel:+${intl}` : undefined}
                            aria-disabled={!dialable}
                            className={cn(
                              'flex-1 inline-flex items-center justify-center gap-1.5 h-9 rounded-xl border border-border bg-background text-[11px] font-bold',
                              !dialable && 'opacity-40 pointer-events-none',
                            )}
                          >
                            <Phone className="h-3.5 w-3.5 text-primary" /> Call
                          </a>
                          <button
                            onClick={() => openChat({
                              partnerUserId: n.partner_user_id,
                              name: n.linked_partner_name ?? n.partner_name,
                              phone: raw,
                              subtitle: `Note ${money(n.amount)}`,
                            })}
                            className="flex-1 inline-flex items-center justify-center gap-1.5 h-9 rounded-xl border border-border bg-background text-[11px] font-bold"
                          >
                            <StickyNote className="h-3.5 w-3.5" /> Notes
                          </button>
                        </div>
                      );
                    })()}

                  </CardContent>
                </Card>
              ))
            )}

            <Pager page={nPage} pages={notePages} total={noteTotal} onChange={setNPage} />
          </TabsContent>

          {/* ---------------- MORE (drill deeper) ---------------- */}
          <TabsContent value="more" className="space-y-3 pt-3">
            {summaryQ.isLoading ? (
              <div className="grid grid-cols-2 gap-2">
                {Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-20 rounded-2xl" />)}
              </div>
            ) : summaryQ.error ? (
              <Card><CardContent className="p-4 text-sm text-destructive">
                {(summaryQ.error as Error).message}
              </CardContent></Card>
            ) : s ? (
              <>
                <div className="grid grid-cols-4 gap-2">
                  {quickActions.map((a) => (
                    <button
                      key={a.key}
                      onClick={a.onClick}
                      className="flex flex-col items-center justify-center gap-1 rounded-lg border border-border bg-card px-2 py-2.5 text-[10px] font-medium text-foreground hover:bg-muted/60 active:scale-[0.98] transition"
                    >
                      {a.key === 'invite' && inviting
                        ? <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                        : <a.icon className="h-4 w-4 text-muted-foreground" />}
                      {a.label}
                    </button>
                  ))}
                </div>

                <Card>
                  <CardContent className="p-0 grid grid-cols-2 divide-x divide-y divide-border sm:grid-cols-4">
                    <Metric icon={Users} label="Partners" value={String(s.partners.onboarded)}
                      hint={`${s.invites.shared} invites shared`} />
                    <Metric icon={UserCheck} label="Came in" value={String(s.partners.came_in)}
                      hint={money(s.partners.total_funded)} />
                    <Metric icon={Repeat} label="Returning" value={String(s.partners.returning)}
                      hint="2+ portfolios" />
                    <Metric icon={FileText} label="Promissory" value={String(s.notes.total)}
                      hint={`${s.notes.pending} pending · ${money(s.notes.total_amount)}`} />
                    <Metric icon={HandCoins} label="Pending" value={money(s.pending_commission.amount)}
                      hint={`${s.pending_commission.pending_notes} × ${money(s.pending_commission.rate_per_note)}`} />
                    <Metric icon={BarChart3} label="Earnings" value={money(s.earnings.total)}
                      hint={`${money(s.commission.this_month)} this month`} />
                    <Metric icon={Wallet} label="Withdrawable" value={money(s.earnings.withdrawable)}
                      hint="Earned commission" />
                    <Metric icon={Target} label="Target" value={`${s.partners.this_month}/${s.targets.monthly_partner_target}`}
                      hint="This month" />
                  </CardContent>
                </Card>

                <Card>
                  <CardContent className="p-4 space-y-2">
                    <div className="flex items-center justify-between">
                      <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                        Commission breakdown
                      </span>
                      <span className="text-[10px] text-muted-foreground">Lifetime</span>
                    </div>
                    <div className="space-y-1">
                      {[
                        { label: `Funding (${s.rates.investment_commission_pct}%)`, value: s.commission.two_percent },
                        { label: `Partner deposit (${s.rates.partner_deposit_commission_pct}%)`, value: s.commission.one_percent },
                        { label: `Promissory notes (${money(s.rates.note_reward)} each)`, value: s.commission.note_rewards },
                      ].map((row) => (
                        <div key={row.label} className="flex items-start justify-between gap-3 border-b border-border/60 py-1.5 last:border-0">
                          <span className="text-xs text-muted-foreground leading-snug">{row.label}</span>
                          <span className="text-xs font-semibold text-right break-words">{money(row.value)}</span>
                        </div>
                      ))}
                      <div className="flex items-center justify-between pt-1.5">
                        <span className="text-xs font-semibold">Total commission</span>
                        <span className="text-sm font-semibold text-primary">{money(s.commission.total)}</span>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              </>
            ) : null}
          </TabsContent>
        </Tabs>

      </main>

      {/* Dialogs */}
      <SupportModeChooserDialog
        open={supportModeOpen}
        onOpenChange={setSupportModeOpen}
        onSelect={(mode) => {
          setSupportMode(mode);
          setSupportModeOpen(false);
          if (mode === 'self') setHouseOppsOpen(true);
          else setNoteOpen(true);
        }}
      />
      <EmptyHouseOpportunitiesSheet
        open={houseOppsOpen}
        onOpenChange={(o) => { setHouseOppsOpen(o); if (!o) refreshAll(); }}
      />
      <PromissoryNoteDialog
        supportMode={supportMode}
        open={noteOpen}
        onOpenChange={(o) => { setNoteOpen(o); if (!o) refreshAll(); }}
      />

      <WithdrawRequestDialog
        open={withdrawOpen}
        onOpenChange={setWithdrawOpen}
        walletBalance={s?.earnings.withdrawable ?? 0}
        onSuccess={refreshAll}
      />

      {/* Reports */}
      <Sheet open={reportsOpen} onOpenChange={setReportsOpen}>
        <SheetContent side="bottom" className="max-h-[92vh] overflow-y-auto">
          <SheetHeader className="text-left">
            <SheetTitle>My proxy reports</SheetTitle>
            <SheetDescription>Live figures straight from the ledger</SheetDescription>
          </SheetHeader>
          <div className="space-y-3 pt-3">
            {s && (
              <Card><CardContent className="p-3 space-y-1.5">
                {[
                  ['Onboarded partners', String(s.partners.onboarded)],
                  ['Partners who came in', String(s.partners.came_in)],
                  ['Returning partners', String(s.partners.returning)],
                  ['Capital raised', money(s.partners.total_funded)],
                  ['Promissory notes', `${s.notes.total} (${s.notes.pending} pending)`],
                  ['Notes value', money(s.notes.total_amount)],
                  ['Funding commission', money(s.commission.two_percent)],
                  ['Partner deposit commission', money(s.commission.one_percent)],
                  ['Promissory note rewards', money(s.commission.note_rewards)],
                  ['Pending commission', money(s.pending_commission.amount)],
                  ['Total earnings', money(s.commission.total)],
                  ['Withdrawable balance', money(s.earnings.withdrawable)],
                  ['Invites shared / converted', `${s.invites.shared} / ${s.invites.converted}`],
                ].map(([k, v]) => (
                  <div key={k} className="flex items-start justify-between gap-3 border-b border-border/50 pb-1.5 last:border-0">
                    <span className="text-[11px] text-muted-foreground">{k}</span>
                    <span className="text-xs font-black text-right break-words">{v}</span>
                  </div>
                ))}
              </CardContent></Card>
            )}
            <div className="flex gap-2">
              <Button variant="outline" className="flex-1" onClick={exportCsv}>
                <Download className="mr-2 h-4 w-4" /> Export {tab === 'partners' ? 'partners' : 'notes'} CSV
              </Button>
              <Button variant="outline" className="flex-1" onClick={handleCopyInvite}>
                <Copy className="mr-2 h-4 w-4" /> Copy invite link
              </Button>
            </div>
          </div>
        </SheetContent>
      </Sheet>

      {/* Invite share sheet — opens instantly, link resolves inside */}
      <Sheet open={inviteSheetOpen} onOpenChange={setInviteSheetOpen}>
        <SheetContent side="bottom" className="rounded-t-2xl pb-8">
          <SheetHeader className="pb-3 text-left">
            <SheetTitle className="flex items-center gap-2 text-base">
              <Share2 className="h-4 w-4 text-primary" /> Share partner invite
            </SheetTitle>
            <SheetDescription className="text-xs">
              Your attributed onboarding link. Every partner who registers through it is linked to you.
            </SheetDescription>
          </SheetHeader>

          <div className="space-y-3">
            <Input
              readOnly
              value={inviteUrl ?? (inviting ? 'Generating your link…' : 'Preparing…')}
              className="h-10 text-xs font-mono"
            />
            <div className="grid grid-cols-2 gap-2">
              <Button
                onClick={handleInviteWhatsApp}
                disabled={!inviteUrl}
                className="h-12 gap-2 font-semibold"
              >
                {inviting && !inviteUrl ? <Loader2 className="h-4 w-4 animate-spin" /> : <Share2 className="h-4 w-4" />}
                WhatsApp
              </Button>
              <Button
                variant="outline"
                onClick={handleInviteNativeShare}
                disabled={!inviteUrl}
                className="h-12 gap-2 font-semibold"
              >
                <Share2 className="h-4 w-4" /> Share
              </Button>
            </div>
            <Button
              variant="ghost"
              onClick={handleCopyInvite}
              disabled={!inviteUrl}
              className="w-full gap-2"
            >
              <Copy className="h-4 w-4" /> {inviteCopied ? 'Copied' : 'Copy link'}
            </Button>
          </div>
        </SheetContent>
      </Sheet>

      <PartnerContactChatSheet
        open={chatOpen}
        onOpenChange={setChatOpen}
        contact={chatContact}
        agentId={agentId}
      />
    </div>

  );
}


function Pager({
  page, pages, total, onChange,
}: { page: number; pages: number; total: number; onChange: (p: number) => void }) {
  if (total === 0) return null;
  return (
    <div className="flex items-center justify-between pt-1">
      <Button variant="outline" size="sm" disabled={page === 0} onClick={() => onChange(page - 1)}>
        <ChevronLeft className="h-4 w-4" /> Prev
      </Button>
      <span className="text-[11px] text-muted-foreground">
        Page {page + 1} of {pages} · {total} records
      </span>
      <Button variant="outline" size="sm" disabled={page + 1 >= pages} onClick={() => onChange(page + 1)}>
        Next <ChevronRight className="h-4 w-4" />
      </Button>
    </div>
  );
}