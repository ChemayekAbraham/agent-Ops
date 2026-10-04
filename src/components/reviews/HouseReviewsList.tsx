import { Star, MapPin, User } from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';
import type { HouseReview, HouseRatingSummary } from '@/hooks/useHouseReviews';
import { Skeleton } from '@/components/ui/skeleton';
import { Progress } from '@/components/ui/progress';

interface HouseReviewsListProps {
  reviews: HouseReview[];
  summary: HouseRatingSummary;
  loading: boolean;
}

function RatingBar({ star, count, total }: { star: number; count: number; total: number }) {
  const pct = total > 0 ? (count / total) * 100 : 0;
  return (
    <div className="flex items-center gap-2 text-xs">
      <span className="w-3 text-muted-foreground font-medium">{star}</span>
      <Star className="h-3 w-3 fill-yellow-400 text-yellow-400" />
      <Progress value={pct} className="h-1.5 flex-1" />
      <span className="w-5 text-right text-muted-foreground">{count}</span>
    </div>
  );
}

export default function HouseReviewsList({ reviews, summary, loading }: HouseReviewsListProps) {
  if (loading) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-20 w-full rounded-xl" />
        <Skeleton className="h-16 w-full rounded-xl" />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Summary */}
      {summary.totalReviews > 0 && (
        <div className="flex gap-4 items-start p-3 rounded-xl bg-muted/30 border border-border/50">
          <div className="text-center shrink-0">
            <p className="text-3xl font-black text-foreground leading-none">{summary.averageRating.toFixed(1)}</p>
            <div className="flex items-center justify-center gap-0.5 mt-1">
              {[1, 2, 3, 4, 5].map(s => (
                <Star key={s} className={`h-3 w-3 ${s <= Math.round(summary.averageRating) ? 'fill-yellow-400 text-yellow-400' : 'text-muted-foreground/30'}`} />
              ))}
            </div>
            <p className="text-[10px] text-muted-foreground mt-0.5">{summary.totalReviews} review{summary.totalReviews !== 1 ? 's' : ''}</p>
          </div>
          <div className="flex-1 space-y-1">
            {[5, 4, 3, 2, 1].map(s => (
              <RatingBar key={s} star={s} count={summary.ratingBreakdown[s] || 0} total={summary.totalReviews} />
            ))}
          </div>
        </div>
      )}

      {/* Review cards */}
      {reviews.length === 0 ? (
        <p className="text-sm text-muted-foreground text-center py-4">No reviews yet — be the first!</p>
      ) : (
        <div className="space-y-3">
          {reviews.map(review => (
            <div key={review.id} className="p-3 rounded-xl border border-border/50 bg-card space-y-2">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  {review.reviewer_profile?.avatar_url ? (
                    <img src={review.reviewer_profile.avatar_url} alt="" className="h-7 w-7 rounded-full object-cover" />
                  ) : (
                    <div className="h-7 w-7 rounded-full bg-muted flex items-center justify-center">
                      <User className="h-3.5 w-3.5 text-muted-foreground" />
                    </div>
                  )}
                  <div>
                    <p className="text-sm font-medium leading-tight">{review.reviewer_profile?.full_name || 'Anonymous'}</p>
                    <p className="text-[10px] text-muted-foreground">
                      {formatDistanceToNow(new Date(review.created_at), { addSuffix: true })}
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-0.5">
                  {[1, 2, 3, 4, 5].map(s => (
                    <Star key={s} className={`h-3 w-3 ${s <= review.rating ? 'fill-yellow-400 text-yellow-400' : 'text-muted-foreground/30'}`} />
                  ))}
                </div>
              </div>
              {review.review_text && (
                <p className="text-sm text-muted-foreground leading-relaxed">{review.review_text}</p>
              )}
              <div className="flex items-center gap-1 text-[10px] text-muted-foreground/60">
                <MapPin className="h-2.5 w-2.5" />
                GPS verified review
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
