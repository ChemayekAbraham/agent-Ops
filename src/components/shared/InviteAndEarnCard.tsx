import { useState, useEffect } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Share2, Copy, Check, Users, Gift, MessageCircle, TrendingUp } from 'lucide-react';
import { useToast } from '@/hooks/use-toast';
import { useAuth } from '@/hooks/useAuth';
import { supabase } from '@/integrations/supabase/client';
import { hapticTap, hapticSuccess } from '@/lib/haptics';
import { motion } from 'framer-motion';
import { formatUGX } from '@/lib/rentCalculations';
import { getPublicOrigin } from '@/lib/getPublicOrigin';
import { createShortLink } from '@/lib/createShortLink';

interface InviteAndEarnCardProps {
  variant?: 'tenant' | 'landlord' | 'supporter' | 'default';
  compact?: boolean;
}

export function InviteAndEarnCard({ variant = 'default', compact = false }: InviteAndEarnCardProps) {
  const { toast } = useToast();
  const { user } = useAuth();
  const [copied, setCopied] = useState(false);
  const [referralCount, setReferralCount] = useState(0);
  const [totalEarned, setTotalEarned] = useState(0);
  const [shortLink, setShortLink] = useState<string | null>(null);
  const [shortLinkLoading, setShortLinkLoading] = useState(false);

  useEffect(() => {
    if (!user?.id) return;
    
    // Fetch referral stats
    const fetchStats = async () => {
      const [refResult, earningsResult] = await Promise.all([
        supabase
          .from('referrals')
          .select('id', { count: 'exact', head: true })
          .eq('referrer_id', user.id),
        supabase
          .from('agent_earnings')
          .select('amount')
          .eq('agent_id', user.id)
          .eq('earning_type', 'registration'),
      ]);
      
      setReferralCount(refResult.count || 0);
      setTotalEarned((earningsResult.data || []).reduce((sum, e) => sum + e.amount, 0));
    };
    
    fetchStats();
  }, [user?.id]);

  // Generate a short link for the landlord variant
  useEffect(() => {
    if (!user?.id || variant !== 'landlord' || shortLink) return;
    let cancelled = false;
    setShortLinkLoading(true);
    createShortLink(user.id, '/auth', { role: 'landlord', ref: user.id })
      .then((url) => {
        if (!cancelled) setShortLink(url);
      })
      .catch(() => {
        // Fall back to the long link silently
      })
      .finally(() => {
        if (!cancelled) setShortLinkLoading(false);
      });
    return () => { cancelled = true; };
  }, [user?.id, variant, shortLink]);

  const roleLabel = variant === 'supporter' ? 'supporter' : variant === 'landlord' ? 'landlord' : 'tenant';
  
  const longShareLink = user 
    ? `${getPublicOrigin()}/auth?role=${roleLabel}&ref=${user.id}`
    : `${getPublicOrigin()}/auth?role=${roleLabel}`;

  // Landlord referrals use the shortened link once generated
  const shareLink = variant === 'landlord' && shortLink ? shortLink : longShareLink;

  const messages: Record<string, string> = {
    tenant: `🏠 Struggling with rent? I use Welile to get my rent paid upfront!\n\n💰 Get your full rent today\n📅 Pay back in small daily amounts\n✅ Quick signup - just 2 minutes\n🎁 We BOTH get 100 UGX bonus!\n\nJoin now: ${shareLink}`,
    landlord: `🏡 Tired of chasing rent? Welile guarantees your monthly rent!\n\n✅ Get rent on time, every month\n🛡️ Zero risk to you\n📲 Free to join\n\nRegister now: ${shareLink}`,
    supporter: `💰 Want to earn passive income? I'm earning returns with Welile!\n\n📈 Competitive monthly returns\n🛡️ Backed by real rent payments\n📲 Easy to start\n🎁 Join through my link!\n\nStart now: ${shareLink}`,
    default: `📲 Join Welile - the smartest way to manage rent!\n\n🎁 We BOTH get 100 UGX bonus!\n\nJoin now: ${shareLink}`,
  };

  const shareMessage = messages[variant] || messages.default;

  const handleWhatsAppShare = () => {
    hapticTap();
    window.open(`https://wa.me/?text=${encodeURIComponent(shareMessage)}`, '_blank');
    toast({ title: '📱 Opening WhatsApp', description: 'Share with friends to earn!' });
  };

  const handleNativeShare = async () => {
    hapticTap();
    if (navigator.share) {
      try {
        await navigator.share({ title: 'Join Welile', text: shareMessage, url: shareLink });
        hapticSuccess();
        return;
      } catch { /* cancelled */ }
    }
    handleCopy();
  };

  const handleCopy = async () => {
    hapticTap();
    try {
      await navigator.clipboard.writeText(shareLink);
      setCopied(true);
      hapticSuccess();
      toast({ title: '✓ Link Copied!', description: 'Share it with friends' });
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast({ title: 'Copy failed', variant: 'destructive' });
    }
  };

  if (compact) {
    return (
      <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.25 }}>
        <Card className="overflow-hidden border border-border/60 bg-card shadow-sm">
          <CardContent className="p-2 sm:p-2.5 flex items-center gap-2 sm:gap-2.5">
            <div className="h-7 w-7 sm:h-8 sm:w-8 rounded-lg bg-primary/10 flex items-center justify-center shrink-0">
              <Gift className="h-3.5 w-3.5 sm:h-4 sm:w-4 text-primary" />
            </div>
            <div className="flex-1 min-w-0">
              <p className="font-semibold text-[12px] sm:text-[13px] leading-tight text-foreground truncate">
                Invite & Earn
              </p>
              <p className="text-[10px] sm:text-[11px] text-muted-foreground leading-tight mt-0.5 truncate">
                {referralCount > 0
                  ? `${referralCount} joined · ${formatUGX(totalEarned)}`
                  : 'UGX 100 per friend'}
              </p>
            </div>
            <Button
              onClick={handleWhatsAppShare}
              size="sm"
              className="bg-[#25D366] hover:bg-[#20BD5A] text-white gap-1 font-semibold text-[11px] sm:text-xs rounded-lg h-7 sm:h-8 px-2.5 sm:px-3 shrink-0"
            >
              <MessageCircle className="h-3 w-3 sm:h-3.5 sm:w-3.5" />
              Share
            </Button>
          </CardContent>
        </Card>
      </motion.div>
    );
  }

  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3 }}
    >
      <Card className="overflow-hidden border-2 border-primary/20 bg-gradient-to-br from-primary/5 via-background to-primary/10">
        <CardContent className="p-4 space-y-3">
          {/* Header */}
          <div className="flex items-center gap-3">
            <div className="h-11 w-11 rounded-xl bg-gradient-to-br from-primary to-primary/70 flex items-center justify-center shadow-md shrink-0">
              <Gift className="h-5 w-5 text-primary-foreground" />
            </div>
            <div className="flex-1 min-w-0">
              <h3 className="font-bold text-sm leading-tight">Invite & Earn UGX 100</h3>
              <p className="text-xs text-muted-foreground">
                Share your link. Earn for every friend who joins.
              </p>
            </div>
          </div>

          {/* Stats Row */}
          {referralCount > 0 && (
            <div className="flex gap-3">
              <div className="flex-1 rounded-xl bg-muted/50 p-2.5 text-center">
                <div className="flex items-center justify-center gap-1">
                  <Users className="h-3.5 w-3.5 text-primary" />
                  <span className="font-black text-lg text-foreground">{referralCount}</span>
                </div>
                <p className="text-[10px] text-muted-foreground font-medium">Friends Joined</p>
              </div>
              <div className="flex-1 rounded-xl bg-muted/50 p-2.5 text-center">
                <div className="flex items-center justify-center gap-1">
                  <TrendingUp className="h-3.5 w-3.5 text-success" />
                  <span className="font-black text-lg text-foreground">{formatUGX(totalEarned)}</span>
                </div>
                <p className="text-[10px] text-muted-foreground font-medium">Total Earned</p>
              </div>
            </div>
          )}

          {/* WhatsApp CTA */}
          <Button
            onClick={handleWhatsAppShare}
            className="w-full h-14 bg-[#25D366] hover:bg-[#20BD5A] text-white gap-2.5 font-bold text-base rounded-xl shadow-md active:scale-[0.98] transition-transform touch-manipulation"
          >
            <MessageCircle className="h-6 w-6" />
            Share on WhatsApp
          </Button>

          {/* Secondary actions */}
          <div className="flex gap-2">
            <Button
              onClick={handleNativeShare}
              variant="outline"
              className="flex-1 h-11 gap-2 rounded-xl font-medium"
            >
              <Share2 className="h-4 w-4" />
              Share
            </Button>
            <Button
              onClick={handleCopy}
              variant="outline"
              className="flex-1 h-11 gap-2 rounded-xl font-medium"
            >
              {copied ? (
                <><Check className="h-4 w-4 text-success" /> Copied!</>
              ) : (
                <><Copy className="h-4 w-4" /> Copy Link</>
              )}
            </Button>
          </div>
        </CardContent>
      </Card>
    </motion.div>
  );
}
