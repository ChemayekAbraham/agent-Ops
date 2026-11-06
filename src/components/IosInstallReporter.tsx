import { useEffect } from 'react';
import { reportIosHomeScreenInstall } from '@/lib/installTracking';

/**
 * Records the first home-screen launch of an iOS install. Waits a few seconds so a restored
 * session is available and the install is attributed to the signed-in user.
 */
export function IosInstallReporter() {
  useEffect(() => {
    const t = window.setTimeout(() => {
      void reportIosHomeScreenInstall();
    }, 4000);
    return () => window.clearTimeout(t);
  }, []);
  return null;
}
