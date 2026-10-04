import { useState, useEffect, useMemo, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { UserAvatar } from '@/components/UserAvatar';
import { cn } from '@/lib/utils';
import { hapticTap } from '@/lib/haptics';
import { format } from 'date-fns';
import { getPublicOrigin } from '@/lib/getPublicOrigin';
import { createShortLink } from '@/lib/createShortLink';
import { useAgentBalances } from '@/hooks/useAgentBalances';
import { formatDynamic } from '@/lib/currencyFormat';
import {
  ArrowLeft, Users, UserCheck, Activity, Search,
  Share2, FileText, Heart, Briefcase, PiggyBank, HandCoins,
  Loader2, ChevronRight, Zap, RefreshCw, Phone, Wallet, Share2 as ShareIcon,
} from 'lucide-react';

// Lazy imports for dialogs
import { AgentInvestForPartnerDialog } from '@/components/agent/AgentInvestForPartnerDialog';
import { AgentAngelPoolInvestDialog } from '@/components/agent/AgentAngelPoolInvestDialog';
import { PromissoryNoteDialog } from '@/components/agent/PromissoryNoteDialog';
import { AgentPromissoryNotesList } from '@/components/agent/AgentPromissoryNotesList';
import { ProxyPartnerDepositDialog } from '@/components/agent/ProxyPartnerDepositDialog';

interface PartnerItem {
  id: string;
  userId: string | null;
  name: string;
  phone: string;
  avatarUrl: string | null;
  invitedDate: string;
  status: 'active' | 'pending' | 'matured' | 'payout' | 'cancelled';
  isProxy: boolean;
  investedAmount: number;
}

type TabFilter = 'invited' | 'proxy';

const statusConfig: Record<string, { label: string; variant: 'success' | 'warning' | 'primary' | 'muted' | 'destructive' }> = {
  active: { label: 'Active', variant: 'success' },
  pending: { label: 'Pending', variant: 'warning' },
  matured: { label: 'Mature', variant: 'primary' },
  payout: { label: 'Payout', variant: 'muted' },
  cancelled: { label: 'Cancelled', variant: 'destructive' },
};

export default function AgentPartners() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const [partners, setPartners] = useState<PartnerItem[]>([]);
  const [loading, setLoading] = useState(true);
  const PAGE_SIZE = 10;
  const [currentPage, setCurrentPage] = useState(0);
  const [search, setSearch] = useState('');
  const [activeTab, setActiveTab] = useState<TabFilter>('invited');
  const [hasLeadAssignment, setHasLeadAssignment] = useState(true);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const { commissionBalance, isLoading: commissionLoading } = useAgentBalances(user?.id);

  // Dialog states
  const [investForPartnerOpen, setInvestForPartnerOpen] = useState(false);
  const [angelPoolOpen, setAngelPoolOpen] = useState(false);
  const [promissoryNoteOpen, setPromissoryNoteOpen] = useState(false);
  const [promissoryListOpen, setPromissoryListOpen] = useState(false);
  const [depositPartner, setDepositPartner] = useState<{ id: string; full_name: string; phone: string } | null>(null);

  const fetchPartners = useCallback(async () => {
    if (!user) return;
    setLoading(true);

    try {
      // Fetch invited partners (supporter_invites created by this agent)
      const { data: invites } = await supabase
        .from('supporter_invites')
        .select('id, full_name, phone, created_at, status, activated_user_id, role')
        .eq('created_by', user.id)
        .eq('role', 'supporter')
        .order('created_at', { ascending: false });

      // Fetch proxy partner assignments
      const { data: proxyAssignments } = await supabase
        .from('proxy_agent_assignments')
        .select('id, beneficiary_id, created_at, is_active, approval_status')
        .eq('agent_id', user.id)
        // Stale (deactivated) rows must never surface to a proxy agent — when
        // a funder is reassigned the prior row is flipped is_active=false.
        .eq('is_active', true);

      // Fetch portfolio data for this agent's partners
      const { data: portfolios } = await supabase
        .from('investor_portfolios')
        .select('investor_id, investment_amount, status, created_at')
        .eq('agent_id', user.id);

      // Get proxy beneficiary profiles
      const proxyIds = (proxyAssignments || []).map(p => p.beneficiary_id).filter(Boolean);
      let proxyProfiles: Record<string, any> = {};
      if (proxyIds.length > 0) {
        const { data: profiles } = await supabase
          .from('profiles')
          .select('id, full_name, phone, avatar_url')
          .in('id', proxyIds);
        (profiles || []).forEach(p => { proxyProfiles[p.id] = p; });
      }

      // Check whether this agent is currently attached to a lead partner.
      const { data: leadAssignments } = await supabase
        .from('partner_lead_assignments')
        .select('id')
        .eq('agent_id', user.id)
        .is('detached_at', null)
        .limit(1);
      setHasLeadAssignment((leadAssignments || []).length > 0);

      // Build portfolio lookup by investor_id
      const portfolioMap: Record<string, { amount: number; status: string }> = {};
      (portfolios || []).forEach(p => {
        if (!portfolioMap[p.investor_id] || p.investment_amount > portfolioMap[p.investor_id].amount) {
          portfolioMap[p.investor_id] = { amount: Number(p.investment_amount), status: p.status };
        }
      });

      const partnerList: PartnerItem[] = [];

      // Process invited partners
      (invites || []).forEach(inv => {
        const portfolioInfo = inv.activated_user_id ? portfolioMap[inv.activated_user_id] : null;
        let status: PartnerItem['status'] = 'pending';
        if (inv.status === 'activated' && portfolioInfo) {
          status = portfolioInfo.status === 'matured' ? 'matured' : 'active';
        } else if (inv.status === 'activated') {
          status = 'active';
        } else if (inv.status === 'cancelled') {
          status = 'cancelled';
        }

        partnerList.push({
          id: inv.id,
          userId: inv.activated_user_id || null,
          name: inv.full_name || 'Unknown',
          phone: inv.phone || '',
          avatarUrl: null,
          invitedDate: inv.created_at,
          status,
          isProxy: false,
          investedAmount: portfolioInfo?.amount || 0,
        });
      });

      // Process proxy partners (that aren't already in invites)
      const existingPhones = new Set(partnerList.map(p => p.phone));
      (proxyAssignments || []).forEach(pa => {
        const profile = proxyProfiles[pa.beneficiary_id];
        if (!profile || existingPhones.has(profile.phone)) {
          // If already present from invites, mark as proxy
          const existing = partnerList.find(p => p.phone === profile?.phone);
          if (existing) existing.isProxy = true;
          return;
        }

        const portfolioInfo = portfolioMap[pa.beneficiary_id];
        let status: PartnerItem['status'] = pa.approval_status === 'approved' ? 'active' : 'pending';
        if (portfolioInfo?.status === 'matured') status = 'matured';

        partnerList.push({
          id: pa.id,
          userId: pa.beneficiary_id,
          name: profile.full_name || 'Unknown',
          phone: profile.phone || '',
          avatarUrl: profile.avatar_url,
          invitedDate: pa.created_at,
          status,
          isProxy: true,
          investedAmount: portfolioInfo?.amount || 0,
        });
      });

      setPartners(partnerList);
    } catch (err) {
      console.error('Failed to fetch partners:', err);
    } finally {
      setLoading(false);
    }
  }, [user]);

  useEffect(() => {
    fetchPartners();
  }, [fetchPartners]);

  // Filtered partners
  const filtered = useMemo(() => {
    let list = activeTab === 'proxy' ? partners.filter(p => p.isProxy) : partners.filter(p => !p.isProxy);
    if (search.trim()) {
      const q = search.toLowerCase();
      list = list.filter(p => p.name.toLowerCase().includes(q) || p.phone.includes(q));
    }
    return list;
  }, [partners, activeTab, search]);

  // Reset pagination when filter changes
  useEffect(() => {
    setCurrentPage(0);
  }, [activeTab, search]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const paginatedPartners = useMemo(() => filtered.slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE), [filtered, currentPage]);

  // KPIs
  const kpis = useMemo(() => ({
    invited: partners.filter(p => !p.isProxy).length,
    proxy: partners.filter(p => p.isProxy).length,
    active: partners.filter(p => p.status === 'active').length,
    pending: partners.filter(p => p.status === 'pending').length,
  }), [partners]);

  const handleSharePartnerForm = async () => {
    hapticTap();
    const url = `${window.location.origin}/become-supporter?ref=${user?.id}`;
    if (navigator.share) {
      try {
        await navigator.share({ title: 'Become a Partner', text: 'Join as a partner on Welile!', url });
      } catch {}
    } else {
      await navigator.clipboard.writeText(url);
      const { toast } = await import('sonner');
      toast.success('Partner link copied!');
    }
  };

  const handleInviteFunder = async () => {
    hapticTap();
    if (!user?.id) return;
    let url = `${getPublicOrigin()}/funder-onboarding?ref=${user.id}`;
    try {
      url = await createShortLink(user.id, '/funder-onboarding', { ref: user.id });
    } catch {
      // fall back to long link
    }
    const message = `🤝 Join me on Welile as a partner investor!\n\nEarn monthly returns on your investment.\n\n${url}`;
    window.open(`https://wa.me/?text=${encodeURIComponent(message)}`, '_blank');
  };

  const quickActions = [
    { icon: Share2, label: 'Share Form', color: 'text-emerald-500', bg: 'bg-emerald-500/10', onClick: handleSharePartnerForm },
    { icon: FileText, label: 'Promissory', color: 'text-purple-500', bg: 'bg-purple-500/10', onClick: () => setPromissoryNoteOpen(true) },
    { icon: Heart, label: 'Invite', color: 'text-primary', bg: 'bg-primary/10', onClick: handleInviteFunder },
    { icon: HandCoins, label: 'Invest', color: 'text-emerald-600', bg: 'bg-emerald-600/10', onClick: () => setInvestForPartnerOpen(true) },
    { icon: PiggyBank, label: 'Angel Pool', color: 'text-amber-500', bg: 'bg-amber-500/10', onClick: () => setAngelPoolOpen(true) },
    { icon: Briefcase, label: 'Notes', color: 'text-indigo-500', bg: 'bg-indigo-500/10', onClick: () => setPromissoryListOpen(true) },
  ];

  const tabs: { key: TabFilter; label: string; count: number }[] = [
    { key: 'invited', label: 'Invited', count: kpis.invited },
    { key: 'proxy', label: 'Proxy', count: kpis.proxy },
  ];

  return (
    <div className="h-[100dvh] bg-background flex flex-col overflow-hidden">
      {/* Header */}
      <header className="sticky top-0 z-30 bg-background/95 backdrop-blur-md border-b border-border/40 px-4 py-3 flex items-center gap-3">
        <button onClick={() => navigate(-1)} className="p-1.5 -ml-1.5 rounded-lg hover:bg-muted/50 active:scale-95 transition-all">
          <ArrowLeft className="h-5 w-5" />
        </button>
        <h1 className="text-lg font-bold flex-1">My Partners</h1>
        <button onClick={fetchPartners} className="p-2 rounded-lg hover:bg-muted/50 active:scale-95 transition-all">
          <RefreshCw className={cn("h-4 w-4", loading && "animate-spin")} />
        </button>
      </header>

      <div className="flex-1 overflow-y-auto pb-8">
        <div className="px-4 py-4 space-y-4 max-w-lg mx-auto">

          {/* Commission summary (display only, no actions) */}
          <div
            style={{
              borderRadius: '16px',
              padding: '16px 18px',
              background: 'linear-gradient(135deg, hsl(var(--primary) / 0.12), hsl(var(--primary) / 0.03))',
              border: '1px solid hsl(var(--primary) / 0.18)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: '12px',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: '12px', minWidth: 0 }}>
              <div
                style={{
                  width: '40px',
                  height: '40px',
                  borderRadius: '12px',
                  background: 'hsl(var(--primary) / 0.15)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  flexShrink: 0,
                }}
              >
                <Wallet style={{ width: '20px', height: '20px', color: 'hsl(var(--primary))' }} />
              </div>
              <div style={{ minWidth: 0 }}>
                <p style={{ fontSize: '11px', fontWeight: 600, letterSpacing: '0.05em', textTransform: 'uppercase', color: 'hsl(var(--muted-foreground))', margin: 0 }}>
                  My Commission
                </p>
                <p style={{ fontSize: '22px', fontWeight: 700, color: 'hsl(var(--foreground))', margin: '2px 0 0', fontVariantNumeric: 'tabular-nums' }}>
                  {commissionLoading ? '—' : formatDynamic(commissionBalance)}
                </p>
              </div>
            </div>
          </div>

          {/* KPI Cards */}
          <div className="grid grid-cols-3 gap-2.5">
            {[
              { label: 'Pending', value: kpis.pending, icon: Heart, color: 'text-warning', bg: 'bg-warning/10' },
              { label: 'Active', value: kpis.active, icon: Activity, color: 'text-success', bg: 'bg-success/10' },
              { label: 'Proxy', value: kpis.proxy, icon: Zap, color: 'text-primary', bg: 'bg-primary/10' },
            ].map(kpi => (
              <div key={kpi.label} className="rounded-2xl border border-border/60 bg-card p-3.5 text-center space-y-1.5 shadow-sm">
                <div className={cn("mx-auto w-9 h-9 rounded-xl flex items-center justify-center", kpi.bg)}>
                  <kpi.icon className={cn("h-4.5 w-4.5", kpi.color)} />
                </div>
                <p className="text-2xl font-bold tabular-nums">{loading ? '—' : kpi.value}</p>
                <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">{kpi.label}</p>
              </div>
            ))}
          </div>

          {/* Quick Actions */}
          <div className="flex gap-2 overflow-x-auto pb-1 -mx-1 px-1 scrollbar-none">
            {quickActions.map(a => (
              <button
                key={a.label}
                onClick={() => { hapticTap(); a.onClick(); }}
                className={cn(
                  "flex flex-col items-center gap-1.5 min-w-[68px] py-3 px-2 rounded-xl border border-border/40 active:scale-95 transition-all shrink-0",
                  a.bg
                )}
              >
                <a.icon className={cn("h-4.5 w-4.5", a.color)} />
                <span className={cn("text-[10px] font-semibold", a.color)}>{a.label}</span>
              </button>
            ))}
          </div>

          {/* Tabs + Search */}
          <div className="space-y-3">
            <div className="flex gap-1 bg-muted/50 p-1 rounded-xl">
              {tabs.map(tab => (
                <button
                  key={tab.key}
                  onClick={() => { hapticTap(); setActiveTab(tab.key); }}
                  className={cn(
                    "flex-1 py-2 rounded-lg text-xs font-semibold transition-all",
                    activeTab === tab.key
                      ? "bg-background text-foreground shadow-sm"
                      : "text-muted-foreground hover:text-foreground"
                  )}
                >
                  {tab.label} <span className="text-[10px] opacity-70">({tab.count})</span>
                </button>
              ))}
            </div>

            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                value={search}
                onChange={e => setSearch(e.target.value)}
                placeholder="Search by name or phone..."
                className="pl-9 h-10 rounded-xl bg-muted/30 border-border/40"
              />
            </div>
          </div>

          {/* Partner Cards */}
          <div className="space-y-2.5">
            {activeTab === 'proxy' && !hasLeadAssignment && (
              <div className="rounded-2xl border border-border/60 bg-card p-4 shadow-sm space-y-3">
                <div className="flex items-start gap-3">
                  <div className="w-10 h-10 rounded-xl bg-primary/10 flex items-center justify-center shrink-0">
                    <Briefcase className="h-5 w-5 text-primary" />
                  </div>
                  <div>
                    <p className="font-semibold text-sm">Become a proxy agent</p>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      Accept the proxy agent agreement to start submitting promissory notes under a lead partner.
                    </p>
                  </div>
                </div>
                <Button onClick={() => navigate('/pa/none')} className="w-full">
                  Accept agreement
                </Button>
              </div>
            )}
            {loading ? (
              <div className="flex items-center justify-center py-16">
                <Loader2 className="h-6 w-6 animate-spin text-primary" />
              </div>
            ) : filtered.length === 0 ? (
              <div className="text-center py-16 space-y-3">
                <div className="mx-auto w-14 h-14 rounded-2xl bg-muted/50 flex items-center justify-center">
                  <Users className="h-7 w-7 text-muted-foreground/50" />
                </div>
                <div>
                  <p className="font-semibold text-sm">No partners found</p>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    {search ? 'Try a different search' : 'Invite your first partner using the actions above'}
                  </p>
                </div>
              </div>
            ) : (
              paginatedPartners.map(partner => {
                const sc = statusConfig[partner.status] || statusConfig.pending;
                const isExpanded = expandedId === partner.id;
                return (
                  <div
                    key={partner.id}
                    className="rounded-2xl border border-border/60 bg-card shadow-sm hover:shadow-md transition-all overflow-hidden"
                  >
                    <button
                      onClick={() => { hapticTap(); setExpandedId(isExpanded ? null : partner.id); }}
                      className="flex items-center gap-3 p-3.5 w-full text-left active:scale-[0.98] transition-all"
                    >
                      <UserAvatar
                        avatarUrl={partner.avatarUrl}
                        fullName={partner.name}
                        size="md"
                      />

                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-1.5">
                          <p className="font-semibold text-sm truncate">{partner.name}</p>
                          {partner.isProxy && (
                            <Badge variant="outline" size="sm" className="shrink-0 text-[9px] border-primary/30 text-primary bg-primary/5">
                              🔗 Proxy
                            </Badge>
                          )}
                        </div>
                        <p className="text-[11px] text-muted-foreground mt-0.5">
                          {activeTab === 'proxy' ? 'Assigned' : 'Invited'} {format(new Date(partner.invitedDate), 'MMM d, yyyy')}
                        </p>
                      </div>

                      <Badge variant={sc.variant} size="sm" className="shrink-0">
                        {sc.label}
                      </Badge>
                    </button>

                    {/* Expanded actions */}
                    {isExpanded && (
                      <div className="px-3.5 pb-3.5 pt-0 flex items-center gap-2 border-t border-border/30 pt-2.5 animate-in fade-in slide-in-from-top-1 duration-200">
                        <Button
                          variant="default"
                          size="sm"
                          className="flex-1 gap-1.5"
                          onClick={() => {
                            hapticTap();
                            if (partner.userId) {
                              setDepositPartner({
                                id: partner.userId,
                                full_name: partner.name,
                                phone: partner.phone,
                              });
                            }
                          }}
                          disabled={!partner.userId}
                        >
                          <Wallet className="h-3.5 w-3.5" />
                          Deposit
                        </Button>

                        {partner.status === 'pending' && (
                          <Button
                            variant="secondary"
                            size="sm"
                            className="gap-1.5"
                            onClick={async () => {
                              hapticTap();
                              const url = `${window.location.origin}/become-supporter?ref=${user?.id}`;
                              const message = `🤝 Hi ${partner.name}, you've been invited to join Welile as a partner investor!\n\nActivate your account here:\n${url}`;
                              if (navigator.share) {
                                try {
                                  await navigator.share({ title: 'Partner Activation', text: message, url });
                                } catch {}
                              } else {
                                await navigator.clipboard.writeText(`${message}\n${url}`);
                                const { toast } = await import('sonner');
                                toast.success('Activation link copied!');
                              }
                            }}
                          >
                            <ShareIcon className="h-3.5 w-3.5" />
                            Resend
                          </Button>
                        )}

                        {partner.phone && (
                          <Button
                            variant="outline"
                            size="sm"
                            className="gap-1.5"
                            onClick={() => {
                              hapticTap();
                              window.open(`tel:${partner.phone}`, '_self');
                            }}
                          >
                            <Phone className="h-3.5 w-3.5" />
                            Call
                          </Button>
                        )}
                      </div>
                    )}
                  </div>
                );
              })
            )}
            {filtered.length > 0 && (
              <div className="flex items-center justify-between mt-3 gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={currentPage === 0}
                  onClick={() => setCurrentPage(p => p - 1)}
                  className="flex-1 rounded-xl h-10"
                >
                  ← Previous
                </Button>
                <span className="text-xs text-muted-foreground font-mono whitespace-nowrap">
                  {currentPage + 1} / {totalPages}
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={currentPage >= totalPages - 1}
                  onClick={() => setCurrentPage(p => p + 1)}
                  className="flex-1 rounded-xl h-10"
                >
                  Next →
                </Button>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Dialogs */}
      <AgentInvestForPartnerDialog open={investForPartnerOpen} onOpenChange={setInvestForPartnerOpen} onSuccess={fetchPartners} />
      <AgentAngelPoolInvestDialog open={angelPoolOpen} onOpenChange={setAngelPoolOpen} onSuccess={fetchPartners} />
      <PromissoryNoteDialog open={promissoryNoteOpen} onOpenChange={setPromissoryNoteOpen} />
      <AgentPromissoryNotesList open={promissoryListOpen} onOpenChange={setPromissoryListOpen} />
      <ProxyPartnerDepositDialog
        open={!!depositPartner}
        onOpenChange={(open) => { if (!open) setDepositPartner(null); }}
        partner={depositPartner}
        onSuccess={fetchPartners}
      />
    </div>
  );
}
