import VouchAgreementModal from '../VouchAgreementModal';
import { LENDING_AGENT_AGREEMENT_TEXT } from '../agreements';

interface Props {
  isOpen: boolean;
  onClose: () => void;
  onAccept: () => Promise<boolean>;
  viewOnly?: boolean;
}

export default function LendingAgentAgreementModal({ isOpen, onClose, onAccept, viewOnly }: Props) {
  return (
    <VouchAgreementModal
      isOpen={isOpen}
      onClose={onClose}
      title="Welile Lending Agent Agreement"
      subtitle="Peer lending through your Welile Wallet. Welile guarantees 100% of your principal if a borrower defaults."
      agreementText={LENDING_AGENT_AGREEMENT_TEXT}
      onAccept={onAccept}
      viewOnly={viewOnly}
    />
  );
}
