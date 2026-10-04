import { useParams, useNavigate } from 'react-router-dom';
import { useState } from 'react';
import { motion } from 'framer-motion';
import {
  ArrowLeft, Copy, FileDown, Loader2, AlertTriangle, BadgeCheck, Phone, Mail,
  IdCard, Calendar, TrendingUp, Wallet, Users, Banknote, RefreshCw, MessageCircle, Link as LinkIcon, Trophy, ShieldCheck,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { UserAvatar } from '@/components/UserAvatar';
import { useTrustProfile } from '@/hooks/useTrustProfile';
import { TrustScoreCard } from '@/components/ai-id/TrustScoreCard';
import { TrustBoostSuggestions } from '@/components/ai-id/TrustBoostSuggestions';
import { CashFlowCapacityCard, MovementBehaviorCard, LandlordListingsCard } from '@/components/ai-id/TrustExpansionCards';
import { AiIdBadge } from '@/components/ai-id/AiIdBadge';
import LenderRecordLoanCard from '@/components/vouch/lender/LenderRecordLoanCard';
import MyVouchedLoansCard from '@/components/vouch/borrower/MyVouchedLoansCard';
import BorrowerVouchDisclosureModal from '@/components/vouch/borrower/BorrowerVouchDisclosureModal';
import { useBorrowerVouchDisclosure } from '@/hooks/useBorrowerVouchDisclosure';
import { EarnedVouchRangeBreakdown } from '@/components/agent/EarnedVouchRangeBreakdown';
import { VouchAuditLog } from '@/components/ai-id/VouchAuditLog';
import { formatUGX } from '@/lib/rentCalculations';
import { buildProfileShareUrl, shareProfileOnWhatsApp } from '@/lib/shareTrustProfile';
import { isValidAiId } from '@/lib/welileAiId';
import { toast } from 'sonner';
import ScreenLoader from '@/components/common/ScreenLoader';

interface Props {
  /** When true, uses get_public_trust_profile (PII hidden, no auth required) */
  publicMode?: boolean;
}

export default function HolisticProfile({ publicMode = false }: Props) {
  const { aiId } = useParams<{ aiId: string }>();
  const navigate = useNavigate();
  const [downloadingPdf, setDownloadingPdf] = useState(false);
  const [showDisclosure, setShowDisclosure] = useState(false);
  const [pendingShareAction, setPendingShareAction] = useState<null | 'whatsapp' | 'link'>(null);

  const cleanAiId = aiId?.toUpperCase();
  const validId = cleanAiId && isValidAiId(cleanAiId);

  const { profile, loading, error, refresh } = useTrustProfile(validId ? cleanAiId : undefined, { publicMode });
  const { hasAcknowledged, acknowledge } = useBorrowerVouchDisclosure();

  if (!validId) {
    return (
      <div className="min-h-screen flex items-center justify-center p-6 bg-background">
        <Card className="max-w-md w-full">
          <CardContent className="p-6 text-center space-y-3">
            <AlertTriangle className="h-10 w-10 text-amber-500 mx-auto" />
            <h2 className="text-lg font-semibold">Invalid Welile AI ID</h2>
            <p className="text-sm text-muted-foreground">Expected format: WEL-XXXXXX</p>
            <Button onClick={() => navigate(-1)} variant="outline" size="sm" className="gap-2">
              <ArrowLeft className="h-4 w-4" /> Go Back
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (loading && !profile) {
    return (
      <ScreenLoader />
    );
  }

  if (error || !profile) {
    return (
      <div className="min-h-screen flex items-center justify-center p-6 bg-background">
        <Card className="max-w-md w-full">
          <CardContent className="p-6 text-center space-y-3">
            <AlertTriangle className="h-10 w-10 text-destructive mx-auto" />
            <h2 className="text-lg font-semibold">Profile Unavailable</h2>
            <p className="text-sm text-muted-foreground">{error || 'Could not load this profile.'}</p>
            <Button onClick={() => navigate(-1)} variant="outline" size="sm" className="gap-2">
              <ArrowLeft className="h-4 w-4" /> Go Back
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  // Gate share/copy actions behind borrower vouch disclosure (self only)
  const requireDisclosure = (action: 'whatsapp' | 'link') => {
    if (profile?.permissions.is_self && !hasAcknowledged) {
      setPendingShareAction(action);
      setShowDisclosure(true);
      return true;
    }
    return false;
  };

  const copyLink = () => {
    if (!profile) return;
    if (requireDisclosure('link')) return;
    navigator.clipboard.writeText(buildProfileShareUrl(profile.ai_id));
    toast.success('Profile link copied');
  };

  const copyId = () => {
    if (!profile) return;
    navigator.clipboard.writeText(profile.ai_id);
    toast.success('AI ID copied');
  };

  const shareWhatsApp = () => {
    if (!profile) return;
    if (requireDisclosure('whatsapp')) return;
    shareProfileOnWhatsApp(profile);
  };

  const handleDisclosureAcknowledge = async () => {
    if (!profile) return false;
    const ok = await acknowledge({ aiId: profile.ai_id, vouchedLimit: profile.trust.borrowing_limit_ugx });
    if (ok && pendingShareAction) {
      // Auto-execute the queued share action
      if (pendingShareAction === 'whatsapp') shareProfileOnWhatsApp(profile);
      else if (pendingShareAction === 'link') {
        navigator.clipboard.writeText(buildProfileShareUrl(profile.ai_id));
        toast.success('Profile link copied');
      }
      setPendingShareAction(null);
    }
    return ok;
  };

  const downloadPdf = async () => {
    setDownloadingPdf(true);
    try {
      const { generateTrustProfilePdf } = await import('@/lib/trustProfilePdf');
      const blob = await generateTrustProfilePdf(profile);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `Welile_Profile_${profile.ai_id}.pdf`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      toast.success('PDF downloaded');
    } catch (e) {
      console.error(e);
      toast.error('Could not generate PDF');
    } finally {
      setDownloadingPdf(false);
    }
  };

  const memberSince = new Date(profile.identity.member_since).toLocaleDateString('en-UG', {
    month: 'long',
    year: 'numeric',
  });

  return (
    <div className="min-h-screen bg-background pb-28 sm:pb-24">
      {/* Top bar */}
      <div className="sticky top-0 z-20 bg-background/95 backdrop-blur border-b border-border/50">
        <div className="max-w-2xl mx-auto px-3 sm:px-4 py-3 flex items-center gap-2">
          <Button variant="ghost" size="icon" onClick={() => navigate(-1)} className="shrink-0 h-9 w-9">
            <ArrowLeft className="h-5 w-5" />
          </Button>
          <h1 className="font-semibold text-sm sm:text-base flex-1 truncate">Welile Trust Profile</h1>
          <Button variant="ghost" size="icon" onClick={refresh} title="Refresh" className="h-9 w-9 shrink-0">
            <RefreshCw className="h-4 w-4" />
          </Button>
        </div>
      </div>

      <div className="max-w-2xl mx-auto px-3 sm:px-4 py-4 sm:py-5 space-y-3 sm:space-y-4">
        {/* Identity header */}
        <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}>
          <Card>
            <CardContent className="p-4 sm:p-5">
              <div className="flex items-start gap-3 sm:gap-4">
                <UserAvatar
                  fullName={profile.identity.full_name}
                  avatarUrl={profile.identity.avatar_url || undefined}
                  size="lg"
                />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <h2 className="text-lg sm:text-xl font-bold truncate">{profile.identity.full_name}</h2>
                    {profile.identity.verified && (
                      <BadgeCheck className="h-5 w-5 text-blue-500 shrink-0" />
                    )}
                    {profile.agent_performance?.top_performing && (
                      <Badge className="bg-emerald-600 hover:bg-emerald-600 text-white text-[10px] gap-1">
                        <Trophy className="h-3 w-3" />
                        Top Performing Agent
                      </Badge>
                    )}
                  </div>
                  <div className="flex items-center gap-2 mt-1.5 flex-wrap">
                    <AiIdBadge aiId={profile.ai_id} size="sm" staticMode />
                    <Badge variant="secondary" className="text-[10px] capitalize">
                      {profile.identity.primary_role}
                    </Badge>
                  </div>
                  <p className="text-[11px] sm:text-xs text-muted-foreground mt-2 flex items-center gap-1.5">
                    <Calendar className="h-3 w-3 shrink-0" />
                    <span className="truncate">Welile member since {memberSince}</span>
                  </p>
                  {profile.agent_performance && profile.agent_performance.qualifying_tenants >= 3 && (
                    <p className="text-[11px] text-muted-foreground mt-1.5 leading-snug">
                      Manages <span className="font-semibold text-foreground">{profile.agent_performance.qualifying_tenants}</span> tenants ·{' '}
                      <span className="font-semibold text-emerald-600">
                        {Math.round(profile.agent_performance.healthy_ratio * 100)}%
                      </span>{' '}
                      paying on schedule
                      {profile.trust.borrowing_limit_ugx > 0 && (
                        <> · <span className="font-semibold text-foreground">{formatUGX(profile.trust.borrowing_limit_ugx)}</span> Welile vouch</>
                      )}
                    </p>
                  )}
                </div>
              </div>

              {/* PII (visible to self/staff only) */}
              {profile.permissions.can_see_pii && (
                <div className="mt-4 pt-4 border-t border-border/50 space-y-1.5">
                  {profile.identity.phone && (
                    <InfoLine icon={<Phone className="h-3.5 w-3.5" />} value={profile.identity.phone} />
                  )}
                  {profile.identity.email && (
                    <InfoLine icon={<Mail className="h-3.5 w-3.5" />} value={profile.identity.email} />
                  )}
                  {profile.identity.national_id_present && (
                    <InfoLine
                      icon={<IdCard className="h-3.5 w-3.5" />}
                      value={profile.identity.national_id || '••• verified'}
                    />
                  )}
                </div>
              )}
            </CardContent>
          </Card>
        </motion.div>

        {/* Trust Score */}
        <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.05 }}>
          <TrustScoreCard
            trust={profile.trust}
            agentPerformance={profile.agent_performance}
            primaryRole={profile.identity.primary_role}
          />
        </motion.div>

        {/* Welile Vouch tile — visible whenever a vouch limit exists. The 2×
            agent_earned_vouch driver is rolled into borrowing_limit_ugx by
            get_agent_vouch_limit_ugx() so we just present the result. */}
        {profile.trust.borrowing_limit_ugx > 0 && (
          <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.07 }}>
            <Card className="border-emerald-500/30 bg-gradient-to-br from-emerald-500/10 via-emerald-500/[0.04] to-transparent">
              <CardContent className="p-4 flex items-center gap-3">
                <div className="h-12 w-12 rounded-xl bg-emerald-600 text-white flex items-center justify-center shrink-0 shadow-sm">
                  <ShieldCheck className="h-6 w-6" />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-[10px] uppercase tracking-[0.14em] font-bold text-emerald-700 dark:text-emerald-400">
                    Welile Vouches
                  </p>
                  <p className="text-2xl font-black tabular-nums leading-tight">
                    {formatUGX(profile.trust.borrowing_limit_ugx)}
                  </p>
                  <p className="text-[11px] text-muted-foreground mt-0.5">
                    {profile.identity.primary_role === 'agent'
                      ? 'Earned 2× from rent collected on schedule'
                      : 'Trust-backed lending limit'}
                  </p>
                </div>
              </CardContent>
            </Card>

            {/* Date-range filtered breakdown — only shows when this user has
                actually collected rent (i.e., is an agent). RPC silently
                returns nothing for non-agents and the component hides itself. */}
            {profile.identity.primary_role === 'agent' && (
              <div className="mt-3">
                <EarnedVouchRangeBreakdown
                  aiId={profile.ai_id}
                  effectiveLimitUgx={profile.trust.borrowing_limit_ugx}
                  defaultRange="all"
                  explain
                />
              </div>
            )}

            {/* Portfolio-first vouch composition — shows exactly which
                components make up the Welile vouch: primary portfolio (1×),
                Welile shares (2×), and behavioural boosters on top. */}
            {profile.trust.vouch_breakdown && (
              <div className="mt-3">
                <Card className="border-emerald-500/20">
                  <CardContent className="p-4 space-y-3">
                    <div>
                      <p className="text-[10px] uppercase tracking-[0.14em] font-bold text-emerald-700 dark:text-emerald-400">
                        How this vouch is built
                      </p>
                      <p className="text-[11px] text-muted-foreground mt-0.5">
                        Your partnership portfolio is the primary vouch (1×). Welile shares add 2×. Everything else stacks on top.
                      </p>
                    </div>

                    <div className="space-y-1.5 text-[12px]">
                      <VouchRow
                        label="Partnership portfolio (primary, 1×)"
                        value={profile.trust.vouch_breakdown.portfolio_component_ugx}
                        emphasis
                      />
                      <VouchRow
                        label={`Welile shares (2× of ${formatUGX(profile.trust.vouch_breakdown.angel_shares_ugx)})`}
                        value={profile.trust.vouch_breakdown.shares_component_ugx}
                        emphasis
                      />
                      <div className="pt-1 mt-1 border-t border-border/60">
                        <p className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">
                          Boosters
                        </p>
                        <VouchRow label="Wallet activity" value={profile.trust.vouch_breakdown.booster_breakdown.wallet_activity} />
                        <VouchRow label="Network contribution" value={profile.trust.vouch_breakdown.booster_breakdown.network_contribution} />
                        <VouchRow label="Agent performance" value={profile.trust.vouch_breakdown.booster_breakdown.agent_performance} />
                        <VouchRow label="Verification" value={profile.trust.vouch_breakdown.booster_breakdown.verification} />
                        <VouchRow label="Movement behaviour" value={profile.trust.vouch_breakdown.booster_breakdown.movement_behavior} />
                        <VouchRow label="Payment history" value={profile.trust.vouch_breakdown.booster_breakdown.payment_history} />
                      </div>
                      <div className="flex items-center justify-between pt-2 mt-1 border-t border-border">
                        <span className="text-[12px] font-bold">Total Welile vouch</span>
                        <span className="text-[13px] font-black tabular-nums text-emerald-700 dark:text-emerald-400">
                          {formatUGX(profile.trust.vouch_breakdown.total_ugx)}
                        </span>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              </div>
            )}

            {/* Full audit log — inputs + formulas for every vouch component */}
            <div className="mt-3">
              <VouchAuditLog profile={profile} />
            </div>
          </motion.div>
        )}

        {/* Boost Your Trust suggestions (self only) */}
        <TrustBoostSuggestions profile={profile} />

        {/* Cash flow capacity */}
        <CashFlowCapacityCard profile={profile} />

        {/* Movement behavior */}
        <MovementBehaviorCard profile={profile} />

        {/* Landlord listings (only if applicable) */}
        <LandlordListingsCard profile={profile} />

        {/* Behavioral History */}
        <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.1 }}>
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm flex items-center gap-2">
                <TrendingUp className="h-4 w-4 text-primary" />
                Payment History
              </CardTitle>
            </CardHeader>
            <CardContent className="pt-2">
              {profile.payment_history.total_rent_plans === 0 ? (
                <p className="text-xs text-muted-foreground text-center py-3">No rent payment activity yet</p>
              ) : (
                <div className="grid grid-cols-2 gap-3">
                  <Stat label="Rent Plans" value={String(profile.payment_history.total_rent_plans)} />
                  <Stat label="On-time Rate" value={`${profile.payment_history.on_time_rate}%`} accent />
                  <Stat label="Total Repaid" value={formatUGX(profile.payment_history.total_repaid)} />
                  <Stat
                    label="Outstanding"
                    value={formatUGX(profile.payment_history.total_owing)}
                    danger={profile.payment_history.total_owing > 0}
                  />
                </div>
              )}
            </CardContent>
          </Card>
        </motion.div>

        {/* Wallet Activity (only if visible) */}
        {profile.permissions.can_see_pii && (
          <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.15 }}>
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm flex items-center gap-2">
                  <Wallet className="h-4 w-4 text-primary" />
                  Wallet Activity (180 days)
                </CardTitle>
              </CardHeader>
              <CardContent className="pt-2">
                <div className="grid grid-cols-2 gap-3">
                  <Stat label="Balance" value={formatUGX(profile.wallet_activity.balance || 0)} accent />
                  <Stat label="Transactions" value={String(profile.wallet_activity.transaction_count_180d)} />
                  <Stat label="Received" value={formatUGX(profile.wallet_activity.total_received_180d)} />
                  <Stat label="Sent" value={formatUGX(profile.wallet_activity.total_sent_180d)} />
                </div>
              </CardContent>
            </Card>
          </motion.div>
        )}

        {/* Network */}
        <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.2 }}>
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm flex items-center gap-2">
                <Users className="h-4 w-4 text-primary" />
                Network & Contribution
              </CardTitle>
            </CardHeader>
            <CardContent className="pt-2">
              <div className="grid grid-cols-2 gap-3">
                <Stat label="Referrals" value={String(profile.network.referrals)} />
                <Stat label="Sub-agents" value={String(profile.network.sub_agents)} />
                {profile.permissions.can_see_pii && (profile.network.portfolio_value || 0) > 0 && (
                  <Stat
                    label="Portfolio"
                    value={formatUGX(profile.network.portfolio_value || 0)}
                    accent
                    span2
                  />
                )}
              </div>
              {profile.identity.roles.length > 0 && (
                <div className="mt-3 pt-3 border-t border-border/50">
                  <p className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1.5">Roles</p>
                  <div className="flex flex-wrap gap-1.5">
                    {profile.identity.roles.map((r) => (
                      <Badge key={r} variant="outline" className="text-[10px] capitalize">
                        {r.replace(/_/g, ' ')}
                      </Badge>
                    ))}
                  </div>
                </div>
              )}
            </CardContent>
          </Card>
        </motion.div>

        {/* Welile Vouches block */}
        <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.25 }}>
          <Card className="bg-gradient-to-br from-emerald-500/10 to-primary/10 border-emerald-500/20">
            <CardContent className="p-4 space-y-2">
              <div className="flex items-center gap-2">
                <Banknote className="h-4 w-4 text-emerald-600" />
                <p className="text-sm font-bold text-emerald-700 dark:text-emerald-400">Welile Vouches</p>
              </div>
              <p className="text-xs text-muted-foreground leading-relaxed">
                Welile guarantees this member based on their platform behavior, payment history, and network
                activity. Lenders can rely on this profile to extend credit, with capital protection backed by
                Welile AI Insurance.
              </p>
            </CardContent>
          </Card>
        </motion.div>

        {/* Lender record-loan card (visible to other authenticated users) */}
        {!profile.permissions.is_self && <LenderRecordLoanCard profile={profile} />}

        {/* Borrower's own vouched loans (self only) */}
        {profile.permissions.is_self && <MyVouchedLoansCard />}

        {/* Disclaimer */}
        <p className="text-[10px] text-muted-foreground text-center px-4 leading-relaxed">
          This is an informational summary only. It does not constitute a credit report, approval for any
          financial product, or financial advice. All data is derived from Welile platform activity.
        </p>
      </div>

      {/* Sticky action bar */}
      <div className="fixed bottom-0 left-0 right-0 z-30 bg-background/95 backdrop-blur border-t border-border/50 pb-[env(safe-area-inset-bottom)]">
        <div className="max-w-2xl mx-auto px-2 sm:px-4 py-2 sm:py-3 grid grid-cols-4 gap-1.5 sm:gap-2">
          <Button variant="outline" size="sm" onClick={copyId} className="flex-col h-auto py-2 gap-0.5 sm:gap-1 px-1">
            <Copy className="h-4 w-4" />
            <span className="text-[9px] sm:text-[10px]">Copy ID</span>
          </Button>
          <Button variant="outline" size="sm" onClick={copyLink} className="flex-col h-auto py-2 gap-0.5 sm:gap-1 px-1">
            <LinkIcon className="h-4 w-4" />
            <span className="text-[9px] sm:text-[10px]">Copy Link</span>
          </Button>
          <Button
            size="sm"
            onClick={shareWhatsApp}
            className="flex-col h-auto py-2 gap-0.5 sm:gap-1 px-1 bg-emerald-600 hover:bg-emerald-700 text-white"
          >
            <MessageCircle className="h-4 w-4" />
            <span className="text-[9px] sm:text-[10px]">WhatsApp</span>
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={downloadPdf}
            disabled={downloadingPdf}
            className="flex-col h-auto py-2 gap-0.5 sm:gap-1 px-1"
          >
            {downloadingPdf ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileDown className="h-4 w-4" />}
            <span className="text-[9px] sm:text-[10px]">PDF</span>
          </Button>
        </div>
      </div>

      {/* Borrower vouch disclosure modal — shown before first share */}
      <BorrowerVouchDisclosureModal
        isOpen={showDisclosure}
        onClose={() => { setShowDisclosure(false); setPendingShareAction(null); }}
        onAcknowledge={handleDisclosureAcknowledge}
        vouchedAmountText={profile ? formatUGX(profile.trust.borrowing_limit_ugx) : undefined}
      />
    </div>
  );
}

function InfoLine({ icon, value }: { icon: React.ReactNode; value: string }) {
  return (
    <div className="flex items-center gap-2 text-xs text-muted-foreground">
      {icon}
      <span className="truncate">{value}</span>
    </div>
  );
}

function Stat({
  label,
  value,
  accent,
  danger,
  span2,
}: {
  label: string;
  value: string;
  accent?: boolean;
  danger?: boolean;
  span2?: boolean;
}) {
  return (
    <div
      className={`p-3 rounded-xl bg-muted/40 border border-border/50 min-w-0 ${span2 ? 'col-span-2' : ''}`}
    >
      <p className="text-[10px] uppercase tracking-wider text-muted-foreground truncate">{label}</p>
      <p
        className={`text-sm font-bold mt-0.5 break-words leading-tight ${
          danger ? 'text-destructive' : accent ? 'text-emerald-600' : 'text-foreground'
        }`}
      >
        {value}
      </p>
    </div>
  );
}

function VouchRow({ label, value, emphasis }: { label: string; value: number; emphasis?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className={`text-[11px] ${emphasis ? 'font-semibold text-foreground' : 'text-muted-foreground'}`}>{label}</span>
      <span className={`text-[11px] tabular-nums ${emphasis ? 'font-bold text-foreground' : 'font-semibold text-foreground/80'}`}>
        {formatUGX(value)}
      </span>
    </div>
  );
}
