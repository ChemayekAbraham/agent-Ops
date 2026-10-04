ALTER TABLE public.merchandise_purchases
  ADD COLUMN IF NOT EXISTS buyer_id uuid REFERENCES auth.users(id),
  ADD COLUMN IF NOT EXISTS buyer_name text,
  ADD COLUMN IF NOT EXISTS buyer_phone text;

CREATE OR REPLACE FUNCTION public.create_purchase_recovery_plan()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_customer uuid;
  v_name text;
BEGIN
  -- Only recover when there is a cost to recover.
  IF COALESCE(NEW.total_cost, 0) <= 0 THEN
    RETURN NEW;
  END IF;

  -- Resolve the buyer: explicit linked account first, then phone match.
  v_customer := NEW.buyer_id;
  IF v_customer IS NULL AND NEW.buyer_phone IS NOT NULL
     AND public.normalize_phone_9(NEW.buyer_phone) <> '' THEN
    SELECT id INTO v_customer
    FROM public.profiles
    WHERE public.normalize_phone_9(phone) = public.normalize_phone_9(NEW.buyer_phone)
    LIMIT 1;
  END IF;

  -- No registered buyer: keep it as a plain purchase, no wallet recovery.
  IF v_customer IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT full_name INTO v_name FROM public.profiles WHERE id = v_customer;

  INSERT INTO public.merchandise_recovery_plans (
    sale_id, customer_id, customer_name, customer_phone, item_name,
    original_amount, outstanding_balance, daily_rate, created_by
  ) VALUES (
    NULL, v_customer, COALESCE(v_name, NEW.buyer_name), NEW.buyer_phone, NEW.item_name,
    NEW.total_cost, NEW.total_cost, 0.15, NEW.created_by
  );

  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_create_purchase_recovery_plan ON public.merchandise_purchases;
CREATE TRIGGER trg_create_purchase_recovery_plan
  AFTER INSERT ON public.merchandise_purchases
  FOR EACH ROW EXECUTE FUNCTION public.create_purchase_recovery_plan();