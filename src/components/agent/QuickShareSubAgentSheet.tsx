import { useState } from 'react';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { useAuth } from '@/hooks/useAuth';
import { useToast } from '@/hooks/use-toast';
import { useShortLink } from '@/hooks/useShortLink';
import { Copy, Check, Share2, Link2, Loader2 } from 'lucide-react';

interface QuickShareSubAgentSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function QuickShareSubAgentSheet({ open, onOpenChange }: QuickShareSubAgentSheetProps) {
  const { user } = useAuth();
  const { toast } = useToast();
  const [copied, setCopied] = useState(false);

  const { shortUrl, isLoading } = useShortLink({
    targetPath: '/auth',
    targetParams: { ref: user?.id || '', become: 'agent' },
    enabled: open && !!user,
  });

  const getWhatsAppMessage = () => {
    return `🚀 Join me on Welile as a Sub-Agent!

💰 What you'll earn:
• 8% commission on every rent collection
• Build your own team & earn even more

✨ FREE to join — no fees!

👉 Sign up here: ${shortUrl}

Let's grow together! 🤝`;
  };

  const handleCopy = async () => {
    await navigator.clipboard.writeText(shortUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
    toast({ title: 'Link copied!' });
  };

  const handleWhatsApp = () => {
    window.open(`https://wa.me/?text=${encodeURIComponent(getWhatsAppMessage())}`, '_blank');
  };

  const handleNativeShare = async () => {
    if (navigator.share) {
      try {
        await navigator.share({
          title: 'Join Welile as a Sub-Agent',
          text: 'Earn money collecting rent. Free to join!',
          url: shortUrl,
        });
      } catch { handleCopy(); }
    } else {
      handleCopy();
    }
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="bottom" className="rounded-t-2xl pb-8">
        <SheetHeader className="pb-4">
          <SheetTitle className="flex items-center gap-2 text-lg">
            <Share2 className="h-5 w-5 text-warning" />
            Share Your Signup Link
          </SheetTitle>
        </SheetHeader>

        <div className="space-y-4">
          {/* How it works */}
          <div className="space-y-2">
            {[
              { step: '1', text: 'Share this link with anyone' },
              { step: '2', text: 'They sign up as a NEW agent' },
              { step: '3', text: 'You instantly earn UGX 10,000 + 2% of all their collections forever' },
            ].map(s => (
              <div key={s.step} className="flex items-center gap-3 py-1.5">
                <Badge className="h-6 w-6 rounded-full p-0 flex items-center justify-center bg-warning text-warning-foreground text-xs font-bold">
                  {s.step}
                </Badge>
                <p className="text-sm">{s.text}</p>
              </div>
            ))}
          </div>

          {/* Link */}
          <div className="p-3 rounded-xl bg-muted/50 border border-border">
            <div className="flex items-center gap-2 text-xs text-muted-foreground mb-2">
              <Link2 className="h-3 w-3" />
              <span>Your personal signup link</span>
            </div>
            <div className="flex gap-2">
              <Input value={isLoading ? 'Generating...' : shortUrl} readOnly className="h-10 text-xs font-mono" />
              <Button
                variant={copied ? "default" : "outline"}
                size="icon"
                onClick={handleCopy}
                disabled={isLoading}
                className={`h-10 w-10 shrink-0 ${copied ? 'bg-success hover:bg-success/90' : ''}`}
              >
                {isLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : copied ? <Check className="h-4 w-4 text-white" /> : <Copy className="h-4 w-4" />}
              </Button>
            </div>
          </div>

          {/* Action buttons */}
          <div className="grid grid-cols-2 gap-2">
            <Button onClick={handleWhatsApp} disabled={isLoading} className="h-12 gap-2 bg-[hsl(142,70%,40%)] hover:bg-[hsl(142,70%,35%)] text-white font-semibold">
              <Share2 className="h-4 w-4" />
              WhatsApp
            </Button>
            <Button variant="outline" onClick={handleNativeShare} disabled={isLoading} className="h-12 gap-2 font-semibold">
              <Share2 className="h-4 w-4" />
              Share
            </Button>
          </div>

          <p className="text-[11px] text-center text-muted-foreground">
            ⚠️ This link is for <strong>new users only</strong>. To register someone directly, use "Register Agent".
          </p>
        </div>
      </SheetContent>
    </Sheet>
  );
}
