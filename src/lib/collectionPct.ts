/** Pure helpers for the agent's collection percentage (no Supabase import, safe anywhere). */
export const COLLECTION_RULE_PCT = 50;

const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/**
 * The collection percentage (0–100) from the agent eligibility JSON: `pct` (a whole or
 * one-decimal percentage, as on the ranking board), else collected ÷ due. null when neither
 * is there.
 */
export function parseCollectionPct(raw: unknown): number | null {
  let r: unknown = raw;
  if (typeof r === 'string') { try { r = JSON.parse(r); } catch { return null; } }
  if (Array.isArray(r)) r = r[0];
  if (!r || typeof r !== 'object') return null;
  const o = r as Record<string, unknown>;
  const pct = num(o.pct) ?? num(o.collection_pct) ?? num(o.pct_collected);
  if (pct !== null) return Math.round(pct * 10) / 10;
  const due = num(o.due);
  const collected = num(o.collected);
  if (due && due > 0 && collected !== null) return Math.round((collected / due) * 1000) / 10;
  return null;
}

/** "52.8" or "53": one decimal only when there is one. */
export const formatPct = (p: number): string => (Number.isInteger(p) ? String(p) : p.toFixed(1));
