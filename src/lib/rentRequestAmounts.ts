export interface RentRequestAmountSource {
  registration_type?: string | null;
  initial_outstanding_balance?: number | null;
  duration_days?: number | null;
  total_repayment?: number | null;
  daily_repayment?: number | null;
}

export function getEffectiveRentRequestAmounts(req: RentRequestAmountSource) {
  const storedTotal = Number(req.total_repayment || 0);
  const storedDaily = Number(req.daily_repayment || 0);

  if (req.registration_type === 'outstanding_balance') {
    const enteredOutstanding = Number(req.initial_outstanding_balance || 0);
    const totalRepayment = enteredOutstanding > 0 ? enteredOutstanding : storedTotal;
    const durationDays = Math.max(Number(req.duration_days || 30), 1);

    return {
      totalRepayment,
      dailyRepayment: totalRepayment > 0 ? Math.ceil(totalRepayment / durationDays) : storedDaily,
    };
  }

  return { totalRepayment: storedTotal, dailyRepayment: storedDaily };
}