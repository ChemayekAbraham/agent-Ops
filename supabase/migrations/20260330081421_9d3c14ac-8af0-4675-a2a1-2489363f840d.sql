-- SAFE TO RUN NOW: Notifications Insert Blocker + System Events Cleanup

-- 1. Silent insert blocker for notifications
CREATE OR REPLACE FUNCTION public.block_all_notification_inserts()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  RETURN NULL;
END;
$$;

-- 2. BEFORE INSERT trigger blocks all notification writes silently
CREATE TRIGGER block_notification_inserts
  BEFORE INSERT ON public.notifications
  FOR EACH ROW
  EXECUTE FUNCTION public.block_all_notification_inserts();

-- 3. Disable all notification-generating triggers on other tables (saves CPU)
ALTER TABLE public.product_orders DISABLE TRIGGER on_order_status_change;
ALTER TABLE public.products DISABLE TRIGGER on_low_stock;
ALTER TABLE public.products DISABLE TRIGGER on_product_price_drop;
ALTER TABLE public.profiles DISABLE TRIGGER on_new_user_signup;
ALTER TABLE public.deposit_requests DISABLE TRIGGER notify_managers_on_new_deposit;
ALTER TABLE public.referrals DISABLE TRIGGER trigger_onboarding_milestone;
ALTER TABLE public.rent_requests DISABLE TRIGGER notify_watchers_on_rent_request_verification;
ALTER TABLE public.rent_requests DISABLE TRIGGER on_new_rent_request_notify_supporters;
ALTER TABLE public.messages DISABLE TRIGGER on_new_chat_message;
ALTER TABLE public.user_roles DISABLE TRIGGER trigger_notify_landlord_registration;
ALTER TABLE public.user_roles DISABLE TRIGGER trigger_notify_landlord_role_enabled;
ALTER TABLE public.withdrawal_requests DISABLE TRIGGER on_withdrawal_status_change;
ALTER TABLE public.rent_requests DISABLE TRIGGER on_rent_request_check_landlord;
ALTER TABLE public.rent_requests DISABLE TRIGGER trg_notify_agents_unverified;

-- 4. Truncate all notification data
TRUNCATE TABLE public.notifications;

-- 5. System events auto-cleanup function
CREATE OR REPLACE FUNCTION public.cleanup_old_system_events()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  DELETE FROM public.system_events
  WHERE created_at < NOW() - INTERVAL '7 days';
END;
$$;

-- 6. Clean up existing old system events
DELETE FROM public.system_events WHERE created_at < NOW() - INTERVAL '7 days';