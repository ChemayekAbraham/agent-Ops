import { useEffect, useState, useCallback } from 'react';
import { ShieldAlert, ChevronRight } from 'lucide-react';
import { useAuth } from '@/hooks/useAuth';
import { listDrafts } from '@/lib/offlineCollectionDrafts';
import { AgentPendingSyncDrawer } from './AgentPendingSyncDrawer';

/**
 * Compact banner under the OfflineBanner that surfaces agent-local
 * offline collection drafts. Only shows when there are drafts on this device.
 * The drafts are NEVER sent to Operations until the agent attaches proof
 * and submits via the drawer (per CFO mandate).
 */
export function PendingDraftsBanner() {
  const { user } = useAuth();
  const [counts, setCounts] = useState({ awaiting: 0, ready: 0 });
  const [drawerOpen, setDrawerOpen] = useState(false);

  const refresh = useCallback(async () => {
    if (!user) return;
    const drafts = await listDrafts(user.id);
    setCounts({
      awaiting: drafts.filter(d => d.status === 'awaiting_proof').length,
      ready: drafts.filter(d => d.status === 'ready_to_submit').length,
    });
  }, [user?.id]);

  useEffect(() => {
    refresh();
    const onFocus = () => refresh();
    window.addEventListener('focus', onFocus);
    const interval = setInterval(refresh, 15_000);
    return () => {
      window.removeEventListener('focus', onFocus);
      clearInterval(interval);
    };
  }, [refresh]);

  const total = counts.awaiting + counts.ready;
  if (total === 0) return null;

  return (
    <>
      <button
        onClick={() => setDrawerOpen(true)}
        className="w-full bg-warning/15 hover:bg-warning/20 border-b border-warning/30 px-4 py-2 flex items-center justify-between text-sm transition-colors"
      >
        <div className="flex items-center gap-2">
          <ShieldAlert className="h-4 w-4 text-warning" />
          <span className="font-semibold text-warning-foreground">
            {total} offline draft{total > 1 ? 's' : ''} on this phone
          </span>
          <span className="text-[11px] text-muted-foreground">
            ({counts.awaiting} need proof
            {counts.ready > 0 ? ` · ${counts.ready} ready` : ''})
          </span>
        </div>
        <ChevronRight className="h-4 w-4 text-muted-foreground" />
      </button>
      <AgentPendingSyncDrawer
        open={drawerOpen}
        onOpenChange={(o) => { setDrawerOpen(o); if (!o) refresh(); }}
      />
    </>
  );
}