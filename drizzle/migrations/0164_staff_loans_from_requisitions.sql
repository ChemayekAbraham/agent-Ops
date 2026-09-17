-- Staff loans raised through the existing requisition approval chain.
-- A loan is a requisition with request_kind = 'staff_loan': same department head ->
-- COO -> CFO route, same wallet credit on final approval. Once credited, a loan
-- account is opened here and recovered from the person's wallet as money arrives.
-- Interest: 30% per month on the amount still owing (reducing balance).

ALTER TABLE public.staff_requisitions
  ADD COLUMN IF NOT EXISTS request_kind text NOT NULL DEFAULT 'requisition',
  ADD COLUMN IF NOT EXISTS loan_months integer,
  ADD COLUMN IF NOT EXISTS loan_monthly_rate numeric(6,4);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.staff_requisitions'::regclass
      AND conname = 'staff_requisitions_request_kind_ck'
  ) THEN
    ALTER TABLE public.staff_requisitions
      ADD CONSTRAINT staff_requisitions_request_kind_ck
      CHECK (request_kind IN ('requisition', 'staff_loan'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.staff_requisitions'::regclass
      AND conname = 'staff_requisitions_loan_months_ck'
  ) THEN
    ALTER TABLE public.staff_requisitions
      ADD CONSTRAINT staff_requisitions_loan_months_ck
      CHECK (loan_months IS NULL OR (loan_months BETWEEN 1 AND 12));
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS public.staff_loans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  requisition_id uuid NOT NULL UNIQUE REFERENCES public.staff_requisitions(id) ON DELETE RESTRICT,
  user_id uuid NOT NULL,
  principal numeric NOT NULL,
  monthly_rate numeric(6,4) NOT NULL DEFAULT 0.30,
  months integer NOT NULL DEFAULT 1,
  outstanding_principal numeric NOT NULL DEFAULT 0,
  accrued_interest numeric NOT NULL DEFAULT 0,
  interest_charged_total numeric NOT NULL DEFAULT 0,
  total_repaid numeric NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'active',
  started_on date NOT NULL DEFAULT current_date,
  due_on date,
  last_accrued_on date NOT NULL DEFAULT current_date,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT staff_loans_status_ck CHECK (status IN ('active', 'completed', 'written_off'))
);

GRANT SELECT ON public.staff_loans TO authenticated;
GRANT ALL ON public.staff_loans TO service_role;
ALTER TABLE public.staff_loans ENABLE ROW LEVEL SECURITY;

CREATE POLICY staff_loans_select_own ON public.staff_loans
  FOR SELECT TO authenticated
  USING (
    user_id = auth.uid()
    OR has_role(auth.uid(), 'cfo')
    OR has_role(auth.uid(), 'ceo')
    OR has_role(auth.uid(), 'coo')
    OR has_role(auth.uid(), 'financial_ops')
    OR has_role(auth.uid(), 'hr')
  );

CREATE TABLE IF NOT EXISTS public.staff_loan_repayments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  loan_id uuid NOT NULL REFERENCES public.staff_loans(id) ON DELETE RESTRICT,
  user_id uuid NOT NULL,
  amount numeric NOT NULL,
  interest_component numeric NOT NULL DEFAULT 0,
  principal_component numeric NOT NULL DEFAULT 0,
  source text NOT NULL DEFAULT 'wallet_recovery',
  note text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS staff_loan_repayments_loan_idx ON public.staff_loan_repayments(loan_id, created_at DESC);
GRANT SELECT ON public.staff_loan_repayments TO authenticated;
GRANT ALL ON public.staff_loan_repayments TO service_role;
ALTER TABLE public.staff_loan_repayments ENABLE ROW LEVEL SECURITY;

CREATE POLICY staff_loan_repayments_select_own ON public.staff_loan_repayments
  FOR SELECT TO authenticated
  USING (
    user_id = auth.uid()
    OR has_role(auth.uid(), 'cfo')
    OR has_role(auth.uid(), 'ceo')
    OR has_role(auth.uid(), 'coo')
    OR has_role(auth.uid(), 'financial_ops')
    OR has_role(auth.uid(), 'hr')
  );

-- Opens the loan account the moment the approved amount reaches the wallet.
CREATE OR REPLACE FUNCTION public.tg_open_staff_loan_on_credit()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_principal numeric;
  v_months integer;
  v_rate numeric;
BEGIN
  IF COALESCE(NEW.request_kind, 'requisition') <> 'staff_loan' THEN
    RETURN NEW;
  END IF;
  IF NEW.wallet_credit_status IS DISTINCT FROM 'credited' THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.wallet_credit_status = 'credited' THEN
    RETURN NEW;
  END IF;

  v_principal := COALESCE(NEW.approved_amount, NEW.amount);
  v_months := GREATEST(1, LEAST(12, COALESCE(NEW.loan_months, 1)));
  v_rate := COALESCE(NEW.loan_monthly_rate, 0.30);

  INSERT INTO public.staff_loans (
    requisition_id, user_id, principal, monthly_rate, months,
    outstanding_principal, started_on, due_on, last_accrued_on
  ) VALUES (
    NEW.id, NEW.requester_id, v_principal, v_rate, v_months,
    v_principal, current_date, current_date + (v_months * INTERVAL '1 month'), current_date
  )
  ON CONFLICT (requisition_id) DO NOTHING;

  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_open_staff_loan_on_credit ON public.staff_requisitions;
CREATE TRIGGER trg_open_staff_loan_on_credit
  AFTER INSERT OR UPDATE OF wallet_credit_status ON public.staff_requisitions
  FOR EACH ROW EXECUTE FUNCTION public.tg_open_staff_loan_on_credit();

-- Charges 30% per month on the amount still owing, for every whole month elapsed.
CREATE OR REPLACE FUNCTION public.staff_loan_accrue_interest()
RETURNS TABLE(loans_charged integer, interest_charged numeric)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  r record;
  v_charge numeric;
  v_count integer := 0;
  v_total numeric := 0;
BEGIN
  FOR r IN
    SELECT * FROM public.staff_loans
    WHERE status = 'active'
      AND outstanding_principal > 0
      AND last_accrued_on <= current_date - INTERVAL '1 month'
  LOOP
    v_charge := 0;
    WHILE r.last_accrued_on <= current_date - INTERVAL '1 month' LOOP
      v_charge := v_charge + round((r.outstanding_principal + r.accrued_interest + v_charge) * r.monthly_rate);
      r.last_accrued_on := r.last_accrued_on + INTERVAL '1 month';
    END LOOP;

    UPDATE public.staff_loans
       SET accrued_interest = accrued_interest + v_charge,
           interest_charged_total = interest_charged_total + v_charge,
           last_accrued_on = r.last_accrued_on,
           updated_at = now()
     WHERE id = r.id;

    v_count := v_count + 1;
    v_total := v_total + v_charge;
  END LOOP;

  RETURN QUERY SELECT v_count, v_total;
END $$;

REVOKE ALL ON FUNCTION public.staff_loan_accrue_interest() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.staff_loan_accrue_interest() TO service_role;

-- Recovers whatever is available in the person's wallet against their loans.
-- Interest is cleared before principal. Posts both ledger legs; never touches
-- wallet buckets directly beyond the ledger path.
CREATE OR REPLACE FUNCTION public.staff_loan_recover_from_wallet(
  p_user_id uuid,
  p_max_amount numeric DEFAULT NULL,
  p_source text DEFAULT 'wallet_recovery'
)
RETURNS TABLE(loan_id uuid, recovered numeric, closed boolean)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  r record;
  v_available numeric;
  v_take numeric;
  v_interest numeric;
  v_principal numeric;
  v_owed numeric;
  v_idem text;
BEGIN
  FOR r IN
    SELECT * FROM public.staff_loans
    WHERE user_id = p_user_id AND status = 'active'
    ORDER BY started_on
  LOOP
    v_available := GREATEST(0, COALESCE(public.get_user_available_balance(p_user_id), 0));
    IF p_max_amount IS NOT NULL THEN
      v_available := LEAST(v_available, GREATEST(0, p_max_amount));
    END IF;
    v_owed := GREATEST(0, r.outstanding_principal + r.accrued_interest);
    v_take := floor(LEAST(v_available, v_owed));
    IF v_take <= 0 THEN
      CONTINUE;
    END IF;

    v_interest := LEAST(v_take, r.accrued_interest);
    v_principal := v_take - v_interest;
    v_idem := 'staff_loan_recovery_' || r.id::text || '_' || extract(epoch from clock_timestamp())::bigint::text;

    PERFORM public.create_ledger_transaction(
      entries := jsonb_build_array(
        jsonb_build_object(
          'user_id', p_user_id, 'ledger_scope', 'wallet', 'direction', 'cash_out',
          'amount', v_take, 'category', 'agent_repayment', 'recipient_type', 'user',
          'source_table', 'staff_loans', 'source_id', r.id,
          'description', 'Staff loan repayment', 'currency', 'UGX',
          'transaction_date', current_date,
          'metadata', jsonb_build_object('source', 'staff_loan_recovery', 'loan_id', r.id,
                                         'interest_component', v_interest,
                                         'principal_component', v_principal)
        ),
        jsonb_build_object(
          'user_id', p_user_id, 'ledger_scope', 'platform', 'direction', 'cash_in',
          'amount', v_take, 'category', 'agent_repayment', 'recipient_type', 'operational_wallet',
          'source_table', 'staff_loans', 'source_id', r.id,
          'description', 'Staff loan repayment received', 'currency', 'UGX',
          'transaction_date', current_date,
          'metadata', jsonb_build_object('source', 'staff_loan_recovery', 'loan_id', r.id)
        )
      ),
      idempotency_key := v_idem
    );

    INSERT INTO public.staff_loan_repayments (loan_id, user_id, amount, interest_component, principal_component, source)
    VALUES (r.id, p_user_id, v_take, v_interest, v_principal, COALESCE(p_source, 'wallet_recovery'));

    UPDATE public.staff_loans
       SET accrued_interest = GREATEST(0, accrued_interest - v_interest),
           outstanding_principal = GREATEST(0, outstanding_principal - v_principal),
           total_repaid = total_repaid + v_take,
           status = CASE WHEN GREATEST(0, outstanding_principal - v_principal) <= 0
                          AND GREATEST(0, accrued_interest - v_interest) <= 0
                         THEN 'completed' ELSE status END,
           completed_at = CASE WHEN GREATEST(0, outstanding_principal - v_principal) <= 0
                                AND GREATEST(0, accrued_interest - v_interest) <= 0
                               THEN now() ELSE completed_at END,
           updated_at = now()
     WHERE id = r.id;

    RETURN QUERY SELECT r.id, v_take, (v_take >= v_owed);
  END LOOP;
END $$;

REVOKE ALL ON FUNCTION public.staff_loan_recover_from_wallet(uuid, numeric, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.staff_loan_recover_from_wallet(uuid, numeric, text) TO service_role;

-- Sweeps every active loan: accrues interest first, then recovers what it can.
CREATE OR REPLACE FUNCTION public.sweep_staff_loan_recovery()
RETURNS TABLE(users_swept integer, total_recovered numeric)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  u record;
  v_users integer := 0;
  v_total numeric := 0;
  v_sum numeric;
BEGIN
  PERFORM public.staff_loan_accrue_interest();
  FOR u IN SELECT DISTINCT user_id FROM public.staff_loans WHERE status = 'active' LOOP
    SELECT COALESCE(sum(recovered), 0) INTO v_sum
      FROM public.staff_loan_recover_from_wallet(u.user_id);
    IF v_sum > 0 THEN
      v_users := v_users + 1;
      v_total := v_total + v_sum;
    END IF;
  END LOOP;
  RETURN QUERY SELECT v_users, v_total;
END $$;

REVOKE ALL ON FUNCTION public.sweep_staff_loan_recovery() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sweep_staff_loan_recovery() TO service_role;

-- Tells the UI whether the signed-in person may raise a staff loan
-- (employee role, enabled).
CREATE OR REPLACE FUNCTION public.my_staff_loan_eligibility()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_eligible boolean := false;
  v_active integer := 0;
  v_owed numeric := 0;
BEGIN
  IF v_uid IS NULL THEN
    RETURN jsonb_build_object('eligible', false, 'reason', 'not_signed_in');
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM public.user_roles ur
    WHERE ur.user_id = v_uid AND ur.role = 'employee' AND COALESCE(ur.enabled, true)
  ) INTO v_eligible;

  SELECT count(*), COALESCE(sum(outstanding_principal + accrued_interest), 0)
    INTO v_active, v_owed
    FROM public.staff_loans
   WHERE user_id = v_uid AND status = 'active';

  RETURN jsonb_build_object(
    'eligible', v_eligible,
    'monthly_rate', 0.30,
    'max_months', 12,
    'active_loans', v_active,
    'outstanding', v_owed
  );
END $$;

GRANT EXECUTE ON FUNCTION public.my_staff_loan_eligibility() TO authenticated;
