import { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { StorageImage } from '@/components/ui/StorageImage';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { 
  ShoppingCart, 
  Package, 
  Loader2, 
  Star, 
  X, 
  Plus, 
  Percent,
  Eye,
  ChevronUp
} from 'lucide-react';
import { useCart } from '@/hooks/useCart';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';
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

const isDiscountActive = (product: Product): boolean => {
  if (!product.discount_percentage || product.discount_percentage <= 0) return false;
  if (!product.discount_ends_at) return true;
  return new Date(product.discount_ends_at) > new Date();
};

const getDiscountedPrice = (product: Product): number => {
  if (!isDiscountActive(product)) return product.price;
  return Math.round(product.price * (1 - (product.discount_percentage || 0) / 100));
};

interface ProductQuickViewProps {
  product: Product;
  open: boolean;
  onClose: () => void;
  onViewFull: () => void;
  onPurchaseComplete?: () => void;
  averageRating?: number;
  reviewCount?: number;
}

export function ProductQuickView({
  product,
  open,
  onClose,
  onViewFull,
  onPurchaseComplete,
  averageRating = 0,
  reviewCount = 0,
}: ProductQuickViewProps) {
  const { user } = useAuth();
  const { addToCart } = useCart();
  const [purchasing, setPurchasing] = useState(false);
  const [addingToCart, setAddingToCart] = useState(false);

  const isOwnProduct = product.agent_id === user?.id;
  const hasDiscount = isDiscountActive(product);
  const discountedPrice = getDiscountedPrice(product);

  const handlePurchase = async () => {
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
        description: `You bought ${product.name} for UGX ${discountedPrice.toLocaleString()}`
      });
      onPurchaseComplete?.();
      onClose();
    } catch (error: any) {
      toast.error('Purchase failed', { description: error.message });
    } finally {
      setPurchasing(false);
    }
  };

  const handleAddToCart = async () => {
    setAddingToCart(true);
    await addToCart(product.id);
    setAddingToCart(false);
  };

  const categoryColors: Record<string, string> = {
    food: 'bg-green-500/10 text-green-500',
    drinks: 'bg-blue-500/10 text-blue-500',
    groceries: 'bg-orange-500/10 text-orange-500',
    general: 'bg-gray-500/10 text-gray-500',
  };

  return (
    <AnimatePresence>
      {open && (
        <>
          {/* Backdrop */}
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 bg-black/50 z-50 md:hidden"
            onClick={onClose}
          />
          
          {/* Bottom Sheet */}
          <motion.div
            initial={{ y: '100%' }}
            animate={{ y: 0 }}
            exit={{ y: '100%' }}
            transition={{ type: 'spring', damping: 25, stiffness: 300 }}
            className="fixed bottom-0 left-0 right-0 z-50 bg-background rounded-t-2xl shadow-2xl md:hidden max-h-[85vh] overflow-hidden"
          >
            {/* Handle */}
            <div className="flex justify-center pt-2 pb-1">
              <div className="w-10 h-1 bg-muted-foreground/30 rounded-full" />
            </div>

            {/* Content */}
            <div className="px-4 pb-6 overflow-y-auto max-h-[calc(85vh-40px)]">
              {/* Close Button */}
              <div className="flex justify-end mb-2">
                <button
                  onClick={onClose}
                  className="p-2 rounded-full hover:bg-muted transition-colors"
                >
                  <X className="h-5 w-5 text-muted-foreground" />
                </button>
              </div>

              {/* Product Summary */}
              <div className="flex gap-4">
                {/* Image */}
                <div className="w-24 h-24 rounded-lg bg-muted overflow-hidden flex-shrink-0 relative">
                  {product.image_url ? (
                    <StorageImage
                      src={product.image_url}
                      alt={product.name}
                      className="w-full h-full object-cover"
                    />
                  ) : (
                    <div className="w-full h-full flex items-center justify-center">
                      <Package className="h-8 w-8 text-muted-foreground" />
                    </div>
                  )}
                  {hasDiscount && (
                    <Badge className="absolute top-1 left-1 text-xs bg-destructive text-destructive-foreground">
                      -{product.discount_percentage}%
                    </Badge>
                  )}
                </div>

                {/* Details */}
                <div className="flex-1 min-w-0">
                  <div className="flex items-start justify-between gap-2">
                    <h3 className="font-semibold text-lg line-clamp-2">{product.name}</h3>
                  </div>
                  
                  <Badge className={`mt-1 ${categoryColors[product.category] || categoryColors.general}`}>
                    {product.category}
                  </Badge>

                  {/* Rating */}
                  {reviewCount > 0 && (
                    <div className="flex items-center gap-1 mt-2">
                      <div className="flex">
                        {[1, 2, 3, 4, 5].map((star) => (
                          <Star
                            key={star}
                            className={`h-3.5 w-3.5 ${
                              star <= Math.round(averageRating)
                                ? 'fill-warning text-warning'
                                : 'text-muted-foreground'
                            }`}
                          />
                        ))}
                      </div>
                      <span className="text-sm text-muted-foreground">
                        ({reviewCount})
                      </span>
                    </div>
                  )}

                  {/* Stock */}
                  <p className="text-sm text-muted-foreground mt-1">
                    {product.stock > 0 ? `${product.stock} in stock` : 'Out of stock'}
                  </p>
                </div>
              </div>

              {/* Description */}
              {product.description && (
                <p className="text-sm text-muted-foreground mt-4 line-clamp-3">
                  {product.description}
                </p>
              )}

              {/* Price Section */}
              <div className="mt-4 p-3 bg-muted/50 rounded-lg">
                <div className="flex items-center justify-between">
                  <span className="text-sm text-muted-foreground">Price</span>
                  <div className="flex items-center gap-2">
                    <span className="text-xl font-bold text-primary">
                      UGX {discountedPrice.toLocaleString()}
                    </span>
                    {hasDiscount && (
                      <span className="text-sm text-muted-foreground line-through">
                        UGX {product.price.toLocaleString()}
                      </span>
                    )}
                  </div>
                </div>
                {hasDiscount && (
                  <div className="flex items-center justify-end gap-1 mt-1">
                    <Percent className="h-3 w-3 text-destructive" />
                    <span className="text-sm text-destructive font-medium">
                      You save UGX {(product.price - discountedPrice).toLocaleString()}
                    </span>
                  </div>
                )}
              </div>

              {/* Action Buttons */}
              <div className="mt-4 space-y-2">
                <div className="flex gap-2">
                  {!isOwnProduct && product.stock > 0 && (
                    <Button
                      variant="outline"
                      className="flex-1"
                      onClick={handleAddToCart}
                      disabled={addingToCart}
                    >
                      {addingToCart ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        <>
                          <Plus className="mr-2 h-4 w-4" />
                          Add to Cart
                        </>
                      )}
                    </Button>
                  )}
                  <Button
                    className="flex-1"
                    onClick={handlePurchase}
                    disabled={purchasing || product.stock === 0 || isOwnProduct}
                  >
                    {purchasing ? (
                      <>
                        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                        Processing...
                      </>
                    ) : isOwnProduct ? (
                      'Your Product'
                    ) : product.stock === 0 ? (
                      'Out of Stock'
                    ) : (
                      <>
                        <ShoppingCart className="mr-2 h-4 w-4" />
                        Buy Now
                      </>
                    )}
                  </Button>
                </div>

                {/* View Full Details */}
                <Button
                  variant="ghost"
                  className="w-full text-muted-foreground"
                  onClick={() => {
                    onClose();
                    onViewFull();
                  }}
                >
                  <Eye className="mr-2 h-4 w-4" />
                  View Full Details
                  <ChevronUp className="ml-2 h-4 w-4" />
                </Button>
              </div>
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}
