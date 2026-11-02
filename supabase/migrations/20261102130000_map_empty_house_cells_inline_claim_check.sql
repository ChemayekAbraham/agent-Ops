-- The full screen houses map was slow to fill in after every pan or zoom.
--
-- map_empty_house_cells() excluded already-funded houses with
-- `NOT public.house_has_live_claim(h.id)`, one SECURITY DEFINER SQL-function call
-- (three index probes) for every house in the viewport. Postgres cannot inline
-- that helper, so a Kampala-sized view spent most of its roughly 400 ms of server
-- time on function-call overhead; the rest of the query runs in about 30 ms.
--
-- The same three checks are now written inline as NOT EXISTS, so the planner
-- handles them as ordinary anti-joins. The rule is unchanged: a house is funded
-- when a promissory-note intent is reserved/funded, a partner is self-supporting
-- it (pending/active), or a company-managed allocation is reserved/fulfilled.
-- Output is identical. house_has_live_claim() stays in place for the functions
-- that must check a specific house before money moves.
--
-- Patched from the live definition, so no other part of the function is retyped.
-- CREATE OR REPLACE keeps the existing grants.

DO $patch$
DECLARE
  v_sig constant regprocedure :=
    'public.map_empty_house_cells(double precision,double precision,double precision,double precision,integer,text,text,numeric,numeric,integer,integer)'::regprocedure;
  v_anchor constant text := 'AND NOT public.house_has_live_claim(h.id)';
  v_def text := pg_get_functiondef(v_sig);
BEGIN
  IF position(v_anchor IN v_def) = 0 THEN
    RAISE EXCEPTION 'map_empty_house_cells: expected claim check not found, nothing patched';
  END IF;

  v_def := replace(
    v_def,
    v_anchor,
    'AND NOT EXISTS (SELECT 1 FROM public.promissory_note_house_intents pni
                       WHERE pni.house_id = h.id AND pni.status IN (''reserved'',''funded''))
      AND NOT EXISTS (SELECT 1 FROM public.partner_supported_houses psh
                       WHERE psh.house_id = h.id AND psh.status IN (''pending'',''active''))
      AND NOT EXISTS (SELECT 1 FROM public.portfolio_allocations pa
                       WHERE pa.house_id = h.id AND pa.status IN (''reserved'',''fulfilled''))'
  );

  EXECUTE v_def;
END
$patch$;
