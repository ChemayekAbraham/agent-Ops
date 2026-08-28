DO $mig$
DECLARE
  v_def text;
  v_new text;
  v_oid oid;
  v_agg_old text := $t$        'total_value', COALESCE(sum(value),0),
        'paid', COALESCE(sum(paid),0),
        'outstanding', COALESCE(sum(outstanding),0),$t$;
  v_agg_new text := $t$        'total_value', COALESCE(sum(value) FILTER (WHERE is_issued),0),
        'paid', COALESCE(sum(paid) FILTER (WHERE is_issued),0),
        'outstanding', COALESCE(sum(outstanding) FILTER (WHERE is_issued),0),$t$;
  v_prod_old text := $t$           ms.payment_status, ms.order_status, ms.payment_plan,$t$;
  v_prod_new text := $t$           ms.payment_status, ms.order_status, ms.payment_plan,
           (ms.order_status IN ('approved','processing','completed','disbursed','active')
             OR ms.cfo_disbursed_at IS NOT NULL
             OR ms.lease_activated_at IS NOT NULL) AS is_issued,$t$;
BEGIN
  FOR v_oid IN
    SELECT p.oid FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'get_agent_products_services_report'
  LOOP
    v_def := pg_get_functiondef(v_oid);
    v_new := v_def;

    -- ensure the is_issued flag exists in the product CTE
    IF position('is_issued' in v_new) = 0 THEN
      IF position(v_prod_old in v_new) = 0 THEN
        RAISE EXCEPTION 'prod CTE anchor not found for oid %', v_oid;
      END IF;
      v_new := replace(v_new, v_prod_old, v_prod_new);
    END IF;

    IF position(v_agg_old in v_new) = 0 THEN
      RAISE EXCEPTION 'bike/phone aggregate anchor not found for oid %', v_oid;
    END IF;
    v_new := replace(v_new, v_agg_old, v_agg_new);

    -- also gate the pending-aware daily receivable / row filters consistently
    v_new := replace(v_new,
      $t$'daily_receivable', COALESCE(sum(daily_rate) FILTER (WHERE outstanding > 0),0)$t$,
      $t$'daily_receivable', COALESCE(sum(daily_rate) FILTER (WHERE is_issued AND outstanding > 0),0)$t$);

    EXECUTE v_new;
  END LOOP;
END
$mig$;