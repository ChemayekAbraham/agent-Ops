export interface DailyChargeScheduleRow {
  day: number;
  cumulativeDue: number;
  cashCharged: number;
}

// Preview/reporting only — mirrors public.direct_funding_daily_charge_schedule
// exactly. Does not affect rent_requests.daily_repayment, the actual
// trigger-enforced billing amount used everywhere money moves.
export function directFundingDailyChargeSchedule(total: number, termDays = 30): DailyChargeScheduleRow[] {
  const term = Math.max(1, termDays);
  const rows: DailyChargeScheduleRow[] = [];
  let prevCumulativeRounded = 0;

  for (let day = 1; day <= term; day++) {
    const cumulativeRounded = Math.round((total * day) / term);
    rows.push({
      day,
      cumulativeDue: Math.round(((total * day) / term) * 10000) / 10000,
      cashCharged: cumulativeRounded - prevCumulativeRounded,
    });
    prevCumulativeRounded = cumulativeRounded;
  }

  return rows;
}
