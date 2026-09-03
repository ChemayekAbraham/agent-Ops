DROP POLICY IF EXISTS "System insert draw ledger" ON public.credit_draw_ledger;
CREATE POLICY "System insert draw ledger" ON public.credit_draw_ledger FOR INSERT TO authenticated WITH CHECK (false);