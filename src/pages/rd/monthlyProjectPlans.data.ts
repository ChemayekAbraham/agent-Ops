export type MonthlyProjectPlan = {
  projectId: string;
  projectName: string;
  month: string;
  budget: number;
  targets: string;
  updatedAt: string;
};

export const monthlyPlansKey = (userId: string) => `rd-monthly-project-plans-v1:${userId}`;

export function readMonthlyPlans(value: string | null): MonthlyProjectPlan[] {
  try {
    const parsed: unknown = JSON.parse(value ?? '[]');
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((p): p is MonthlyProjectPlan =>
      p !== null && typeof p === 'object' && typeof p.projectId === 'string' &&
      typeof p.projectName === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(p.month) &&
      Number.isSafeInteger(p.budget) && p.budget >= 0 && typeof p.targets === 'string' &&
      typeof p.updatedAt === 'string');
  } catch { return []; }
}

export function saveMonthlyPlan(plans: MonthlyProjectPlan[], plan: MonthlyProjectPlan): MonthlyProjectPlan[] {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(plan.month) || !Number.isSafeInteger(plan.budget) || plan.budget < 0) {
    throw new Error('Enter a valid month and a whole UGX budget of zero or more.');
  }
  return [...plans.filter((p) => p.month !== plan.month || p.projectId !== plan.projectId), plan];
}