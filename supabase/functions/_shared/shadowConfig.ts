/**
 * Shadow Config — Phase 5
 * 
 * Reads shadow_config table with 60-second in-memory cache.
 * Falls back to disabled on any error.
 */

interface ShadowConfig {
  enabled: boolean;
  samplePercentage: number;
}

const DISABLED: ShadowConfig = { enabled: false, samplePercentage: 0 };

let cachedConfig: ShadowConfig | null = null;
let cacheExpiry = 0;
const CACHE_TTL_MS = 60_000; // 60 seconds

export async function fetchShadowConfig(
  adminClient: { from: (table: string) => any }
): Promise<ShadowConfig> {
  const now = Date.now();
  if (cachedConfig && now < cacheExpiry) {
    return cachedConfig;
  }

  try {
    const { data, error } = await adminClient
      .from("shadow_config")
      .select("enabled, sample_percentage")
      .limit(1)
      .single();

    if (error || !data) {
      cachedConfig = DISABLED;
    } else {
      cachedConfig = {
        enabled: !!data.enabled,
        samplePercentage: typeof data.sample_percentage === "number" ? data.sample_percentage : 0,
      };
    }
  } catch {
    cachedConfig = DISABLED;
  }

  cacheExpiry = now + CACHE_TTL_MS;
  return cachedConfig!;
}

export function shouldSample(config: ShadowConfig): boolean {
  return config.enabled && config.samplePercentage > 0 && Math.random() * 100 < config.samplePercentage;
}
