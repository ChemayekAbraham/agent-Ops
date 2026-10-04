import { Star } from 'lucide-react';

interface StarRatingDisplayProps {
  rating: number;
  totalReviews?: number;
  size?: 'sm' | 'md' | 'lg';
  showCount?: boolean;
}

const sizeMap = {
  sm: 'h-3 w-3',
  md: 'h-4 w-4',
  lg: 'h-5 w-5',
};

export default function StarRatingDisplay({ rating, totalReviews = 0, size = 'sm', showCount = true }: StarRatingDisplayProps) {
  const roundedRating = Math.round(rating * 10) / 10;

  return (
    <div className="flex items-center gap-1">
      <div className="flex items-center gap-0.5">
        {[1, 2, 3, 4, 5].map((star) => {
          const filled = star <= Math.floor(rating);
          const halfFilled = !filled && star <= rating + 0.5;
          return (
            <Star
              key={star}
              className={`${sizeMap[size]} ${
                filled
                  ? 'fill-yellow-400 text-yellow-400'
                  : halfFilled
                  ? 'fill-yellow-400/50 text-yellow-400'
                  : 'text-muted-foreground/30'
              }`}
            />
          );
        })}
      </div>
      {showCount && (
        <span className="text-xs text-muted-foreground">
          {roundedRating > 0 ? roundedRating.toFixed(1) : '—'} ({totalReviews})
        </span>
      )}
    </div>
  );
}
