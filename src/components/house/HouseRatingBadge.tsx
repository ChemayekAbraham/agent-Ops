import { useState, useEffect } from 'react';
import { Star } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';

interface HouseRatingBadgeProps {
  houseId: string;
  houseLat?: number | null;
  houseLng?: number | null;
  className?: string;
}

export default function HouseRatingBadge({ houseId, houseLat, houseLng, className = '' }: HouseRatingBadgeProps) {
  const [avg, setAvg] = useState(0);
  const [count, setCount] = useState(0);

  useEffect(() => {
    supabase
      .from('house_reviews')
      .select('rating')
      .eq('house_id', houseId)
      .then(({ data }) => {
        if (data && data.length > 0) {
          setCount(data.length);
          setAvg(data.reduce((s, r) => s + r.rating, 0) / data.length);
        }
      });
  }, [houseId]);

  const handleClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    if (houseLat && houseLng) {
      // Open Google Maps directions so user can visit the house
      window.open(
        `https://www.google.com/maps/dir/?api=1&destination=${houseLat},${houseLng}&travelmode=walking`,
        '_blank'
      );
    } else {
      // Fallback: navigate to house detail reviews section
      window.location.href = `/houses/${houseId}#reviews`;
    }
  };

  return (
    <button
      type="button"
      onClick={handleClick}
      className={`flex items-center gap-1 bg-black/70 backdrop-blur-sm text-white text-[11px] font-semibold px-2 py-1 rounded-full hover:bg-black/90 transition-colors ${className}`}
      title={count > 0 ? `${avg.toFixed(1)} from ${count} reviews` : 'Visit this house to rate it!'}
    >
      <Star className="h-3 w-3 fill-yellow-400 text-yellow-400" />
      {count > 0 ? (
        <span>{avg.toFixed(1)} ({count})</span>
      ) : (
        <span>Visit & Rate</span>
      )}
    </button>
  );
}
