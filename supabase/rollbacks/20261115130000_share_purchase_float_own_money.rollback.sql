-- Rollback of 20261115130000_share_purchase_float_own_money.sql: the float leg of a share purchase debits A26 again.
UPDATE public.ledger_account_map
   SET account_code = 'A26',
       notes = 'Angel Pool shares paid from company float: the shareholder owes the company (CFO 1 Oct and 10 Nov 2026)'
 WHERE ledger_scope = 'wallet' AND category = 'share_capital' AND wallet_bucket = 'float'
   AND account_code = 'A8' AND debit_when = 'cash_out';
