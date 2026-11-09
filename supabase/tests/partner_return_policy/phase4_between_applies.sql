-- Phase 4 test load step (LOCAL THROWAWAY CLUSTER ONLY). Run by run_phase4_tests.sh between the first and the second
-- 4a apply: what the first apply wrote (P9: the second apply must write no notice row; L: the requester trigger keeps
-- its OID across CREATE OR REPLACE TRIGGER).
SET client_min_messages = warning;
CREATE TABLE public._t_p4_between AS
  SELECT 'booking:' || id AS k, xmin::text AS v FROM public.promissory_house_booking_notices
  UNION ALL SELECT 'pledge:' || id, xmin::text FROM public.promissory_note_pledge_notices
  UNION ALL SELECT 'progress:' || id, xmin::text FROM public.funder_house_progress_notices
  UNION ALL SELECT 'trigger', oid::text FROM pg_trigger WHERE tgname = 'trg_portfolio_rate_requests_stamp_actor';
SELECT 'between 4a applies ready';
