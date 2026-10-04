import { motion, AnimatePresence } from 'framer-motion';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Star, MessageSquare } from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';
import type { UserReview } from '@/hooks/useUserReviews';

interface UserReviewsListProps {
  reviews: UserReview[];
  loading?: boolean;
}

const roleColors: Record<string, string> = {
  agent: 'bg-amber-500/10 text-amber-600 border-amber-500/30',
  landlord: 'bg-purple-500/10 text-purple-600 border-purple-500/30',
  tenant: 'bg-blue-500/10 text-blue-600 border-blue-500/30',
  supporter: 'bg-emerald-500/10 text-emerald-600 border-emerald-500/30',
  user: 'bg-muted text-muted-foreground',
};

export default function UserReviewsList({ reviews, loading }: UserReviewsListProps) {
  if (loading) {
    return (
      <div className="space-y-3">
        {[1, 2].map(i => (
          <div key={i} className="h-16 rounded-lg bg-muted/50 animate-pulse" />
        ))}
      </div>
    );
  }

  if (reviews.length === 0) {
    return (
      <div className="text-center py-6">
        <MessageSquare className="h-8 w-8 text-muted-foreground/40 mx-auto mb-2" />
        <p className="text-sm text-muted-foreground">No reviews yet</p>
      </div>
    );
  }

  return (
    <div className="space-y-3 max-h-[300px] overflow-y-auto pr-1">
      <AnimatePresence>
        {reviews.map((review, index) => (
          <motion.div
            key={review.id}
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: index * 0.05 }}
            className="p-3 rounded-lg bg-background/60 border border-border/40"
          >
            <div className="flex items-start gap-2.5">
              <Avatar className="h-8 w-8 shrink-0">
                <AvatarImage src={review.reviewer_profile?.avatar_url || undefined} />
                <AvatarFallback className="text-xs bg-primary/10 text-primary">
                  {(review.reviewer_profile?.full_name || 'U').charAt(0).toUpperCase()}
                </AvatarFallback>
              </Avatar>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-sm font-medium truncate">
                    {review.reviewer_profile?.full_name || 'User'}
                  </span>
                  {review.reviewer_role && (
                    <Badge variant="outline" className={`text-[10px] h-4 px-1.5 ${roleColors[review.reviewer_role] || roleColors.user}`}>
                      {review.reviewer_role}
                    </Badge>
                  )}
                </div>
                <div className="flex items-center gap-2 mt-0.5">
                  <div className="flex items-center gap-0.5">
                    {[1, 2, 3, 4, 5].map(s => (
                      <Star
                        key={s}
                        className={`h-3 w-3 ${s <= review.rating ? 'fill-yellow-400 text-yellow-400' : 'text-muted-foreground/30'}`}
                      />
                    ))}
                  </div>
                  <span className="text-[10px] text-muted-foreground">
                    {formatDistanceToNow(new Date(review.created_at), { addSuffix: true })}
                  </span>
                </div>
                {review.review_text && (
                  <p className="text-xs text-muted-foreground mt-1.5 leading-relaxed">
                    "{review.review_text}"
                  </p>
                )}
              </div>
            </div>
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );
}
