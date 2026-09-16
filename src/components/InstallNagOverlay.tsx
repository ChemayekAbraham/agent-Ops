import { useEffect, useState, lazy, Suspense, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Download, Share, HelpCircle, X, Zap, Wifi, Bell } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  usePWAInstall,
  getInstallPlatformPreference,
  setInstallPlatformPreference,
  clearInstallPlatformPreference,
} from '@/hooks/usePWAInstall';
import { trackInstallEvent } from '@/lib/installTracking';
import { toast } from 'sonner';

const IOSInstallGuide = lazy(() => import('@/components/IOSInstallGuide'));
const GenericInstallGuide = lazy(() => import('@/components/GenericInstallGuide'));

/**
 * Aggressive, smartphone-only install nag.
 *
 * Behaviour:
 *  - Shows a full-screen sheet a few seconds after landing on any page.
 *  - Re-appears every REPEAT_MS while the visit continues if still not installed.
 *  - "Not now" only quietens it for SNOOZE_HOURS, then it returns.
 *  - Never shows when already installed / running standalone, and never on
 *    desktop (an install there is not a phone app).
 */
const SNOOZE_KEY = 'welile_install_nag_snoozed_until';
const SNOOZE_HOURS = 6;
const FIRST_DELAY_MS = 5_000;
const REPEAT_MS = 3 * 60 * 1000;

function isSmartphone(): boolean {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent || '';
  const phone = /Android|iPhone|iPod|Windows Phone|webOS|BlackBerry|Opera Mini|IEMobile/i.test(ua);
  const iPad = /iPad/.test(ua) || (/Macintosh/.test(ua) && (navigator as any).maxTouchPoints > 1);
  const narrow = typeof window !== 'undefined' && window.innerWidth <= 900;
  return phone || iPad || (narrow && 'ontouchstart' in window);
}

function snoozedUntil(): number {
  try {
    const raw = localStorage.getItem(SNOOZE_KEY);
    const until = raw ? Number(raw) : 0;
    return Number.isFinite(until) ? until : 0;
  } catch {
    return 0;
  }
}

export default function InstallNagOverlay() {
  const { isInstalled, isIOS, isAndroid, hasPrompt, promptInstall, canShow } = usePWAInstall();
  // Manual override when the OS can't be detected (unusual WebViews, etc.).
  // A saved preference lets the prompt skip the picker on future visits.
  const osDetected = isIOS || isAndroid;
  const [manualPlatform, setManualPlatform] = useState<'ios' | 'android' | null>(() =>
    osDetected ? null : getInstallPlatformPreference(),
  );
  const effectiveIsIOS = manualPlatform ? manualPlatform === 'ios' : isIOS;
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [showIOSGuide, setShowIOSGuide] = useState(false);
  const [showGenericGuide, setShowGenericGuide] = useState(false);
  const [phone] = useState(() => isSmartphone());

  const eligible = phone && !isInstalled && canShow;

  useEffect(() => {
    if (!eligible) return;
    let timer: number | undefined;
    let interval: number | undefined;

    const tryOpen = () => {
      if (Date.now() < snoozedUntil()) return;
      if (document.hidden) return;
      setOpen(true);
    };

    timer = window.setTimeout(tryOpen, FIRST_DELAY_MS);
    interval = window.setInterval(tryOpen, REPEAT_MS);

    return () => {
      if (timer) window.clearTimeout(timer);
      if (interval) window.clearInterval(interval);
    };
  }, [eligible]);

  useEffect(() => {
    if (!open) return;
    trackInstallEvent('install_card_shown', { isIOS, hasPrompt, surface: 'nag_overlay' });
    trackInstallEvent('platform_steps_shown', {
      surface: 'nag_overlay',
      platform: isIOS ? 'ios' : 'android',
    });
  }, [open, isIOS, hasPrompt]);

  const snooze = useCallback(() => {
    try {
      localStorage.setItem(SNOOZE_KEY, String(Date.now() + SNOOZE_HOURS * 60 * 60 * 1000));
    } catch {
      /* storage unavailable — sheet simply returns next load */
    }
    setOpen(false);
    trackInstallEvent('install_card_dismissed', { isIOS, surface: 'nag_overlay' });
  }, [isIOS]);

  const handleInstall = async () => {
    trackInstallEvent('install_cta_clicked', { isIOS, hasPrompt, surface: 'nag_overlay' });
    if (isIOS) {
      setShowIOSGuide(true);
      trackInstallEvent('ios_guide_opened', { source: 'nag_overlay' });
      return;
    }
    if (!hasPrompt) {
      setShowGenericGuide(true);
      trackInstallEvent('install_instructions_opened', { source: 'nag_overlay' });
      return;
    }
    if (busy) return;
    setBusy(true);
    trackInstallEvent('native_prompt_shown', { surface: 'nag_overlay' });
    try {
      const accepted = await promptInstall();
      if (accepted) {
        trackInstallEvent('native_prompt_accepted', { surface: 'nag_overlay' });
        trackInstallEvent('app_installed', { surface: 'nag_overlay' });
        trackInstallEvent('install_attributed', {
          surface: 'nag_overlay',
          platform: isIOS ? 'ios' : 'android',
        });
        toast.success('App installed successfully!');
        setOpen(false);
      } else {
        trackInstallEvent('native_prompt_dismissed', { surface: 'nag_overlay' });
      }
    } catch {
      /* hook cleans up */
    } finally {
      setBusy(false);
    }
  };

  if (!eligible) return null;

  return (
    <>
      {showIOSGuide && (
        <Suspense fallback={null}>
          <IOSInstallGuide onClose={() => setShowIOSGuide(false)} />
        </Suspense>
      )}
      {showGenericGuide && (
        <Suspense fallback={null}>
          <GenericInstallGuide onClose={() => setShowGenericGuide(false)} />
        </Suspense>
      )}
      <AnimatePresence>
        {open && (
          <motion.div
            className="fixed inset-0 z-[70] flex items-end justify-center bg-foreground/60 backdrop-blur-sm px-3 pb-3"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            role="dialog"
            aria-modal="true"
            aria-label="Install the Welile app"
          >
            <motion.div
              className="relative w-full max-w-md overflow-hidden rounded-3xl border border-border/60 bg-card p-5 shadow-2xl"
              initial={{ y: 40, opacity: 0 }}
              animate={{ y: 0, opacity: 1 }}
              exit={{ y: 40, opacity: 0 }}
              transition={{ type: 'spring', stiffness: 260, damping: 24 }}
            >
              <div
                aria-hidden
                className="pointer-events-none absolute -right-16 -top-16 h-48 w-48 rounded-full bg-primary/15 blur-3xl"
              />
              <button
                onClick={snooze}
                aria-label="Close"
                className="absolute right-3 top-3 flex h-8 w-8 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted"
              >
                <X className="h-4 w-4" />
              </button>

              <div className="flex items-start gap-4 pr-8">
                <div className="flex h-14 w-14 flex-shrink-0 items-center justify-center rounded-2xl bg-primary/15">
                  <img
                    src="/icon-192.png"
                    alt=""
                    className="h-10 w-10 rounded-xl"
                    loading="lazy"
                  />
                </div>
                <div className="min-w-0 flex-1">
                  <h2 className="text-lg font-bold leading-tight text-foreground">
                    Get the Welile app on your phone
                  </h2>
                  <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
                    {isIOS
                      ? 'Add Welile to your home screen — it opens instantly, like a normal app.'
                      : 'Install it in seconds. It opens instantly from your home screen, uses less data and works on weak network.'}
                  </p>
                </div>
              </div>

              {/* Manual platform picker when the OS can't be detected. */}
              {!osDetected && !manualPlatform && (
                <div className="mt-4 rounded-2xl bg-muted/50 p-3">
                  <p className="text-sm font-medium text-foreground">Choose your phone:</p>
                  <div className="mt-2 flex gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      className="flex-1"
                      onClick={() => {
                      setManualPlatform('ios');
                        trackInstallEvent('manual_platform_selected', {
                          source: 'nag_overlay',
                          selected_platform: 'ios',
                        });
                        trackInstallEvent('platform_steps_shown', {
                          source: 'nag_overlay',
                          platform: 'ios',
                          manual: true,
                        });
                      }}
                    >
                      iPhone
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      className="flex-1"
                      onClick={() => {
                      setManualPlatform('android');
                        trackInstallEvent('manual_platform_selected', {
                          source: 'nag_overlay',
                          selected_platform: 'android',
                        });
                        trackInstallEvent('platform_steps_shown', {
                          source: 'nag_overlay',
                          platform: 'android',
                          manual: true,
                        });
                      }}
                    >
                      Android
                    </Button>
                  </div>
                </div>
              )}

              {/* Platform-specific install steps, shown inline so the user
                  never has to open a guide to know what to tap. */}
              {(osDetected || manualPlatform) && (effectiveIsIOS ? (
                <ol className="mt-4 space-y-2 rounded-2xl bg-muted/50 p-3 text-sm text-foreground">
                  <li className="flex gap-2.5">
                    <span className="flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full bg-primary/15 text-xs font-semibold text-primary">1</span>
                    <span>Tap the <strong>Share</strong> button <Share className="inline h-3.5 w-3.5 -mt-0.5" /> at the bottom of Safari.</span>
                  </li>
                  <li className="flex gap-2.5">
                    <span className="flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full bg-primary/15 text-xs font-semibold text-primary">2</span>
                    <span>Scroll down and tap <strong>"Add to Home Screen"</strong>.</span>
                  </li>
                  <li className="flex gap-2.5">
                    <span className="flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full bg-primary/15 text-xs font-semibold text-primary">3</span>
                    <span>Tap <strong>"Add"</strong> — Welile appears with your other apps.</span>
                  </li>
                </ol>
              ) : (
                <ol className="mt-4 space-y-2 rounded-2xl bg-muted/50 p-3 text-sm text-foreground">
                  <li className="flex gap-2.5">
                    <span className="flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full bg-primary/15 text-xs font-semibold text-primary">1</span>
                    <span>Tap <strong>"Install now"</strong> below — or open the browser menu <strong>(⋮)</strong>.</span>
                  </li>
                  <li className="flex gap-2.5">
                    <span className="flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full bg-primary/15 text-xs font-semibold text-primary">2</span>
                    <span>Choose <strong>"Install app"</strong> or <strong>"Add to Home screen"</strong>.</span>
                  </li>
                  <li className="flex gap-2.5">
                    <span className="flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full bg-primary/15 text-xs font-semibold text-primary">3</span>
                    <span>Confirm — Welile appears with your other apps.</span>
                  </li>
                </ol>
              ))}

              <ul className="mt-4 grid gap-2 text-sm text-foreground/90">
                <li className="flex items-center gap-2">
                  <Zap className="h-4 w-4 text-primary" /> Opens instantly from your home screen
                </li>
                <li className="flex items-center gap-2">
                  <Wifi className="h-4 w-4 text-primary" /> Uses less data on weak network
                </li>
                <li className="flex items-center gap-2">
                  <Bell className="h-4 w-4 text-primary" /> Never miss a payment reminder
                </li>
              </ul>

              <div className="mt-5 flex flex-col gap-2">
                <Button
                  onClick={handleInstall}
                  disabled={busy}
                  size="lg"
                  className="w-full gap-2 font-semibold"
                >
                  {isIOS ? (
                    <Share className="h-4 w-4" />
                  ) : hasPrompt ? (
                    <Download className="h-4 w-4" />
                  ) : (
                    <HelpCircle className="h-4 w-4" />
                  )}
                  {busy ? 'Installing…' : isIOS ? 'Show me how' : hasPrompt ? 'Install now' : 'Show me how'}
                </Button>
                <Button onClick={snooze} variant="ghost" size="sm" className="text-muted-foreground">
                  Maybe later
                </Button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}
