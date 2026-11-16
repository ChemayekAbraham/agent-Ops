/**
 * The rent-request intake in 8 steps (approved by the COO), shared by the agent chat
 * (RentRequestAssistant) and the tenant self-apply page (/tenants-onboarding).
 * Pure: no Supabase import. The header (IntakeStepHeader) reads what is here.
 */

export const INTAKE_STEPS = [
  { key: 'tenant', n: 1, name: 'Tenant', short: 'Tenant' },
  { key: 'rent_plan', n: 2, name: 'Rent plan', short: 'Rent plan' },
  { key: 'landlord', n: 3, name: 'Landlord', short: 'Landlord' },
  { key: 'house', n: 4, name: 'House', short: 'House' },
  { key: 'household', n: 5, name: 'Household', short: 'Household' },
  { key: 'tenant_photo', n: 6, name: 'Tenant’s photo', short: 'Photo' },
  { key: 'id', n: 7, name: 'ID', short: 'ID' },
  { key: 'lc1_post', n: 8, name: 'LC1 letter + Post', short: 'LC1 letter' },
] as const;

export type IntakeStepKey = typeof INTAKE_STEPS[number]['key'];
export const INTAKE_STEP_KEYS = INTAKE_STEPS.map((s) => s.key) as IntakeStepKey[];
export const INTAKE_TOTAL = INTAKE_STEPS.length;

/** One line of a step's "What's needed" box. */
export interface IntakeItem { label: string; done: boolean }
/** Every step with its items; a step is done when all its items are. */
export type IntakeState = Record<IntakeStepKey, IntakeItem[]>;

export const intakeStep = (key: IntakeStepKey) => INTAKE_STEPS.find((s) => s.key === key)!;
export const stepDone = (state: IntakeState, key: IntakeStepKey): boolean => (state[key] ?? []).every((i) => i.done);
export const incompleteSteps = (state: IntakeState): IntakeStepKey[] => INTAKE_STEP_KEYS.filter((k) => !stepDone(state, k));
export const firstIncompleteStep = (state: IntakeState): IntakeStepKey | null => incompleteSteps(state)[0] ?? null;

/**
 * The counter on top of every step: "Step 3 of 8 · 5 left" (steps not yet complete), or on a
 * resubmit "2 to fix" (returned items not yet redone).
 */
export function intakeCounter(state: IntakeState, current: IntakeStepKey, toFix?: number | null): string {
  if (typeof toFix === 'number') return toFix === 0 ? 'All fixed' : `${toFix} to fix`;
  return `Step ${intakeStep(current).n} of ${INTAKE_TOTAL} · ${incompleteSteps(state).length} left`;
}

/** What replaces Post while steps are incomplete: "2 left: House, ID". null when all are done. */
export function intakeLeftLabel(state: IntakeState): string | null {
  const left = incompleteSteps(state);
  if (!left.length) return null;
  return `${left.length} left: ${left.map((k) => intakeStep(k).short).join(', ')}`;
}
