CREATE OR REPLACE FUNCTION public._special_advance_term_errors(
  p_principal numeric, p_rate_percent numeric, p_rate_basis text, p_term_days numeric, p_frequency text, p_start_date date)
RETURNS text[] LANGUAGE sql IMMUTABLE SET search_path = public AS $$
  SELECT array_remove(ARRAY[
    CASE WHEN p_principal IS NULL OR p_principal <> trunc(p_principal)
              OR p_principal < 10000 OR p_principal > 1000000000000 THEN 'principal' END,
    CASE WHEN p_rate_percent IS NULL OR p_rate_percent <= 0
              OR p_rate_percent * 100 <> trunc(p_rate_percent * 100) THEN 'rate' END,
    CASE WHEN p_rate_basis IS NULL OR p_rate_basis NOT IN ('daily', 'monthly') THEN 'rate_basis' END,
    CASE WHEN p_term_days IS NULL OR p_term_days <> trunc(p_term_days)
              OR p_term_days < 1 OR p_term_days > 90 THEN 'term' END,
    CASE WHEN p_frequency IS NULL OR p_frequency NOT IN ('daily', 'weekly', 'monthly') THEN 'frequency' END,
    CASE WHEN p_start_date IS NULL THEN 'start_date' END
  ], NULL);
$$;