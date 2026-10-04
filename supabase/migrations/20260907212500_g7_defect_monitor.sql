-- PHASE 1: G7 detection only (NOT a block).
-- agent_collections posts bridge.rent_receivable_created cash_in => DR A3,
-- increasing the tenant receivable instead of clearing it.
-- A hard database reject was evaluated and REJECTED: the path posts ~168 legs /
-- UGX 3.5m per day, and the corrective code is in an Edge Function that cannot
-- be deployed from this environment, so blocking would halt agent collections.
-- These groups are mapped-BALANCED, so the new DR/CR control correctly does not
-- catch them - this is a semantic defect, not a balance defect.
CREATE OR REPLACE VIEW public.v_g7_receivable_direction_defect AS
SELECT gl.transaction_group_id, gl.id AS leg_id, gl.transaction_date,
       gl.source_table, gl.source_id, gl.amount,
       'DR A3 (increases receivable) - a collection must CREDIT A3'::text AS defect
FROM public.general_ledger gl
WHERE gl.source_table='agent_collections' AND gl.ledger_scope='bridge'
  AND gl.category='rent_receivable_created' AND gl.direction='cash_in'
  AND gl.classification IN ('production','legacy_real');
