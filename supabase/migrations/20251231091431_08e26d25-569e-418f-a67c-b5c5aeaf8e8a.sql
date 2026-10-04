-- Create function to notify buyer when order status changes
CREATE OR REPLACE FUNCTION public.notify_order_status_change()
RETURNS TRIGGER AS $$
DECLARE
  product_name TEXT;
  status_message TEXT;
  notification_type TEXT;
BEGIN
  -- Only trigger on status change
  IF OLD.status IS DISTINCT FROM NEW.status THEN
    -- Get product name
    SELECT name INTO product_name FROM public.products WHERE id = NEW.product_id;
    
    -- Set message based on status
    CASE NEW.status
      WHEN 'processing' THEN
        status_message := 'Your order for "' || COALESCE(product_name, 'Product') || '" is now being processed.';
        notification_type := 'info';
      WHEN 'shipped' THEN
        status_message := 'Great news! Your order for "' || COALESCE(product_name, 'Product') || '" has been shipped.';
        notification_type := 'success';
      WHEN 'delivered' THEN
        status_message := 'Your order for "' || COALESCE(product_name, 'Product') || '" has been delivered. Enjoy!';
        notification_type := 'success';
      WHEN 'cancelled' THEN
        status_message := 'Your order for "' || COALESCE(product_name, 'Product') || '" has been cancelled.';
        notification_type := 'warning';
      ELSE
        status_message := 'Your order for "' || COALESCE(product_name, 'Product') || '" status updated to: ' || NEW.status;
        notification_type := 'info';
    END CASE;
    
    -- Insert notification for buyer
    INSERT INTO public.notifications (user_id, title, message, type, metadata)
    VALUES (
      NEW.buyer_id,
      'Order Status Update',
      status_message,
      notification_type,
      jsonb_build_object('order_id', NEW.id, 'product_id', NEW.product_id, 'status', NEW.status)
    );
  END IF;
  
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- Create trigger on product_orders table
DROP TRIGGER IF EXISTS on_order_status_change ON public.product_orders;
CREATE TRIGGER on_order_status_change
  AFTER UPDATE ON public.product_orders
  FOR EACH ROW
  EXECUTE FUNCTION public.notify_order_status_change();