-- Recreate with security_invoker so it enforces the querying user's RLS,
-- not the creator's. Resolves the Security Definer View linter error.
DROP VIEW IF EXISTS public.agent_misrouted_deposits_preview;

CREATE VIEW public.agent_misrouted_deposits_preview
WITH (security_invoker = true) AS
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
       OR dr.deposit_purpose IN ('personal_deposit', 'other'));

REVOKE ALL ON public.agent_misrouted_deposits_preview FROM PUBLIC;
GRANT SELECT ON public.agent_misrouted_deposits_preview TO authenticated;