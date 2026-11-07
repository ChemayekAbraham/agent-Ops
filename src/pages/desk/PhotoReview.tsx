import { useEffect, useMemo, useState } from 'react';
import { Check, Star, X } from 'lucide-react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { FunderNewHouseCard } from '@/components/funder-new/FunderNewHouseCard';
import type { FunderNewReadyPlan } from '@/components/funder-new/types';
import { CALM, FOCUS, LABEL, PANEL, statusGlass, statusText } from './deskTheme';
import { Skeleton } from './Skeleton';
import { readableError, rpc } from './reviewApi';

/**
 * Agent Ops' photo review: approve or reject each house photo, star the main
 * one, and see the funders' own card ("Houses to fund") update as the main
 * photo changes — before anything is saved.
 *
 * The server (`agent_ops_review_photos`) needs 3+ approved photos with the
 * main among them; the Save button waits for the same, and the server's own
 * message is shown if it still refuses.
 */

export type PhotoState = {
  all_photos: string[];
  current: string[];
  reviewed: boolean;
  main: string | null;
  approved: string[];
  rejected: string[];
  ok: boolean;
};

export type CardPreview = {
  house_category: string | null;
  location: string | null;
  rent: number | null;
  main_photo: string | null;
  photos: string[];
  gps: { lat: number; lng: number } | null;
  badge: string | null;
};

export const MIN_APPROVED = 3;

type Verdict = 'approved' | 'rejected';

/** Why Save is off, or null when the review can be saved. */
export function photoSaveBlocked(approved: string[], main: string | null): string | null {
  if (approved.length < MIN_APPROVED) return `Approve at least ${MIN_APPROVED} photos (${approved.length} so far).`;
  if (!main) return 'Mark the main photo with ★.';
  if (!approved.includes(main)) return 'The main photo must be one of the approved photos.';
  return null;
}

/** The photos the funders will see, main first, then the rest of the approved ones. */
export function previewPhotos(preview: CardPreview | null | undefined, main: string | null, approved: string[]): string[] {
  const rest = approved.filter((u) => u !== main);
  const ordered = main ? [main, ...rest] : rest;
  return ordered.length > 0 ? ordered : (preview?.photos ?? []).filter(Boolean);
}

/** The preview as the funders' card reads a rent plan. */
export function previewPlan(preview: CardPreview | null | undefined, main: string | null, approved: string[]): FunderNewReadyPlan {
  return {
    house_category: preview?.house_category ?? null,
    tenant_location: preview?.location ?? null,
    request_city: null,
    funding_amount: Number(preview?.rent ?? 0),
    house_image_urls: previewPhotos(preview, main, approved),
    request_latitude: preview?.gps?.lat ?? null,
    request_longitude: preview?.gps?.lng ?? null,
  } as unknown as FunderNewReadyPlan;
}

function usePhotoState(requestId: string) {
  return useQuery({
    queryKey: ['desk-feed', 'photo-state', requestId],
    queryFn: async (): Promise<PhotoState> => {
      const { data, error } = await rpc('agent_ops_photo_state', { p_request_id: requestId });
      if (error) throw error;
      const d = (data ?? {}) as Partial<PhotoState>;
      return {
        all_photos: d.all_photos ?? [],
        current: d.current ?? [],
        reviewed: d.reviewed === true,
        main: d.main ?? null,
        approved: d.approved ?? [],
        rejected: d.rejected ?? [],
        ok: d.ok === true,
      };
    },
    staleTime: 10_000,
    retry: false,
  });
}

function useCardPreview(requestId: string) {
  return useQuery({
    queryKey: ['desk-feed', 'card-preview', requestId],
    queryFn: async (): Promise<CardPreview> => {
      const { data, error } = await rpc('funder_card_preview', { p_request_id: requestId });
      if (error) throw error;
      const d = (data ?? {}) as Partial<CardPreview>;
      return {
        house_category: d.house_category ?? null,
        location: d.location ?? null,
        rent: d.rent ?? null,
        main_photo: d.main_photo ?? null,
        photos: d.photos ?? [],
        gps: d.gps ?? null,
        badge: d.badge ?? null,
      };
    },
    staleTime: 10_000,
    retry: false,
  });
}

const noop = () => {};

export function PhotoReview({ requestId }: { requestId: string }) {
  const queryClient = useQueryClient();
  const state = usePhotoState(requestId);
  const preview = useCardPreview(requestId);
  const [verdict, setVerdict] = useState<Record<string, Verdict>>({});
  const [main, setMain] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  // Start from what was saved last time.
  useEffect(() => {
    if (!state.data || ready) return;
    const v: Record<string, Verdict> = {};
    state.data.approved.forEach((u) => (v[u] = 'approved'));
    state.data.rejected.forEach((u) => (v[u] = 'rejected'));
    setVerdict(v);
    setMain(state.data.main);
    setReady(true);
  }, [state.data, ready]);

  const photos = state.data?.all_photos ?? [];
  const approved = useMemo(() => photos.filter((u) => verdict[u] === 'approved'), [photos, verdict]);
  const rejected = useMemo(() => photos.filter((u) => verdict[u] === 'rejected'), [photos, verdict]);
  const blocked = photoSaveBlocked(approved, main);
  const plan = useMemo(() => previewPlan(preview.data, main, approved), [preview.data, main, approved]);

  const toggle = (url: string, v: Verdict) => {
    setMessage(null);
    setVerdict((m) => {
      const next = { ...m };
      if (next[url] === v) delete next[url];
      else next[url] = v;
      return next;
    });
    if (v === 'rejected' && main === url) setMain(null);
  };

  const star = (url: string) => {
    setMessage(null);
    setMain(url);
    // A main photo is always an approved one.
    setVerdict((m) => ({ ...m, [url]: 'approved' }));
  };

  const save = async () => {
    if (blocked || !main) return;
    setBusy(true);
    setMessage(null);
    const { error } = await rpc('agent_ops_review_photos', {
      p_request_id: requestId,
      p_main_url: main,
      p_approved: approved,
      p_rejected: rejected,
    });
    setBusy(false);
    if (error) {
      setMessage({ ok: false, text: readableError(error) });
      return;
    }
    setMessage({ ok: true, text: `Saved: ${approved.length} approved, ${rejected.length} rejected.` });
    queryClient.invalidateQueries({ queryKey: ['desk-feed'] });
  };

  if (state.isLoading) return <Skeleton className="h-64 w-full" />;
  if (state.error) return <p className={`text-sm ${statusText.bad}`}>{readableError(state.error)}</p>;

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_18rem]">
      <section className={`${PANEL} space-y-3 p-4`} aria-label="House photos">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h3 className="text-sm font-semibold text-foreground">House photos</h3>
          <span className={LABEL}>
            {approved.length} approved · {rejected.length} rejected · {photos.length} in all
          </span>
        </div>
        {photos.length === 0 ? (
          <p className={`text-sm ${statusText.bad}`}>No photos of the house were sent.</p>
        ) : (
          <ul className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            {photos.map((u, i) => {
              const v = verdict[u];
              const isMain = main === u;
              return (
                <li
                  key={u}
                  className={`space-y-1.5 rounded-xl border p-1.5 ${
                    v === 'approved' ? statusGlass.ok : v === 'rejected' ? statusGlass.bad : 'border-[var(--desk-line-color)]'
                  }`}
                >
                  <div className="relative">
                    <img src={u} alt={`House photo ${i + 1}`} loading="lazy" className={`aspect-[4/3] w-full rounded-lg object-cover ${v === 'rejected' ? 'opacity-40' : ''}`} />
                    <button
                      type="button"
                      aria-pressed={isMain}
                      aria-label={isMain ? `Photo ${i + 1} is the main photo` : `Make photo ${i + 1} the main photo`}
                      onClick={() => star(u)}
                      className={`absolute right-1.5 top-1.5 rounded-full bg-black/60 p-1 ${CALM} ${FOCUS}`}
                    >
                      <Star className={`h-4 w-4 ${isMain ? 'fill-amber-400 text-amber-400' : 'text-white'}`} aria-hidden />
                    </button>
                  </div>
                  <div className="flex gap-1">
                    <button
                      type="button"
                      aria-pressed={v === 'approved'}
                      onClick={() => toggle(u, 'approved')}
                      className={`desk-pill flex flex-1 items-center justify-center gap-1 border px-2 py-0.5 text-xs ${CALM} ${FOCUS} ${
                        v === 'approved' ? statusGlass.ok : 'border-[var(--desk-line-color)] text-muted-foreground'
                      }`}
                    >
                      <Check className="h-3 w-3" aria-hidden /> Approve
                    </button>
                    <button
                      type="button"
                      aria-pressed={v === 'rejected'}
                      onClick={() => toggle(u, 'rejected')}
                      className={`desk-pill flex flex-1 items-center justify-center gap-1 border px-2 py-0.5 text-xs ${CALM} ${FOCUS} ${
                        v === 'rejected' ? statusGlass.bad : 'border-[var(--desk-line-color)] text-muted-foreground'
                      }`}
                    >
                      <X className="h-3 w-3" aria-hidden /> Reject
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}

        {blocked && <p className={`text-sm ${statusText.warn}`}>{blocked}</p>}
        {message && (
          <p className={`text-sm ${message.ok ? statusText.ok : statusText.bad}`} role={message.ok ? 'status' : 'alert'}>
            {message.text}
          </p>
        )}
        <button
          type="button"
          disabled={!!blocked || busy}
          onClick={save}
          className={`desk-pill border px-4 py-2 text-sm font-medium ${CALM} ${FOCUS} ${
            !blocked && !busy ? statusGlass.ok : 'border-[var(--desk-line-color)] bg-[var(--desk-surface)] text-muted-foreground'
          } disabled:cursor-not-allowed`}
        >
          {busy ? 'Saving…' : 'Save the photo review'}
        </button>
      </section>

      <aside className="space-y-2" aria-label="What funders will see">
        <h3 className="text-sm font-semibold text-foreground">What funders will see</h3>
        {preview.isLoading ? (
          <Skeleton className="h-72 w-full" />
        ) : preview.error ? (
          <p className={`text-sm ${statusText.bad}`}>{readableError(preview.error)}</p>
        ) : (
          <div data-testid="funder-preview" data-main={plan.house_image_urls?.[0] ?? ''}>
            <FunderNewHouseCard
              category="ready"
              item={plan}
              saved={false}
              selected={false}
              distance={null}
              onSave={noop}
              onSelect={noop}
              onDetail={noop}
            />
          </div>
        )}
        <p className={LABEL}>Updates as you change the main photo; nothing is saved until you press Save.</p>
      </aside>
    </div>
  );
}
