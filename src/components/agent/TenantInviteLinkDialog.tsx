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
import { UserPlus, Copy, Check, Share2, Link2 } from 'lucide-react';
import bannerImg from '@/assets/leaderboard-banner.jpg';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * "Onboard Tenant" invite-link dialog.
 *
 * Generates a copyable short link to the tenant self-onboarding flow
 * (`/tenants-onboarding?ref=<agentId>&become=tenant`). The referral is captured
 * durably on arrival, stored on the new tenant's profile at signup, and the
 * tenant-self-onboarding edge function assigns the tenant's Rent Request to
 * this agent — so the agent earns their commission on the tenant's collections.
 */
export function TenantInviteLinkDialog({ open, onOpenChange }: Props) {
  const { user } = useAuth();
  const { toast } = useToast();
  const [copied, setCopied] = useState(false);

  const { shortUrl: inviteLink } = useShortLink({
    targetPath: '/tenants-onboarding',
    targetParams: { ref: user?.id || '', become: 'tenant' },
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
      `Get your rent sorted with Welile! 🏠\n\nUse my link to sign up and submit your Rent Request — I'll be your agent and support you through the process:\n${inviteLink}`,
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
          <img src={bannerImg} alt="Welile tenant onboarding" className="h-32 w-full object-cover" />
          <div className="absolute inset-0 bg-gradient-to-t from-black/70 via-black/10 to-transparent" />
          <div className="absolute inset-x-0 bottom-0 p-4">
            <div className="flex items-center gap-2 text-white">
              <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-white/20 backdrop-blur-md ring-1 ring-white/25">
                <UserPlus className="h-5 w-5" style={{ color: '#FACC15' }} strokeWidth={2.3} />
              </span>
              <DialogTitle className="text-lg font-extrabold tracking-tight drop-shadow">
                Onboard a Tenant
              </DialogTitle>
            </div>
          </div>
        </div>

        {/* Body */}
        <div className="p-5 space-y-4">
          <DialogDescription asChild>
            <p className="text-center text-[14px] leading-relaxed text-muted-foreground">
              Share your invite link. Anyone who registers through it is linked to you
              automatically — you become their agent and earn commission on their
              Rent Plan collections.
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
              style={{ background: 'linear-gradient(135deg, #0D9488, #0F766E)' }}
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

export default TenantInviteLinkDialog;
