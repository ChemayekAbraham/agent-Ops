import { V360_MODEL_A_EXAMPLE } from '@/lib/contractEngine360';

/** The 360 partner sentence (owner decision D8; same words as the assistant and system context). */
export const V360_PARTNER_RETURNS_SENTENCE =
  'A 360-day plan sets aside 15% for Partner Rent profit share; each partner earns their own Rent profit share rate (new partners: the current new-partner rate), not guaranteed.';

/** Server figures from v360_plan_summary. The client only labels them. */
export interface V360CaptionSource {
  daily_rate: number | null;
  partner_monthly: number;
  partner_12_months: number;
  remaining_receivable: number;
  missed_days: number;
  vacant_days: number;
  maturity_on: string | null;
  buffer_drawn: number;
  agent_sub?: number | null;
  agent_general?: number | null;
  cover_pool?: number | null;
  proxy_agent?: number | null;
  tithe?: number | null;
  welile?: number | null;
  welile_net?: number | null;
}

function ugx(value: number): string {
  return `UGX ${Math.round(value).toLocaleString('en-US')}`;
}

function asNumber(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function optionalMoney(source: V360CaptionSource, key: keyof V360CaptionSource, label: string) {
  const raw = source[key];
  if (raw == null || raw === '') return null;
  return { label, value: ugx(asNumber(raw)) };
}

export function v360CaptionLines(source: V360CaptionSource): { label: string; value: string }[] {
  const daily = source.daily_rate == null ? null : asNumber(source.daily_rate);
  const lines = [
    { label: 'Daily rate', value: daily == null ? 'not set' : ugx(daily) },
    {
      label: V360_PARTNER_RETURNS_SENTENCE,
      value: `${ugx(asNumber(source.partner_monthly))} a month, ${ugx(asNumber(source.partner_12_months))} over 12 months`,
    },
    optionalMoney(source, 'agent_sub', 'Sub-agent commission (6% of Gross)'),
    optionalMoney(source, 'agent_general', 'General agent commission (2% of Gross)'),
    optionalMoney(source, 'cover_pool', 'Cover Pool this cycle'),
    optionalMoney(source, 'proxy_agent', 'Proxy Agent fee (from cycle 1 Cover Pool)'),
    optionalMoney(source, 'welile', 'Welile 7% of Gross'),
    optionalMoney(source, 'tithe', 'Tithe (10% of Welile 7%)'),
    optionalMoney(source, 'welile_net', 'Welile after tithe'),
    { label: 'Remaining 360-day receivable', value: ugx(asNumber(source.remaining_receivable)) },
    { label: 'Missed days', value: String(Math.round(asNumber(source.missed_days))) },
    { label: 'Vacant days', value: String(Math.round(asNumber(source.vacant_days))) },
    { label: 'Maturity', value: source.maturity_on || 'not set' },
    { label: 'Cover Pool drawn', value: ugx(asNumber(source.buffer_drawn)) },
  ];
  return lines.filter((line): line is { label: string; value: string } => line != null);
}

const ex = V360_MODEL_A_EXAMPLE;
const ugxText = (value: number) => `UGX ${value.toLocaleString('en-US')}`;

export const V360_NEW_QUOTE_EXAMPLE_SENTENCE =
  `Illustrative new 360-day Rent Plan only. Rent ${ugxText(ex.principal)} gives Gross ${ugxText(ex.gross)} and Daily ${ugxText(ex.daily)} (collected ${ugxText(ex.collected)}). Tenant agent commission is 8% of Gross: sub-agent ${ugxText(ex.agentSub)} (6%) and general agent ${ugxText(ex.agentGeneral)} (2%). Cover Pool ${ugxText(ex.coverPool)} (cycle 1: Proxy Agent ${ugxText(ex.proxy)} and pool ${ugxText(ex.coverPoolRetained)}). Welile 7% is ${ugxText(ex.welile)}, of which tithe is ${ugxText(ex.tithe)} and Welile keeps ${ugxText(ex.welileNet)}. ${V360_PARTNER_RETURNS_SENTENCE} Set aside on this example: ${ugxText(ex.partnerMonthly)} a month. Existing Rent Plans keep their approved terms. This example does not turn new-plan pricing on.`;
