import { useState, useEffect, useCallback } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';

export interface HouseQuestion {
  id: string;
  house_id: string;
  asker_id: string;
  question_text: string;
  answer_text: string | null;
  answered_by: string | null;
  answered_at: string | null;
  created_at: string;
  asker_profile?: { full_name: string; avatar_url: string | null };
}

export function useHouseQuestions(houseId: string | undefined) {
  const { user } = useAuth();
  const [questions, setQuestions] = useState<HouseQuestion[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchQuestions = useCallback(async () => {
    if (!houseId) return;
    setLoading(true);
    const { data } = await supabase
      .from('house_questions')
      .select('*')
      .eq('house_id', houseId)
      .order('created_at', { ascending: false });

    const list = data || [];
    const askerIds = [...new Set(list.map(q => q.asker_id))];
    let profiles: { id: string; full_name: string; avatar_url: string | null }[] = [];
    if (askerIds.length > 0) {
      const { data: p } = await supabase.from('profiles').select('id, full_name, avatar_url').in('id', askerIds);
      profiles = p || [];
    }

    setQuestions(list.map(q => ({
      ...q,
      asker_profile: profiles.find(p => p.id === q.asker_id) || undefined,
    })));
    setLoading(false);
  }, [houseId]);

  useEffect(() => { fetchQuestions(); }, [fetchQuestions]);

  const askQuestion = async (text: string) => {
    if (!user || !houseId) return;
    await supabase.from('house_questions').insert({
      house_id: houseId,
      asker_id: user.id,
      question_text: text.trim(),
    });
    fetchQuestions();
  };

  const answerQuestion = async (questionId: string, answer: string) => {
    if (!user) return;
    await supabase.from('house_questions').update({
      answer_text: answer.trim(),
      answered_by: user.id,
      answered_at: new Date().toISOString(),
    }).eq('id', questionId);
    fetchQuestions();
  };

  return { questions, loading, askQuestion, answerQuestion, refetch: fetchQuestions };
}
