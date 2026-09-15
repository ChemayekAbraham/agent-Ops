-- READ-ONLY verification harness for the tenant-payment custody prototype.
-- Adds no rows: the prototype legs are modelled in a VALUES list and layered on
-- top of the live reporting resolver sofp_ledger_legs().
--
-- Scenarios: 3 collections (two for the same tenant, three for the same agent),
-- then a partial banking and a final banking of the same custody balance.

WITH base AS (
  SELECT account_code ac, SUM(dr) dr, SUM(cr) cr FROM sofp_ledger_legs(now()) GROUP BY 1
), sim(scenario, ac, dr, cr) AS (VALUES
  ('S1 collect 100k','A5',100000::numeric,0::numeric),('S1 collect 100k','A3',0,100000),
  ('S1 commission','X3',10000,0),                     ('S1 commission','L1',0,10000),
  ('S2 collect 50k (same tenant)','A5',50000,0),      ('S2 collect 50k (same tenant)','A3',0,50000),
  ('S3 collect 25k (same agent)','A5',25000,0),       ('S3 collect 25k (same agent)','A3',0,25000),
  ('S4 bank 100k (partial)','A1',100000,0),           ('S4 bank 100k (partial)','A5',0,100000),
  ('S5 bank 75k (full)','A1',75000,0),                ('S5 bank 75k (full)','A5',0,75000)
), agg AS (SELECT ac, SUM(dr) dr, SUM(cr) cr FROM sim GROUP BY 1)
SELECT COALESCE(b.ac,a.ac) account,
       COALESCE(b.dr,0)-COALESCE(b.cr,0)                             AS before_bal,
       COALESCE(b.dr,0)+COALESCE(a.dr,0)-COALESCE(b.cr,0)-COALESCE(a.cr,0) AS prototype_bal
FROM base b FULL JOIN agg a ON a.ac=b.ac
ORDER BY 1;

-- Test 8  Debits = Credits (must be 0.00 before and after; sim legs self-balance)
SELECT SUM(dr)-SUM(cr) AS trial_balance_difference FROM sofp_ledger_legs(now());

-- Test 9  Assets + Expenses = Liabilities + Equity + Revenue
SELECT c.nature, SUM(l.dr)-SUM(l.cr) AS bal
FROM sofp_ledger_legs(now()) l JOIN ledger_account_catalog c ON c.code=l.account_code
GROUP BY 1 ORDER BY 1;

-- Test 10 Independent operational rebuild (does not use the reporting resolver)
SELECT (SELECT SUM(rent_amount)-SUM(amount_repaid) FROM rent_requests
          WHERE status IN ('funded','repaying','completed'))            AS tenant_receivable_operational,
       (SELECT SUM(float_balance) FROM wallets)                         AS agent_float_cache,
       (SELECT SUM(amount) FROM agent_collections)                      AS collections_recorded;
