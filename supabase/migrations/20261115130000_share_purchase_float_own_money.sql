-- Angel Pool share purchases paid through the buyer's float: the buyer's own money, not a receivable.
-- CFO confirmation 11 Nov 2026. Accounting classification only: posts nothing and moves no money.
--
-- Facts (CFO, 11 Nov 2026): the shareholders whose purchases went through their operational float (Pius Lubega
-- Ssenkaali, Kabahuma Lillian, Atengei Esther, Nalikka Hilda, Akuza Mumo Ntumwa, Kitiibwa Mulei Ntumwa, Ayinza Kasyoka
-- Ntumwa: 7 purchases, UGX 3,352,500) deposited their own money with the company; the company then used the float to
-- buy the shares. Their float was credited when the money came in (DR A2 float with agents / CR A8 float cycle control,
-- or a move from their own wallet balance).
--
-- 20261111090100 mapped the float leg of these purchases to A26 "Receivable from shareholders", i.e. as if the buyer
-- had used company money and owed it back. That is wrong for money the buyer paid in. The float leg now debits A8
-- (Agent and Merchant Float Cycle Control): it closes the float-control credit raised when their money was booked as
-- float, so the company shows the cash it received against share capital (E1), with nothing owed by the buyer.
--
-- Effect (all 7 existing purchases and any future one, through the account map): A26 3,352,500 -> 0;
-- A8 +3,352,500; E1 and every cash account unchanged; each purchase group still balances on the base mapping, so the
-- share functions' balanced-posting check (supabase/functions/_shared/balancedLedgerPost.ts) is unaffected.
-- Rollback: supabase/rollbacks/20261115130000_share_purchase_float_own_money.rollback.sql

UPDATE public.ledger_account_map
   SET account_code = 'A8',
       notes = 'Angel Pool shares bought through the buyer''s float with money the buyer deposited: closes the float-control credit (CFO 11 Nov 2026; replaces A26)'
 WHERE ledger_scope = 'wallet' AND category = 'share_capital' AND wallet_bucket = 'float'
   AND account_code = 'A26' AND debit_when = 'cash_out';

DO $$ BEGIN
  IF (SELECT count(*) FROM public.ledger_account_map
       WHERE ledger_scope = 'wallet' AND category = 'share_capital' AND wallet_bucket = 'float'
         AND account_code = 'A8' AND debit_when = 'cash_out') <> 1 THEN
    RAISE EXCEPTION 'STOP: the wallet/share_capital/float mapping is not the expected A26 row';
  END IF;
END $$;
