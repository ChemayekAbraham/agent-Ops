import { useState, useEffect, useCallback } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';

export interface HouseReview {
  id: string;
  house_id: string;
  reviewer_id: string;
  rating: number;
  review_text: string | null;
  created_at: string;
  updated_at: string;
  reviewer_profile?: {
    full_name: string;
    avatar_url: string | null;
  };
}

export interface HouseRatingSummary {
  averageRating: number;
  totalReviews: number;
  ratingBreakdown: Record<number, number>;
}

export function useHouseReviews(houseId: string | undefined) {
  const { user } = useAuth();
  const [reviews, setReviews] = useState<HouseReview[]>([]);
  const [summary, setSummary] = useState<HouseRatingSummary>({
    averageRating: 0,
    totalReviews: 0,
    ratingBreakdown: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 },
  });
  const [myReview, setMyReview] = useState<HouseReview | null>(null);
  const [loading, setLoading] = useState(true);

  const fetchReviews = useCallback(async () => {
    if (!houseId) return;
    setLoading(true);

    const { data, error } = await supabase
      .from('house_reviews')
      .select('id, house_id, reviewer_id, rating, review_text, created_at, updated_at')
      .eq('house_id', houseId)
      .order('created_at', { ascending: false });

    if (error) {
      console.error('Error fetching house reviews:', error);
      setLoading(false);
      return;
    }

    const reviewsList = data || [];

    // Fetch reviewer profiles
    const reviewerIds = [...new Set(reviewsList.map(r => r.reviewer_id))];
    let profiles: { id: string; full_name: string; avatar_url: string | null }[] = [];

    if (reviewerIds.length > 0) {
      const { data: profilesData } = await supabase
        .from('profiles')
        .select('id, full_name, avatar_url')
        .in('id', reviewerIds);
      profiles = profilesData || [];
    }

    const enriched: HouseReview[] = reviewsList.map(r => ({
      ...r,
      reviewer_profile: profiles.find(p => p.id === r.reviewer_id) || undefined,
    }));

    setReviews(enriched);

    // Summary
    const total = reviewsList.length;
    const breakdown: Record<number, number> = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
    let sum = 0;
    reviewsList.forEach(r => {
      breakdown[r.rating] = (breakdown[r.rating] || 0) + 1;
      sum += r.rating;
    });
    setSummary({
      averageRating: total > 0 ? sum / total : 0,
      totalReviews: total,
      ratingBreakdown: breakdown,
    });

    if (user) {
      setMyReview(enriched.find(r => r.reviewer_id === user.id) || null);
    }

    setLoading(false);
  }, [houseId, user]);

  useEffect(() => {
    fetchReviews();
  }, [fetchReviews]);

  return { reviews, summary, myReview, loading, refetch: fetchReviews };
}
