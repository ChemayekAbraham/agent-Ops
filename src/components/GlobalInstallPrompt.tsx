import { useEffect, useState } from 'react';
import InstallAppCard from '@/components/InstallAppCard';
import InstallNagOverlay from '@/components/InstallNagOverlay';
import { hasPriorityInstallCard, subscribeInstallCards } from '@/lib/installCardRegistry';

/**
 * Install offer for visitors who are not inside the signed-in dashboard shell
 * (landing, listings, public pages). Stands down whenever the dashboard header
 * card is mounted, so only one card is ever on screen.
 */
export default function GlobalInstallPrompt() {
  const [suppressed, setSuppressed] = useState(() => hasPriorityInstallCard());

  useEffect(() => {
    setSuppressed(hasPriorityInstallCard());
    return subscribeInstallCards((count) => setSuppressed(count > 0));
  }, []);

  if (suppressed) return null;

  return (
    <div className="fixed bottom-3 left-0 right-0 z-40 px-3 pointer-events-none">
      <div className="mx-auto w-full max-w-md pointer-events-auto">
        <InstallAppCard global />
      </div>
    </div>
  );
}