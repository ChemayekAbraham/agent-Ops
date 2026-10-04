import { useState, useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Users, Share2, Copy, Check, MessageCircle, Gift, Home, TrendingUp, Sparkles } from 'lucide-react';
import { useAuth } from '@/hooks/useAuth';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';

interface InviteFriendWelileHomesProps {
  currentSavings?: number;
  monthlyRent?: number;
}

export function InviteFriendWelileHomes({ currentSavings = 0, monthlyRent = 500000 }: InviteFriendWelileHomesProps) {
  const { user } = useAuth();
  const [copied, setCopied] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [referralCount, setReferralCount] = useState(0);

  // Referral DB calls stubbed for performance

  const getShareLink = () => {
    if (!user) return `${window.location.origin}/auth?promo=welile-homes`;
    return `${window.location.origin}/auth?ref=${user.id}&promo=welile-homes`;
  };

  const formatUGX = (amount: number) => {
    return new Intl.NumberFormat('en-UG', {
      style: 'currency',
      currency: 'UGX',
      minimumFractionDigits: 0,
      maximumFractionDigits: 0,
    }).format(amount);
  };

  // Calculate projections for sharing
  const monthlySaving = monthlyRent * 0.10;
  const monthlyRate = 0.05;
  const projections = {
    oneYear: monthlySaving * 12 * Math.pow(1 + monthlyRate, 12),
    twoYears: monthlySaving * 24 * Math.pow(1 + monthlyRate, 24),
    fiveYears: monthlySaving * 60 * Math.pow(1 + monthlyRate, 60),
  };

  const getWhatsAppMessage = () => {
    return `🏠 *Turn Your Rent Into Home Savings!*

Hey! I'm using Welile Homes and it's amazing - my rent payments are building my future home fund! 🎉

*Here's how it works:*
✅ 10% of rent fees saved automatically
✅ 5% compound interest MONTHLY
✅ Use for land, home, or mortgage deposits

*My Progress:*
💰 Current Savings: ${formatUGX(currentSavings)}

*Example Growth (${formatUGX(monthlyRent)}/month rent):*
📈 1 Year: ${formatUGX(projections.oneYear)}
📈 2 Years: ${formatUGX(projections.twoYears)}  
📈 5 Years: ${formatUGX(projections.fiveYears)}!

*Plus you get:*
🎁 UGX 500 signup bonus
📱 Easy daily rent payments
🏦 Rent loans when needed

Join me and start building YOUR future home! 👇
${getShareLink()}

Let's become homeowners together! 💪🏡`;
  };

  const handleCopyLink = async () => {
    try {
      await navigator.clipboard.writeText(getShareLink());
      setCopied(true);
      toast.success('Link copied!');
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error('Failed to copy');
    }
  };

  const handleWhatsAppShare = () => {
    const message = encodeURIComponent(getWhatsAppMessage());
    window.open(`https://wa.me/?text=${message}`, '_blank');
    setDialogOpen(false);
  };

  const handleNativeShare = async () => {
    if (navigator.share) {
      try {
        await navigator.share({
          title: 'Join Welile Homes - Build Your Future Home!',
          text: getWhatsAppMessage(),
          url: getShareLink(),
        });
      } catch (err) {
        if ((err as Error).name !== 'AbortError') {
          setDialogOpen(true);
        }
      }
    } else {
      setDialogOpen(true);
    }
  };

  return (
    <>
      {/* Compact Invite Card */}
      <Card className="bg-gradient-to-br from-emerald-500/90 via-teal-500/85 to-cyan-500/80 border-0 shadow-lg overflow-hidden">
        <CardContent className="p-4">
          <div className="flex items-start gap-4">
            <div className="p-3 rounded-2xl bg-white/20 backdrop-blur-sm shadow-lg">
              <Users className="h-6 w-6 text-white" />
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 mb-0.5">
                <h3 className="font-bold text-white">Invite Friends to Welile Homes</h3>
                {referralCount > 0 && (
                  <Badge variant="secondary" className="bg-white/20 text-white text-xs">
                    {referralCount} invited
                  </Badge>
                )}
              </div>
              <p className="text-xs text-white/80 mb-3">
                Help friends build their future homes & earn UGX 500 per signup!
              </p>
              
              <div className="flex gap-2">
                <Button
                  onClick={handleNativeShare}
                  className="flex-1 h-10 rounded-xl bg-card text-emerald-600 font-bold text-sm hover:bg-white/95 active:scale-[0.98] transition-all gap-2"
                >
                  <Share2 className="h-4 w-4" />
                  Share Link
                </Button>
                <Button
                  onClick={handleCopyLink}
                  variant="ghost"
                  className="h-10 px-3 rounded-xl bg-white/15 text-white hover:bg-white/25 active:scale-[0.98]"
                >
                  {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                </Button>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Share Dialog */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle className="text-center flex items-center justify-center gap-2">
              <Home className="h-5 w-5 text-emerald-500" />
              Invite to Welile Homes
            </DialogTitle>
            <DialogDescription className="text-center">
              Share the home savings journey with friends!
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 pt-2">
            {/* Benefits Preview */}
            <div className="bg-gradient-to-br from-emerald-50 to-teal-50 dark:from-emerald-950/30 dark:to-teal-950/30 rounded-xl p-4 border border-emerald-200 dark:border-emerald-800">
              <div className="flex items-center gap-2 mb-3">
                <Sparkles className="h-4 w-4 text-emerald-500" />
                <span className="font-semibold text-sm">What Friends Get</span>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div className="flex items-center gap-2 text-xs">
                  <TrendingUp className="h-3 w-3 text-emerald-500" />
                  <span>5% monthly interest</span>
                </div>
                <div className="flex items-center gap-2 text-xs">
                  <Home className="h-3 w-3 text-emerald-500" />
                  <span>10% rent saved</span>
                </div>
                <div className="flex items-center gap-2 text-xs">
                  <Gift className="h-3 w-3 text-emerald-500" />
                  <span>UGX 500 bonus</span>
                </div>
                <div className="flex items-center gap-2 text-xs">
                  <Users className="h-3 w-3 text-emerald-500" />
                  <span>You earn UGX 500</span>
                </div>
              </div>
            </div>

            {/* Earnings Card */}
            <div className="bg-secondary/50 rounded-lg p-3 text-center">
              <p className="text-xs text-muted-foreground mb-1">Your potential earnings</p>
              <p className="text-lg font-bold text-primary">{formatUGX(referralCount * 500)}</p>
              <p className="text-xs text-muted-foreground">from {referralCount} referrals</p>
            </div>

            {/* Share Buttons */}
            <Button
              onClick={handleWhatsAppShare}
              className="w-full gap-3 bg-[#25D366] hover:bg-[#1fb855] text-white h-12"
            >
              <MessageCircle className="h-5 w-5" />
              Share on WhatsApp
            </Button>

            <Button
              onClick={handleCopyLink}
              variant="outline"
              className="w-full gap-3 h-12"
            >
              {copied ? (
                <>
                  <Check className="h-5 w-5 text-green-500" />
                  Copied!
                </>
              ) : (
                <>
                  <Copy className="h-5 w-5" />
                  Copy Invite Link
                </>
              )}
            </Button>

            <div className="bg-muted/50 rounded-lg p-3 text-center">
              <p className="text-xs text-muted-foreground mb-1">Your invite link:</p>
              <p className="text-xs font-mono break-all text-primary">{getShareLink()}</p>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
