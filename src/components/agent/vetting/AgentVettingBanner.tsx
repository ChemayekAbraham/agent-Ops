import { useNavigate } from 'react-router-dom';
import { ShieldCheck } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useAgentVetting } from '@/hooks/useAgentVetting';
import { vettingChecklist, vettingProgress } from '@/lib/agentVetting';

/** Agent dashboard banner: hidden when verified, on error, or while loading. */
export function AgentVettingBanner() {
  const v = useAgentVetting();
  const navigate = useNavigate();
  const vetting = v.vetting;
  if (!vetting || v.error || vetting.status === 'verified') return null;

  const { done, total } = vettingProgress(vettingChecklist(vetting));
  const submitted = vetting.status === 'submitted';

  return (
    <div className="mb-4 rounded-xl border border-primary/30 bg-primary/5 p-4">
      <div className="flex items-start gap-3">
        <ShieldCheck className="mt-0.5 h-5 w-5 shrink-0 text-primary" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-foreground">Verify your agent account</p>
          <p className="mt-0.5 text-sm text-muted-foreground">
            {submitted
              ? 'Agent Ops is reviewing your verification.'
              : vetting.enforced
                ? 'You need to be verified to add tenants and post Rent Plan requests.'
                : `${done} of ${total} done`}
          </p>
          {!submitted && vetting.enforced && (
            <p className="mt-0.5 text-sm text-muted-foreground">{done} of {total} done</p>
          )}
        </div>
        {!submitted && (
          <Button size="sm" className="min-h-11 shrink-0" onClick={() => navigate('/dashboard/agent/verification')}>
            Continue
          </Button>
        )}
      </div>
    </div>
  );
}
