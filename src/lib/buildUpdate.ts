import { BUILD_INFO } from '@/lib/buildInfo';

/**
 * Detecting that welileapp.com now serves a newer build than the one a tab is
 * running. Open tabs otherwise keep an old bundle for days: its lazy chunks 404
 * after a deploy and the same fixed errors keep reappearing in the CTO error log
 * (2026-10-01: the AgentTenantsSheet / AgentListingsSheet / IndexedDB rows were
 * all tabs on chunks that no longer exist).
 *
 * Detection only. Nothing here reloads a page.
 */

export interface BuildStamp {
  source?: string | null;
  builtAt?: string | null;
}

const KNOWN = (v: string | null | undefined): v is string => !!v && v !== 'unknown';

/**
 * True only when the remote build is a different source tree AND was built later
 * than this one. The time check keeps a rollback (older build now live) from
 * nagging every open tab to "update" to older code.
 */
export function isNewerBuild(local: BuildStamp, remote: BuildStamp): boolean {
  if (!KNOWN(local.source) || !KNOWN(remote.source)) return false;
  if (local.source === remote.source) return false;
  if (!KNOWN(local.builtAt) || !KNOWN(remote.builtAt)) return false;
  const l = Date.parse(local.builtAt);
  const r = Date.parse(remote.builtAt);
  if (Number.isNaN(l) || Number.isNaN(r)) return false;
  return r > l;
}

/** The running tab's own stamp. */
export const RUNNING_BUILD: BuildStamp = { source: BUILD_INFO.source, builtAt: BUILD_INFO.builtAt };

/** Read /build-info.json uncached. Returns null on any failure (offline, 404, bad JSON). */
export async function fetchLiveBuild(signal?: AbortSignal): Promise<BuildStamp | null> {
  try {
    const res = await fetch(`/build-info.json?t=${Date.now()}`, { cache: 'no-store', signal });
    if (!res.ok) return null;
    const json = (await res.json()) as BuildStamp;
    return { source: json?.source ?? null, builtAt: json?.builtAt ?? null };
  } catch {
    return null;
  }
}
