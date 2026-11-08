import { beforeEach, describe, expect, it, vi } from 'vitest';

// The tool module only needs defineTool to hand back its config.
vi.mock('@lovable.dev/mcp-js', () => ({ defineTool: (cfg: unknown) => cfg }));
vi.mock('../rateLimit', () => ({ enforceRateLimit: async () => null, limiterClient: () => undefined }));
const rate = vi.hoisted(() => ({ value: 15 as number | null }));
vi.mock('../partnerRate', () => ({ newPartnerReturnRate: async () => rate.value }));

import tool from '../tools/estimate-supporter-returns';

type Handler = (args: { amount: number; duration_months?: number }) => Promise<unknown>;
const run = (args: { amount: number; duration_months?: number }) =>
  (tool as unknown as { handler: Handler }).handler(args);

function payload(result: unknown): Record<string, any> {
  // publicToolResult wraps the envelope as MCP text content.
  const r = result as { structuredContent?: unknown; content?: Array<{ text?: string }> };
  if (r.structuredContent) return r.structuredContent as Record<string, any>;
  return JSON.parse(r.content?.[0]?.text ?? '{}');
}

describe('estimate_supporter_returns follows the partner Returns policy', () => {
  beforeEach(() => { rate.value = 15; });

  it('quotes 15% while the switch is off', async () => {
    const out = payload(await run({ amount: 1_000_000, duration_months: 1 }));
    expect(out.data.monthly_reward_rate_pct).toBe(15);
    expect(out.data.projections[0].monthly_reward).toBe(150_000);
    expect(JSON.stringify(out)).toContain('target 15% a month');
  });

  it('quotes 10% once the switch is on, with no 15% left anywhere in the answer', async () => {
    rate.value = 10;
    const out = payload(await run({ amount: 1_000_000, duration_months: 1 }));
    expect(out.data.monthly_reward_rate_pct).toBe(10);
    expect(out.data.projections[0].monthly_reward).toBe(100_000);
    expect(JSON.stringify(out)).not.toContain('15%');
  });

  it('states no figure when the live rate cannot be read (no fallback rate)', async () => {
    rate.value = null;
    const out = payload(await run({ amount: 1_000_000, duration_months: 12 }));
    expect(out.data.monthly_reward_rate_pct).toBeNull();
    expect(out.data.projections).toEqual([]);
    expect(out.estimates.ranges).toEqual([]);
    expect(out.summary).toContain('not available right now');
    expect(JSON.stringify(out)).not.toMatch(/\d+(\.\d+)?%(?![0-9A-Fa-f]{2})/);
  });

  it('never claims a guarantee', async () => {
    const text = JSON.stringify(payload(await run({ amount: 500_000 })));
    expect(text).toMatch(/not guaranteed/);
    expect(text).not.toMatch(/\bguaranteed returns\b|\binterest\b/i);
  });
});
