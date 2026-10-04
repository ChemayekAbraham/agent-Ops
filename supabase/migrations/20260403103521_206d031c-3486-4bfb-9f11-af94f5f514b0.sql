
CREATE POLICY "Executives can view all ledger entries"
  ON public.general_ledger FOR SELECT
  TO authenticated
  USING (
    public.has_role(auth.uid(), 'cfo'::app_role) OR
    public.has_role(auth.uid(), 'coo'::app_role) OR
    public.has_role(auth.uid(), 'ceo'::app_role)
  );

CREATE POLICY "Executives can view all wallets"
  ON public.wallets FOR SELECT
  TO authenticated
  USING (
    public.has_role(auth.uid(), 'cfo'::app_role) OR
    public.has_role(auth.uid(), 'coo'::app_role) OR
    public.has_role(auth.uid(), 'ceo'::app_role)
  );

CREATE POLICY "Executives can view all rent requests"
  ON public.rent_requests FOR SELECT
  TO authenticated
  USING (
    public.has_role(auth.uid(), 'cfo'::app_role) OR
    public.has_role(auth.uid(), 'coo'::app_role) OR
    public.has_role(auth.uid(), 'ceo'::app_role)
  );
