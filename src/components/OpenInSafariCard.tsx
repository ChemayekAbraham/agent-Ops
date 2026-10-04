import { useMemo, useState } from 'react';
import { Copy, ExternalLink, Share2, Check } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { isChromeIOS, isFirefoxIOS, isIOSInAppBrowser } from '@/hooks/useIOSCompatibility';
import { trackInstallEvent } from '@/lib/installTracking';

type Browser =
  | 'safari'
  | 'chrome-ios'
  | 'firefox-ios'
  | 'facebook'
  | 'instagram'
  | 'messenger'
  | 'whatsapp'
  | 'tiktok'
  | 'twitter'
  | 'linkedin'
  | 'line'
  | 'wechat'
  | 'snapchat'
  | 'telegram'
  | 'other-in-app';

interface DetectedBrowser {
  key: Browser;
  label: string;
  /** Menu icon description users will see. */
  menuIcon: string;
  /** Ordered tap instructions to reach Safari. */
  steps: string[];
}

function detectBrowser(): DetectedBrowser {
  const ua = navigator.userAgent || '';
  if (/FBAN|FBAV/i.test(ua) && /Messenger/i.test(ua))
    return {
      key: 'messenger',
      label: 'Facebook Messenger',
      menuIcon: 'the ⋯ menu (top right)',
      steps: [
        'Tap the ⋯ menu in the top right',
        'Choose "Open in Safari" (or "Open in Browser")',
      ],
    };
  if (/FBAN|FBAV/i.test(ua))
    return {
      key: 'facebook',
      label: 'Facebook',
      menuIcon: 'the ⋯ menu (bottom right)',
      steps: [
        'Tap the ⋯ menu at the bottom right',
        'Choose "Open in External Browser" / "Open in Safari"',
      ],
    };
  if (/Instagram/i.test(ua))
    return {
      key: 'instagram',
      label: 'Instagram',
      menuIcon: 'the ⋯ menu (top right)',
      steps: [
        'Tap the ⋯ menu at the top right',
        'Choose "Open in external browser"',
      ],
    };
  if (/WhatsApp/i.test(ua))
    return {
      key: 'whatsapp',
      label: 'WhatsApp',
      menuIcon: 'the Share icon (bottom left)',
      steps: [
        'Tap the Share icon at the bottom left',
        'Choose "Open in Safari"',
      ],
    };
  if (/musical_ly|BytedanceWebview/i.test(ua))
    return {
      key: 'tiktok',
      label: 'TikTok',
      menuIcon: 'the ⋯ menu (top right)',
      steps: [
        'Tap the ⋯ icon at the top right',
        'Choose "Open in browser" / "Open in Safari"',
      ],
    };
  if (/Twitter/i.test(ua))
    return {
      key: 'twitter',
      label: 'X / Twitter',
      menuIcon: 'the Share icon (bottom right)',
      steps: [
        'Tap the Share icon at the bottom right',
        'Choose "Open in Safari"',
      ],
    };
  if (/LinkedInApp/i.test(ua))
    return {
      key: 'linkedin',
      label: 'LinkedIn',
      menuIcon: 'the ⋯ menu (top right)',
      steps: [
        'Tap the ⋯ menu at the top right',
        'Choose "Open in Safari"',
      ],
    };
  if (/Line\//i.test(ua))
    return {
      key: 'line',
      label: 'Line',
      menuIcon: 'the ⋯ menu (bottom right)',
      steps: [
        'Tap the ⋯ menu at the bottom right',
        'Choose "Open in other browser"',
      ],
    };
  if (/MicroMessenger/i.test(ua))
    return {
      key: 'wechat',
      label: 'WeChat',
      menuIcon: 'the ⋯ menu (top right)',
      steps: [
        'Tap the ⋯ menu at the top right',
        'Choose "Open in Safari"',
      ],
    };
  if (/Snapchat/i.test(ua))
    return {
      key: 'snapchat',
      label: 'Snapchat',
      menuIcon: 'the ⋯ menu',
      steps: ['Tap the ⋯ menu', 'Choose "Open in Safari"'],
    };
  if (/Telegram/i.test(ua))
    return {
      key: 'telegram',
      label: 'Telegram',
      menuIcon: 'the ⋯ menu (top right)',
      steps: [
        'Tap the ⋯ menu at the top right',
        'Choose "Open in Safari"',
      ],
    };
  if (isChromeIOS())
    return {
      key: 'chrome-ios',
      label: 'Chrome',
      menuIcon: 'the ⋯ menu',
      steps: [
        'Tap the ⋯ menu at the bottom right',
        'Choose "Open in Safari"',
      ],
    };
  if (isFirefoxIOS())
    return {
      key: 'firefox-ios',
      label: 'Firefox',
      menuIcon: 'the ☰ menu',
      steps: [
        'Tap the ☰ menu at the bottom right',
        'Choose "Open in Safari"',
      ],
    };
  if (isIOSInAppBrowser())
    return {
      key: 'other-in-app',
      label: 'this in-app browser',
      menuIcon: 'the ⋯ or Share menu',
      steps: [
        'Tap the ⋯ or Share menu',
        'Choose "Open in Safari" (or "Open in Browser")',
      ],
    };
  return {
    key: 'safari',
    label: 'Safari',
    menuIcon: 'the Share icon',
    steps: [
      'Tap the Share icon in the Safari toolbar',
      'Scroll and tap "Add to Home Screen"',
      'Tap "Add" in the top right',
    ],
  };
}

/**
 * Convert the current page URL into an iOS Safari-scheme URL. Some in-app
 * browsers (WhatsApp, Messenger, LinkedIn) honor `x-safari-https://` and
 * escape into Safari when the link is tapped.
 */
function toSafariSchemeURL(url: string): string {
  return url.startsWith('https://')
    ? url.replace(/^https:\/\//, 'x-safari-https://')
    : url.startsWith('http://')
      ? url.replace(/^http:\/\//, 'x-safari-http://')
      : url;
}

interface OpenInSafariCardProps {
  /** Where to send the user; defaults to current href. */
  targetUrl?: string;
  className?: string;
}

export default function OpenInSafariCard({ targetUrl, className }: OpenInSafariCardProps) {
  const url = targetUrl || (typeof window !== 'undefined' ? window.location.href : '');
  const browser = useMemo(detectBrowser, []);
  const safariScheme = useMemo(() => toSafariSchemeURL(url), [url]);
  const [copied, setCopied] = useState(false);
  const [shareOk, setShareOk] = useState<null | boolean>(null);

  const canWebShare = typeof navigator !== 'undefined' && typeof navigator.share === 'function';

  const copyLink = async () => {
    trackInstallEvent('copy_link_clicked', { context: 'open_in_safari', browser: browser.key });
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      trackInstallEvent('copy_link_success', { context: 'open_in_safari', browser: browser.key });
      setTimeout(() => setCopied(false), 2500);
    } catch {
      trackInstallEvent('copy_link_failed', { context: 'open_in_safari', browser: browser.key });
    }
  };

  const webShare = async () => {
    trackInstallEvent('copy_link_clicked', { context: 'open_in_safari_share', browser: browser.key });
    try {
      await navigator.share({
        title: 'Welile',
        text: 'Open this in Safari to install the Welile app',
        url,
      });
      setShareOk(true);
      trackInstallEvent('copy_link_success', { context: 'open_in_safari_share', browser: browser.key });
    } catch {
      setShareOk(false);
      trackInstallEvent('copy_link_failed', { context: 'open_in_safari_share', browser: browser.key });
    }
  };

  const onSafariSchemeClick = () => {
    trackInstallEvent('copy_link_clicked', {
      context: 'open_in_safari_scheme',
      browser: browser.key,
    });
  };

  // Already in Safari — no rescue needed.
  if (browser.key === 'safari') return null;

  return (
    <div
      className={`animate-fade-in p-4 bg-warning/10 border border-warning/30 rounded-xl space-y-4 ${className ?? ''}`}
    >
      <div className="flex items-start gap-3">
        <ExternalLink className="h-5 w-5 text-warning flex-shrink-0 mt-0.5" />
        <div className="flex-1 min-w-0">
          <p className="font-semibold text-sm text-warning-foreground">
            You're in {browser.label} — open in Safari first
          </p>
          <p className="text-xs text-muted-foreground mt-1">
            iPhone only lets you install the app from Safari. Use one of the options below.
          </p>
        </div>
      </div>

      {/* Option A — one-tap Safari scheme (works in WhatsApp/Messenger/LinkedIn) */}
      <div className="rounded-lg border bg-background/60 p-3">
        <p className="text-xs font-medium mb-2">Option 1 — one-tap link</p>
        <a
          href={safariScheme}
          onClick={onSafariSchemeClick}
          className="inline-flex items-center justify-center gap-2 w-full h-11 rounded-md bg-primary text-primary-foreground text-sm font-semibold touch-manipulation active:scale-[0.98] transition-transform"
          style={{ WebkitTapHighlightColor: 'transparent', fontSize: '16px' }}
        >
          <ExternalLink className="h-4 w-4" />
          Open in Safari
        </a>
        <p className="text-[11px] text-muted-foreground mt-2">
          If nothing happens, use option 2 or 3 below — some apps block this link.
        </p>
      </div>

      {/* Option B — web share sheet (routes to Safari on iOS 15+) */}
      {canWebShare && (
        <div className="rounded-lg border bg-background/60 p-3">
          <p className="text-xs font-medium mb-2">Option 2 — share to Safari</p>
          <Button
            variant="outline"
            size="sm"
            onClick={webShare}
            className="gap-2 h-11 w-full text-base touch-manipulation"
            style={{ WebkitTapHighlightColor: 'transparent', fontSize: '16px' }}
          >
            <Share2 className="h-4 w-4" />
            Share → then pick Safari
          </Button>
          {shareOk === false && (
            <p className="text-[11px] text-destructive mt-2">
              Share was cancelled. Use option 3 instead.
            </p>
          )}
        </div>
      )}

      {/* Option C — manual copy + explicit step-by-step for the detected app */}
      <div className="rounded-lg border bg-background/60 p-3">
        <p className="text-xs font-medium mb-2">
          Option {canWebShare ? '3' : '2'} — copy the link, then open Safari
        </p>
        <Button
          variant="outline"
          size="sm"
          onClick={copyLink}
          className="gap-2 h-11 w-full text-base touch-manipulation"
          style={{ WebkitTapHighlightColor: 'transparent', fontSize: '16px' }}
        >
          {copied ? <Check className="h-4 w-4 text-success" /> : <Copy className="h-4 w-4" />}
          {copied ? 'Copied — now open Safari and paste' : 'Copy link'}
        </Button>

        <div className="mt-3">
          <p className="text-[11px] font-medium text-muted-foreground uppercase tracking-wide">
            In {browser.label}
          </p>
          <ol className="mt-1.5 space-y-1.5 text-sm">
            {browser.steps.map((step, i) => (
              <li key={i} className="flex gap-2">
                <span className="flex-shrink-0 w-5 h-5 rounded-full bg-primary/15 text-primary text-[11px] font-semibold inline-flex items-center justify-center">
                  {i + 1}
                </span>
                <span>{step}</span>
              </li>
            ))}
          </ol>
        </div>

        <p className="text-[11px] text-muted-foreground mt-3 break-all bg-muted/50 rounded px-2 py-1 border">
          {url}
        </p>
      </div>
    </div>
  );
}