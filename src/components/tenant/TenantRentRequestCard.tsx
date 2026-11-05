import { Suspense, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { HandCoins } from 'lucide-react';
import { FadedHouseIllustration } from '@/components/common/FadedHouseIllustration';
import { supabase } from '@/integrations/supabase/client';
import { lazyWithRetry } from '@/lib/lazyWithRetry';

// The request form and the progress tracker (dialogs, village picker, date formatting) load only when opened.
const TenantRentRequestDialogs = lazyWithRetry(() => import('./TenantRentRequestDialogs'));

const OPEN_STATUSES = ['submitted', 'claimed', 'visit_verified', 'approved'];

const STATUS_COPY: Record<string, { label: string; note: string }> = {
  submitted: { label: 'With Service Centre', note: 'Sent to your nearest Welile Service Centre for agent review.' },
  claimed: { label: 'Agent assigned', note: 'An agent picked up your request and will visit your house to verify it.' },
  visit_verified: { label: 'House verified', note: 'Your house was verified. The agent is finishing the review.' },
  approved: { label: 'Approved', note: 'You were approved. Your agent will now raise the rent plan for you.' },
  rent_requested: { label: 'Rent plan raised', note: 'Your agent has raised your rent plan. Follow it from your rent plan card.' },
  declined: { label: 'Not approved', note: '' },
};

export interface TenantIntakeRow {
  status: string;
  rent_amount: number | string;
  service_centre_name: string | null;
  decline_reason: string | null;
  created_at: string;
  claimed_at: string | null;
  visit_verified_at: string | null;
  decided_at: string | null;
  location_name: string | null;
}

export interface TrackStep {
  key: string;
  label: string;
  at: string | null;
  note: string;
}

const INTAKE_COLUMNS =
  'status, rent_amount, service_centre_name, decline_reason, created_at, claimed_at, visit_verified_at, decided_at, location_name';

// Last known request status per tenant, so the card paints its real state on the first frame of a new visit
// instead of waiting for the network. The fresh answer replaces it as soon as it arrives.
const cacheKey = (userId: string) => `welile.tenant-rent-intake.v1.${userId}`;
function readCachedIntake(userId: string): TenantIntakeRow | null | undefined {
  try {
    const raw = localStorage.getItem(cacheKey(userId));
    if (!raw) return undefined;
    return JSON.parse(raw) as TenantIntakeRow | null;
  } catch {
    return undefined;
  }
}
function writeCachedIntake(userId: string, row: TenantIntakeRow | null) {
  try {
    localStorage.setItem(cacheKey(userId), JSON.stringify(row));
  } catch {
    /* storage unavailable: the card just waits for the network as before */
  }
}

const ONBOARDING_PATH = '/tenants-onboarding';
const preloadOnboarding = () => { void import('@/pages/TenantsOnboarding').catch(() => {}); };

export function TenantRentRequestCard({ userId }: { userId: string }) {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [trackOpen, setTrackOpen] = useState(false);

  const { data: latest } = useQuery({
    queryKey: ['tenant-rent-intake', userId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('tenant_rent_intake_requests')
        .select(INTAKE_COLUMNS)
        .eq('tenant_id', userId)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) throw error;
      const row = (data as TenantIntakeRow | null) ?? null;
      writeCachedIntake(userId, row);
      return row;
    },
    placeholderData: () => readCachedIntake(userId),
  });

  // Fetch the onboarding page while the browser is idle, so the tap opens it straight away.
  useEffect(() => {
    if (typeof window.requestIdleCallback === 'function') {
      const handle = window.requestIdleCallback(preloadOnboarding);
      return () => window.cancelIdleCallback(handle);
    }
    // Browsers without requestIdleCallback (older Safari): wait a moment instead.
    const timer = window.setTimeout(preloadOnboarding, 1500);
    return () => window.clearTimeout(timer);
  }, []);

  const openCard = () => {
    // Same app on our own hosts: move within it instead of reloading the whole site.
    const host = window.location.hostname;
    if (host === 'localhost' || host === '127.0.0.1' || host.endsWith('welileapp.com')) {
      navigate(ONBOARDING_PATH);
    } else {
      window.location.href = `https://welileapp.com${ONBOARDING_PATH}`;
    }
  };

  const openRequest = latest && OPEN_STATUSES.includes(latest.status) ? latest : null;

  const status = openRequest ? STATUS_COPY[openRequest.status] : null;

  const trackSteps: TrackStep[] = latest
    ? [
        { key: 'submitted', label: 'Request sent', at: latest.created_at, note: latest.service_centre_name ? `Routed to ${latest.service_centre_name}` : 'Routed to your nearest Service Centre' },
        { key: 'claimed', label: 'Agent assigned', at: latest.claimed_at, note: 'An agent picked up your request' },
        { key: 'visit_verified', label: 'House verified', at: latest.visit_verified_at, note: 'The agent visited and verified your house' },
        {
          key: 'decided',
          label: latest.status === 'declined' ? 'Not approved' : 'Approved',
          at: latest.decided_at,
          note: latest.status === 'declined'
            ? (latest.decline_reason || 'Your agent did not approve this request')
            : 'Your agent will now raise your rent plan',
        },
      ]
    : [];
  const doneCount = trackSteps.filter((s) => !!s.at).length;

  return (
    <>
      <button
        type="button"
        onClick={openCard}
        onPointerEnter={preloadOnboarding}
        onTouchStart={preloadOnboarding}
        className="relative w-full rounded-2xl border-2 border-primary/40 bg-primary p-5 sm:p-6 text-left flex flex-col shadow-lg active:scale-[0.99] transition-all touch-manipulation overflow-hidden min-h-[175px] sm:min-h-[195px]"
      >
        {/* The house, very faint, behind the text */}
        <FadedHouseIllustration opacity={0.2} />
        <div className="relative z-10 flex flex-col justify-between h-full w-full gap-4 sm:gap-6">
          <div className="space-y-3 sm:space-y-3.5">
            <div className="p-2.5 sm:p-3 rounded-xl bg-primary-foreground/20 text-primary-foreground w-fit shadow-xs">
              <HandCoins className="h-6 w-6 sm:h-7 sm:w-7" />
            </div>
            <p className="font-extrabold text-[22px] sm:text-[30px] lg:text-[34px] leading-tight text-primary-foreground tracking-tight text-center">
              <span className="block">Request</span>
              <span className="block">rent</span>
              <span className="block">here</span>
            </p>
          </div>

          <div className="space-y-2">
            {openRequest ? (
              <>
                <div className="flex items-center gap-1.5">
                  {trackSteps.map((s, i) => (
                    <span
                      key={s.key}
                      className={`h-2 flex-1 rounded-full ${i < doneCount ? 'bg-primary-foreground' : 'bg-primary-foreground/25'}`}
                    />
                  ))}
                </div>
                <p className="text-xs sm:text-sm font-bold text-primary-foreground leading-tight">
                  Step {Math.max(doneCount, 1)} of {trackSteps.length} · {status?.label}
                </p>
                <p className="text-xs sm:text-sm text-primary-foreground/85 leading-snug sm:leading-relaxed line-clamp-2 lg:line-clamp-3 break-words">{status?.note}</p>
                <p className="text-xs font-semibold text-primary-foreground/90 underline">Track progress</p>
              </>
            ) : (
              <p className="text-sm sm:text-base text-primary-foreground/90 leading-snug sm:leading-relaxed font-medium line-clamp-2 lg:line-clamp-3 break-words">
                Request rent · agent verifies your house
              </p>
            )}
            {latest?.status === 'declined' && !openRequest && latest.decline_reason && (
              <p className="text-xs sm:text-sm text-primary-foreground/90 leading-snug line-clamp-1">
                Last request not approved: {latest.decline_reason}
              </p>
            )}
          </div>
        </div>
      </button>




      {(open || trackOpen) && (
        <Suspense fallback={null}>
          <TenantRentRequestDialogs
            userId={userId}
            open={open}
            onOpenChange={setOpen}
            trackOpen={trackOpen}
            onTrackOpenChange={setTrackOpen}
            latest={latest}
            trackSteps={trackSteps}
            doneCount={doneCount}
          />
        </Suspense>
      )}
    </>
  );
}

export default TenantRentRequestCard;
