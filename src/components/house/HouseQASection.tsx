import { useState } from 'react';
import { formatDistanceToNow } from 'date-fns';
import { useAuth } from '@/hooks/useAuth';
import { useHouseQuestions } from '@/hooks/useHouseQuestions';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Skeleton } from '@/components/ui/skeleton';
import { MessageCircleQuestion, Send, User, CheckCircle } from 'lucide-react';
import { toast } from 'sonner';

interface HouseQASectionProps {
  houseId: string;
  agentId: string;
}

export default function HouseQASection({ houseId, agentId }: HouseQASectionProps) {
  const { user } = useAuth();
  const { questions, loading, askQuestion, answerQuestion } = useHouseQuestions(houseId);
  const [newQuestion, setNewQuestion] = useState('');
  const [answerInputs, setAnswerInputs] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);

  const isAgent = user?.id === agentId;

  const handleAsk = async () => {
    if (!user) { toast.error('Sign in to ask a question'); return; }
    if (!newQuestion.trim()) return;
    setSubmitting(true);
    await askQuestion(newQuestion);
    setNewQuestion('');
    setSubmitting(false);
    toast.success('Question posted!');
  };

  const handleAnswer = async (qId: string) => {
    const text = answerInputs[qId];
    if (!text?.trim()) return;
    setSubmitting(true);
    await answerQuestion(qId, text);
    setAnswerInputs(prev => ({ ...prev, [qId]: '' }));
    setSubmitting(false);
    toast.success('Answer posted!');
  };

  if (loading) {
    return <Skeleton className="h-24 w-full rounded-xl" />;
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <MessageCircleQuestion className="h-4 w-4 text-primary" />
        <h2 className="font-bold text-base">
          Q&A
          {questions.length > 0 && (
            <span className="text-muted-foreground font-normal text-sm ml-1.5">{questions.length}</span>
          )}
        </h2>
      </div>

      {/* Ask box */}
      {user && (
        <div className="flex gap-2">
          <Textarea
            value={newQuestion}
            onChange={e => setNewQuestion(e.target.value)}
            placeholder="Ask about this house..."
            className="min-h-[40px] resize-none text-sm flex-1"
            maxLength={300}
          />
          <Button size="sm" onClick={handleAsk} disabled={submitting || !newQuestion.trim()} className="shrink-0 self-end">
            <Send className="h-3.5 w-3.5" />
          </Button>
        </div>
      )}

      {/* Questions list */}
      {questions.length === 0 ? (
        <p className="text-sm text-muted-foreground text-center py-3">No questions yet — ask the first one!</p>
      ) : (
        <div className="space-y-3">
          {questions.map(q => (
            <div key={q.id} className="p-3 rounded-xl border border-border/50 bg-card space-y-2">
              <div className="flex items-start gap-2">
                <div className="h-6 w-6 rounded-full bg-primary/10 flex items-center justify-center shrink-0 mt-0.5">
                  <User className="h-3 w-3 text-primary" />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-1.5">
                    <p className="text-xs font-medium">{q.asker_profile?.full_name || 'User'}</p>
                    <span className="text-[10px] text-muted-foreground">
                      {formatDistanceToNow(new Date(q.created_at), { addSuffix: true })}
                    </span>
                  </div>
                  <p className="text-sm mt-0.5">{q.question_text}</p>
                </div>
              </div>

              {q.answer_text ? (
                <div className="ml-8 p-2 rounded-lg bg-success/10 border border-success/20">
                  <div className="flex items-center gap-1 mb-0.5">
                    <CheckCircle className="h-3 w-3 text-success" />
                    <span className="text-[10px] font-semibold text-success">Agent Reply</span>
                  </div>
                  <p className="text-sm">{q.answer_text}</p>
                </div>
              ) : isAgent ? (
                <div className="ml-8 flex gap-2">
                  <Textarea
                    value={answerInputs[q.id] || ''}
                    onChange={e => setAnswerInputs(prev => ({ ...prev, [q.id]: e.target.value }))}
                    placeholder="Write your answer..."
                    className="min-h-[36px] resize-none text-sm flex-1"
                    maxLength={500}
                  />
                  <Button size="sm" variant="secondary" onClick={() => handleAnswer(q.id)} disabled={submitting} className="shrink-0 self-end">
                    Reply
                  </Button>
                </div>
              ) : (
                <p className="ml-8 text-[10px] text-muted-foreground italic">Awaiting agent reply…</p>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
