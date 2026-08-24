DROP TRIGGER IF EXISTS on_wallet_transaction_first_bonus ON public.wallet_transactions;
DROP TRIGGER IF EXISTS on_repayment_first_bonus ON public.repayments;
DROP TRIGGER IF EXISTS on_deposit_first_bonus ON public.wallet_deposits;
DROP TRIGGER IF EXISTS on_product_order_first_bonus ON public.product_orders;
DROP TRIGGER IF EXISTS on_loan_repayment_first_bonus ON public.user_loan_repayments;

ALTER TABLE public.referrals ALTER COLUMN first_transaction_bonus_amount SET DEFAULT 0;