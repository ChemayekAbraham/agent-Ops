import { useState } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Loader2, Send } from 'lucide-react';
import { toast } from 'sonner';
import StarRatingInput from './StarRatingInput';
import type { UserReview } from '@/hooks/useUserReviews';

interface WriteReviewFormProps {
  reviewedUserId: string;
  reviewedUserName: string;
  existingReview?: UserReview | null;
  onSuccess?: () => void;
}

export default function WriteReviewForm({ reviewedUserId, reviewedUserName, existingReview, onSuccess }: WriteReviewFormProps) {
  const { user } = useAuth();
  const [rating, setRating] = useState(existingReview?.rating || 0);
  const [reviewText, setReviewText] = useState(existingReview?.review_text || '');
  const [saving, setSaving] = useState(false);

  // Determine reviewer's role
  const getReviewerRole = async (): Promise<string> => {
    if (!user) return 'user';
    const { data } = await supabase
      .from('user_roles')
      .select('role')
      .eq('user_id', user.id);
    const roles = data?.map(r => r.role) || [];
    if (roles.includes('agent')) return 'agent';
    if (roles.includes('landlord')) return 'landlord';
    if (roles.includes('supporter')) return 'supporter';
    if (roles.includes('tenant')) return 'tenant';
    return 'user';
  };

  const handleSubmit = async () => {
    if (!user) return;
    if (rating === 0) {
      toast.error('Please select a rating');
      return;
    }

    setSaving(true);
    const reviewerRole = await getReviewerRole();

    const { error } = await supabase
      .from('user_reviews')
      .upsert({
        reviewer_id: user.id,
        reviewed_user_id: reviewedUserId,
        rating,
        review_text: reviewText.trim() || null,
        reviewer_role: reviewerRole,
        updated_at: new Date().toISOString(),
      }, {
        onConflict: 'reviewer_id,reviewed_user_id',
      });

    setSaving(false);

    if (error) {
      toast.error('Failed to save review');
      console.error('Review error:', error);
      return;
    }

    toast.success(`Review for ${reviewedUserName} saved!`);
    onSuccess?.();
  };

  if (!user || user.id === reviewedUserId) return null;

  return (
    <div className="space-y-3 p-3 rounded-lg bg-muted/30 border border-border/50">
      <p className="text-xs font-medium text-muted-foreground">
        {existingReview ? 'Update your review' : 'Write a review'}
      </p>
      <StarRatingInput value={rating} onChange={setRating} size="md" />
      <Textarea
        value={reviewText}
        onChange={(e) => setReviewText(e.target.value)}
        placeholder={`Write about your experience with ${reviewedUserName}...`}
        className="min-h-[60px] resize-none text-sm"
        maxLength={500}
      />
      <div className="flex items-center justify-between">
        <span className="text-xs text-muted-foreground">{reviewText.length}/500</span>
        <Button
          size="sm"
          onClick={handleSubmit}
          disabled={saving || rating === 0}
          className="gap-1.5"
        >
          {saving ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Send className="h-3.5 w-3.5" />
          )}
          {existingReview ? 'Update' : 'Submit'}
        </Button>
      </div>
    </div>
  );
}
