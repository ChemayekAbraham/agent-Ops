-- Tenant Ops Workspace — tops_calling_gap_summary(). Found during the
-- 2026-09-28 acceptance audit: CallingSection.tsx summed
-- tops_calling_gap()'s already-fetched rows in the browser
-- (`gap.data.reduce((sum, g) => sum + g.arrears_amount, 0)`) to show the
-- "Not in this round" total — client-side money arithmetic, against the
-- standing rule that every figure comes from a tops_ RPC. Same shape and
-- same basis-string convention as tops_never_billed_summary(): a standalone
-- count + total so the header line doesn't need to fetch/reduce the full
-- row list itself.
CREATE OR REPLACE FUNCTION public.tops_calling_gap_summary()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_count integer;
  v_total numeric;
BEGIN
  IF NOT (
    public.has_role(auth.uid(), 'tenant_ops'::app_role)
    OR public.has_role(auth.uid(), 'operations'::app_role)
    OR public.has_role(auth.uid(), 'coo'::app_role)
    OR public.has_role(auth.uid(), 'cfo'::app_role)
    OR public.has_role(auth.uid(), 'ceo'::app_role)
    OR public.has_role(auth.uid(), 'super_admin'::app_role)
  ) THEN
    RAISE EXCEPTION 'not authorized';
  END IF;

  SELECT count(*), COALESCE(SUM(g.arrears_amount), 0)
  INTO v_count, v_total
  FROM public.tops_calling_gap() g;

  RETURN jsonb_build_object(
    'tenant_count', v_count,
    'total_arrears_ugx', v_total,
    'basis', 'kampala;reversals_excluded;not_in_open_round'
  );
END;
$$;

REVOKE ALL ON FUNCTION public.tops_calling_gap_summary() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.tops_calling_gap_summary() TO authenticated;

COMMENT ON FUNCTION public.tops_calling_gap_summary() IS
'Standalone {tenant_count, total_arrears_ugx, basis} for the "Not in this round" panel, computed server-side from tops_calling_gap() so the frontend never sums money itself. Added 2026-09-28 after the acceptance audit found CallingSection.tsx doing this sum in the browser. Gated by an internal has_role check.';
