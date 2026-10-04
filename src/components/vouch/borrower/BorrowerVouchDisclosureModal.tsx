import VouchAgreementModal from '../VouchAgreementModal';
import { BORROWER_VOUCH_DISCLOSURE_TEXT } from '../agreements';

interface Props {
  isOpen: boolean;
  onClose: () => void;
  onAcknowledge: () => Promise<boolean>;
  vouchedAmountText?: string;
  viewOnly?: boolean;
}

export default function BorrowerVouchDisclosureModal({
  isOpen, onClose, onAcknowledge, vouchedAmountText, viewOnly,
}: Props) {
  return (
    <VouchAgreementModal
      isOpen={isOpen}
      onClose={onClose}
      title="Welile Vouches For You — Read First"
      subtitle={vouchedAmountText ? `Welile currently vouches up to ${vouchedAmountText} on your behalf.` : undefined}
      agreementText={BORROWER_VOUCH_DISCLOSURE_TEXT}
      onAccept={onAcknowledge}
      viewOnly={viewOnly}
      acceptLabel="I Understand"
    />
  );
}
