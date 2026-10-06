-- Stage 11: read-only investigation register. Never posts or changes financial records.
CREATE TABLE public.fin_collection_reconciliation_s11 (
  collection_id uuid PRIMARY KEY,
  collected_at timestamptz, agent_id uuid, agent_name text, tenant_id uuid, tenant_name text,
  rent_plan_id uuid, plan_status text, amount numeric, payment_method text, collection_channel text,
  momo_transaction_id text, deposit_request_id uuid, float_before numeric, float_after numeric, reversed_at timestamptz,
  original_classification text,
  plan_found boolean, plan_tenant_match boolean, plan_agent_match boolean,
  ledger_groups int, ledger_group text, ledger_legs int, ledger_receipt numeric, ledger_repayment numeric,
  ledger_commission numeric, ledger_net numeric, ledger_categories text, access_fee numeric, registration_fee numeric,
  dup_matches int, dup_other text, plan_sequence int, prev_float_after numeric,
  reconciliation_result text, external_evidence_required boolean NOT NULL DEFAULT true, findings text,
  generated_at timestamptz NOT NULL DEFAULT now()
);
GRANT ALL ON public.fin_collection_reconciliation_s11 TO service_role;
ALTER TABLE public.fin_collection_reconciliation_s11 ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION public.cfo_collection_reconciliation_s11()
RETURNS SETOF public.fin_collection_reconciliation_s11
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT public.is_cfo_approver(auth.uid()) THEN RAISE EXCEPTION 'Not authorized'; END IF;
  RETURN QUERY SELECT * FROM public.fin_collection_reconciliation_s11 ORDER BY collected_at;
END $$;
REVOKE ALL ON FUNCTION public.cfo_collection_reconciliation_s11() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.cfo_collection_reconciliation_s11() TO authenticated;