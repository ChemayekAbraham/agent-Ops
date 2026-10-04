import { useState, useEffect } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Skeleton } from '@/components/ui/skeleton';
import { Sparkles } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
import { useRecentlyViewed } from '@/hooks/useRecentlyViewed';
import { ProductCard } from './ProductCard';

interface Product {
  id: string;
  name: string;
  description: string | null;
  price: number;
  image_url: string | null;
  stock: number;
  category: string;
  agent_id: string;
  discount_percentage: number | null;
  discount_ends_at: string | null;
}

interface ProductRecommendationsProps {
  onProductPurchase?: () => void;
  excludeIds?: string[];
}

export function ProductRecommendations({ onProductPurchase, excludeIds = [] }: ProductRecommendationsProps) {
  const { user } = useAuth();
  const { recentIds } = useRecentlyViewed();
  const [products, setProducts] = useState<Product[]>([]);
  const [recentCategories, setRecentCategories] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [wishlistIds, setWishlistIds] = useState<string[]>([]);

  // Fetch categories from recently viewed products
  useEffect(() => {
    const fetchRecentCategories = async () => {
      if (recentIds.length === 0) {
        setRecentCategories([]);
        return;
      }

      const { data } = await supabase
        .from('products')
        .select('category')
        .in('id', recentIds);

      if (data) {
        const categories = [...new Set(data.map(p => p.category))];
        setRecentCategories(categories);
      }
    };

    fetchRecentCategories();
  }, [recentIds]);

  // Fetch recommended products based on categories
  useEffect(() => {
    const fetchRecommendations = async () => {
      setLoading(true);

      try {
        let query = supabase
          .from('products')
          .select('*')
          .eq('active', true)
          .gt('stock', 0)
          .order('created_at', { ascending: false })
          .limit(12);

        // If we have recent categories, prioritize those
        if (recentCategories.length > 0) {
          query = query.in('category', recentCategories);
        }

        const { data } = await query;

        if (data) {
          // Filter out recently viewed and excluded products
          const allExcluded = [...recentIds, ...excludeIds];
          const filtered = data.filter(p => !allExcluded.includes(p.id));
          setProducts(filtered.slice(0, 8));
        }
      } catch (error) {
        console.error('Error fetching recommendations:', error);
      } finally {
        setLoading(false);
      }
    };

    fetchRecommendations();
  }, [recentCategories, recentIds, excludeIds]);

  // Fetch wishlist
  useEffect(() => {
    const fetchWishlist = async () => {
      if (!user) return;

      const { data } = await supabase
        .from('wishlists')
        .select('product_id')
        .eq('user_id', user.id);

      if (data) {
        setWishlistIds(data.map(w => w.product_id));
      }
    };

    fetchWishlist();
  }, [user]);

  const handleWishlistToggle = async (productId: string) => {
    if (!user) return;

    const isInWishlist = wishlistIds.includes(productId);

    if (isInWishlist) {
      await supabase
        .from('wishlists')
        .delete()
        .eq('user_id', user.id)
        .eq('product_id', productId);
      setWishlistIds(prev => prev.filter(id => id !== productId));
    } else {
      await supabase
        .from('wishlists')
        .insert({ user_id: user.id, product_id: productId });
      setWishlistIds(prev => [...prev, productId]);
    }
  };

  // Don't show if no recommendations available
  if (!loading && products.length === 0) {
    return null;
  }

  return (
    <Card className="border-primary/20 bg-gradient-to-br from-primary/5 to-transparent">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-lg">
          <Sparkles className="h-5 w-5 text-primary" />
          Recommended For You
          {recentCategories.length > 0 && (
            <span className="text-xs font-normal text-muted-foreground ml-2">
              Based on your interests
            </span>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent>
        {loading ? (
          <div className="flex gap-4 overflow-hidden">
            {[1, 2, 3, 4].map((i) => (
              <Skeleton key={i} className="h-64 w-48 flex-shrink-0 rounded-lg" />
            ))}
          </div>
        ) : (
          <ScrollArea className="w-full whitespace-nowrap">
            <div className="flex gap-4 pb-4">
              {products.map((product) => (
                <div key={product.id} className="w-48 flex-shrink-0">
                  <ProductCard
                    product={product}
                    onPurchaseComplete={onProductPurchase}
                    isInWishlist={wishlistIds.includes(product.id)}
                    onWishlistChange={() => handleWishlistToggle(product.id)}
                  />
                </div>
              ))}
            </div>
          </ScrollArea>
        )}
      </CardContent>
    </Card>
  );
}
