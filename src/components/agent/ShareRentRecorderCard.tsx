import { useEffect, useState } from 'react';
import { useAuth } from '@/hooks/useAuth';
import { supabase } from '@/integrations/supabase/client';
import { Button } from '@/components/ui/button';
import { MessageCircle, Copy, Check, ClipboardList, TrendingUp, Sparkles } from 'lucide-react';
import { toast } from 'sonner';
import { hapticTap } from '@/lib/haptics';
import { getPublicOrigin } from '@/lib/getPublicOrigin';

/**
 * Prominent agent-dashboard card.
 * Shares a public, no-login rent-history recorder link via WhatsApp.
 * Anyone tapping the link can record their last 12 months of rent — no signup.
 */
export function ShareRentRecorderCard() {
  const { user } = useAuth();
  const [copied, setCopied] = useState(false);
  const [submissionCount, setSubmissionCount] = useState<number | null>(null);

  // Permanent, never-expiring direct link. Works offline (no DB resolve needed),
  // opens on every device, no signup, no short-code lookup. Uses the canonical
  // production domain so the same link always resolves even if shared from preview.
  const PUBLIC_BASE = getPublicOrigin();
  const shortUrl = user ? `${PUBLIC_BASE}/record-rent?a=${user.id}` : '';
  const isLoading = !user;

  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    (async () => {
      const { count } = await supabase
        .from('public_rent_history_submissions')
        .select('*', { count: 'exact', head: true })
        .eq('agent_id', user.id);
      if (!cancelled) setSubmissionCount(count ?? 0);
    })();
    return () => {
      cancelled = true;
    };
  }, [user]);

  const link = shortUrl;

  // SHORT message + link FIRST = maximum compatibility.
  // Older Android WhatsApp, WhatsApp Business, KaiOS clones and feature phones
  // truncate long messages, strip emojis, or fail to auto-link URLs that
  // aren't on the first line. URL-first guarantees it's tappable everywhere.
  const message = link
    ? `${link}\n\nRecord your rent with Welile. No signup. Qualify for a rent advance.`
    : '';

  // Use api.whatsapp.com (works on more devices than wa.me, including
  // WhatsApp Business + older Android WebViews) with a navigation fallback
  // for in-app browsers (Facebook/Instagram) that block window.open popups.
  const openWhatsApp = (url: string) => {
    const win = window.open(url, '_blank', 'noopener,noreferrer');
    if (!win) window.location.href = url;
  };

  const handleWhatsApp = () => {
    if (!link) return;
    hapticTap();
    openWhatsApp(`https://api.whatsapp.com/send?text=${encodeURIComponent(message)}`);
  };

  const handleCopy = async () => {
    if (!link) return;
    hapticTap();
    try {
      await navigator.clipboard.writeText(link);
    } catch {
      // Fallback for older browsers / non-secure contexts
      const ta = document.createElement('textarea');
      ta.value = link;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); } catch { /* ignore */ }
      document.body.removeChild(ta);
    }
    setCopied(true);
    toast.success('Link copied — paste it anywhere!');
    setTimeout(() => setCopied(false), 2000);
  };

  const handleNativeShare = async () => {
    if (!link) return;
    hapticTap();
    // OS share sheet handles ALL apps (WhatsApp, SMS, Telegram, Messenger,
    // Signal, email) on every device that supports Web Share API.
    if (navigator.share) {
      try {
        await navigator.share({ title: 'Record your rent — Welile', text: message, url: link });
        return;
      } catch {
        /* user cancelled or unsupported — fall through */
      }
    }
    handleWhatsApp();
  };

  return (
    <div
      className="animate-fade-in rounded-2xl border-2 border-success/40 bg-gradient-to-br from-success/10 via-background to-primary/5 p-4 shadow-sm"
    >
      <div className="flex items-start gap-3">
        <div className="p-2.5 rounded-xl bg-gradient-to-br from-success to-success/70 text-success-foreground shadow-md shrink-0">
          <ClipboardList className="h-5 w-5" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <h3 className="font-extrabold text-base leading-tight">Send rent recorder</h3>
            <span className="text-[10px] uppercase font-bold tracking-wider bg-success/20 text-success px-2 py-0.5 rounded-full">
              No signup
            </span>
          </div>
          <p className="text-xs text-muted-foreground mt-1 leading-snug">
            Share on WhatsApp. Anyone taps it, records their rent, qualifies for advances. You earn from every active tenant.
          </p>
        </div>
      </div>

      {/* Stats strip */}
      <div className="mt-3 grid grid-cols-3 gap-2">
        <Stat label="Records in" value={submissionCount === null ? '—' : String(submissionCount)} />
        <Stat label="Per record" value="UGX 500" tone="success" />
        <Stat label="Tap to send" value="📲" />
      </div>

      {/* Big WhatsApp CTA */}
      <Button
        onClick={handleWhatsApp}
        disabled={!link || isLoading}
        className="mt-3 w-full h-14 gap-2 bg-[#25D366] hover:bg-[#1fb855] text-white text-base font-extrabold rounded-xl shadow-md"
      >
        <MessageCircle className="h-5 w-5" />
        Share on WhatsApp
      </Button>

      <div className="mt-2 grid grid-cols-2 gap-2">
        <Button onClick={handleCopy} variant="outline" disabled={!link} className="h-11 gap-2 text-xs font-bold">
          {copied ? <Check className="h-4 w-4 text-success" /> : <Copy className="h-4 w-4" />}
          {copied ? 'Copied' : 'Copy link'}
        </Button>
        <Button onClick={handleNativeShare} variant="outline" disabled={!link} className="h-11 gap-2 text-xs font-bold">
          <TrendingUp className="h-4 w-4" />
          More apps
        </Button>
      </div>

      {link && (
        <button
          type="button"
          onClick={handleCopy}
          className="mt-3 w-full flex items-center gap-2 rounded-xl border border-dashed border-primary/40 bg-primary/5 hover:bg-primary/10 active:bg-primary/15 transition-colors p-2.5 text-left"
          aria-label="Tap to copy your share link"
        >
          {copied ? (
            <Check className="h-4 w-4 text-success shrink-0" />
          ) : (
            <Copy className="h-4 w-4 text-primary shrink-0" />
          )}
          <span className="flex-1 min-w-0">
            <span className="block text-[9px] uppercase tracking-wider font-bold text-primary">
              {copied ? 'Copied!' : 'Your share link — tap to copy'}
            </span>
            <span className="block text-[11px] font-mono text-foreground/80 break-all">
              {link}
            </span>
          </span>
        </button>
      )}

      <div className="mt-3 flex items-start gap-2 rounded-xl bg-primary/5 border border-primary/15 p-2.5">
        <Sparkles className="h-3.5 w-3.5 text-primary shrink-0 mt-0.5" />
        <p className="text-[11px] text-foreground/80 leading-snug">
          <span className="font-bold">Pro tip:</span> Send to WhatsApp groups & status. Every verified record raises your team's collection volume.
        </p>
      </div>
    </div>
  );
}

function Stat({ label, value, tone = 'default' }: { label: string; value: string; tone?: 'default' | 'success' }) {
  return (
    <div
      className={`rounded-lg p-2 text-center border ${
        tone === 'success' ? 'bg-success/10 border-success/30' : 'bg-muted/30 border-border'
      }`}
    >
      <p className={`text-base font-extrabold leading-none ${tone === 'success' ? 'text-success' : 'text-foreground'}`}>
        {value}
      </p>
      <p className="text-[9px] uppercase tracking-wider text-muted-foreground mt-1 font-bold">{label}</p>
    </div>
  );
}
