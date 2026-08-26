CREATE OR REPLACE FUNCTION public.resolve_promissory_note_for_partner(
  p_partner_id uuid,
  p_kind text DEFAULT 'portfolio_creation'
)
RETURNS TABLE(note_id uuid, agent_id uuid, match_basis text, matched_value text)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  RETURN QUERY
  WITH partner AS (
    SELECT p.id,
           right(regexp_replace(coalesce(p.phone, ''), '\D', '', 'g'), 9) AS phone_key,
           nullif(lower(trim(coalesce(p.email, ''))), '') AS email_key
    FROM public.profiles p
    WHERE p.id = p_partner_id
  ), candidates AS (
    SELECT n.id AS candidate_note_id,
           n.agent_id AS candidate_agent_id,
           CASE
             WHEN n.partner_user_id = p_partner_id THEN 'linked_account'
             WHEN length(pr.phone_key) = 9
                  AND right(regexp_replace(coalesce(n.whatsapp_number, ''), '\D', '', 'g'), 9) = pr.phone_key THEN 'whatsapp_number'
             WHEN length(pr.phone_key) = 9
                  AND right(regexp_replace(coalesce(n.phone_number, ''), '\D', '', 'g'), 9) = pr.phone_key THEN 'phone_number'
             WHEN pr.email_key IS NOT NULL
                  AND lower(trim(coalesce(n.email, ''))) = pr.email_key THEN 'email'
             ELSE NULL
           END AS candidate_match_basis,
           CASE
             WHEN n.partner_user_id = p_partner_id THEN p_partner_id::text
             WHEN length(pr.phone_key) = 9
                  AND right(regexp_replace(coalesce(n.whatsapp_number, ''), '\D', '', 'g'), 9) = pr.phone_key THEN n.whatsapp_number
             WHEN length(pr.phone_key) = 9
                  AND right(regexp_replace(coalesce(n.phone_number, ''), '\D', '', 'g'), 9) = pr.phone_key THEN n.phone_number
             WHEN pr.email_key IS NOT NULL
                  AND lower(trim(coalesce(n.email, ''))) = pr.email_key THEN n.email
             ELSE NULL
           END AS candidate_matched_value,
           n.approved_at,
           n.created_at,
           EXISTS (
             SELECT 1
             FROM public.promissory_commission_events e
             WHERE e.note_id = n.id
               AND e.kind = 'portfolio_creation'
               AND e.status = 'paid'
           ) AS creation_already_paid
    FROM public.promissory_notes n
    CROSS JOIN partner pr
    WHERE n.agent_id IS NOT NULL
      AND coalesce(n.approval_bonus_paid, false) = true
      AND (
        n.partner_user_id = p_partner_id
        OR (length(pr.phone_key) = 9 AND right(regexp_replace(coalesce(n.whatsapp_number, ''), '\D', '', 'g'), 9) = pr.phone_key)
        OR (length(pr.phone_key) = 9 AND right(regexp_replace(coalesce(n.phone_number, ''), '\D', '', 'g'), 9) = pr.phone_key)
        OR (pr.email_key IS NOT NULL AND lower(trim(coalesce(n.email, ''))) = pr.email_key)
      )
  )
  SELECT c.candidate_note_id, c.candidate_agent_id, c.candidate_match_basis, c.candidate_matched_value
  FROM candidates c
  WHERE c.candidate_match_basis IS NOT NULL
  ORDER BY
    CASE c.candidate_match_basis
      WHEN 'linked_account' THEN 1
      WHEN 'whatsapp_number' THEN 2
      WHEN 'phone_number' THEN 3
      WHEN 'email' THEN 4
      ELSE 5
    END,
    CASE WHEN p_kind = 'portfolio_creation' AND c.creation_already_paid THEN 1 ELSE 0 END,
    c.approved_at DESC NULLS LAST,
    c.created_at DESC
  LIMIT 1;
END;
$function$;

CREATE OR REPLACE FUNCTION public.credit_promissory_agent_commission(
  p_partner_id uuid,
  p_base_amount numeric,
  p_kind text,
  p_source_table text,
  p_source_id uuid,
  p_dedupe_key text DEFAULT NULL::text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_note_id uuid;
  v_agent_id uuid;
  v_match_basis text;
  v_matched_value text;
  v_rate numeric;
  v_amount numeric;
  v_idem text;
  v_group uuid;
  v_label text;
BEGIN
  IF p_partner_id IS NULL OR p_source_id IS NULL OR coalesce(p_base_amount,0) <= 0 THEN
    RETURN jsonb_build_object('status','skipped','reason','no_base_amount');
  END IF;

  IF p_kind NOT IN ('portfolio_creation', 'portfolio_topup') THEN
    RETURN jsonb_build_object('status','skipped','reason','unsupported_kind');
  END IF;

  SELECT r.note_id, r.agent_id, r.match_basis, r.matched_value
    INTO v_note_id, v_agent_id, v_match_basis, v_matched_value
    FROM public.resolve_promissory_note_for_partner(p_partner_id, p_kind) r
   LIMIT 1;

  IF v_agent_id IS NULL THEN
    RETURN jsonb_build_object('status','skipped','reason','partner_not_promissory_linked');
  END IF;

  v_rate := public.promissory_commission_rate(p_kind, now());
  IF coalesce(v_rate,0) <= 0 THEN
    RETURN jsonb_build_object('status','skipped','reason','no_rate_in_force');
  END IF;

  v_amount := round(p_base_amount * v_rate);
  IF v_amount <= 0 THEN
    RETURN jsonb_build_object('status','skipped','reason','amount_rounds_to_zero');
  END IF;

  IF p_kind = 'portfolio_creation' AND EXISTS (
    SELECT 1 FROM public.promissory_commission_events e
     WHERE e.partner_id = p_partner_id AND e.kind = 'portfolio_creation' AND e.status = 'paid'
  ) THEN
    RETURN jsonb_build_object('status','skipped','reason','creation_commission_already_paid_for_partner');
  END IF;

  v_idem := 'promissory_commission:' || p_kind || ':' || p_source_table || ':'
            || coalesce(p_dedupe_key, p_source_id::text);

  IF EXISTS (SELECT 1 FROM public.promissory_commission_events e
              WHERE e.idempotency_key = v_idem AND e.status = 'paid') THEN
    RETURN jsonb_build_object('status','skipped','reason','duplicate_source');
  END IF;

  v_label := CASE WHEN p_kind = 'portfolio_creation'
                  THEN 'Promissory partner portfolio commission ('
                  ELSE 'Promissory partner top-up commission (' END
             || to_char(v_rate * 100, 'FM999.99') || '%)';

  v_group := public.create_ledger_transaction(
    jsonb_build_array(
      jsonb_build_object('user_id', v_agent_id, 'amount', v_amount,
        'direction','cash_out', 'category','marketing_expense',
        'source_table', p_source_table, 'source_id', p_source_id::text,
        'description', 'Marketing expense: ' || v_label,
        'ledger_scope','platform'),
      jsonb_build_object('user_id', v_agent_id, 'amount', v_amount,
        'direction','cash_in', 'category','agent_commission',
        'source_table', p_source_table, 'source_id', p_source_id::text,
        'description', v_label,
        'ledger_scope','wallet', 'recipient_type','user')),
    v_idem);

  INSERT INTO public.promissory_commission_events
    (note_id, agent_id, partner_id, kind, base_amount, rate, amount,
     source_table, source_id, idempotency_key, ledger_group_id, status)
  VALUES (v_note_id, v_agent_id, p_partner_id, p_kind, p_base_amount, v_rate, v_amount,
          p_source_table, p_source_id::text, v_idem, v_group, 'paid')
  ON CONFLICT DO NOTHING;

  INSERT INTO public.system_events (event_type, user_id, entity_type, entity_id, metadata)
  VALUES (
    'wallet_transfer',
    v_agent_id,
    'promissory_commission_events',
    p_source_id,
    jsonb_build_object(
      'kind', p_kind,
      'partner_id', p_partner_id,
      'promissory_note_id', v_note_id,
      'base_amount', p_base_amount,
      'rate', v_rate,
      'commission_amount', v_amount,
      'source_table', p_source_table,
      'source_id', p_source_id,
      'match_basis', v_match_basis,
      'matched_value', v_matched_value,
      'idempotency_key', v_idem,
      'ledger_group_id', v_group
    )
  );

  RETURN jsonb_build_object('status','paid','amount',v_amount,'rate',v_rate,
                            'agent_id',v_agent_id,'note_id',v_note_id,
                            'match_basis',v_match_basis,'matched_value',v_matched_value,
                            'ledger_group_id',v_group);
END;
$function$;

CREATE OR REPLACE FUNCTION public.trg_credit_promissory_portfolio_creation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF NEW.investor_id IS NOT NULL
     AND coalesce(NEW.investment_amount, 0) > 0
     AND NEW.status = 'active'
     AND (TG_OP = 'INSERT' OR coalesce(OLD.status, '') IS DISTINCT FROM NEW.status) THEN
    PERFORM public.credit_promissory_agent_commission(
      NEW.investor_id,
      NEW.investment_amount,
      'portfolio_creation',
      'investor_portfolios',
      NEW.id,
      NEW.id::text
    );
  END IF;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_credit_promissory_portfolio_creation ON public.investor_portfolios;
CREATE TRIGGER trg_credit_promissory_portfolio_creation
AFTER INSERT OR UPDATE OF status ON public.investor_portfolios
FOR EACH ROW
EXECUTE FUNCTION public.trg_credit_promissory_portfolio_creation();

CREATE OR REPLACE FUNCTION public.trg_credit_promissory_portfolio_topup()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_partner_id uuid;
BEGIN
  IF NEW.operation_type = 'portfolio_topup'
     AND NEW.source_table = 'investor_portfolios'
     AND NEW.source_id IS NOT NULL
     AND coalesce(NEW.amount, 0) > 0
     AND NEW.status = 'approved'
     AND (TG_OP = 'INSERT' OR coalesce(OLD.status, '') IS DISTINCT FROM NEW.status) THEN
    SELECT ip.investor_id
      INTO v_partner_id
      FROM public.investor_portfolios ip
     WHERE ip.id = NEW.source_id;

    PERFORM public.credit_promissory_agent_commission(
      coalesce(v_partner_id, NEW.user_id),
      NEW.amount,
      'portfolio_topup',
      'pending_wallet_operations',
      NEW.id,
      NEW.id::text
    );
  END IF;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_credit_promissory_portfolio_topup ON public.pending_wallet_operations;
CREATE TRIGGER trg_credit_promissory_portfolio_topup
AFTER INSERT OR UPDATE OF status ON public.pending_wallet_operations
FOR EACH ROW
EXECUTE FUNCTION public.trg_credit_promissory_portfolio_topup();

GRANT EXECUTE ON FUNCTION public.resolve_promissory_note_for_partner(uuid, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.credit_promissory_agent_commission(uuid, numeric, text, text, uuid, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.trg_credit_promissory_portfolio_creation() TO service_role;
GRANT EXECUTE ON FUNCTION public.trg_credit_promissory_portfolio_topup() TO service_role;