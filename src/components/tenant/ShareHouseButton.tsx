import { useState } from 'react';
import { Share2, Check, Copy, MessageCircle } from 'lucide-react';
import { hapticTap } from '@/lib/haptics';
import { useToast } from '@/hooks/use-toast';
import { formatUGX } from '@/lib/rentCalculations';
import { supabase } from '@/integrations/supabase/client';

const APP_URL = 'https://welileapp.com';

interface ShareHouseButtonProps {
  listingId: string;
  title: string;
  region: string;
  dailyRate: number;
  shortCode?: string | null;
  address?: string | null;
  monthlyRent?: number | null;
  rooms?: number | null;
  category?: string | null;
  /** 'icon' = small icon button, 'full' = full-width button with WhatsApp */
  variant?: 'icon' | 'full';
  /** 'share' = try native share first (default), 'copy' = copy to clipboard immediately, 'whatsapp' = copy link + open WhatsApp in one tap */
  mode?: 'share' | 'copy' | 'whatsapp';
}

export function ShareHouseButton({ listingId, title, region, dailyRate, shortCode, address, monthlyRent, rooms, category, variant = 'icon', mode = 'share' }: ShareHouseButtonProps) {
  const { toast } = useToast();
  const [copied, setCopied] = useState(false);

  // Fire-and-forget share analytics — never blocks or breaks the share UX
  const trackShare = (shareMethod: 'native' | 'whatsapp' | 'copy') => {
    void (async () => {
      try {
        const { data: { user } } = await supabase.auth.getUser();
        await supabase.from('house_share_events').insert({
          listing_id: listingId,
          share_method: shareMethod,
          short_code: shortCode ?? null,
          user_id: user?.id ?? null,
        });
      } catch { /* analytics is best-effort */ }
    })();
  };

  const shareUrl = shortCode
    ? `${APP_URL}/house/${shortCode}`
    : `${APP_URL}/house/${listingId}`;

  const locationLine = address ? `${address}${region ? `, ${region}` : ''}` : region;
  const roomsLine = rooms ? `${rooms} room${rooms > 1 ? 's' : ''}${category ? ` · ${category}` : ''}` : (category || '');
  const priceLine = monthlyRent
    ? `💰 ${formatUGX(monthlyRent)}/month (≈ ${formatUGX(dailyRate)}/day)`
    : `💰 ${formatUGX(dailyRate)}/day`;

  const message = [
    `🏠 *Check out this house on Welile!*`,
    ``,
    `*${title}*`,
    `📍 ${locationLine}`,
    ...(roomsLine ? [`🏠 ${roomsLine}`] : []),
    priceLine,
    ``,
    `🎁 Move in TODAY — your first 7 days are FREE, then just pay daily.`,
    `Pay daily, weekly, or monthly through Welile — no big upfront deposit needed.`,
    ``,
    `👉 View & reserve: ${shareUrl}`,
  ].join('\n');

  const handleCopyLink = async (e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(message);
      setCopied(true);
      toast({ title: 'Link copied!', description: 'Paste it on WhatsApp or anywhere to share.' });
      setTimeout(() => setCopied(false), 2000);
      trackShare('copy');
    } catch {
      toast({ title: 'Could not copy', variant: 'destructive' });
    }
  };

  const handleWhatsApp = (e: React.MouseEvent) => {
    e.stopPropagation();
    window.open(`https://wa.me/?text=${encodeURIComponent(message)}`, '_blank');
    trackShare('whatsapp');
  };

  const handleShareOnWhatsApp = async (e: React.MouseEvent) => {
    e.stopPropagation();
    hapticTap();
    try {
      await navigator.clipboard.writeText(message);
      setCopied(true);
      toast({ title: 'Link copied — opening WhatsApp!', description: 'Paste the link in the chat if it is not pre-filled.' });
      setTimeout(() => setCopied(false), 2500);
    } catch {
      toast({ title: 'Could not copy link', variant: 'destructive' });
    }
    window.open(`https://wa.me/?text=${encodeURIComponent(message)}`, '_blank');
    trackShare('whatsapp');
  };

  const handleNativeShare = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (navigator.share) {
      try {
        await navigator.share({ title: `${title} — Welile`, text: message, url: shareUrl });
        trackShare('native');
      } catch {}
    } else {
      handleCopyLink(e);
    }
  };

  // Icon variant — small overlay button
  if (variant === 'icon') {
    if (mode === 'whatsapp') {
      return (
        <button
          onClick={handleShareOnWhatsApp}
          className="p-1.5 rounded-full bg-[#25D366]/15 border border-[#25D366]/40 shadow-sm hover:bg-[#25D366]/25 transition-colors touch-manipulation"
          title="Share on WhatsApp"
        >
          {copied ? <Check className="h-3.5 w-3.5 text-success" /> : <MessageCircle className="h-3.5 w-3.5 text-[#25D366]" />}
        </button>
      );
    }
    const isCopy = mode === 'copy';
    return (
      <button
        onClick={isCopy ? handleCopyLink : handleNativeShare}
        className="p-1.5 rounded-full bg-card/80 backdrop-blur-sm border border-border/50 shadow-sm hover:bg-muted transition-colors touch-manipulation"
        title={isCopy ? 'Copy share link' : 'Share this house'}
      >
        {copied ? <Check className="h-3.5 w-3.5 text-success" /> : isCopy ? <Copy className="h-3.5 w-3.5 text-muted-foreground" /> : <Share2 className="h-3.5 w-3.5 text-muted-foreground" />}
      </button>
    );
  }

  // Full variant — WhatsApp + Copy buttons
  return (
    <div className="flex gap-2">
      <button
        onClick={handleWhatsApp}
        className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl bg-[#25D366]/10 border border-[#25D366]/30 text-[#25D366] hover:bg-[#25D366]/20 text-sm font-semibold transition-colors touch-manipulation active:scale-[0.97] min-h-[44px]"
      >
        <MessageCircle className="h-4 w-4" />
        WhatsApp
      </button>
      <button
        onClick={handleCopyLink}
        className="flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl border border-border bg-card hover:bg-muted text-sm font-medium transition-colors touch-manipulation active:scale-[0.97] min-h-[44px]"
      >
        {copied ? <Check className="h-4 w-4 text-success" /> : <Copy className="h-4 w-4" />}
        {copied ? 'Copied!' : 'Copy Link'}
      </button>
    </div>
  );
}
