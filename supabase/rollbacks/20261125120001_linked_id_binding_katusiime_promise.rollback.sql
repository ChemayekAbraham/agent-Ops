-- Rolls back 20261125120001_linked_id_binding_katusiime_promise.sql
-- Puts Katusiime Promise's identity binding back to 'user_capture'. The withdrawal ID gate
-- will then ignore her active link again and block her withdrawals.
UPDATE public.user_identity_bindings
   SET capture_source = 'user_capture'
 WHERE id = '6f94a83a-4d1f-4c69-98dc-81c67080da59'
   AND user_id = '1eaa4087-a367-463a-8bb0-aba1ed59524f'
   AND capture_source = 'linked_id_owner';
