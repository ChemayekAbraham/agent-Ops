CREATE TABLE IF NOT EXISTS public.tmp_phase6_diag (
  id bigserial PRIMARY KEY,
  withdrawal_id uuid,
  msg text,
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT ON public.tmp_phase6_diag TO authenticated;
GRANT ALL ON public.tmp_phase6_diag TO service_role;
ALTER TABLE public.tmp_phase6_diag ENABLE ROW LEVEL SECURITY;
CREATE POLICY "admins read phase6 diag" ON public.tmp_phase6_diag FOR SELECT TO authenticated
USING (public.has_role(auth.uid(), 'super_admin'));

DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT w.id FROM public.withdrawal_requests w
    WHERE w.status IN ('paid','completed')
      AND (EXISTS (SELECT 1 FROM public.merchant_float_reservations mr WHERE mr.withdrawal_id=w.id)
        OR EXISTS (SELECT 1 FROM public.cashout_agents ca WHERE ca.is_active AND ca.agent_id IN (w.dispatch_claimed_by,w.processed_by,w.processing_started_by)))
      AND NOT EXISTS (SELECT 1 FROM public.merchant_payout_funding f WHERE f.withdrawal_id=w.id)
    LIMIT 5
  LOOP
    BEGIN
      PERFORM public.classify_merchant_payout_funding(r.id, 'probe');
      INSERT INTO public.tmp_phase6_diag(withdrawal_id, msg) VALUES (r.id, 'ok');
    EXCEPTION WHEN OTHERS THEN
      INSERT INTO public.tmp_phase6_diag(withdrawal_id, msg) VALUES (r.id, SQLSTATE || ' ' || SQLERRM);
    END;
  END LOOP;
END $$;