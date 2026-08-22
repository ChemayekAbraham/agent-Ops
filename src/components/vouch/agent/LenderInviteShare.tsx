import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Share2, Copy, Check, MessageCircle, Link2 } from 'lucide-react';
import { toast } from 'sonner';

interface Props {
  /** The lending agent's Welile AI ID, e.g. WEL-AB12CD. */
  aiId: string | null;
  displayName?: string | null;
  /** `card` renders the full invite block, `icon` a compact header button. */
  variant?: 'card' | 'icon';
}

function buildLink(aiId: string) {
  const origin = typeof window !== 'undefined' ? window.location.origin : 'https://welileapp.com';
  return `${origin}/borrow/${aiId}`;
}

function buildMessage(aiId: string, name?: string | null) {
  const who = name?.trim() ? name.trim() : 'a Welile Lending Agent';
  return `Need a quick loan? I am ${who} on Welile. Send me your loan request here and I will review it: ${buildLink(aiId)}`;
}

/**
 * Lets a Lending Agent share a public borrower invite link.
 * Uses the native share sheet on phones and falls back to WhatsApp / copy.
 */
export default function LenderInviteShare({ aiId, displayName, variant = 'card' }: Props) {
  const [copied, setCopied] = useState(false);

  const link = aiId ? buildLink(aiId) : '';
  const message = aiId ? buildMessage(aiId, displayName) : '';

  const share = async () => {
    if (!aiId) { toast.error('Your AI ID is not ready yet'); return; }
    const payload: ShareData = { title: 'Borrow from me on Welile', text: message, url: link };
    if (typeof navigator !== 'undefined' && typeof navigator.share === 'function') {
      try {
        await navigator.share(payload);
        return;
      } catch (e: any) {
        if (e?.name === 'AbortError') return;
      }
    }
    window.open(
      `https://wa.me/?${new URLSearchParams({ text: message }).toString()}`,
      '_blank',
      'noopener,noreferrer',
    );
  };

  const copy = async () => {
    if (!aiId) return;
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      toast.success('Borrower link copied');
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error('Could not copy the link');
    }
  };

  if (variant === 'icon') {
    return (
      <Button
        size="icon"
        variant="outline"
        aria-label="Share your borrower link"
        className="h-10 w-10 rounded-2xl shrink-0"
        onClick={share}
      >
        <Share2 className="h-4 w-4" />
      </Button>
    );
  }

  return (
    <div className="rounded-2xl border border-primary/30 bg-gradient-to-br from-primary/10 to-emerald-500/5 p-4">
      <div className="flex items-start gap-3">
        <div className="h-9 w-9 shrink-0 rounded-xl bg-primary/15 flex items-center justify-center">
          <Link2 className="h-4.5 w-4.5 text-primary" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-bold leading-tight">Attract borrowers</p>
          <p className="mt-0.5 text-[11px] leading-relaxed text-muted-foreground">
            Share your personal link. Anyone who opens it can send a loan request straight to you.
          </p>
        </div>
      </div>

      <p className="mt-3 truncate rounded-xl bg-background/70 px-3 py-2 font-mono text-[11px]">
        {link || 'Preparing your link…'}
      </p>

      <div className="mt-3 grid grid-cols-2 gap-2">
        <Button className="h-11 rounded-2xl text-sm" onClick={share} disabled={!aiId}>
          <Share2 className="mr-1.5 h-4 w-4" /> Share link
        </Button>
        <Button variant="outline" className="h-11 rounded-2xl text-sm" onClick={copy} disabled={!aiId}>
          {copied ? <Check className="mr-1.5 h-4 w-4" /> : <Copy className="mr-1.5 h-4 w-4" />}
          {copied ? 'Copied' : 'Copy'}
        </Button>
      </div>
      <button
        type="button"
        onClick={share}
        disabled={!aiId}
        className="mt-2 inline-flex w-full items-center justify-center gap-1.5 text-[11px] font-semibold text-muted-foreground disabled:opacity-50"
      >
        <MessageCircle className="h-3.5 w-3.5" /> Send on WhatsApp
      </button>
    </div>
  );
}
