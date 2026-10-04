import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Separator } from '@/components/ui/separator';
import { Input } from '@/components/ui/input';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { 
  Star, 
  Loader2, 
  ShoppingCart,
  MessageSquare,
  Heart,
  Plus,
  Minus,
  Percent,
  Store,
  ExternalLink,
  CheckCircle2,
  Camera,
  ArrowUpDown
} from 'lucide-react';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';
import { useAuth } from '@/hooks/useAuth';
import { useCart } from '@/hooks/useCart';
import { ProductImageGallery } from './ProductImageGallery';
import { FlashSaleCountdown } from './FlashSaleCountdown';
import { VerifiedBadge } from './VerifiedBadge';
import { ReviewImageUploader } from './ReviewImageUploader';
import { PhotoReviewCard, ReviewImageLightbox } from './PhotoReviewCard';
import { format } from 'date-fns';

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

interface GalleryImage {
  id: string;
  image_url: string;
}

interface ReviewImage {
  id: string;
  image_url: string;
}

interface ReviewVote {
  upvotes: number;
  downvotes: number;
  userVote: 'upvote' | 'downvote' | null;
}

interface SellerResponse {
  id: string;
  response_text: string;
  created_at: string;
  updated_at: string;
}

interface Review {
  id: string;
  product_id: string;
  buyer_id: string;
  rating: number;
  comment: string | null;
  created_at: string;
  buyer_name?: string;
  buyer_avatar?: string | null;
  is_verified_purchase?: boolean;
  images?: ReviewImage[];
  votes?: ReviewVote;
  seller_response?: SellerResponse | null;
}

interface ProductDetailDialogProps {
  product: Product | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onPurchaseComplete?: () => void;
  isInWishlist?: boolean;
  onWishlistChange?: () => void;
}

export function ProductDetailDialog({ 
  product, 
  open, 
  onOpenChange,
  onPurchaseComplete,
  isInWishlist = false,
  onWishlistChange
}: ProductDetailDialogProps) {
  const navigate = useNavigate();
  const { user } = useAuth();
  const { addToCart } = useCart();
  const [reviews, setReviews] = useState<Review[]>([]);
  const [galleryImages, setGalleryImages] = useState<GalleryImage[]>([]);
  const [sellerInfo, setSellerInfo] = useState<{ full_name: string; avatar_url: string | null; verified: boolean } | null>(null);
  const [loading, setLoading] = useState(false);
  const [purchasing, setPurchasing] = useState(false);
  const [submittingReview, setSubmittingReview] = useState(false);
  const [userReview, setUserReview] = useState<Review | null>(null);
  const [canReview, setCanReview] = useState(false);
  const [showReviewForm, setShowReviewForm] = useState(false);
  const [rating, setRating] = useState(5);
  const [comment, setComment] = useState('');
  const [reviewImages, setReviewImages] = useState<string[]>([]);
  const [hoverRating, setHoverRating] = useState(0);
  const [wishlistLoading, setWishlistLoading] = useState(false);
  const [quantity, setQuantity] = useState(1);
  const [addingToCart, setAddingToCart] = useState(false);
  const [lightboxImages, setLightboxImages] = useState<ReviewImage[]>([]);
  const [lightboxIndex, setLightboxIndex] = useState(0);
  const [lightboxOpen, setLightboxOpen] = useState(false);
  const [reviewSortBy, setReviewSortBy] = useState<'newest' | 'highest' | 'lowest' | 'helpful'>('newest');
  const [showPhotoReviewsOnly, setShowPhotoReviewsOnly] = useState(false);

  useEffect(() => {
    if (product && open) {
      fetchReviews();
      fetchGalleryImages();
      fetchSellerInfo();
      checkCanReview();
      setQuantity(1);
      setReviewImages([]);
    }
  }, [product, open]);

  const fetchSellerInfo = async () => {
    if (!product) return;
    
    try {
      const { data } = await supabase
        .from('profiles')
        .select('full_name, avatar_url, verified')
        .eq('id', product.agent_id)
        .maybeSingle();
      
      setSellerInfo(data);
    } catch (error) {
      console.error('Error fetching seller info:', error);
    }
  };

  const fetchGalleryImages = async () => {
    if (!product) return;

    try {
      const { data, error } = await supabase
        .from('product_images')
        .select('id, image_url')
        .eq('product_id', product.id)
        .order('display_order');

      if (error) throw error;
      setGalleryImages(data || []);
    } catch (error) {
      console.error('Error fetching gallery images:', error);
    }
  };

  const fetchReviews = async () => {
    if (!product) return;
    setLoading(true);

    try {
      const { data, error } = await supabase
        .from('product_reviews')
        .select('*')
        .eq('product_id', product.id)
        .order('created_at', { ascending: false });

      if (error) throw error;

      // Enrich with buyer names, avatars, images, votes, and seller responses
      const enrichedReviews = await Promise.all(
        (data || []).map(async (review) => {
          // Get profile
          const { data: profile } = await supabase
            .from('profiles')
            .select('full_name, avatar_url')
            .eq('id', review.buyer_id)
            .maybeSingle();

          // Get review images
          const { data: images } = await supabase
            .from('review_images')
            .select('id, image_url')
            .eq('review_id', review.id)
            .order('display_order');

          // Get vote counts
          const { data: votes } = await supabase
            .from('review_votes')
            .select('vote_type, user_id')
            .eq('review_id', review.id);

          // Get seller response
          const { data: sellerResponse } = await supabase
            .from('review_responses')
            .select('id, response_text, created_at, updated_at')
            .eq('review_id', review.id)
            .maybeSingle();

          const upvotes = votes?.filter(v => v.vote_type === 'upvote').length || 0;
          const downvotes = votes?.filter(v => v.vote_type === 'downvote').length || 0;
          const userVote = user ? votes?.find(v => v.user_id === user.id)?.vote_type as 'upvote' | 'downvote' | null : null;

          return {
            ...review,
            buyer_name: profile?.full_name || 'Anonymous',
            buyer_avatar: profile?.avatar_url,
            is_verified_purchase: true, // All reviews require purchase
            images: images || [],
            votes: { upvotes, downvotes, userVote },
            seller_response: sellerResponse || null,
          };
        })
      );

      setReviews(enrichedReviews);
      
      // Check if user already reviewed
      if (user) {
        const existing = enrichedReviews.find(r => r.buyer_id === user.id);
        setUserReview(existing || null);
        if (existing) {
          setRating(existing.rating);
          setComment(existing.comment || '');
        }
      }
    } catch (error) {
      console.error('Error fetching reviews:', error);
    } finally {
      setLoading(false);
    }
  };

  const checkCanReview = async () => {
    if (!product || !user) {
      setCanReview(false);
      return;
    }

    const { data } = await supabase
      .from('product_orders')
      .select('id')
      .eq('product_id', product.id)
      .eq('buyer_id', user.id)
      .limit(1);

    setCanReview((data?.length || 0) > 0);
  };

  const handlePurchase = async () => {
    if (!product || !user) return;

    setPurchasing(true);
    try {
      const { data, error } = await supabase.functions.invoke('product-purchase', {
        body: { productId: product.id, quantity }
      });

      if (error) throw error;
      if (!data.success) throw new Error(data.error);

      toast.success('Purchase successful!', {
        description: `You bought ${quantity}x ${product.name} for UGX ${(product.price * quantity).toLocaleString()}`
      });
      onPurchaseComplete?.();
      setCanReview(true);
      setQuantity(1);
    } catch (error: any) {
      toast.error('Purchase failed', { description: error.message });
    } finally {
      setPurchasing(false);
    }
  };

  const handleQuantityChange = (delta: number) => {
    const newQuantity = quantity + delta;
    if (newQuantity >= 1 && newQuantity <= product!.stock) {
      setQuantity(newQuantity);
    }
  };

  const handleQuantityInput = (value: string) => {
    const num = parseInt(value, 10);
    if (!isNaN(num) && num >= 1 && num <= product!.stock) {
      setQuantity(num);
    } else if (value === '') {
      setQuantity(1);
    }
  };

  const handleSubmitReview = async () => {
    if (!product || !user) return;

    setSubmittingReview(true);
    try {
      let reviewId = userReview?.id;

      if (userReview) {
        // Update existing review
        const { error } = await supabase
          .from('product_reviews')
          .update({ rating, comment: comment || null })
          .eq('id', userReview.id);

        if (error) throw error;
      } else {
        // Create new review
        const { data, error } = await supabase
          .from('product_reviews')
          .insert({
            product_id: product.id,
            buyer_id: user.id,
            rating,
            comment: comment || null,
          })
          .select('id')
          .single();

        if (error) throw error;
        reviewId = data.id;
      }

      // Upload review images if any
      if (reviewId && reviewImages.length > 0) {
        // Delete existing images first
        await supabase
          .from('review_images')
          .delete()
          .eq('review_id', reviewId);

        // Insert new images
        const imageInserts = reviewImages.map((url, index) => ({
          review_id: reviewId,
          image_url: url,
          display_order: index,
        }));

        const { error: imgError } = await supabase
          .from('review_images')
          .insert(imageInserts);

        if (imgError) {
          console.error('Error saving review images:', imgError);
        }
      }

      toast.success(userReview ? 'Review updated!' : 'Review submitted!');
      setShowReviewForm(false);
      setReviewImages([]);
      fetchReviews();
    } catch (error: any) {
      toast.error('Failed to submit review', { description: error.message });
    } finally {
      setSubmittingReview(false);
    }
  };

  const averageRating = reviews.length > 0
    ? reviews.reduce((sum, r) => sum + r.rating, 0) / reviews.length
    : 0;

  const handleWishlistToggle = async () => {
    if (!product || !user) return;

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

  const openReviewImageLightbox = (images: ReviewImage[], startIndex: number) => {
    setLightboxImages(images);
    setLightboxIndex(startIndex);
    setLightboxOpen(true);
  };

  const isOwnProduct = product?.agent_id === user?.id;
  const hasDiscount = product ? isDiscountActive(product) : false;
  const discountedPrice = product ? getDiscountedPrice(product) : 0;

  // Count reviews with photos
  const photoReviewCount = reviews.filter(r => r.images && r.images.length > 0).length;

  // Filter and sort reviews
  const sortedReviews = [...reviews]
    .filter(review => !showPhotoReviewsOnly || (review.images && review.images.length > 0))
    .sort((a, b) => {
      // If showing photo reviews only or if sorting is "newest", prioritize reviews with photos
      const aHasPhotos = a.images && a.images.length > 0;
      const bHasPhotos = b.images && b.images.length > 0;
      
      switch (reviewSortBy) {
        case 'newest':
          return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
        case 'highest':
          return b.rating - a.rating;
        case 'lowest':
          return a.rating - b.rating;
        case 'helpful':
          const aScore = (a.votes?.upvotes || 0) - (a.votes?.downvotes || 0);
          const bScore = (b.votes?.upvotes || 0) - (b.votes?.downvotes || 0);
          return bScore - aScore;
        default:
          return 0;
      }
    });

  if (!product) return null;

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="sm:max-w-[500px] max-h-[90vh] p-0">
          <ScrollArea className="max-h-[90vh]">
            <div className="p-6">
              <DialogHeader>
                <DialogTitle className="sr-only">{product.name}</DialogTitle>
              </DialogHeader>

              {/* Product Image Gallery */}
              <div className="mb-4">
                <ProductImageGallery
                  mainImage={product.image_url}
                  galleryImages={galleryImages}
                  productName={product.name}
                />
              </div>

              {/* Product Info */}
              <div className="space-y-3">
                <div className="flex items-start justify-between gap-2">
                  <h2 className="text-xl font-bold">{product.name}</h2>
                  <div className="flex items-center gap-2">
                    {user && (
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={handleWishlistToggle}
                        disabled={wishlistLoading}
                        className="h-8 w-8"
                      >
                        <Heart 
                          className={`h-5 w-5 ${
                            isInWishlist 
                              ? 'fill-destructive text-destructive' 
                              : 'text-muted-foreground hover:text-destructive'
                          }`}
                        />
                      </Button>
                    )}
                    <Badge className="capitalize shrink-0">{product.category}</Badge>
                  </div>
                </div>

                {/* Seller Info */}
                {sellerInfo && (
                  <button
                    onClick={() => {
                      onOpenChange(false);
                      navigate(`/seller/${product.agent_id}`);
                    }}
                    className="flex items-center gap-3 p-3 rounded-lg bg-secondary/50 hover:bg-secondary transition-colors w-full text-left group"
                  >
                    <Avatar className="h-10 w-10">
                      <AvatarImage src={sellerInfo.avatar_url || undefined} />
                      <AvatarFallback className="bg-primary/10 text-primary">
                        {sellerInfo.full_name.split(' ').map(n => n[0]).join('').toUpperCase().slice(0, 2)}
                      </AvatarFallback>
                    </Avatar>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium truncate group-hover:text-primary transition-colors flex items-center gap-1">
                        {sellerInfo.full_name}
                        {sellerInfo.verified && <VerifiedBadge size="sm" />}
                      </p>
                      <p className="text-xs text-muted-foreground flex items-center gap-1">
                        <Store className="h-3 w-3" />
                        View seller profile
                      </p>
                    </div>
                    <ExternalLink className="h-4 w-4 text-muted-foreground group-hover:text-primary transition-colors" />
                  </button>
                )}

                {product.description && (
                  <p className="text-muted-foreground">{product.description}</p>
                )}

                {/* Discount Badge */}
                {hasDiscount && (
                  <div className="space-y-2">
                    <div className="flex items-center gap-2 p-3 rounded-lg bg-destructive/10 border border-destructive/20">
                      <Percent className="h-5 w-5 text-destructive" />
                      <span className="font-semibold text-destructive">{product.discount_percentage}% OFF</span>
                    </div>
                    {product.discount_ends_at && (
                      <FlashSaleCountdown endDate={product.discount_ends_at} />
                    )}
                  </div>
                )}

                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span className="text-2xl font-bold text-primary">
                      UGX {discountedPrice.toLocaleString()}
                    </span>
                    {hasDiscount && (
                      <span className="text-lg text-muted-foreground line-through">
                        UGX {product.price.toLocaleString()}
                      </span>
                    )}
                  </div>
                  <span className="text-sm text-muted-foreground">
                    {product.stock > 0 ? `${product.stock} in stock` : 'Out of stock'}
                  </span>
                </div>

                {/* Rating Summary */}
                {reviews.length > 0 && (
                  <div className="flex items-center gap-2">
                    <div className="flex">
                      {[1, 2, 3, 4, 5].map((star) => (
                        <Star
                          key={star}
                          className={`h-4 w-4 ${
                            star <= Math.round(averageRating)
                              ? 'fill-warning text-warning'
                              : 'text-muted-foreground'
                          }`}
                        />
                      ))}
                    </div>
                    <span className="text-sm font-medium">{averageRating.toFixed(1)}</span>
                    <span className="text-sm text-muted-foreground">
                      ({reviews.length} review{reviews.length !== 1 ? 's' : ''})
                    </span>
                    {photoReviewCount > 0 && (
                      <Badge variant="secondary" className="text-xs gap-1">
                        <Camera className="h-3 w-3" />
                        {photoReviewCount} with photos
                      </Badge>
                    )}
                  </div>
                )}

                {/* Buy Section */}
                {!isOwnProduct && product.stock > 0 && (
                  <div className="space-y-3">
                    {/* Quantity Selector */}
                    <div className="flex items-center justify-between">
                      <label className="text-sm font-medium">Quantity</label>
                      <div className="flex items-center gap-2">
                        <Button
                          variant="outline"
                          size="icon"
                          className="h-8 w-8"
                          onClick={() => handleQuantityChange(-1)}
                          disabled={quantity <= 1}
                        >
                          <Minus className="h-4 w-4" />
                        </Button>
                        <Input
                          type="number"
                          min={1}
                          max={product.stock}
                          value={quantity}
                          onChange={(e) => handleQuantityInput(e.target.value)}
                          className="w-16 h-8 text-center [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                        />
                        <Button
                          variant="outline"
                          size="icon"
                          className="h-8 w-8"
                          onClick={() => handleQuantityChange(1)}
                          disabled={quantity >= product.stock}
                        >
                          <Plus className="h-4 w-4" />
                        </Button>
                      </div>
                    </div>

                    {/* Total Price */}
                    <div className="flex items-center justify-between text-sm">
                      <span className="text-muted-foreground">Total</span>
                      <div className="text-right">
                        <span className="font-bold text-lg text-primary">
                          UGX {(discountedPrice * quantity).toLocaleString()}
                        </span>
                        {hasDiscount && (
                          <span className="block text-xs text-muted-foreground line-through">
                            UGX {(product.price * quantity).toLocaleString()}
                          </span>
                        )}
                      </div>
                    </div>

                    {/* Action Buttons */}
                    <div className="flex gap-2">
                      <Button 
                        variant="outline"
                        className="flex-1" 
                        size="lg"
                        onClick={async () => {
                          setAddingToCart(true);
                          await addToCart(product.id, quantity);
                          setAddingToCart(false);
                        }}
                        disabled={addingToCart}
                      >
                        {addingToCart ? (
                          <>
                            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                            Adding...
                          </>
                        ) : (
                          <>
                            <Plus className="mr-2 h-4 w-4" />
                            Add to Cart
                          </>
                        )}
                      </Button>
                      <Button 
                        className="flex-1" 
                        size="lg"
                        onClick={handlePurchase}
                        disabled={purchasing}
                      >
                        {purchasing ? (
                          <>
                            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                            Processing...
                          </>
                        ) : (
                          <>
                            <ShoppingCart className="mr-2 h-4 w-4" />
                            Buy Now
                          </>
                        )}
                      </Button>
                    </div>
                  </div>
                )}

                {!isOwnProduct && product.stock === 0 && (
                  <Button className="w-full" size="lg" disabled>
                    Out of Stock
                  </Button>
                )}
              </div>

              <Separator className="my-6" />

              {/* Reviews Section */}
              <div className="space-y-4">
                <div className="flex items-center justify-between flex-wrap gap-2">
                  <h3 className="font-semibold flex items-center gap-2">
                    <MessageSquare className="h-4 w-4" />
                    Reviews ({reviews.length})
                  </h3>
                  <div className="flex items-center gap-2 flex-wrap">
                    {/* Photo Filter Toggle */}
                    {photoReviewCount > 0 && (
                      <Button
                        variant={showPhotoReviewsOnly ? "default" : "outline"}
                        size="sm"
                        onClick={() => setShowPhotoReviewsOnly(!showPhotoReviewsOnly)}
                        className="h-8 text-xs gap-1.5"
                      >
                        <Camera className="h-3.5 w-3.5" />
                        Photos ({photoReviewCount})
                      </Button>
                    )}
                    
                    {reviews.length > 1 && (
                      <Select value={reviewSortBy} onValueChange={(v) => setReviewSortBy(v as typeof reviewSortBy)}>
                        <SelectTrigger className="h-8 w-[130px] text-xs">
                          <ArrowUpDown className="h-3 w-3 mr-1" />
                          <SelectValue placeholder="Sort by" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="newest">Newest</SelectItem>
                          <SelectItem value="helpful">Most Helpful</SelectItem>
                          <SelectItem value="highest">Highest Rated</SelectItem>
                          <SelectItem value="lowest">Lowest Rated</SelectItem>
                        </SelectContent>
                      </Select>
                    )}
                    {canReview && !showReviewForm && (
                      <Button 
                        variant="outline" 
                        size="sm"
                        onClick={() => setShowReviewForm(true)}
                      >
                        {userReview ? 'Edit Review' : 'Write Review'}
                      </Button>
                    )}
                  </div>
                </div>

                {/* Active Filter Indicator */}
                {showPhotoReviewsOnly && (
                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    <span>Showing {sortedReviews.length} review{sortedReviews.length !== 1 ? 's' : ''} with photos</span>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setShowPhotoReviewsOnly(false)}
                      className="h-6 px-2 text-xs"
                    >
                      Show all
                    </Button>
                  </div>
                )}

                {/* Review Form */}
                {showReviewForm && user && (
                  <div className="p-4 rounded-lg bg-secondary/30 border border-border/50 space-y-4">
                    <div>
                      <label className="text-sm font-medium mb-2 block">Your Rating</label>
                      <div className="flex gap-1">
                        {[1, 2, 3, 4, 5].map((star) => (
                          <button
                            key={star}
                            type="button"
                            onClick={() => setRating(star)}
                            onMouseEnter={() => setHoverRating(star)}
                            onMouseLeave={() => setHoverRating(0)}
                            className="p-1 transition-transform hover:scale-110"
                          >
                            <Star
                              className={`h-6 w-6 ${
                                star <= (hoverRating || rating)
                                  ? 'fill-warning text-warning'
                                  : 'text-muted-foreground'
                              }`}
                            />
                          </button>
                        ))}
                      </div>
                    </div>

                    <div>
                      <label className="text-sm font-medium mb-2 block">Comment (optional)</label>
                      <Textarea
                        placeholder="Share your experience with this product..."
                        value={comment}
                        onChange={(e) => setComment(e.target.value)}
                        rows={3}
                      />
                    </div>

                    {/* Photo Upload */}
                    <ReviewImageUploader
                      images={reviewImages}
                      onImagesChange={setReviewImages}
                      userId={user.id}
                      maxImages={5}
                    />

                    <div className="flex gap-2">
                      <Button
                        variant="outline"
                        onClick={() => {
                          setShowReviewForm(false);
                          setReviewImages([]);
                        }}
                        disabled={submittingReview}
                      >
                        Cancel
                      </Button>
                      <Button
                        onClick={handleSubmitReview}
                        disabled={submittingReview}
                        className="flex-1"
                      >
                        {submittingReview ? (
                          <>
                            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                            Submitting...
                          </>
                        ) : (
                          userReview ? 'Update Review' : 'Submit Review'
                        )}
                      </Button>
                    </div>
                  </div>
                )}

                {/* Reviews List */}
                {loading ? (
                  <div className="flex items-center justify-center py-8">
                    <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
                  </div>
                ) : reviews.length === 0 ? (
                  <div className="text-center py-8">
                    <MessageSquare className="h-8 w-8 mx-auto text-muted-foreground mb-2" />
                    <p className="text-sm text-muted-foreground">No reviews yet</p>
                    {canReview && (
                      <p className="text-xs text-muted-foreground">Be the first to review!</p>
                    )}
                  </div>
                ) : (
                  <div className="space-y-3">
                    {sortedReviews.map((review) => (
                      <PhotoReviewCard
                        key={review.id}
                        review={review}
                        onImageClick={openReviewImageLightbox}
                        onVoteChange={fetchReviews}
                        isProductOwner={user?.id === product?.agent_id}
                        onResponseChange={fetchReviews}
                      />
                    ))}
                  </div>
                )}
              </div>
            </div>
          </ScrollArea>
        </DialogContent>
      </Dialog>

      {/* Review Image Lightbox */}
      <ReviewImageLightbox
        images={lightboxImages}
        initialIndex={lightboxIndex}
        open={lightboxOpen}
        onClose={() => setLightboxOpen(false)}
      />
    </>
  );
}
