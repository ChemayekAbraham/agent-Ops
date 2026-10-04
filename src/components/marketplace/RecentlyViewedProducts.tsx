import { useState, useEffect } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { ScrollArea, ScrollBar } from '@/components/ui/scroll-area';
import { Skeleton } from '@/components/ui/skeleton';
import { Clock, X, Trash2 } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { ProductCard } from './ProductCard';
import { useRecentlyViewed } from '@/hooks/useRecentlyViewed';
import { useAuth } from '@/hooks/useAuth';

interface Product {
  id: string;
  name: string;
  description: string | null;
  price: number;
  category: string;
  image_url: string | null;
  stock: number;
  agent_id: string;
  discount_percentage?: number | null;
  discount_ends_at?: string | null;
}

interface RecentlyViewedProductsProps {
  onProductPurchase?: () => void;
}

export function RecentlyViewedProducts({ onProductPurchase }: RecentlyViewedProductsProps) {
  const { user } = useAuth();
  const { recentIds, clearRecentlyViewed } = useRecentlyViewed();
  const [products, setProducts] = useState<Product[]>([]);
  const [loading, setLoading] = useState(true);
  const [wishlistIds, setWishlistIds] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (recentIds.length > 0) {
      fetchProducts();
    } else {
      setProducts([]);
      setLoading(false);
    }
  }, [recentIds]);

  useEffect(() => {
    if (user) fetchWishlist();
  }, [user]);

  const fetchProducts = async () => {
    setLoading(true);
    try {
      const { data, error } = await supabase
        .from('products')
        .select('*')
        .in('id', recentIds)
        .eq('active', true);

      if (error) throw error;

      // Sort by the order in recentIds (most recent first)
      const sortedProducts = (data || []).sort((a, b) => {
        return recentIds.indexOf(a.id) - recentIds.indexOf(b.id);
      });

      setProducts(sortedProducts);
    } catch (error) {
      console.error('Error fetching recently viewed products:', error);
    } finally {
      setLoading(false);
    }
  };

  const fetchWishlist = async () => {
    if (!user) return;
    
    const { data } = await supabase
      .from('wishlists')
      .select('product_id')
      .eq('user_id', user.id);
    
    if (data) {
      setWishlistIds(new Set(data.map(w => w.product_id)));
    }
  };

  if (recentIds.length === 0) {
    return null;
  }

  return (
    <Card className="mb-6">
      <CardHeader className="flex flex-row items-center justify-between pb-3">
        <CardTitle className="flex items-center gap-2 text-lg">
          <Clock className="h-5 w-5 text-muted-foreground" />
          Recently Viewed
        </CardTitle>
        <Button 
          variant="ghost" 
          size="sm" 
          className="text-muted-foreground hover:text-destructive gap-1"
          onClick={clearRecentlyViewed}
        >
          <Trash2 className="h-4 w-4" />
          Clear
        </Button>
      </CardHeader>
      <CardContent>
        {loading ? (
          <div className="flex gap-4 overflow-hidden">
            {[...Array(4)].map((_, i) => (
              <div key={i} className="flex-shrink-0 w-[200px] space-y-3">
                <Skeleton className="aspect-square w-full rounded-lg" />
                <Skeleton className="h-4 w-3/4" />
                <Skeleton className="h-4 w-1/2" />
              </div>
            ))}
          </div>
        ) : products.length === 0 ? (
          <p className="text-sm text-muted-foreground text-center py-4">
            Products you've viewed will appear here
          </p>
        ) : (
          <ScrollArea className="w-full whitespace-nowrap">
            <div className="flex gap-4 pb-4">
              {products.map((product) => (
                <div key={product.id} className="flex-shrink-0 w-[200px]">
                  <ProductCard
                    product={product}
                    onPurchaseComplete={() => {
                      fetchProducts();
                      onProductPurchase?.();
                    }}
                    isOwnProduct={product.agent_id === user?.id}
                    isInWishlist={wishlistIds.has(product.id)}
                    onWishlistChange={fetchWishlist}
                  />
                </div>
              ))}
            </div>
            <ScrollBar orientation="horizontal" />
          </ScrollArea>
        )}
      </CardContent>
    </Card>
  );
}
