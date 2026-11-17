import { Suspense, useEffect } from 'react';
import { Loader2 } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { lazyWithRetry } from '@/lib/lazyWithRetry';
import { useAuth } from '@/hooks/useAuth';
import { AGENT_RENT_REQUEST_REOPEN_FLAG } from '@/lib/formPhotoDraft';
import { closeT4RentRequest, openT4RentRequest, useT4Request, type T4Request } from '@/lib/t4RentRequest';
import { resumeRequestFor } from '@/lib/t4Resume';

const RentRequestAssistant = lazyWithRetry(() => import('./RentRequestAssistant'));

/** Lists that show a request the T4 form just sent; refreshed so open screens see it. */
export const T4_REFRESH_KEYS = [
  'rent-pipeline',
  'service-center-rent-queue',
  'partner-ops-rent-queue',
  'agent-rejected-rent-requests',
  'agent-pipeline',
  'agent-requests-missing-details',
  'tenant-registration',
  'tenant-documents',
];

/** Turns the older `open-rent-request` window event (deep links, widgets) into a T4 request. */
export function requestFromEvent(detail: unknown): T4Request {
  if (detail && typeof detail === 'object' && 'mode' in detail) return detail as T4Request;
  return { mode: 'new', entry: 'open-rent-request-event' };
}

/**
 * Shows the T4 rent request form wherever an agent is in the app. Mounted once
 * in App. Each open mounts a fresh form (keyed), filled from what opened it.
 */
export default function T4RentRequestHost() {
  const req = useT4Request();
  const queryClient = useQueryClient();
  const { user } = useAuth();

  // The phone reloaded the page while this agent was filling a new request (often on
  // return from the camera app): open it again; the form restores its draft (doc 276).
  useEffect(() => {
    if (!user?.id) return;
    // The app just updated in the middle of a Post / Resubmit / Renew: reopen that same chat.
    const resumed = resumeRequestFor(user.id);
    if (resumed) { openT4RentRequest(resumed); return; }
    let mine = false;
    try { mine = localStorage.getItem(AGENT_RENT_REQUEST_REOPEN_FLAG) === user.id; } catch { /* ignore */ }
    if (mine) openT4RentRequest({ mode: 'new', entry: 'reload' });
  }, [user?.id]);

  useEffect(() => {
    const handler = (e: Event) => openT4RentRequest(requestFromEvent((e as CustomEvent).detail));
    window.addEventListener('open-rent-request', handler);
    return () => window.removeEventListener('open-rent-request', handler);
  }, []);

  if (!req) return null;
  return (
    <Suspense
      fallback={(
        <div className="fixed inset-0 z-[115] flex items-center justify-center bg-background" role="status" aria-label="Opening the rent request form">
          <Loader2 className="h-6 w-6 animate-spin text-primary" />
        </div>
      )}
    >
      <RentRequestAssistant
        key={req.key}
        open
        request={req}
        onOpenChange={(o) => { if (!o) closeT4RentRequest(); }}
        onSuccess={() => T4_REFRESH_KEYS.forEach((key) => queryClient.invalidateQueries({ queryKey: [key] }))}
      />
    </Suspense>
  );
}
