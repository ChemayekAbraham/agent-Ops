import { useState, useEffect, createContext, useContext, ReactNode } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from './useAuth';
import { toast } from 'sonner';

interface Product {
  id: string;
  name: string;
  description: string | null;
  price: number;
  category: string;
  image_url: string | null;
  stock: number;
  agent_id: string;
}

interface CartItem {
  id: string;
  product_id: string;
  quantity: number;
  product: Product;
}

interface CartContextType {
  items: CartItem[];
  loading: boolean;
  itemCount: number;
  totalAmount: number;
  addToCart: (productId: string, quantity?: number) => Promise<void>;
  updateQuantity: (productId: string, quantity: number) => Promise<void>;
  removeFromCart: (productId: string) => Promise<void>;
  clearCart: () => Promise<void>;
  refreshCart: () => Promise<void>;
}

const CartContext = createContext<CartContextType | undefined>(undefined);

export function CartProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const [items, setItems] = useState<CartItem[]>([]);
  const [loading, setLoading] = useState(false);

  const fetchCart = async () => {
    if (!user) {
      setItems([]);
      return;
    }

    setLoading(true);
    try {
      const { data, error } = await supabase
        .from('cart_items')
        .select('id, product_id, quantity, products(*)')
        .eq('user_id', user.id)
        .order('created_at', { ascending: false });

      if (error) throw error;

      const cartItems = (data || [])
        .filter(item => item.products)
        .map(item => ({
          id: item.id,
          product_id: item.product_id,
          quantity: item.quantity,
          product: item.products as unknown as Product
        }));

      setItems(cartItems);
    } catch (error) {
      console.error('Error fetching cart:', error);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchCart();
  }, [user]);

  const addToCart = async (productId: string, quantity: number = 1) => {
    if (!user) {
      toast.error('Please sign in to add to cart');
      return;
    }

    try {
      // Check if item already in cart
      const existingItem = items.find(item => item.product_id === productId);

      if (existingItem) {
        // Update quantity
        const newQuantity = existingItem.quantity + quantity;
        if (newQuantity > existingItem.product.stock) {
          toast.error('Not enough stock available');
          return;
        }

        const { error } = await supabase
          .from('cart_items')
          .update({ quantity: newQuantity })
          .eq('id', existingItem.id);

        if (error) throw error;
        toast.success('Cart updated');
      } else {
        // Add new item
        const { error } = await supabase
          .from('cart_items')
          .insert({ user_id: user.id, product_id: productId, quantity });

        if (error) throw error;
        toast.success('Added to cart');
      }

      await fetchCart();
    } catch (error: any) {
      toast.error('Failed to add to cart');
      console.error('Add to cart error:', error);
    }
  };

  const updateQuantity = async (productId: string, quantity: number) => {
    if (!user) return;

    const item = items.find(i => i.product_id === productId);
    if (!item) return;

    if (quantity <= 0) {
      await removeFromCart(productId);
      return;
    }

    if (quantity > item.product.stock) {
      toast.error('Not enough stock available');
      return;
    }

    try {
      const { error } = await supabase
        .from('cart_items')
        .update({ quantity })
        .eq('id', item.id);

      if (error) throw error;
      await fetchCart();
    } catch (error) {
      toast.error('Failed to update cart');
      console.error('Update cart error:', error);
    }
  };

  const removeFromCart = async (productId: string) => {
    if (!user) return;

    try {
      const { error } = await supabase
        .from('cart_items')
        .delete()
        .eq('user_id', user.id)
        .eq('product_id', productId);

      if (error) throw error;
      toast.success('Removed from cart');
      await fetchCart();
    } catch (error) {
      toast.error('Failed to remove from cart');
      console.error('Remove from cart error:', error);
    }
  };

  const clearCart = async () => {
    if (!user) return;

    try {
      const { error } = await supabase
        .from('cart_items')
        .delete()
        .eq('user_id', user.id);

      if (error) throw error;
      setItems([]);
    } catch (error) {
      console.error('Clear cart error:', error);
    }
  };

  const itemCount = items.reduce((sum, item) => sum + item.quantity, 0);
  const totalAmount = items.reduce((sum, item) => sum + (item.product.price * item.quantity), 0);

  return (
    <CartContext.Provider value={{
      items,
      loading,
      itemCount,
      totalAmount,
      addToCart,
      updateQuantity,
      removeFromCart,
      clearCart,
      refreshCart: fetchCart
    }}>
      {children}
    </CartContext.Provider>
  );
}

// Safe fallback when provider hasn't loaded yet
const cartFallback: CartContextType = {
  items: [],
  loading: false,
  itemCount: 0,
  totalAmount: 0,
  addToCart: async () => {},
  updateQuantity: async () => {},
  removeFromCart: async () => {},
  clearCart: async () => {},
  refreshCart: async () => {},
};

export function useCart() {
  const context = useContext(CartContext);
  return context ?? cartFallback;
}
