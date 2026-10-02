CREATE TABLE public.agent_bike_leases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sale_id uuid NOT NULL UNIQUE REFERENCES public.merchandise_sales(id),
  agent_id uuid,
  agent_name text,
  agent_phone text,
  brand text NOT NULL DEFAULT 'Spiro',
  model text,
  tracking_reference text,
  valuation_amount numeric NOT NULL DEFAULT 0,
  lease_term_months integer NOT NULL DEFAULT 12,
  monthly_rate_pct numeric NOT NULL DEFAULT 0 CHECK (monthly_rate_pct >= 0 AND monthly_rate_pct <= 20),
  wallet_recovery_rate numeric,
  amount_paid numeric NOT NULL DEFAULT 0,
  amount_outstanding numeric NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'submitted',
  rejection_reason text,
  battery_serial text,
  chassis_number text,
  gps_tracker_id text,
  plate_number text,
  logbook_status text NOT NULL DEFAULT 'pending_registration'
    CHECK (logbook_status IN ('pending_registration','held_by_welile','held_by_supplier','with_agent','released')),
  logbook_updated_at timestamptz,
  logbook_updated_by uuid,
  ops_approved_at timestamptz,
  coo_approved_at timestamptz,
  cfo_disbursed_at timestamptz,
  lease_activated_at timestamptz,
  disbursed_amount numeric,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX agent_bike_leases_agent_idx ON public.agent_bike_leases(agent_id);
CREATE INDEX agent_bike_leases_status_idx ON public.agent_bike_leases(status);

CREATE TABLE public.agent_bike_lease_schedules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lease_id uuid NOT NULL REFERENCES public.agent_bike_leases(id),
  version integer NOT NULL DEFAULT 1,
  installment_no integer NOT NULL,
  due_date date NOT NULL,
  opening_balance numeric NOT NULL,
  principal_due numeric NOT NULL,
  interest_due numeric NOT NULL,
  installment_amount numeric NOT NULL,
  closing_balance numeric NOT NULL,
  monthly_rate_pct numeric NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  UNIQUE (lease_id, version, installment_no)
);
CREATE INDEX agent_bike_lease_schedules_lease_idx ON public.agent_bike_lease_schedules(lease_id, version);

GRANT SELECT ON public.agent_bike_leases TO authenticated;
GRANT SELECT ON public.agent_bike_lease_schedules TO authenticated;
GRANT ALL ON public.agent_bike_leases TO service_role;
GRANT ALL ON public.agent_bike_lease_schedules TO service_role;

ALTER TABLE public.agent_bike_leases ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.agent_bike_lease_schedules ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Agents view own bike leases" ON public.agent_bike_leases FOR SELECT TO authenticated
  USING (agent_id = auth.uid() OR public.can_review_bike_leases(auth.uid()));
CREATE POLICY "View schedules of visible leases" ON public.agent_bike_lease_schedules FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.agent_bike_leases l WHERE l.id = lease_id
         AND (l.agent_id = auth.uid() OR public.can_review_bike_leases(auth.uid()))));

-- Reducing-balance schedule. Appends a new version; earlier versions are kept as history.
CREATE OR REPLACE FUNCTION public._generate_bike_lease_schedule(p_lease_id uuid)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  l public.agent_bike_leases;
  v_ver integer;
  r numeric; n integer; bal numeric; pmt numeric; intr numeric; prin numeric;
  v_start date; i integer;
BEGIN
  SELECT * INTO l FROM public.agent_bike_leases WHERE id = p_lease_id;
  IF l.id IS NULL OR COALESCE(l.valuation_amount,0) <= 0 THEN RETURN 0; END IF;
  SELECT COALESCE(max(version),0)+1 INTO v_ver FROM public.agent_bike_lease_schedules WHERE lease_id = p_lease_id;
  n := GREATEST(l.lease_term_months,1);
  r := l.monthly_rate_pct / 100.0;
  bal := l.valuation_amount;
  v_start := (COALESCE(l.lease_activated_at, l.coo_approved_at, l.created_at, now()) AT TIME ZONE 'Africa/Kampala')::date;
  IF r > 0 THEN pmt := round(bal * r / (1 - power(1 + r, -n)));
  ELSE pmt := ceil(bal / n); END IF;
  FOR i IN 1..n LOOP
    intr := round(bal * r);
    prin := LEAST(pmt - intr, bal);
    IF i = n THEN prin := bal; END IF;
    INSERT INTO public.agent_bike_lease_schedules(lease_id, version, installment_no, due_date, opening_balance,
      principal_due, interest_due, installment_amount, closing_balance, monthly_rate_pct, created_by)
    VALUES (p_lease_id, v_ver, i, (v_start + make_interval(months => i))::date, bal,
      prin, intr, prin + intr, bal - prin, l.monthly_rate_pct, auth.uid());
    bal := bal - prin;
  END LOOP;
  RETURN v_ver;
END $$;
REVOKE ALL ON FUNCTION public._generate_bike_lease_schedule(uuid) FROM public, anon, authenticated;

-- Keep lease records in step with the merchandise record (money paths unchanged).
CREATE OR REPLACE FUNCTION public.sync_bike_lease_from_sale()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_id uuid; v_prev public.agent_bike_leases;
BEGIN
  IF lower(COALESCE(NEW.item_name,'')) NOT LIKE '%spiro%' THEN RETURN NEW; END IF;
  SELECT * INTO v_prev FROM public.agent_bike_leases WHERE sale_id = NEW.id;
  INSERT INTO public.agent_bike_leases AS b (sale_id, agent_id, agent_name, agent_phone, brand, model, tracking_reference,
    valuation_amount, lease_term_months, wallet_recovery_rate, amount_paid, amount_outstanding, status, rejection_reason,
    ops_approved_at, coo_approved_at, cfo_disbursed_at, lease_activated_at, disbursed_amount, created_at)
  VALUES (NEW.id, NEW.customer_id, NEW.client_name, NEW.client_phone, COALESCE(NEW.brand,'Spiro'), NEW.model_type, NEW.tracking_reference,
    COALESCE(NULLIF(NEW.valuation_amount,0), NULLIF(NEW.total_amount,0), NEW.total_revenue, 0),
    COALESCE(NEW.lease_term_months,12), NEW.lease_daily_rate, COALESCE(NEW.amount_paid,0), COALESCE(NEW.amount_outstanding,0),
    COALESCE(NEW.order_status,'submitted'), NEW.rejection_reason, NEW.ops_approved_at, NEW.coo_approved_at,
    NEW.cfo_disbursed_at, NEW.lease_activated_at, NEW.disbursed_amount, COALESCE(NEW.created_at, now()))
  ON CONFLICT (sale_id) DO UPDATE SET
    agent_id = EXCLUDED.agent_id, agent_name = EXCLUDED.agent_name, agent_phone = EXCLUDED.agent_phone,
    model = EXCLUDED.model, tracking_reference = EXCLUDED.tracking_reference,
    valuation_amount = EXCLUDED.valuation_amount, lease_term_months = EXCLUDED.lease_term_months,
    wallet_recovery_rate = EXCLUDED.wallet_recovery_rate, amount_paid = EXCLUDED.amount_paid,
    amount_outstanding = EXCLUDED.amount_outstanding, status = EXCLUDED.status, rejection_reason = EXCLUDED.rejection_reason,
    ops_approved_at = EXCLUDED.ops_approved_at, coo_approved_at = EXCLUDED.coo_approved_at,
    cfo_disbursed_at = EXCLUDED.cfo_disbursed_at, lease_activated_at = EXCLUDED.lease_activated_at,
    disbursed_amount = EXCLUDED.disbursed_amount, updated_at = now()
  RETURNING id INTO v_id;
  -- New schedule when terms or activation date change
  IF v_prev.id IS NULL
     OR v_prev.valuation_amount IS DISTINCT FROM COALESCE(NULLIF(NEW.valuation_amount,0), NULLIF(NEW.total_amount,0), NEW.total_revenue, 0)
     OR v_prev.lease_term_months IS DISTINCT FROM COALESCE(NEW.lease_term_months,12)
     OR v_prev.lease_activated_at IS DISTINCT FROM NEW.lease_activated_at THEN
    PERFORM public._generate_bike_lease_schedule(v_id);
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.sync_bike_lease_from_sale() FROM public, anon, authenticated;

CREATE TRIGGER trg_sync_bike_lease_from_sale AFTER INSERT OR UPDATE ON public.merchandise_sales
  FOR EACH ROW EXECUTE FUNCTION public.sync_bike_lease_from_sale();

-- Backfill: insert lease rows and first schedule for existing bike records (merchandise_sales untouched)
INSERT INTO public.agent_bike_leases (sale_id, agent_id, agent_name, agent_phone, brand, model, tracking_reference,
  valuation_amount, lease_term_months, wallet_recovery_rate, amount_paid, amount_outstanding, status, rejection_reason,
  ops_approved_at, coo_approved_at, cfo_disbursed_at, lease_activated_at, disbursed_amount, created_at)
SELECT s.id, s.customer_id, s.client_name, s.client_phone, COALESCE(s.brand,'Spiro'), s.model_type, s.tracking_reference,
  COALESCE(NULLIF(s.valuation_amount,0), NULLIF(s.total_amount,0), s.total_revenue, 0),
  COALESCE(s.lease_term_months,12), s.lease_daily_rate, COALESCE(s.amount_paid,0), COALESCE(s.amount_outstanding,0),
  COALESCE(s.order_status,'submitted'), s.rejection_reason, s.ops_approved_at, s.coo_approved_at,
  s.cfo_disbursed_at, s.lease_activated_at, s.disbursed_amount, COALESCE(s.created_at, now())
FROM public.merchandise_sales s
WHERE lower(COALESCE(s.item_name,'')) LIKE '%spiro%'
ON CONFLICT (sale_id) DO NOTHING;

INSERT INTO public.agent_bike_lease_schedules (lease_id, version, installment_no, due_date, opening_balance,
  principal_due, interest_due, installment_amount, closing_balance, monthly_rate_pct)
SELECT l.id, 1, g.i,
  ((COALESCE(l.lease_activated_at, l.coo_approved_at, l.created_at) AT TIME ZONE 'Africa/Kampala')::date + make_interval(months => g.i))::date,
  l.valuation_amount - LEAST(ceil(l.valuation_amount / l.lease_term_months) * (g.i-1), l.valuation_amount),
  CASE WHEN g.i = l.lease_term_months THEN l.valuation_amount - LEAST(ceil(l.valuation_amount / l.lease_term_months) * (g.i-1), l.valuation_amount)
       ELSE LEAST(ceil(l.valuation_amount / l.lease_term_months), GREATEST(l.valuation_amount - ceil(l.valuation_amount / l.lease_term_months) * (g.i-1),0)) END,
  0,
  CASE WHEN g.i = l.lease_term_months THEN l.valuation_amount - LEAST(ceil(l.valuation_amount / l.lease_term_months) * (g.i-1), l.valuation_amount)
       ELSE LEAST(ceil(l.valuation_amount / l.lease_term_months), GREATEST(l.valuation_amount - ceil(l.valuation_amount / l.lease_term_months) * (g.i-1),0)) END,
  GREATEST(l.valuation_amount - ceil(l.valuation_amount / l.lease_term_months) * g.i, 0),
  0
FROM public.agent_bike_leases l
CROSS JOIN LATERAL generate_series(1, GREATEST(l.lease_term_months,1)) g(i)
WHERE l.valuation_amount > 0;

-- Asset details + logbook custody
CREATE OR REPLACE FUNCTION public.update_bike_lease_asset(p_lease_id uuid, p_details jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_uid uuid := auth.uid(); v_old public.agent_bike_leases; v_new public.agent_bike_leases; v_log text;
BEGIN
  IF NOT public.can_review_bike_leases(v_uid) THEN RAISE EXCEPTION 'Not authorized to edit bike lease details'; END IF;
  SELECT * INTO v_old FROM public.agent_bike_leases WHERE id = p_lease_id FOR UPDATE;
  IF v_old.id IS NULL THEN RAISE EXCEPTION 'Bike lease not found'; END IF;
  v_log := NULLIF(btrim(p_details->>'logbook_status'),'');
  UPDATE public.agent_bike_leases SET
    battery_serial = CASE WHEN p_details ? 'battery_serial' THEN NULLIF(btrim(p_details->>'battery_serial'),'') ELSE battery_serial END,
    chassis_number = CASE WHEN p_details ? 'chassis_number' THEN NULLIF(btrim(p_details->>'chassis_number'),'') ELSE chassis_number END,
    gps_tracker_id = CASE WHEN p_details ? 'gps_tracker_id' THEN NULLIF(btrim(p_details->>'gps_tracker_id'),'') ELSE gps_tracker_id END,
    plate_number = CASE WHEN p_details ? 'plate_number' THEN NULLIF(upper(btrim(p_details->>'plate_number')),'') ELSE plate_number END,
    logbook_status = COALESCE(v_log, logbook_status),
    logbook_updated_at = CASE WHEN v_log IS NOT NULL AND v_log <> logbook_status THEN now() ELSE logbook_updated_at END,
    logbook_updated_by = CASE WHEN v_log IS NOT NULL AND v_log <> logbook_status THEN v_uid ELSE logbook_updated_by END,
    updated_at = now()
  WHERE id = p_lease_id RETURNING * INTO v_new;
  INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, reason, old_values, new_values)
  VALUES (v_uid, 'bike_lease_asset_updated', 'agent_bike_leases', p_lease_id,
    'Bike lease asset details or logbook custody updated',
    jsonb_build_object('battery_serial',v_old.battery_serial,'chassis_number',v_old.chassis_number,'gps_tracker_id',v_old.gps_tracker_id,'plate_number',v_old.plate_number,'logbook_status',v_old.logbook_status),
    jsonb_build_object('battery_serial',v_new.battery_serial,'chassis_number',v_new.chassis_number,'gps_tracker_id',v_new.gps_tracker_id,'plate_number',v_new.plate_number,'logbook_status',v_new.logbook_status));
  RETURN to_jsonb(v_new);
END $$;

-- Monthly rate per lease (COO or CFO), regenerates schedule
CREATE OR REPLACE FUNCTION public.set_bike_lease_monthly_rate(p_lease_id uuid, p_monthly_rate_pct numeric, p_reason text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_uid uuid := auth.uid(); v_old numeric; v_ver integer;
BEGIN
  IF NOT (public.can_coo_approve_bike_leases(v_uid) OR public.can_cfo_disburse_bike_leases(v_uid)) THEN
    RAISE EXCEPTION 'Only the COO or CFO can set the lease rate';
  END IF;
  IF length(btrim(COALESCE(p_reason,''))) < 10 THEN RAISE EXCEPTION 'Provide a reason of at least 10 characters'; END IF;
  IF p_monthly_rate_pct IS NULL OR p_monthly_rate_pct < 0 OR p_monthly_rate_pct > 20 THEN
    RAISE EXCEPTION 'Monthly rate must be between 0%% and 20%%';
  END IF;
  SELECT monthly_rate_pct INTO v_old FROM public.agent_bike_leases WHERE id = p_lease_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Bike lease not found'; END IF;
  UPDATE public.agent_bike_leases SET monthly_rate_pct = p_monthly_rate_pct, updated_at = now() WHERE id = p_lease_id;
  v_ver := public._generate_bike_lease_schedule(p_lease_id);
  INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, reason, old_values, new_values)
  VALUES (v_uid, 'bike_lease_rate_set', 'agent_bike_leases', p_lease_id, btrim(p_reason),
    jsonb_build_object('monthly_rate_pct', v_old), jsonb_build_object('monthly_rate_pct', p_monthly_rate_pct, 'schedule_version', v_ver));
  RETURN jsonb_build_object('lease_id', p_lease_id, 'monthly_rate_pct', p_monthly_rate_pct, 'schedule_version', v_ver);
END $$;

CREATE OR REPLACE FUNCTION public.list_bike_leases(p_status text DEFAULT NULL)
RETURNS SETOF public.agent_bike_leases LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT public.can_review_bike_leases(auth.uid()) THEN RAISE EXCEPTION 'Not authorized to view Spiro bike lease applications'; END IF;
  RETURN QUERY SELECT * FROM public.agent_bike_leases
   WHERE p_status IS NULL OR status = p_status ORDER BY created_at DESC LIMIT 300;
END $$;

CREATE OR REPLACE VIEW public.v_bike_lease_current_schedule WITH (security_invoker = true) AS
SELECT s.* FROM public.agent_bike_lease_schedules s
WHERE s.version = (SELECT max(version) FROM public.agent_bike_lease_schedules x WHERE x.lease_id = s.lease_id);
GRANT SELECT ON public.v_bike_lease_current_schedule TO authenticated;

REVOKE ALL ON FUNCTION public.update_bike_lease_asset(uuid,jsonb) FROM public, anon;
REVOKE ALL ON FUNCTION public.set_bike_lease_monthly_rate(uuid,numeric,text) FROM public, anon;
REVOKE ALL ON FUNCTION public.list_bike_leases(text) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.update_bike_lease_asset(uuid,jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.set_bike_lease_monthly_rate(uuid,numeric,text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.list_bike_leases(text) TO authenticated;

-- Order RPC now also returns the lease record id (insert path unchanged; trigger creates the lease)
CREATE OR REPLACE FUNCTION public.agent_order_spiro_bike_lease(p_model text, p_valuation numeric, p_lease_term_months integer DEFAULT 12, p_daily_rate numeric DEFAULT 0.15, p_note text DEFAULT NULL::text)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  v_uid uuid := auth.uid(); v_name text; v_phone text; v_sale_id uuid; v_tracking text; v_lease_id uuid;
  v_model text := NULLIF(btrim(COALESCE(p_model, '')), '');
  v_term integer := GREATEST(COALESCE(p_lease_term_months, 12), 1);
  v_rate numeric := LEAST(GREATEST(COALESCE(p_daily_rate, 0.15), 0.01), 1);
  v_projection numeric;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  IF v_model IS NULL THEN RAISE EXCEPTION 'Select a Spiro bike model'; END IF;
  IF p_valuation IS NULL OR p_valuation < 100000 THEN RAISE EXCEPTION 'Bike valuation must be at least UGX 100,000'; END IF;
  IF EXISTS (SELECT 1 FROM public.agent_bike_leases WHERE agent_id = v_uid
             AND status IN ('submitted','pending_approval','ops_approved','coo_approved')) THEN
    RAISE EXCEPTION 'You already have a Spiro bike application in review';
  END IF;
  SELECT full_name, phone INTO v_name, v_phone FROM public.profiles WHERE id = v_uid;
  v_tracking := 'SPB-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 8));
  v_projection := round(p_valuation * v_rate);
  INSERT INTO public.merchandise_sales (
    item_name, brand, model_type, quantity, unit_price, unit_cost, total_revenue, total_amount,
    valuation_amount, payment_projection, lease_term_months, lease_daily_rate,
    client_name, client_phone, customer_id, payment_status,
    amount_paid, amount_outstanding, sale_date, created_by, order_status, notes, tracking_reference
  ) VALUES (
    'Welile Spiro Bike', 'Spiro', v_model, 1, p_valuation, 0, p_valuation, p_valuation,
    p_valuation, v_projection, v_term, v_rate, v_name, v_phone, v_uid, 'credit',
    0, p_valuation, current_date, v_uid, 'submitted',
    'Spiro electric bike lease application - model ' || v_model
      || ', valuation ' || to_char(p_valuation, 'FM999,999,999')
      || ', lease term ' || v_term || ' months, wallet recovery rate '
      || to_char(v_rate * 100, 'FM990.9') || '% per credit'
      || COALESCE(' - ' || NULLIF(btrim(p_note), ''), ''),
    v_tracking
  ) RETURNING id INTO v_sale_id;
  SELECT id INTO v_lease_id FROM public.agent_bike_leases WHERE sale_id = v_sale_id;
  RETURN jsonb_build_object('sale_id', v_sale_id, 'lease_id', v_lease_id, 'model', v_model, 'valuation', p_valuation,
    'lease_term_months', v_term, 'daily_recovery', v_projection, 'order_status', 'submitted', 'tracking_reference', v_tracking);
END;
$function$;