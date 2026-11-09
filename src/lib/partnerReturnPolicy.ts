// Partner Returns rates for the browser: the same pure functions and parser the edge functions use
// (one copy, design v2 §6.1). The database decides every rate; these only read answers and return
// null when they cannot answer, so screens show no number instead of a guessed 15.
export * from '../../supabase/functions/_shared/partnerReturnPolicy';
