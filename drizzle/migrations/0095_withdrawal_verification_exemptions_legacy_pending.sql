-- One-time, per-withdrawal grandfather exemption for the payout-destination /
-- National-ID verification gate. Does NOT mark any payout destination verified,
-- and does NOT create user-wide or destination-wide bypasses.

CREATE TABLE IF NOT EXISTS public.withdrawal_verification_exemptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  withdrawal_id uuid NOT NULL UNIQUE REFERENCES public.withdrawal_requests(id) ON DELETE CASCADE,
  exemption_type text NOT NULL DEFAULT 'legacy_pending_cutoff',
  reason text NOT NULL,
  active boolean NOT NULL DEFAULT true,
  cutoff_at timestamptz NOT NULL DEFAULT now(),
  snapshot_status text,
  snapshot_payout_method text,
  snapshot_user_id uuid,
  snapshot_amount numeric,
  snapshot_momo_number text,
  snapshot_bank_name text,
  snapshot_bank_account_number text,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_wve_withdrawal_active
  ON public.withdrawal_verification_exemptions (withdrawal_id) WHERE active;

GRANT SELECT ON public.withdrawal_verification_exemptions TO authenticated;
GRANT ALL ON public.withdrawal_verification_exemptions TO service_role;

ALTER TABLE public.withdrawal_verification_exemptions ENABLE ROW LEVEL SECURITY;

-- Read-only for staff and active merchant desks; no client write policy at all,
-- so the list cannot be extended from the app.
DROP POLICY IF EXISTS wve_read ON public.withdrawal_verification_exemptions;
CREATE POLICY wve_read ON public.withdrawal_verification_exemptions
  FOR SELECT TO authenticated
  USING (
    public.is_withdrawal_staff(auth.uid())
    OR public.is_active_cashout_agent(auth.uid())
    OR EXISTS (
      SELECT 1 FROM public.withdrawal_requests w
      WHERE w.id = withdrawal_verification_exemptions.withdrawal_id
        AND w.user_id = auth.uid()
    )
  );

-- Exact-ID lookup used by the payout gates.
CREATE OR REPLACE FUNCTION public.withdrawal_verification_exempt(p_withdrawal_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.withdrawal_verification_exemptions e
    WHERE e.withdrawal_id = p_withdrawal_id
      AND e.active
  )
$$;

REVOKE ALL ON FUNCTION public.withdrawal_verification_exempt(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.withdrawal_verification_exempt(uuid) TO authenticated, service_role;

-- Snapshot: ONLY the rows that are pending at this exact moment.
INSERT INTO public.withdrawal_verification_exemptions (
  withdrawal_id, exemption_type, reason, cutoff_at,
  snapshot_status, snapshot_payout_method, snapshot_user_id, snapshot_amount,
  snapshot_momo_number, snapshot_bank_name, snapshot_bank_account_number
)
SELECT w.id, 'legacy_pending_cutoff',
       'Legacy pending payout queue grandfathered at cutoff: payout-destination / National-ID verification waived for these existing requests only. All later withdrawals remain fully gated.',
       now(),
       w.status, w.payout_method, w.user_id, w.amount,
       w.mobile_money_number, w.bank_name, w.bank_account_number
FROM public.withdrawal_requests w
WHERE w.status = 'pending'
ON CONFLICT (withdrawal_id) DO NOTHING;

-- Audit the snapshot itself.
INSERT INTO public.audit_logs (action_type, table_name, record_id, reason, metadata)
SELECT 'withdrawal_verification_grandfather_snapshot',
       'withdrawal_verification_exemptions',
       gen_random_uuid(),
       'One-time grandfather of the already-pending payout queue; destination verification remains mandatory for every withdrawal created after this cutoff.',
       jsonb_build_object(
         'exempted_count', (SELECT count(*) FROM public.withdrawal_verification_exemptions WHERE exemption_type = 'legacy_pending_cutoff'),
         'cutoff_at', now()
       );