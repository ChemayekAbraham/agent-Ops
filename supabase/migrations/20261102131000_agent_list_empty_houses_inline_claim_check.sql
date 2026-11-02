-- The partner "Houses to fund" list loaded slowly.
--
-- agent_list_empty_house_opportunities() excluded already-funded houses with
-- `NOT public.house_has_live_claim(h.id)` inside its `base` set, which covers
-- every eligible house in the market (about 6,800), because the total count and
-- the ranking need all of them even though a page shows only a handful. That is
-- one SECURITY DEFINER SQL-function call (three index probes) per house on every
-- request, and Postgres cannot inline the helper.
--
-- Same fix as map_empty_house_cells (20261102130000): the three checks are
-- written inline as NOT EXISTS so the planner runs them as anti-joins. The rule
-- is unchanged: a house is funded when a promissory-note intent is
-- reserved/funded, a partner is self-supporting it (pending/active), or a
-- company-managed allocation is reserved/fulfilled. Output is identical.
-- house_has_live_claim() stays in place for the functions that must check a
-- specific house before money moves.
--
-- Patched from the live definition, so no other part of the function is retyped.
-- CREATE OR REPLACE keeps the existing grants.

DO $patch$
DECLARE
  v_sig constant regprocedure :=
    'public.agent_list_empty_house_opportunities(text,integer,integer,text,boolean,boolean,numeric,numeric,double precision,double precision,double precision,text)'::regprocedure;
  v_anchor constant text := 'AND NOT public.house_has_live_claim(h.id)';
  v_def text := pg_get_functiondef(v_sig);
BEGIN
  IF position(v_anchor IN v_def) = 0 THEN
    RAISE EXCEPTION 'agent_list_empty_house_opportunities: expected claim check not found, nothing patched';
  END IF;

  v_def := replace(
    v_def,
    v_anchor,
    'AND NOT EXISTS (SELECT 1 FROM public.promissory_note_house_intents pni
                       WHERE pni.house_id = h.id AND pni.status IN (''reserved'',''funded''))
      AND NOT EXISTS (SELECT 1 FROM public.partner_supported_houses pshc
                       WHERE pshc.house_id = h.id AND pshc.status IN (''pending'',''active''))
      AND NOT EXISTS (SELECT 1 FROM public.portfolio_allocations pa
                       WHERE pa.house_id = h.id AND pa.status IN (''reserved'',''fulfilled''))'
  );

  EXECUTE v_def;
END
$patch$;
