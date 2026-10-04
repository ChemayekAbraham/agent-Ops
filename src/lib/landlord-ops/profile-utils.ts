import { supabase } from "@/integrations/supabase/client";

export interface ProfileLite {
  id: string;
  full_name: string | null;
  phone: string | null;
  email?: string | null;
}

export interface FetchProfilesOptions {
  chunkSize?: number;
  concurrency?: number;
  /** Columns to select. Defaults to id, full_name, phone, email. */
  columns?: string;
}

/**
 * Dedup, chunk, and fetch profile rows for a list of user ids.
 * - null / undefined / empty ids are skipped
 * - duplicate ids are collapsed to one lookup
 * - chunks run with bounded concurrency (default 4 × 500)
 * - returns immediately when there is nothing to fetch
 * - throws on genuine DB failure, otherwise resolves with a Map
 */
export async function fetchProfilesByIds(
  ids: Array<string | null | undefined>,
  options: FetchProfilesOptions = {},
): Promise<Map<string, ProfileLite>> {
  const { chunkSize = 500, concurrency = 4, columns = "id, full_name, phone, email" } = options;

  const unique = new Set<string>();
  for (const id of ids) {
    if (typeof id === "string" && id.length > 0) unique.add(id);
  }
  const result = new Map<string, ProfileLite>();
  if (unique.size === 0) return result;

  const list = [...unique];
  const chunks: string[][] = [];
  for (let i = 0; i < list.length; i += chunkSize) chunks.push(list.slice(i, i + chunkSize));

  // Bounded concurrency worker pool.
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, chunks.length) }, async () => {
    while (cursor < chunks.length) {
      const idx = cursor++;
      const { data, error } = await (supabase.from("profiles") as any)
        .select(columns)
        .in("id", chunks[idx]);
      if (error) throw error;
      for (const row of (data ?? []) as ProfileLite[]) {
        result.set(row.id, row);
      }
    }
  });
  await Promise.all(workers);
  return result;
}

/** Build a Map<id, ProfileLite> from an already-fetched array. */
export function buildProfileMap(profiles: ProfileLite[]): Map<string, ProfileLite> {
  return new Map(profiles.map((p) => [p.id, p]));
}

export interface EnrichmentMaps {
  agentMap: Map<string, ProfileLite>;
  tenantMap: Map<string, ProfileLite>;
}

/**
 * Fetch agent + tenant profiles for a batch of listings in one pass.
 * Agents and tenants are combined into a single deduplicated fetch so
 * one user id that appears as both roles is fetched once.
 */
export async function fetchListingProfileMaps<
  L extends { agent_id: string | null; tenant_id: string | null },
>(listings: L[]): Promise<EnrichmentMaps> {
  const all: (string | null)[] = [];
  for (const l of listings) {
    all.push(l.agent_id);
    all.push(l.tenant_id);
  }
  const combined = await fetchProfilesByIds(all);
  // Same map serves both roles — an id is either an agent, tenant, or both.
  return { agentMap: combined, tenantMap: combined };
}

/**
 * Attach agent + tenant profile fields to raw house_listings rows.
 * Missing profiles resolve to null (never throws for missing rows).
 */
export function enrichListingsWithProfiles<
  L extends { agent_id: string | null; tenant_id: string | null },
>(listings: L[], maps: EnrichmentMaps): Array<
  L & {
    agent_name: string | null;
    agent_phone: string | null;
    agent_email: string | null;
    tenant_name: string | null;
    tenant_phone: string | null;
  }
> {
  return listings.map((d) => {
    const a = d.agent_id ? maps.agentMap.get(d.agent_id) : undefined;
    const t = d.tenant_id ? maps.tenantMap.get(d.tenant_id) : undefined;
    return {
      ...d,
      agent_name: a?.full_name ?? null,
      agent_phone: a?.phone ?? null,
      agent_email: a?.email ?? null,
      tenant_name: t?.full_name ?? null,
      tenant_phone: t?.phone ?? null,
    };
  });
}
