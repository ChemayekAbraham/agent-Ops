import { useState, useEffect } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
import { useCaptureLocation } from '@/hooks/useCaptureLocation';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Loader2, Send, MapPin, LocateFixed, Navigation, FileText } from 'lucide-react';
import { toast } from 'sonner';
import StarRatingInput from './StarRatingInput';
import type { HouseReview } from '@/hooks/useHouseReviews';

interface WriteHouseReviewFormProps {
  houseId: string;
  houseTitle: string;
  existingReview?: HouseReview | null;
  houseLat?: number | null;
  houseLng?: number | null;
  onSuccess?: () => void;
}

const DRAFT_KEY = (houseId: string) => `review_draft_${houseId}`;
const PROXIMITY_THRESHOLD_M = 500; // must be within 500m of house

function haversineDistance(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export default function WriteHouseReviewForm({ houseId, houseTitle, existingReview, houseLat, houseLng, onSuccess }: WriteHouseReviewFormProps) {
  const { user } = useAuth();
  const { location, loading: geoLoading, error: geoError, captureLocation } = useCaptureLocation();
  const [rating, setRating] = useState(existingReview?.rating || 0);
  const [reviewText, setReviewText] = useState(existingReview?.review_text || '');
  const [saving, setSaving] = useState(false);
  const [hasDraft, setHasDraft] = useState(false);

  // Load draft on mount
  useEffect(() => {
    if (existingReview) return;
    try {
      const raw = localStorage.getItem(DRAFT_KEY(houseId));
      if (raw) {
        const draft = JSON.parse(raw);
        if (draft.rating) setRating(draft.rating);
        if (draft.reviewText) setReviewText(draft.reviewText);
        setHasDraft(true);
      }
    } catch { /* ignore */ }
  }, [houseId, existingReview]);

  // Auto-save draft when rating or text changes
  useEffect(() => {
    if (!user || existingReview) return;
    if (rating === 0 && !reviewText.trim()) {
      localStorage.removeItem(DRAFT_KEY(houseId));
      setHasDraft(false);
      return;
    }
    localStorage.setItem(DRAFT_KEY(houseId), JSON.stringify({ rating, reviewText }));
    setHasDraft(true);
  }, [rating, reviewText, houseId, user, existingReview]);

  const proximityOk = (() => {
    if (!location || houseLat == null || houseLng == null) return false;
    const dist = haversineDistance(location.latitude, location.longitude, houseLat, houseLng);
    return dist <= PROXIMITY_THRESHOLD_M;
  })();

  const distanceFromHouse = (() => {
    if (!location || houseLat == null || houseLng == null) return null;
    return haversineDistance(location.latitude, location.longitude, houseLat, houseLng);
  })();

  const googleMapsUrl = houseLat && houseLng
    ? `https://www.google.com/maps/dir/?api=1&destination=${houseLat},${houseLng}&travelmode=walking`
    : null;

  const handleCaptureGPS = async () => {
    const loc = await captureLocation();
    if (!loc) return;
    if (houseLat != null && houseLng != null) {
      const dist = haversineDistance(loc.latitude, loc.longitude, houseLat, houseLng);
      if (dist > PROXIMITY_THRESHOLD_M) {
        toast.error(`You're ${dist < 1000 ? `${Math.round(dist)}m` : `${(dist / 1000).toFixed(1)}km`} away. You need to be within ${PROXIMITY_THRESHOLD_M}m of the house.`);
        return;
      }
    }
    toast.success('Location verified! You can now submit your review.');
  };

  const handleSubmit = async () => {
    if (!user) { toast.error('Please sign in to leave a review'); return; }
    if (rating === 0) { toast.error('Please select a rating'); return; }
    if (!location) { toast.error('GPS required — capture your location first'); return; }
    if (!proximityOk) {
      toast.error('You must be near the house to submit. Use directions to navigate there first.');
      return;
    }

    setSaving(true);

    const { error } = await supabase
      .from('house_reviews')
      .upsert({
        house_id: houseId,
        reviewer_id: user.id,
        rating,
        review_text: reviewText.trim() || null,
        latitude: location.latitude,
        longitude: location.longitude,
        accuracy: location.accuracy,
        updated_at: new Date().toISOString(),
      }, { onConflict: 'house_id,reviewer_id' });

    setSaving(false);

    if (error) {
      toast.error('Failed to save review');
      console.error('House review error:', error);
      return;
    }

    // Clear draft on success
    localStorage.removeItem(DRAFT_KEY(houseId));
    setHasDraft(false);
    toast.success('Review posted!');
    onSuccess?.();
  };

  if (!user) {
    return (
      <div className="p-3 rounded-lg bg-muted/30 border border-border/50 text-center">
        <p className="text-sm text-muted-foreground">Sign in to review this house</p>
      </div>
    );
  }

  return (
    <div className="space-y-3 p-3 rounded-xl bg-muted/30 border border-border/50">
      <div className="flex items-center justify-between">
        <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
          {existingReview ? 'Update your review' : 'Review this house'}
        </p>
        {hasDraft && !existingReview && (
          <span className="flex items-center gap-1 text-[10px] font-medium text-warning">
            <FileText className="h-3 w-3" /> Draft saved
          </span>
        )}
      </div>

      <StarRatingInput value={rating} onChange={setRating} size="md" />

      <Textarea
        value={reviewText}
        onChange={(e) => setReviewText(e.target.value)}
        placeholder={`How is the quality of "${houseTitle}"? Write your review, then visit to post it.`}
        className="min-h-[60px] resize-none text-sm"
        maxLength={500}
      />

      {/* Step 1: Get directions to the house */}
      {googleMapsUrl && !proximityOk && (
        <a
          href={googleMapsUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center gap-2 p-2.5 rounded-lg bg-primary/10 border border-primary/20 text-primary text-sm font-medium hover:bg-primary/20 transition-colors"
        >
          <Navigation className="h-4 w-4 shrink-0" />
          <div className="flex-1 min-w-0">
            <p className="font-semibold text-xs">Get Directions to This House</p>
            <p className="text-[10px] text-muted-foreground">Visit the house first, then capture GPS to post your review</p>
          </div>
        </a>
      )}

      {/* Step 2: Capture GPS once at the house */}
      <div className="flex items-center gap-2">
        <Button
          type="button"
          variant={proximityOk ? 'outline' : 'secondary'}
          size="sm"
          onClick={handleCaptureGPS}
          disabled={geoLoading}
          className="gap-1.5"
        >
          {geoLoading ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : proximityOk ? (
            <LocateFixed className="h-3.5 w-3.5 text-success" />
          ) : (
            <MapPin className="h-3.5 w-3.5" />
          )}
          {proximityOk ? 'Location verified ✓' : 'Capture My Location'}
        </Button>
        {geoError && <span className="text-xs text-destructive">{geoError}</span>}
        {location && !proximityOk && distanceFromHouse != null && (
          <span className="text-[10px] text-destructive font-medium">
            {distanceFromHouse < 1000 ? `${Math.round(distanceFromHouse)}m` : `${(distanceFromHouse / 1000).toFixed(1)}km`} away — get closer!
          </span>
        )}
        {!location && !geoError && (
          <span className="text-[10px] text-muted-foreground">Must be within {PROXIMITY_THRESHOLD_M}m of the house</span>
        )}
      </div>

      <div className="flex items-center justify-between">
        <span className="text-xs text-muted-foreground">{reviewText.length}/500</span>
        <Button
          size="sm"
          onClick={handleSubmit}
          disabled={saving || rating === 0 || !proximityOk}
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
