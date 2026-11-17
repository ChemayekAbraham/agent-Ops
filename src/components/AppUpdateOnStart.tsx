import { useEffect } from 'react';
import { settleAppUpdate, startupUpdate } from '@/lib/appUpdate';

/**
 * Headless, once per page load:
 *   - after an update, logs 'app_updated' { from_build, to_build } (settleAppUpdate);
 *   - a build more than 12 hours behind the live one reloads at once, before the agent starts
 *     typing (startupUpdate). Production builds only; a slow or failed check changes nothing.
 */
export function AppUpdateOnStart() {
  useEffect(() => {
    settleAppUpdate();
    void startupUpdate();
  }, []);
  return null;
}
