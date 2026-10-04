import { useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { useAuth } from '@/hooks/useAuth';
import { getPublicOrigin } from '@/lib/getPublicOrigin';
import { useToast } from '@/hooks/use-toast';
import { hapticTap } from '@/lib/haptics';
import { useShortLink } from '@/hooks/useShortLink';
import { useIsMerchantAgent } from '@/hooks/useIsMerchantAgent';
import { Share2, Copy, Check, UserPlus, BadgeDollarSign } from 'lucide-react';
import { useNavigate } from 'react-router-dom';

/**
 * "Invite Merchant Agent" card — only rendered for active Merchant Agents.
 * Reward pool per new Merchant Agent is UGX 10,000, split across two generations:
 * UGX 4,000 to the direct recruiter and UGX 6,000 to the recruiter's own recruiter
 * (the full UGX 10,000 goes to the direct recruiter when there is no upline).
 * Paid only after the new Merchant Agent processes their first payout with proof.
 */
export function InviteMerchantAgentCard() {
  const { user } = useAuth();
  const { isMerchantAgent, loading } = useIsMerchantAgent();
  const { toast } = useToast();
  const navigate = useNavigate();
  const [copied, setCopied] = useState(false);

  const longUrl = useMemo(
    () => (user?.id ? `${getPublicOrigin()}/merchant/register?ref=${user.id}` : ''),
    [user?.id],
  );

  const { shortUrl } = useShortLink({
    targetPath: '/merchant/register',
    targetParams: { ref: user?.id ?? '' },
    enabled: !!user?.id && isMerchantAgent,
  });

  const inviteUrl = shortUrl || longUrl;

  if (loading || !isMerchantAgent) return null;

  const message =
    `Join Welile as a Merchant Agent and start earning commissions by serving customers in your community.\n\n` +
    `Register using my invitation link:\n${inviteUrl}\n\n` +
    `Complete your registration and become an approved Merchant Agent today.`;

  const handleWhatsApp = () => {
    hapticTap();
    window.open(`https://wa.me/?text=${encodeURIComponent(message)}`, '_blank');
  };

  const handleCopy = async () => {
    hapticTap();
    try {
      await navigator.clipboard.writeText(inviteUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
      toast({ title: 'Invite link copied' });
    } catch {
      toast({ title: 'Copy failed', description: 'Long-press the link to copy.', variant: 'destructive' });
    }
  };

  return (
    <Card className="p-4 rounded-2xl border border-primary/25 bg-gradient-to-br from-primary/5 to-primary/0">
      <div className="flex items-start gap-3">
        <div className="p-2.5 rounded-xl bg-primary/15 shrink-0">
          <UserPlus className="h-5 w-5 text-primary" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h3 className="text-base font-bold">Invite a Merchant Agent</h3>
            <span className="inline-flex items-center gap-1 h-5 px-1.5 rounded-full bg-success/15 text-success text-[10px] font-bold">
              <BadgeDollarSign className="h-3 w-3" /> UGX 10,000
            </span>
          </div>
          <p className="text-xs text-muted-foreground mt-1">
            Earn UGX 4,000 for a direct recruit, plus UGX 6,000 when they recruit someone else — like a
            sub-agent network. Paid after your recruit processes their first payout with proof.
          </p>
          <div className="mt-3 space-y-2">
            <Button onClick={handleWhatsApp} className="w-full h-11 rounded-xl font-semibold">
              <Share2 className="h-4 w-4 mr-1.5" />
              Invite via WhatsApp
            </Button>
            <div className="grid grid-cols-2 gap-2">
              <Button variant="outline" onClick={handleCopy} className="h-10 rounded-xl font-medium">
                {copied ? <Check className="h-4 w-4 mr-1.5" /> : <Copy className="h-4 w-4 mr-1.5" />}
                {copied ? 'Copied' : 'Copy link'}
              </Button>
              <Button variant="ghost" onClick={() => navigate('/merchant-agent-referrals')} className="h-10 rounded-xl font-medium">
                My referrals
              </Button>
            </div>
          </div>
        </div>
      </div>
    </Card>
  );
}

export default InviteMerchantAgentCard;