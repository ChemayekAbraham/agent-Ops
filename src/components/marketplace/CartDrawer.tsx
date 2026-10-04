import { useState } from 'react';
import { StorageImage } from '@/components/ui/StorageImage';
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
  SheetFooter,
} from '@/components/ui/sheet';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Separator } from '@/components/ui/separator';
import { 
  ShoppingCart, 
  Package, 
  Plus, 
  Minus, 
  Trash2, 
  Loader2,
  CreditCard 
} from 'lucide-react';
import { useCart } from '@/hooks/useCart';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';

interface CartDrawerProps {
  children?: React.ReactNode;
}

export function CartDrawer({ children }: CartDrawerProps) {
  const { items, loading, itemCount, totalAmount, updateQuantity, removeFromCart, clearCart, refreshCart } = useCart();
  const [checkingOut, setCheckingOut] = useState(false);
  const [open, setOpen] = useState(false);

  const handleCheckout = async () => {
    if (items.length === 0) return;

    setCheckingOut(true);
    try {
      // Process each item in the cart
      for (const item of items) {
        const { data, error } = await supabase.functions.invoke('product-purchase', {
          body: { productId: item.product_id, quantity: item.quantity }
        });

        if (error) throw error;
        if (!data.success) throw new Error(data.error || `Failed to purchase ${item.product.name}`);
      }

      toast.success('Checkout complete!', {
        description: `Successfully purchased ${itemCount} item${itemCount !== 1 ? 's' : ''}`
      });

      await clearCart();
      setOpen(false);
    } catch (error: any) {
      toast.error('Checkout failed', { description: error.message });
      // Refresh cart to get updated stock info
      await refreshCart();
    } finally {
      setCheckingOut(false);
    }
  };

  const defaultTrigger = (
    <Button variant="outline" size="sm" className="relative gap-2">
      <ShoppingCart className="h-4 w-4" />
      Cart
      {itemCount > 0 && (
        <Badge className="absolute -top-2 -right-2 h-5 w-5 p-0 flex items-center justify-center text-xs">
          {itemCount}
        </Badge>
      )}
    </Button>
  );

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        {children || defaultTrigger}
      </SheetTrigger>
      <SheetContent className="flex flex-col w-full sm:max-w-md">
        <SheetHeader>
          <SheetTitle className="flex items-center gap-2">
            <ShoppingCart className="h-5 w-5" />
            Shopping Cart
            {itemCount > 0 && (
              <Badge variant="secondary">{itemCount} item{itemCount !== 1 ? 's' : ''}</Badge>
            )}
          </SheetTitle>
        </SheetHeader>

        {loading ? (
          <div className="flex-1 flex items-center justify-center">
            <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
          </div>
        ) : items.length === 0 ? (
          <div className="flex-1 flex flex-col items-center justify-center text-center">
            <ShoppingCart className="h-16 w-16 text-muted-foreground mb-4" />
            <h3 className="font-medium mb-2">Your cart is empty</h3>
            <p className="text-sm text-muted-foreground mb-4">
              Add products to your cart to checkout
            </p>
            <Button 
              variant="outline" 
              onClick={() => {
                setOpen(false);
                document.getElementById('products-section')?.scrollIntoView({ behavior: 'smooth' });
              }}
            >
              Continue Shopping
            </Button>
          </div>
        ) : (
          <>
            <ScrollArea className="flex-1 -mx-6 px-6">
              <div className="space-y-4 py-4">
                {items.map((item) => (
                  <div key={item.id} className="flex gap-3">
                    {/* Product Image */}
                    <div className="h-16 w-16 rounded-lg bg-muted overflow-hidden flex-shrink-0">
                      {item.product.image_url ? (
                        <StorageImage
                          src={item.product.image_url}
                          alt={item.product.name}
                          className="h-full w-full object-cover"
                        />
                      ) : (
                        <div className="h-full w-full flex items-center justify-center">
                          <Package className="h-6 w-6 text-muted-foreground" />
                        </div>
                      )}
                    </div>

                    {/* Product Info */}
                    <div className="flex-1 min-w-0">
                      <h4 className="font-medium text-sm line-clamp-1">{item.product.name}</h4>
                      <p className="text-sm text-muted-foreground">
                        UGX {item.product.price.toLocaleString()} each
                      </p>
                      
                      {/* Quantity Controls */}
                      <div className="flex items-center gap-2 mt-2">
                        <Button
                          variant="outline"
                          size="icon"
                          className="h-7 w-7"
                          onClick={() => updateQuantity(item.product_id, item.quantity - 1)}
                        >
                          <Minus className="h-3 w-3" />
                        </Button>
                        <span className="w-8 text-center text-sm font-medium">
                          {item.quantity}
                        </span>
                        <Button
                          variant="outline"
                          size="icon"
                          className="h-7 w-7"
                          onClick={() => updateQuantity(item.product_id, item.quantity + 1)}
                          disabled={item.quantity >= item.product.stock}
                        >
                          <Plus className="h-3 w-3" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7 text-destructive hover:text-destructive ml-auto"
                          onClick={() => removeFromCart(item.product_id)}
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </div>
                    </div>

                    {/* Item Total */}
                    <div className="text-right">
                      <p className="font-medium text-sm">
                        UGX {(item.product.price * item.quantity).toLocaleString()}
                      </p>
                    </div>
                  </div>
                ))}
              </div>
            </ScrollArea>

            <div className="pt-4 space-y-4">
              <Separator />
              
              {/* Order Summary */}
              <div className="space-y-2">
                <div className="flex justify-between text-sm">
                  <span className="text-muted-foreground">Subtotal ({itemCount} items)</span>
                  <span>UGX {totalAmount.toLocaleString()}</span>
                </div>
                <div className="flex justify-between font-medium">
                  <span>Total</span>
                  <span className="text-primary text-lg">UGX {totalAmount.toLocaleString()}</span>
                </div>
              </div>

              {/* Checkout Button */}
              <Button 
                className="w-full" 
                size="lg" 
                onClick={handleCheckout}
                disabled={checkingOut || items.length === 0}
              >
                {checkingOut ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Processing...
                  </>
                ) : (
                  <>
                    <CreditCard className="mr-2 h-4 w-4" />
                    Checkout - UGX {totalAmount.toLocaleString()}
                  </>
                )}
              </Button>

              <Button 
                variant="outline" 
                className="w-full" 
                onClick={() => {
                  setOpen(false);
                  document.getElementById('products-section')?.scrollIntoView({ behavior: 'smooth' });
                }}
              >
                Continue Shopping
              </Button>

              <Button 
                variant="ghost" 
                className="w-full text-muted-foreground" 
                onClick={() => {
                  clearCart();
                  setOpen(false);
                }}
              >
                Clear Cart
              </Button>
            </div>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}
