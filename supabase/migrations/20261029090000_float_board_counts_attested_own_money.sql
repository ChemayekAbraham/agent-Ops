-- The float board now counts finance-attested own-money claims as money we owe the agent.
--
-- THE PROBLEM: get_merchant_float_positions counted an own-money (OOP) claim as "owed to the agent" ONLY when her float position at the time of the payout was
-- zero or below. Immaculate Namulindwa's 28 Oct payouts were made when the books still showed float (the books were wrong: her returns had not been booked), so
-- the board showed her "owed 0" and "company cash with agent 8.8M", which reads as if SHE owes US, while we owe her about 8.9M net. settle_merchant_out_of_pocket
-- (which pays the claim) already accepts a claim that finance has attested, whatever the books showed. The board and the payment disagreed.
--
-- THE FIX: a claim with evidence.finance_attested = true counts as owed on the board too, in full, exactly as the settle function pays it. Claims without that
-- attestation behave exactly as before. Nothing is paid and no ledger row changes; only what the board adds up changes.
--   * get_merchant_float_positions : the "unbacked" total now also includes attested claims. Patched in place from the live definition (four text
--     replacements, each checked to occur exactly once; if the live definition has changed the migration stops and writes nothing).
--   * get_merchant_oop_evidenced_owed : same rule (attested = counted in full).
-- Roll back with 20261029090000_float_board_counts_attested_own_money.rollback.sql.

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
    ('NULL::numeric AS shortfall_amount' || E'\n' || '      FROM public.general_ledger g',
     'NULL::numeric AS shortfall_amount,' || E'\n' || '             false AS attested' || E'\n' || '      FROM public.general_ledger g'),
    ('o.shortfall_amount' || E'\n' || '      FROM public.merchant_out_of_pocket_advances o' || E'\n' || '      JOIN desks d2',
     'o.shortfall_amount,' || E'\n' || '             COALESCE(o.evidence ->> ''finance_attested'', '''') = ''true''' || E'\n' || '      FROM public.merchant_out_of_pocket_advances o' || E'\n' || '      JOIN desks d2'),
    ('e.shortfall_amount,' || E'\n' || '           SUM(e.delta) OVER (',
     'e.shortfall_amount,' || E'\n' || '           e.attested,' || E'\n' || '           SUM(e.delta) OVER ('),
    ('AND COALESCE(w.running, 0) <= 0 /* doc 229: exact zero still owed */',
     'AND (COALESCE(w.running, 0) <= 0 OR w.attested) /* doc 229: exact zero still owed; finance-attested claims are owed whatever the books showed */')
  ) AS t(old_text, new_text) LOOP
    IF (length(v_new) - length(replace(v_new, r.old_text, ''))) / length(r.old_text) <> 1 THEN
      RAISE EXCEPTION 'The live get_merchant_float_positions is not the expected one (a patch point is missing or repeated). Nothing was changed.';
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
           CASE WHEN COALESCE(o.evidence ->> 'finance_attested', '') = 'true'
                THEN o.shortfall_amount
                ELSE LEAST(o.shortfall_amount,
                           GREATEST(0, -public.merchant_float_position_at(
                             o.agent_id,
                             COALESCE(w.processed_at, w.updated_at, o.created_at))))
           END
         ), 0)
  FROM public.merchant_out_of_pocket_advances o
  LEFT JOIN public.withdrawal_requests w ON w.id = o.withdrawal_id
  WHERE o.agent_id = p_agent_id
    AND o.status = 'pending_reimbursement'
    AND o.reimbursed_at IS NULL
    AND (
      COALESCE(o.evidence ->> 'finance_attested', '') = 'true'
      OR public.merchant_float_position_at(
           o.agent_id, COALESCE(w.processed_at, w.updated_at, o.created_at)) < 0
    );
$function$;
