-- Create function to notify users when wishlist products go on sale
CREATE OR REPLACE FUNCTION public.notify_wishlist_price_drop()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  wishlist_user RECORD;
  discount_message TEXT;
BEGIN
  -- Only trigger when discount is added or increased
  IF (
    (OLD.discount_percentage IS NULL OR OLD.discount_percentage = 0) 
    AND NEW.discount_percentage > 0
  ) OR (
    NEW.discount_percentage > COALESCE(OLD.discount_percentage, 0)
  ) THEN
    -- Calculate discounted price
    discount_message := NEW.name || ' is now ' || NEW.discount_percentage || '% off! Price dropped to UGX ' || 
      ROUND(NEW.price * (1 - NEW.discount_percentage::numeric / 100))::text;
    
    -- Notify all users who have this product in their wishlist
    FOR wishlist_user IN 
      SELECT user_id FROM public.wishlists WHERE product_id = NEW.id
    LOOP
      INSERT INTO public.notifications (user_id, title, message, type, metadata)
      VALUES (
        wishlist_user.user_id,
        '🔥 Price Drop Alert!',
        discount_message,
        'success',
        jsonb_build_object(
          'product_id', NEW.id, 
          'product_name', NEW.name,
          'discount_percentage', NEW.discount_percentage,
          'original_price', NEW.price,
          'discounted_price', ROUND(NEW.price * (1 - NEW.discount_percentage::numeric / 100))
        )
      );
    END LOOP;
  END IF;
  
  RETURN NEW;
END;
$$;

-- Create trigger for price drop notifications
DROP TRIGGER IF EXISTS on_product_price_drop ON public.products;
CREATE TRIGGER on_product_price_drop
  AFTER UPDATE ON public.products
  FOR EACH ROW
  EXECUTE FUNCTION public.notify_wishlist_price_drop();