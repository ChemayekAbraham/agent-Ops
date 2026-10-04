import { useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Check, Copy, Facebook, Loader2, Mail, MessageCircle, Send, Share2, Twitter } from 'lucide-react';
import { toast } from 'sonner';
import { supabase } from '@/integrations/supabase/client';
import {
  createPlanShareLink,
  planShareDescription,
  planShareTitle,
  type SharePlanInput,
} from '@/lib/planShareLink';

async function buildLink(plan: SharePlanInput) {
  const { data } = await supabase.auth.getUser();
  const userId = data.user?.id;
  if (!userId) throw new Error('Sign in to share this plan');
  return createPlanShareLink(userId, plan.rent_request_id);
}

/**
 * Trackable share action for a fundable rent plan.
 *
 * Always opens a real share surface: the native OS/browser share sheet when the
 * Web Share API is available (mobile, Safari, Edge), otherwise a platform
 * picker so desktop users can still post to WhatsApp, Telegram, Facebook, X,
 * email or SMS. Clipboard copy is only ever an explicit last option.
 */
export function PlanShareButton({
  plan,
  variant = 'icon',
}: {
  plan: SharePlanInput;
  variant?: 'icon' | 'block';
}) {
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [link, setLink] = useState('');

  const title = planShareTitle(plan);
  const description = planShareDescription(plan);
  const message = `${title}\n\n${description}`;

  const start = async () => {
    setBusy(true);
    try {
      // publicShareUrl — the branded welileapp.com short link. The internal
      // Open Graph endpoint is never exposed to the share surfaces.
      const { share_url: publicShareUrl } = await buildLink(plan);
      setLink(publicShareUrl);

      const payload: ShareData = { title, text: description, url: publicShareUrl };
      const canNative =
        typeof navigator !== 'undefined' &&
        typeof navigator.share === 'function' &&
        (typeof navigator.canShare !== 'function' || navigator.canShare(payload));

      if (canNative) {
        try {
          await navigator.share(payload);
          return;
        } catch (e: any) {
          if (e?.name === 'AbortError') return;
        }
      }
      setPickerOpen(true);
    } catch (e: any) {
      toast.error(e?.message ?? 'Could not create the share link');
    } finally {
      setBusy(false);
    }
  };

  const full = `${message}\n${link}`;
  const openTarget = (href: string) => {
    window.open(href, '_blank', 'noopener,noreferrer');
    setPickerOpen(false);
  };

  const targets = [
    {
      label: 'WhatsApp',
      icon: MessageCircle,
      // Exactly one URL in the message, and it is the branded welileapp.com
      // short link. Encoded once, via URLSearchParams only.
      onClick: () => openTarget(`https://wa.me/?${new URLSearchParams({ text: full }).toString()}`),
    },
    {
      label: 'Telegram',
      icon: Send,
      onClick: () =>
        openTarget(
          `https://t.me/share/url?url=${encodeURIComponent(link)}&text=${encodeURIComponent(message)}`,
        ),
    },
    {
      label: 'Facebook',
      icon: Facebook,
      onClick: () => openTarget(`https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(link)}`),
    },
    {
      label: 'X',
      icon: Twitter,
      onClick: () =>
        openTarget(
          `https://twitter.com/intent/tweet?text=${encodeURIComponent(message)}&url=${encodeURIComponent(link)}`,
        ),
    },
    {
      label: 'Email',
      icon: Mail,
      onClick: () =>
        openTarget(`mailto:?subject=${encodeURIComponent(title)}&body=${encodeURIComponent(full)}`),
    },
    {
      label: 'SMS',
      icon: MessageCircle,
      onClick: () => openTarget(`sms:?&body=${encodeURIComponent(full)}`),
    },
  ];

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(full);
      setCopied(true);
      toast.success('Share link copied');
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error('Could not copy the link');
    }
  };

  const trigger =
    variant === 'block' ? (
      <Button
        variant="outline"
        className="w-full gap-2 rounded-xl"
        disabled={busy}
        onClick={(e) => {
          e.stopPropagation();
          void start();
        }}
      >
        {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Share2 className="h-4 w-4" />}
        Share this plan
      </Button>
    ) : (
      <Button
        size="icon"
        variant="outline"
        disabled={busy}
        aria-label="Share this rent plan"
        className="h-10 w-10 shrink-0 rounded-full"
        onClick={(e) => {
          e.stopPropagation();
          void start();
        }}
      >
        {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Share2 className="h-4 w-4" />}
      </Button>
    );

  return (
    <>
      {trigger}

      <Dialog open={pickerOpen} onOpenChange={setPickerOpen}>
        <DialogContent
          className="max-w-sm"
          onClick={(e) => e.stopPropagation()}
        >
          <DialogHeader>
            <DialogTitle className="text-base">Share this rent plan</DialogTitle>
            <DialogDescription className="text-xs">{description}</DialogDescription>
          </DialogHeader>

          <div className="grid grid-cols-3 gap-2">
            {targets.map((t) => (
              <button
                key={t.label}
                type="button"
                onClick={t.onClick}
                className="flex flex-col items-center gap-1.5 rounded-xl border border-border bg-card p-3 text-xs font-semibold transition hover:bg-accent"
              >
                <t.icon className="h-5 w-5 text-primary" />
                {t.label}
              </button>
            ))}
          </div>

          <p className="truncate rounded-lg bg-muted px-3 py-2 text-[11px] font-mono">{link}</p>

          <Button variant="outline" className="w-full gap-2" onClick={copy}>
            {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
            {copied ? 'Copied' : 'Copy link'}
          </Button>
        </DialogContent>
      </Dialog>
    </>
  );
}
