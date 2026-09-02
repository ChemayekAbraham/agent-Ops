import { formatDynamic } from '@/lib/currencyFormat';
import { proxyPvBand, PROXY_PV_BAND_META, type ProxyPvTeamRow } from '@/hooks/useProxyAgentPerformance';

const money = (v: unknown) => formatDynamic(v);

export interface ProxyPvExplanation {
  /** One-line verdict on where the agent stands. */
  headline: string;
  /** What is producing the score, strongest contributor first. */
  drivers: string[];
  /** What is holding the score back. */
  gaps: string[];
  /** Share of PV coming from each action, for the mix bar. */
  mix: { key: 'commitments' | 'investment' | 'topups'; label: string; pv: number; pct: number }[];
  /** Dominant action label, or null when there is no PV yet. */
  leadSource: string | null;
}

/**
 * Turns the server-computed PV components into a plain-language explanation of
 * why an agent sits at their current pace. Pure presentation — every number
 * used here already comes from `partner_ops_proxy_agent_pv`.
 */
export function explainProxyPv(
  row: ProxyPvTeamRow,
  ctx?: { teamAveragePv?: number; monthlyTarget?: number; workingDaysRemaining?: number },
): ProxyPvExplanation {
  const band = proxyPvBand(row.performance_pct);
  const bandLabel = PROXY_PV_BAND_META[band].label;
  const total = row.total_pv;

  const parts = [
    { key: 'commitments' as const, label: 'Verified commitments', pv: row.commitment_pv },
    { key: 'investment' as const, label: 'New partner investment', pv: row.investment_pv },
    { key: 'topups' as const, label: 'Partner top-ups', pv: row.topup_pv },
  ];
  const mix = parts
    .map((p) => ({ ...p, pct: total > 0 ? Math.round((p.pv / total) * 100) : 0 }))
    .sort((a, b) => b.pv - a.pv);
  const leadSource = mix[0] && mix[0].pv > 0 ? mix[0].label : null;

  const gap = row.expected_pv - total;
  const headline =
    total === 0
      ? 'No PV recorded yet this month — nothing has been verified or paid.'
      : gap > 0
        ? `${bandLabel} pace — ${money(gap)} PV behind the ${money(row.expected_pv)} expected by today.`
        : `${bandLabel} pace — ${money(Math.abs(gap))} PV ahead of the ${money(row.expected_pv)} expected by today.`;

  const drivers: string[] = [];
  if (row.commitment_pv > 0) {
    drivers.push(`${row.commitments} verified commitment${row.commitments === 1 ? '' : 's'} → ${money(row.commitment_pv)} PV`);
  }
  if (row.investment_pv > 0) {
    drivers.push(`${money(row.new_investment)} new partner investment at 2% → ${money(row.investment_pv)} PV`);
  }
  if (row.topup_pv > 0) {
    drivers.push(`${money(row.topups)} partner top-ups at 1% → ${money(row.topup_pv)} PV`);
  }
  if (leadSource && mix[0].pct >= 60 && drivers.length > 1) {
    drivers.push(`${mix[0].pct}% of the score comes from ${leadSource.toLowerCase()} alone`);
  }

  const gaps: string[] = [];
  if (row.commitments === 0) gaps.push('No commitment has been verified by Partner Ops this month');
  if (row.new_investment === 0) gaps.push('No new partner investment recorded');
  if (row.topups === 0) gaps.push('No partner top-up recorded');
  if (ctx?.teamAveragePv !== undefined && total < ctx.teamAveragePv) {
    gaps.push(`Below the team average of ${money(Math.round(ctx.teamAveragePv))} PV`);
  }
  if (gap > 0 && ctx?.workingDaysRemaining) {
    const perDay = Math.ceil(gap / ctx.workingDaysRemaining);
    gaps.push(`Needs ${money(perDay)} PV per remaining working day to close the gap`);
  }

  return { headline, drivers, gaps, mix, leadSource };
}
