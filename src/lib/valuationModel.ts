// Pure valuation math for the CEO valuation model. No side effects.

export interface ScenarioInputs {
  monthlyGrowthPct: number; // compounded monthly revenue growth, %
  multiple: number; // valuation = annual revenue × multiple
  dilutionPct: number; // equity sold per yearly round, %
}

export interface YearRow {
  year: number;
  revenue: number;
  valuation: number; // post-money for the round that year
  raised: number;
  founderStakePct: number; // existing holders' combined stake after the round
  stakeValue: number;
}

export interface ScenarioResult {
  todayPreMoney: number;
  todayRaise: number;
  rows: YearRow[];
}

export const SCENARIO_PRESETS: Record<'conservative' | 'base' | 'high', ScenarioInputs> = {
  conservative: { monthlyGrowthPct: 3, multiple: 8, dilutionPct: 20 },
  base: { monthlyGrowthPct: 8, multiple: 12, dilutionPct: 18 },
  high: { monthlyGrowthPct: 15, multiple: 18, dilutionPct: 15 },
};

/**
 * monthlyRevenue: the latest 30-day revenue.
 * startStakePct: existing holders' stake before new rounds (100 − Angel Pool %).
 */
export function runScenario(
  monthlyRevenue: number,
  inp: ScenarioInputs,
  years = 3,
  startStakePct = 92,
): ScenarioResult {
  const g = inp.monthlyGrowthPct / 100;
  const d = Math.min(Math.max(inp.dilutionPct, 0), 90) / 100;
  const todayPreMoney = monthlyRevenue * 12 * inp.multiple;
  const todayRaise = (todayPreMoney * d) / (1 - d);
  let stake = startStakePct * (1 - d);
  const rows: YearRow[] = [];
  for (let y = 1; y <= years; y++) {
    let revenue = 0;
    for (let m = 1; m <= 12; m++) revenue += monthlyRevenue * Math.pow(1 + g, (y - 1) * 12 + m);
    const preMoney = revenue * inp.multiple;
    const raised = y < years ? (preMoney * d) / (1 - d) : 0;
    const valuation = preMoney + raised;
    if (y < years) stake = stake * (1 - d);
    rows.push({ year: y, revenue, valuation, raised, founderStakePct: stake, stakeValue: (valuation * stake) / 100 });
  }
  return { todayPreMoney, todayRaise, rows };
}
