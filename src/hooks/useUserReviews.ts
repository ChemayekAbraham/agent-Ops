import { useState, useEffect, useCallback } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';

export interface UserReview {
  id: string;
  reviewer_id: string;
  reviewed_user_id: string;
  rating: number;
  review_text: string | null;
  reviewer_role: string | null;
  created_at: string;
  updated_at: string;
  reviewer_profile?: {
    full_name: string;
    avatar_url: string | null;
  };
}

export interface UserRatingSummary {
  averageRating: number;
  totalReviews: number;
  ratingBreakdown: Record<number, number>; // { 5: 10, 4: 5, ... }
}

export function useUserReviews(userId: string | undefined) {
  const { user } = useAuth();
  const [reviews, setReviews] = useState<UserReview[]>([]);
  const [summary, setSummary] = useState<UserRatingSummary>({
    averageRating: 0,
    totalReviews: 0,
    ratingBreakdown: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 },
  });
  const [myReview, setMyReview] = useState<UserReview | null>(null);
  const [loading, setLoading] = useState(true);

  const fetchReviews = useCallback(async () => {
    if (!userId) return;
    setLoading(true);

    const { data, error } = await supabase
      .from('user_reviews')
      .select('*')
      .eq('reviewed_user_id', userId)
      .order('created_at', { ascending: false });

    if (error) {
      console.error('Error fetching reviews:', error);
      setLoading(false);
      return;
    }

    const reviewsList = data || [];

    // Fetch reviewer profiles
    const reviewerIds = reviewsList.map(r => r.reviewer_id);
    let profiles: { id: string; full_name: string; avatar_url: string | null }[] = [];
    
    if (reviewerIds.length > 0) {
      const { data: profilesData } = await supabase
        .from('profiles')
        .select('id, full_name, avatar_url')
        .in('id', reviewerIds);
      profiles = profilesData || [];
    }

    const reviewsWithProfiles: UserReview[] = reviewsList.map(r => ({
      ...r,
      reviewer_profile: profiles.find(p => p.id === r.reviewer_id) || undefined,
    }));

    setReviews(reviewsWithProfiles);

    // Calculate summary
    const totalReviews = reviewsList.length;
    const breakdown: Record<number, number> = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
    let totalRating = 0;
    reviewsList.forEach(r => {
      breakdown[r.rating] = (breakdown[r.rating] || 0) + 1;
      totalRating += r.rating;
    });
    setSummary({
      averageRating: totalReviews > 0 ? totalRating / totalReviews : 0,
      totalReviews,
      ratingBreakdown: breakdown,
    });

    // Find current user's review
    if (user) {
      const mine = reviewsWithProfiles.find(r => r.reviewer_id === user.id);
      setMyReview(mine || null);
    }

    setLoading(false);
  }, [userId, user]);

  useEffect(() => {
    fetchReviews();
  }, [fetchReviews]);

  // Realtime removed — user_reviews not in realtime whitelist. Refresh on revisit.

  return { reviews, summary, myReview, loading, refetch: fetchReviews };
}
