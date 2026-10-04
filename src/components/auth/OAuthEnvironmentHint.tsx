import { useEffect, useState } from 'react';
import { AlertTriangle, Info, Copy, Check, ExternalLink } from 'lucide-react';

/**
 * Detects browser environments where Google OAuth popups commonly fail and
 * shows targeted guidance so the user can switch to a supported browser
 * before tapping "Continue with Google".
 *
 * Cases handled:
 *  - In-app browsers (WhatsApp, Facebook, Instagram, TikTok, Snapchat,
 *    LinkedIn, Line, Messenger, Twitter, WeChat) — Google blocks OAuth in
 *    these WebViews entirely.
 *  - iOS Safari — cross-site tracking prevention can silently drop the
 *    OAuth popup, so we surface a soft nudge to try again / disable it.
 */
type Env = 'in_app' | 'ios_safari' | null;

function detectEnv(): { env: Env; appName?: string } {
  if (typeof navigator === 'undefined') return { env: null };
  const ua = navigator.userAgent || '';

  const inApp: Array<[RegExp, string]> = [
    [/FBAN|FBAV|FB_IAB|FB4A/i, 'Facebook'],
    [/Instagram/i, 'Instagram'],
    [/WhatsApp/i, 'WhatsApp'],
    [/Messenger|MessengerLite/i, 'Messenger'],
    [/TikTok|Musical_ly|BytedanceWebview/i, 'TikTok'],
    [/Snapchat/i, 'Snapchat'],
    [/LinkedInApp/i, 'LinkedIn'],
    [/Line\//i, 'Line'],
    [/Twitter/i, 'Twitter/X'],
    [/MicroMessenger/i, 'WeChat'],
  ];
  for (const [re, name] of inApp) {
    if (re.test(ua)) return { env: 'in_app', appName: name };
  }

  // iOS Safari (not Chrome/Firefox/Edge/Opera on iOS, which use different UA tokens).
  const isIOS = /iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && (navigator as unknown as { maxTouchPoints?: number }).maxTouchPoints! > 1);
  const isSafari = /Safari/.test(ua) && !/CriOS|FxiOS|EdgiOS|OPiOS/.test(ua);
  if (isIOS && isSafari) return { env: 'ios_safari' };

  return { env: null };
}

function isIOSUA(ua: string) {
  return /iPad|iPhone|iPod/.test(ua);
}
function isAndroidUA(ua: string) {
  return /Android/i.test(ua);
}

/**
 * Build a one-tap link that jumps out of an in-app browser into the system
 * Chrome / Safari. Returns null when we don't have a reliable scheme for the
 * current OS (in which case we fall back to the "copy link" button).
 */
function buildOpenInBrowserHref(): { href: string; label: string } | null {
  if (typeof window === 'undefined') return null;
  const ua = navigator.userAgent || '';
  const current = window.location.href;
  const url = new URL(current);

  if (isAndroidUA(ua)) {
    // Android intent URL — opens Chrome directly, falls back to Play Store.
    const host = url.host;
    const pathAndQuery = url.pathname + url.search + url.hash;
    const intent =
      `intent://${host}${pathAndQuery}` +
      `#Intent;scheme=${url.protocol.replace(':', '')};` +
      `package=com.android.chrome;` +
      `S.browser_fallback_url=${encodeURIComponent(current)};end`;
    return { href: intent, label: 'Open in Chrome' };
  }

  if (isIOSUA(ua)) {
    // iOS: `googlechrome://` opens Chrome if installed. If not, the tap does
    // nothing — so we surface Safari as the label since it's the OS default
    // and users can also long-press → Open in Safari.
    const chromeScheme =
      (url.protocol === 'https:' ? 'googlechromes://' : 'googlechrome://') +
      url.host +
      url.pathname +
      url.search +
      url.hash;
    return { href: chromeScheme, label: 'Open in Chrome' };
  }

  return null;
}

export function OAuthEnvironmentHint() {
  const [state, setState] = useState<{ env: Env; appName?: string }>({ env: null });
  const [copied, setCopied] = useState(false);
  const [openInBrowser, setOpenInBrowser] = useState<{ href: string; label: string } | null>(null);

  useEffect(() => {
    setState(detectEnv());
    setOpenInBrowser(buildOpenInBrowserHref());
  }, []);

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(window.location.href);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // ignore
    }
  };

  if (!state.env) return null;

  if (state.env === 'in_app') {
    return (
      <div
        role="alert"
        className="rounded-lg border border-amber-300/60 bg-amber-50 dark:bg-amber-950/30 dark:border-amber-800/50 p-3 text-xs text-amber-900 dark:text-amber-100 space-y-2"
      >
        <div className="flex items-start gap-2">
          <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
          <div className="space-y-1">
            <p className="font-semibold">
              Google sign-in doesn't work inside {state.appName ?? 'this app'}.
            </p>
            <p className="leading-relaxed">
              Google blocks logins from in-app browsers. Tap
              <span className="font-semibold"> "Open in Chrome / Safari"</span> below to
              continue in your system browser. If it doesn't jump, use the
              <span className="font-semibold"> ⋯ menu</span> and copy the link.
            </p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {openInBrowser && (
            <a
              href={openInBrowser.href}
              rel="external noreferrer"
              className="inline-flex items-center gap-1.5 rounded-md bg-amber-600 text-white px-2.5 py-1 font-semibold hover:bg-amber-700 transition-colors"
            >
              <ExternalLink className="h-3 w-3" />
              {openInBrowser.label}
            </a>
          )}
          <button
            type="button"
            onClick={copyLink}
            className="inline-flex items-center gap-1.5 rounded-md bg-amber-100 dark:bg-amber-900/40 px-2.5 py-1 font-medium hover:bg-amber-200/70 dark:hover:bg-amber-900/60 transition-colors"
          >
            {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
            {copied ? 'Link copied' : 'Copy page link'}
          </button>
        </div>
      </div>
    );
  }

  // iOS Safari — softer nudge
  return (
    <div
      role="note"
      className="rounded-lg border border-border/60 bg-muted/40 p-3 text-xs text-muted-foreground flex items-start gap-2"
    >
      <Info className="h-4 w-4 shrink-0 mt-0.5" />
      <p className="leading-relaxed">
        On iPhone Safari, if the Google popup doesn't open, tap
        <span className="font-semibold"> AA → Website Settings</span> and disable
        <span className="font-semibold"> "Block Pop-ups"</span>, or turn off
        <span className="font-semibold"> "Prevent Cross-Site Tracking"</span> in Settings → Safari, then try again.
      </p>
    </div>
  );
}