
CREATE OR REPLACE FUNCTION public.decrement_rent_requested(p_summary_id uuid, p_amount numeric)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE public.opportunity_summaries
  SET total_rent_requested = GREATEST(total_rent_requested - p_amount, 0),
      updated_at = now()
  WHERE id = p_summary_id;
END;
$$;
