import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { CheckCircle2, XCircle, AlertTriangle, Copy, RefreshCw, ArrowLeft, Info } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { toast } from 'sonner';
import {
  isChromeIOS,
  isFirefoxIOS,
  isIOSInAppBrowser,
} from '@/hooks/useIOSCompatibility';
import { detectStandalone } from '@/lib/pwaStandalone';
import { globalDeferredPrompt } from '@/hooks/usePWAInstall';
import { trackInstallEvent } from '@/lib/installTracking';

type Status = 'ok' | 'warn' | 'fail' | 'info';

interface Check {
  id: string;
  label: string;
  status: Status;
  detail: string;
  fix?: string;
}

function detectIOSInAppApp(): string | null {
  const ua = navigator.userAgent || '';
  if (/FBAN|FBAV/i.test(ua)) return 'Facebook';
  if (/Instagram/i.test(ua)) return 'Instagram';
  if (/WhatsApp/i.test(ua)) return 'WhatsApp';
  if (/Line\//i.test(ua)) return 'Line';
  if (/MicroMessenger/i.test(ua)) return 'WeChat';
  if (/Twitter/i.test(ua)) return 'X / Twitter';
  if (/LinkedInApp/i.test(ua)) return 'LinkedIn';
  if (/musical_ly|BytedanceWebview/i.test(ua)) return 'TikTok';
  if (/Snapchat/i.test(ua)) return 'Snapchat';
  if (/Telegram/i.test(ua)) return 'Telegram';
  return null;
}

function iosVersion(): number | null {
  const m = navigator.userAgent.match(/OS (\d+)_/);
  return m ? parseInt(m[1], 10) : null;
}

function displayMode(): string {
  if (typeof window.matchMedia !== 'function') return 'unknown';
  for (const q of ['standalone', 'fullscreen', 'minimal-ui', 'window-controls-overlay', 'browser']) {
    try {
      if (window.matchMedia(`(display-mode: ${q})`).matches) return q;
    } catch {
      /* noop */
    }
  }
  return 'browser';
}

function StatusIcon({ status }: { status: Status }) {
  if (status === 'ok') return <CheckCircle2 className="h-5 w-5 text-success" />;
  if (status === 'fail') return <XCircle className="h-5 w-5 text-destructive" />;
  if (status === 'warn') return <AlertTriangle className="h-5 w-5 text-warning" />;
  return <Info className="h-5 w-5 text-muted-foreground" />;
}

export default function InstallDiagnostics() {
  const [checks, setChecks] = useState<Check[]>([]);
  const [manifestOk, setManifestOk] = useState<boolean | null>(null);
  const [swRegs, setSwRegs] = useState<string[] | null>(null);
  const [refreshTick, setRefreshTick] = useState(0);

  useEffect(() => {
    let cancelled = false;

    trackInstallEvent('diagnostics_opened');

    async function run() {
      const ua = navigator.userAgent || '';
      const isIOS = /iPad|iPhone|iPod/.test(ua) && !(window as unknown as { MSStream?: unknown }).MSStream;
      const iosVer = iosVersion();
      const inAppName = detectIOSInAppApp();
      const inApp = isIOSInAppBrowser();
      const chromeIOS = isChromeIOS();
      const firefoxIOS = isFirefoxIOS();
      const standalone = detectStandalone();
      const mode = displayMode();
      const isSecure = window.isSecureContext;
      const hasPrompt = !!globalDeferredPrompt;
      const hasSW = 'serviceWorker' in navigator;

      // Manifest fetch check
      let manifestReachable = false;
      try {
        const res = await fetch('/manifest.webmanifest', { cache: 'no-store' });
        manifestReachable = res.ok;
      } catch {
        manifestReachable = false;
      }
      if (cancelled) return;
      setManifestOk(manifestReachable);

      // Service worker registrations
      let regs: string[] = [];
      if (hasSW) {
        try {
          const list = await navigator.serviceWorker.getRegistrations();
          regs = list.map((r) => r.active?.scriptURL || r.installing?.scriptURL || r.waiting?.scriptURL || '(unknown)');
        } catch {
          regs = [];
        }
      }
      if (cancelled) return;
      setSwRegs(regs);

      const results: Check[] = [];

      // Platform
      results.push({
        id: 'platform',
        label: 'Device platform',
        status: isIOS ? 'ok' : 'info',
        detail: isIOS
          ? `iPhone / iPad detected${iosVer ? ` (iOS ${iosVer})` : ''}`
          : 'This diagnostics page is optimized for iPhone. You appear to be on a different device.',
        fix: !isIOS ? 'Open this URL on the iPhone that cannot install the app.' : undefined,
      });

      // Secure context
      results.push({
        id: 'secure',
        label: 'Secure (HTTPS) context',
        status: isSecure ? 'ok' : 'fail',
        detail: isSecure ? 'Page is served over HTTPS.' : 'Page is not in a secure context.',
        fix: isSecure ? undefined : 'Open the site via https://welileapp.com — installation requires HTTPS.',
      });

      // Standalone / already installed
      results.push({
        id: 'standalone',
        label: 'Already installed?',
        status: standalone ? 'ok' : 'info',
        detail: standalone
          ? `Yes — currently running installed (display-mode: ${mode}).`
          : `No — running in a normal browser tab (display-mode: ${mode}).`,
        fix: standalone ? 'You already have the app installed. Launch it from your home screen.' : undefined,
      });

      if (isIOS) {
        // In-app browser — the #1 iPhone install blocker
        results.push({
          id: 'in-app',
          label: 'Browser environment',
          status: inApp ? 'fail' : chromeIOS || firefoxIOS ? 'fail' : 'ok',
          detail: inApp
            ? `Running inside the ${inAppName ?? 'another app\'s'} in-app browser.`
            : chromeIOS
              ? 'Running in Chrome on iOS.'
              : firefoxIOS
                ? 'Running in Firefox on iOS.'
                : 'Running in Safari — required for install.',
          fix:
            inApp || chromeIOS || firefoxIOS
              ? 'iPhone only allows installing from Safari. Tap the ⋯ or Share menu and choose "Open in Safari", then reopen this page.'
              : undefined,
        });

        // iOS version
        results.push({
          id: 'ios-version',
          label: 'iOS version supports install',
          status: iosVer === null ? 'info' : iosVer >= 11 ? 'ok' : 'fail',
          detail:
            iosVer === null
              ? 'Could not detect iOS version from browser.'
              : `iOS ${iosVer} detected.`,
          fix:
            iosVer !== null && iosVer < 11
              ? 'Update your iPhone to iOS 11.3 or later — earlier versions cannot install PWAs.'
              : undefined,
        });

        // Private browsing (heuristic)
        let privateBrowsing = false;
        try {
          localStorage.setItem('__welile_pbcheck', '1');
          localStorage.removeItem('__welile_pbcheck');
        } catch {
          privateBrowsing = true;
        }
        results.push({
          id: 'private',
          label: 'Private browsing',
          status: privateBrowsing ? 'fail' : 'ok',
          detail: privateBrowsing
            ? 'Storage is blocked — you appear to be in Private Browsing.'
            : 'Not in private browsing.',
          fix: privateBrowsing
            ? 'Turn off Private Browsing in Safari (tap the tabs icon → Private → switch to a normal tab).'
            : undefined,
        });
      } else {
        // Non-iOS: report Chromium prompt availability
        results.push({
          id: 'beforeinstallprompt',
          label: 'Native install prompt captured',
          status: hasPrompt ? 'ok' : 'warn',
          detail: hasPrompt
            ? 'beforeinstallprompt was fired and captured — you can install directly.'
            : 'No beforeinstallprompt yet. This is normal on iOS. On Android/desktop Chrome it can take a few seconds or a page reload.',
        });
      }

      // Manifest
      results.push({
        id: 'manifest',
        label: 'Web app manifest',
        status: manifestReachable ? 'ok' : 'fail',
        detail: manifestReachable
          ? '/manifest.webmanifest is reachable.'
          : 'Could not fetch /manifest.webmanifest.',
        fix: manifestReachable ? undefined : 'Reload the page. If this persists, the app hosting is down.',
      });

      // Apple touch icon
      results.push({
        id: 'apple-icon',
        label: 'Home screen icon',
        status: 'ok',
        detail: '/apple-touch-icon.png is configured at 180×180 (required by iOS).',
      });

      // Service workers (informational — offline)
      results.push({
        id: 'sw',
        label: 'Service worker (offline support)',
        status: hasSW ? (regs.length ? 'ok' : 'info') : 'warn',
        detail: !hasSW
          ? 'This browser does not support service workers.'
          : regs.length
            ? `${regs.length} registration(s) active.`
            : 'No service worker registered on this device yet — the app still installs without one.',
      });

      if (!cancelled) setChecks(results);
    }

    run();
    return () => {
      cancelled = true;
    };
  }, [refreshTick]);

  const failing = checks.filter((c) => c.status === 'fail');
  const warnings = checks.filter((c) => c.status === 'warn');

  const copyLink = async () => {
    trackInstallEvent('copy_link_clicked', { context: 'diagnostics' });
    try {
      await navigator.clipboard.writeText(window.location.origin);
      trackInstallEvent('copy_link_success', { context: 'diagnostics' });
      toast.success('Link copied — open Safari and paste it in the address bar.');
    } catch {
      trackInstallEvent('copy_link_failed', { context: 'diagnostics' });
      toast.error('Could not copy — long-press the URL bar to copy manually.');
    }
  };

  const copyReport = async () => {
    const lines = [
      `Welile install diagnostics — ${new Date().toISOString()}`,
      `URL: ${window.location.href}`,
      `UA: ${navigator.userAgent}`,
      `display-mode: ${displayMode()}`,
      `standalone: ${detectStandalone()}`,
      `manifest reachable: ${manifestOk}`,
      `service workers: ${swRegs?.length ?? 0}`,
      '',
      ...checks.map((c) => `[${c.status.toUpperCase()}] ${c.label}: ${c.detail}${c.fix ? ` → ${c.fix}` : ''}`),
    ].join('\n');
    try {
      await navigator.clipboard.writeText(lines);
      trackInstallEvent('diagnostics_report_copied', {
        failing: checks.filter((c) => c.status === 'fail').map((c) => c.id),
      });
      toast.success('Diagnostics report copied to clipboard.');
    } catch {
      toast.error('Could not copy report.');
    }
  };

  return (
    <div className="min-h-screen bg-background">
      <div className="max-w-2xl mx-auto p-4 sm:p-6 space-y-6">
        <div className="flex items-center justify-between gap-2">
          <Link
            to="/install"
            className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
          >
            <ArrowLeft className="h-4 w-4" /> Back to install
          </Link>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setRefreshTick((n) => n + 1)}
            className="gap-1"
          >
            <RefreshCw className="h-4 w-4" /> Re-run
          </Button>
        </div>

        <div>
          <h1 className="text-2xl font-bold">iPhone install diagnostics</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Automated checks explaining exactly why the app can or cannot be installed on this device right
            now.
          </p>
        </div>

        {/* Summary */}
        <Card className="p-4">
          {failing.length === 0 && warnings.length === 0 ? (
            <div className="flex items-start gap-3">
              <CheckCircle2 className="h-5 w-5 text-success mt-0.5" />
              <div>
                <p className="font-semibold">All checks passed</p>
                <p className="text-sm text-muted-foreground">
                  Open the Share menu in Safari and tap “Add to Home Screen”.
                </p>
              </div>
            </div>
          ) : (
            <div className="flex items-start gap-3">
              <AlertTriangle className="h-5 w-5 text-warning mt-0.5" />
              <div className="flex-1">
                <p className="font-semibold">
                  {failing.length} blocker{failing.length === 1 ? '' : 's'}
                  {warnings.length ? `, ${warnings.length} warning${warnings.length === 1 ? '' : 's'}` : ''}
                </p>
                <p className="text-sm text-muted-foreground">
                  Follow the next steps below in order — each one unblocks the next check.
                </p>
                {failing.some((f) => f.id === 'in-app') && (
                  <Button size="sm" className="mt-3 gap-2" onClick={copyLink}>
                    <Copy className="h-4 w-4" /> Copy link for Safari
                  </Button>
                )}
              </div>
            </div>
          )}
        </Card>

        {/* Check list */}
        <div className="space-y-2">
          {checks.map((c) => (
            <Card key={c.id} className="p-4">
              <div className="flex items-start gap-3">
                <StatusIcon status={c.status} />
                <div className="flex-1 min-w-0">
                  <p className="font-medium">{c.label}</p>
                  <p className="text-sm text-muted-foreground mt-0.5 break-words">{c.detail}</p>
                  {c.fix && (
                    <p className="text-sm mt-2 p-2 rounded bg-primary/5 border border-primary/20">
                      <span className="font-medium">Next step: </span>
                      {c.fix}
                    </p>
                  )}
                </div>
              </div>
            </Card>
          ))}
        </div>

        {/* Env dump */}
        <Card className="p-4 space-y-2">
          <p className="font-medium text-sm">Environment</p>
          <div className="text-xs text-muted-foreground space-y-1 font-mono break-all">
            <div>URL: {window.location.href}</div>
            <div>UA: {navigator.userAgent}</div>
            <div>display-mode: {displayMode()}</div>
            <div>service workers: {swRegs?.length ?? 0}</div>
          </div>
          <Button variant="outline" size="sm" onClick={copyReport} className="gap-2 mt-2">
            <Copy className="h-4 w-4" /> Copy full report
          </Button>
        </Card>
      </div>
    </div>
  );
}