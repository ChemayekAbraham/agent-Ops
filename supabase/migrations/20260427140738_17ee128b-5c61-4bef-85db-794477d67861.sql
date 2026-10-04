DO $$
DECLARE
  rec RECORD;
  partner_uuid uuid;
  portfolio_uuid uuid;
  i INT;
BEGIN
  FOR rec IN
    SELECT * FROM (VALUES
      ('WIP2601253293', 'ae194750-4827-47e8-839e-5e772565138b'::uuid, 260000, 2, 'rev-dup-WIP2601253293'),
      ('WIP2604031412', 'ae194750-4827-47e8-839e-5e772565138b'::uuid, 100000, 1, 'rev-dup-WIP2604031412'),
      ('WIP2503248054', 'ae194750-4827-47e8-839e-5e772565138b'::uuid, 1000000, 1, 'rev-dup-WIP2503248054'),
      ('WIP2603092070', 'b4d7c324-1f7e-4e1c-91a8-3f0e10e0b25c'::uuid, 1000000, 4, 'rev-dup-WIP2603092070')
    ) AS t(portfolio_code, sender_id, dup_amount, num_extras, base_idem)
  LOOP
    SELECT id, COALESCE(investor_id, agent_id)
      INTO portfolio_uuid, partner_uuid
    FROM public.investor_portfolios
    WHERE portfolio_code = rec.portfolio_code
    LIMIT 1;

    IF portfolio_uuid IS NULL THEN
      RAISE NOTICE 'Skipping % — portfolio not found', rec.portfolio_code;
      CONTINUE;
    END IF;

    FOR i IN 1..rec.num_extras LOOP
      PERFORM public.create_ledger_transaction(
        jsonb_build_array(
          jsonb_build_object(
            'user_id', rec.sender_id,
            'amount', rec.dup_amount,
            'direction', 'cash_in',
            'category', 'system_balance_correction',
            'ledger_scope', 'wallet',
            'description', 'Reversal of duplicate Portfolio top-up: ' || rec.portfolio_code || ' (extra #' || i || ')',
            'source_table', 'investor_portfolios',
            'source_id', portfolio_uuid::text,
            'linked_party', 'platform',
            'currency', 'UGX'
          ),
          jsonb_build_object(
            'user_id', partner_uuid,
            'amount', rec.dup_amount,
            'direction', 'cash_out',
            'category', 'system_balance_correction',
            'ledger_scope', 'platform',
            'description', 'Reversal of duplicate Portfolio top-up: ' || rec.portfolio_code || ' (extra #' || i || ')',
            'source_table', 'investor_portfolios',
            'source_id', portfolio_uuid::text,
            'linked_party', 'platform',
            'currency', 'UGX'
          )
        ),
        rec.base_idem || '-' || i,
        TRUE
      );
    END LOOP;
  END LOOP;
END $$;

-- Recompute affected wallets
SELECT public.recompute_wallet_buckets('ae194750-4827-47e8-839e-5e772565138b');
SELECT public.recompute_wallet_buckets('b4d7c324-1f7e-4e1c-91a8-3f0e10e0b25c');
SELECT public.recompute_wallet_buckets(COALESCE(investor_id, agent_id))
  FROM public.investor_portfolios
  WHERE portfolio_code IN ('WIP2601253293','WIP2604031412','WIP2503248054','WIP2603092070');