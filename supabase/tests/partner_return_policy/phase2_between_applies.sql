-- Run by run_phase2_tests.sh between the first and the second Phase 2 apply. LOCAL THROWAWAY CLUSTER ONLY.
-- It sets up what the second apply must handle, and phase2_test.sql (section M) checks the result:
--   * a rent request whose supporter changed while the reward-rate stamp trigger was missing (as between a
--     Phase 2 rollback and its re-apply): the re-applied backfill must decide it again for the new supporter;
--   * a stored reward rate of an unchanged supporter (marked 17 here): the re-applied backfill must not touch it;
--   * a funding with no stored rate made just now (no cut-off yet): stored as legacy 15 at its funded_at;
--   * the OIDs of the three Phase 2 triggers: CREATE OR REPLACE TRIGGER keeps them (no DROP + CREATE).
SET client_min_messages = warning;
CREATE TABLE IF NOT EXISTS public._t_between (k text PRIMARY KEY, v text);
INSERT INTO public._t_between (k, v)
SELECT 'trg:' || t.tgname, t.oid::text FROM pg_trigger t
 WHERE t.tgname IN ('trg_zz_partner_note_linked_late', 'trg_zz_stamp_rent_reward_rate_ins', 'trg_zz_stamp_rent_reward_rate_upd')
ON CONFLICT (k) DO UPDATE SET v = EXCLUDED.v;

ALTER TABLE public.rent_requests DISABLE TRIGGER trg_zz_stamp_rent_reward_rate_upd;
UPDATE public.rent_requests SET supporter_id = public.pid('moved_to') WHERE id = public.pid('rr_moved');
ALTER TABLE public.rent_requests ENABLE TRIGGER trg_zz_stamp_rent_reward_rate_upd;
UPDATE public.rent_facilitation_reward_rates SET rate = 17 WHERE rent_request_id = public.pid('rr_same');
-- A funding made just now whose stored rate is missing (inserted with the stamp trigger off). With no cut-off yet the
-- re-applied backfill must store it as legacy 15 at its funded_at (round 3: only rows funded after a cut-off use the rule).
ALTER TABLE public.rent_requests DISABLE TRIGGER trg_zz_stamp_rent_reward_rate_ins;
INSERT INTO public.rent_requests (id, tenant_id, landlord_id, rent_amount, status, supporter_id, funded_at)
VALUES (public.pid('rr_nocut'), gen_random_uuid(), gen_random_uuid(), 250000, 'funded', public.pid('nocut_sup'), now());
ALTER TABLE public.rent_requests ENABLE TRIGGER trg_zz_stamp_rent_reward_rate_ins;

INSERT INTO public._t_between (k, v)
SELECT 'rr_moved_before', r.supporter_id::text || '|' || trim_scale(r.rate) || '|' || r.basis
  FROM public.rent_facilitation_reward_rates r WHERE r.rent_request_id = public.pid('rr_moved')
ON CONFLICT (k) DO UPDATE SET v = EXCLUDED.v;
SELECT 'between applies: set up';
