
-- Clean up orphaned roles and wallet for deleted user lolem ipsum
DELETE FROM public.user_roles WHERE user_id = '94188235-80ec-41f7-b2b4-0ba4a9e70a4c';
DELETE FROM public.wallets WHERE user_id = '94188235-80ec-41f7-b2b4-0ba4a9e70a4c';
DELETE FROM public.notifications WHERE user_id = '94188235-80ec-41f7-b2b4-0ba4a9e70a4c';
DELETE FROM public.ai_chat_messages WHERE user_id = '94188235-80ec-41f7-b2b4-0ba4a9e70a4c';
DELETE FROM public.push_subscriptions WHERE user_id = '94188235-80ec-41f7-b2b4-0ba4a9e70a4c';
DELETE FROM public.credit_access_limits WHERE user_id = '94188235-80ec-41f7-b2b4-0ba4a9e70a4c';

-- Also delete the auth user to fully kill the account
DELETE FROM auth.users WHERE id = '94188235-80ec-41f7-b2b4-0ba4a9e70a4c';
