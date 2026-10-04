DROP POLICY IF EXISTS "Public can read maintenance keys only" ON public.treasury_controls;
CREATE POLICY "Public can read maintenance and payout flags"
ON public.treasury_controls
FOR SELECT
TO anon, authenticated
USING (control_key = ANY (ARRAY['maintenance_mode','maintenance_message','maintenance_until','payouts_ui_enabled','withdrawals_paused']));