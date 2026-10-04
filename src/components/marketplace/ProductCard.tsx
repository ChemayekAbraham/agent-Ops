import { useState, useEffect } from 'react';
import { StorageImage } from '@/components/ui/StorageImage';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { ShoppingCart, Package, Loader2, Star, Eye, Heart, Plus, Percent, Scale, Check } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';
import { ProductDetailDialog } from './ProductDetailDialog';
import { ProductQuickView } from './ProductQuickView';
import { useAuth } from '@/hooks/useAuth';
import { useCart } from '@/hooks/useCart';
import { FlashSaleCountdown } from './FlashSaleCountdown';
import { useRecentlyViewed } from '@/hooks/useRecentlyViewed';
import { useProductComparison } from '@/hooks/useProductComparison';
import { useIsMobile } from '@/hooks/use-mobile';
import { motion } from 'framer-motion';

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

const isDiscountActive = (product: Product): boolean => {
  if (!product.discount_percentage || product.discount_percentage <= 0) return false;
  if (!product.discount_ends_at) return true;
  return new Date(product.discount_ends_at) > new Date();
};

const getDiscountedPrice = (product: Product): number => {
  if (!isDiscountActive(product)) return product.price;
  return Math.round(product.price * (1 - (product.discount_percentage || 0) / 100));
};

interface ProductCardProps {
  product: Product;
  onPurchaseComplete?: () => void;
  isOwnProduct?: boolean;
  isInWishlist?: boolean;
  onWishlistChange?: () => void;
}

export function ProductCard({ 
  product, 
  onPurchaseComplete, 
  isOwnProduct = false,
  isInWishlist = false,
  onWishlistChange
}: ProductCardProps) {
  const { user } = useAuth();
  const { addToCart } = useCart();
  const { addToRecentlyViewed } = useRecentlyViewed();
  const { addToComparison, removeFromComparison, isInComparison } = useProductComparison();
  const isMobile = useIsMobile();
  const [purchasing, setPurchasing] = useState(false);
  const [addingToCart, setAddingToCart] = useState(false);
  const [addedToCart, setAddedToCart] = useState(false);
  const [showDetail, setShowDetail] = useState(false);
  const [showQuickView, setShowQuickView] = useState(false);
  const [averageRating, setAverageRating] = useState(0);
  const [reviewCount, setReviewCount] = useState(0);
  const [wishlistLoading, setWishlistLoading] = useState(false);
  
  const inComparison = isInComparison(product.id);

  const handleCompareToggle = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (inComparison) {
      removeFromComparison(product.id);
      toast.success('Removed from comparison');
    } else {
      const added = addToComparison(product);
      if (added) {
        toast.success('Added to comparison');
      } else {
        toast.error('Maximum 4 products can be compared');
      }
    }
  };

  const handleCardClick = () => {
    addToRecentlyViewed(product.id);
    if (isMobile) {
      setShowQuickView(true);
    } else {
      setShowDetail(true);
    }
  };

  const handleOpenFullDetail = () => {
    addToRecentlyViewed(product.id);
    setShowDetail(true);
  };

  useEffect(() => {
    fetchRating();
  }, [product.id]);

  const fetchRating = async () => {
    const { data } = await supabase
      .from('product_reviews')
      .select('rating')
      .eq('product_id', product.id);

    if (data && data.length > 0) {
      const avg = data.reduce((sum, r) => sum + r.rating, 0) / data.length;
      setAverageRating(avg);
      setReviewCount(data.length);
    }
  };

  const handlePurchase = async (e: React.MouseEvent) => {
    e.stopPropagation();
    
    if (isOwnProduct) {
      toast.error("You can't buy your own product");
      return;
    }

    setPurchasing(true);
    try {
      const { data, error } = await supabase.functions.invoke('product-purchase', {
        body: { productId: product.id, quantity: 1 }
      });

      if (error) throw error;
      if (!data.success) throw new Error(data.error);

      toast.success('Purchase successful!', {
        description: `You bought ${product.name} for UGX ${product.price.toLocaleString()}`
      });
      onPurchaseComplete?.();
    } catch (error: any) {
      console.error('Purchase error:', error);
      toast.error('Purchase failed', {
        description: error.message || 'Please try again'
      });
    } finally {
      setPurchasing(false);
    }
  };

  const handleAddToCart = async (e: React.MouseEvent) => {
    e.stopPropagation();
    setAddingToCart(true);
    await addToCart(product.id);
    setAddingToCart(false);
    setAddedToCart(true);
    setTimeout(() => setAddedToCart(false), 2000);
  };

  const handleWishlistToggle = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!user) {
      toast.error('Please sign in to add to wishlist');
      return;
    }

    setWishlistLoading(true);
    try {
      if (isInWishlist) {
        const { error } = await supabase
          .from('wishlists')
          .delete()
          .eq('user_id', user.id)
          .eq('product_id', product.id);
        if (error) throw error;
        toast.success('Removed from wishlist');
      } else {
        const { error } = await supabase
          .from('wishlists')
          .insert({ user_id: user.id, product_id: product.id });
        if (error) throw error;
        toast.success('Added to wishlist');
      }
      onWishlistChange?.();
    } catch (error: any) {
      toast.error('Failed to update wishlist');
    } finally {
      setWishlistLoading(false);
    }
  };

  const hasDiscount = isDiscountActive(product);
  const discountedPrice = getDiscountedPrice(product);
  const savings = product.price - discountedPrice;

  return (
    <>
      <motion.div
        whileHover={{ y: -4 }}
        transition={{ type: "spring", stiffness: 300, damping: 20 }}
      >
        <Card 
          className="overflow-hidden border-border/50 hover:border-primary/30 hover:shadow-xl transition-all duration-300 cursor-pointer group bg-card"
          onClick={handleCardClick}
        >
          {/* Image Container */}
          <div className="aspect-square bg-muted relative overflow-hidden">
            {product.image_url ? (
              <StorageImage 
                src={product.image_url} 
                alt={product.name}
                className="w-full h-full object-cover group-hover:scale-110 transition-transform duration-500"
                loading="lazy"
              />
            ) : (
              <div className="w-full h-full flex items-center justify-center bg-gradient-to-br from-muted to-muted/50">
                <Package className="h-16 w-16 text-muted-foreground/40" />
              </div>
            )}
            
            {/* Out of Stock Overlay */}
            {product.stock === 0 && (
              <div className="absolute inset-0 bg-background/90 backdrop-blur-sm flex items-center justify-center">
                <Badge variant="destructive" className="text-sm px-4 py-1.5">
                  Sold Out
                </Badge>
              </div>
            )}
            
            {/* Discount Badge - Top Left */}
            {hasDiscount && (
              <div className="absolute top-2 left-2 z-10 flex flex-col gap-1">
                <Badge className="bg-destructive text-destructive-foreground font-bold text-xs px-2 py-1 shadow-lg">
                  -{product.discount_percentage}%
                </Badge>
              </div>
            )}

            {/* Flash Sale Timer */}
            {hasDiscount && product.discount_ends_at && (
              <div className="absolute bottom-2 left-2 z-10">
                <FlashSaleCountdown endDate={product.discount_ends_at} compact />
              </div>
            )}
            
            {/* Action Buttons - Top Right */}
            <div className="absolute top-2 right-2 flex flex-col gap-1.5 z-10 opacity-0 group-hover:opacity-100 transition-opacity duration-200">
              {user && (
                <motion.button
                  whileHover={{ scale: 1.1 }}
                  whileTap={{ scale: 0.9 }}
                  onClick={handleWishlistToggle}
                  disabled={wishlistLoading}
                  className={`p-2 rounded-full shadow-lg transition-colors ${
                    isInWishlist 
                      ? 'bg-destructive text-white' 
                      : 'bg-white/95 dark:bg-card/95 backdrop-blur-sm hover:bg-white dark:hover:bg-card'
                  }`}
                >
                  <Heart 
                    className={`h-4 w-4 ${isInWishlist ? 'fill-current' : 'text-gray-600 dark:text-gray-300'}`}
                  />
                </motion.button>
              )}
              <motion.button
                whileHover={{ scale: 1.1 }}
                whileTap={{ scale: 0.9 }}
                onClick={handleCompareToggle}
                className={`p-2 rounded-full shadow-lg transition-colors ${
                  inComparison 
                    ? 'bg-primary text-primary-foreground' 
                    : 'bg-white/95 dark:bg-card/95 backdrop-blur-sm hover:bg-white dark:hover:bg-card text-gray-600 dark:text-gray-300'
                }`}
              >
                <Scale className="h-4 w-4" />
              </motion.button>
            </div>

            {/* Quick View Overlay */}
            <div className="absolute inset-0 bg-gradient-to-t from-black/60 via-transparent to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-300 flex items-end justify-center pb-4 pointer-events-none">
              <div className="flex items-center gap-2 text-white text-sm font-medium bg-black/30 backdrop-blur-sm px-4 py-2 rounded-full">
                <Eye className="h-4 w-4" />
                Quick View
              </div>
            </div>
          </div>

          <CardContent className="p-3 sm:p-4">
            {/* Product Name */}
            <h3 className="font-semibold text-sm sm:text-base line-clamp-2 mb-1 group-hover:text-primary transition-colors min-h-[2.5rem]">
              {product.name}
            </h3>
            
            {/* Rating */}
            {reviewCount > 0 && (
              <div className="flex items-center gap-1.5 mb-2">
                <div className="flex items-center">
                  {[1, 2, 3, 4, 5].map((star) => (
                    <Star
                      key={star}
                      className={`h-3 w-3 ${
                        star <= Math.round(averageRating)
                          ? 'fill-amber-400 text-amber-400'
                          : 'text-gray-300'
                      }`}
                    />
                  ))}
                </div>
                <span className="text-xs text-muted-foreground">
                  ({reviewCount})
                </span>
              </div>
            )}

            {/* Price Section */}
            <div className="space-y-1 mb-3">
              <div className="flex items-baseline gap-2 flex-wrap">
                <span className="text-lg sm:text-xl font-bold text-primary">
                  UGX {discountedPrice.toLocaleString()}
                </span>
                {hasDiscount && (
                  <span className="text-xs sm:text-sm text-muted-foreground line-through">
                    UGX {product.price.toLocaleString()}
                  </span>
                )}
              </div>
              {hasDiscount && (
                <p className="text-xs text-success font-medium">
                  You save UGX {savings.toLocaleString()}
                </p>
              )}
            </div>

            {/* Stock Info */}
            <div className="flex items-center justify-between mb-3 text-xs">
              <span className={`font-medium ${product.stock > 0 ? 'text-success' : 'text-destructive'}`}>
                {product.stock > 0 ? `${product.stock} in stock` : 'Out of stock'}
              </span>
              {product.stock > 0 && product.stock <= 5 && (
                <Badge variant="outline" className="text-[10px] px-1.5 py-0 text-orange-600 border-orange-300 bg-orange-50 dark:bg-orange-900/20">
                  Few left!
                </Badge>
              )}
            </div>

            {/* Action Buttons */}
            <div className="flex gap-2">
              {!isOwnProduct && product.stock > 0 && (
                <Button 
                  variant="outline"
                  size="sm"
                  onClick={handleAddToCart}
                  disabled={addingToCart}
                  className={`transition-all ${addedToCart ? 'bg-success text-success-foreground border-success' : ''}`}
                >
                  {addingToCart ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : addedToCart ? (
                    <Check className="h-4 w-4" />
                  ) : (
                    <Plus className="h-4 w-4" />
                  )}
                </Button>
              )}
              <Button 
                className="flex-1 text-xs sm:text-sm font-semibold" 
                size="sm"
                onClick={handlePurchase}
                disabled={purchasing || product.stock === 0 || isOwnProduct}
              >
                {purchasing ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : isOwnProduct ? (
                  'Your Product'
                ) : product.stock === 0 ? (
                  'Sold Out'
                ) : (
                  <>
                    <ShoppingCart className="mr-1.5 h-4 w-4" />
                    Buy Now
                  </>
                )}
              </Button>
            </div>
          </CardContent>
        </Card>
      </motion.div>

      {/* Quick View for Mobile */}
      <ProductQuickView
        product={product}
        open={showQuickView}
        onClose={() => setShowQuickView(false)}
        onViewFull={handleOpenFullDetail}
        onPurchaseComplete={() => {
          onPurchaseComplete?.();
          fetchRating();
        }}
        averageRating={averageRating}
        reviewCount={reviewCount}
      />

      {/* Full Detail Dialog */}
      <ProductDetailDialog
        product={product}
        open={showDetail}
        onOpenChange={setShowDetail}
        onPurchaseComplete={() => {
          onPurchaseComplete?.();
          fetchRating();
        }}
        isInWishlist={isInWishlist}
        onWishlistChange={onWishlistChange}
      />
    </>
  );
}
