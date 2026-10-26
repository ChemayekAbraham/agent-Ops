/**
 * Length of a self-support contract in months. The SERVER owns this number
 * (public.psm_contract_term_months(), which every commitment uses); this copy
 * exists only so screens can show a projection over the term. Keep them equal.
 *
 * The rent plan underneath never changes it: a partner earns across the whole
 * contract whether a tenant's plan lasts a week or a month.
 */
export const CONTRACT_TERM_MONTHS = 12;
