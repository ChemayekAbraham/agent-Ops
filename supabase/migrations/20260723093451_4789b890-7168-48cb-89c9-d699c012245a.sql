
CREATE INDEX IF NOT EXISTS idx_gl_user_scope_created_plain
  ON public.general_ledger (user_id, ledger_scope, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_gl_user_scope_txdate_plain
  ON public.general_ledger (user_id, ledger_scope, transaction_date DESC);

ANALYZE public.general_ledger;
ANALYZE public.landlords;
ANALYZE public.wallets;
ANALYZE public.profiles;
