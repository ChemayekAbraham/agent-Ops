
DO $$
DECLARE
  rec RECORD;
  correction_amount NUMERIC;
BEGIN
  FOR rec IN 
    SELECT gl.user_id,
      SUM(
        CASE 
          WHEN gl.direction = 'cash_in' THEN gl.amount
          WHEN gl.direction = 'cash_out' THEN -gl.amount
        END
      ) AS balance
    FROM general_ledger gl
    WHERE gl.ledger_scope = 'wallet'
    GROUP BY gl.user_id
    HAVING SUM(
      CASE 
        WHEN gl.direction = 'cash_in' THEN gl.amount
        WHEN gl.direction = 'cash_out' THEN -gl.amount
      END
    ) < 0
  LOOP
    BEGIN
      correction_amount := ABS(rec.balance);

      RAISE NOTICE 'Fixing user % | Amount: %', rec.user_id, correction_amount;

      PERFORM create_ledger_transaction(
        jsonb_build_array(
          jsonb_build_object(
            'user_id', rec.user_id,
            'ledger_scope', 'wallet',
            'direction', 'cash_in',
            'amount', correction_amount,
            'category', 'system_balance_correction',
            'source_table', 'system'
          ),
          jsonb_build_object(
            'ledger_scope', 'platform',
            'direction', 'cash_out',
            'amount', correction_amount,
            'category', 'system_balance_correction',
            'source_table', 'system'
          )
        )
      );

    EXCEPTION WHEN OTHERS THEN
      RAISE NOTICE 'FAILED for user %: %', rec.user_id, SQLERRM;
    END;
  END LOOP;
END $$;
