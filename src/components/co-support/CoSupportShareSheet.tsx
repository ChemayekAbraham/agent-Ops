import { Copy, Home, MessageCircle } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { formatUGX } from '@/lib/rentCalculations';
import {
  coSupportShareText,
  coSupportShareUrl,
  coSupportTimeLeft,
  whatsappShareUrl,
  type CoSupportInvite,
} from '@/lib/coSupport';

/** Countdown text from the server's expires_at. */
export function CoSupportCountdown({ expiresAt }: { expiresAt: string }) {
  const t = coSupportTimeLeft(expiresAt);
  return (
    <span className="text-xs font-medium text-muted-foreground">
      {t.expired ? 'The 48 hours ran out' : `Open for ${t.hours}h ${t.minutes}m`}
    </span>
  );
}

/** Section 2: the sender shares the invitation (WhatsApp or copy link). */
export function CoSupportShareSheet({
  invite,
  open,
  onOpenChange,
}: {
  invite: CoSupportInvite | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  if (!invite) return null;
  const url = invite.code ? coSupportShareUrl(invite.code) : null;
  const isHouse = invite.kind === 'house';
  const text = url
    ? coSupportShareText({
        kind: invite.kind,
        houseTitle: invite.house_title,
        tenantFirstName: invite.tenant_first_name,
        city: invite.city,
        partnerShare: invite.partner_share,
        url,
      })
    : null;

  const copy = async () => {
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      toast.success('Link copied');
    } catch {
      toast.error('Could not copy the link. Please try again.');
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Support with a partner</DialogTitle>
          <DialogDescription>Send this link to the partner who will support this {isHouse ? 'empty house' : 'Rent Plan'} with you.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="overflow-hidden rounded-lg border bg-muted">
            {invite.house_image_url ? (
              <img src={invite.house_image_url} alt="House" className="aspect-[16/9] w-full object-cover" />
            ) : (
              <div className="flex aspect-[16/9] items-center justify-center bg-primary/5">
                <Home className="h-8 w-8 text-primary/45" aria-hidden />
              </div>
            )}
          </div>
          <p className="text-sm font-semibold text-foreground">
            {isHouse ? invite.house_title ?? 'Empty house' : invite.tenant_first_name ?? 'Tenant'}
            {invite.city ? <span className="font-normal text-muted-foreground"> · {invite.city}</span> : null}
          </p>
          <p className="text-sm text-foreground">
            Your half: {formatUGX(invite.your_share)} · Your partner's half: {formatUGX(invite.partner_share)}
          </p>
          {invite.your_monthly_rent_profit_share != null ? (
            <p className="text-sm text-foreground">
              Your Rent Profit Share: <span className="font-semibold text-primary">{formatUGX(invite.your_monthly_rent_profit_share)}</span> a month
            </p>
          ) : null}
          <CoSupportCountdown expiresAt={invite.expires_at} />
        </div>
        <div className="grid gap-2 pt-2">
          <Button asChild disabled={!text}>
            <a href={text ? whatsappShareUrl(text) : undefined} target="_blank" rel="noopener noreferrer">
              <MessageCircle className="h-4 w-4" aria-hidden />
              WhatsApp
            </a>
          </Button>
          <Button variant="outline" onClick={copy} disabled={!url}>
            <Copy className="h-4 w-4" aria-hidden />
            Copy link
          </Button>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Done
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
