import { template as testTemplate } from './test-email.tsx'

import { template as returnsDisbursementTemplate } from './returns-disbursement-confirmation.tsx'
import { template as partnershipReturnsProcessingTemplate } from './partnership-returns-processing.tsx'
import { template as partnerWalletDepositTemplate } from './partner-wallet-deposit.tsx'
import { template as partnershipAgreementTemplate } from './partnership-agreement.tsx'
import { template as partnershipTopupTemplate } from './partnership-topup.tsx'
import { template as partnershipSplitAllocationTemplate } from './partnership-split-allocation.tsx'
import { template as partnerCompoundTemplate } from './partner-compound.tsx'
import { template as partnerPortfolioCompoundedTemplate } from './partner-portfolio-compounded.tsx'
import { template as portfolioRenewalTemplate } from './portfolio-renewal.tsx'
import { template as portfolioRenewalDaysRemainingTemplate } from './portfolio-renewal-days-remaining.tsx'
import { template as portfolioMaturityTemplate } from './portfolio-maturity.tsx'
import { template as portfolioRedemptionTemplate } from './portfolio-redemption.tsx'
import { template as partnershipMaturityNoticeTemplate } from './partnership-maturity-notice.tsx'
import { template as partnerSelfManagedCycleEndedTemplate } from './partner-self-managed-cycle-ended.tsx'
import { template as partnerSelfManagedDeploymentTemplate } from './partner-self-managed-deployment.tsx'
import { template as promissoryNotePledgeTemplate } from './promissory-note-pledge.tsx'
import { template as promissoryNoteReleaseWarningTemplate } from './promissory-note-release-warning.tsx'
import { template as funderHouseBookingTemplate } from './funder-house-booking.tsx'
import { template as funderSavedHouseFundableTemplate } from './funder-saved-house-fundable.tsx'
import { template as funderHouseProgressTemplate } from './funder-house-progress.tsx'
import { template as partnerAccountCreatedTemplate } from './partner-account-created.tsx'
import { template as databaseBackupReadyTemplate } from './database-backup-ready.tsx'
import { template as databaseBackupLinkTemplate } from './database-backup-link.tsx'
import { template as angelPoolSharePurchaseTemplate } from './angel-pool-share-purchase.tsx'
import { template as proxyManagedPayoutNoticeTemplate } from './proxy-managed-payout-notice.tsx'
import { template as operationalFloatCreditTemplate } from './operational-float-credit.tsx'
import { template as agentLandlordFloatFundedTemplate } from './agent-landlord-float-funded.tsx'
import { template as walletTransferReceivedTemplate } from './wallet-transfer-received.tsx'
import { template as walletTransferSentTemplate } from './wallet-transfer-sent.tsx'
import { template as agentTenantPaymentReceiptTemplate } from './agent-tenant-payment-receipt.tsx'
import { template as cashWithdrawalCodeTemplate } from './cash-withdrawal-code.tsx'
import { template as cashDepositCodeTemplate } from './cash-deposit-code.tsx'
import { template as cashDepositWalletConfirmationTemplate } from './cash-deposit-wallet-confirmation.tsx'
import { template as twoFactorCodeTemplate } from './two-factor-code.tsx'
import { template as smsFailureAlertTemplate } from './sms-failure-alert.tsx'
import { template as dailyAgentCardTemplate } from './daily-agent-card.tsx'
import { template as subAgentInviteTemplate } from './sub-agent-invite.tsx'
import { template as residenceVerificationStatusTemplate } from './residence-verification-status.tsx'
import { template as identityNameAdoptedTemplate } from './identity-name-adopted.tsx'

import { template as portfolioRequestConfirmationTemplate } from './portfolio-request-confirmation.tsx'
import { template as portfolioRequestTeamAlertTemplate } from './portfolio-request-team-alert.tsx'
import { template as standingOrderCreatedTemplate } from './standing-order-created.tsx'
import { template as newWithdrawalMerchantAlertTemplate } from './new-withdrawal-merchant-alert.tsx'
import { template as withdrawalPaidReceiptTemplate } from './withdrawal-paid-receipt.tsx'
import { template as tenantPartnershipAgreementTemplate } from './tenant-partnership-agreement.tsx'
import { template as jobApplicationReceivedTemplate } from './job-application-received.tsx'
import { template as directorRequisitionNewTemplate } from './director-requisition-new.tsx'
import { template as directorRequisitionStatusTemplate } from './director-requisition-status.tsx'
import { template as redirectMonitorAlertTemplate } from './redirect-monitor-alert.tsx'
import { template as smartphoneOrderReceiptTemplate } from './smartphone-order-receipt.tsx'
import { template as portfolioRenewalApologyTemplate } from './portfolio-renewal-apology.tsx'
import { template as partnerPortfolioInviteTemplate } from './partner-portfolio-invite.tsx'
import { template as shareholderSharesCreatedTemplate } from './shareholder-shares-created.tsx'
import { template as performanceAssessmentReportTemplate } from './performance-assessment-report.tsx'
import { template as boardTechnologyMemoTemplate } from './board-technology-memo.tsx'
import { template as proxyAgentOnboardedTemplate } from './proxy-agent-onboarded.tsx'
import { template as proxyDailyNudgeTemplate } from './proxy-daily-nudge.tsx'
import { template as smartphoneOrderDisbursedTemplate } from './smartphone-order-disbursed.tsx'
import type { TemplateEntry } from './types.ts'

export const TEMPLATES: Record<string, TemplateEntry> = {
  'test-email': testTemplate,
  'director-requisition-new': directorRequisitionNewTemplate,
  'director-requisition-status': directorRequisitionStatusTemplate,
  'returns-disbursement-confirmation': returnsDisbursementTemplate,
  'partnership-returns-processing': partnershipReturnsProcessingTemplate,
  'partner-wallet-deposit': partnerWalletDepositTemplate,
  'partnership-agreement': partnershipAgreementTemplate,
  'partnership-topup': partnershipTopupTemplate,
  'partnership-split-allocation': partnershipSplitAllocationTemplate,
  'partner-compound': partnerCompoundTemplate,
  'partner-portfolio-compounded': partnerPortfolioCompoundedTemplate,
  'portfolio-renewal': portfolioRenewalTemplate,
  'portfolio-renewal-days-remaining': portfolioRenewalDaysRemainingTemplate,
  'portfolio-maturity': portfolioMaturityTemplate,
  'portfolio-redemption': portfolioRedemptionTemplate,
  'partnership-maturity-notice': partnershipMaturityNoticeTemplate,
  'partner-self-managed-cycle-ended': partnerSelfManagedCycleEndedTemplate,
  'partner-self-managed-deployment': partnerSelfManagedDeploymentTemplate,
  'promissory-note-pledge': promissoryNotePledgeTemplate,
  'promissory-note-release-warning': promissoryNoteReleaseWarningTemplate,
  'funder-house-booking': funderHouseBookingTemplate,
  'funder-saved-house-fundable': funderSavedHouseFundableTemplate,
  'funder-house-progress': funderHouseProgressTemplate,
  'partner-account-created': partnerAccountCreatedTemplate,
  'database-backup-ready': databaseBackupReadyTemplate,
  'database-backup-link': databaseBackupLinkTemplate,
  'angel-pool-share-purchase': angelPoolSharePurchaseTemplate,
  'proxy-managed-payout-notice': proxyManagedPayoutNoticeTemplate,
  'operational-float-credit': operationalFloatCreditTemplate,
  'agent-landlord-float-funded': agentLandlordFloatFundedTemplate,
  'wallet-transfer-received': walletTransferReceivedTemplate,
  'wallet-transfer-sent': walletTransferSentTemplate,
  'agent-tenant-payment-receipt': agentTenantPaymentReceiptTemplate,
  'cash-withdrawal-code': cashWithdrawalCodeTemplate,
  'cash-deposit-code': cashDepositCodeTemplate,
  'cash-deposit-wallet-confirmation': cashDepositWalletConfirmationTemplate,
  'two-factor-code': twoFactorCodeTemplate,
  'sms-failure-alert': smsFailureAlertTemplate,
  'daily-agent-card': dailyAgentCardTemplate,
  'sub-agent-invite': subAgentInviteTemplate,
  'residence-verification-status': residenceVerificationStatusTemplate,
  'identity-name-adopted': identityNameAdoptedTemplate,

  'portfolio-request-confirmation': portfolioRequestConfirmationTemplate,
  'portfolio-request-team-alert': portfolioRequestTeamAlertTemplate,
  'standing-order-created': standingOrderCreatedTemplate,
  'new-withdrawal-merchant-alert': newWithdrawalMerchantAlertTemplate,
  'withdrawal-paid-receipt': withdrawalPaidReceiptTemplate,
  'tenant-partnership-agreement': tenantPartnershipAgreementTemplate,
  'job-application-received': jobApplicationReceivedTemplate,
  'redirect-monitor-alert': redirectMonitorAlertTemplate,
  'smartphone-order-receipt': smartphoneOrderReceiptTemplate,
  'portfolio-renewal-apology': portfolioRenewalApologyTemplate,
  'partner-portfolio-invite': partnerPortfolioInviteTemplate,
  'shareholder-shares-created': shareholderSharesCreatedTemplate,
  'performance-assessment-report': performanceAssessmentReportTemplate,
  'board-technology-memo': boardTechnologyMemoTemplate,
  'proxy-agent-onboarded': proxyAgentOnboardedTemplate,
  'proxy-daily-nudge': proxyDailyNudgeTemplate,
  'smartphone-order-disbursed': smartphoneOrderDisbursedTemplate,
}