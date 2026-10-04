
-- Delete duplicate account: sunueli alex (0743331870)
-- User ID: c0266492-7184-4fae-95cb-4e3ad230d0f8
-- Keeping account: Sunueli Alex (0755114078) ID: 3b293a8d-6046-429b-8295-0eb121e88577

DO $$
DECLARE
  target_id uuid := 'c0266492-7184-4fae-95cb-4e3ad230d0f8';
BEGIN
  -- Pre-cleanup: tables with non-nullable FK refs
  DELETE FROM public.agent_advance_topups WHERE topped_up_by = target_id;
  DELETE FROM public.agent_advances WHERE issued_by = target_id;
  DELETE FROM public.agent_advances WHERE agent_id = target_id;
  DELETE FROM public.wallet_transactions WHERE sender_id = target_id OR recipient_id = target_id;
  DELETE FROM public.money_requests WHERE requester_id = target_id OR recipient_id = target_id;
  DELETE FROM public.voided_ledger_entries WHERE voided_by = target_id;
  DELETE FROM public.investor_portfolios WHERE agent_id = target_id;
  UPDATE public.investor_portfolios SET investor_id = NULL, status = 'cancelled' WHERE investor_id = target_id;

  -- Main cleanup
  DELETE FROM public.user_roles WHERE user_id = target_id;
  DELETE FROM public.wallets WHERE user_id = target_id;
  DELETE FROM public.referrals WHERE referrer_id = target_id OR referred_id = target_id;
  DELETE FROM public.notifications WHERE user_id = target_id;
  DELETE FROM public.ai_chat_messages WHERE user_id = target_id;
  DELETE FROM public.push_subscriptions WHERE user_id = target_id;
  DELETE FROM public.supporter_referrals WHERE referrer_id = target_id OR referred_id = target_id;
  DELETE FROM public.investment_withdrawal_requests WHERE user_id = target_id;
  DELETE FROM public.credit_access_limits WHERE user_id = target_id;
  DELETE FROM public.agent_earnings WHERE agent_id = target_id;
  DELETE FROM public.earning_baselines WHERE user_id = target_id;
  DELETE FROM public.earning_predictions WHERE user_id = target_id;
  DELETE FROM public.deposit_requests WHERE user_id = target_id;
  DELETE FROM public.cart_items WHERE user_id = target_id;

  -- Cancel linked supporter invites
  UPDATE public.supporter_invites SET status = 'cancelled'
  WHERE activated_user_id = target_id OR created_by = target_id OR parent_agent_id = target_id;

  -- Delete auth user (cascades profile via trigger/FK)
  DELETE FROM auth.users WHERE id = target_id;

  -- Insert audit log
  INSERT INTO public.audit_logs (action_type, table_name, record_id, metadata)
  VALUES ('account_deletion', 'profiles', target_id::text, 
    jsonb_build_object(
      'reason', 'Duplicate account removal - keeping 0755114078, deleting 0743331870',
      'deleted_phone', '0743331870',
      'kept_account_id', '3b293a8d-6046-429b-8295-0eb121e88577'
    )
  );
END $$;
