CREATE OR REPLACE FUNCTION public.sofp_ledger_legs(p_as_at timestamp with time zone)
 RETURNS TABLE(transaction_group_id uuid, ledger_scope text, category text, source_table text, account_code text, dr numeric, cr numeric, group_one_sided boolean, is_legacy_counterpart boolean)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  -- Reporting-layer resolver for the statement of financial position.
  -- Every general_ledger leg is turned into a debit or a credit against the
  -- reporting chart of accounts (ledger_account_catalog). The base mapping comes
  -- from ledger_account_map; the rules below correct cases where a single ledger
  -- category carries two opposite economics depending on the originating
  -- workflow, which previously placed both legs of a balanced entry on the same
  -- side of the trial balance. NO amount is invented and no ledger row is
  -- touched: only the account and the debit/credit side of existing legs.
  WITH grp_class AS MATERIALIZED (
    SELECT gl.transaction_group_id,
           bool_or(gl.classification IN ('production','legacy_real')
                   OR (gl.classification = 'admin_correction'
                       AND gl.source_table = 'merchant_float_reconciliations')) AS has_reportable
    FROM general_ledger gl
    WHERE gl.transaction_group_id IS NOT NULL
    GROUP BY gl.transaction_group_id
  ), base AS MATERIALIZED (
    SELECT gl.id,
           gl.transaction_group_id AS real_gid,
           COALESCE(gl.transaction_group_id, gl.id) AS gid,
           gl.ledger_scope AS sc,
           gl.category AS cat,
           gl.source_table AS src,
           gl.direction AS dir,
           gl.amount AS amt,
           COALESCE(mb.account_code, mw.account_code,
             CASE WHEN gl.ledger_scope = 'wallet' AND gl.wallet_bucket = 'float'   THEN 'A2'
                  WHEN gl.ledger_scope = 'wallet' AND gl.wallet_bucket = 'advance' THEN 'A4'
                  WHEN gl.ledger_scope = 'wallet'                                  THEN 'L1'
                  ELSE 'A9' END) AS acct0,
           COALESCE(mb.debit_when, mw.debit_when,
             CASE WHEN gl.ledger_scope = 'wallet' AND gl.wallet_bucket IN ('float','advance') THEN 'cash_in'
                  WHEN gl.ledger_scope = 'wallet'                                             THEN 'cash_out'
                  ELSE 'cash_in' END) AS dw0
    FROM general_ledger gl
    LEFT JOIN grp_class g ON g.transaction_group_id = gl.transaction_group_id
    LEFT JOIN ledger_account_map mb
           ON mb.ledger_scope = gl.ledger_scope
          AND mb.category     = gl.category
          AND mb.wallet_bucket IS NOT NULL
          AND mb.wallet_bucket = gl.wallet_bucket
    LEFT JOIN ledger_account_map mw
           ON mw.ledger_scope = gl.ledger_scope
          AND mw.category     = gl.category
          AND mw.wallet_bucket IS NULL
    WHERE gl.transaction_date <= p_as_at
      AND CASE
            WHEN gl.transaction_group_id IS NULL
              THEN gl.classification IN ('production','legacy_real')
            ELSE COALESCE(g.has_reportable, false)
          END
  ), shape AS MATERIALIZED (
    SELECT b.gid,
           count(*) AS n_legs,
           count(*) FILTER (WHERE b.sc = 'wallet') AS n_wallet,
           count(*) FILTER (WHERE b.sc = 'wallet' AND b.acct0 = 'A2') AS n_a2,
           count(*) FILTER (WHERE b.sc = 'wallet' AND b.acct0 = 'L1') AS n_l1,
           count(*) FILTER (WHERE b.sc = 'platform') AS n_plat,
           count(*) FILTER (WHERE b.sc = 'platform' AND b.cat = 'system_balance_correction') AS n_plat_sbc,
           count(*) FILTER (WHERE b.sc = 'platform' AND b.cat IN ('tenant_repayment','tenant_repayment_collected','rent_repayment')) AS n_repay,
           count(*) FILTER (WHERE b.sc = 'platform' AND b.acct0 = 'R1') AS n_rev,
           count(*) FILTER (WHERE b.sc = 'platform' AND b.cat = 'landlord_receivable_collected') AS n_land_recv,
           count(*) FILTER (WHERE b.sc = 'platform' AND b.cat = 'cash_custody_payable') AS n_custody,
           count(*) FILTER (WHERE b.sc = 'platform' AND b.cat = 'wallet_deposit' AND b.dir = 'cash_out') AS n_bank_receipt,
           sum(CASE WHEN b.dir = 'cash_in' THEN b.amt ELSE -b.amt END) AS raw_net
    FROM base b
    GROUP BY b.gid
  ), adj AS MATERIALIZED (
    SELECT b.real_gid, b.gid, b.sc, b.cat, b.src, b.dir, b.amt, s.raw_net,
      CASE
        -- R1  Manual balance corrections: cash returned/paid when the counterpart
        --     is an agent float leg, otherwise an equity adjustment (same
        --     convention as the sibling category platform.balance_correction).
        WHEN b.sc = 'platform' AND b.cat = 'system_balance_correction' AND s.n_a2 > 0 THEN 'A1'
        WHEN b.sc = 'platform' AND b.cat = 'system_balance_correction'                THEN 'E3'
        -- R2  Advances disbursed into agent wallets are receivables, not bank cash.
        WHEN b.sc = 'platform' AND b.cat = 'rent_disbursement' AND b.src = 'agent_advance_requests' THEN 'A4'
        -- R3  Float swept back to the platform to settle a wallet deduction.
        WHEN b.sc = 'platform' AND b.cat LIKE 'wallet_deduction%' AND s.n_a2 > 0 AND s.n_l1 = 0 THEN 'A1'
        -- R3b Wallet deduction taken from a user's own withdrawable balance
        --     (CFO Direct Debit). No cash moved and no advance receivable exists
        --     for these -- they create no debt row -- so the counterpart is a
        --     balance-correction adjustment in equity, exactly as R1 treats
        --     system_balance_correction. Previously these credited A4, driving
        --     the advances receivable account to a ~UGX 1.21bn credit balance
        --     that could not honestly be classified as an asset.
        WHEN b.sc = 'platform' AND b.cat LIKE 'wallet_deduction%' AND s.n_l1 > 0 THEN 'E3'
        -- R4  Withdrawal settled out of agent float: the platform leg IS the
        --     settlement of the custody obligation (no bank payment happened).
        WHEN b.sc = 'platform' AND b.cat = 'wallet_withdrawal' AND s.n_wallet > 0 AND s.n_l1 = 0 THEN 'L1'
        -- R5  Float <-> withdrawable reclass (CFO decision 2026-08): the amount
        --     released to the user's own balance is a cost to the company.
        WHEN b.sc = 'wallet' AND b.acct0 = 'L1'
             AND s.n_wallet = 2 AND s.n_a2 = 1 AND s.n_l1 = 1
             AND (s.n_plat = 0 OR s.n_plat = s.n_plat_sbc) THEN 'X4'
        -- R8  Physical cash deposit credited to a user's WITHDRAWABLE balance.
        --     The float offset leg exists to reverse the A2 debit that a float
        --     deposit's wallet leg creates; a withdrawable deposit has no such
        --     debit (its wallet leg is an L1 custody credit), so the offset was
        --     crediting A2 for float that never moved while L1 was credited
        --     twice for one obligation. Presented as the debit side of the
        --     duplicated custody payable: the group then reads DR A5 / CR L1,
        --     which is what the deposit actually is. Restricted to groups that
        --     carry a wallet leg, so later correction groups that legitimately
        --     reverse an A2 debit posted in an earlier group keep their credit.
        WHEN b.sc = 'platform' AND b.cat = 'agent_float_cash_offset'
             AND s.n_custody > 0 AND s.n_wallet > 0 AND s.n_a2 = 0 THEN 'L1'
        ELSE b.acct0
      END AS acct,
      CASE
        WHEN b.sc = 'platform' AND b.cat = 'system_balance_correction' AND s.n_a2 > 0 THEN 'cash_in'
        WHEN b.sc = 'platform' AND b.cat = 'system_balance_correction'                THEN 'cash_out'
        WHEN b.sc = 'platform' AND b.cat = 'rent_disbursement' AND b.src = 'agent_advance_requests' THEN 'cash_out'
        WHEN b.sc = 'platform' AND b.cat LIKE 'wallet_deduction%' AND s.n_a2 > 0 AND s.n_l1 = 0 THEN 'cash_in'
        -- R3b keeps the leg on the same side it already sits on: the platform
        -- cash_in leg becomes the credit to E3.
        WHEN b.sc = 'platform' AND b.cat LIKE 'wallet_deduction%' AND s.n_l1 > 0 THEN 'cash_out'
        WHEN b.sc = 'platform' AND b.cat = 'wallet_withdrawal' AND s.n_wallet > 0 AND s.n_l1 = 0 THEN b.dir
        WHEN b.sc = 'platform' AND b.cat = 'agent_float_cash_offset'
             AND s.n_custody > 0 AND s.n_wallet > 0 AND s.n_a2 = 0 THEN b.dir
        -- R6  Rent collected by an agent is cash received into float: the wallet
        --     float leg is ALWAYS the debit and the platform receivable leg is
        --     ALWAYS the credit, whichever direction the workflow recorded.
        --     Collections are posted with both direction conventions
        --     ("float used for rent" cash_out and "cash collected and held by
        --     agent" cash_in); keying the side off the recorded direction put
        --     both legs of the entry on the same side for whichever convention
        --     did not match, which is where the trial balance broke.
        WHEN b.sc = 'platform'
             AND b.cat IN ('tenant_repayment','tenant_repayment_collected','rent_repayment',
                           'landlord_receivable_collected')
             AND s.n_a2 > 0
             THEN CASE WHEN b.dir = 'cash_in' THEN 'cash_out' ELSE 'cash_in' END
        WHEN b.sc = 'wallet' AND b.acct0 = 'A2'
             AND (s.n_repay > 0 OR s.n_land_recv > 0) THEN b.dir
        -- R8b Float top-up settled into the company bank (platform A1 debit):
        --     the cash left the agent's hands, so float with agents is credited
        --     and bank cash debited. Two debits previously counted the same
        --     money twice.
        WHEN b.sc = 'wallet' AND b.acct0 = 'A2' AND s.n_bank_receipt > 0
             THEN CASE WHEN b.dir = 'cash_in' THEN 'cash_out' ELSE 'cash_in' END
        -- R7  Platform fees paid out of float: the float leg is the cash received.
        WHEN b.sc = 'wallet' AND b.acct0 = 'A2' AND s.n_rev > 0 THEN b.dir
        WHEN b.sc = 'wallet' AND b.acct0 = 'L1'
             AND s.n_wallet = 2 AND s.n_a2 = 1 AND s.n_l1 = 1
             AND (s.n_plat = 0 OR s.n_plat = s.n_plat_sbc) THEN 'cash_in'
        ELSE b.dw0
      END AS dw
    FROM base b
    JOIN shape s ON s.gid = b.gid
  ), mapped AS MATERIALIZED (
    SELECT a.real_gid, a.gid, a.sc, a.cat, a.src, a.acct, a.raw_net,
           CASE WHEN a.dir = a.dw THEN a.amt ELSE 0 END AS dr,
           CASE WHEN a.dir = a.dw THEN 0 ELSE a.amt END AS cr
    FROM adj a
  ), one_sided AS (
    -- Historic entries where only one side was ever recorded in the ledger
    -- (pre-ledger capital, legacy reseeds, single-leg wallet credits).
    -- The missing side is recognised, per group, in the clearly labelled
    -- equity account E4 and itemised in the reconciliation schedule.
    SELECT m.gid, SUM(m.dr) - SUM(m.cr) AS resid
    FROM mapped m
    GROUP BY m.gid
    HAVING abs(MAX(m.raw_net)) > 0.5 AND abs(SUM(m.dr) - SUM(m.cr)) > 0.5
  )
  SELECT m.real_gid, m.sc, m.cat, m.src, m.acct, m.dr, m.cr,
         (o.gid IS NOT NULL) AS group_one_sided,
         false AS is_legacy_counterpart
  FROM mapped m
  LEFT JOIN one_sided o ON o.gid = m.gid
  UNION ALL
  SELECT NULL::uuid, 'reconciliation', 'legacy_one_sided_counterpart', NULL, 'E4',
         CASE WHEN o.resid < 0 THEN -o.resid ELSE 0 END,
         CASE WHEN o.resid > 0 THEN  o.resid ELSE 0 END,
         true, true
  FROM one_sided o;
$function$;