import { Suspense, useEffect } from 'react';
import { Loader2 } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { lazyWithRetry } from '@/lib/lazyWithRetry';
import { closeT4RentRequest, openT4RentRequest, useT4Request, type T4Request } from '@/lib/t4RentRequest';

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
