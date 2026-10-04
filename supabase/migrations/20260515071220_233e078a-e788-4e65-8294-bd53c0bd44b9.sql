CREATE OR REPLACE FUNCTION public.post_landlord_payout_finops_commission()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_commission numeric;
  v_txn_group uuid;
  v_reference text;
BEGIN
  IF NEW.status NOT IN ('awaiting_agent_receipt', 'completed') THEN
    RETURN NEW;
  END IF;

  IF OLD.status IS NOT DISTINCT FROM NEW.status
     AND OLD.finops_disbursed_at IS NOT DISTINCT FROM NEW.finops_disbursed_at THEN
    RETURN NEW;
  END IF;

  IF NEW.agent_id IS NULL OR COALESCE(NEW.amount, 0) <= 0 THEN
    RETURN NEW;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.general_ledger
    WHERE source_table = 'landlord_payouts'
      AND source_id = NEW.id
      AND category = 'agent_commission_earned'
      AND ledger_scope = 'wallet'
  ) THEN
    RETURN NEW;
  END IF;

  v_commission := ROUND(NEW.amount * 0.01);
  IF v_commission <= 0 THEN
    RETURN NEW;
  END IF;

  v_reference := COALESCE(NULLIF(NEW.finops_momo_reference, ''), NULLIF(NEW.external_reference, ''), NEW.id::text);

  SELECT public.create_ledger_transaction(
    jsonb_build_array(
      jsonb_build_object(
        'user_id', NEW.agent_id,
        'amount', v_commission,
        'direction', 'cash_in',
        'category', 'agent_commission_earned',
        'ledger_scope', 'wallet',
        'recipient_type', 'user',
        'source_table', 'landlord_payouts',
        'source_id', NEW.id,
        'description', '1% commission on FinOps-approved landlord payout to ' || COALESCE(NEW.landlord_name, 'landlord') || ' (Ref: ' || v_reference || ')',
        'currency', 'UGX',
        'reference_id', NEW.id::text || '-landlord-payout-commission',
        'transaction_date', COALESCE(NEW.finops_disbursed_at, NEW.disbursed_at, now())
      ),
      jsonb_build_object(
        'amount', v_commission,
        'direction', 'cash_out',
        'category', 'marketing_expense',
        'ledger_scope', 'platform',
        'source_table', 'landlord_payouts',
        'source_id', NEW.id,
        'description', 'Platform expense: 1% agent commission for landlord payout ' || NEW.id::text,
        'currency', 'UGX',
        'reference_id', NEW.id::text || '-landlord-payout-commission',
        'transaction_date', COALESCE(NEW.finops_disbursed_at, NEW.disbursed_at, now())
      )
    ),
    'landlord-payout-commission-' || NEW.id::text,
    true
  ) INTO v_txn_group;

  INSERT INTO public.system_events (
    event_type,
    user_id,
    related_entity_type,
    related_entity_id,
    metadata
  ) VALUES (
    'funds_added'::public.system_event_type,
    NEW.agent_id,
    'landlord_payout',
    NEW.id,
    jsonb_build_object(
      'amount', v_commission,
      'currency', 'UGX',
      'source', 'finops_landlord_payout_commission',
      'payout_amount', NEW.amount,
      'commission_rate', 0.01,
      'transaction_group_id', v_txn_group
    )
  );

  INSERT INTO public.welile_trust_score_cache (
    user_id,
    ai_id,
    score,
    tier,
    data_points,
    borrowing_limit_ugx,
    breakdown,
    is_agent_managed,
    last_calculated_at
  ) VALUES (
    NEW.agent_id,
    'WELILE-' || left(replace(NEW.agent_id::text, '-', ''), 10),
    1,
    'new',
    1,
    0,
    jsonb_build_object('landlord_payout_commissions', 1),
    true,
    now()
  )
  ON CONFLICT (user_id) DO UPDATE
  SET data_points = public.welile_trust_score_cache.data_points + 1,
      breakdown = COALESCE(public.welile_trust_score_cache.breakdown, '{}'::jsonb) || jsonb_build_object(
        'last_landlord_payout_commission_at', now(),
        'last_landlord_payout_commission_ugx', v_commission
      ),
      last_calculated_at = now();

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_post_landlord_payout_finops_commission ON public.landlord_payouts;
CREATE TRIGGER trg_post_landlord_payout_finops_commission
AFTER UPDATE OF status, finops_disbursed_at, disbursed_at ON public.landlord_payouts
FOR EACH ROW
WHEN (NEW.status IN ('awaiting_agent_receipt', 'completed'))
EXECUTE FUNCTION public.post_landlord_payout_finops_commission();

WITH eligible AS (
  SELECT lp.*
  FROM public.landlord_payouts lp
  WHERE lp.status IN ('awaiting_agent_receipt', 'completed')
    AND lp.amount > 0
    AND NOT EXISTS (
      SELECT 1
      FROM public.general_ledger gl
      WHERE gl.source_table = 'landlord_payouts'
        AND gl.source_id = lp.id
        AND gl.category = 'agent_commission_earned'
        AND gl.ledger_scope = 'wallet'
    )
), posted AS (
  SELECT
    e.id,
    public.create_ledger_transaction(
      jsonb_build_array(
        jsonb_build_object(
          'user_id', e.agent_id,
          'amount', ROUND(e.amount * 0.01),
          'direction', 'cash_in',
          'category', 'agent_commission_earned',
          'ledger_scope', 'wallet',
          'recipient_type', 'user',
          'source_table', 'landlord_payouts',
          'source_id', e.id,
          'description', 'Backfill: 1% commission on FinOps-approved landlord payout to ' || COALESCE(e.landlord_name, 'landlord'),
          'currency', 'UGX',
          'reference_id', e.id::text || '-landlord-payout-commission',
          'transaction_date', COALESCE(e.finops_disbursed_at, e.disbursed_at, e.updated_at, now())
        ),
        jsonb_build_object(
          'amount', ROUND(e.amount * 0.01),
          'direction', 'cash_out',
          'category', 'marketing_expense',
          'ledger_scope', 'platform',
          'source_table', 'landlord_payouts',
          'source_id', e.id,
          'description', 'Backfill platform expense: 1% agent commission for landlord payout ' || e.id::text,
          'currency', 'UGX',
          'reference_id', e.id::text || '-landlord-payout-commission',
          'transaction_date', COALESCE(e.finops_disbursed_at, e.disbursed_at, e.updated_at, now())
        )
      ),
      'landlord-payout-commission-' || e.id::text,
      true
    ) AS txn_group_id,
    e.agent_id,
    e.amount
  FROM eligible e
  WHERE ROUND(e.amount * 0.01) > 0
)
INSERT INTO public.system_events (event_type, user_id, related_entity_type, related_entity_id, metadata)
SELECT
  'funds_added'::public.system_event_type,
  agent_id,
  'landlord_payout',
  id,
  jsonb_build_object(
    'amount', ROUND(amount * 0.01),
    'currency', 'UGX',
    'source', 'finops_landlord_payout_commission_backfill',
    'payout_amount', amount,
    'commission_rate', 0.01,
    'transaction_group_id', txn_group_id
  )
FROM posted;