import { useEffect, useState, lazy, Suspense } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Download, X, Share, Zap, RefreshCw, HelpCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { usePWAInstall } from '@/hooks/usePWAInstall';
import { useInstallPreflight } from '@/hooks/useInstallPreflight';
import { toast } from 'sonner';
import { trackInstallEvent } from '@/lib/installTracking';
import WhatsAppInstallBanner from '@/components/WhatsAppInstallBanner';
import { registerInstallCard } from '@/lib/installCardRegistry';

const IOSInstallGuide = lazy(() => import('@/components/IOSInstallGuide'));
const GenericInstallGuide = lazy(() => import('@/components/GenericInstallGuide'));

/**
 * Dismissal is persistent, not per-session: "Not now" snoozes the card for
 * SNOOZE_DAYS across tabs and app relaunches. Installing does NOT write a
 * permanent lock — installed state is detected live on each load, so a user who
 * later removes the app is offered it again.
 */
const SNOOZE_KEY = 'welile_install_card_snoozed_until';
// Deliberately short: the offer must come back the same day, not next week.
const SNOOZE_HOURS = 6;

function readSnoozed(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    const raw = localStorage.getItem(SNOOZE_KEY);
    if (!raw) return false;
    // Legacy permanent 'installed' sentinel — treat as no longer binding so
    // users who uninstalled are offered the app again.
    if (raw === 'installed') {
      localStorage.removeItem(SNOOZE_KEY);
      return false;
    }
    const until = Number(raw);
    if (!Number.isFinite(until)) return false;
    return Date.now() < until;
  } catch {
    return false;
  }
}

function writeSnooze(value: 'installed' | 'snoozed') {
  try {
    localStorage.setItem(
      SNOOZE_KEY,
      String(Date.now() + SNOOZE_HOURS * 60 * 60 * 1000),
    );
  } catch {
    /* storage unavailable — card simply reappears next load */
  }
}

interface InstallAppCardProps {
  className?: string;
  /**
   * Set on the globally-mounted instance (public shell). The header instance
   * takes priority so the card is never rendered twice.
   */
  global?: boolean;
}

export default function InstallAppCard({ className, global = false }: InstallAppCardProps) {
  const { canShow, isInstalled, isIOS, hasPrompt, canInstructInstead, promptInstall } = usePWAInstall();
  // Preflight is ADVISORY, never a gate: a failed check degrades the copy but
  // the card still renders, because slow mobile networks fail these routinely.
  const preflight = useInstallPreflight(!isInstalled);
  const [dismissed, setDismissed] = useState<boolean>(() => readSnoozed());
  const [isInstalling, setIsInstalling] = useState(false);
  const [showIOSGuide, setShowIOSGuide] = useState(false);
  const [showGenericGuide, setShowGenericGuide] = useState(false);

  // Header instance claims the slot; the global instance stands down while it is
  // mounted so users never see two install cards.
  useEffect(() => {
    if (global) return;
    return registerInstallCard();
  }, [global]);

  // Auto-hide after install
  useEffect(() => {
    if (!isInstalled) return;
    setDismissed(true);
  }, [isInstalled]);

  // Log card impression once per mount when visible.
  useEffect(() => {
    if (isInstalled || dismissed || !canShow) return;
    if (preflight.loading) return;
    trackInstallEvent('install_card_shown', {
      isIOS,
      hasPrompt,
      degraded: preflight.degraded,
      surface: global ? 'global_card' : 'header_card',
    });
    trackInstallEvent('platform_steps_shown', {
      surface: global ? 'global_card' : 'header_card',
      platform: isIOS ? 'ios' : 'android',
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [preflight.loading, preflight.degraded]);

  // Preflight failures are still logged, but they no longer hide the card.
  useEffect(() => {
    if (preflight.loading || preflight.ready || preflight.checks.length === 0) return;
    const failed = preflight.checks.filter((c) => !c.ok).map((c) => c.key);
    trackInstallEvent('install_card_degraded', { failed, isIOS });
  }, [preflight.loading, preflight.ready, preflight.checks, isIOS]);

  // Whenever the card decides NOT to render, say why — so suppression is
  // measurable instead of guesswork.
  const suppressionReason = isInstalled
    ? 'already_installed'
    : dismissed
      ? 'snoozed'
      : !canShow
        ? 'not_installable'
        : null;

  useEffect(() => {
    if (!suppressionReason) return;
    if (suppressionReason === 'already_installed') return; // expected, not a problem
    trackInstallEvent('install_card_suppressed', { reason: suppressionReason, isIOS, hasPrompt });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [suppressionReason]);

  const handleDismiss = () => {
    writeSnooze('snoozed');
    setDismissed(true);
    trackInstallEvent('install_card_dismissed', { isIOS });
  };

  const handleInstall = async () => {
    trackInstallEvent('install_cta_clicked', { isIOS, hasPrompt });
    if (isIOS) {
      // Open the full guide (with in-app-browser detection + copy link).
      // A toast alone is not enough — most iPhone install failures are users
      // opening the link from WhatsApp/Facebook/Instagram in-app browsers.
      setShowIOSGuide(true);
      trackInstallEvent('ios_guide_opened', { source: 'install_card' });
      return;
    }
    if (isInstalling) return;

    // No native prompt available (Firefox, in-app browser, some WebViews):
    // show written steps rather than doing nothing.
    if (!hasPrompt) {
      setShowGenericGuide(true);
      trackInstallEvent('install_instructions_opened', { source: 'install_card' });
      return;
    }

    setIsInstalling(true);
    trackInstallEvent('native_prompt_shown');
    try {
      const accepted = await promptInstall();
      if (accepted) {
        trackInstallEvent('native_prompt_accepted');
        trackInstallEvent('app_installed');
        trackInstallEvent('install_attributed', {
          surface: global ? 'global_card' : 'header_card',
          platform: isIOS ? 'ios' : 'android',
        });
        toast.success('App installed successfully!');
        handleDismiss();
      } else {
        trackInstallEvent('native_prompt_dismissed');
      }
      // If dismissed in native prompt, leave the card so user can retry
    } catch {
      // Silent fail — hook already cleans up
    } finally {
      setIsInstalling(false);
    }
  };

  // Hide conditions
  if (isInstalled) return null;
  if (dismissed) return null;
  if (!canShow) return null;
  // Only the first paint waits for the checks — a failure never hides the card.
  if (preflight.loading) return null;

  const ctaLabel = isInstalling
    ? 'Installing…'
    : isIOS
      ? 'How to install'
      : hasPrompt
        ? 'Install App'
        : 'How to install';

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
      <motion.div
        initial={{ opacity: 0, y: -8 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: -8 }}
        transition={{ duration: 0.25, ease: 'easeOut' }}
        className={className}
      >
        {/* WhatsApp-in-app users on iPhone: surface the ⋯ → Open in Safari
            instruction inline, above the install card, so they see it without
            having to open the full guide first. Renders nothing otherwise. */}
        <WhatsAppInstallBanner className="mb-3" />
        <div className="relative overflow-hidden rounded-2xl border border-border/60 bg-card shadow-sm p-4 sm:p-5">
          {/* Decorative accent */}
          <div
            aria-hidden
            className="absolute -top-12 -right-12 w-40 h-40 rounded-full bg-primary/10 blur-2xl pointer-events-none"
          />

          <button
            onClick={handleDismiss}
            aria-label="Dismiss install prompt"
            className="absolute top-2.5 right-2.5 w-8 h-8 rounded-full hover:bg-muted flex items-center justify-center transition-colors"
          >
            <X className="h-4 w-4 text-muted-foreground" />
          </button>

          <div className="flex items-start gap-4 pr-8">
            <div className="flex-shrink-0 w-12 h-12 rounded-xl bg-primary/15 flex items-center justify-center">
              <Zap className="h-6 w-6 text-primary" />
            </div>

            <div className="flex-1 min-w-0">
              <h3 className="text-base font-semibold text-foreground leading-tight">
                Install App
              </h3>
              <p className="text-sm text-muted-foreground mt-1 leading-relaxed">
                {isIOS
                  ? 'Add Welile to your home screen for faster access and a native app feel.'
                  : 'Faster access, offline-ready, and a native app feel right from your home screen.'}
              </p>
              {preflight.degraded && (
                <p className="text-xs text-muted-foreground mt-2 leading-relaxed">
                  Install may be slow on this connection.
                </p>
              )}

              {/* Platform-specific quick steps, visible without opening a guide. */}
              <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
                {isIOS ? (
                  <>
                    On iPhone: tap <strong>Share</strong> <Share className="inline h-3 w-3 -mt-0.5" /> in Safari, then <strong>"Add to Home Screen"</strong>, then <strong>"Add"</strong>.
                  </>
                ) : (
                  <>
                    On Android: tap <strong>Install App</strong> below — or open the browser menu <strong>(⋮)</strong> and choose <strong>"Install app"</strong> / <strong>"Add to Home screen"</strong>.
                  </>
                )}
              </p>

              <div className="mt-3 flex items-center gap-2 flex-wrap">
                <Button
                  onClick={handleInstall}
                  disabled={isInstalling}
                  size="sm"
                  className="gap-1.5 font-semibold"
                >
                  {isIOS ? (
                    <Share className="h-4 w-4" />
                  ) : hasPrompt ? (
                    <Download className="h-4 w-4" />
                  ) : (
                    <HelpCircle className="h-4 w-4" />
                  )}
                  {ctaLabel}
                </Button>
                {preflight.degraded && (
                  <Button
                    onClick={() => preflight.rerun()}
                    variant="outline"
                    size="sm"
                    className="gap-1.5"
                  >
                    <RefreshCw className="h-3.5 w-3.5" />
                    Retry
                  </Button>
                )}
                <Button
                  onClick={handleDismiss}
                  variant="ghost"
                  size="sm"
                  className="text-muted-foreground"
                >
                  Not now
                </Button>
              </div>
            </div>
          </div>
        </div>
      </motion.div>
    </AnimatePresence>
    </>
  );
}
