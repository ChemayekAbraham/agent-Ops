import { useEffect } from 'react';
import { toast } from 'sonner';
import { BUILD_INFO } from '@/lib/buildInfo';
import { RUNNING_BUILD, fetchLiveBuild, isNewerBuild } from '@/lib/buildUpdate';
import { isCriticalFlowActive, subscribeCriticalFlow } from '@/lib/criticalFlowGuard';

const TOAST_ID = 'welile-new-build';
/** Checked on start, then every 2 minutes while the app is open, and whenever it comes back to the front. */
export const RECHECK_MS = 2 * 60 * 1000;
const MIN_GAP_MS = 60 * 1000;

/** The banner: "Update now" first, then what it is. */
export function NewBuildBanner({ onUpdate }: { onUpdate: () => void }) {
  return (
    <div className="flex w-full items-center gap-3 rounded-xl border border-border bg-card p-3 text-card-foreground shadow-lg" role="status" data-testid="new-build-banner">
      <button
        type="button"
        onClick={onUpdate}
        className="min-h-10 shrink-0 rounded-lg bg-primary px-3 text-sm font-semibold text-primary-foreground"
      >
        Update now
      </button>
      <div className="min-w-0">
        <p className="text-sm font-semibold">A new version of Welile is ready</p>
        <p className="text-xs text-muted-foreground">Update to get the latest fixes. Finish what you are doing first.</p>
      </div>
    </div>
  );
}

/**
 * Headless. Tells a tab that a newer build is live as soon as it is (checked on start, every
 * 2 minutes, and on return to the app), so it stops running a bundle whose chunks no longer
 * exist. It only ever OFFERS the update: nothing reloads until the person taps "Update now",
 * and nothing is offered while a protected flow (collection, payout, sign-in) is open.
 * (A build more than an hour old reloads on start by itself: AppUpdateOnStart.)
 */
export function BuildUpdateWatcher() {
  useEffect(() => {
    // Dev server and unstamped builds have nothing to compare.
    if (BUILD_INFO.mode !== 'production') return;

    let stopped = false;
    let lastCheck = 0;
    let pendingSource: string | null = null; // newer build found, not yet shown
    let shownFor: string | null = null;      // newer build already offered (or dismissed)

    const show = () => {
      if (!pendingSource || shownFor === pendingSource || isCriticalFlowActive()) return;
      const source = pendingSource;
      shownFor = source;
      toast.custom(() => <NewBuildBanner onUpdate={() => window.location.reload()} />, {
        id: TOAST_ID,
        duration: Infinity,
      });
    };

    const check = async () => {
      if (stopped || document.visibilityState === 'hidden') return;
      if (Date.now() - lastCheck < MIN_GAP_MS) return;
      lastCheck = Date.now();
      const live = await fetchLiveBuild();
      if (stopped || !live) return;
      if (isNewerBuild(RUNNING_BUILD, live)) {
        pendingSource = live.source ?? null;
        show();
      }
    };

    const onVisible = () => { if (document.visibilityState === 'visible') void check(); };
    document.addEventListener('visibilitychange', onVisible);
    const interval = window.setInterval(() => void check(), RECHECK_MS);
    // A flow closing is a safe moment to offer a prompt that was held back.
    const unsubscribe = subscribeCriticalFlow(show);
    // At once: a newer build is offered as soon as it exists.
    const first = window.setTimeout(() => void check(), 0);

    return () => {
      stopped = true;
      document.removeEventListener('visibilitychange', onVisible);
      window.clearInterval(interval);
      window.clearTimeout(first);
      unsubscribe();
    };
  }, []);

  return null;
}
