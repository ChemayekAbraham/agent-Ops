import { useState, lazy, Suspense } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { FileText, Download } from 'lucide-react';
import { downloadMerchantAgreementPdf } from '@/components/merchant/agreement/merchantAgreementPdf';
import { useProfile } from '@/hooks/useProfile';
import { useTenantAgreement } from '@/hooks/useTenantAgreement';
import { useAgentAgreement } from '@/hooks/useAgentAgreement';
import { useSupporterAgreement } from '@/hooks/useSupporterAgreement';
import { useEmployeeAgreement } from '@/hooks/useEmployeeAgreement';
import { useLenderVouchAgreement } from '@/hooks/useLenderVouchAgreement';
import { useLendingAgentAgreement } from '@/hooks/useLendingAgentAgreement';
import { useBorrowerVouchDisclosure } from '@/hooks/useBorrowerVouchDisclosure';
import type { AppRole } from '@/hooks/useAuth';
import { STAFF_ROLES } from '@/lib/roleConstants';
import { EmployeeBadge } from '@/components/employee/EmployeeBadge';

const TenantAgreementModal = lazy(() => import('@/components/tenant/agreement').then(m => ({ default: m.TenantAgreementModal })));
const AgentAgreementModal = lazy(() => import('@/components/agent/agreement').then(m => ({ default: m.AgentAgreementModal })));
const SupporterAgreementModal = lazy(() => import('@/components/supporter/agreement').then(m => ({ default: m.SupporterAgreementModal })));
const EmployeeAgreementModal = lazy(() => import('@/components/employee/EmployeeAgreementModal'));
const LenderVouchAgreementModal = lazy(() => import('@/components/vouch/lender/LenderVouchAgreementModal'));
const LendingAgentAgreementModal = lazy(() => import('@/components/vouch/agent/LendingAgentAgreementModal'));
const BorrowerVouchDisclosureModal = lazy(() => import('@/components/vouch/borrower/BorrowerVouchDisclosureModal'));

function AgreementRow({ label, accepted, acceptedAt, onView, note }: { label: string; accepted: boolean; acceptedAt?: string | null; onView: () => void; note?: string }) {
  return (
    <div className="flex items-center justify-between p-3 rounded-xl bg-muted/30 border border-border/30">
      <div className="flex items-center gap-2.5 min-w-0">
        <FileText className="h-4 w-4 text-muted-foreground shrink-0" />
        <div className="min-w-0">
          <p className="font-medium text-sm">{label}</p>
          <p className="text-xs text-muted-foreground truncate">
            {accepted && acceptedAt ? `Accepted ${new Date(acceptedAt).toLocaleDateString()}` : note || (accepted ? 'Accepted' : 'Not yet accepted')}
          </p>
        </div>
      </div>
      <Button variant={accepted ? "outline" : "default"} size="sm" onClick={onView} className="shrink-0 text-xs h-8">
        {accepted ? 'View' : 'Accept'}
      </Button>
    </div>
  );
}

export default function LegalSection({ roles }: { roles: AppRole[] }) {
  const tenantAgreement = useTenantAgreement();
  const { profile } = useProfile();
  const agentAgreement = useAgentAgreement();
  const supporterAgreement = useSupporterAgreement();
  const employeeAgreement = useEmployeeAgreement();
  const lenderVouch = useLenderVouchAgreement();
  const lendingAgent = useLendingAgentAgreement();
  const borrowerDisclosure = useBorrowerVouchDisclosure();

  const [showTenantModal, setShowTenantModal] = useState(false);
  const [showAgentModal, setShowAgentModal] = useState(false);
  const [showSupporterModal, setShowSupporterModal] = useState(false);
  const [showEmployeeModal, setShowEmployeeModal] = useState(false);
  const [showLenderModal, setShowLenderModal] = useState(false);
  const [showLendingAgentModal, setShowLendingAgentModal] = useState(false);
  const [showBorrowerDisclosureModal, setShowBorrowerDisclosureModal] = useState(false);

  const isStaff = roles.some(r => STAFF_ROLES.includes(r));
  const isAgent = roles.includes('agent');

  return (
    <>
      <Card className="border-border/40 shadow-md rounded-2xl">
        <CardContent className="pt-5 space-y-3">
          {isStaff && (
            <>
              <AgreementRow
                label="Employment Contract"
                accepted={employeeAgreement.isAccepted || false}
                acceptedAt={employeeAgreement.acceptance?.accepted_at}
                onView={() => setShowEmployeeModal(true)}
              />
              {employeeAgreement.isAccepted && (
                <div className="px-3 pb-1">
                  <EmployeeBadge />
                </div>
              )}
            </>
          )}
          {roles.includes('tenant') && (
            <AgreementRow
              label="Tenant Agreement"
              accepted={tenantAgreement.isAccepted || false}
              acceptedAt={tenantAgreement.acceptance?.accepted_at}
              onView={() => setShowTenantModal(true)}
            />
          )}
          {isAgent && (
            <AgreementRow
              label="Agent Agreement"
              accepted={agentAgreement.isAccepted || false}
              acceptedAt={agentAgreement.acceptance?.accepted_at}
              onView={() => setShowAgentModal(true)}
            />
          )}
          {roles.includes('supporter') && (
            <AgreementRow
              label="Supporter Agreement"
              accepted={supporterAgreement.hasAccepted || false}
              acceptedAt={supporterAgreement.acceptance?.accepted_at}
              onView={() => setShowSupporterModal(true)}
              note="Implicitly agreed by using the platform"
            />
          )}

          {/* === Welile Vouch Network agreements (visible to all) === */}
          <AgreementRow
            label="Borrower Vouch Disclosure"
            accepted={borrowerDisclosure.hasAcknowledged}
            acceptedAt={borrowerDisclosure.disclosure?.acknowledged_at}
            onView={() => setShowBorrowerDisclosureModal(true)}
            note="What it means when Welile vouches for you"
          />
          <AgreementRow
            label="Lender Vouch Agreement"
            accepted={lenderVouch.isAccepted}
            acceptedAt={lenderVouch.acceptance?.accepted_at}
            onView={() => setShowLenderModal(true)}
            note="For lenders who lend against Welile Trust Profiles"
          />
          {isAgent && (
            <AgreementRow
              label="Lending Agent Agreement"
              accepted={lendingAgent.isAccepted}
              acceptedAt={lendingAgent.acceptance?.accepted_at}
              onView={() => setShowLendingAgentModal(true)}
              note="Required to lend from your wallet to Welile users"
            />
          )}

          {/* === Merchant Agent (Cash-Out Agent) Agreement — downloadable PDF === */}
          <div className="flex items-center justify-between p-3 rounded-xl bg-muted/30 border border-border/30">
            <div className="flex items-center gap-2.5 min-w-0">
              <FileText className="h-4 w-4 text-muted-foreground shrink-0" />
              <div className="min-w-0">
                <p className="font-medium text-sm">Merchant Agent Agreement</p>
                <p className="text-xs text-muted-foreground truncate">
                  Cash-Out Agent — float distribution &amp; payout services
                </p>
              </div>
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={() => downloadMerchantAgreementPdf({ name: profile?.full_name, phone: profile?.phone })}
              className="shrink-0 text-xs h-8 gap-1.5"
            >
              <Download className="h-3.5 w-3.5" />
              PDF
            </Button>
          </div>
        </CardContent>
      </Card>

      <Suspense fallback={null}>
        {isStaff && showEmployeeModal && (
          <EmployeeAgreementModal isOpen={showEmployeeModal} onClose={() => setShowEmployeeModal(false)} onAccept={employeeAgreement.acceptAgreement} viewOnly={employeeAgreement.isAccepted || false} />
        )}
        {roles.includes('tenant') && showTenantModal && (
          <TenantAgreementModal isOpen={showTenantModal} onClose={() => setShowTenantModal(false)} onAccept={tenantAgreement.acceptAgreement} viewOnly={tenantAgreement.isAccepted || false} />
        )}
        {isAgent && showAgentModal && (
          <AgentAgreementModal isOpen={showAgentModal} onClose={() => setShowAgentModal(false)} onAccept={async () => true} viewOnly />
        )}
        {roles.includes('supporter') && showSupporterModal && (
          <SupporterAgreementModal open={showSupporterModal} onOpenChange={setShowSupporterModal} onAccept={supporterAgreement.acceptAgreement} />
        )}
        {showBorrowerDisclosureModal && (
          <BorrowerVouchDisclosureModal
            isOpen={showBorrowerDisclosureModal}
            onClose={() => setShowBorrowerDisclosureModal(false)}
            onAcknowledge={borrowerDisclosure.acknowledge}
            viewOnly={borrowerDisclosure.hasAcknowledged}
          />
        )}
        {showLenderModal && (
          <LenderVouchAgreementModal
            isOpen={showLenderModal}
            onClose={() => setShowLenderModal(false)}
            onAccept={lenderVouch.acceptAgreement}
            viewOnly={lenderVouch.isAccepted}
          />
        )}
        {isAgent && showLendingAgentModal && (
          <LendingAgentAgreementModal
            isOpen={showLendingAgentModal}
            onClose={() => setShowLendingAgentModal(false)}
            onAccept={lendingAgent.acceptAgreement}
            viewOnly={lendingAgent.isAccepted}
          />
        )}
      </Suspense>
    </>
  );
}
