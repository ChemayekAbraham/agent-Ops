-- Puts the float board back to counting an own-money claim only when the agent's float was zero or below at the payout time.

DO $migration$
DECLARE
  v_def text;
  v_new text;
  r record;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
    FROM pg_proc p WHERE p.proname = 'get_merchant_float_positions' AND p.pronamespace = 'public'::regnamespace;
  IF v_def IS NULL THEN RAISE EXCEPTION 'get_merchant_float_positions not found. Nothing was changed.'; END IF;

  v_new := v_def;
  FOR r IN SELECT * FROM (VALUES
    ('NULL::numeric AS shortfall_amount,' || E'\n' || '             false AS attested' || E'\n' || '      FROM public.general_ledger g',
     'NULL::numeric AS shortfall_amount' || E'\n' || '      FROM public.general_ledger g'),
    ('o.shortfall_amount,' || E'\n' || '             COALESCE(o.evidence ->> ''finance_attested'', '''') = ''true''' || E'\n' || '      FROM public.merchant_out_of_pocket_advances o' || E'\n' || '      JOIN desks d2',
     'o.shortfall_amount' || E'\n' || '      FROM public.merchant_out_of_pocket_advances o' || E'\n' || '      JOIN desks d2'),
    ('e.shortfall_amount,' || E'\n' || '           e.attested,' || E'\n' || '           SUM(e.delta) OVER (',
     'e.shortfall_amount,' || E'\n' || '           SUM(e.delta) OVER ('),
    ('AND (COALESCE(w.running, 0) <= 0 OR w.attested) /* doc 229: exact zero still owed; finance-attested claims are owed whatever the books showed */',
     'AND COALESCE(w.running, 0) <= 0 /* doc 229: exact zero still owed */')
  ) AS t(old_text, new_text) LOOP
    IF (length(v_new) - length(replace(v_new, r.old_text, ''))) / length(r.old_text) <> 1 THEN
      RAISE EXCEPTION 'The live get_merchant_float_positions is not the patched one. Nothing was changed.';
    END IF;
    v_new := replace(v_new, r.old_text, r.new_text);
  END LOOP;

  EXECUTE v_new;
END
$migration$;

CREATE OR REPLACE FUNCTION public.get_merchant_oop_evidenced_owed(p_agent_id uuid)
 RETURNS numeric
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT COALESCE(SUM(
           LEAST(o.shortfall_amount,
                 GREATEST(0, -public.merchant_float_position_at(
                   o.agent_id,
                   COALESCE(w.processed_at, w.updated_at, o.created_at))))
         ), 0)
  FROM public.merchant_out_of_pocket_advances o
  LEFT JOIN public.withdrawal_requests w ON w.id = o.withdrawal_id
  WHERE o.agent_id = p_agent_id
    AND o.status = 'pending_reimbursement'
    AND o.reimbursed_at IS NULL
    AND public.merchant_float_position_at(
          o.agent_id, COALESCE(w.processed_at, w.updated_at, o.created_at)) < 0;
$function$;
