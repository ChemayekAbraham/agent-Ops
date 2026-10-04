-- Read-only preview view for historical agent deposits that may have been
-- misrouted to the personal wallet (purpose = 'personal_deposit' / 'other' / NULL)
-- when the depositor actually has the 'agent' role. Manager reviews this list,
-- then a follow-up runs create_ledger_transaction sweeps for confirmed rows.
CREATE OR REPLACE VIEW public.agent_misrouted_deposits_preview AS
SELECT
  dr.id              AS deposit_id,
  dr.user_id         AS agent_id,
  p.full_name        AS agent_name,
  dr.amount,
  dr.provider,
  dr.transaction_id,
  dr.deposit_purpose AS original_purpose,
  dr.transaction_date,
  dr.approved_at,
  CASE
    WHEN EXISTS (
      SELECT 1 FROM public.agent_float_funding aff
      WHERE aff.agent_id = dr.user_id
        AND aff.bank_reference = dr.transaction_id
    ) THEN 'already_in_float'
    ELSE 'in_personal_wallet'
  END AS current_location,
  'operational_float' AS suggested_target
FROM public.deposit_requests dr
JOIN public.user_roles ur ON ur.user_id = dr.user_id AND ur.role = 'agent'
LEFT JOIN public.profiles p ON p.id = dr.user_id
WHERE dr.status = 'approved'
  AND (dr.deposit_purpose IS NULL
       OR dr.deposit_purpose IN ('personal_deposit', 'other'))
ORDER BY dr.transaction_date DESC NULLS LAST;

COMMENT ON VIEW public.agent_misrouted_deposits_preview IS
  'Preview of historical agent deposits potentially misrouted to personal wallet. Read-only — managers review here before any sweeps are applied.';

-- Restrict to staff (managers / CFO / COO) since it exposes amounts across agents.
REVOKE ALL ON public.agent_misrouted_deposits_preview FROM PUBLIC;
GRANT SELECT ON public.agent_misrouted_deposits_preview TO authenticated;