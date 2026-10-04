-- Create function to notify agent when product stock is low
CREATE OR REPLACE FUNCTION public.notify_low_stock()
RETURNS TRIGGER AS $$
DECLARE
  low_stock_threshold INTEGER := 5;
BEGIN
  -- Only trigger when stock decreases and crosses the threshold
  IF NEW.stock < low_stock_threshold AND OLD.stock >= low_stock_threshold THEN
    INSERT INTO public.notifications (user_id, title, message, type, metadata)
    VALUES (
      NEW.agent_id,
      'Low Stock Alert',
      'Your product "' || NEW.name || '" is running low with only ' || NEW.stock || ' items left.',
      'warning',
      jsonb_build_object('product_id', NEW.id, 'stock', NEW.stock, 'product_name', NEW.name)
    );
  -- Also notify when stock reaches zero
  ELSIF NEW.stock = 0 AND OLD.stock > 0 THEN
    INSERT INTO public.notifications (user_id, title, message, type, metadata)
    VALUES (
      NEW.agent_id,
      'Out of Stock!',
      'Your product "' || NEW.name || '" is now out of stock. Restock soon to avoid losing sales.',
      'alert',
      jsonb_build_object('product_id', NEW.id, 'stock', 0, 'product_name', NEW.name)
    );
  END IF;
  
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- Create trigger on products table
DROP TRIGGER IF EXISTS on_low_stock ON public.products;
CREATE TRIGGER on_low_stock
  AFTER UPDATE ON public.products
  FOR EACH ROW
  WHEN (OLD.stock IS DISTINCT FROM NEW.stock)
  EXECUTE FUNCTION public.notify_low_stock();