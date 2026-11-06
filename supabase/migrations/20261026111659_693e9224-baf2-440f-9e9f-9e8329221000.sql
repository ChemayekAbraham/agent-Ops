CREATE TABLE public.compound_reversal_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  portfolio_id uuid NOT NULL REFERENCES public.investor_portfolios(id),
  partner_id uuid NOT NULL,
  reinvestment_ledger_id uuid NOT NULL,
  reinvested_at timestamptz NOT NULL,
  amount numeric NOT NULL CHECK (amount > 0),
  reason text NOT NULL,
  status text NOT NULL DEFAULT 'pending_cfo' CHECK (status IN ('pending_cfo','approved','rejected')),
  requested_by uuid NOT NULL,
  decided_by uuid,
  decided_at timestamptz,
  decision_note text,
  cycle_date date,
  override_id uuid,
  reversal_group_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX compound_reversal_one_open ON public.compound_reversal_requests(reinvestment_ledger_id)
  WHERE status IN ('pending_cfo','approved');
CREATE INDEX compound_reversal_status_idx ON public.compound_reversal_requests(status, created_at DESC);

GRANT SELECT ON public.compound_reversal_requests TO authenticated;
GRANT ALL ON public.compound_reversal_requests TO service_role;
ALTER TABLE public.compound_reversal_requests ENABLE ROW LEVEL SECURITY;
CREATE POLICY compound_reversal_staff_read ON public.compound_reversal_requests FOR SELECT TO authenticated
  USING (public._return_cycle_can_request((select auth.uid())) OR public.is_cfo_approver((select auth.uid())));
CREATE POLICY mfa_required_for_staff ON public.compound_reversal_requests AS RESTRICTIVE FOR ALL TO authenticated
  USING ((select public.staff_mfa_ok())) WITH CHECK ((select public.staff_mfa_ok()));

CREATE OR REPLACE FUNCTION public.compound_reversal_candidates(p_portfolio_id uuid)
RETURNS TABLE(ledger_id uuid, reinvested_at timestamptz, amount numeric, reference_id text, description text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_actor uuid := auth.uid();
BEGIN
  IF v_actor IS NULL OR NOT (public._return_cycle_can_request(v_actor) OR public.is_cfo_approver(v_actor)) THEN
    RAISE EXCEPTION 'Not authorised' USING ERRCODE = '42501'; END IF;
  RETURN QUERY
  SELECT g.id, g.created_at, g.amount, g.reference_id, g.description
    FROM public.general_ledger g
   WHERE g.source_table = 'investor_portfolios' AND g.source_id = p_portfolio_id
     AND g.category = 'roi_reinvestment' AND g.direction = 'cash_in'
     AND g.created_at > now() - interval '120 days'
     AND NOT EXISTS (SELECT 1 FROM public.compound_reversal_requests r
                      WHERE r.reinvestment_ledger_id = g.id AND r.status IN ('pending_cfo','approved'))
   ORDER BY g.created_at DESC;
END $$;

CREATE OR REPLACE FUNCTION public.request_compound_reversal(p_portfolio_id uuid, p_ledger_id uuid, p_reason text)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_actor uuid := auth.uid(); v_leg record; v_partner uuid; v_id uuid;
BEGIN
  IF v_actor IS NULL OR NOT public._return_cycle_can_request(v_actor) THEN
    RAISE EXCEPTION 'Only Partner Ops staff can file a compound request' USING ERRCODE = '42501'; END IF;
  IF length(btrim(coalesce(p_reason,''))) < 20 THEN
    RAISE EXCEPTION 'Give a reason of at least 20 characters' USING ERRCODE = '22023'; END IF;
  SELECT investor_id INTO v_partner FROM public.investor_portfolios WHERE id = p_portfolio_id;
  IF v_partner IS NULL THEN RAISE EXCEPTION 'Portfolio not found' USING ERRCODE = 'P0002'; END IF;
  SELECT id, amount, created_at INTO v_leg FROM public.general_ledger
   WHERE id = p_ledger_id AND source_table = 'investor_portfolios' AND source_id = p_portfolio_id
     AND category = 'roi_reinvestment' AND direction = 'cash_in';
  IF NOT FOUND THEN RAISE EXCEPTION 'That reinvestment does not belong to this portfolio' USING ERRCODE = '22023'; END IF;
  INSERT INTO public.compound_reversal_requests
    (portfolio_id, partner_id, reinvestment_ledger_id, reinvested_at, amount, reason, requested_by)
  VALUES (p_portfolio_id, v_partner, v_leg.id, v_leg.created_at, v_leg.amount, btrim(p_reason), v_actor)
  RETURNING id INTO v_id;
  INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, metadata, reason)
  VALUES (v_actor, 'compound_reversal_requested', 'compound_reversal_requests', v_id::text,
          jsonb_build_object('portfolio_id', p_portfolio_id, 'ledger_id', v_leg.id, 'amount', v_leg.amount), btrim(p_reason));
  RETURN v_id;
EXCEPTION WHEN unique_violation THEN
  RAISE EXCEPTION 'This reinvestment already has an open compound request' USING ERRCODE = '23505';
END $$;

CREATE OR REPLACE FUNCTION public.list_compound_reversal_requests(p_status text DEFAULT NULL)
RETURNS TABLE(id uuid, portfolio_id uuid, portfolio_code text, partner_id uuid, partner_name text, amount numeric,
  reinvested_at timestamptz, reason text, status text, requested_by uuid, requested_by_name text, created_at timestamptz,
  decided_by_name text, decided_at timestamptz, decision_note text, cycle_date date, override_id uuid,
  current_principal numeric)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_actor uuid := auth.uid();
BEGIN
  IF v_actor IS NULL OR NOT (public._return_cycle_can_request(v_actor) OR public.is_cfo_approver(v_actor)) THEN
    RAISE EXCEPTION 'Not authorised' USING ERRCODE = '42501'; END IF;
  RETURN QUERY
  SELECT r.id, r.portfolio_id, ip.portfolio_code, r.partner_id, pp.full_name, r.amount, r.reinvested_at, r.reason,
         r.status, r.requested_by, rq.full_name, r.created_at, dc.full_name, r.decided_at, r.decision_note,
         r.cycle_date, r.override_id, ip.investment_amount
    FROM public.compound_reversal_requests r
    JOIN public.investor_portfolios ip ON ip.id = r.portfolio_id
    LEFT JOIN public.profiles pp ON pp.id = r.partner_id
    LEFT JOIN public.profiles rq ON rq.id = r.requested_by
    LEFT JOIN public.profiles dc ON dc.id = r.decided_by
   WHERE p_status IS NULL OR r.status = p_status
   ORDER BY r.created_at DESC LIMIT 300;
END $$;

CREATE OR REPLACE FUNCTION public.decide_compound_reversal(p_request_id uuid, p_approve boolean, p_note text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_actor uuid := auth.uid(); r record; v_pf record; v_cycle date; v_group uuid; v_override uuid;
  v_month_start date := date_trunc('month', (now() AT TIME ZONE 'Africa/Kampala'))::date;
BEGIN
  IF v_actor IS NULL OR NOT public.is_cfo_approver(v_actor) THEN
    RAISE EXCEPTION 'Only the CFO approver can decide compound requests' USING ERRCODE = '42501'; END IF;
  IF length(btrim(coalesce(p_note,''))) < 20 THEN
    RAISE EXCEPTION 'Give a note of at least 20 characters' USING ERRCODE = '22023'; END IF;
  SELECT * INTO r FROM public.compound_reversal_requests WHERE id = p_request_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Request not found' USING ERRCODE = 'P0002'; END IF;
  IF r.status <> 'pending_cfo' THEN RAISE EXCEPTION 'This request was already decided' USING ERRCODE = '22023'; END IF;
  IF r.requested_by = v_actor THEN RAISE EXCEPTION 'You cannot decide your own request' USING ERRCODE = '42501'; END IF;

  IF NOT p_approve THEN
    UPDATE public.compound_reversal_requests SET status='rejected', decided_by=v_actor, decided_at=now(),
      decision_note=btrim(p_note), updated_at=now() WHERE id = r.id;
    INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, metadata, reason)
    VALUES (v_actor, 'compound_reversal_rejected', 'compound_reversal_requests', r.id::text,
            jsonb_build_object('portfolio_id', r.portfolio_id, 'amount', r.amount), btrim(p_note));
    RETURN jsonb_build_object('status','rejected');
  END IF;

  SELECT id, portfolio_code, investment_amount, next_roi_date INTO v_pf
    FROM public.investor_portfolios WHERE id = r.portfolio_id FOR UPDATE;
  IF v_pf.investment_amount - r.amount <= 0 THEN
    RAISE EXCEPTION 'Reversing this would leave the portfolio with no principal' USING ERRCODE = '22023'; END IF;

  v_group := public.create_ledger_transaction(
    entries => jsonb_build_array(
      jsonb_build_object('user_id', r.partner_id, 'ledger_scope','platform', 'direction','cash_out',
        'amount', r.amount, 'category','roi_reinvestment',
        'description','Reinvested Return taken back for cash payout (compound request)',
        'reference_id','CRV-' || v_pf.portfolio_code, 'source_table','investor_portfolios', 'source_id', r.portfolio_id,
        'linked_party', v_actor, 'currency','UGX'),
      jsonb_build_object('user_id', r.partner_id, 'ledger_scope','platform', 'direction','cash_in',
        'amount', r.amount, 'category','roi_expense',
        'description','Reinvested Return reversed; Return to be paid through Nearing Payout',
        'reference_id','CRV-' || v_pf.portfolio_code, 'source_table','investor_portfolios', 'source_id', r.portfolio_id,
        'linked_party', v_actor, 'currency','UGX')),
    idempotency_key => 'compound-reversal:' || r.id::text);

  v_cycle := greatest(coalesce((v_pf.next_roi_date - interval '1 month')::date, v_month_start), v_month_start);
  UPDATE public.investor_portfolios
     SET investment_amount = investment_amount - r.amount, next_roi_date = v_cycle,
         return_fields_edit_token = gen_random_uuid()
   WHERE id = r.portfolio_id;

  v_override := public.authorise_return_cycle_override(r.portfolio_id, v_cycle, r.requested_by,
    least(r.amount, 2 * (SELECT round(investment_amount * roi_percentage / 100) FROM public.investor_portfolios WHERE id = r.portfolio_id)),
    'Compound request approved: reinvested Return returned to Nearing Payout. ' || btrim(p_note));

  UPDATE public.compound_reversal_requests SET status='approved', decided_by=v_actor, decided_at=now(),
    decision_note=btrim(p_note), cycle_date=v_cycle, override_id=v_override, reversal_group_id=v_group, updated_at=now()
   WHERE id = r.id;
  INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, metadata, reason)
  VALUES (v_actor, 'compound_reversal_approved', 'compound_reversal_requests', r.id::text,
          jsonb_build_object('portfolio_id', r.portfolio_id, 'amount', r.amount, 'cycle_date', v_cycle,
                             'override_id', v_override, 'ledger_group', v_group, 'wallet_credited', false), btrim(p_note));
  RETURN jsonb_build_object('status','approved','cycle_date',v_cycle,'override_id',v_override);
END $$;

REVOKE EXECUTE ON FUNCTION public.compound_reversal_candidates(uuid), public.request_compound_reversal(uuid,uuid,text),
  public.list_compound_reversal_requests(text), public.decide_compound_reversal(uuid,boolean,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.compound_reversal_candidates(uuid), public.request_compound_reversal(uuid,uuid,text),
  public.list_compound_reversal_requests(text), public.decide_compound_reversal(uuid,boolean,text) TO authenticated, service_role;