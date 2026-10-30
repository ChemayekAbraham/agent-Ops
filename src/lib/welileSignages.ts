/**
 * Welile Signages — Core Types & Constants
 *
 * Business Rules:
 *  - Eligible: Busy houses and shops / business premises.
 *  - Property Owner: UGX 10,000 per active signage per month (commences on verified activation date).
 *  - Agent Reward: UGX 3,000 once per qualifying installation (eligible only after installation verification).
 *  - Mandatory Live GPS: Required before submission (accuracy <= 25m recommended).
 *  - Administrative Location: Dataset-driven (UgLocationPicker: District -> Village).
 */

export const SIGNAGE_RATES = {
  OWNER_MONTHLY_UGX: 10_000,
  AGENT_REWARD_UGX: 3_000,
  MAX_GPS_ACCURACY_METERS: 50,
} as const;

export type SignagePropertyType = 'house' | 'shop' | 'business_premise' | 'mixed_use';

export type SignageFootTraffic = 'low' | 'medium' | 'high';

export type SignageStatus =
  | 'draft'
  | 'submitted'
  | 'under_review'
  | 'changes_required'
  | 'rejected'
  | 'approved_for_installation'
  | 'pending_installation'
  | 'installation_verification'
  | 'active'
  | 'temporarily_inactive'
  | 'payment_on_hold'
  | 'removal_requested'
  | 'removed'
  | 'cancelled';

export interface SignagePhoto {
  id: string;
  url: string;
  category: 'exterior' | 'proposed_position' | 'surroundings' | 'installed_signage';
  caption?: string;
  taken_at: string;
}

export interface SignageRecord {
  id: string;
  reference_no: string;
  agent_id: string;
  agent_name?: string;
  agent_phone?: string;
  
  // Property & Consenting Person
  property_name: string;
  property_type: SignagePropertyType;
  business_category?: string;
  owner_full_name: string;
  owner_phone: string;
  owner_alt_phone?: string;
  consenting_relation: string;
  permission_confirmed: boolean;
  owner_payment_method: 'momo_mtn' | 'momo_airtel' | 'bank';
  owner_payment_number: string;
  owner_payment_name: string;

  // Live GPS
  gps_latitude: number;
  gps_longitude: number;
  gps_accuracy_meters: number;
  gps_captured_at: string;

  // Administrative Location
  district_name: string;
  county_name?: string;
  sub_county_name?: string;
  parish_name?: string;
  village_name: string;
  plot_or_landmark?: string;

  // Suitability
  foot_traffic: SignageFootTraffic;
  road_visibility?: string;
  operating_hours?: string;
  nearby_landmarks?: string;
  proposed_surface?: string;
  proposed_dimensions?: string;
  accessibility_notes?: string;

  // Photos
  photos: SignagePhoto[];

  // Lifecycle
  status: SignageStatus;
  rejection_reason?: string;
  review_notes?: string;
  reviewed_by?: string;
  reviewed_at?: string;

  // Installation & Verification
  installed_at?: string;
  installer_name?: string;
  installation_photos?: SignagePhoto[];
  verified_by?: string;
  verified_at?: string;
  verification_notes?: string;

  // Activation & Payment Clock
  activated_at?: string;
  removal_effective_at?: string;

  // CFO Disbursement Tracking
  agent_reward_status?: 'eligible' | 'pending' | 'disbursed';
  agent_reward_disbursed_at?: string;
  agent_reward_disbursed_by?: string;
  agent_reward_tx_ref?: string;

  owner_rent_status?: 'pending' | 'disbursed';
  owner_rent_disbursed_at?: string;
  owner_rent_disbursed_by?: string;
  owner_rent_tx_ref?: string;

  created_at: string;
  updated_at: string;
}

export interface SignageOwnerObligation {
  id: string;
  signage_id: string;
  owner_phone: string;
  owner_name: string;
  period_start: string;
  period_end: string;
  due_date: string;
  amount_ugx: number;
  status: 'pending' | 'approved' | 'paid' | 'failed' | 'cancelled';
  transaction_ref?: string;
  disbursed_at?: string;
}

export interface SignageAgentReward {
  id: string;
  signage_id: string;
  agent_id: string;
  amount_ugx: number;
  status: 'eligible' | 'pending' | 'paid' | 'failed';
  wallet_transaction_id?: string;
  paid_at?: string;
}

export function formatSignageStatus(status: SignageStatus): { label: string; variant: 'default' | 'secondary' | 'outline' | 'destructive' | 'success' } {
  switch (status) {
    case 'submitted':
      return { label: 'Submitted', variant: 'secondary' };
    case 'under_review':
      return { label: 'Under Review', variant: 'secondary' };
    case 'approved_for_installation':
      return { label: 'Approved for Installation', variant: 'default' };
    case 'pending_installation':
      return { label: 'Pending Installation', variant: 'secondary' };
    case 'installation_verification':
      return { label: 'Verifying Installation', variant: 'secondary' };
    case 'active':
      return { label: 'Active (Billing)', variant: 'success' };
    case 'changes_required':
      return { label: 'Changes Required', variant: 'destructive' };
    case 'rejected':
      return { label: 'Rejected', variant: 'destructive' };
    case 'temporarily_inactive':
      return { label: 'Inactive', variant: 'outline' };
    case 'payment_on_hold':
      return { label: 'Payment On Hold', variant: 'destructive' };
    case 'removal_requested':
      return { label: 'Removal Requested', variant: 'outline' };
    case 'removed':
      return { label: 'Removed', variant: 'outline' };
    case 'cancelled':
      return { label: 'Cancelled', variant: 'outline' };
    default:
      return { label: status, variant: 'outline' };
  }
}
