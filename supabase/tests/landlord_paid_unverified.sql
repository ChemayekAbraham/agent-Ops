-- Read-only parity regression. Run after the filter migration succeeds.
-- Every row must be unverified and have a recorded, non-reversed payout;
-- pending and rejected rows are included, duplicate payouts count only once.
WITH expected AS (
 SELECT l.id FROM public.landlords l JOIN public.v_landlord_ops_status v ON v.landlord_id=l.id
 WHERE l.verified IS NOT TRUE AND v.status <> 'verified'
 AND EXISTS (
  SELECT 1 FROM public.landlord_payouts p WHERE p.landlord_id=l.id AND p.amount>0
  AND p.status IN ('awaiting_agent_receipt','completed')
  AND COALESCE(p.finops_disbursed_at,p.disbursed_at) IS NOT NULL
  AND NOT (EXISTS (SELECT 1 FROM public.landlord_payout_receipts r WHERE r.payout_id=p.id AND r.reversed_at IS NOT NULL)
   AND NOT EXISTS (SELECT 1 FROM public.landlord_payout_receipts r WHERE r.payout_id=p.id AND r.reversed_at IS NULL))
 )
)
SELECT count(*) = public.ops_landlord_paid_unverified_count(NULL,NULL,NULL) AS count_matches,
 bool_and(public._landlord_has_recorded_payout(id)) AS every_row_has_payout
FROM expected;