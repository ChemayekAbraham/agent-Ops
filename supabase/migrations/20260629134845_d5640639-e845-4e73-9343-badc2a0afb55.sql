CREATE OR REPLACE VIEW public.wallets
WITH (security_invoker = on) AS
SELECT
  wp.id,
  wp.user_id,
  COALESCE((v.j ->> 'total_visible')::numeric, 0::numeric)   AS balance,
  wp.created_at,
  wp.updated_at,
  wp.locked_balance,
  wp.currency,
  COALESCE((v.j ->> 'withdrawable')::numeric, 0::numeric)    AS withdrawable_balance,
  COALESCE((v.j ->> 'float_balance')::numeric, 0::numeric)   AS float_balance,
  COALESCE((v.j ->> 'advance_balance')::numeric, 0::numeric) AS advance_balance
FROM public.wallets_physical wp
LEFT JOIN LATERAL public.get_user_wallet_view(wp.user_id) AS v(j) ON true;