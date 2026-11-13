-- Special Advances register: the agreements list carries each advance's server-owned position figures.
-- The CFO table shows Outstanding, Date Issued and Period for every advance; Outstanding is decided only by
-- _special_advance_position (the same definition the detail sheet's statement uses) and is attached here so the
-- table needs one read, not one per row. Nothing is recomputed or re-labelled in this file, and the page of
-- rows is chosen before the positions are computed so the read stays as cheap as the page.
-- Read-only: no table, no write, no status change. CREATE OR REPLACE keeps the existing grants
-- (authenticated execute, anon revoked) and the CFO gate inside the function.

CREATE OR REPLACE FUNCTION public.special_advance_list(p_status text DEFAULT NULL, p_limit integer DEFAULT 50, p_offset integer DEFAULT 0)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_limit int := LEAST(GREATEST(COALESCE(p_limit, 50), 1), 200);
  v_offset int := GREATEST(COALESCE(p_offset, 0), 0);
BEGIN
  PERFORM public._special_advance_require_cfo();
  RETURN jsonb_build_object(
    'issuance_enabled', public._special_advance_issuance_enabled(),
    'total_count', (SELECT count(*) FROM public.special_advances a WHERE p_status IS NULL OR a.status = p_status),
    'items', COALESCE((SELECT jsonb_agg(x.j ORDER BY x.created_at DESC, x.reference DESC) FROM (
        SELECT a.created_at, a.reference, to_jsonb(a) || jsonb_build_object(
                 'borrower_name', COALESCE(eb.full_name, NULLIF(btrim(pr.full_name), '')),
                 'paid_out', (pos ->> 'paid_out')::boolean,
                 'outstanding', (pos ->> 'outstanding')::numeric,
                 'outstanding_principal', (pos ->> 'outstanding_principal')::numeric,
                 'outstanding_access_fee', (pos ->> 'outstanding_access_fee')::numeric,
                 'scheduled_outstanding', (pos ->> 'scheduled_outstanding')::numeric) AS j
          FROM (
                 SELECT a2.*
                   FROM public.special_advances a2
                  WHERE p_status IS NULL OR a2.status = p_status
                  ORDER BY a2.created_at DESC, a2.reference DESC
                  LIMIT v_limit OFFSET v_offset
               ) a
          LEFT JOIN public.special_advance_external_borrowers eb ON eb.id = a.external_borrower_id
          LEFT JOIN public.profiles pr ON pr.id = a.borrower_user_id
          CROSS JOIN LATERAL (SELECT public._special_advance_position(a.id) AS pos) p
        ) x), '[]'::jsonb));
END $$;
