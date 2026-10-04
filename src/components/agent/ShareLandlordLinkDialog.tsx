import { useState, useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { MessageCircle, Copy, Check, Building2, Loader2 } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { toast } from 'sonner';
import { useAuth } from '@/hooks/useAuth';
import { createShortLink } from '@/lib/createShortLink';

interface ShareLandlordLinkDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function ShareLandlordLinkDialog({ open, onOpenChange }: ShareLandlordLinkDialogProps) {
  const { user } = useAuth();
  const [link, setLink] = useState<string>('');
  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!open || !user || link) return;
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const url = await createShortLink(user.id, '/landlord-signup', { ref: user.id });
        if (!cancelled) setLink(url);
      } catch (err: any) {
        if (!cancelled) toast.error(err.message || 'Failed to generate link');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [open, user, link]);

  const shareMessage = `🏠 Guarantee your rent for 12 months with Welile! No more chasing tenants — we pay you on time every month, even if the tenant delays. Sign up here: ${link}`;

  const handleCopy = async () => {
    if (!link) return;
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      toast.success('Landlord signup link copied!');
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error('Failed to copy link');
    }
  };

  const handleWhatsApp = () => {
    if (!link) return;
    const url = `https://wa.me/?text=${encodeURIComponent(shareMessage)}`;
    window.open(url, '_blank');
  };

  const handleNativeShare = async () => {
    if (!link) return;
    if (navigator.share) {
      try {
        await navigator.share({
          title: 'Become a Welile Landlord',
          text: shareMessage,
          url: link,
        });
      } catch (err) {
        if ((err as Error).name !== 'AbortError') {
          toast.error('Sharing failed');
        }
      }
    } else {
      handleCopy();
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle className="flex items-center justify-center gap-2 text-center">
            <Building2 className="h-5 w-5 text-primary" />
            Invite a Landlord
          </DialogTitle>
          <DialogDescription className="text-center">
            Share your unique link. When a landlord signs up, the property is attributed to you and you earn commission.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3 pt-2">
          {/* Reward info */}
          <div className="bg-gradient-to-r from-primary/10 to-success/10 rounded-lg p-3 border border-primary/20">
            <p className="text-xs text-center text-muted-foreground">
              Landlords get <span className="font-bold text-primary">12 months guaranteed rent</span> — you get the credit!
            </p>
          </div>

          <Button
            onClick={handleWhatsApp}
            disabled={loading || !link}
            className="w-full gap-3 bg-[#25D366] hover:bg-[#1fb855] text-white h-12"
          >
            {loading ? (
              <Loader2 className="h-5 w-5 animate-spin" />
            ) : (
              <>
                <MessageCircle className="h-5 w-5" />
                Share on WhatsApp
              </>
            )}
          </Button>

          <Button
            onClick={handleCopy}
            disabled={loading || !link}
            variant="outline"
            className="w-full gap-3 h-12"
          >
            {copied ? (
              <>
                <Check className="h-5 w-5 text-success" />
                Copied!
              </>
            ) : (
              <>
                <Copy className="h-5 w-5" />
                Copy Link
              </>
            )}
          </Button>

          {typeof navigator !== 'undefined' && 'share' in navigator && (
            <Button
              onClick={handleNativeShare}
              disabled={loading || !link}
              variant="ghost"
              className="w-full h-10 text-sm"
            >
              More sharing options…
            </Button>
          )}

          <div className="bg-secondary/50 rounded-lg p-3 text-center">
            <p className="text-xs text-muted-foreground mb-1">Your unique landlord invite link:</p>
            <p className="text-xs font-mono break-all text-primary">
              {loading ? 'Generating…' : link || '—'}
            </p>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
