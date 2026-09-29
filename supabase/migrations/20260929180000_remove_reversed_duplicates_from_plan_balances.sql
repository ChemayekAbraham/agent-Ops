-- Take reversed float-gate duplicate collections back out of rent_requests.amount_repaid.
--
-- WHAT. During the 15–16 Sep float-gate incident, duplicate re-taps that posted
-- after the 2026-09-16 06:03 guard fix (and a smaller set on 10 and 14 Sep) DID
-- raise rent_requests.amount_repaid: each one has a rent_amount_change_log row
-- whose amount_repaid delta equals the collection amount within 5 seconds of
-- it. The incident remediation reversed them in agent_collections and contra'd
-- them in general_ledger, but on 31 plans never took them back off the plan
-- balance — so those tenants read as having paid ~UGX 7.4M they did not pay,
-- and 17 plans read "completed" only because of it.
-- docs/HANDOVER/161; incident: docs/2026-09-15-float-gate-collection-incident.md.
--
-- HOW MUCH. Per plan: the reversed collections that provably landed, minus
-- every amount_repaid DECREASE logged after the first reversal (counting any
-- decrease as a take-back makes this the conservative figure).
--
-- WHAT THIS DOES NOT DO. No ledger posting: the ledger already carries the
-- contra. Only the operational balance is corrected, the same shape as
-- 20260916200000. Plans reopened completed → repaying (checked: no trigger
-- moves money or messages anyone on that transition; the repaying gate returns
-- early when OLD.status is 'completed').
--
-- Decision: Josh Wanda, 2026-09-29 ("Correct all 31").

BEGIN;

CREATE TABLE IF NOT EXISTS public.plan_balance_duplicate_correction_20260929 (
  rent_request_id      uuid PRIMARY KEY,
  tenant_id            uuid,
  status_before        text,
  total_repayment      numeric,
  amount_repaid_before numeric,
  duplicates_landed    numeric,
  duplicate_count      int,
  later_decreases      numeric,
  correction           numeric,
  amount_repaid_after  numeric,
  status_after         text,
  corrected_at         timestamptz DEFAULT now()
);
ALTER TABLE public.plan_balance_duplicate_correction_20260929 ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.plan_balance_duplicate_correction_20260929 FROM PUBLIC, anon, authenticated;
COMMENT ON TABLE public.plan_balance_duplicate_correction_20260929 IS
'Evidence + before/after for the 2026-09-29 removal of reversed float-gate duplicates from rent_requests.amount_repaid (docs/HANDOVER/161). Read-only record.';

WITH rc AS (
  SELECT c.id, c.rent_request_id, c.amount, c.created_at, c.reversed_at
    FROM public.agent_collections c
   WHERE c.reversed_at IS NOT NULL AND c.rent_request_id IS NOT NULL AND c.amount > 0
     AND c.created_at >= '2026-09-01' AND c.created_at < '2026-09-17'
),
lg AS (
  SELECT l.rent_request_id, l.changed_at,
         COALESCE(l.new_amount_repaid,0) - COALESCE(l.old_amount_repaid,0) AS delta
    FROM public.rent_amount_change_log l
   WHERE l.changed_at >= '2026-09-01' AND 'amount_repaid' = ANY (l.changed_fields)
     AND l.rent_request_id IN (SELECT rent_request_id FROM rc)
),
landed AS (
  SELECT rc.* FROM rc
   WHERE EXISTS (SELECT 1 FROM lg
                  WHERE lg.rent_request_id = rc.rent_request_id AND lg.delta = rc.amount
                    AND lg.changed_at BETWEEN rc.created_at - interval '5 seconds'
                                          AND rc.created_at + interval '5 seconds')
),
per AS (
  SELECT rent_request_id, sum(amount) AS landed_amt, count(*) AS n, min(reversed_at) AS first_rev
    FROM landed GROUP BY 1
),
dec AS (
  SELECT per.rent_request_id,
         COALESCE(sum(-lg.delta) FILTER (WHERE lg.delta < 0
                  AND lg.changed_at >= per.first_rev - interval '1 minute'), 0) AS sys_dec
    FROM per LEFT JOIN lg ON lg.rent_request_id = per.rent_request_id GROUP BY 1
),
fix AS (
  SELECT rr.id, rr.tenant_id, rr.status, rr.total_repayment, rr.amount_repaid,
         per.landed_amt, per.n, dec.sys_dec,
         LEAST(per.landed_amt - dec.sys_dec, COALESCE(rr.amount_repaid,0)) AS correction
    FROM per JOIN dec USING (rent_request_id)
    JOIN public.rent_requests rr ON rr.id = per.rent_request_id
   WHERE per.landed_amt > dec.sys_dec
)
INSERT INTO public.plan_balance_duplicate_correction_20260929
  (rent_request_id, tenant_id, status_before, total_repayment, amount_repaid_before,
   duplicates_landed, duplicate_count, later_decreases, correction, amount_repaid_after, status_after)
SELECT id, tenant_id, status, total_repayment, amount_repaid, landed_amt, n, sys_dec, correction,
       amount_repaid - correction,
       CASE WHEN status = 'completed' AND amount_repaid - correction < COALESCE(total_repayment,0)
            THEN 'repaying' ELSE status END
  FROM fix
ON CONFLICT (rent_request_id) DO NOTHING;

UPDATE public.rent_requests rr
   SET amount_repaid = rr.amount_repaid - f.correction,
       status        = f.status_after
  FROM public.plan_balance_duplicate_correction_20260929 f
 WHERE f.rent_request_id = rr.id
   AND rr.amount_repaid = f.amount_repaid_before;  -- skip a plan that moved since the snapshot

INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, reason, metadata)
SELECT 'cb798acb-68bc-4b4e-a414-a3d374e030b6', 'plan_balance_duplicate_correction', 'rent_requests',
       f.rent_request_id::text, 'Reversed float-gate duplicates removed from amount_repaid (doc 161)',
       jsonb_build_object('before', f.amount_repaid_before, 'after', f.amount_repaid_after,
                          'correction', f.correction, 'status_before', f.status_before,
                          'status_after', f.status_after)
  FROM public.plan_balance_duplicate_correction_20260929 f;

COMMIT;
