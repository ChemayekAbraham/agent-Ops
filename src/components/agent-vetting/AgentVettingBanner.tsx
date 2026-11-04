import { useNavigate } from 'react-router-dom';
import { ShieldCheck, ChevronRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useAgentVetting } from '@/hooks/useAgentVetting';
import { vettingChecklist, vettingProgress } from '@/lib/agentVetting';

/** Agent dashboard banner; hidden unless the signed-in user is a real agent with an unfinished record. */
export default function AgentVettingBanner() {
  const { vetting, applicability } = useAgentVetting();
  const navigate = useNavigate();
  if (applicability !== 'ready' || !vetting || vetting.status === 'verified') return null;

  const { done, total } = vettingProgress(vettingChecklist(vetting));
  const submitted = vetting.status === 'submitted';

  return (
    <div className="mx-3 my-2 rounded-xl border border-primary/30 bg-primary/5 p-3 flex flex-col items-start gap-3 sm:flex-row sm:items-center">
      <div className="flex items-start gap-3 min-w-0 w-full sm:items-center">
        <ShieldCheck className="h-6 w-6 text-primary shrink-0 mt-0.5 sm:mt-0" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold leading-snug">
            {submitted ? 'Agent Ops is reviewing your verification.' : 'Verify your agent account'}
          </p>
          {!submitted && (
            <p className="text-sm text-muted-foreground leading-snug">
              {vetting.enforced
                ? 'You need to be verified to add tenants and post Rent Plan requests.'
                : `${done} of ${total} done`}
            </p>
          )}
        </div>
      </div>
      {!submitted && (
        <Button size="sm" className="min-h-11 w-full sm:w-auto shrink-0" onClick={() => navigate('/dashboard/agent/verification')}>
          Continue <ChevronRight className="h-4 w-4 ml-1" />
        </Button>
      )}
    </div>
  );
}
