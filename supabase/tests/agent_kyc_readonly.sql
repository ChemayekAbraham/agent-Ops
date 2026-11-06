-- Read-only production contract/reconciliation checks. Every passed value must be true.
SELECT p.proname,
 p.provolatile = 's' AND p.prosecdef AND p.proconfig @> ARRAY['search_path=public'] AS stable_scoped,
 NOT has_function_privilege('anon', p.oid, 'EXECUTE') AS anonymous_denied,
 has_function_privilege('authenticated', p.oid, 'EXECUTE') AS signed_in_entry,
 position('is_agent_vetting_reviewer' IN p.prosrc)>0 AND position('staff_mfa_ok() IS NOT TRUE' IN p.prosrc)>0 AS reviewer_mfa_gate
FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
WHERE n.nspname='public' AND p.proname IN ('agent_kyc_overview','agent_kyc_identity_summary','agent_kyc_identity_group');

SELECT public.normalize_national_id_fuzzy('CMO-ILSBZ')=public.normalize_national_id_fuzzy('CM0-11582') AS normalization,
 public.mask_national_id('CM012345678901')='CM0******8901' AS masked,
 public.mask_national_id('ABC123')='******' AS short_masked,
 ('2026-10-28T20:59:59Z'::timestamptz AT TIME ZONE 'Africa/Kampala')::date='2026-10-28'::date AS before_midnight,
 ('2026-10-28T21:00:00Z'::timestamptz AT TIME ZONE 'Africa/Kampala')::date='2026-10-29'::date AS after_midnight;

WITH subjects AS (SELECT agent_id FROM public.agent_vetting ORDER BY agent_id LIMIT 50),
 members AS MATERIALIZED (SELECT * FROM public._agent_kyc_identity_members(ARRAY(SELECT agent_id FROM subjects)))
SELECT NOT EXISTS(SELECT 1 FROM members GROUP BY subject_id,agent_id HAVING count(*)>1) AS no_duplicate_members,
 NOT EXISTS(SELECT 1 FROM members m WHERE NOT EXISTS(SELECT 1 FROM public.agent_vetting v WHERE v.agent_id=m.agent_id)
 AND NOT EXISTS(SELECT 1 FROM public.user_roles r WHERE r.user_id=m.agent_id AND r.role='agent' AND r.enabled)) AS agents_only,
 NOT EXISTS(SELECT 1 FROM members WHERE masked_nin IS NOT NULL AND masked_nin NOT LIKE '%*%') AS masked_only;