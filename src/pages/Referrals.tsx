import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '@/hooks/useAuth';
import { useUserSnapshot } from '@/hooks/useUserSnapshot';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { 
  ArrowLeft, 
  Users, 
  Coins, 
  Calendar, 
  Share2, 
  Copy, 
  CheckCircle2,
  Gift,
  ChevronDown,
  AlertCircle
} from 'lucide-react';
import { formatUGX } from '@/lib/rentCalculations';
import { format } from 'date-fns';
import { cn } from '@/lib/utils';
import { useToast } from '@/hooks/use-toast';
import { ReferralLeaderboard } from '@/components/ReferralLeaderboard';
import { RewardHistoryBadges } from '@/components/RewardHistoryBadges';
import { ReferralBonusProgress } from '@/components/ReferralBonusProgress';
import { motion } from 'framer-motion';
import { ReferralsSkeleton } from '@/components/skeletons/DashboardSkeletons';
import { getPublicOrigin } from '@/lib/getPublicOrigin';
import { createShortLink } from '@/lib/createShortLink';

export default function Referrals() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const { toast } = useToast();
  const { snapshot, loading, refresh } = useUserSnapshot(user?.id);
  const [copied, setCopied] = useState(false);
  const [statusFilter, setStatusFilter] = useState<'all' | 'completed' | 'incomplete'>('all');
  const [historyOpen, setHistoryOpen] = useState(true);

  const referrals = snapshot.referrals || [];
  const isReferralIncomplete = (r: any) => r.referral_status === 'incomplete';
  const completedCount = referrals.filter((r: any) => r.referral_status === 'completed').length;
  const incompleteCount = referrals.filter((r: any) => r.referral_status === 'incomplete').length;
  const filteredReferrals = referrals.filter((r: any) => {
    if (statusFilter === 'completed') return !isReferralIncomplete(r);
    if (statusFilter === 'incomplete') return isReferralIncomplete(r);
    return true;
  });
  const longReferralLink = user ? `${getPublicOrigin()}/join?r=${user.id}` : '';
  const [shortLink, setShortLink] = useState<string | null>(null);
  const referralLink = shortLink || longReferralLink;

  // Each user gets their own short, unique invite link (e.g. /r/X7kM2p).
  // The same code is reused on every visit; if creation fails we keep the
  // full /join?r=<id> link so sharing always works.
  useEffect(() => {
    if (!user?.id) return;
    let active = true;
    createShortLink(user.id, '/join', { r: user.id })
      .then((url) => { if (active) setShortLink(url); })
      .catch(() => { /* keep the long link */ });
    return () => { active = false; };
  }, [user?.id]);

  const copyReferralLink = async () => {
    await navigator.clipboard.writeText(referralLink);
    setCopied(true);
    toast({
      title: 'Link Copied!',
      description: 'Share this link with friends to earn rewards.',
    });
    setTimeout(() => setCopied(false), 2000);
  };

  const shareReferralLink = async () => {
    if (navigator.share) {
      try {
        await navigator.share({
          title: 'Join Welile',
          text: 'Join Welile and we both earn rewards!',
          url: referralLink,
        });
      } catch (err) {
        copyReferralLink();
      }
    } else {
      copyReferralLink();
    }
  };

  // Signup bonus (UGX 100) is the only referral bonus. The former UGX 200
  // first-transaction bonus was retired, but historic credits still count
  // toward what a referrer already earned.
  const totalSignupBonus = referrals.reduce((sum: number, r: any) => sum + Number(r.bonus_amount), 0);
  const totalFirstTxBonus = referrals
    .filter((r: any) => r.first_transaction_bonus_credited)
    .reduce((sum: number, r: any) => sum + Number(r.first_transaction_bonus_amount || 0), 0);
  const totalEarned = totalSignupBonus + totalFirstTxBonus;


  if (loading) {
    return <ReferralsSkeleton />;
  }

  return (
    <div className="min-h-screen bg-background">
      <header className="sticky top-0 z-50 glass-card border-b border-border/50">
        <div className="container mx-auto px-4 py-4">
          <div className="flex items-center gap-4">
            <Button variant="ghost" size="icon" onClick={() => navigate(-1)}>
              <ArrowLeft className="h-5 w-5" />
            </Button>
            <div>
              <h1 className="text-xl font-bold">My Referrals</h1>
              <p className="text-sm text-muted-foreground">Track your referral earnings</p>
            </div>
          </div>
        </div>
      </header>

      <main className="container mx-auto px-4 py-6 space-y-6">
        {/* Stats Cards */}
        <div className="grid grid-cols-2 gap-3">
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.1 }}
          >
            <Card className="text-center h-full overflow-hidden">
              <CardContent className="p-3 flex flex-col items-center justify-center gap-1">
                <Users className="h-4 w-4 text-primary" />
                <p className="text-sm font-bold leading-tight truncate max-w-full">{snapshot.referralCount || referrals.length}</p>
                <p className="text-[10px] text-muted-foreground leading-none">Friends</p>
              </CardContent>
            </Card>
          </motion.div>

          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.2 }}
          >
            <Card className="text-center h-full overflow-hidden">
              <CardContent className="p-3 flex flex-col items-center justify-center gap-1">
                <Coins className="h-4 w-4 text-success" />
                <div className="flex flex-col items-center justify-center leading-tight min-w-0">
                  <span className="text-[10px] text-muted-foreground">UGX</span>
                  <span className="text-sm font-bold text-success truncate max-w-full">{formatUGX(totalEarned).replace(/UGX\s*/, '')}</span>
                </div>
                <p className="text-[10px] text-muted-foreground leading-none">Earned</p>
              </CardContent>
            </Card>
          </motion.div>

        </div>


        {/* Share Card */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.4 }}
        >
          <Card className="border-primary/20 bg-gradient-to-br from-primary/5 to-transparent">
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center gap-2 text-lg">
                <Gift className="h-5 w-5 text-primary" />
                Invite Friends & Earn
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex items-center justify-center p-3 bg-muted/30 rounded-lg">
                <p className="text-lg font-bold text-primary">UGX 100 Per friend</p>
              </div>

              
              <div className="flex gap-2">
                <div className="flex-1 bg-muted/50 rounded-lg px-3 py-2 text-sm truncate font-mono">
                  {referralLink}
                </div>
                <Button
                  variant="outline"
                  size="icon"
                  onClick={copyReferralLink}
                  className="shrink-0"
                >
                  {copied ? <CheckCircle2 className="h-4 w-4 text-success" /> : <Copy className="h-4 w-4" />}
                </Button>
              </div>

              <Button onClick={shareReferralLink} className="w-full gap-2">
                <Share2 className="h-4 w-4" />
                Share Your Link
              </Button>
            </CardContent>
          </Card>
        </motion.div>

        {/* Monthly Achievement Badges */}
        <RewardHistoryBadges />

        {/* UGX 500 Restricted Referral Bonus Progress */}
        <ReferralBonusProgress />

        {/* Leaderboard */}
        <ReferralLeaderboard limit={5} />

        {/* Referral History */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.5 }}
        >
          <Card>
            <CardHeader>
              <button
                type="button"
                onClick={() => setHistoryOpen(v => !v)}
                className="flex w-full items-center justify-between gap-2 text-left"
                aria-expanded={historyOpen}
                aria-controls="referral-history-content"
              >
                <CardTitle className="flex items-center gap-2 text-lg">
                  <Calendar className="h-5 w-5 text-primary" />
                  Referral History
                </CardTitle>
                <ChevronDown className={cn('h-5 w-5 text-muted-foreground transition-transform', historyOpen && 'rotate-180')} />
              </button>
            </CardHeader>
            {historyOpen && (
            <CardContent id="referral-history-content">
              <div className="mb-4 flex items-center justify-between gap-2 flex-wrap">
                <ToggleGroup
                  type="single"
                  value={statusFilter}
                  onValueChange={(v) => v && setStatusFilter(v as any)}
                  className="bg-muted/30 rounded-lg p-1"
                >
                  <ToggleGroupItem value="all" className="text-xs h-8 px-3 data-[state=on]:bg-background">
                    All ({referrals.length})
                  </ToggleGroupItem>
                  <ToggleGroupItem value="completed" className="text-xs h-8 px-3 data-[state=on]:bg-background">
                    Completed ({completedCount})
                  </ToggleGroupItem>
                  <ToggleGroupItem value="incomplete" className="text-xs h-8 px-3 data-[state=on]:bg-background">
                    Incomplete ({incompleteCount})
                  </ToggleGroupItem>
                </ToggleGroup>
              </div>
              {referrals.length === 0 ? (
                <div className="text-center py-8">
                  <Users className="h-12 w-12 mx-auto text-muted-foreground/30 mb-3" />
                  <p className="text-muted-foreground">No referrals yet</p>
                  <p className="text-sm text-muted-foreground mt-1">
                    Share your link to start earning!
                  </p>
                </div>
              ) : filteredReferrals.length === 0 ? (
                <div className="text-center py-8">
                  <AlertCircle className="h-12 w-12 mx-auto text-muted-foreground/30 mb-3" />
                  <p className="text-muted-foreground">
                    No {statusFilter === 'completed' ? 'completed' : 'incomplete'} referrals
                  </p>
                </div>
              ) : (
                <div className="space-y-3">
                  {filteredReferrals.map((referral: any, index: number) => {
                    const isIncomplete = referral.referral_status === 'incomplete';
                    const displayName =
                      referral.referred_name ||
                      (referral.referred_id
                        ? `Onboarding incomplete · …${String(referral.referred_id).slice(-6)}`
                        : 'Onboarding incomplete');
                    return (
                    <motion.div
                      key={referral.id}
                      initial={{ opacity: 0, x: -20 }}
                      animate={{ opacity: 1, x: 0 }}
                      transition={{ delay: index * 0.05 }}
                      className={`flex items-center gap-3 p-3 rounded-lg bg-muted/30 hover:bg-muted/50 transition-colors ${
                        isIncomplete ? 'opacity-60' : ''
                      }`}
                      title={
                        isIncomplete
                          ? "This invitee never finished sign-up. Bonus stays pending."
                          : undefined
                      }
                    >
                      <div className="h-10 w-10 rounded-full bg-gradient-to-br from-primary/20 to-primary/5 flex items-center justify-center">
                        {isIncomplete ? (
                          <AlertCircle className="h-5 w-5 text-muted-foreground" />
                        ) : (
                          <Users className="h-5 w-5 text-primary" />
                        )}
                      </div>

                      <div className="flex-1 min-w-0">
                        <p className={`font-medium truncate ${isIncomplete ? 'text-muted-foreground italic' : ''}`}>
                          {displayName}
                        </p>
                        <p className="text-xs text-muted-foreground truncate">
                          {isIncomplete
                            ? "Invitee never finished sign-up — bonus pending"
                            : (
                              <>
                                {referral.referred_phone || '—'}
                                {referral.referred_city ? ` • ${referral.referred_city}` : ''}
                              </>
                            )}
                        </p>
                        <p className="text-[10px] text-muted-foreground">
                          {format(new Date(referral.created_at), 'MMM d, yyyy')}
                        </p>
                      </div>

                      <div className="text-right space-y-1">
                        <p className="font-bold text-success text-sm">
                          +{formatUGX(Number(referral.bonus_amount))}
                        </p>
                        {referral.first_transaction_bonus_credited && (
                          <p className="text-[10px] text-success">
                            +{formatUGX(Number(referral.first_transaction_bonus_amount || 0))} tx
                          </p>
                        )}
                        <Badge 
                          variant={referral.credited ? 'default' : 'secondary'}
                          className="text-[10px]"
                        >
                          {referral.credited ? 'Credited ✓' : 'Pending'}
                        </Badge>
                      </div>
                    </motion.div>
                  );})}
                </div>
              )}
            </CardContent>
          )}
          </Card>
        </motion.div>
      </main>
    </div>
  );
}
