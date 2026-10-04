REVOKE EXECUTE ON FUNCTION public.get_money_at_bank_reconciliation() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_money_at_bank_reconciliation() TO authenticated;

REVOKE EXECUTE ON FUNCTION public.get_money_at_bank_total() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_money_at_bank_total() TO authenticated;