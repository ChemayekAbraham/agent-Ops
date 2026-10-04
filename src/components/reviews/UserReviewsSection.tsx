import { useUserReviews } from '@/hooks/useUserReviews';
import StarRatingDisplay from './StarRatingDisplay';
import WriteReviewForm from './WriteReviewForm';
import UserReviewsList from './UserReviewsList';
import { Separator } from '@/components/ui/separator';

interface UserReviewsSectionProps {
  userId: string;
  userName: string;
  compact?: boolean;
}

export default function UserReviewsSection({ userId, userName, compact = false }: UserReviewsSectionProps) {
  const { reviews, summary, myReview, loading, refetch } = useUserReviews(userId);

  return (
    <div className="space-y-3">
      {/* Rating Summary */}
      <div className="flex items-center justify-between">
        <div>
          <p className="text-sm font-medium">Reviews & Ratings</p>
          <StarRatingDisplay
            rating={summary.averageRating}
            totalReviews={summary.totalReviews}
            size="md"
          />
        </div>
        {summary.totalReviews > 0 && (
          <div className="text-right">
            <p className="text-2xl font-bold text-foreground">{summary.averageRating.toFixed(1)}</p>
            <p className="text-[10px] text-muted-foreground">{summary.totalReviews} review{summary.totalReviews !== 1 ? 's' : ''}</p>
          </div>
        )}
      </div>

      {!compact && (
        <>
          <Separator />
          {/* Write Review */}
          <WriteReviewForm
            reviewedUserId={userId}
            reviewedUserName={userName}
            existingReview={myReview}
            onSuccess={refetch}
          />
          <Separator />
          {/* Reviews List */}
          <UserReviewsList reviews={reviews} loading={loading} />
        </>
      )}
    </div>
  );
}
