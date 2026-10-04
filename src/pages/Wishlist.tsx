import { useState, useEffect, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Heart, ArrowLeft, Loader2, Trash2, Percent, Tag } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
import { roleToSlug } from '@/lib/roleRoutes';
import { ProductCard } from '@/components/marketplace/ProductCard';
import ScreenLoader from '@/components/common/ScreenLoader';

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

interface WishlistItem {
  id: string;
  product_id: string;
  product: Product;
}

type FilterType = 'all' | 'on_sale';

export default function Wishlist() {
  const navigate = useNavigate();
  const { user, loading: authLoading, role } = useAuth();
  const [wishlistItems, setWishlistItems] = useState<WishlistItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [wishlistIds, setWishlistIds] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState<FilterType>('all');

  const isDiscountActive = (product: Product): boolean => {
    if (!product.discount_percentage || product.discount_percentage <= 0) return false;
    if (!product.discount_ends_at) return true;
    return new Date(product.discount_ends_at) > new Date();
  };

  const filteredItems = useMemo(() => {
    if (filter === 'on_sale') {
      return wishlistItems.filter(item => isDiscountActive(item.product));
    }
    return wishlistItems;
  }, [wishlistItems, filter]);

  const onSaleCount = useMemo(() => {
    return wishlistItems.filter(item => isDiscountActive(item.product)).length;
  }, [wishlistItems]);

  useEffect(() => {
    if (!authLoading && !user) {
      navigate('/auth');
    }
  }, [user, authLoading, navigate]);

  useEffect(() => {
    if (user) {
      fetchWishlist();
    }
  }, [user]);

  const fetchWishlist = async () => {
    if (!user) return;
    
    setLoading(true);
    try {
      const { data, error } = await supabase
        .from('wishlists')
        .select('id, product_id, products(*)')
        .eq('user_id', user.id)
        .order('created_at', { ascending: false });

      if (error) throw error;

      const items = (data || [])
        .filter(item => item.products)
        .map(item => ({
          id: item.id,
          product_id: item.product_id,
          product: item.products as unknown as Product
        }));

      setWishlistItems(items);
      setWishlistIds(new Set(items.map(item => item.product_id)));
    } catch (error) {
      console.error('Error fetching wishlist:', error);
    } finally {
      setLoading(false);
    }
  };

  const clearWishlist = async () => {
    if (!user) return;
    
    try {
      const { error } = await supabase
        .from('wishlists')
        .delete()
        .eq('user_id', user.id);

      if (error) throw error;
      setWishlistItems([]);
      setWishlistIds(new Set());
    } catch (error) {
      console.error('Error clearing wishlist:', error);
    }
  };

  if (authLoading) {
    return (
      <ScreenLoader />
    );
  }

  return (
    <div className="min-h-screen bg-background">
      <div className="container max-w-6xl mx-auto px-4 py-6">
        {/* Header */}
        <div className="flex items-center justify-between mb-6">
          <div className="flex items-center gap-3">
            <Button variant="ghost" size="icon" onClick={() => navigate(-1)}>
              <ArrowLeft className="h-5 w-5" />
            </Button>
            <div>
              <h1 className="text-2xl font-bold flex items-center gap-2">
                <Heart className="h-6 w-6 text-destructive fill-destructive" />
                My Wishlist
              </h1>
              <p className="text-sm text-muted-foreground">
                {wishlistItems.length} saved product{wishlistItems.length !== 1 ? 's' : ''}
                {onSaleCount > 0 && (
                  <span className="text-success ml-1">• {onSaleCount} on sale!</span>
                )}
              </p>
            </div>
          </div>
          {wishlistItems.length > 0 && (
            <Button variant="outline" size="sm" onClick={clearWishlist} className="gap-2">
              <Trash2 className="h-4 w-4" />
              Clear All
            </Button>
          )}
        </div>

        {/* Filter Tabs */}
        {wishlistItems.length > 0 && (
          <div className="flex gap-2 mb-4">
            <Button
              variant={filter === 'all' ? 'default' : 'outline'}
              size="sm"
              onClick={() => setFilter('all')}
              className="gap-2"
            >
              <Tag className="h-4 w-4" />
              All ({wishlistItems.length})
            </Button>
            <Button
              variant={filter === 'on_sale' ? 'default' : 'outline'}
              size="sm"
              onClick={() => setFilter('on_sale')}
              className="gap-2"
              disabled={onSaleCount === 0}
            >
              <Percent className="h-4 w-4" />
              On Sale ({onSaleCount})
              {onSaleCount > 0 && (
                <Badge variant="destructive" className="ml-1 h-5 px-1.5 text-xs">
                  🔥
                </Badge>
              )}
            </Button>
          </div>
        )}

        {/* Content */}
        <Card>
          <CardContent className="p-6">
            {loading ? (
              <div className="flex items-center justify-center py-12">
                <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
              </div>
            ) : wishlistItems.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-12 text-center">
                <Heart className="h-16 w-16 text-muted-foreground mb-4" />
                <h3 className="text-lg font-medium mb-2">Your wishlist is empty</h3>
                <p className="text-sm text-muted-foreground mb-6">
                  Save products you like by clicking the heart icon
                </p>
                <Button onClick={() => navigate(roleToSlug(role))}>
                  Browse Products
                </Button>
              </div>
            ) : filteredItems.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-12 text-center">
                <Percent className="h-16 w-16 text-muted-foreground mb-4" />
                <h3 className="text-lg font-medium mb-2">No items on sale</h3>
                <p className="text-sm text-muted-foreground mb-6">
                  None of your wishlist items are currently discounted
                </p>
                <Button variant="outline" onClick={() => setFilter('all')}>
                  View All Items
                </Button>
              </div>
            ) : (
              <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
                {filteredItems.map((item) => (
                  <ProductCard
                    key={item.id}
                    product={item.product}
                    onPurchaseComplete={fetchWishlist}
                    isOwnProduct={item.product.agent_id === user?.id}
                    isInWishlist={wishlistIds.has(item.product_id)}
                    onWishlistChange={fetchWishlist}
                  />
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
