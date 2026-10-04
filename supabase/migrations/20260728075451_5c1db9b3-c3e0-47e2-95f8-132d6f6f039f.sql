CREATE OR REPLACE FUNCTION public.is_customer_wallet_history_visible(
  p_user_id uuid,
  p_classification text,
  p_category text,
  p_source_table text,
  p_description text,
  p_reference_id text DEFAULT NULL,
  p_source_id uuid DEFAULT NULL
)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT NOT (
    COALESCE(p_classification, '') = 'admin_correction'
    OR COALESCE(p_category, '') IN (
      'system_balance_correction',
      'admin_balance_correction',
      'administrative_balance_correction',
      'reconciliation_adjustment',
      'migration_adjustment',
      'rollback_correction',
      'backfill_correction',
      'wallet_projection_reversed_bonus_exclusion'
    )
    OR COALESCE(p_source_table, '') IN (
      'commission_engine_reversal',
      'wallet_projection_reversed_bonus_exclusion',
      'wallet_reconciliation',
      'admin_wallet_reconciliation',
      'migration',
      'migration_backfill',
      'backfill',
      'rollback',
      'admin_correction'
    )
    OR lower(COALESCE(p_description, '')) LIKE ANY (ARRAY[
      '%internal accounting adjustment%',
      '%accounting adjustment%',
      '%reconciliation entry%',
      '%reconciliation adjustment%',
      '%migration entry%',
      '%migration adjustment%',
      '%rollback entry%',
      '%rollback correction%',
      '%backfill correction%',
      '%erroneous%backfill%',
      '%administrative balance correction%',
      '%admin balance correction%',
      '%balance correction%',
      '%reversal:%erroneous%'
    ])
    OR COALESCE(p_reference_id, '') ~* '^(ADMIN|ADJ|CORR|RECON|MIG|ROLLBACK|BACKFILL)-'
    OR (
      COALESCE(p_source_table, '') = 'commission_engine'
      AND COALESCE(p_category, '') = 'agent_commission'
      AND COALESCE(p_description, '') = 'Bonus: Landlord float disbursed for registered tenant'
      AND EXISTS (
        SELECT 1
        FROM public.commission_accrual_ledger cal
        WHERE cal.agent_id = p_user_id
          AND cal.event_type = 'rent_funded_landlord_float'
          AND cal.status = 'reversed'
          AND cal.source_id = p_source_id::text
      )
    )
  )
$$;

CREATE OR REPLACE FUNCTION public.is_customer_wallet_history_visible(
  p_classification text,
  p_category text,
  p_source_table text,
  p_description text,
  p_reference_id text DEFAULT NULL
)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT public.is_customer_wallet_history_visible(
    NULL::uuid,
    p_classification,
    p_category,
    p_source_table,
    p_description,
    p_reference_id,
    NULL::uuid
  )
$$;

ALTER POLICY "Users can view own ledger entries"
ON public.general_ledger
USING (
  auth.uid() = user_id
  AND public.is_customer_wallet_history_visible(
    user_id,
    classification,
    category,
    source_table,
    description,
    reference_id,
    source_id
  )
);