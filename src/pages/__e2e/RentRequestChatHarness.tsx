/**
 * Dev-only harness for the Welile purple agent rent-request chat.
 * Mounted at `/__e2e/rent-request-chat` only when `import.meta.env.DEV`.
 */
import AgentRentRequestDialog from '@/components/agent/AgentRentRequestDialog';

export default function RentRequestChatHarness() {
  if (typeof window !== 'undefined') {
    for (const key of Object.keys(localStorage)) {
      if (key.startsWith('welile:rentReqDraft')) localStorage.removeItem(key);
    }
  }
  return (
    <div data-testid="e2e-rent-request-chat" className="min-h-screen bg-primary/10">
      <AgentRentRequestDialog presentation="chat" open onOpenChange={() => {}} />
    </div>
  );
}
