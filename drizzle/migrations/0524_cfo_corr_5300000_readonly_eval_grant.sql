-- Read-only verification access for the correction pre-flight evaluator (STABLE, reads only; cannot post).
GRANT EXECUTE ON FUNCTION public._cfo_corr_5300000_evaluate() TO supabase_read_only_user;
GRANT EXECUTE ON FUNCTION public._cfo_corr_5300000_hash() TO supabase_read_only_user;
GRANT EXECUTE ON FUNCTION public._cfo_corr_5300000_acct(text) TO supabase_read_only_user;
GRANT EXECUTE ON FUNCTION public._cfo_corr_5300000_group_ok(text,text,text,text,numeric) TO supabase_read_only_user;