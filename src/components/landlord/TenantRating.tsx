import { useState } from 'react';
import { motion } from 'framer-motion';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
import { Button } from '@/components/ui/button';
import { Star, Loader2 } from 'lucide-react';
import { toast } from 'sonner';

interface TenantRatingProps {
  tenantId: string;
  tenantName: string;
  currentRating?: number;
  onRated?: () => void;
}

export default function TenantRating({ tenantId, tenantName, currentRating, onRated }: TenantRatingProps) {
  const { user } = useAuth();
  const [rating, setRating] = useState(currentRating || 0);
  const [hoveredRating, setHoveredRating] = useState(0);
  const [saving, setSaving] = useState(false);

  const handleRate = async (newRating: number) => {
    if (!user) return;
    
    setSaving(true);
    setRating(newRating);

    const { error } = await supabase
      .from('tenant_ratings')
      .upsert({
        tenant_id: tenantId,
        landlord_id: user.id,
        rating: newRating,
        updated_at: new Date().toISOString()
      }, {
        onConflict: 'tenant_id,landlord_id'
      });

    setSaving(false);

    if (error) {
      toast.error('Failed to save rating');
      setRating(currentRating || 0);
      return;
    }

    toast.success(`Rated ${tenantName} ${newRating} star${newRating > 1 ? 's' : ''}`);
    onRated?.();
  };

  return (
    <div className="flex items-center gap-1">
      {[1, 2, 3, 4, 5].map((star) => (
        <motion.button
          key={star}
          whileHover={{ scale: 1.2 }}
          whileTap={{ scale: 0.9 }}
          className="p-0.5 focus:outline-none disabled:opacity-50"
          onMouseEnter={() => setHoveredRating(star)}
          onMouseLeave={() => setHoveredRating(0)}
          onClick={() => handleRate(star)}
          disabled={saving}
        >
          <Star
            className={`h-5 w-5 transition-colors ${
              star <= (hoveredRating || rating)
                ? 'fill-yellow-400 text-yellow-400'
                : 'text-muted-foreground'
            }`}
          />
        </motion.button>
      ))}
      {saving && <Loader2 className="h-4 w-4 animate-spin ml-1" />}
    </div>
  );
}
