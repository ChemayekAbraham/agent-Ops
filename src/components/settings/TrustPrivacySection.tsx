import { useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import { MapPin, Shield } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { LiquidToggle } from '@/components/ui/liquid-toggle';
import { Badge } from '@/components/ui/badge';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
import { toast } from 'sonner';

/**
 * Privacy & Trust controls — opt in/out of always-on location sharing.
 * Always-on GPS contributes to the user's Welile Trust Score.
 */
export function TrustPrivacySection() {
  const { user } = useAuth();
  const [enabled, setEnabled] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    (async () => {
      const { data } = await supabase
        .from('profiles')
        .select('always_share_location')
        .eq('id', user.id)
        .maybeSingle();
      if (!cancelled) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        setEnabled(Boolean((data as any)?.always_share_location));
        setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [user]);

  const toggle = async (checked: boolean) => {
    if (!user) return;
    setSaving(true);

    if (checked) {
      // Request permission first
      if (!navigator.geolocation) {
        toast.error('Location is not supported on this device');
        setSaving(false);
        return;
      }
      try {
        await new Promise<void>((resolve, reject) => {
          navigator.geolocation.getCurrentPosition(() => resolve(), reject, { timeout: 10000 });
        });
      } catch {
        toast.error('Please allow location access in your browser settings');
        setSaving(false);
        return;
      }
    }

    const { error } = await supabase
      .from('profiles')
      .update({
        always_share_location: checked,
        last_continuous_location_at: checked ? new Date().toISOString() : null,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any)
      .eq('id', user.id);

    if (error) {
      toast.error('Could not save preference');
    } else {
      setEnabled(checked);
      toast.success(checked ? 'Always-on GPS enabled — boosts your trust score' : 'Always-on GPS turned off');
    }
    setSaving(false);
  };

  return (
    <motion.div id="location" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}>
      <Card className="border-border/40 rounded-2xl">
        <CardContent className="pt-5 space-y-4">
          <div className="flex items-center gap-2">
            <Shield className="h-4 w-4 text-primary" />
            <p className="font-medium text-sm">Privacy & Trust</p>
            <Badge variant="outline" className="text-[9px] ml-auto">Boosts Trust Score</Badge>
          </div>

          <div className="flex items-start justify-between gap-3">
            <div className="flex items-start gap-2.5 flex-1 min-w-0">
              <MapPin className="h-4 w-4 text-primary mt-0.5 shrink-0" />
              <div className="min-w-0">
                <p className="font-medium text-sm">Always-On Location</p>
                <p className="text-xs text-muted-foreground mt-0.5 leading-relaxed">
                  Share your live location continuously. This proves you're findable —
                  agents can deliver in person and lenders trust you more, raising your Welile Trust Score.
                </p>
              </div>
            </div>
            <div className={loading || saving ? 'opacity-50 pointer-events-none' : ''}>
              <LiquidToggle checked={enabled} onCheckedChange={toggle} />
            </div>
          </div>

          {enabled && (
            <p className="text-[11px] text-emerald-600 pl-7">
              ✓ Active — adding +4 points to your Verification & GPS score
            </p>
          )}
        </CardContent>
      </Card>
    </motion.div>
  );
}

export default TrustPrivacySection;
