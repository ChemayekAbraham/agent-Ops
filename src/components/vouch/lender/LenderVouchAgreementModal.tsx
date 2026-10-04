import VouchAgreementModal from '../VouchAgreementModal';
import { LENDER_VOUCH_AGREEMENT_TEXT } from '../agreements';

interface Props {
  isOpen: boolean;
  onClose: () => void;
  onAccept: () => Promise<boolean>;
  viewOnly?: boolean;
}

export default function LenderVouchAgreementModal({ isOpen, onClose, onAccept, viewOnly }: Props) {
  return (
    <VouchAgreementModal
      isOpen={isOpen}
      onClose={onClose}
      title="Welile Lender Vouch Agreement"
      subtitle="Partner Lender Terms — required to record vouched loans on the Welile network."
      agreementText={LENDER_VOUCH_AGREEMENT_TEXT}
      onAccept={onAccept}
      viewOnly={viewOnly}
    />
  );
}
