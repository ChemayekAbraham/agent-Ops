DROP TRIGGER IF EXISTS trg_enforce_collection_lock ON public.agent_collections;
DROP FUNCTION IF EXISTS public.enforce_collection_lock();

UPDATE public.rent_requests
SET collection_locked_at = NULL,
    collection_locked_reason = NULL,
    collection_lock_days = NULL
WHERE collection_locked_at IS NOT NULL;