import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { identityPhotoUrl } from '@/hooks/useIdentityPhotos';
import { rpc } from './reviewApi';
import { CALM, FOCUS, LABEL, PANEL, statusGlass } from './deskTheme';
import { Skeleton } from './Skeleton';
import { ErrorLine } from './ui';

/**
 * Identity photos at the top of the review drawer (E77), on every desk:
 * `request_identity_photos(p_request_id)`. The tenant's passport photo beside
 * the agent's photo (the vetting passport photo when there is one), and the
 * tenant's ID front and back. Tap any photo to see it large.
 *
 * The server compares the pictures; any flag it raises becomes a red
 * "Check identity: …" banner above the decision buttons.
 */

type StoredFile = { bucket: string | null; path: string } | null;

export type IdentityPhotos = {
  tenant: { name: string | null; passport_photo_url: string | null; id_front: StoredFile; id_back: StoredFile } | null;
  agent: { name: string | null; photo_url: string | null; vetting_passport_photo: string | null; vetting_status: string | null } | null;
  flags: Partial<Record<IdentityFlag, boolean>>;
};

export type IdentityFlag = 'tenant_photo_is_agent_profile_photo' | 'tenant_photo_matches_agent_fingerprint' | 'tenant_photo_used_by_another_person';

export const FLAG_WORDS: Record<IdentityFlag, string> = {
  tenant_photo_is_agent_profile_photo: "the tenant's photo is the agent's own profile photo",
  tenant_photo_matches_agent_fingerprint: "the tenant's photo is the same picture as one the agent uploaded",
  tenant_photo_used_by_another_person: "the tenant's photo is also used for another person",
};

/** "Check identity: …" with every raised flag in words, or null when none is raised. */
export function identityBanner(flags: IdentityPhotos['flags'] | null | undefined): string | null {
  const raised = (Object.keys(FLAG_WORDS) as IdentityFlag[]).filter((f) => flags?.[f] === true);
  if (raised.length === 0) return null;
  return `Check identity: ${raised.map((f) => FLAG_WORDS[f]).join('; ')}`;
}

async function signed(file: StoredFile): Promise<string | null> {
  if (!file?.path) return null;
  const { data, error } = await supabase.storage.from(file.bucket || 'tenant-ids').createSignedUrl(file.path, 600);
  return error ? null : (data?.signedUrl ?? null);
}

export function useIdentityPhotos(requestId: string) {
  return useQuery({
    queryKey: ['desk-feed', 'identity-photos', requestId],
    queryFn: async (): Promise<IdentityPhotos & { urls: { idFront: string | null; idBack: string | null; agentVetting: string | null } }> => {
      const { data, error } = await rpc('request_identity_photos', { p_request_id: requestId });
      if (error) throw error;
      const d = (data ?? {}) as Partial<IdentityPhotos>;
      const tenant = d.tenant ?? null;
      const agent = d.agent ?? null;
      const [idFront, idBack, agentVetting] = await Promise.all([
        signed(tenant?.id_front ?? null),
        signed(tenant?.id_back ?? null),
        identityPhotoUrl(agent?.vetting_passport_photo ?? null),
      ]);
      return { tenant, agent, flags: d.flags ?? {}, urls: { idFront, idBack, agentVetting } };
    },
    staleTime: 5 * 60_000,
    retry: false,
  });
}

function Photo({ label, src, alt, size, onOpen }: { label: string; src: string | null; alt: string; size: number; onOpen: (s: { src: string; alt: string }) => void }) {
  return (
    <figure style={{ margin: 0, display: 'flex', flexDirection: 'column', gap: 4, alignItems: 'flex-start' }} data-photo={label}>
      <figcaption className={LABEL}>{label}</figcaption>
      {src ? (
        <button
          type="button"
          onClick={() => onOpen({ src, alt })}
          aria-label={`Enlarge: ${alt}`}
          className={`overflow-hidden rounded-xl border border-[var(--desk-line-color)] ${CALM} ${FOCUS} hover:opacity-90`}
          style={{ width: size, height: size, padding: 0, background: 'none' }}
        >
          <img src={src} alt={alt} loading="lazy" style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
        </button>
      ) : (
        <span
          className="rounded-xl border border-dashed border-[var(--desk-line-color)] text-xs text-muted-foreground"
          style={{ width: size, height: size, display: 'flex', alignItems: 'center', justifyContent: 'center', textAlign: 'center', padding: 6 }}
        >
          No photo
        </span>
      )}
    </figure>
  );
}

export function IdentityPanel({ requestId }: { requestId: string }) {
  const q = useIdentityPhotos(requestId);
  const [big, setBig] = useState<{ src: string; alt: string } | null>(null);
  const d = q.data;

  return (
    <section className={`${PANEL} p-4`} aria-label="Identity photos" data-identity-photos style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <h3 className="text-sm font-semibold text-foreground" style={{ margin: 0 }}>
        Identity
      </h3>
      {q.isLoading ? (
        <div style={{ display: 'flex', gap: 12 }} role="status" aria-label="Loading identity photos">
          <Skeleton className="h-28 w-28" />
          <Skeleton className="h-28 w-28" />
        </div>
      ) : q.error ? (
        <ErrorLine>{String((q.error as { message?: string }).message ?? q.error)}</ErrorLine>
      ) : d ? (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 16, alignItems: 'flex-end' }}>
          <Photo label="Tenant" src={d.tenant?.passport_photo_url ?? null} alt={`Tenant passport photo${d.tenant?.name ? `: ${d.tenant.name}` : ''}`} size={112} onOpen={setBig} />
          <Photo
            label={`Agent${d.agent?.vetting_status ? ` · vetting ${d.agent.vetting_status.replace(/_/g, ' ')}` : ''}`}
            src={d.urls.agentVetting ?? d.agent?.photo_url ?? null}
            alt={`Agent photo${d.agent?.name ? `: ${d.agent.name}` : ''}`}
            size={112}
            onOpen={setBig}
          />
          <Photo label="ID front" src={d.urls.idFront} alt="Tenant ID, front" size={72} onOpen={setBig} />
          <Photo label="ID back" src={d.urls.idBack} alt="Tenant ID, back" size={72} onOpen={setBig} />
        </div>
      ) : null}

      {big && (
        <div role="dialog" aria-modal="true" aria-label={big.alt} className="fixed inset-0 z-[60] flex items-center justify-center p-4" style={{ position: 'fixed', inset: 0 }}>
          <button type="button" aria-label="Close the photo" onClick={() => setBig(null)} className="absolute inset-0 bg-black/80" style={{ position: 'absolute', inset: 0 }} />
          <img src={big.src} alt={big.alt} className="relative max-h-[85dvh] max-w-full rounded-xl" style={{ position: 'relative', objectFit: 'contain' }} />
        </div>
      )}
    </section>
  );
}

/** The red banner above the decision buttons, when the server raised any identity flag. */
export function IdentityBanner({ requestId }: { requestId: string }) {
  const q = useIdentityPhotos(requestId);
  const text = identityBanner(q.data?.flags);
  if (!text) return null;
  return (
    <p role="alert" data-identity-banner className={`rounded-xl border px-3 py-2 text-sm font-medium ${statusGlass.bad}`} style={{ margin: 0 }}>
      {text}
    </p>
  );
}
