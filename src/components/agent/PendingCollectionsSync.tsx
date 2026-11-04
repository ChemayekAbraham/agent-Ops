import { useEffect, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { toast } from 'sonner';
import { CloudUpload } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { formatUGX } from '@/lib/rentCalculations';
import { logCollectionError } from '@/lib/logCollectionError';
import {
  callWithRetry,
  listPendingCollections,
  removeQueuedCollection,
  QUEUE_EVENT,
} from '@/lib/collectionSubmitRetry';

let replaying = false;

/** Resends queued collections with their ORIGINAL args and client_ref. */
export async function replayPendingCollections(): Promise<void> {
  if (replaying || (typeof navigator !== 'undefined' && !navigator.onLine)) return;
  const items = listPendingCollections();
  if (!items.length) return;
  replaying = true;
  try {
    const { data: s } = await supabase.auth.getSession();
    const uid = s.session?.user?.id;
    for (const item of items) {
      if (!uid || item.args.p_agent_id !== uid) continue; // only this agent's own items
      const { result, attempts, lastKind } = await callWithRetry(
        () => supabase.rpc('agent_allocate_tenant_payment', item.args) as unknown as Promise<{ data: unknown; error: unknown }>,
      );
      if (result.error) {
        if (lastKind === 'permission' || lastKind === 'other') {
          // Definitive server refusal — stop resending and tell the agent.
          removeQueuedCollection(item.args.p_client_ref);
          const msg = (result.error as { message?: string })?.message ?? 'Collection was refused';
          toast.error('Saved collection was not recorded', { description: msg });
          logCollectionError({
            phase: 'sync', message: msg,
            errorCode: (result.error as { code?: string })?.code ?? null,
            tenantId: item.args.p_tenant_id, rentRequestId: item.args.p_rent_request_id,
            amount: item.args.p_amount, clientRef: item.args.p_client_ref,
            context: { attempts, queued_at: item.queuedAt },
          });
        }
        continue; // transient: keep queued for the next trigger
      }
      const res = result.data as { success?: boolean; error?: string } | null;
      removeQueuedCollection(item.args.p_client_ref);
      if (res?.success) {
        toast.success('Saved collection sent', {
          description: `${formatUGX(item.args.p_amount)}${item.tenantName ? ` for ${item.tenantName}` : ''} is now recorded.`,
        });
      } else {
        toast.error('Saved collection was not recorded', { description: String(res?.error ?? 'Rejected') });
      }
    }
  } finally {
    replaying = false;
  }
}

/** Mounted once: replays on start, on 'online', and when the tab becomes visible. */
export default function PendingCollectionsSync() {
  const [count, setCount] = useState(() => listPendingCollections().length);
  const { pathname } = useLocation();

  useEffect(() => {
    const refresh = () => setCount(listPendingCollections().length);
    const run = () => { void replayPendingCollections(); };
    const onVis = () => { if (document.visibilityState === 'visible') run(); };
    run();
    window.addEventListener('online', run);
    window.addEventListener(QUEUE_EVENT, refresh);
    window.addEventListener('storage', refresh);
    document.addEventListener('visibilitychange', onVis);
    return () => {
      window.removeEventListener('online', run);
      window.removeEventListener(QUEUE_EVENT, refresh);
      window.removeEventListener('storage', refresh);
      document.removeEventListener('visibilitychange', onVis);
    };
  }, []);

  // Dashboard mount also triggers a replay.
  useEffect(() => {
    if (pathname.startsWith('/dashboard/agent')) void replayPendingCollections();
  }, [pathname]);

  if (!count || !pathname.startsWith('/dashboard/agent')) return null;
  return (
    <div
      role="status"
      className="fixed left-3 top-16 z-40 flex items-center gap-1.5 rounded-full border bg-card px-3 py-1 text-xs font-medium text-foreground shadow-sm"
    >
      <CloudUpload className="h-3.5 w-3.5 text-primary" />
      {count} collection{count === 1 ? '' : 's'} waiting to send
    </div>
  );
}
