CREATE OR REPLACE FUNCTION public.sync_supported_houses_on_review()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF NEW.source <> 'self_managed_house' OR NEW.commitment_id IS NULL THEN
    RETURN NEW;
  END IF;
  IF NEW.status = 'approved' AND COALESCE(OLD.status,'') <> 'approved' THEN
    UPDATE public.partner_supported_houses
       SET status='active', activated_at=now(), updated_at=now()
     WHERE commitment_id = NEW.commitment_id AND status='pending';
    UPDATE public.partner_self_commitments
       SET status='active', updated_at=now()
     WHERE id = NEW.commitment_id AND status <> 'active';
  ELSIF NEW.status = 'rejected' AND COALESCE(OLD.status,'') <> 'rejected' THEN
    UPDATE public.partner_supported_houses
       SET status='cancelled', cancelled_at=now(), updated_at=now(),
           proxy_fee_status = CASE WHEN proxy_fee_status = 'pending' THEN 'cancelled' ELSE proxy_fee_status END
     WHERE commitment_id = NEW.commitment_id AND status='pending';
    UPDATE public.partner_self_commitments
       SET status='cancelled', updated_at=now()
     WHERE id = NEW.commitment_id AND status='pending_ops_approval';
  END IF;
  RETURN NEW;
END;
$function$
