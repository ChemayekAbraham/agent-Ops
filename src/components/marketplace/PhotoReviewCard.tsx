import { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { StorageImage } from '@/components/ui/StorageImage';
import { Star, CheckCircle2, Camera, ChevronLeft, ChevronRight, X, ThumbsUp, ThumbsDown, MessageCircle, Store, Edit2, Trash2, Send } from 'lucide-react';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { format } from 'date-fns';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
import { toast } from 'sonner';

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
  agent_name?: string;
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

interface PhotoReviewCardProps {
  review: Review;
  onImageClick?: (images: ReviewImage[], startIndex: number) => void;
  onVoteChange?: () => void;
  isProductOwner?: boolean;
  onResponseChange?: () => void;
}

export function PhotoReviewCard({ review, onImageClick, onVoteChange, isProductOwner, onResponseChange }: PhotoReviewCardProps) {
  const { user } = useAuth();
  const [voting, setVoting] = useState(false);
  const [showResponseForm, setShowResponseForm] = useState(false);
  const [responseText, setResponseText] = useState(review.seller_response?.response_text || '');
  const [submittingResponse, setSubmittingResponse] = useState(false);
  const [editingResponse, setEditingResponse] = useState(false);
  const hasImages = review.images && review.images.length > 0;

  const handleVote = async (voteType: 'upvote' | 'downvote') => {
    if (!user) {
      toast.error('Please sign in to vote');
      return;
    }

    if (user.id === review.buyer_id) {
      toast.error("You can't vote on your own review");
      return;
    }

    setVoting(true);
    try {
      const currentVote = review.votes?.userVote;

      if (currentVote === voteType) {
        // Remove vote
        const { error } = await supabase
          .from('review_votes')
          .delete()
          .eq('review_id', review.id)
          .eq('user_id', user.id);

        if (error) throw error;
      } else if (currentVote) {
        // Update vote
        const { error } = await supabase
          .from('review_votes')
          .update({ vote_type: voteType })
          .eq('review_id', review.id)
          .eq('user_id', user.id);

        if (error) throw error;
      } else {
        // Insert new vote
        const { error } = await supabase
          .from('review_votes')
          .insert({
            review_id: review.id,
            user_id: user.id,
            vote_type: voteType,
          });

        if (error) throw error;
      }

      onVoteChange?.();
    } catch (error: any) {
      toast.error('Failed to vote', { description: error.message });
    } finally {
      setVoting(false);
    }
  };

  const helpfulScore = (review.votes?.upvotes || 0) - (review.votes?.downvotes || 0);

  const handleSubmitResponse = async () => {
    if (!user || !responseText.trim()) return;

    setSubmittingResponse(true);
    try {
      if (review.seller_response && editingResponse) {
        // Update existing response
        const { error } = await supabase
          .from('review_responses')
          .update({ response_text: responseText.trim() })
          .eq('id', review.seller_response.id);

        if (error) throw error;
        toast.success('Response updated');
      } else {
        // Create new response
        const { error } = await supabase
          .from('review_responses')
          .insert({
            review_id: review.id,
            agent_id: user.id,
            response_text: responseText.trim(),
          });

        if (error) throw error;
        toast.success('Response posted');
      }

      setShowResponseForm(false);
      setEditingResponse(false);
      onResponseChange?.();
    } catch (error: any) {
      toast.error('Failed to submit response', { description: error.message });
    } finally {
      setSubmittingResponse(false);
    }
  };

  const handleDeleteResponse = async () => {
    if (!review.seller_response) return;

    try {
      const { error } = await supabase
        .from('review_responses')
        .delete()
        .eq('id', review.seller_response.id);

      if (error) throw error;
      toast.success('Response deleted');
      setResponseText('');
      onResponseChange?.();
    } catch (error: any) {
      toast.error('Failed to delete response', { description: error.message });
    }
  };

  return (
    <div className="p-4 rounded-xl bg-card border border-border/50 space-y-3">
      {/* Header */}
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-3">
          <Avatar className="h-10 w-10">
            <AvatarImage src={review.buyer_avatar || undefined} />
            <AvatarFallback className="bg-primary/10 text-primary text-sm">
              {(review.buyer_name || 'A').charAt(0).toUpperCase()}
            </AvatarFallback>
          </Avatar>
          <div>
            <div className="flex items-center gap-2">
              <span className="font-medium text-sm">{review.buyer_name || 'Anonymous'}</span>
              {review.is_verified_purchase && (
                <Badge variant="outline" className="text-[10px] px-1.5 py-0 gap-1 text-success border-success/30 bg-success/10">
                  <CheckCircle2 className="h-3 w-3" />
                  Verified Purchase
                </Badge>
              )}
            </div>
            <div className="flex items-center gap-2">
              <div className="flex">
                {[1, 2, 3, 4, 5].map((star) => (
                  <Star
                    key={star}
                    className={`h-3 w-3 ${
                      star <= review.rating
                        ? 'fill-amber-400 text-amber-400'
                        : 'text-gray-300'
                    }`}
                  />
                ))}
              </div>
              <span className="text-xs text-muted-foreground">
                {format(new Date(review.created_at), 'MMM d, yyyy')}
              </span>
            </div>
          </div>
        </div>
      </div>

      {/* Comment */}
      {review.comment && (
        <p className="text-sm text-muted-foreground leading-relaxed">
          {review.comment}
        </p>
      )}

      {/* Review Images */}
      {hasImages && (
        <div className="flex gap-2 overflow-x-auto pb-1">
          {review.images!.map((image, index) => (
            <motion.button
              key={image.id}
              whileHover={{ scale: 1.02 }}
              whileTap={{ scale: 0.98 }}
              onClick={() => onImageClick?.(review.images!, index)}
              className="flex-shrink-0 w-20 h-20 rounded-lg overflow-hidden border border-border hover:border-primary/50 transition-colors"
            >
              <StorageImage
                src={image.image_url}
                alt={`Review photo ${index + 1}`}
                className="w-full h-full object-cover"
              />
            </motion.button>
          ))}
          {review.images!.length > 0 && (
            <div className="flex items-center text-xs text-muted-foreground gap-1 pl-2">
              <Camera className="h-3.5 w-3.5" />
              {review.images!.length}
            </div>
          )}
        </div>
      )}

      {/* Seller Response Display */}
      {review.seller_response && !editingResponse && (
        <div className="mt-3 p-3 rounded-lg bg-primary/5 border border-primary/20">
          <div className="flex items-start gap-2">
            <div className="p-1.5 rounded-full bg-primary/10">
              <Store className="h-3.5 w-3.5 text-primary" />
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-xs font-medium text-primary">Seller Response</span>
                <span className="text-[10px] text-muted-foreground">
                  {format(new Date(review.seller_response.updated_at || review.seller_response.created_at), 'MMM d, yyyy')}
                </span>
                {isProductOwner && (
                  <div className="flex items-center gap-1 ml-auto">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        setEditingResponse(true);
                        setShowResponseForm(true);
                        setResponseText(review.seller_response?.response_text || '');
                      }}
                      className="h-6 w-6 p-0 text-muted-foreground hover:text-primary"
                    >
                      <Edit2 className="h-3 w-3" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={handleDeleteResponse}
                      className="h-6 w-6 p-0 text-muted-foreground hover:text-destructive"
                    >
                      <Trash2 className="h-3 w-3" />
                    </Button>
                  </div>
                )}
              </div>
              <p className="text-sm text-muted-foreground mt-1">
                {review.seller_response.response_text}
              </p>
            </div>
          </div>
        </div>
      )}

      {/* Response Form */}
      {showResponseForm && isProductOwner && (
        <div className="mt-3 p-3 rounded-lg bg-muted/50 border border-border space-y-2">
          <div className="flex items-center gap-2">
            <Store className="h-4 w-4 text-primary" />
            <span className="text-xs font-medium">
              {editingResponse ? 'Edit your response' : 'Reply to this review'}
            </span>
          </div>
          <Textarea
            value={responseText}
            onChange={(e) => setResponseText(e.target.value)}
            placeholder="Write your response to this customer review..."
            className="min-h-[80px] text-sm resize-none"
            maxLength={1000}
          />
          <div className="flex items-center justify-between">
            <span className="text-[10px] text-muted-foreground">
              {responseText.length}/1000
            </span>
            <div className="flex gap-2">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setShowResponseForm(false);
                  setEditingResponse(false);
                  setResponseText(review.seller_response?.response_text || '');
                }}
                className="h-7 text-xs"
              >
                Cancel
              </Button>
              <Button
                size="sm"
                onClick={handleSubmitResponse}
                disabled={!responseText.trim() || submittingResponse}
                className="h-7 text-xs gap-1"
              >
                <Send className="h-3 w-3" />
                {submittingResponse ? 'Posting...' : editingResponse ? 'Update' : 'Post Response'}
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Voting Section */}
      <div className="flex items-center gap-3 pt-2 border-t border-border/50">
        <span className="text-xs text-muted-foreground">Helpful?</span>
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => handleVote('upvote')}
            disabled={voting}
            className={`h-7 px-2 gap-1 ${
              review.votes?.userVote === 'upvote'
                ? 'text-success bg-success/10 hover:bg-success/20'
                : 'text-muted-foreground hover:text-success'
            }`}
          >
            <ThumbsUp className="h-3.5 w-3.5" />
            <span className="text-xs">{review.votes?.upvotes || 0}</span>
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => handleVote('downvote')}
            disabled={voting}
            className={`h-7 px-2 gap-1 ${
              review.votes?.userVote === 'downvote'
                ? 'text-destructive bg-destructive/10 hover:bg-destructive/20'
                : 'text-muted-foreground hover:text-destructive'
            }`}
          >
            <ThumbsDown className="h-3.5 w-3.5" />
            <span className="text-xs">{review.votes?.downvotes || 0}</span>
          </Button>
        </div>
        {helpfulScore > 0 && (
          <span className="text-xs text-success ml-auto">
            {helpfulScore} found this helpful
          </span>
        )}
        
        {/* Reply Button for Product Owner */}
        {isProductOwner && !review.seller_response && !showResponseForm && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setShowResponseForm(true)}
            className="h-7 px-2 gap-1 text-primary hover:text-primary hover:bg-primary/10 ml-auto"
          >
            <MessageCircle className="h-3.5 w-3.5" />
            <span className="text-xs">Reply</span>
          </Button>
        )}
      </div>
    </div>
  );
}

// Lightbox for review images
interface ReviewImageLightboxProps {
  images: ReviewImage[];
  initialIndex: number;
  open: boolean;
  onClose: () => void;
}

export function ReviewImageLightbox({ images, initialIndex, open, onClose }: ReviewImageLightboxProps) {
  const [currentIndex, setCurrentIndex] = useState(initialIndex);

  const goToPrevious = () => {
    setCurrentIndex((prev) => (prev === 0 ? images.length - 1 : prev - 1));
  };

  const goToNext = () => {
    setCurrentIndex((prev) => (prev === images.length - 1 ? 0 : prev + 1));
  };

  if (!open || images.length === 0) return null;

  return (
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        className="fixed inset-0 z-[100] bg-black/95 flex items-center justify-center"
        onClick={onClose}
      >
        {/* Close button */}
        <Button
          variant="ghost"
          size="icon"
          onClick={onClose}
          className="absolute top-4 right-4 text-white/70 hover:text-white hover:bg-white/10 z-10"
        >
          <X className="h-6 w-6" />
        </Button>

        {/* Counter */}
        <div className="absolute top-4 left-4 text-white/70 text-sm">
          {currentIndex + 1} / {images.length}
        </div>

        {/* Navigation */}
        {images.length > 1 && (
          <>
            <Button
              variant="ghost"
              size="icon"
              onClick={(e) => { e.stopPropagation(); goToPrevious(); }}
              className="absolute left-4 top-1/2 -translate-y-1/2 h-12 w-12 rounded-full text-white/70 hover:text-white hover:bg-white/10"
            >
              <ChevronLeft className="h-8 w-8" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              onClick={(e) => { e.stopPropagation(); goToNext(); }}
              className="absolute right-4 top-1/2 -translate-y-1/2 h-12 w-12 rounded-full text-white/70 hover:text-white hover:bg-white/10"
            >
              <ChevronRight className="h-8 w-8" />
            </Button>
          </>
        )}

        {/* Image */}
        <motion.img
          key={currentIndex}
          initial={{ opacity: 0, scale: 0.9 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ duration: 0.2 }}
          src={images[currentIndex].image_url}
          alt={`Review image ${currentIndex + 1}`}
          className="max-h-[85vh] max-w-[90vw] object-contain"
          onClick={(e) => e.stopPropagation()}
        />

        {/* Thumbnails */}
        {images.length > 1 && (
          <div className="absolute bottom-4 left-1/2 -translate-x-1/2 flex gap-2">
            {images.map((image, index) => (
              <button
                key={image.id}
                onClick={(e) => { e.stopPropagation(); setCurrentIndex(index); }}
                className={`w-12 h-12 rounded-lg overflow-hidden border-2 transition-all ${
                  index === currentIndex
                    ? 'border-white opacity-100'
                    : 'border-transparent opacity-50 hover:opacity-75'
                }`}
              >
                <StorageImage
                  src={image.image_url}
                  alt={`Thumbnail ${index + 1}`}
                  className="w-full h-full object-cover"
                />
              </button>
            ))}
          </div>
        )}
      </motion.div>
    </AnimatePresence>
  );
}
