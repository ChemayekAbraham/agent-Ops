// Provider-level payout routing shared by the merchant dispatch engine.
//
// A merchant agent is only eligible for a withdrawal when BOTH the parent
// payment channel (momo / bank / cash) AND the specific provider (MTN, Airtel,
// or the exact bank) are enabled on their `cashout_agents.config` matrix.
// Mirrors src/lib/cashoutAgentConfig.ts.

/** Canonical bank ids + name patterns. Mirrors src/lib/cashoutAgentConfig.ts. */
export const SUPPORTED_BANK_PATTERNS: Record<string, string[]> = {
  absa: ["absa"],
  bank_of_africa: ["bank of africa", "boa uganda"],
  baroda: ["baroda"],
  bank_of_india: ["bank of india"],
  cairo: ["cairo"],
  centenary: ["centenary", "centinary"],
  citibank: ["citibank", "citi bank"],
  dfcu: ["dfcu"],
  dtb: ["diamond trust", "dtb"],
  ecobank: ["ecobank", "eco bank"],
  equity: ["equity"],
  exim: ["exim"],
  housing_finance: ["housing finance", "housingfinance"],
  im_bank: ["i m bank", "i and m bank", "im bank"],
  kcb: ["kcb", "kenya commercial bank"],
  ncba: ["ncba", "nc bank"],
  pearl: ["pearl"],
  salaam: ["salaam"],
  stanbic: ["stanbic"],
  stanchart: ["standard chartered", "stanchart", "scb"],
  tropical: ["tropical"],
  uba: ["united bank for africa", "uba"],
  postbank: ["postbank", "post bank"],
};

export const SUPPORTED_BANK_IDS = Object.keys(SUPPORTED_BANK_PATTERNS);

export function normalizeBankId(raw: unknown): string | null {
  const s = String(raw ?? "").toLowerCase().replace(/[^a-z]+/g, " ").trim();
  if (!s) return null;
  for (const [id, pats] of Object.entries(SUPPORTED_BANK_PATTERNS)) {
    if (pats.some((p) => s.includes(p))) return id;
  }
  return null;
}

export interface PayoutRoute {
  channel: "momo" | "bank" | "cash";
  provider: string | null;
}

export function getWithdrawalPayoutRoute(w: any): PayoutRoute {
  const method = String(w?.payout_method ?? "").toLowerCase();
  if (method.includes("bank")) {
    return { channel: "bank", provider: normalizeBankId(w?.bank_name) };
  }
  if (method.includes("cash") || method.includes("pickup")) {
    return { channel: "cash", provider: null };
  }
  const prov = String(w?.mobile_money_provider ?? "").toLowerCase();
  return {
    channel: "momo",
    provider: prov.includes("mtn") ? "mtn" : prov.includes("airtel") ? "airtel" : null,
  };
}

/**
 * True when this merchant's config permits the withdrawal's channel AND its
 * exact provider/bank. Merchants with no config saved (legacy) fall back to the
 * legacy boolean columns; unknown providers fall back to the channel flag so
 * payouts are never stranded.
 */
export function merchantHandlesPayout(agentRow: any, withdrawal: any): boolean {
  const cfg = (agentRow?.config ?? null) as Record<string, any> | null;
  const { channel, provider } = getWithdrawalPayoutRoute(withdrawal);

  const hasMatrix = !!cfg && typeof cfg === "object" && !!cfg.channels;
  if (!hasMatrix) {
    // Legacy merchants: only the boolean columns are available.
    if (channel === "cash") return agentRow?.handles_cash !== false;
    if (channel === "bank") return agentRow?.handles_bank !== false;
    if (provider === "mtn") return agentRow?.handles_mtn !== false;
    if (provider === "airtel") return agentRow?.handles_airtel !== false;
    return agentRow?.handles_mtn !== false || agentRow?.handles_airtel !== false;
  }

  const channels = (cfg!.channels ?? {}) as Record<string, boolean>;
  if (channels[channel] !== true) return false;
  if (!provider) return true;

  if (channel === "momo") {
    const networks = (cfg!.networks ?? {}) as Record<string, boolean>;
    return networks[provider] === true;
  }
  if (channel === "bank") {
    const banks = (cfg!.banks ?? {}) as Record<string, boolean>;
    return banks[provider] === true;
  }
  return true;
}