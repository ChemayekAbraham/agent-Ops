-- Repair: outstanding-balance rent requests stuck at landlord_ops_approved
-- should be 'repaying' (the new trigger short-circuits this transition,
-- but a couple of historical rows pre-date the trigger and are now
-- jammed in the COO queue).
UPDATE public.rent_requests
SET status = 'repaying',
    tenancy_status = COALESCE(tenancy_status, 'active'),
    agent_verified = TRUE,
    agent_verified_at = COALESCE(agent_verified_at, now()),
    agent_verified_by = COALESCE(agent_verified_by, landlord_ops_reviewed_by, agent_id),
    coo_reviewed_by = COALESCE(coo_reviewed_by, landlord_ops_reviewed_by),
    coo_reviewed_at = COALESCE(coo_reviewed_at, now()),
    cfo_reviewed_by = COALESCE(cfo_reviewed_by, landlord_ops_reviewed_by),
    cfo_reviewed_at = COALESCE(cfo_reviewed_at, now()),
    payout_method = COALESCE(payout_method, 'no_disbursement_outstanding'),
    disbursed_at = COALESCE(disbursed_at, now()),
    updated_at = now()
WHERE registration_type = 'outstanding_balance'
  AND status IN ('landlord_ops_approved','coo_approved');