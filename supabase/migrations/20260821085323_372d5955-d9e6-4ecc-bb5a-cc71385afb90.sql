-- Financial correction audit rows are immutable (delete is blocked by trigger),
-- so they must not be tied to auth.users lifecycle. Decouple the FKs while
-- keeping the stored user ids for reference/audit purposes.
ALTER TABLE public.platform_wallet_corrections
  DROP CONSTRAINT IF EXISTS platform_wallet_corrections_target_user_id_fkey;

ALTER TABLE public.platform_wallet_corrections
  DROP CONSTRAINT IF EXISTS platform_wallet_corrections_created_by_fkey;

COMMENT ON COLUMN public.platform_wallet_corrections.target_user_id IS 'auth.users id of the wallet owner at correction time. Intentionally not a foreign key: these audit rows are permanent and must survive account deletion.';
COMMENT ON COLUMN public.platform_wallet_corrections.created_by IS 'auth.users id of the operator. Intentionally not a foreign key: these audit rows are permanent and must survive account deletion.';