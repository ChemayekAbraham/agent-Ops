import { useState, useEffect } from 'react';
import { supabase } from '@/integrations/supabase/client';

export interface OpportunitySummary {
  id: string;
  total_rent_requested: number;
  total_requests: number;
  total_landlords: number;
  total_agents: number;
  notes: string | null;
  posted_by: string;
  created_at: string;
  updated_at: string;
}

export function useOpportunitySummary() {
  const [summary, setSummary] = useState<OpportunitySummary | null>(null);
  const [loading, setLoading] = useState(true);

  const fetchSummary = async () => {
    try {
      const { data, error } = await supabase
        .from('opportunity_summaries')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      if (error) throw error;
      setSummary(data as OpportunitySummary | null);
    } catch (err) {
      console.error('Failed to fetch opportunity summary:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    // Fetched on mount; callers use `refetch` after a submit. The old Realtime
    // listener was on opportunity_summaries, which is not in the publication,
    // so it never fired (doc 147).
    fetchSummary();
  }, []);

  return { summary, loading, refetch: fetchSummary };
}
