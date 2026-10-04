-- Create function to send push notification on repayment
CREATE OR REPLACE FUNCTION public.notify_repayment_made()
RETURNS TRIGGER AS $$
DECLARE
  tenant_record RECORD;
  request_record RECORD;
  total_paid NUMERIC;
  remaining NUMERIC;
  progress_percent NUMERIC;
BEGIN
  -- Get tenant info
  SELECT full_name INTO tenant_record FROM public.profiles WHERE id = NEW.tenant_id;
  
  -- Get rent request info
  SELECT total_repayment, daily_repayment INTO request_record 
  FROM public.rent_requests WHERE id = NEW.rent_request_id;
  
  -- Calculate total paid for this request
  SELECT COALESCE(SUM(amount), 0) INTO total_paid
  FROM public.repayments
  WHERE rent_request_id = NEW.rent_request_id;
  
  remaining := request_record.total_repayment - total_paid;
  progress_percent := (total_paid / request_record.total_repayment) * 100;
  
  -- Create in-app notification for tenant
  INSERT INTO public.notifications (user_id, title, message, type, metadata)
  VALUES (
    NEW.tenant_id,
    '✅ Payment Received!',
    'Your payment of UGX ' || NEW.amount::text || ' was received. ' ||
    CASE 
      WHEN remaining <= 0 THEN '🎉 Congratulations! Your loan is fully repaid!'
      ELSE 'Remaining: UGX ' || remaining::text || ' (' || ROUND(progress_percent) || '% complete)'
    END,
    'success',
    jsonb_build_object(
      'amount', NEW.amount,
      'rent_request_id', NEW.rent_request_id,
      'total_paid', total_paid,
      'remaining', remaining,
      'progress_percent', progress_percent
    )
  );
  
  -- Notify agent who registered this tenant (if any)
  INSERT INTO public.notifications (user_id, title, message, type, metadata)
  SELECT 
    rr.agent_id,
    '💰 Tenant Payment',
    COALESCE(tenant_record.full_name, 'A tenant') || ' made a payment of UGX ' || NEW.amount::text,
    'earning',
    jsonb_build_object(
      'tenant_id', NEW.tenant_id,
      'amount', NEW.amount,
      'rent_request_id', NEW.rent_request_id
    )
  FROM public.rent_requests rr
  WHERE rr.id = NEW.rent_request_id AND rr.agent_id IS NOT NULL;
  
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- Create trigger for repayment notifications
DROP TRIGGER IF EXISTS on_repayment_made ON public.repayments;
CREATE TRIGGER on_repayment_made
  AFTER INSERT ON public.repayments
  FOR EACH ROW
  EXECUTE FUNCTION public.notify_repayment_made();