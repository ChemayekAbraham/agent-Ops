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

/** The renewal in 3 steps (E128), with the same header. */
export const RENEWAL_STEP_DEFS = [
  { key: 'plan', n: 1, name: 'Plan', short: 'Plan' },
  { key: 'changes', n: 2, name: 'What changed', short: 'What changed' },
  { key: 'code', n: 3, name: 'Tenant code + Post', short: 'Code + Post' },
] as const;
export type RenewalStepKey = typeof RENEWAL_STEP_DEFS[number]['key'];

/** One step of a header: its key, number and names. */
export interface StepDef { key: string; n: number; name: string; short: string }

export type IntakeStepKey = typeof INTAKE_STEPS[number]['key'];
export const INTAKE_STEP_KEYS = INTAKE_STEPS.map((s) => s.key) as IntakeStepKey[];
export const INTAKE_TOTAL = INTAKE_STEPS.length;

/** One line of a step's "What's needed" box. */
export interface IntakeItem { label: string; done: boolean }
/** Every step with its items; a step is done when all its items are. */
export type IntakeState = Record<IntakeStepKey, IntakeItem[]>;

/** Steps as the header reads them: each key with its items. */
export type StepState = Record<string, IntakeItem[]>;

export const intakeStep = (key: string, steps: readonly StepDef[] = INTAKE_STEPS) => steps.find((s) => s.key === key) ?? steps[0];
export const stepDone = (state: StepState, key: string): boolean => (state[key] ?? []).every((i) => i.done);
export function incompleteSteps<S extends readonly StepDef[] = typeof INTAKE_STEPS>(state: StepState, steps: S = INTAKE_STEPS as unknown as S): S[number]['key'][] {
  return steps.filter((s) => !stepDone(state, s.key)).map((s) => s.key);
}
export function firstIncompleteStep<S extends readonly StepDef[] = typeof INTAKE_STEPS>(state: StepState, steps: S = INTAKE_STEPS as unknown as S): S[number]['key'] | null {
  return incompleteSteps(state, steps)[0] ?? null;
}

/**
 * The counter on top of every step: "Step 3 of 8 · 5 left" (steps not yet complete), or on a
 * resubmit "2 to fix" (returned items not yet redone). A renewal reads "Step 1 of 3 · 3 left".
 */
export function intakeCounter(state: StepState, current: string, toFix?: number | null, steps: readonly StepDef[] = INTAKE_STEPS): string {
  if (typeof toFix === 'number') return toFix === 0 ? 'All fixed' : `${toFix} to fix`;
  return `Step ${intakeStep(current, steps).n} of ${steps.length} · ${incompleteSteps(state, steps).length} left`;
}

/** What replaces Post while steps are incomplete: "2 left: House, ID". null when all are done. */
export function intakeLeftLabel(state: StepState, steps: readonly StepDef[] = INTAKE_STEPS): string | null {
  const left = incompleteSteps(state, steps);
  if (!left.length) return null;
  return `${left.length} left: ${left.map((k) => intakeStep(k, steps).short).join(', ')}`;
}
