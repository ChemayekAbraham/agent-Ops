import { useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { useAuth } from '@/hooks/useAuth';
import { useShortLink } from '@/hooks/useShortLink';
import { hapticTap } from '@/lib/haptics';
import { useToast } from '@/hooks/use-toast';
import { UsersRound, Copy, Check, Share2, Link2 } from 'lucide-react';
import bannerImg from '@/assets/leaderboard-banner.jpg';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * Lightweight "share your sub-agent invite link" dialog.
 *
 * Unlike the full register flow, this simply gives the agent a copyable link
 * that lets a prospective sub-agent self-register under them
 * (`/auth?signup=1&role=agent&ref=<agentId>`). Referral attribution flows into
 * the Weekly Listing Mission counts.
 */
export function SubAgentInviteLinkDialog({ open, onOpenChange }: Props) {
  const { user } = useAuth();
  const { toast } = useToast();
  const [copied, setCopied] = useState(false);

  const { shortUrl: inviteLink } = useShortLink({
    targetPath: '/auth',
    targetParams: { ref: user?.id || '', become: 'agent' },
    enabled: !!user && open,
  });

  const handleCopy = async () => {
    if (!inviteLink) return;
    hapticTap();
    try {
      await navigator.clipboard.writeText(inviteLink);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
      toast({ title: 'Invite link copied!' });
    } catch {
      toast({ title: 'Could not copy', description: 'Long-press the link to copy manually.', variant: 'destructive' });
    }
  };

  const handleWhatsApp = () => {
    if (!inviteLink) return;
    hapticTap();
    const message = encodeURIComponent(
      `Join my Welile agent team! 🏠\n\nSign up as a sub-agent using my invite link and start listing verified houses:\n${inviteLink}`,
    );
    window.open(`https://wa.me/?text=${message}`, '_blank');
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="grid-cols-1 w-[calc(100%-1.5rem)] max-w-[24rem] rounded-3xl border-0 p-0 overflow-hidden gap-0"
        overlayClassName="backdrop-blur-sm bg-background/70"
      >
        {/* Hero banner */}
        <div className="relative">
          <img src={bannerImg} alt="Welile agent team" className="h-32 w-full object-cover" />
          <div className="absolute inset-0 bg-gradient-to-t from-black/70 via-black/10 to-transparent" />
          <div className="absolute inset-x-0 bottom-0 p-4">
            <div className="flex items-center gap-2 text-white">
              <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-white/20 backdrop-blur-md ring-1 ring-white/25">
                <UsersRound className="h-5 w-5" style={{ color: '#FACC15' }} strokeWidth={2.3} />
              </span>
              <DialogTitle className="text-lg font-extrabold tracking-tight drop-shadow">
                Invite Sub-Agents
              </DialogTitle>
            </div>
          </div>
        </div>

        {/* Body */}
        <div className="p-5 space-y-4">
          <DialogDescription asChild>
            <p className="text-center text-[14px] leading-relaxed text-muted-foreground">
              Share your invite link. Anyone who signs up through it joins your team
              automatically — no registration needed on your side.
            </p>
          </DialogDescription>

          {/* Copyable link box */}
          <div className="flex items-center gap-2 rounded-2xl border border-primary/25 bg-primary/5 p-3 overflow-hidden">
            <Link2 className="h-4 w-4 shrink-0 text-primary" />
            <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-foreground">
              {inviteLink || 'Loading link…'}
            </span>
          </div>

          {/* Actions */}
          <div className="space-y-2">
            <Button
              onClick={handleCopy}
              disabled={!inviteLink}
              className="w-full h-12 rounded-2xl text-[15px] font-bold text-white shadow-md active:scale-[0.98] transition-transform"
              style={{ background: 'linear-gradient(135deg, #9334EB, #6D28D9)' }}
            >
              {copied ? <Check className="mr-1.5 h-4.5 w-4.5" /> : <Copy className="mr-1.5 h-4.5 w-4.5" />}
              {copied ? 'Copied!' : 'Copy Invite Link'}
            </Button>
            <Button
              variant="ghost"
              onClick={handleWhatsApp}
              disabled={!inviteLink}
              className="w-full h-11 rounded-2xl text-[14px] font-semibold text-foreground hover:bg-muted"
            >
              <Share2 className="mr-1.5 h-4 w-4" style={{ color: '#22C55E' }} />
              Share on WhatsApp
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export default SubAgentInviteLinkDialog;