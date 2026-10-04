-- Follow-up to 20260915103000_duplicate_email_alias_account_cleanup.sql:
-- Josh Wanda asked for these 27 duplicate/alias accounts to be permanently
-- purged rather than left soft-deleted. An evidence export (names, emails,
-- phones, national IDs, lifetime cash-in/withdrawn) was taken before this ran.
--
-- general_ledger and wallets have no FK to profiles/auth.users (verified live:
-- pg_constraint has no entry for either), so this purge does NOT touch the
-- transaction history — the money trail survives as evidence regardless of
-- this cleanup. profiles.id -> auth.users.id is ON DELETE CASCADE, so deleting
-- the auth.users row removes the profile automatically; admin_purge_user_dependencies
-- clears every other blocking reference first, same as delete-user's
-- permanent-mode path.
--
-- NOTE: public.wallets is a VIEW (wallets_physical + wallet_balances_projection),
-- not a table, on this environment — confirmed live before running. Delete the
-- underlying physical row instead of the view.

DO $$
DECLARE
  v_ids uuid[] := ARRAY[
    '407b6a17-75b8-4cfd-a3db-ce034989c0c4','9dee68b0-ced2-4ea4-8031-3b5ebcba5f68',
    '55bfa48b-a21a-429d-ae57-68158cd04143','d6afe497-1363-415e-ac0c-c5de53359293',
    '5a645220-7abd-439b-b960-3002f021991d','071749f2-0150-4572-8da6-6de8b000c094',
    '2d036028-02b5-4f29-8433-fdd011e353e1','45dda3b2-1f04-459a-915c-825e5daec6bf',
    'b8c1dda6-9ad2-46d6-821c-9aa8940178cd','b8c0bff7-c707-4617-af58-97e04344ea9e',
    '081f99df-b96b-464a-9b99-3ff41d737169','03456a46-c7d0-4875-ab26-e210dfc72ceb',
    '47e8fd53-694e-402e-9192-e9567604bad7',
    'ae474e60-b0f6-4b1a-9c8a-7039bbc0b594','44aa235e-f137-4f36-aa61-c26f2d6c7bd9',
    'a27650b6-347f-4728-b70b-4bd92fd14ced','dd7e88ae-53cb-44c9-bf20-de7337dfa2ee',
    '4cc7c760-43a1-4890-9799-ad3804a38318','bd608de8-44b1-4109-b7ee-0de35a7a9a45',
    'c3e886f1-1d64-4a96-a6f9-2e63aa4f9c89','ee40822a-ebb2-461f-bebe-d73b690ac95f',
    'f7cf9062-e07e-4c2e-ad53-936bf161f764','4f0ba443-164d-40b3-8237-b8b5b146666a',
    '76c88499-829e-4678-a9de-001cba8bbabb',
    '90e33f86-fb12-462d-96ea-e0ac9eaf8e18','cff0ce36-1276-41c5-b2b1-51a50846c3a5',
    '3d9e3431-32aa-49d6-809f-7a603265d18a'
  ];
  v_id uuid;
  v_actor uuid := 'cb798acb-68bc-4b4e-a414-a3d374e030b6';
  v_reason text := 'Permanent purge of confirmed duplicate/alias accounts (shared-email cluster), per Josh Wanda decision 2026-09-15. Evidence exported before purge; ledger history untouched (no FK to profiles).';
BEGIN
  FOREACH v_id IN ARRAY v_ids LOOP
    PERFORM public.admin_purge_user_dependencies(v_id);

    DELETE FROM public.wallets_physical WHERE user_id = v_id;
    DELETE FROM public.wallet_balances_projection WHERE user_id = v_id;
    DELETE FROM public.referrals WHERE referrer_id = v_id OR referred_id = v_id;
    DELETE FROM public.notifications WHERE user_id = v_id;
    DELETE FROM public.ai_chat_messages WHERE user_id = v_id;
    DELETE FROM public.supporter_referrals WHERE referrer_id = v_id OR referred_id = v_id;
    DELETE FROM public.investment_withdrawal_requests WHERE user_id = v_id;
    DELETE FROM public.credit_access_limits WHERE user_id = v_id;
    DELETE FROM public.agent_earnings WHERE agent_id = v_id;
    DELETE FROM public.earning_baselines WHERE user_id = v_id;
    DELETE FROM public.earning_predictions WHERE user_id = v_id;
    DELETE FROM public.deposit_requests WHERE user_id = v_id;
    DELETE FROM public.cart_items WHERE user_id = v_id;

    UPDATE public.supporter_invites
       SET status = 'cancelled'
     WHERE activated_user_id = v_id OR created_by = v_id OR parent_agent_id = v_id;

    DELETE FROM auth.users WHERE id = v_id;

    UPDATE public.deleted_accounts
       SET status = 'purged', purged_at = now(), purged_by = v_actor, purge_reason = v_reason
     WHERE user_id = v_id AND status = 'soft_deleted';

    INSERT INTO public.audit_logs (user_id, action_type, action, table_name, record_id, metadata)
    VALUES (v_actor, 'delete_account', 'delete_account', 'auth.users', v_id::text,
      jsonb_build_object('reason', v_reason, 'target_user_id', v_id, 'performed_by', v_actor, 'hard_delete', true, 'bulk_remediation', true));
  END LOOP;
END $$;
