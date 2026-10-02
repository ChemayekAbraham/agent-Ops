import { useEffect } from 'react';
import { toast } from 'sonner';
import { BUILD_INFO } from '@/lib/buildInfo';
import { RUNNING_BUILD, fetchLiveBuild, isNewerBuild } from '@/lib/buildUpdate';
import { isCriticalFlowActive, subscribeCriticalFlow } from '@/lib/criticalFlowGuard';

const TOAST_ID = 'welile-new-build';
const RECHECK_MS = 15 * 60 * 1000;
const MIN_GAP_MS = 5 * 60 * 1000;

/**
 * Headless. Tells a long-open tab that a newer build is live, so it stops running
 * a bundle whose chunks no longer exist. It only ever OFFERS the update: nothing
 * reloads until the person taps it, and nothing is offered while a protected
 * flow (collection, payout, sign-in) is open. Wording and look are Gemini's.
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
      toast('A new version of Welile is ready', {
        id: TOAST_ID,
        description: 'Update to get the latest fixes. Finish what you are doing first.',
        duration: Infinity,
        action: { label: 'Update now', onClick: () => window.location.reload() },
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
    const first = window.setTimeout(() => void check(), 30_000);

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
