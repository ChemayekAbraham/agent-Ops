-- Drop detector functions first (so they don't error during table drops)
DROP FUNCTION IF EXISTS public.detect_phantom_wallet_drift() CASCADE;
DROP FUNCTION IF EXISTS public.detect_withdrawable_drift_alerts() CASCADE;
DROP FUNCTION IF EXISTS public.test_drift_uses_strict_pivot() CASCADE;
DROP FUNCTION IF EXISTS public.resolve_phantom_drift(uuid, text) CASCADE;
DROP FUNCTION IF EXISTS public.resolve_phantom_drift(uuid, uuid, text) CASCADE;

-- Drop the observation-only drift tables
DROP TABLE IF EXISTS public.phantom_wallet_drift CASCADE;
DROP TABLE IF EXISTS public.phantom_drift_test_runs CASCADE;
DROP TABLE IF EXISTS public.phantom_drift_run_audit CASCADE;
DROP TABLE IF EXISTS public.phantom_drift_run_user_audit CASCADE;
DROP TABLE IF EXISTS public.phantom_freeze_audit CASCADE;
DROP TABLE IF EXISTS public.wallet_withdrawable_drift_alerts CASCADE;
DROP TABLE IF EXISTS public.wallet_historical_drift_review CASCADE;
DROP TABLE IF EXISTS public.wallet_drift_alert_config CASCADE;
DROP TABLE IF EXISTS public.wallet_commission_drift CASCADE;