/**
 * Rent Request Assistant — posts a rent request as a guided chat.
 *
 * One question per turn, every answer checked as it is given, the Rent Plan
 * priced before any personal details. Collects exactly the fields the
 * AgentRentRequestDialog collects for the daily / weekly / monthly flows and
 * posts through submitAssistantRentRequest, which mirrors the form's submit.
 *
 * The T4 form: since 2026-11-09 the only way an agent posts, resubmits or
 * renews a rent request. Every entry point opens it with openT4RentRequest
 * (src/lib/t4RentRequest.ts) and T4RentRequestHost shows it. `request.mode`:
 *   - 'new'      the full chat, optionally prefilled (intake queue, swap tenant).
 *   - 'resubmit' a rejected request, prefilled, opening at the review; sent
 *                with agent_resubmit_rent_request.
 *   - 'renewal'  a completed plan: the agent's rent/days choice and the
 *                tenant's code, then renew_rent_request.
 * Submit stays off until t4Missing() is empty (SC-2 and Agent Ops gate items).
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ArrowLeft, Camera, Check, ImagePlus, Loader2, Lock, MapPin, RotateCcw, Send, ShieldCheck, Square, UserPlus, Volume2, VolumeX } from 'lucide-react';
import welileLogo from '@/assets/welile-logo.png';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { useAssistantSpeech } from './useAssistantSpeech';
import { Lc1SearchStep, type Lc1Hit } from './Lc1SearchStep';
import { toast } from 'sonner';
import { AGENT_RENT_REQUEST_REOPEN_FLAG as REOPEN_FLAG, clearFormPhotos, loadFormPhotos, previewOf, saveFormPhotos } from '@/lib/formPhotoDraft';
import SelfieCameraCapture from '@/components/wallet/SelfieCameraCapture';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
import { collectionInfoLine, fetchMyCollectionInfo, type MyCollectionInfo } from '@/lib/agentCollectionInfo';
import { listingHasRealPhoto } from '@/hooks/useHouseListings';
import type { UgLocationSelection } from '@/hooks/useUgLocations';
import { LandlordSearchSelect, type LandlordOption } from '@/components/agent/LandlordSearchSelect';
import RegisterLandlordDialog from '@/components/agent/RegisterLandlordDialog';
import { UgLocationPicker } from '@/components/location/UgLocationPicker';
import { GuarantorConsentCheckbox } from '@/components/agent/GuarantorConsentCheckbox';
import { NOT_VETTED_EVENT, promptIfNotVetted } from '@/components/agent-vetting/notVettedPrompt';
import { useAgentGateStatus } from '@/hooks/useAgentGateStatus';
import { AGENT_VERIFICATION_PATH } from '@/hooks/useAgentVetting';
import { agentNotVettedReason } from '@/lib/agentVetting';
import { optimizeImage } from '@/lib/imageOptimizer';
import { FACE_PHOTO_ENCODING, runPassportFaceCheck, runPassportFaceCheckWithin, type PassportFaceCheck } from '@/lib/passportFaceCheck';
import { FACE_CHECK_SLOW_MESSAGE, FACE_CHECK_TIMEOUT_MS, TENANT_FACE_PHOTO, facePhotoRefusal, itemsMentioned, type ReasonItem } from '@/lib/tenantFacePhoto';
import { notifyVerificationCreated } from '@/lib/landlordVerificationNotify';
import { IntakeStepHeader } from '@/components/intake/IntakeStepHeader';
import { GpsCapturePanel } from '@/components/intake/GpsCapturePanel';
import { useGpsCapture } from '@/hooks/useGpsCapture';
import type { GpsSource } from '@/lib/gpsCapture';
import { WhoIsPosting } from '@/components/intake/WhoIsPosting';
import { RENEWAL_STEP_DEFS, firstIncompleteStep, intakeLeftLabel, type IntakeState, type IntakeStepKey, type RenewalStepKey, type StepState } from '@/lib/intakeSteps';
import { useRenewalAdvice } from '@/hooks/useRenewalAdvice';
import type { RenewalChoice } from '@/lib/renewalAdvice';
import { checkIntakeTenant, fetchResubmitNeeds, recordFaceCheck, type IntakeTenantCheck, type ResubmitNeeds } from '@/lib/intakeRpc';
import { fetchAgentRejectedRequests } from '@/hooks/useAgentRejectedRequests';
import { normalizeDistrict } from '@/lib/ugandaDistricts';
import { formatUGX } from '@/lib/rentCalculations';
import { hapticSuccess, hapticTap } from '@/lib/haptics';
import { joinPersonName, splitPersonName, type PersonNameParts } from '@/lib/authValidation';
import { useRenewalFlow } from '@/components/agent/RenewalDialog';
import {
  RESUBMIT_DAYS_MAX,
  RESUBMIT_DAYS_MIN,
  RESUBMIT_NOTE_MIN_CHARS,
  rejectedToValues,
  resubmitPatch,
  hasTenantId,
  MIN_HOUSE_PHOTOS,
  openT4RentRequest,
  t4Missing,
  type ResubmitValues,
  type T4ItemKey,
  type T4MissingItem,
  type T4Request,
} from '@/lib/t4RentRequest';
import {
  attachRenewalPhotos,
  attachT4Documents,
  docPreviewUrl,
  loadTenantDocsOnFile,
  uploadNewRequestDocs,
  findOpenRequest,
  finishRenewalIntake,
  loadRequestOnFile,
  loadTenantRecord,
  postRenewal,
  resubmitT4Request,
  fetchAgentSideMissing,
  sideMissingSteps,
  type SideMissingStep,
  saveTenantProfile,
  type T4IntakeOutcome,
  type DocKind,
  type StoredDoc,
  type TenantRecord,
} from '@/lib/t4RentRequestSubmit';
import { createUploadCounter, sendButtonLabel, type SendProgress } from '@/lib/sendProgress';
import { landlordCodeFromSearch, normalizeLandlordCode, recordLandlordReferral } from '@/lib/landlordReferral';
import { createFormFunnel, funnelErrorCode, plainServerMessage, type FunnelItem, type FunnelStep } from '@/lib/formFunnel';
import {
  DRAFT_SAVED_MESSAGE, closeDraft, downloadDraftPhoto, draftsAvailable, fetchMyDrafts, newDraftFolder, onDraftsAvailability,
  saveDraft, uploadDraftPhoto, type DraftPhoto, type DraftPhotoKind, type PostingDraftPayload,
} from '@/lib/postingDrafts';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import {
  computeAssistantFees,
  submitAssistantRentRequest,
  weeklyRepaymentFor,
  type AssistantEarnerCycle,
  type AssistantHouse,
  type AssistantIncomeType,
  type AssistantSubmitResult,
} from '@/lib/rentRequestAssistantSubmit';
import {
  checkNationalId,
  checkNewLc1Phone,
  checkTenantPhone,
  loadAgentSelf,
  maskNationalId,
  maskPhone,
  type AgentSelf,
  type RecordVerdict,
} from '@/lib/rentAssistantRecordChecks';
import {
  familySizeProblem,
  isFullName,
  lc1LetterProblem,
  parseFamilySize,
  workProblem,
} from '@/lib/agentIntakeDetails';

const HOUSE_CATEGORIES = [
  { value: 'single-room', label: 'Single room' },
  { value: 'double-room', label: 'Double room' },
  { value: '1-bed', label: '1 bed house' },
  { value: '2-bed', label: '2 bedroom house' },
  { value: '2-bed-full', label: '2 bed + sitting room' },
  { value: '3-bed', label: '3 bedroom' },
  { value: '3-bed-luxury', label: '3 bed luxury' },
  { value: '4-bed', label: '4+ bedroom' },
  { value: 'shop', label: 'Shop' },
  { value: 'market-stall', label: 'Market stall' },
  { value: 'kiosk', label: 'Kiosk' },
  { value: 'salon-workshop', label: 'Salon / workshop' },
  { value: 'office', label: 'Office' },
  { value: 'warehouse', label: 'Warehouse' },
  { value: 'commercial', label: 'Other business' },
];
const LANGUAGES = ['English', 'Luganda', 'Runyankole', 'Lusoga', 'Acholi', 'Lugbara', 'Other'];
const PAYOUT_DAYS = ['1', '5', '10', '15', '20', '25', '28'];
const PHOTO_SLOTS = ['Front', 'Back', 'Left side', 'Right side'];
const ALLOWED_IMAGE_TYPES = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp', 'image/heic', 'image/heif'];

type UntypedRpc = (fn: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: unknown }>;
/** For the RPCs missing from the generated types (same calls the form makes). */
const rpcUntyped: UntypedRpc = (fn, args) => (supabase.rpc as unknown as UntypedRpc).call(supabase, fn, args);
const metaOf = (u: { user_metadata?: Record<string, unknown> } | null | undefined) =>
  (u?.user_metadata ?? {}) as Record<string, string | undefined>;

const UG_PHONE = /^0[3-9][0-9]{8}$/;
const clean = (s: string) => s.replace(/\s/g, '');
const isUgPhone = (s: string) => UG_PHONE.test(clean(s));

/** What is wrong with a typed phone number, in plain words; null when it is fine. */
function phoneProblem(text: string, whose: string): string | null {
  const d = formatPhone(text).replace(/\D/g, '');
  if (!d) return `I didn’t catch a number 🤔 Type ${whose}’s phone, like 0783 123 456.`;
  if (UG_PHONE.test(d)) return null;
  if (/^[37][0-9]{8}$/.test(d)) return `Looks like the 0 at the start is missing. Did you mean ${formatPhone(`0${d}`)}? 🤔`;
  if (d.length < 10) return `That’s only ${d.length} digits. A Ugandan number has 10, like 0783 123 456 📱`;
  if (!/^0[37]/.test(d)) return 'Ugandan numbers start with 07 (or 03 for landlines) 🤔 Check the number again.';
  return 'That number doesn’t look right 🤔 Use one like 0783 123 456.';
}
const formatPhone = (raw: string) => {
  // A pasted +256 / 256 number becomes the local 0… form as it is typed.
  let d = raw.replace(/\D/g, '');
  if (d.startsWith('256')) d = `0${d.slice(3)}`;
  d = d.slice(0, 10);
  if (d.length <= 4) return d;
  if (d.length <= 7) return `${d.slice(0, 4)} ${d.slice(4)}`;
  return `${d.slice(0, 4)} ${d.slice(4, 7)} ${d.slice(7)}`;
};
const groupDigits = (raw: string) => raw.replace(/\D/g, '').replace(/\B(?=(\d{3})+(?!\d))/g, ',');

function mapHouseCategory(cat: string | null): string {
  switch ((cat || '').toLowerCase()) {
    case 'single_room': case 'studio': case 'bedsitter': return 'single-room';
    case 'double_room': return 'double-room';
    case 'one_bedroom': return '1-bed';
    case 'two_bedroom': return '2-bed';
    case 'three_bedroom': return '3-bed';
    case 'shop': case 'commercial': return 'commercial';
    default: return '';
  }
}

type StepId =
  | 'type' | 'rent' | 'plan'
  | 'tenantPhone' | 'tenantName' | 'nationalId' | 'language' | 'smartphone'
  | 'familySize' | 'work' | 'workLocation'
  | 'landlord' | 'house' | 'location' | 'address' | 'category' | 'photos' | 'tenantPhoto' | 'idFront' | 'idBack' | 'gps'
  | 'lc1' | 'lc1Phone' | 'lc1Name' | 'lc1Village' | 'city' | 'lcLetter' | 'payoutDay'
  | 'days' | 'note'
  | 'renewPlan' | 'renewChanges'
  | 'review';

/** Every question in order; `steps` drops the ones an answer makes unnecessary. */
const ALL_STEPS: StepId[] = [
  // The 8 intake steps (intakeSteps.ts), in order. The first screen is the tenant's phone
  // number; step 8 ends on the LC1 letter, with consent and Post on the same screen (no review step).
  'tenantPhone', 'tenantName', 'language', 'smartphone', // 1 Tenant
  'type', 'rent', 'plan', // 2 Rent plan
  'landlord', 'payoutDay', // 3 Landlord
  'house', 'location', 'address', 'city', 'category', 'photos', 'gps', // 4 House
  'familySize', 'work', 'workLocation', // 5 Household
  'tenantPhoto', // 6 Tenant's photo
  'nationalId', 'idFront', 'idBack', // 7 ID
  'lc1', 'lc1Phone', 'lc1Name', 'lc1Village', 'lcLetter', // 8 LC1 letter + Post
];
/** The last question of a new request: the LC1 letter, with consent and Post. */
const LAST_NEW_STEP: StepId = 'lcLetter';

/** Resubmit: what a rejected request can change, the T4 intake, and a note for the reviewer. */
const RESUBMIT_STEPS: StepId[] = [
  'rent', 'days', 'tenantName', 'tenantPhone', 'nationalId', 'language', 'smartphone',
  'familySize', 'work', 'workLocation', 'landlord', 'category', 'photos', 'tenantPhoto', 'idFront', 'idBack', 'gps', 'lcLetter', 'note', 'review',
];
/** The question a return reason or a desk's failed check points at. */
const REASON_STEP: Record<ReasonItem, StepId> = {
  rent: 'rent', landlord: 'landlord', photos: 'photos', tenantPhoto: 'tenantPhoto', idFront: 'idFront', idBack: 'idBack',
  gps: 'gps', lcLetter: 'lcLetter', familySize: 'familySize', work: 'work',
};
/**
 * Renewal: same tenant, house and landlord. The Agent Ops gate still needs the
 * full name, a tenant ID, 3+ house photos, GPS and the LC1 letter; each is
 * prefilled from what is on file and asked only when it is missing.
 */
const RENEWAL_STEPS: StepId[] = ['tenantName', 'nationalId', 'photos', 'idFront', 'idBack', 'gps', 'lcLetter', 'review'];
/** The question that fixes each checklist item. */
const ITEM_STEP: Partial<Record<T4ItemKey, StepId>> = {
  plan: 'type', rent: 'rent', tenantPhone: 'tenantPhone', tenantName: 'tenantName', idFront: 'idFront', idBack: 'idBack',
  familySize: 'familySize', work: 'work', landlord: 'landlord', house: 'category', photos: 'photos',
  tenantPhoto: 'tenantPhoto', gps: 'gps', lc1: 'lc1', lcLetter: 'lcLetter', payoutDay: 'payoutDay', note: 'note',
};

/** Which of the 8 intake steps each question belongs to; also the funnel step name (E108). */
const SECTION_OF: Record<StepId, IntakeStepKey> = {
  tenantPhone: 'tenant', tenantName: 'tenant', language: 'tenant', smartphone: 'tenant',
  type: 'rent_plan', rent: 'rent_plan', plan: 'rent_plan', days: 'rent_plan',
  landlord: 'landlord', payoutDay: 'landlord',
  house: 'house', location: 'house', address: 'house', city: 'house', category: 'house', photos: 'house', gps: 'house',
  familySize: 'household', work: 'household', workLocation: 'household',
  tenantPhoto: 'tenant_photo',
  nationalId: 'id', idFront: 'id', idBack: 'id',
  lc1: 'lc1_post', lc1Phone: 'lc1_post', lc1Name: 'lc1_post', lc1Village: 'lc1_post', lcLetter: 'lc1_post',
  note: 'lc1_post', review: 'lc1_post',
  renewPlan: 'rent_plan', renewChanges: 'house',
};
/** E128 renewal: its 3 steps (Plan, What changed, Tenant code + Post). */
const RENEWAL_SECTION_OF: Partial<Record<StepId, RenewalStepKey>> = {
  renewPlan: 'plan', renewChanges: 'changes', tenantName: 'changes', nationalId: 'changes', photos: 'changes',
  idFront: 'changes', idBack: 'changes', gps: 'changes', lcLetter: 'changes', review: 'code',
};
// 'start' is logged once the first answer is given, not on open (see funnelStarted).
const FUNNEL_STEP: Record<StepId, FunnelStep> = SECTION_OF;
/** Resubmit: the question each return_items_for item opens (tenant_photo = step 6). */
const RETURN_STEP: Record<string, StepId> = {
  tenant_photo: 'tenantPhoto', face_photo: 'tenantPhoto', photo: 'tenantPhoto', passport_photo: 'tenantPhoto',
  id_front: 'idFront', id_back: 'idBack', nin: 'nationalId', national_id: 'nationalId',
  lc1_letter: 'lcLetter', lc_letter: 'lcLetter', house_photos: 'photos', photos: 'photos', gps: 'gps',
  landlord: 'landlord', landlord_phone: 'landlord', rent: 'rent', days: 'days', duration: 'days',
  family_size: 'familySize', household: 'familySize', work: 'work',
  phone: 'tenantPhone', tenant_phone: 'tenantPhone', name: 'tenantName', tenant_name: 'tenantName', full_name: 'tenantName',
  house_type: 'category', house: 'category', category: 'category', language: 'language', smartphone: 'smartphone',
};
/** The "What's needed" line for a returned item. */
const RETURN_LABEL: Partial<Record<StepId, string>> = {
  tenantPhoto: TENANT_FACE_PHOTO, idFront: 'National ID front', idBack: 'National ID back', nationalId: 'NIN',
  lcLetter: 'LC1 letter photo', photos: 'House photos', gps: 'GPS at the house', landlord: 'Landlord and their phone',
  rent: 'Rent for one month', days: 'Days', familySize: 'Family size', work: 'Work / business',
  tenantPhone: 'Tenant’s phone', tenantName: 'Full names as on the ID', category: 'House type', language: 'Language', smartphone: 'Smartphone',
};
/** E108 funnel: the item code for each checklist item (anything else is 'other'). */
const T4_FUNNEL_ITEM: Partial<Record<T4ItemKey, FunnelItem>> = {
  photos: 'house_photos', landlord: 'landlord', rent: 'rent', gps: 'gps', familySize: 'family_size', work: 'work',
  lcLetter: 'lc1_letter', idFront: 'id_front', idBack: 'id_back', tenantPhoto: 'tenant_photo', tenantPhone: 'phone',
  consent: 'agreement', openRequest: 'duplicate',
};
/** E108 funnel: what a wrong answer to a question is missing. */
const STEP_FUNNEL_ITEM: Partial<Record<StepId, FunnelItem>> = {
  rent: 'rent', tenantPhone: 'phone', familySize: 'family_size', work: 'work', landlord: 'landlord',
  photos: 'house_photos', gps: 'gps', idFront: 'id_front', idBack: 'id_back', lcLetter: 'lc1_letter', tenantPhoto: 'tenant_photo',
};
const t4FunnelItems = (keys: T4ItemKey[]): FunnelItem[] => keys.map((k) => T4_FUNNEL_ITEM[k] ?? 'other');
/** E108 funnel: what a server refusal of a new request is about. */
const REFUSAL_FUNNEL_ITEM: Record<string, FunnelItem> = { landlord_missing: 'landlord', duplicate: 'duplicate' };

type PlanType = 'daily' | 'weekly' | 'monthly';
type Lc1Match = { id: string; name: string; verified: boolean; village: string } | null;
/** A draft older than this is dropped; the agent has moved on. */
const DRAFT_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** A photo taken now, or one already on file (file null, preview = its URL). */
type Photo = { file: File | null; preview: string };

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called with the request id once the Service Centre has it. */
  onSuccess?: (requestId: string) => void;
  /** What to open: a new request (optionally prefilled), a resubmit or a renewal. */
  request?: T4Request | null;
}

/** Where the form opens: a resubmit or renewal at its review, with the checklist of what is missing. */
function firstStep(request: T4Request | null | undefined): StepId {
  if (request?.mode === 'renewal') return 'renewPlan';
  return request?.mode === 'resubmit' ? 'review' : 'tenantPhone';
}

function greetingNow(): { text: string; emoji: string } {
  const h = new Date().getHours();
  if (h < 12) return { text: 'Good morning', emoji: '🌅' };
  if (h < 17) return { text: 'Good afternoon', emoji: '☀️' };
  return { text: 'Good evening', emoji: '🌙' };
}

export default function RentRequestAssistant({ open, onOpenChange, onSuccess, request }: Props) {
  const { user, enabledRoles, rolesResolved } = useAuth();
  const mode = request?.mode ?? 'new';
  /**
   * Anyone can post. A signed-in user who is not an agent first says who the request is for
   * (WhoIsPosting): themselves (the tenant self-apply flow) or someone else (become_agent).
   * Agents skip it. Only asked once the roles are known.
   */
  const [becameAgent, setBecameAgent] = useState(false);
  const needsWho = mode === 'new' && rolesResolved === true && !(enabledRoles ?? []).includes('agent') && !becameAgent;
  const draftKey = user?.id ? `welile_agent_rent_request_draft_${user.id}` : '';
  const rejected = request?.mode === 'resubmit' ? request.rejected : null;
  const renewal = request?.mode === 'renewal' ? request.renewal : null;
  // E63: no rent cap per tenant. Any monthly rent can be entered; the server's own rule
  // (tenant arrears) refuses what it should, and its message is shown as it is.
  // E100 (COO decision): no daily or weekly posting gate. The agent's collection against the
  // 50% rule is shown as information only; it never blocks a post.
  // E119: the agent reads their own figure (agent_eligibility_of with their own id) and its reason.
  const [collection, setCollection] = useState<MyCollectionInfo | null>(null);
  /*
   * E111: agents always post. An unverified agent's request passes every desk and waits at
   * the COO / funders' board until Agent Ops verifies them; `notice` says so. Only
   * `blocked` (the switch turned back on) stops a new request, with the old block.
   */
  const gate = useAgentGateStatus(user?.id, open && mode === 'new');
  const gateBlocked = mode === 'new' && gate?.blocked === true;
  const vettingNotice = mode === 'new' && !gateBlocked ? gate?.notice ?? null : null;
  useEffect(() => {
    if (!gateBlocked) return;
    window.dispatchEvent(new CustomEvent(NOT_VETTED_EVENT, {
      detail: gate?.reason || 'Complete your agent verification before posting a rent request.',
    }));
  }, [gateBlocked, gate?.reason]);
  useEffect(() => {
    if (!open || !user?.id) return;
    let cancelled = false;
    void fetchMyCollectionInfo(user.id).then((c) => { if (!cancelled) setCollection(c); });
    return () => { cancelled = true; };
  }, [open, user?.id]);

  // ----- answers -----
  const [planType, setPlanType] = useState<PlanType | null>(null);
  const [rentText, setRentText] = useState('');
  const [duration, setDuration] = useState<'30' | '60' | '90'>('30');
  const [repaymentPeriod, setRepaymentPeriod] = useState('7');
  const [tenantPhone, setTenantPhone] = useState('');
  const [tenantNameParts, setTenantNameParts] = useState<PersonNameParts>({ firstName: '', otherNames: '', lastName: '' });
  const [nationalId, setNationalId] = useState('');
  const [language, setLanguage] = useState('');
  const [noSmartphone, setNoSmartphone] = useState<boolean | null>(null);
  const [familySize, setFamilySize] = useState('');
  const [work, setWork] = useState('');
  const [workLocation, setWorkLocation] = useState('');
  const [landlord, setLandlord] = useState<LandlordOption | null>(null);
  const [landlordStatus, setLandlordStatus] = useState<'idle' | 'checking' | 'verified' | 'unverified' | 'missing'>('idle');
  const [agreementOnFile, setAgreementOnFile] = useState<boolean | null>(null);
  const [verifyReq, setVerifyReq] = useState<'idle' | 'sending' | 'sent' | 'exists'>('idle');
  const [showRegisterLandlord, setShowRegisterLandlord] = useState(false);
  const [houses, setHouses] = useState<AssistantHouse[] | null>(null);
  const [house, setHouse] = useState<AssistantHouse | null>(null);
  const [houseChoiceMade, setHouseChoiceMade] = useState(false);
  const [location, setLocation] = useState<UgLocationSelection | null>(null);
  const [address, setAddress] = useState('');
  const [district, setDistrict] = useState('');
  const [category, setCategory] = useState('');
  const [housePhotos, setHousePhotos] = useState<(Photo | null)[]>([null, null, null, null]);
  const [tenantPhoto, setTenantPhoto] = useState<Photo | null>(null);
  const [faceCheck, setFaceCheck] = useState<PassportFaceCheck | null>(null);
  /** The house GPS. source 'gps' when captured here; accuracy 0 = from the house listing or on file. */
  const [gps, setGps] = useState<{ lat: number; lng: number; accuracy: number | null; source?: GpsSource } | null>(null);
  const [lc1Phone, setLc1Phone] = useState('');
  const [lc1Match, setLc1Match] = useState<Lc1Match>(null);
  /** 'existing' = picked from the LC1 search; 'new' = the agent is registering them. */
  const [lc1Mode, setLc1Mode] = useState<'existing' | 'new' | null>(null);
  const [lc1Looking, setLc1Looking] = useState(false);
  const [lc1NameParts, setLc1NameParts] = useState<PersonNameParts>({ firstName: '', otherNames: '', lastName: '' });
  const [lc1Village, setLc1Village] = useState('');
  const [city, setCity] = useState('');
  const [lcLetter, setLcLetter] = useState<Photo | null>(null);
  /*
   * The one standard (E99) needs the LC1 letter PHOTO; "No LC1 letter yet" and an LC1 confirmed
   * by phone are gone. Kept as constants so older drafts that carried them open with them cleared.
   */
  const noLc1Letter = false;
  const noLc1Reason = '';
  const [payoutDay, setPayoutDay] = useState('');
  const [consent, setConsent] = useState(false);
  /**
   * E108 demand funnel for new requests ("Open rent request form"): open, steps, blocked
   * presses, items done, post and close. Fire-and-forget; never shown, never awaited.
   */
  // A renewal logs as its own form ('renewal'): open, its 3 steps, submit_ok / submit_fail.
  const funnel = useMemo(() => createFormFunnel(mode === 'renewal' ? 'renewal' : mode === 'resubmit' ? 'resubmit' : 'agent_post'), []);
  const tracking = mode === 'new';
  const logRenewal = mode === 'renewal';
  /** A resubmit logs as form 'resubmit': open, each item done, blocked items, submit_ok / submit_fail. */
  const logResubmit = mode === 'resubmit';
  useEffect(() => {
    if (!tracking) return;
    if (open) funnel.open(); else funnel.close();
  }, [open, tracking, funnel]);
  useEffect(() => {
    if (!logRenewal && !logResubmit) return;
    if (open) funnel.open(); else funnel.close();
  }, [open, logRenewal, logResubmit, funnel]);
  useEffect(() => () => funnel.close(), [funnel]);
  /** Step 'start' is logged once the first answer is given; until then only 'open' (and 'close'). */
  const [funnelStarted, setFunnelStarted] = useState(false);

  // ----- E109: save and finish later -----
  const [draftId, setDraftId] = useState<string | null>(request?.mode === 'new' ? request.draft?.id ?? null : null);
  const [saveOffer, setSaveOffer] = useState(false);
  const [savingDraft, setSavingDraft] = useState(false);
  const [draftNote, setDraftNote] = useState<{ ok: boolean; text: string } | null>(null);
  const [refusalItems, setRefusalItems] = useState<FunnelItem[]>([]);
  const [draftsOk, setDraftsOk] = useState<boolean | null>(draftsAvailable());
  const [jumpToMissing, setJumpToMissing] = useState(false);
  /** Photos already stored for a draft, so a second save does not upload them again. */
  const draftPaths = useRef(new WeakMap<File, DraftPhoto>());
  const draftFolder = useRef(newDraftFolder());
  useEffect(() => onDraftsAvailability(() => setDraftsOk(draftsAvailable())), []);
  useEffect(() => {
    // Learn once whether the draft RPCs exist; until they do, the button stays hidden.
    if (open && tracking && draftsAvailable() === null) fetchMyDrafts().catch(() => {});
  }, [open, tracking]);
  /** A blocked press: logged for the funnel, and "Save and finish later" is offered. */
  const blockedNow = (items: FunnelItem[], error?: string | null) => {
    funnel.blocked(items, error);
    setSaveOffer(true);
  };
  /**
   * The face check, given up after 15 seconds (or at once when offline): then the agent can
   * continue, the office checks the photo, and the funnel logs it as a blocked press.
   */
  const checkFace = async (file: File): Promise<PassportFaceCheck> => {
    const r = await runPassportFaceCheckWithin(file, { source: 'agent_rent_request' }, FACE_CHECK_TIMEOUT_MS, runPassportFaceCheck);
    if (r.status === 'skipped_timeout' && mode === 'new') funnel.blocked(['tenant_photo'], 'face_check_timeout');
    // E124: the check runs in the background (recorded with face_check_record once the request
    // exists); it never stops the agent.
    return r;
  };
  useEffect(() => {
    if (!open || !tracking || typeof document === 'undefined') return;
    const onHide = () => { if (document.visibilityState === 'hidden') funnel.close(); };
    document.addEventListener('visibilitychange', onHide);
    return () => document.removeEventListener('visibilitychange', onHide);
  }, [open, tracking, funnel]);
  /** Landlord referral code (E107): optional, prefilled from the page link (?ref=L…). */
  const [landlordCode, setLandlordCode] = useState(() => (typeof window === 'undefined' ? '' : landlordCodeFromSearch(window.location.search)));
  // ----- resubmit / renewal -----
  const [resubmitDays, setResubmitDays] = useState('');
  const [note, setNote] = useState('');
  /** The rejected request's values before any change, for the resubmit patch. */
  const [original, setOriginal] = useState<ResubmitValues | null>(null);
  /** An LC letter is already on the request (resubmit) or the plan being renewed. */
  const [lcOnFile, setLcOnFile] = useState(false);
  /** The tenant's profile (name, the four ID fields, occupation) for an existing tenant. */
  const [tenantOnFile, setTenantOnFile] = useState<TenantRecord | null>(null);
  /** The tenant's other open request: its status, null when there is none, undefined while checking. */
  const [openStatus, setOpenStatus] = useState<string | null | undefined>(() => (
    request?.mode === 'resubmit' || request?.mode === 'renewal' || (request?.mode === 'new' && request.prefill?.tenantId)
      ? undefined
      : null
  ));
  /** The GPS the request already had (resubmit / renewal); a newly captured one is sent with it. */
  const [gpsOnFile, setGpsOnFile] = useState(false);
  /* DOCS-1 (E75): photos of the National ID front and back (and the LC1 letter) on every request.
     A slot holds a new photo, or one already stored on the request (file null). */
  const [idFront, setIdFront] = useState<Photo | null>(null);
  const [idBack, setIdBack] = useState<Photo | null>(null);
  /** Documents already stored on the request being resubmitted, or on the plan being renewed. */
  const [docsOnFile, setDocsOnFile] = useState<Partial<Record<DocKind, StoredDoc>>>({});
  /**
   * E90: what the agent still has to add before this rejected request can go back
   * (_agent_side_missing). null until read, or when it could not be read: then every
   * resubmit question is asked as before.
   */
  const [sideMissing, setSideMissing] = useState<string[] | null>(null);
  const sideSteps = useMemo(() => (sideMissing ? new Set<SideMissingStep>(sideMissing.flatMap(sideMissingSteps)) : null), [sideMissing]);
  /** A question the agent opened from the checklist that the server list did not name. */
  const [extraSteps, setExtraSteps] = useState<StepId[]>([]);
  /** The server list has been read (or could not be): the flagged items can be opened. */
  const [sideLoaded, setSideLoaded] = useState(false);
  /**
   * E130 resubmit: resubmit_needs is the one source of what to fix (the desk's named items and
   * what the gate finds missing, merged, in order). null when it can't be read; then the older
   * sources (the server's still-missing lines and the reason text) are used.
   */
  const [needs, setNeeds] = useState<ResubmitNeeds | null>(null);
  const [returnLoaded, setReturnLoaded] = useState(false);
  const returnSteps = useMemo(() => {
    if (!needs) return null;
    // count 0: what the desk's note names, if anything.
    const fromItems = needs.items.map((i) => RETURN_STEP[i.code]).filter((x): x is StepId => !!x);
    const list = fromItems.length ? fromItems : itemsMentioned([needs.deskNote]).map((k) => REASON_STEP[k]);
    const out = Array.from(new Set(list));
    return out.length ? out : null;
  }, [needs]);
  /** E130: nothing listed and nothing named in the desk's note: the summary, "Tap what you fixed". */
  const tapWhatYouFixed = mode === 'resubmit' && !!needs && !returnSteps;
  /** Returned items the agent has redone (passed their question). */
  const [fixedSteps, setFixedSteps] = useState<StepId[]>([]);
  /** Step 1: what intake_tenant_check said about the tenant's phone, when it stops the agent. */
  const [tenantCheck, setTenantCheck] = useState<IntakeTenantCheck | null>(null);
  /** The tenant's phone that passed the step-1 checks (clean digits). */
  const [phoneCleared, setPhoneCleared] = useState<string | null>(null);
  /** Resubmit: items the return reason or the desk's checks point at, still to open after this one. */
  const redoQueue = useRef<StepId[]>([]);
  const flaggedOpened = useRef(false);
  /** An error to show on the question being opened (the composer's reset would clear it otherwise). */
  const pendingError = useRef<string | null>(null);
  /** The server lists this document, so a photo on file elsewhere does not count. */
  const listedDoc = (k: SideMissingStep) => mode === 'resubmit' && !!sideSteps?.has(k);
  /** Short-lived preview links for the documents on file. */
  const [docPreviews, setDocPreviews] = useState<Partial<Record<DocKind, string>>>({});

  /**
   * The tenant's ID front, ID back and LC1 letter already on file (their profile or an earlier request;
   * a renewal reuses the last plan's letter). The database carries them over, so the form shows them
   * as "On file ✓" and does not ask for them again.
   */
  function applyDocsOnFile(docs: Partial<Record<DocKind, StoredDoc>>) {
    setDocsOnFile(docs);
    if (docs.id_front) setIdFront((v) => v ?? { file: null, preview: '' });
    if (docs.id_back) setIdBack((v) => v ?? { file: null, preview: '' });
    if (docs.lc1_letter) setLcOnFile(true);
    (Object.entries(docs) as [DocKind, StoredDoc][]).forEach(([kind, doc]) => {
      void docPreviewUrl(doc).then((url) => { if (url) setDocPreviews((p) => ({ ...p, [kind]: url })); });
    });
  }
  /** The renewal choice and tenant code dialogs are up; the form steps aside. */
  const [renewing, setRenewing] = useState(false);
  const renewalFlow = useRenewalFlow();
  /** E128 renewal step 1: the new rent and days (with a reason when they change). */
  const [renewChoice, setRenewChoice] = useState<RenewalChoice | null>(null);
  /** Documents that didn't attach to the new renewal: tap to retry against the new id. */
  const [renewRetry, setRenewRetry] = useState<{ newId: string; failed: { kind: DocKind; file: File; message: string }[] } | null>(null);
  const [retryingDocs, setRetryingDocs] = useState(false);
  /** renew_rent_request said the tenant's code is missing or wrong: offer a new one in place. */
  const [renewOtpProblem, setRenewOtpProblem] = useState<string | null>(null);
  /** E128 renewal step 2: what changed since the last plan. */
  const [renewChange, setRenewChange] = useState<'same' | 'moved' | 'landlord' | null>(null);
  /** Standard items missing when the renewal opened (they become extra steps in step 2). */
  const [renewalExtra, setRenewalExtra] = useState<StepId[] | null>(null);
  const [renewalLoaded, setRenewalLoaded] = useState(false);
  const renewalAdvice = useRenewalAdvice(renewal?.prevId ?? null, renewal?.currentDays ?? null, mode === 'renewal' && open);
  /** E128: another agent may renew this tenant; Agent Ops then confirms them as the agent. */
  const renewingOthersTenant = mode === 'renewal' && !!renewal?.agentId && !!user?.id && renewal.agentId !== user.id;

  // ----- flow -----
  const [current, setCurrent] = useState<StepId>(() => firstStep(request));
  const [furthest, setFurthest] = useState<StepId>(() => (mode === 'new' ? 'tenantPhone' : mode === 'renewal' ? 'renewPlan' : 'review'));
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);
  /** A corrected answer the agent can accept with one tap ("Did you mean …?"). */
  const [fixOffer, setFixOffer] = useState<string | null>(null);
  /** Wrong tries per question; the third one adds a tip. */
  const [wrongTries, setWrongTries] = useState<Partial<Record<StepId, number>>>({});
  const [posting, setPosting] = useState(false);
  /** What the send button says while sending: "Uploading photos 3/6…", "Saving…", "Sent ✓". */
  const [sendProgress, setSendProgress] = useState<SendProgress | null>(null);
  const [result, setResult] = useState<{
    id: string;
    existing: boolean;
    lcLetterFailed: boolean;
    intakeError: string | null;
    lc1AttachError: string | null;
    lc1NoteError: string | null;
    /** Document photos that were not stored or attached, with the server's message. */
    docErrors: string[];
    /** The landlord referral code was not recorded ("Code not recognised", or the server's words). */
    referralError?: string | null;
  } | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const greeting = useMemo(greetingNow, [open]);

  const incomeType: AssistantIncomeType = planType === 'daily' ? 'daily' : 'weekly-monthly';
  const earnerCycle: AssistantEarnerCycle = planType === 'monthly' ? 'monthly' : 'weekly';
  const amount = parseInt(rentText.replace(/\D/g, ''), 10) || 0;
  const fees = planType ? computeAssistantFees(incomeType, amount, duration, repaymentPeriod) : null;
  const tenantName = joinPersonName(tenantNameParts);
  const lc1Name = lc1Match ? lc1Match.name : joinPersonName(lc1NameParts);

  // ----- existing-record checks (never reveal whose record it is) -----
  const [agentSelf, setAgentSelf] = useState<AgentSelf | null>(null);
  const [recordChecking, setRecordChecking] = useState(false);
  const [recordBlock, setRecordBlock] = useState<RecordBlock | null>(null);
  useEffect(() => {
    if (!open || !user?.id) return;
    let cancelled = false;
    const fallbackPhone = metaOf(user).phone || user.phone || null;
    loadAgentSelf(user.id, fallbackPhone)
      .then((me) => { if (!cancelled) setAgentSelf(me); })
      .catch(() => { if (!cancelled) setAgentSelf({ phone: fallbackPhone, nationalId: null }); });
    return () => { cancelled = true; };
  }, [open, user]);

  const steps: StepId[] = useMemo(() => {
    // DOCS-1: a document already on file is not asked for again.
    const onFile = (s: StepId) => (s === 'idFront' && !!docsOnFile.id_front)
      || (s === 'idBack' && !!docsOnFile.id_back)
      || (s === 'lcLetter' && !!docsOnFile.lc1_letter)
      || (s === 'tenantPhoto' && !!rejected?.tenant_photo_url?.trim());
    if (mode === 'renewal') {
      // E128: Plan, What changed (plus any standard item that is missing), then the code and Post.
      const extra = new Set(renewalExtra ?? []);
      return ['renewPlan', 'renewChanges', ...RENEWAL_STEPS.filter((s) => s !== 'review' && extra.has(s)), 'review'] as StepId[];
    }
    if (mode === 'resubmit') {
      if (returnSteps) {
        // E130: only the questions for the listed items. The note is pre-filled ("Fixed: …").
        const ask = new Set<StepId>([...returnSteps, ...extraSteps, 'review']);
        if (!note.trim() || note.trim().length < RESUBMIT_NOTE_MIN_CHARS) ask.add('note');
        return RESUBMIT_STEPS.filter((s) => ask.has(s));
      }
      if (sideSteps) {
        // E90: ask only for what the server lists, plus the note for the reviewer.
        const ask = new Set<StepId>([...sideSteps, ...extraSteps, 'note', 'review']);
        if (sideSteps.has('work')) ask.add('workLocation');
        return RESUBMIT_STEPS.filter((s) => ask.has(s));
      }
      // SC-2 does not ask a renewal for family size or work again.
      const skip = rejected?.registration_type === 'renewal' ? ['familySize', 'work', 'workLocation'] : [];
      return RESUBMIT_STEPS.filter((s) => extraSteps.includes(s) || (!skip.includes(s) && !onFile(s)));
    }
    return ALL_STEPS.filter((s) => {
      // Picked from the search: phone and name are already known.
      if (lc1Mode === 'existing' && (s === 'lc1Phone' || s === 'lc1Name')) return false;
      // New LC1 whose phone turned out to be on file: the name is known.
      return !(s === 'lc1Name' && lc1Match);
    });
  }, [lc1Match, lc1Mode, mode, rejected?.registration_type, rejected?.tenant_photo_url, docsOnFile, sideSteps, extraSteps, returnSteps, renewalExtra, note]);
  const idx = steps.indexOf(current);
  const furthestIdx = Math.max(steps.indexOf(furthest), idx);

  useEffect(() => {
    if (open && tracking && funnelStarted) funnel.step(FUNNEL_STEP[current]);
  }, [current, open, tracking, funnel, funnelStarted]);
  useEffect(() => {
    if (open && logRenewal) funnel.step(RENEWAL_SECTION_OF[current] ?? 'code');
  }, [current, open, logRenewal, funnel]);

  const reset = useCallback(() => {
    setPlanType(null); setRentText(''); setDuration('30'); setRepaymentPeriod('7');
    setTenantPhone(''); setTenantNameParts({ firstName: '', otherNames: '', lastName: '' }); setNationalId('');
    setLanguage(''); setNoSmartphone(null); setFamilySize(''); setWork(''); setWorkLocation('');
    setLandlord(null); setLandlordStatus('idle'); setAgreementOnFile(null);
    setVerifyReq('idle'); setHouses(null); setHouse(null); setHouseChoiceMade(false); setLocation(null); setAddress('');
    setDistrict(''); setCategory(''); setHousePhotos([null, null, null, null]); setTenantPhoto(null); setFaceCheck(null);
    setGps(null); setLc1Phone(''); setLc1Match(null); setLc1Mode(null); setLc1NameParts({ firstName: '', otherNames: '', lastName: '' });
    setLc1Village(''); setCity(''); setLcLetter(null); setPayoutDay(''); setConsent(false);
    setLandlordCode(typeof window === 'undefined' ? '' : landlordCodeFromSearch(window.location.search));
    setCurrent('tenantPhone'); setFurthest('tenantPhone'); setFunnelStarted(false); setDraft(''); setError(null); setResult(null); setRecordBlock(null);
    setFixOffer(null); setWrongTries({});
    setDraftId(null); setSaveOffer(false); setDraftNote(null); setRefusalItems([]); draftFolder.current = newDraftFolder();
    setIdFront(null); setIdBack(null);
    if (draftKey) { try { localStorage.removeItem(draftKey); } catch { /* ignore */ } void clearFormPhotos(draftKey); }
    // "Post another": a new funnel session.
    if (tracking) funnel.open();
  }, [tracking, funnel, draftKey]);

  /* ----- keep a new request on this phone until it is sent (doc 276) -----
     The phone's camera app sends the browser to the background and Android often
     reloads the page when it comes back, which used to throw the agent back to the
     first question with everything gone. Answers go to localStorage, photos to
     IndexedDB; the dashboard reopens the form after a reload (REOPEN_FLAG).
     Resubmits and renewals are filled from the server, so they are not kept. */
  const keepDraft = mode === 'new' && !!draftKey;
  const [draftLoaded, setDraftLoaded] = useState(false);
  useEffect(() => {
    if (!open || !keepDraft || draftLoaded) return;
    let cancelled = false;
    void (async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let d: Record<string, any> | null = null;
      try { d = JSON.parse(localStorage.getItem(draftKey) ?? 'null'); } catch { d = null; }
      // A prefilled form (opened for one tenant) or a saved request (E109) starts from that, not the old draft.
      const usable = !!d && !(request?.mode === 'new' && request.prefill) && !(request?.mode === 'new' && request.draft) && Date.now() - Number(d.savedAt ?? 0) < DRAFT_MAX_AGE_MS
        && (ALL_STEPS as string[]).includes(d.current);
      if (usable && d) {
        const ph = await loadFormPhotos<{ house?: (File | null)[]; tenant?: File | null; idFront?: File | null; idBack?: File | null; lcLetter?: File | null }>(draftKey);
        if (cancelled) return;
        setPlanType(d.planType ?? null); setRentText(d.rentText ?? ''); setDuration(d.duration ?? '30'); setRepaymentPeriod(d.repaymentPeriod ?? '7');
        setTenantPhone(d.tenantPhone ?? ''); if (d.tenantNameParts) setTenantNameParts(d.tenantNameParts); setNationalId(d.nationalId ?? '');
        setLanguage(d.language ?? ''); setNoSmartphone(d.noSmartphone ?? null); setFamilySize(d.familySize ?? ''); setWork(d.work ?? ''); setWorkLocation(d.workLocation ?? '');
        setLandlord(d.landlord ?? null); setHouses(d.houses ?? null); setHouse(d.house ?? null); setHouseChoiceMade(!!d.houseChoiceMade);
        setLocation(d.location ?? null); setAddress(d.address ?? ''); setDistrict(d.district ?? ''); setCategory(d.category ?? '');
        setGps(d.gps ?? null); setLc1Phone(d.lc1Phone ?? ''); setLc1Match(d.lc1Match ?? null); setLc1Mode(d.lc1Mode ?? null);
        if (d.lc1NameParts) setLc1NameParts(d.lc1NameParts);
        setLc1Village(d.lc1Village ?? ''); setCity(d.city ?? ''); setPayoutDay(d.payoutDay ?? ''); // an old "No LC1 letter yet" tick is not restored
        setCurrent(d.current); setFurthest(d.furthest ?? d.current);
        if (d.current !== 'tenantPhone') setFunnelStarted(true);
        if (d.tenantPhone && d.current !== 'tenantPhone') setPhoneCleared(clean(d.tenantPhone));
        if (ph) {
          setHousePhotos([0, 1, 2, 3].map((i) => previewOf(ph.house?.[i])));
          setIdFront(previewOf(ph.idFront)); setIdBack(previewOf(ph.idBack)); setLcLetter(previewOf(ph.lcLetter));
          const face = previewOf(ph.tenant);
          if (face) {
            setTenantPhoto(face);
            // The face check result was not kept; run it again.
            setFaceCheck({ status: 'checking' });
            if (face.file) void checkFace(face.file).then((r) => { if (!cancelled) setFaceCheck(r); });
          }
        }
        toast.success('Picked up where you left off', { action: { label: 'Start over', onClick: () => reset() } });
      }
      if (!cancelled) setDraftLoaded(true);
    })();
    return () => { cancelled = true; };
    // Once per open form.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, keepDraft, draftLoaded]);

  useEffect(() => {
    if (!keepDraft || !draftLoaded || !open || result) return;
    const t = window.setTimeout(() => {
      try {
        localStorage.setItem(draftKey, JSON.stringify({
          savedAt: Date.now(), planType, rentText, duration, repaymentPeriod, tenantPhone, tenantNameParts, nationalId,
          language, noSmartphone, familySize, work, workLocation, landlord, houses, house, houseChoiceMade, location,
          address, district, category, gps, lc1Phone, lc1Match, lc1Mode, lc1NameParts, lc1Village, city, noLc1Letter,
          noLc1Reason, payoutDay, current, furthest,
        }));
      } catch { /* quota or private mode: nothing kept */ }
      void saveFormPhotos(draftKey, {
        house: housePhotos.map((h) => h?.file ?? null), tenant: tenantPhoto?.file ?? null,
        idFront: idFront?.file ?? null, idBack: idBack?.file ?? null, lcLetter: lcLetter?.file ?? null,
      });
    }, 400);
    return () => window.clearTimeout(t);
  }, [keepDraft, draftLoaded, open, result, draftKey, planType, rentText, duration, repaymentPeriod, tenantPhone, tenantNameParts,
      nationalId, language, noSmartphone, familySize, work, workLocation, landlord, houses, house, houseChoiceMade, location,
      address, district, category, gps, lc1Phone, lc1Match, lc1Mode, lc1NameParts, lc1Village, city, noLc1Letter, noLc1Reason,
      payoutDay, current, furthest, housePhotos, tenantPhoto, idFront, idBack, lcLetter]);

  // Sent: the draft is done with. Open: reopen after a reload; closed on purpose: don't.
  useEffect(() => {
    if (result && draftKey) { try { localStorage.removeItem(draftKey); } catch { /* ignore */ } void clearFormPhotos(draftKey); }
  }, [result, draftKey]);
  // The host closes the form by unmounting it, so the flag is cleared in the cleanup.
  useEffect(() => {
    if (!open || !keepDraft || result || !user?.id) return;
    try { localStorage.setItem(REOPEN_FLAG, user.id); } catch { /* ignore */ }
    return () => { try { localStorage.removeItem(REOPEN_FLAG); } catch { /* ignore */ } };
  }, [open, keepDraft, result, user?.id]);

  // Fill the form from what opened it. The host mounts a fresh form for each request.
  useEffect(() => {
    if (!request) return;
    let cancelled = false;
    /** The gate refuses a tenant who already has a request on its way. */
    const checkOpen = (tenantId: string | null | undefined, exceptId?: string) => {
      if (!tenantId) { setOpenStatus(null); return; }
      findOpenRequest(tenantId, exceptId)
        .then((status) => { if (!cancelled) setOpenStatus(status); })
        // A failed look-up does not block: the database still refuses a duplicate.
        .catch((e) => { console.warn('[T4] open-request check failed', e); if (!cancelled) setOpenStatus(null); });
    };
    if (request.mode === 'new' && request.draft) {
      const f = (request.draft.payload?.fields ?? {}) as Record<string, any>;
      const str = (v: unknown) => (typeof v === 'string' ? v : '');
      if (f.planType) setPlanType(f.planType);
      setRentText(str(f.rentText));
      if (f.duration) setDuration(f.duration);
      if (f.repaymentPeriod) setRepaymentPeriod(String(f.repaymentPeriod));
      setTenantPhone(str(f.tenantPhone));
      if (f.tenantNameParts) setTenantNameParts(f.tenantNameParts);
      setNationalId(str(f.nationalId));
      setLanguage(str(f.language));
      if (typeof f.noSmartphone === 'boolean') setNoSmartphone(f.noSmartphone);
      setFamilySize(str(f.familySize));
      setWork(str(f.work));
      setWorkLocation(str(f.workLocation));
      if (f.landlord) setLandlord(f.landlord);
      if (f.house) setHouse(f.house);
      if (typeof f.houseChoiceMade === 'boolean') setHouseChoiceMade(f.houseChoiceMade);
      if (f.location) setLocation(f.location);
      setAddress(str(f.address));
      setDistrict(str(f.district));
      setCategory(str(f.category));
      // A face-check result stored with a draft is never trusted: the photo is checked again below.
      if (f.gps) setGps(f.gps);
      setLc1Phone(str(f.lc1Phone));
      if (f.lc1Match) setLc1Match(f.lc1Match);
      if (f.lc1Mode) setLc1Mode(f.lc1Mode);
      if (f.lc1NameParts) setLc1NameParts(f.lc1NameParts);
      setLc1Village(str(f.lc1Village));
      setCity(str(f.city));
      // An old "No LC1 letter yet" tick is not restored: the letter photo is needed.
      setPayoutDay(str(f.payoutDay));
      if (str(f.landlordCode)) setLandlordCode(str(f.landlordCode));
      const ph = request.draft.payload?.photos;
      void (async () => {
        const back = async (d: DraftPhoto | null | undefined, name: string): Promise<Photo | null> => {
          const file = await downloadDraftPhoto(d, name);
          if (!file || !d) return null;
          draftPaths.current.set(file, d);
          return { file, preview: URL.createObjectURL(file) };
        };
        const [house4, tp, front, backSide, letter] = await Promise.all([
          Promise.all([0, 1, 2, 3].map((i) => back(ph?.house?.[i], `house_${i}.jpg`))),
          back(ph?.tenantPhoto, 'tenant_photo.jpg'),
          back(ph?.idFront, 'id_front.jpg'),
          back(ph?.idBack, 'id_back.jpg'),
          back(ph?.lcLetter, 'lc_letter.jpg'),
        ]);
        if (cancelled) return;
        setHousePhotos(house4);
        setTenantPhoto(tp);
        // The face check runs again on the photo that came back, in the background only:
        // it never decides where the request opens (only a missing photo blocks).
        setFunnelStarted(true);
        if (tp?.file) {
          setFaceCheck({ status: 'checking' });
          void checkFace(tp.file).then((check) => { if (!cancelled) setFaceCheck(check); });
        } else {
          setFaceCheck(null);
        }
        setIdFront(front);
        setIdBack(backSide);
        setLcLetter(letter);
        // The phone passed step 1 when the request was saved.
        if (str(f.tenantPhone)) setPhoneCleared(clean(str(f.tenantPhone)));
        setJumpToMissing(true);
      })();
      return () => { cancelled = true; };
    }
    if (request.mode === 'new') {
      const p = request.prefill;
      if (!p) return;
      if (p.tenantId) checkOpen(p.tenantId);
      if (p.tenantName) setTenantNameParts(splitPersonName(p.tenantName));
      if (p.tenantPhone) setTenantPhone(formatPhone(p.tenantPhone));
      if (p.rentAmount && p.rentAmount > 0) setRentText(String(Math.round(p.rentAmount)));
      const h = p.house;
      if (h) {
        if (h.landlord_id) setLandlord({ id: h.landlord_id, name: h.landlord_name ?? '', phone: h.landlord_phone ?? '', property_address: h.address });
        setHouse({
          id: h.id, title: h.title, address: h.address, region: h.region, district: h.district, house_category: h.house_category,
          monthly_rent: h.monthly_rent, latitude: h.latitude, longitude: h.longitude, landlord_id: h.landlord_id, image_urls: h.image_urls ?? [],
        });
        setHouseChoiceMade(true);
        if (h.address) setAddress(h.address);
        if (h.district) setDistrict(normalizeDistrict(h.district));
        if (h.region) setCity(h.region);
        const mapped = mapHouseCategory(h.house_category);
        if (mapped) setCategory(mapped);
        if (h.latitude != null && h.longitude != null) setGps({ lat: Number(h.latitude), lng: Number(h.longitude), accuracy: 0 });
        if (!p.rentAmount && h.monthly_rent) setRentText(String(Math.round(Number(h.monthly_rent))));
      }
      return () => { cancelled = true; };
    }
    if (request.mode === 'renewal') {
      const r = request.renewal;
      setTenantNameParts(splitPersonName(r.tenantName));
      if (r.tenantPhone) setTenantPhone(formatPhone(r.tenantPhone));
      setRentText(String(Math.round(r.currentRent)));
      checkOpen(r.tenantId);
      (async () => {
        // The renewal re-posts the previous plan, so what that plan has on file is what the gate will see.
        const [plan, tenant] = await Promise.all([loadRequestOnFile(r.prevId), r.tenantId ? loadTenantRecord(r.tenantId) : null]);
        if (cancelled) return;
        if (plan) {
          setHousePhotos([0, 1, 2, 3].map((i) => (plan.photos[i] ? { file: null, preview: plan.photos[i] } : null)));
          if (plan.gps) { setGps({ ...plan.gps, accuracy: 0 }); setGpsOnFile(true); }
          setLcOnFile(plan.lcLetter);
        }
        if (tenant) {
          setTenantOnFile(tenant);
          if (tenant.full_name) setTenantNameParts(splitPersonName(tenant.full_name));
          if (tenant.national_id) setNationalId(tenant.national_id.toUpperCase());
        }
        // DOCS-1: what the tenant has on file (profile or earlier requests); the renewal reuses the
        // last plan's letter, so the previous plan's documents come first.
        const tenantDocs = r.tenantId ? await loadTenantDocsOnFile(r.tenantId) : {};
        if (cancelled) return;
        applyDocsOnFile({ ...tenantDocs, ...(plan?.docs ?? {}) });
        setRenewalLoaded(true);
      })();
      return () => { cancelled = true; };
    }
    const r = request.rejected;
    const urls = Array.isArray(r.house_image_urls) ? r.house_image_urls : [];
    setRentText(String(Math.round(Number(r.rent_amount) || 0)));
    setResubmitDays(r.duration_days ? String(r.duration_days) : '');
    setLanguage(r.preferred_language ?? '');
    setNoSmartphone(r.tenant_no_smartphone ?? false);
    setCategory(r.house_category ?? '');
    if (r.landlord_id) setLandlord({ id: r.landlord_id, name: r.landlord_name ?? '', phone: '', property_address: r.landlord_address ?? null });
    setHousePhotos([0, 1, 2, 3].map((i) => (urls[i] ? { file: null, preview: urls[i] } : null)));
    setLcOnFile(!!r.lc_letter_path?.trim());
    if (r.request_latitude != null && r.request_longitude != null) {
      setGps({ lat: Number(r.request_latitude), lng: Number(r.request_longitude), accuracy: 0 });
      setGpsOnFile(true);
    }
    setTenantNameParts(splitPersonName(r.tenant_name ?? ''));
    setTenantPhone(r.tenant_phone ? formatPhone(r.tenant_phone) : '');
    // The face photo already on the request: shown on the summary, retaken only when the agent taps it.
    if (r.tenant_photo_url?.trim()) setTenantPhoto({ file: null, preview: r.tenant_photo_url });
    checkOpen(r.tenant_id, r.id);
    (async () => {
      // The tenant's record (name, ID, occupation) and the intake already saved for this request.
      // E90: what the server still needs from the agent, read first.
      void fetchAgentSideMissing(r.id).then((lines) => { if (!cancelled) { setSideMissing(lines); setSideLoaded(true); } });
      void fetchResubmitNeeds(r.id).then((n) => {
        if (cancelled) return;
        setNeeds(n);
        setReturnLoaded(true);
        // E130: the note for the reviewer is written for the agent ("Fixed: …"); they may edit it.
        const labels = (n?.items ?? []).map((i) => i.label ?? i.code).filter(Boolean);
        const auto = n?.autoNote && n.autoNote.trim().length >= RESUBMIT_NOTE_MIN_CHARS
          ? n.autoNote.trim()
          : labels.length ? `Fixed: ${labels.join(', ')}` : null;
        if (auto && auto.length >= RESUBMIT_NOTE_MIN_CHARS) setNote((v) => v || auto);
      });
      const [t, onFile] = await Promise.all([loadTenantRecord(r.tenant_id), loadRequestOnFile(r.id)]);
      if (cancelled) return;
      if (t) setTenantOnFile(t);
      // DOCS-1: this request's documents first, then what the tenant has on file elsewhere.
      const tenantDocs = await loadTenantDocsOnFile(r.tenant_id);
      if (cancelled) return;
      applyDocsOnFile({ ...tenantDocs, ...(onFile?.docs ?? {}) });
      const d = onFile ? { family_size: onFile.familySize, work_business: onFile.workBusiness, work_location: onFile.workLocation } : null;
      const name = t?.full_name || r.tenant_name || '';
      const phone = t?.phone || r.tenant_phone || '';
      if (name) setTenantNameParts(splitPersonName(name));
      if (phone) setTenantPhone(formatPhone(phone));
      if (t?.national_id) setNationalId(t.national_id.toUpperCase());
      if (d?.family_size) setFamilySize(String(d.family_size));
      const w = d?.work_business || t?.occupation || '';
      if (w) setWork(w);
      if (d?.work_location) setWorkLocation(d.work_location);
      setOriginal(rejectedToValues(r, { name, phone, nationalId: t?.national_id ?? '' }));
    })();
    return () => { cancelled = true; };
    // Runs once: the form is mounted per request.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!open) return;
    requestAnimationFrame(() => scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' }));
  }, [open, current, error, result, houses, landlordStatus, lc1Match, faceCheck, posting]);

  // Seed the composer with the stored value when a text step opens.
  useEffect(() => {
    const seed: Partial<Record<StepId, string>> = {
      rent: rentText ? groupDigits(rentText) : '',
      tenantPhone, nationalId, familySize, work, workLocation, address, lc1Phone, lc1Village, city,
      days: resubmitDays, note,
    };
    setDraft(seed[current] ?? '');
    setError(pendingError.current);
    pendingError.current = null;
    setFixOffer(null);
    // Keep a notice raised for this very step (the pre-post re-check sends the agent back with one).
    setRecordBlock((b) => (b && b.step === current ? b : null));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current]);

  // ----- landlord checks (same RPCs as the form) -----
  useEffect(() => {
    const landlordId = landlord?.id;
    if (!landlordId) { setLandlordStatus('idle'); setAgreementOnFile(null); return; }
    let cancelled = false;
    setLandlordStatus('checking');
    setVerifyReq('idle');
    (async () => {
      try {
        const [{ data, error: e1 }, { data: agreement, error: e2 }] = await Promise.all([
          rpcUntyped('get_landlord_verification_status', { p_id: landlordId }),
          rpcUntyped('landlord_has_current_agreement', { p_landlord_id: landlordId }),
        ]);
        if (cancelled) return;
        const row = (Array.isArray(data) ? data[0] : data) as { exists_flag?: boolean; verified?: boolean } | null | undefined;
        if (e1) setLandlordStatus('idle');
        else if (!row || row.exists_flag === false) setLandlordStatus('missing');
        else setLandlordStatus(row.verified ? 'verified' : 'unverified');
        setAgreementOnFile(e2 ? null : agreement === true);
      } catch {
        if (!cancelled) { setLandlordStatus('idle'); setAgreementOnFile(null); }
      }
    })();
    return () => { cancelled = true; };
  }, [landlord?.id]);

  const requestLandlordVerification = async () => {
    if (!landlord || !user) return;
    setVerifyReq('sending');
    const meta = metaOf(user);
    const agentName = meta.full_name || meta.name || 'Agent';
    const agentPhone = meta.phone || user.phone || null;
    try {
      const { data: inserted, error: e } = await supabase
        .from('landlord_verification_requests')
        .insert({
          landlord_id: landlord.id,
          landlord_name: landlord.name,
          landlord_phone: landlord.phone || null,
          requested_by: user.id,
          agent_name: agentName,
          agent_phone: agentPhone,
          status: 'pending',
        })
        .select('id')
        .single();
      if (e) {
        if ((e as { code?: string }).code === '23505') { setVerifyReq('exists'); return; }
        throw e;
      }
      setVerifyReq('sent');
      void notifyVerificationCreated({
        agentId: user.id, agentName, landlordId: landlord.id, landlordName: landlord.name,
        landlordPhone: landlord.phone || null, requestId: inserted?.id ?? null,
      });
    } catch (err) {
      setVerifyReq('idle');
      toast.error('Could not send the request', { description: err instanceof Error ? err.message : 'Please try again.' });
    }
  };

  // Available houses for the chosen landlord (photoless ones shown but blocked).
  useEffect(() => {
    if (current !== 'house' || !landlord?.id) return;
    let cancelled = false;
    setHouses(null);
    (async () => {
      const { data, error: e } = await supabase
        .from('house_listings')
        .select('id, title, address, region, district, house_category, monthly_rent, latitude, longitude, landlord_id, image_urls')
        .eq('landlord_id', landlord.id)
        .eq('status', 'available')
        .is('tenant_id', null)
        .is('reserved_at', null)
        .eq('is_hidden', false)
        .order('created_at', { ascending: false })
        .limit(20);
      if (cancelled) return;
      if (e) { setHouses([]); return; }
      const rows = (data || []) as unknown as Array<Omit<AssistantHouse, 'image_urls'> & { image_urls: unknown }>;
      setHouses(rows.map((r) => ({ ...r, image_urls: Array.isArray(r.image_urls) ? (r.image_urls as string[]) : [] })));
    })();
    return () => { cancelled = true; };
  }, [current, landlord?.id]);

  const pickHouse = (h: AssistantHouse | null) => {
    hapticTap();
    setHouse(h);
    setHouseChoiceMade(true);
    if (h) {
      if (h.address) setAddress(h.address);
      if (h.district) setDistrict(normalizeDistrict(h.district));
      if (h.region && !city) setCity(h.region);
      const mapped = mapHouseCategory(h.house_category);
      if (mapped) setCategory(mapped);
      if (h.latitude != null && h.longitude != null) setGps({ lat: Number(h.latitude), lng: Number(h.longitude), accuracy: 0 });
    }
    advance('house');
  };

  // ----- photos -----
  /* Every photo is taken in this page: the phone's camera app can make Android reload the
     form (doc 276). One camera, opened for whichever photo was tapped; the label's own file
     input stays as the fallback when the camera cannot open. */
  const [camera, setCamera] = useState<{
    title: string; hint: string; facing: 'user' | 'environment'; oval: boolean;
    onPick: (f: File) => void; input: HTMLInputElement | null;
  } | null>(null);
  const openCamera = (e: import('react').MouseEvent<HTMLLabelElement>, opts: Omit<NonNullable<typeof camera>, 'input'>) => {
    if ((e.target as HTMLElement).tagName === 'INPUT') return;
    e.preventDefault();
    setCamera({ ...opts, input: e.currentTarget.querySelector('input[type=file]') });
  };
  const readPhoto = async (file: File, encoding?: Parameters<typeof optimizeImage>[1]): Promise<(Photo & { file: File }) | null> => {
    if (!ALLOWED_IMAGE_TYPES.includes(file.type.toLowerCase())) { toast.error('Use a JPG, PNG, WebP or HEIC photo'); return null; }
    if (file.size > 10 * 1024 * 1024) { toast.error('That photo is over 10 MB'); return null; }
    try {
      const optimized = await optimizeImage(file, encoding);
      return { file: optimized.file, preview: optimized.previewUrl };
    } catch {
      return { file, preview: URL.createObjectURL(file) };
    }
  };
  const onHousePhoto = async (i: number, file: File | undefined) => {
    if (!file) return;
    const p = await readPhoto(file);
    if (!p) return;
    setHousePhotos((prev) => { const next = [...prev]; if (next[i]) URL.revokeObjectURL(next[i]!.preview); next[i] = p; return next; });
  };
  const onTenantPhoto = async (file: File | undefined) => {
    if (!file) return;
    // Encoded once, as JPEG (FACE_PHOTO_ENCODING), because the face checker reads
    // JPEG and PNG only: the same bytes then serve the check, the preview and
    // storage. As WebP the phone had to decode and re-encode this picture again
    // before it could be graded, which is most of the wait on a cheap handset.
    const p = await readPhoto(file, FACE_PHOTO_ENCODING);
    if (!p) return;
    setTenantPhoto((prev) => { if (prev) URL.revokeObjectURL(prev.preview); return p; });
    setFaceCheck({ status: 'checking' });
    setError(null);
    const res = await checkFace(p.file);
    setFaceCheck(res);
  };
  /** The LC1 letter photo: camera or gallery, turned into a JPEG (an iPhone's HEIC included). */
  const onLcLetter = async (file: File | undefined) => {
    if (!file) return;
    const p = await readPhoto(file, FACE_PHOTO_ENCODING);
    if (!p) return;
    setLcLetter((prev) => { if (prev) URL.revokeObjectURL(prev.preview); return p; });
    setError(null);
  };

  /*
   * The house GPS (gpsCapture.ts): "Capture location" just captures and stores the coordinates.
   * The network and the GPS are asked at once; the first reading is taken and improved silently
   * for up to 60 s (old phones' GPS chips are slow). No map.
   * request_form_log: item_done gps { accuracy_m }, or why there was no reading
   * (gps_permission_denied / gps_timeout / gps_unavailable), and gps_in_app_browser.
   */
  const gpsWatch = useGpsCapture({
    onFix: (fix, first) => {
      setGps({ lat: fix.lat, lng: fix.lng, accuracy: fix.accuracy, source: 'gps' });
      setError(null);
      if (first && tracking) funnel.itemDone('gps', { accuracy_m: fix.accuracy === null ? null : Math.round(fix.accuracy), gps_source: 'gps' });
    },
    onFail: (code) => {
      if (tracking) blockedNow(['gps'], code);
    },
    onInAppBrowser: () => { if (tracking) blockedNow(['gps'], 'gps_in_app_browser'); },
  });

  // ----- LC1 lookup -----
  const lookupLc1 = async (phone: string): Promise<Lc1Match> => {
    setLc1Looking(true);
    try {
      const { data } = await supabase.rpc('find_lc1_by_phone', { p_phone: clean(phone) });
      return ((data ?? [])[0] as Lc1Match) ?? null;
    } catch {
      return null;
    } finally {
      setLc1Looking(false);
    }
  };

  // ----- validation (same rules as the form, said kindly and specifically) -----
  const validate = (s: StepId, text = draft): string | null => {
    switch (s) {
      case 'type':
        return planType ? null : 'Pick one of the options above so I know how they’ll pay back 👆';
      case 'renewPlan':
        return renewChoice ? null : 'Choose the new rent and days first 👆';
      case 'renewChanges':
        if (renewChange === 'landlord') return 'A new landlord needs a new rent request. Tap “Post a new request” above.';
        return renewChange ? null : 'Tell me what changed since the last plan 👆';
      case 'language':
        return language ? null : 'Pick a language above 👆 so their SMS messages make sense to them.';
      case 'smartphone':
        return noSmartphone === null ? 'Just tap Yes or No above 👆' : null;
      case 'house':
        return houseChoiceMade ? null : 'Pick a house above, or tap “The house isn’t listed” 👆';
      case 'category':
        return category ? null : 'Pick the type of place above 👆';
      case 'payoutDay':
        return payoutDay ? null : 'Pick a payout day above 👆';
      case 'familySize':
        return familySizeProblem(text);
      case 'work':
        return workProblem(text);
      case 'lcLetter':
        // DOCS-1: only a photo of the letter counts; a phone confirmation or a "no letter yet" reason does not.
        return lcLetter || lcOnFile ? null : 'Add a photo of the stamped LC1 letter 📄';
      case 'days': {
        const n = parseInt(text.replace(/\D/g, ''), 10) || 0;
        return n >= RESUBMIT_DAYS_MIN && n <= RESUBMIT_DAYS_MAX ? null : `Type the number of days, from ${RESUBMIT_DAYS_MIN} to ${RESUBMIT_DAYS_MAX} 📅`;
      }
      case 'note':
        return text.trim().length >= RESUBMIT_NOTE_MIN_CHARS
          ? null
          : `Tell the reviewer what you changed, in at least ${RESUBMIT_NOTE_MIN_CHARS} characters ✍️`;
      case 'rent': {
        const n = parseInt(text.replace(/\D/g, ''), 10) || 0;
        if (!n) return 'I didn’t catch an amount 🤔 Type the monthly rent, like 450,000.';
        if (n < 50000) {
          return n * 1000 >= 50000 && n < 50000 / 10
            ? `Hmm, ${formatUGX(n)} looks too small for a month’s rent. Did you mean ${formatUGX(n * 1000)}? 🤔`
            : `${formatUGX(n)} is below the UGX 50,000 minimum for a Rent Plan. Check the amount with the tenant 🙏`;
        }
        return null;
      }
      case 'tenantPhone':
        return phoneProblem(text, 'the tenant');
      case 'tenantName':
        if (!tenantNameParts.firstName.trim() && !tenantNameParts.lastName.trim()) return 'I need their name before we move on 🙂 Type the first and last name.';
        if (!tenantNameParts.lastName.trim()) return `And ${tenantNameParts.firstName.trim()}’s last name? I need both, as on the ID 🪪`;
        return tenantNameParts.firstName.trim() ? null : 'And their first name? I need both, as on the ID 🪪';
      case 'nationalId': {
        const id = text.replace(/[^a-zA-Z0-9]/g, '').toUpperCase();
        if (!id) return 'I didn’t catch the NIN 🤔 It’s on the front of the card, like CM12345678ABCD.';
        if (id.length < 10) return `That’s only ${id.length} characters. The NIN on the card is usually 14, like CM12345678ABCD 🪪`;
        if (id.length > 14) return `That’s ${id.length} characters, a bit too long. The NIN is 14 at most 🪪`;
        return null;
      }
      case 'landlord':
        if (!landlord) return 'Search for the landlord above, or register them if they’re new 👆';
        if (landlordStatus === 'missing') return 'Hmm, that landlord is no longer on Welile 😕 Pick another, or register them.';
        if (mode === 'new' && !clean(landlord.phone || '')) return `${landlord.name} has no phone number on Welile 🤔 Register the landlord with their own phone.`;
        if (clean(landlord.phone || '') && clean(formatPhone(landlord.phone)) === clean(tenantPhone)) return `${landlord.name} has the same phone as the tenant 🤔 The tenant and landlord need different numbers.`;
        if (clean(landlord.phone || '') && agentSelf?.phone && clean(formatPhone(landlord.phone)) === clean(formatPhone(agentSelf.phone))) {
          return 'That’s your own phone number 🙂 The landlord needs their own phone.';
        }
        return null;
      case 'address':
        return text.trim() ? null : 'Type an address, even a nearby landmark works 🙂';
      case 'photos': {
        // 3 or more house photos (the Agent Ops gate), in every mode.
        const have = housePhotos.filter(Boolean).length;
        return have >= MIN_HOUSE_PHOTOS ? null : `Agent Ops needs at least ${MIN_HOUSE_PHOTOS} house photos 📸 Add ${MIN_HOUSE_PHOTOS - have} more.`;
      }
      case 'tenantPhoto':
        // Only a missing photo blocks; the face check is advice (E124).
        return tenantPhoto ? null : `Take a clear photo of ${tenantNameParts.firstName.trim() || 'the tenant'} first 📸`;
      case 'idFront':
        return idFront ? null : 'Take a photo of the FRONT of the National ID first 🪪';
      case 'idBack':
        return idBack ? null : 'Take a photo of the BACK of the National ID first 🪪';
      case 'gps':
        return gps ? null : 'Tap “Capture location” while you’re at the house 📍';
      case 'lc1':
        return lc1Mode ? null : 'Search for the chairperson above, or tap “Register a new LC1” 👆';
      case 'lc1Phone': {
        const p = phoneProblem(text, 'the LC1');
        if (p) return p;
        const c = clean(formatPhone(text));
        if (c === clean(tenantPhone)) return 'That’s the tenant’s own number 🙂 The LC1 has to be a different person.';
        if (landlord && c === clean(landlord.phone || '')) return `That’s ${landlord.name}’s number, the landlord 🙂 The LC1 has to be a different person.`;
        return null;
      }
      case 'lc1Name':
        if (!lc1NameParts.firstName.trim() || !lc1NameParts.lastName.trim()) return 'I need the LC1’s first and last name 🙂';
        return null;
      case 'lc1Village':
        return text.trim() ? null : 'Which village? Type its name, like Kireka B 🏡';
      case 'city':
        return text.trim() ? null : 'Type the town or city, like Kira 🌆';
      default:
        return null;
    }
  };

  /** A corrected value to offer as a one-tap fix, when the mistake is a common one. */
  const fixFor = (s: StepId, text: string): string | null => {
    if (s === 'rent') {
      const n = parseInt(text.replace(/\D/g, ''), 10) || 0;
      return n > 0 && n < 5000 && n * 1000 >= 50000 ? groupDigits(String(n * 1000)) : null;
    }
    if (s === 'tenantPhone' || s === 'lc1Phone') {
      const d = text.replace(/\D/g, '');
      return /^[37][0-9]{8}$/.test(d) ? formatPhone(`0${d}`) : null;
    }
    return null;
  };

  /** One extra hint after the second wrong try at the same question. */
  const tipFor = (s: StepId): string | null => {
    switch (s) {
      case 'rent': return '💡 Tip: type the numbers only, like 450000. I’ll add the commas.';
      case 'tenantPhone': return '💡 Tip: ask the tenant to flash your phone, then copy the number from your call log.';
      case 'lc1Phone': return '💡 Tip: ask the LC1 to flash your phone, then copy the number from your call log.';
      case 'nationalId': return '💡 Tip: the NIN is printed on the front of the card next to “NIN”. Letters O and I are rare; check for zeros and ones.';
      case 'photos': return '💡 Tip: tap each empty box to open the camera.';
      case 'gps': return '💡 Tip: turn on location for this site in your browser settings, then step outside for a clearer signal.';
      default: return null;
    }
  };

  /** Rejects a wrong answer: says what is wrong, offers a fix if there is one, adds a tip on the third try. */
  const reject = (s: StepId, problem: string, text = draft) => {
    // The Capture attempt logs its own reason (gps_timeout …) once; a Continue tap without a GPS is gps_not_captured.
    if (tracking) blockedNow([STEP_FUNNEL_ITEM[s] ?? 'other'], s === 'gps' ? 'gps_not_captured' : undefined);
    else if (logResubmit) funnel.blocked([STEP_FUNNEL_ITEM[s] ?? 'other']);
    const tries = (wrongTries[s] ?? 0) + 1;
    setWrongTries((t) => ({ ...t, [s]: tries }));
    const tip = tries >= 3 ? tipFor(s) : null;
    setError(tip ? `${problem}\n${tip}` : problem);
    setFixOffer(fixFor(s, text));
  };

  /**
   * Runs the existing-record check for a step. Returns true when the value is
   * new; otherwise shows the locked notice (or a retry message) and returns false.
   */
  async function recordIsNew(step: RecordBlock['step'], value: string): Promise<boolean> {
    setRecordBlock(null);
    setRecordChecking(true);
    let verdict: RecordVerdict;
    try {
      verdict = step === 'tenantPhone' ? await checkTenantPhone(value, agentSelf)
        : step === 'nationalId' ? await checkNationalId(value, agentSelf)
          : await checkNewLc1Phone(value, agentSelf);
    } finally {
      setRecordChecking(false);
    }
    if (verdict.status === 'free') return true;
    if (verdict.status === 'unknown') {
      if (tracking) blockedNow(['other'], 'record_check_unavailable');
      setError('I couldn’t check Welile’s records just now. Check your connection and send it again.');
      return false;
    }
    if (tracking) blockedNow(['duplicate']);
    setRecordBlock(blockFor(step, verdict.hit === 'self', value));
    return false;
  }

  /** Jump to a step that `steps` may only include from the next render. */
  function goTo(step: StepId) {
    setCurrent(step);
    if (ALL_STEPS.indexOf(step) > ALL_STEPS.indexOf(furthest)) setFurthest(step);
  }

  /** An LC1 picked from the search: same person checks as a typed number. */
  const pickLc1 = (hit: Lc1Hit) => {
    const c = clean(formatPhone(hit.phone || ''));
    const own = agentSelf?.phone ? clean(formatPhone(agentSelf.phone)) : '';
    if (c && c === clean(tenantPhone)) { reject('lc1', `${hit.name} has the tenant’s own number 🤔 The LC1 has to be a different person.`); return; }
    if (c && landlord && c === clean(formatPhone(landlord.phone || ''))) { reject('lc1', `${hit.name} has ${landlord.name}’s number, the landlord 🤔 The LC1 has to be a different person.`); return; }
    if (c && own && c === own) { reject('lc1', 'That chairperson has your own number 🙂 The LC1 has to be someone else, so they can vouch for the tenant.'); return; }
    hapticTap();
    setError(null);
    setLc1Mode('existing');
    setLc1Match({ id: hit.id, name: hit.name, verified: hit.verified, village: hit.village ?? '' });
    setLc1Phone(formatPhone(hit.phone || ''));
    if (hit.village) setLc1Village(hit.village);
    goTo('lc1Village');
  };

  /** Register a new LC1; a typed name or phone from the search is carried over. */
  const startNewLc1 = (query: string) => {
    hapticTap();
    setError(null);
    setLc1Mode('new');
    setLc1Match(null);
    if (query && /^\+?[0-9\s]+$/.test(query)) {
      setLc1Phone(formatPhone(query));
    } else {
      setLc1Phone('');
      const words = query.split(/\s+/).filter(Boolean);
      if (words.length) setLc1NameParts({ firstName: words[0], otherNames: words.slice(1, -1).join(' '), lastName: words.length > 1 ? words[words.length - 1] : '' });
    }
    goTo('lc1Phone');
  };

  /**
   * E124 step 1: intake_tenant_check on the tenant's phone. Own phone, a request already on
   * its way, or one returned to another agent stop here; one returned to this agent opens
   * its resubmit. A check that cannot be read does not stop the agent.
   */
  async function tenantCheckPasses(value: string): Promise<boolean> {
    setTenantCheck(null);
    setRecordChecking(true);
    let c: IntakeTenantCheck;
    try {
      c = await checkIntakeTenant(value);
    } finally {
      setRecordChecking(false);
    }
    if (c.kind === 'ok' || c.kind === 'unavailable') return true;
    setTenantCheck(c);
    if (tracking) blockedNow([c.kind === 'own_phone' ? 'phone' : 'duplicate'], `intake_${c.kind}`);
    if (c.kind === 'returned_request' && c.mine && c.requestId && user?.id) {
      const list = await fetchAgentRejectedRequests(user.id).catch(() => [] as Awaited<ReturnType<typeof fetchAgentRejectedRequests>>);
      const rejectedOne = list.find((r) => r.id === c.requestId);
      if (rejectedOne) openT4RentRequest({ mode: 'resubmit', rejected: rejectedOne, entry: 'intake-returned' });
    }
    return false;
  }

  /** Opens a question with an error already on it. */
  function showErrorAt(step: StepId, message: string) {
    if (step === current) { setError(message); return; }
    pendingError.current = message;
    setCurrent(step);
  }

  function advance(from: StepId) {
    if (mode === 'resubmit' && returnSteps?.includes(from)) {
      setFixedSteps((x) => (x.includes(from) ? x : [...x, from]));
      funnel.itemDone(STEP_FUNNEL_ITEM[from] ?? 'other');
    }
    if (mode === 'resubmit' && redoQueue.current.length) {
      setCurrent(redoQueue.current.shift()!);
      return;
    }
    const i = steps.indexOf(from);
    // When an earlier answer was edited, go back to where the agent had reached —
    // except for answers the next step depends on, which walk forward one step.
    // A resubmit goes back to the summary after each redo; only a new rent asks the days again.
    const dependsOnNext = mode === 'resubmit'
      ? from === 'rent'
      : from === 'type' || from === 'rent' || from === 'landlord' || from === 'lc1';
    const target = !dependsOnNext && i < furthestIdx && steps[furthestIdx] !== from
      ? steps[furthestIdx]
      : steps[Math.min(i + 1, steps.length - 1)];
    setCurrent(target);
    if (steps.indexOf(target) > steps.indexOf(furthest)) setFurthest(target);
  }

  const submitText = async (text = draft) => {
    const s = current;
    const problem = validate(s, text);
    if (problem) { reject(s, problem, text); return; }
    setFixOffer(null);
    hapticTap();
    switch (s) {
      case 'rent': setRentText(text.replace(/\D/g, '')); break;
      case 'tenantPhone': {
        const value = formatPhone(text);
        // A resubmit keeps the tenant's own number: it is on file because it is theirs.
        const kept = mode === 'resubmit' && !!original && clean(value) === clean(formatPhone(original.tenantPhone));
        if (mode === 'new' && !(await tenantCheckPasses(value))) return;
        if (!kept && !(await recordIsNew('tenantPhone', value))) return;
        setTenantPhone(value);
        setPhoneCleared(clean(value));
        if (tracking && !funnelStarted) { funnel.step('start'); setFunnelStarted(true); }
        break;
      }
      case 'nationalId': {
        const value = text.replace(/[^a-zA-Z0-9]/g, '').toUpperCase();
        const kept = (mode === 'resubmit' && !!original && value === original.nationalId.toUpperCase())
          || (mode === 'renewal' && value === (tenantOnFile?.national_id ?? '').toUpperCase());
        if (!kept && !(await recordIsNew('nationalId', value))) return;
        setNationalId(value);
        break;
      }
      case 'days': setResubmitDays(String(parseInt(text.replace(/\D/g, ''), 10))); break;
      case 'note': setNote(text.trim()); break;
      case 'familySize': setFamilySize(String(parseFamilySize(text))); break;
      case 'work': setWork(text.trim()); break;
      case 'workLocation': setWorkLocation(text.trim()); break;
      case 'address': setAddress(text.trim()); break;
      case 'lc1Phone': {
        setLc1Phone(formatPhone(text));
        const m = await lookupLc1(text);
        setLc1Match(m);
        if (m?.village && !lc1Village) setLc1Village(m.village);
        // A brand-new LC1 must not be the agent or a landlord.
        if (!m && !(await recordIsNew('lc1Phone', formatPhone(text)))) return;
        if (m) {
          // The "new" LC1 is already on file: treat it as picked, which skips the name question.
          setLc1Mode('existing');
          setCurrent('lc1Village');
          if (steps.indexOf('lc1Village') > steps.indexOf(furthest)) setFurthest('lc1Village');
          return;
        }
        // Unknown LC1: always ask the name next (it may have been skipped before).
        setCurrent('lc1Name');
        if (steps.indexOf('lc1Name') > steps.indexOf(furthest) || !steps.includes('lc1Name')) setFurthest('lc1Name');
        return;
      }
      case 'lc1Village': setLc1Village(text.trim()); break;
      case 'city': setCity(text.trim()); break;
    }
    advance(s);
  };

  const continueStep = () => {
    const problem = validate(current);
    if (problem) { reject(current, problem); return; }
    hapticTap();
    advance(current);
  };

  const showSent = (id: string, o: T4IntakeOutcome, docErrors: string[] = []) => {
    hapticSuccess();
    setResult({
      id, existing: true, lcLetterFailed: o.lcLetterFailed, intakeError: o.intakeError,
      lc1AttachError: o.lc1AttachError, lc1NoteError: o.lc1NoteError, docErrors,
    });
    onSuccess?.(id);
    request?.onDone?.(id);
  };

  const postResubmit = async () => {
    if (!user || !rejected || !original || posting || missing.length) return;
    setPosting(true);
    setSendProgress(null);
    setError(null);
    const after: ResubmitValues = {
      rentAmount: amount,
      durationDays: parseInt(resubmitDays, 10) || original.durationDays,
      preferredLanguage: language || null,
      noSmartphone,
      landlordId: landlord?.id ?? original.landlordId,
      landlordName: landlord?.name ?? original.landlordName,
      landlordPhone: landlord?.phone ?? '',
      houseCategory: category || null,
      tenantName,
      tenantPhone,
      nationalId,
    };
    const urls = Array.isArray(rejected.house_image_urls) ? rejected.house_image_urls : [];
    const patch = resubmitPatch(original, after);
    // The request had no GPS; send the one captured at the house now.
    if (!gpsOnFile && gps) { patch.request_latitude = gps.lat; patch.request_longitude = gps.lng; }
    // DOCS-1: new photos are attached to this existing request (request_attach_document), and
    // E90: family size and work saved, both before the resubmit (resubmitT4Request), and for a
    // renewal-type request too when the server lists them. They go in side by side.
    const askDetails = rejected.registration_type !== 'renewal' || !!sideSteps?.has('familySize') || !!sideSteps?.has('work');
    const res = await resubmitT4Request({
      agentId: user.id,
      requestId: rejected.id,
      patch,
      note,
      photos: housePhotos.map((p) => (p ? (p.file ?? p.preview) : null)),
      extraPhotoUrls: urls.slice(4),
      // The LC1 letter goes with the ID photos (docs).
      lcLetter: null,
      noLc1Reason: null,
      details: askDetails
        ? { familySize: parseFamilySize(familySize), workBusiness: work, workLocation }
        : null,
      docs: { id_front: idFront?.file ?? null, id_back: idBack?.file ?? null, lc1_letter: lcLetter?.file ?? null },
      tenantPhoto: tenantPhoto?.file
        ? { file: tenantPhoto.file, sha256: faceCheck?.sha256 ?? null, faceCheck: faceCheck?.status === 'skipped_timeout' ? 'skipped_timeout' : null }
        : null,
      onProgress: setSendProgress,
    });
    // Server errors are shown as they come. RESUBMIT_INCOMPLETE: read the list again so the
    // questions match what the server still needs.
    if ('message' in res) {
      setPosting(false);
      setSendProgress(null);
      funnel.submitFail(funnelErrorCode(res.message, plainServerMessage(res.message).slice(0, 120)), t4FunnelItems(missing.map((m) => m.key)));
      const photoProblem = facePhotoRefusal(res.message);
      if (photoProblem) {
        redoQueue.current = [];
        setExtraSteps((x) => (x.includes('tenantPhoto') ? x : [...x, 'tenantPhoto']));
        showErrorAt('tenantPhoto', photoProblem);
        return;
      }
      setError(res.message);
      if (res.message.includes('RESUBMIT_INCOMPLETE')) {
        void fetchAgentSideMissing(rejected.id).then((lines) => { if (lines) setSideMissing(lines); });
      }
      return;
    }
    setPosting(false);
    setSendProgress({ phase: 'sent' });
    funnel.submitOk(res.requestId);
    // A retaken face photo: what the background check found, on the request (E124).
    if (tenantPhoto?.file && faceCheck && faceCheck.status !== 'checking') void recordFaceCheck(res.requestId, faceCheck.status);
    showSent(res.requestId, res);
  };

  const postRenewalPlan = async () => {
    if (!user || !renewal || posting || missing.length) return;
    setError(null);
    // E128: the rent and days were chosen in step 1 (chosen here if not yet); step 3 is the
    // tenant's code on those figures, then the post.
    const target = { prevId: renewal.prevId, tenantName: tenantName || renewal.tenantName, currentRent: renewal.currentRent, currentDays: renewal.currentDays };
    let choice = renewChoice;
    if (!choice) {
      setRenewing(true);
      choice = await renewalFlow.choose(target);
      setRenewing(false);
      if (!choice) return;
      setRenewChoice(choice);
    }
    setRenewing(true);
    const consented = await renewalFlow.confirm(target, choice);
    setRenewing(false);
    if (!consented) return;
    setRenewOtpProblem(null);
    setPosting(true);
    setSendProgress(null);
    let sent = false;
    try {
      const counter = createUploadCounter(setSendProgress);
      // A changed name, or a NIN for a tenant with no ID on file, goes on the tenant's profile first.
      const nameChanged = tenantName.trim() !== (tenantOnFile?.full_name ?? renewal.tenantName).trim();
      const ninNew = !hasTenantId(tenantOnFile) && !!nationalId.trim();
      if (renewal.tenantId && (nameChanged || ninNew)) {
        const saved = await saveTenantProfile(renewal.tenantId, { fullName: nameChanged ? tenantName : null, nationalId: ninNew ? nationalId : null });
        if (!saved.ok) { setError(plainServerMessage(saved.message)); return; }
      }
      counter.saving();
      // 1. The renewal itself. Nothing is ever attached to the previous (completed) request.
      let newId: string;
      try {
        newId = await postRenewal(
          renewal.prevId,
          choice,
          () => toast.info('Capturing the property GPS at the house…'),
          !gpsOnFile && gps ? { latitude: gps.lat, longitude: gps.lng } : null,
        );
      } catch (e) {
        const raw = e instanceof Error ? e.message : String(e);
        funnel.submitFail(funnelErrorCode(raw, plainServerMessage(raw).slice(0, 120)), ['other']);
        if (/RENEWAL_OTP_(REQUIRED|MISMATCH)/.test(raw)) {
          setRenewOtpProblem(/MISMATCH/.test(raw)
            ? 'The tenant’s code didn’t match. Send a new code and ask them for it again.'
            : 'The tenant’s code is needed again. Send a new code.');
          return;
        }
        setError(plainServerMessage(raw));
        return;
      }
      setRentText(String(choice.newRent));
      funnel.submitOk(newId);
      // 2. The documents captured in step 2 go on the NEW request, each on its own; one that fails
      // doesn't undo or hide the renewal (resubmit_needs will ask for it too).
      const docFiles = ([['id_front', idFront?.file], ['id_back', idBack?.file], ['lc1_letter', lcLetter?.file]] as const)
        .filter((d): d is readonly [DocKind, File] => !!d[1]);
      const [docResults, photoError, o] = await Promise.all([
        Promise.all(docFiles.map(async ([kind, file]) => {
          const problems = await attachT4Documents(user.id, newId, { [kind]: file }, counter);
          return problems.length ? { kind, file, message: plainServerMessage(problems[0]) } : null;
        })),
        attachRenewalPhotos(user.id, newId, housePhotos.map((p) => (p ? (p.file ?? p.preview) : null)), counter),
        finishRenewalIntake(user.id, newId, null, null),
      ]);
      const failed = docResults.filter((x): x is { kind: DocKind; file: File; message: string } => !!x);
      setRenewRetry(failed.length ? { newId, failed } : null);
      sent = true;
      setSendProgress({ phase: 'sent' });
      showSent(newId, { ...o, lc1AttachError: o.lc1AttachError ?? (photoError ? `House photos not saved: ${plainServerMessage(photoError)}` : null) });
    } catch (e) {
      setError(plainServerMessage(e instanceof Error ? e.message : String(e)));
    } finally {
      setPosting(false);
      if (!sent) setSendProgress(null);
    }
  };

  /** Retry the renewal's documents that didn't attach, against the new request. */
  const retryRenewalDocs = async () => {
    if (!user || !renewRetry || retryingDocs) return;
    setRetryingDocs(true);
    try {
      const still = (await Promise.all(renewRetry.failed.map(async (f) => {
        const problems = await attachT4Documents(user.id, renewRetry.newId, { [f.kind]: f.file });
        return problems.length ? { ...f, message: plainServerMessage(problems[0]) } : null;
      }))).filter((x): x is { kind: DocKind; file: File; message: string } => !!x);
      setRenewRetry(still.length ? { newId: renewRetry.newId, failed: still } : null);
      if (!still.length) toast.success('Documents uploaded ✓');
    } finally {
      setRetryingDocs(false);
    }
  };

  const post = async () => {
    if (mode === 'resubmit') return postResubmit();
    if (mode === 'renewal') return postRenewalPlan();
    if (gateBlocked) return;
    if (!user || !fees || !landlord || !tenantPhoto || posting) return;
    if (missing.length) {
      blockedNow(t4FunnelItems(missing.map((m) => m.key)));
      setError(`Still missing: ${missing.map((m) => m.label).join(', ')}.`);
      return;
    }
    if (!consent) { blockedNow(['agreement']); setError('Tick the box to accept guarantor responsibility.'); return; }
    // Required intake: every step checks its own answer; this catches anything skipped.
    const intakeMissing = (!isFullName(tenantName) && 'Type the tenant’s full name (first and last), as on the ID.')
      || familySizeProblem(familySize)
      || workProblem(work)
      || lc1LetterProblem({ hasLetter: !!lcLetter, noLetterYet: noLc1Letter, reason: noLc1Reason });
    if (intakeMissing) {
      blockedNow([
        !isFullName(tenantName) ? 'other'
          : familySizeProblem(familySize) ? 'family_size'
            : workProblem(work) ? 'work'
              : 'lc1_letter',
      ]);
      setError(`${intakeMissing} Tap the answer above to fix it.`);
      return;
    }
    setPosting(true);
    setSendProgress(null);
    setError(null);
    // DOCS-1: the three document photos start uploading now, side by side with the re-check below
    // and then with the house and face photos and the checks in the submit; their paths go in
    // the insert itself. A failed photo comes back as the submit's error. If the re-check stops the
    // send, the stored photos are simply never used.
    const counter = createUploadCounter(setSendProgress);
    const docs = uploadNewRequestDocs(user.id, { idFront: idFront!.file!, idBack: idBack!.file!, lcLetter: lcLetter!.file! }, counter);
    docs.catch(() => {});
    // Re-check right before posting: the number or ID may have been registered since it was typed.
    const [phoneNow, ninNow] = await Promise.all([checkTenantPhone(tenantPhone, agentSelf), checkNationalId(nationalId, agentSelf)]);
    for (const [step, verdict, value] of [['tenantPhone', phoneNow, tenantPhone], ['nationalId', ninNow, nationalId]] as const) {
      if (verdict.status === 'taken') {
        blockedNow(['duplicate']);
        setPosting(false);
        setSendProgress(null);
        setCurrent(step);
        setRecordBlock(blockFor(step, verdict.hit === 'self', value));
        return;
      }
      if (verdict.status === 'unknown') {
        blockedNow(['other'], 'record_check_unavailable');
        setPosting(false);
        setSendProgress(null);
        setError('I couldn’t check Welile’s records just now. Check your connection and tap Post again.');
        return;
      }
    }
    const res = await submitAssistantRentRequest({
      agentId: user.id,
      docs,
      uploadCounter: counter,
      incomeType,
      earnerCycle,
      fees,
      tenantName,
      tenantPhone,
      tenantNationalId: nationalId,
      preferredLanguage: language,
      noSmartphone: !!noSmartphone,
      landlordId: landlord.id,
      landlordName: landlord.name,
      landlordPhone: landlord.phone || '',
      house,
      houseCategory: category,
      propertyCity: city,
      propertyDistrict: district || location?.district || '',
      location,
      gps,
      housePhotos: housePhotos.map((p) => p?.file).filter((f): f is File => !!f),
      tenantPhoto: tenantPhoto.file as File,
      faceCheckSha256: faceCheck?.sha256 ?? null,
      faceCheck: faceCheck?.status === 'skipped_timeout' ? 'skipped_timeout' : null,
      lc1Name,
      lc1Phone,
      lc1Village,
      // The LC1 letter goes with the ID photos after the insert, through request_attach_document.
      lcLetter: null,
      landlordPayoutDay: payoutDay || '1',
      familySize: parseFamilySize(familySize) ?? 0,
      workBusiness: work,
      workLocation,
      noLc1Reason: null,
    });
    if (res.ok) {
      funnel.submitOk(res.rentRequestId, gps ? { gps_source: gps.source ?? 'listing', gps_accuracy_m: gps.accuracy ? Math.round(gps.accuracy) : null } : undefined);
      if (faceCheck && faceCheck.status !== 'checking') void recordFaceCheck(res.rentRequestId, faceCheck.status);
      if (draftId) void closeDraft(draftId, 'posted', res.rentRequestId);
      setPosting(false);
      setSendProgress({ phase: 'sent' });
      hapticSuccess();
      setResult({
        id: res.rentRequestId,
        existing: res.tenantExisting,
        lcLetterFailed: res.lcLetterFailed,
        intakeError: res.intakeError,
        lc1AttachError: res.lc1AttachError,
        lc1NoteError: res.lc1NoteError,
        docErrors: [],
      });
      // E107: the landlord referral code is recorded on the saved request. It never blocks or
      // delays the request; an unknown code is only noted on the "sent" screen.
      const newId = res.rentRequestId;
      void recordLandlordReferral(newId, landlordCode).then((o) => {
        if (o && 'message' in o) setResult((r) => (r && r.id === newId ? { ...r, referralError: o.message } : r));
      });
      onSuccess?.(res.rentRequestId);
      request?.onDone?.(res.rentRequestId);
      return;
    }
    setPosting(false);
    setSendProgress(null);
    const fail = res as Extract<AssistantSubmitResult, { ok: false }>;
    // The server refused: a blocked press and a failed submit, with the server's error code.
    const refusalItems: FunnelItem[] = [REFUSAL_FUNNEL_ITEM[fail.reason] ?? 'other'];
    const refusalCode = funnelErrorCode(fail.message, fail.reason);
    setRefusalItems(refusalItems);
    blockedNow(refusalItems, refusalCode);
    funnel.submitFail(refusalCode, refusalItems);
    if (fail.raw && promptIfNotVetted(fail.raw, fail.message)) {
      setError(agentNotVettedReason(fail.raw) ?? agentNotVettedReason(fail.message) ?? fail.message);
      return;
    }
    const photoProblem = facePhotoRefusal(fail.message);
    if (photoProblem) { showErrorAt('tenantPhoto', photoProblem); return; }
    if (fail.backTo) {
      if (fail.backTo === 'house') { setHouse(null); setHouseChoiceMade(false); }
      showErrorAt(fail.backTo, fail.message);
    } else {
      setError(fail.message);
    }
  };

  // ----- what T4 still needs: the Agent Ops gate (_ao_gate_missing), then what this form needs to send -----
  const ninTyped = validate('nationalId', nationalId) === null;
  const facts: Partial<Record<T4ItemKey, boolean>> = {
    // The gate: Service Centre basics, SC-2 intake, LC1, full name, tenant ID, no other open request.
    photos: housePhotos.filter(Boolean).length >= MIN_HOUSE_PHOTOS,
    landlord: mode === 'renewal' ? true : !!landlord && landlordStatus !== 'missing',
    rent: mode === 'renewal' ? (renewal?.currentRent ?? 0) > 0 : amount > 0 && validate('rent', rentText) === null,
    gps: !!gps,
    familySize: familySizeProblem(familySize) === null,
    work: workProblem(work) === null || !!tenantOnFile?.occupation?.trim(),
    // The letter, or the LC1 confirmed by phone. A "no letter yet" reason does not pass the gate.
    lcLetter: listedDoc('lcLetter') ? !!lcLetter?.file : !!lcLetter || lcOnFile,
    tenantName: isFullName(tenantName),
    idFront: listedDoc('idFront') ? !!idFront?.file : !!idFront,
    idBack: listedDoc('idBack') ? !!idBack?.file : !!idBack,
    openRequest: openStatus === null,
    // What this form needs to send.
    plan: !!planType && !!fees,
    tenantPhone: isUgPhone(tenantPhone),
    house: !!category && !!address.trim(),
    // Only a missing photo blocks. A resubmit returned for the photo needs a new one.
    tenantPhoto: mode === 'resubmit' ? (!returnSteps?.includes('tenantPhoto') || !!tenantPhoto?.file) : !!tenantPhoto,
    lc1: !!lc1Mode && !!clean(lc1Phone) && !!lc1Name.trim() && !!lc1Village.trim(),
    payoutDay: !!payoutDay,
    consent,
    note: note.trim().length >= RESUBMIT_NOTE_MIN_CHARS,
  };
  const missing = t4Missing(mode, facts, rejected?.registration_type, openStatus);

  /** Is a question answered (for "first open question of a step")? */
  const questionDone = (s: StepId): boolean => {
    switch (s) {
      case 'tenantPhone': return isUgPhone(tenantPhone) && phoneCleared === clean(tenantPhone);
      case 'tenantName': return isFullName(tenantName);
      case 'language': return !!language;
      case 'smartphone': return noSmartphone !== null;
      case 'type': return !!planType;
      case 'rent': return validate('rent', rentText) === null;
      // The days have a default, so a priced plan is a chosen one.
      case 'plan': return !!planType && !!fees;
      case 'landlord': return !!landlord && validate('landlord') === null;
      case 'payoutDay': return !!payoutDay;
      case 'house': return houseChoiceMade;
      case 'location': return !!location || !!house;
      case 'address': return !!address.trim();
      case 'city': return !!city.trim();
      case 'category': return !!category;
      case 'photos': return validate('photos') === null;
      case 'gps': return !!gps;
      case 'familySize': return familySizeProblem(familySize) === null;
      case 'work': return workProblem(work) === null;
      case 'tenantPhoto': return !!tenantPhoto;
      case 'nationalId': return ninTyped;
      case 'idFront': return !!idFront;
      case 'idBack': return !!idBack;
      case 'lc1': return !!lc1Mode;
      case 'lc1Phone': return !!clean(lc1Phone);
      case 'lc1Name': return !!lc1Name.trim();
      case 'lc1Village': return !!lc1Village.trim();
      case 'lcLetter': return !!lcLetter || lcOnFile;
      default: return true;
    }
  };
  /** The first unanswered question of an intake step (or its first question). */
  const firstOpenQuestion = (section: IntakeStepKey): StepId => {
    const inSection = steps.filter((st) => SECTION_OF[st] === section);
    return inSection.find((st) => !questionDone(st)) ?? inSection[0] ?? LAST_NEW_STEP;
  };
  /** E124: the 8 steps and what each still needs, for the header and Post. */
  const landlordOwnPhone = !!landlord && !!clean(landlord.phone || '') && validate('landlord') === null;
  const intakeState: IntakeState = {
    tenant: [
      { label: 'Tenant’s phone number', done: questionDone('tenantPhone') },
      { label: 'Full names as on the ID', done: isFullName(tenantName) },
      { label: 'Language for SMS', done: !!language },
      { label: 'Smartphone: yes or no', done: noSmartphone !== null },
      ...(openStatus ? [{ label: 'No other open request for this tenant', done: false }] : []),
    ],
    rent_plan: [
      { label: 'Daily, weekly or monthly earner', done: !!planType },
      { label: 'Rent for ONE month (min UGX 50,000)', done: validate('rent', rentText) === null && amount > 0 },
      { label: 'Days', done: questionDone('plan') },
    ],
    landlord: [
      { label: 'Landlord’s name', done: !!landlord && landlordStatus !== 'missing' },
      { label: 'Landlord’s own phone (not the tenant’s or yours)', done: landlordOwnPhone },
      { label: 'Landlord payout day', done: !!payoutDay },
    ],
    house: [
      { label: 'House type', done: !!category },
      { label: 'Village / address', done: !!address.trim() },
      { label: 'GPS captured at the house', done: !!gps },
      { label: `${MIN_HOUSE_PHOTOS}+ house photos`, done: housePhotos.filter(Boolean).length >= MIN_HOUSE_PHOTOS },
    ],
    household: [
      { label: 'Family size (1–30)', done: familySizeProblem(familySize) === null },
      { label: 'Work / business and where', done: workProblem(work) === null },
    ],
    tenant_photo: [{ label: 'Any clear photo of the tenant', done: !!tenantPhoto }],
    id: [
      { label: 'NIN', done: ninTyped },
      { label: 'National ID front', done: !!idFront },
      { label: 'National ID back', done: !!idBack },
    ],
    lc1_post: [
      { label: 'LC1 chairperson', done: !!facts.lc1 },
      { label: 'LC1 letter photo', done: !!lcLetter || lcOnFile },
      { label: 'Guarantor consent', done: consent },
    ],
  };
  // E128: the renewal's 3 steps and what each still needs.
  useEffect(() => {
    if (mode !== 'renewal' || !renewalLoaded || renewalExtra !== null) return;
    // The standard items missing when it opened become extra steps in "What changed".
    const missingNow: StepId[] = [];
    if (!isFullName(tenantName)) missingNow.push('tenantName');
    if (!hasTenantId(tenantOnFile) && !ninTyped) missingNow.push('nationalId');
    if (housePhotos.filter(Boolean).length < MIN_HOUSE_PHOTOS) missingNow.push('photos');
    if (!idFront) missingNow.push('idFront');
    if (!idBack) missingNow.push('idBack');
    if (!gps) missingNow.push('gps');
    if (!lcLetter && !lcOnFile) missingNow.push('lcLetter');
    setRenewalExtra(missingNow);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, renewalLoaded, renewalExtra]);
  const renewalState: StepState = {
    plan: [
      { label: `Last plan: ${formatUGX(renewal?.currentRent ?? 0)} for ${renewal?.currentDays ?? ''} days, completed`, done: true },
      { label: 'New rent and days', done: !!renewChoice },
      ...(renewChoice?.changed ? [{ label: 'Reason for the change', done: !!renewChoice.reasonCode }] : []),
    ],
    changes: [
      { label: 'What changed: same house and landlord, or moved', done: renewChange === 'same' || renewChange === 'moved' },
      ...(renewalExtra ?? []).map((st) => ({
        label: RETURN_LABEL[st] ?? st,
        done: st === 'nationalId' ? hasTenantId(tenantOnFile) || ninTyped : questionDone(st),
      })),
    ],
    code: [{ label: 'Tenant’s SMS code, then Post', done: !!result }],
  };
  const jumpRenewal = (key: string) => {
    if (result || posting) return;
    hapticTap();
    if (key === 'plan') setCurrent('renewPlan');
    else if (key === 'changes') setCurrent('renewChanges');
    else setCurrent('review');
  };
  const chooseRenewal = async () => {
    if (!renewal) return;
    setRenewing(true);
    const c = await renewalFlow.choose({ prevId: renewal.prevId, tenantName: tenantName || renewal.tenantName, currentRent: renewal.currentRent, currentDays: renewal.currentDays });
    setRenewing(false);
    if (c) { setRenewChoice(c); setRentText(String(c.newRent)); setError(null); }
  };

  /** Post on step 8 is replaced by "2 left: House, ID" while a step (other than the consent tick) is incomplete. */
  const leftForPost = intakeLeftLabel({ ...intakeState, lc1_post: intakeState.lc1_post.filter((i) => i.label !== 'Guarantor consent') });
  const firstLeft = firstIncompleteStep({ ...intakeState, lc1_post: intakeState.lc1_post.filter((i) => i.label !== 'Guarantor consent') });
  const toFix = mode === 'resubmit' && returnSteps ? returnSteps.filter((st) => !fixedSteps.includes(st)).length : null;
  const showIntakeHeader = !result && !gateBlocked && !needsWho && (mode === 'new' || mode === 'renewal' || (mode === 'resubmit' && !!returnSteps));
  const onlySections = mode === 'resubmit' && returnSteps ? Array.from(new Set(returnSteps.map((st) => SECTION_OF[st]))) : null;
  /** Tap a step name: its first open question (a resubmit: its first returned item). */
  const jumpToSection = (section: IntakeStepKey) => {
    if (result || posting) return;
    hapticTap();
    if (mode === 'resubmit') {
      const target = returnSteps?.find((st) => SECTION_OF[st] === section);
      if (target) { redoQueue.current = []; setCurrent(target); }
      return;
    }
    goTo(firstOpenQuestion(section));
  };
  const doneKey = (Object.keys(facts) as T4ItemKey[]).filter((k) => facts[k]).sort().join(',');
  useEffect(() => {
    if (!open || !tracking) return;
    for (const k of doneKey.split(',')) {
      const item = T4_FUNNEL_ITEM[k as T4ItemKey];
      if (item) funnel.itemDone(item);
    }
  }, [doneKey, open, tracking, funnel]);
  // Resubmit: what the return reason or the desk's checks name opens first, even when on file.
  useEffect(() => {
    if (mode !== 'resubmit' || !sideLoaded || !returnLoaded || !original || flaggedOpened.current) return;
    flaggedOpened.current = true;
    // E130: resubmit_needs, in its order. When it can't be read: what the reason and the server list name.
    const flagged = returnSteps ?? (needs ? [] : itemsMentioned([rejected?.rejected_reason, ...(sideMissing ?? [])]).map((k) => REASON_STEP[k]));
    if (!flagged.length) return;
    setExtraSteps((x) => Array.from(new Set([...x, ...flagged])));
    redoQueue.current = flagged.slice(1);
    setCurrent(flagged[0]);
  }, [mode, sideLoaded, returnLoaded, returnSteps, needs, original, rejected?.rejected_reason, sideMissing]);

  useEffect(() => {
    if (!jumpToMissing) return;
    setJumpToMissing(false);
    // A saved request reopens on its first incomplete step (E124), at its first open question.
    const section = firstIncompleteStep(intakeState);
    setFurthest(LAST_NEW_STEP);
    setCurrent(section ? firstOpenQuestion(section) : LAST_NEW_STEP);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jumpToMissing]);

  /** Everything entered so far, photos as storage paths (uploaded now when new). */
  const handleSaveDraft = async () => {
    if (!user || savingDraft) return;
    setSavingDraft(true);
    setDraftNote(null);
    try {
      const store = async (ph: Photo | null, kind: DraftPhotoKind, i = 0): Promise<DraftPhoto | null> => {
        if (!ph?.file) return null;
        const known = draftPaths.current.get(ph.file);
        if (known) return known;
        const stored = await uploadDraftPhoto(user.id, draftFolder.current, kind, ph.file, i);
        draftPaths.current.set(ph.file, stored);
        return stored;
      };
      const [house4, tp, front, backSide, letter] = await Promise.all([
        Promise.all(housePhotos.map((ph, i) => store(ph, 'house', i))),
        store(tenantPhoto, 'tenant_photo'),
        store(idFront, 'id_front'),
        store(idBack, 'id_back'),
        store(lcLetter, 'lc1_letter'),
      ]);
      const payload: PostingDraftPayload = {
        v: 1,
        fields: {
          planType, rentText, duration, repaymentPeriod, tenantPhone, tenantNameParts, nationalId, language, noSmartphone,
          familySize, work, workLocation, landlord, house, houseChoiceMade, location, address, district, category,
          // Not saved: the face-check result (re-run on Continue) and guarantor consent (ticked again).
          gps, lc1Phone, lc1Match, lc1Mode, lc1NameParts, lc1Village, city, noLc1Letter, noLc1Reason, payoutDay, landlordCode,
        },
        photos: { house: house4, tenantPhoto: tp, idFront: front, idBack: backSide, lcLetter: letter },
      };
      const missingItems = Array.from(new Set([...t4FunnelItems(missing.map((m) => m.key)), ...refusalItems]));
      const res = await saveDraft({
        payload,
        missing: missingItems.length ? missingItems : ['other'],
        tenantName: tenantName || null,
        tenantPhone: tenantPhone || null,
        draftId,
        session: funnel.session,
      });
      if ('id' in res) {
        setDraftId(res.id || draftId);
        setDraftNote({ ok: true, text: DRAFT_SAVED_MESSAGE });
        funnel.close({ saved_draft: true });
      } else if (!res.missingRpc) {
        // The RPC not being there hides the button (draftsOk); anything else is said as it came.
        setDraftNote({ ok: false, text: res.message });
      }
    } catch (e) {
      setDraftNote({ ok: false, text: e instanceof Error ? e.message : String(e) });
    } finally {
      setSavingDraft(false);
    }
  };
  const showSaveDraft = tracking && draftsOk === true && !result;
  const saveDraftBlock = (
    <div className="flex flex-col gap-1" data-testid="save-draft">
      <button
        type="button"
        onClick={() => void handleSaveDraft()}
        disabled={savingDraft}
        className="flex h-11 items-center justify-center gap-2 rounded-2xl border border-primary/40 bg-background text-sm font-semibold text-primary disabled:opacity-60"
      >
        {savingDraft ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
        {savingDraft ? 'Saving…' : draftId ? 'Save changes for later' : 'Save and finish later'}
      </button>
      {draftNote && (
        <p className={cn('text-xs', draftNote.ok ? 'text-success' : 'text-destructive')} role="status">{draftNote.text}</p>
      )}
    </div>
  );

  /** Resubmit summary: any line opens its question to redo it. */
  const redo = (s: StepId) => {
    if (result || posting) return;
    hapticTap();
    redoQueue.current = [];
    setExtraSteps((x) => (steps.includes(s) || x.includes(s) ? x : [...x, s]));
    setCurrent(s);
  };
  const fixItem = (k: T4ItemKey) => {
    const s = ITEM_STEP[k];
    if (!s) return;
    if (steps.includes(s)) { hapticTap(); setCurrent(s); return; }
    // A resubmit asks only what the server lists; an item the form still finds missing opens too.
    if (mode === 'resubmit' && RESUBMIT_STEPS.includes(s)) {
      hapticTap();
      setExtraSteps((x) => (x.includes(s) ? x : [...x, s]));
      setCurrent(s);
    }
  };
  const sentLine = mode === 'resubmit'
    ? `${tenantNameParts.firstName || 'The tenant'}’s request is back with the Service Centre for a fresh review.`
    : mode === 'renewal'
      ? `${tenantNameParts.firstName || 'The tenant'}’s renewal for ${formatUGX(amount)} is with the Service Centre.`
      : `${tenantNameParts.firstName}’s request for ${formatUGX(amount)} is with the Service Centre.`;

  /** A document's line on the review: a new photo, "On file ✓" with a small preview, or missing. */
  const docRow = (kind: DocKind): { v: string; preview: string | null } => {
    const slot = kind === 'id_front' ? idFront : kind === 'id_back' ? idBack : lcLetter;
    if (slot?.file) return { v: 'Photo added', preview: slot.preview };
    if (listedDoc(kind === 'id_front' ? 'idFront' : kind === 'id_back' ? 'idBack' : 'lcLetter')) return { v: 'Missing', preview: null };
    if (docsOnFile[kind] || (kind === 'lc1_letter' && lcOnFile)) return { v: 'On file ✓', preview: docPreviews[kind] ?? null };
    return { v: 'Missing', preview: null };
  };

  // ----- copy -----
  const questionOf = (s: StepId): string => {
    const first = tenantNameParts.firstName.trim() || 'the tenant';
    const landlordFirst = landlord?.name?.split(' ')[0] || 'the landlord';
    switch (s) {
      case 'type': return 'How does the tenant earn their money? 💼 It decides how they’ll pay back.';
      case 'rent': return 'Monthly rent (one month only) 🏠';
      case 'plan': return planType === 'daily'
        ? `For ${formatUGX(amount)} rent, how long does the tenant need to pay it back? ⏳`
        : planType === 'weekly' ? 'How many weeks should Welile cover? 📅' : 'When will the tenant pay it back? 📅';
      case 'tenantPhone': return 'What’s the tenant’s phone number? 📱';
      case 'tenantName': return `${mode === 'new' ? 'Lovely, the plan is set 👌 ' : ''}What’s the tenant’s full name, exactly as it’s written on their National ID? 🪪`;
      case 'nationalId': return `Thanks! Now the NIN from ${first}’s National ID card. It usually starts with CM or CF. 🔢`;
      case 'language': return `Which language does ${first} understand best? 🗣️ I’ll send their SMS messages in it.`;
      case 'smartphone': return `Does ${first} have a smartphone? 📲`;
      case 'familySize': return first === 'the tenant'
        ? 'How many people live in the tenant’s household, counting the tenant? 👨‍👩‍👧'
        : `How many people live in ${first}’s household, counting ${first}? 👨‍👩‍👧`;
      case 'work': return `What work or business does ${first} do? 💼`;
      case 'workLocation': return 'Where do they work? A market, town or area is fine. You can skip this one.';
      case 'landlord': return `${first === 'the tenant' ? 'The tenant' : first} is all set ✅ Now the house. Who’s the landlord? Search by name or phone, or register them if they’re new.`;
      case 'house': return `Which of ${landlordFirst}’s houses is it? 🏘️ Only houses with photos can be used.`;
      case 'location': return 'Where is the house? 📍 Pick the district, sub-county and village.';
      case 'address': return 'What’s the address? A plot number, road or landmark is fine. 🛣️';
      case 'category': return 'What kind of place is it? 🏠';
      case 'photos': return 'Photo time! 📸 Stand outside the house and take 4 photos: front, back, left and right.';
      case 'tenantPhoto': return `Now the tenant’s face photo (head and shoulders) of ${first}, please 🙂 I’ll check the face is clear.`;
      case 'idFront': return `Now a clear photo of the FRONT of ${first}’s National ID 🪪 All the writing must be readable.`;
      case 'idBack': return `And the BACK of ${first}’s National ID 🪪`;
      case 'gps': return 'While you’re standing at the house, capture its GPS location 🛰️';
      case 'lc1': return `Almost there! 🙌 Last person: the LC1 chairperson who knows ${first}. Search by their name or phone 🔎`;
      case 'lc1Phone': return 'Let’s add them 🤝 What’s the chairperson’s phone number?';
      case 'lc1Name': return 'And the chairperson’s name, please? 🙂';
      case 'lc1Village': return 'Which village is the LC1 for? 🏡';
      case 'city': return 'Which town or city is the house in? 🌆';
      case 'lcLetter': return 'Now a photo of the stamped LC1 letter 📄';
      case 'payoutDay': return `Which day of the month should Welile pay ${landlordFirst}? 🗓️ Most agents pick the day the rent falls due.`;
      case 'days': return 'How many days should the Rent Plan run? From 7 to 120 📅';
      case 'renewPlan': return `Renewing ${first}’s Rent Plan 🔁 Here’s how the last one went. Choose the new rent and days.`;
      case 'renewChanges': return `What changed since ${first}’s last plan? 🏠`;
      case 'note': return 'Last thing: tell the reviewer what you changed ✍️ At least 10 characters.';
      case 'review':
        if (mode === 'resubmit') {
          // The reviewer's reason is shown at the top of the form (E90).
          return 'Here’s the request with your changes. Tap any answer above to change it.';
        }
        if (mode === 'renewal') return `Last step: ${first} confirms with the code we text them, then the renewal posts.`;
        return 'All done, well done! 🎉 Here’s the request. Tap any answer above if you want to change it.';
    }
  };

  const answerOf = (s: StepId): string => {
    switch (s) {
      case 'type': return planType === 'daily' ? 'Daily income earner' : planType === 'weekly' ? 'Weekly earner' : 'Monthly earner';
      case 'rent': return formatUGX(amount);
      case 'plan': return planType === 'daily' ? `${duration} days` : planType === 'weekly' ? `${parseInt(repaymentPeriod, 10) / 7} week${repaymentPeriod === '7' ? '' : 's'}` : repaymentPeriod === '30' ? 'After 1 month' : 'Over 4 months';
      case 'tenantPhone': return tenantPhone;
      case 'tenantName': return tenantName;
      case 'nationalId': return nationalId || (hasTenantId(tenantOnFile) ? 'ID on file' : '');
      case 'language': return language;
      case 'smartphone': return noSmartphone ? 'No smartphone' : 'Has a smartphone';
      case 'familySize': return familySize ? `${familySize} ${familySize === '1' ? 'person' : 'people'}` : '';
      case 'work': return work;
      case 'workLocation': return workLocation || 'No work location';
      case 'landlord': return landlord?.name ?? '';
      case 'house': return house ? house.title : 'No listed house';
      case 'location': return location ? `${location.district} › ${location.subcounty} › ${location.village}` : '';
      case 'address': return address;
      case 'category': return HOUSE_CATEGORIES.find((c) => c.value === category)?.label ?? '';
      case 'photos': return housePhotos.every(Boolean)
        ? (housePhotos.some((p) => p?.file) ? '4 house photos taken' : 'House photos on file')
        : housePhotos.some(Boolean) ? `${housePhotos.filter(Boolean).length} of 4 house photos` : '';
      case 'tenantPhoto': return tenantPhoto?.file ? 'Face photo taken' : tenantPhoto ? 'Face photo on file' : '';
      case 'idFront': return idFront ? (idFront.file ? 'ID front photo taken' : 'On file ✓') : '';
      case 'idBack': return idBack ? (idBack.file ? 'ID back photo taken' : 'On file ✓') : '';
      case 'gps': return gps
        ? (gps.source === 'gps' ? `Location captured (${gps.lat.toFixed(5)}, ${gps.lng.toFixed(5)})` : gpsOnFile ? 'GPS on file' : 'GPS from the house listing')
        : '';
      case 'lc1': return lc1Mode === 'existing' ? lc1Name : lc1Mode === 'new' ? 'Register a new LC1' : '';
      case 'lc1Phone': return lc1Phone;
      case 'lc1Name': return lc1Name;
      case 'lc1Village': return lc1Village;
      case 'city': return city;
      case 'lcLetter': return lcLetter ? 'LC letter added' : lcOnFile ? 'On file ✓' : '';
      case 'payoutDay': return `The ${ordinal(payoutDay)}`;
      case 'days': return resubmitDays ? `${resubmitDays} days` : '';
      case 'renewPlan': return renewChoice ? `${formatUGX(renewChoice.newRent)} · ${renewChoice.newDays} days` : '';
      case 'renewChanges': return renewChange === 'same' ? 'Same house and landlord' : renewChange === 'moved' ? 'Moved house (same landlord)' : renewChange === 'landlord' ? 'New landlord' : '';
      case 'note': return note;
      case 'review': return '';
    }
  };

  const isTextStep = ['rent', 'days', 'tenantPhone', 'nationalId', 'familySize', 'work', 'workLocation', 'address', 'lc1Phone', 'lc1Village', 'city', 'note'].includes(current);

  const spokenReply = result
        ? `Sent to the Service Centre. ${sentLine}${mode === 'new' && !result.existing ? ` ${tenantNameParts.firstName} will get an SMS in ${language || 'English'} inviting them to join Welile.` : ''}${result.lcLetterFailed ? ' The LC letter didn’t upload. Add it later from My rent requests.' : ''}${result.intakeError ? ' Details not saved. Open Complete your requests on your home screen.' : ''}`
        : recordBlock && recordBlock.step === current
          ? `${recordHeadline(recordBlock, true)} ${recordBody(recordBlock)}`
          : error || questionOf(current);
  const speech = useAssistantSpeech(spokenReply, open && !showRegisterLandlord, user?.id);

  useEffect(() => {
    if (speech.failed) toast.error('Voice playback is unavailable. You can still read the assistant’s replies.');
  }, [speech.failed]);

  /** Step 8 of a new request: referral code, consent and Post (or what is still left). */
  const postArea = (
    <div className="mt-2 flex max-w-sm flex-col gap-3" data-testid="post-area">
      <label className="flex flex-col gap-1 text-sm">
        <span className="font-semibold">Landlord referral code <span className="font-normal text-muted-foreground">(optional)</span></span>
        <Input
          value={landlordCode}
          onChange={(e) => setLandlordCode(normalizeLandlordCode(e.target.value))}
          placeholder="e.g. L4K7Q2M9X"
          autoCapitalize="characters"
          autoComplete="off"
          spellCheck={false}
          aria-label="Landlord referral code"
          className="h-11 font-mono uppercase"
        />
      </label>
      <GuarantorConsentCheckbox checked={consent} onCheckedChange={(c) => { setConsent(c); setError(null); }} />
      {leftForPost ? (
        <button
          type="button"
          onClick={() => { if (tracking) blockedNow(t4FunnelItems(missing.map((m) => m.key))); if (firstLeft) jumpToSection(firstLeft); }}
          className="flex h-14 items-center justify-center rounded-2xl border-2 border-warning/50 bg-warning/10 px-3 text-center font-display text-base font-bold"
          data-testid="send-button"
          data-missing="yes"
        >
          {leftForPost}
        </button>
      ) : (
        <>
          {missing.filter((m) => m.key !== 'consent').length > 0 && <MissingChecklist items={missing.filter((m) => m.key !== 'consent')} onFix={fixItem} />}
          <div
            className="flex flex-col"
            onClick={() => { if (tracking && !posting && missing.length > 0) blockedNow(t4FunnelItems(missing.map((m) => m.key))); }}
            data-testid="send-button-wrap"
          >
            <button
              type="button"
              onClick={() => void post()}
              disabled={posting || sendProgress?.phase === 'sent' || missing.length > 0}
              aria-live="polite"
              className="flex h-14 items-center justify-center gap-2 rounded-2xl bg-primary font-display text-base font-bold text-primary-foreground shadow-lg disabled:pointer-events-none disabled:opacity-50"
              data-testid="send-button"
            >
              {sendProgress?.phase === 'sent'
                ? <>{sendButtonLabel(sendProgress, '')}</>
                : posting
                  ? <><Loader2 className="h-5 w-5 animate-spin" /> {sendButtonLabel(sendProgress, 'Sending…')}</>
                  : <><Send className="h-5 w-5" /> Post rent request</>}
            </button>
          </div>
          {!consent && <p className="text-xs text-muted-foreground">Tick the guarantor box to post.</p>}
        </>
      )}
      {showSaveDraft && saveDraftBlock}
    </div>
  );

  if (!open) return null;

  // ----- render -----
  // z-[115]: full-screen, so it must cover the bottom role bar (100), the assistant launcher/bubble (105/106) and the WhatsApp button (60).
  return (
    <div className={cn('rent-request-assistant fixed inset-0 z-[115] flex flex-col bg-background text-foreground', renewing && 'invisible')} role="dialog" aria-modal="true" aria-label="Rent request assistant" data-t4-mode={mode}>
      {camera && (
        <SelfieCameraCapture
          open
          onOpenChange={(o) => { if (!o) setCamera(null); }}
          onCapture={camera.onPick}
          onFallback={() => camera.input?.click()}
          facing={camera.facing}
          oval={camera.oval}
          title={camera.title}
          hint={camera.hint}
        />
      )}
      <header className="flex items-center gap-2.5 border-b border-border bg-card px-3 py-2.5 pt-safe">
        <button type="button" aria-label="Close" onClick={() => onOpenChange(false)} className="flex h-11 w-11 items-center justify-center rounded-full hover:bg-muted">
          <ArrowLeft className="h-5 w-5" />
        </button>
        <Avatar size="lg" />
        <div className="min-w-0 flex-1">
          <p className="font-display text-base font-bold leading-tight">{mode === 'resubmit' ? 'Resubmit Rent Request' : mode === 'renewal' ? 'Renew Rent Plan' : 'Post Rent Request'}</p>
          <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <span className="h-1.5 w-1.5 rounded-full bg-success" />
            {result ? 'Sent to the Service Centre' : mode === 'resubmit' ? 'Fixing a returned request with you' : mode === 'renewal' ? 'Renewing a Rent Plan with you' : 'Posting a Rent Plan with you'}
          </p>
        </div>
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button type="button" variant="ghost" size="icon" className="shrink-0 text-primary" disabled={!speech.supported} aria-label={speech.enabled ? 'Turn voice off' : 'Turn voice on'} aria-pressed={speech.enabled} onClick={speech.toggle}>
                {speech.enabled ? <Volume2 /> : <VolumeX />}
              </Button>
            </TooltipTrigger>
            <TooltipContent>{speech.supported ? (speech.enabled ? 'Turn voice off' : 'Turn voice on') : 'Voice unavailable on this browser'}</TooltipContent>
          </Tooltip>
          {speech.enabled && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button type="button" variant="ghost" size="icon" className="shrink-0 text-primary" aria-label={speech.speaking ? 'Stop speaking' : 'Replay reply'} onClick={speech.speaking ? speech.stop : speech.replay}>
                  {speech.speaking ? <Square /> : <RotateCcw />}
                </Button>
              </TooltipTrigger>
              <TooltipContent>{speech.speaking ? 'Stop speaking' : 'Replay reply'}</TooltipContent>
            </Tooltip>
          )}
        </TooltipProvider>
      </header>

      {showIntakeHeader && mode === 'renewal' && (
        <IntakeStepHeader
          steps={RENEWAL_STEP_DEFS}
          state={renewalState}
          current={RENEWAL_SECTION_OF[current] ?? 'code'}
          onJump={jumpRenewal}
        />
      )}
      {mode === 'resubmit' && !result && needs && (needs.desk || needs.deskNote) && (
        <p className="border-b border-border bg-warning/5 px-4 py-2 text-sm font-medium" data-testid="sent-back-by">
          {needs.desk ? `Sent back by ${needs.desk}` : 'Sent back'}{needs.deskNote ? `: ${needs.deskNote}` : ''}
        </p>
      )}
      {tapWhatYouFixed && !result && (
        <p className="border-b border-border bg-card px-4 py-2 text-sm font-semibold" data-testid="intake-counter">Tap what you fixed</p>
      )}
      {showIntakeHeader && mode !== 'renewal' && (
        <IntakeStepHeader
          state={intakeState}
          current={SECTION_OF[current]}
          onJump={jumpToSection}
          toFix={toFix}
          only={onlySections}
          items={mode === 'resubmit' && returnSteps
            ? returnSteps.map((st) => ({
              label: needs?.items.find((i) => RETURN_STEP[i.code] === st)?.label ?? RETURN_LABEL[st] ?? st,
              done: fixedSteps.includes(st),
            }))
            : undefined}
        />
      )}
      {needsWho ? (
        <div className="flex-1 overflow-y-auto">
          <WhoIsPosting
            onMe={() => { onOpenChange(false); window.location.assign('/tenants-onboarding'); }}
            onAgent={() => setBecameAgent(true)}
          />
        </div>
      ) : (
      <div ref={scrollRef} className="rent-request-canvas flex-1 overflow-y-auto px-4 py-4">
        <div className="mx-auto flex max-w-xl flex-col gap-3.5">
          {/* The greeting is one small line above the first question. */}
          <p className="px-1 pt-1 text-sm text-muted-foreground" data-testid="greeting">
            {greeting.text}, {metaOf(user).full_name?.split(' ')[0] || 'Agent'} {greeting.emoji}
            {mode === 'resubmit' ? ' · Let’s fix this request and send it back.' : mode === 'renewal' ? ' · Let’s renew this Rent Plan.' : ''}
          </p>

          {mode === 'resubmit' && !result && !needs && (!!rejected?.rejected_reason || (sideMissing?.length ?? 0) > 0) && (
            <div className="rounded-2xl border border-warning/40 bg-warning/5 p-3 text-sm" data-testid="resubmit-reason">
              {rejected?.rejected_reason && (
                <>
                  <p className="font-semibold">Why it came back</p>
                  <p className="mt-1 whitespace-pre-wrap">{rejected.rejected_reason}</p>
                </>
              )}
              {sideMissing && sideMissing.length > 0 && (
                <div className={rejected?.rejected_reason ? 'mt-3' : ''} data-testid="resubmit-side-missing">
                  <p className="font-semibold">Add before sending it again</p>
                  <ul className="mt-1 flex flex-col gap-1">
                    {sideMissing.map((line) => {
                      const target = sideMissingSteps(line).find((x) => steps.includes(x));
                      return (
                        <li key={line}>
                          {target ? (
                            <button type="button" className="min-h-11 text-left text-primary underline underline-offset-4" onClick={() => { hapticTap(); setCurrent(target); }}>{line}</button>
                          ) : line}
                        </li>
                      );
                    })}
                  </ul>
                </div>
              )}
            </div>
          )}

          {gateBlocked ? (
            <Bot>
              <Bubble tone="warn">
                <span data-testid="vetting-blocked">
                  <b>Complete your agent verification to post rent requests.</b>{' '}
                  {gate?.reason ?? ''}{' '}
                  <a href={AGENT_VERIFICATION_PATH} className="font-semibold underline underline-offset-4">Go to verification</a>
                </span>
              </Bubble>
            </Bot>
          ) : (
            <>
              {vettingNotice && !result && (
                <div className="flex items-start gap-2 rounded-xl border border-primary/20 bg-primary/5 px-3 py-2 text-sm" role="note" data-testid="vetting-notice">
                  <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-primary" aria-hidden />
                  <span>{vettingNotice} <a href={AGENT_VERIFICATION_PATH} className="font-semibold text-primary underline underline-offset-4">Complete verification</a></span>
                </div>
              )}
              {collection && (
                <Bot><Bubble>
                  {typeof collection.pct === 'number' && <span data-testid="collection-info">{collectionInfoLine(collection.pct)}</span>}
                  {collection.reason && <span className="mt-1 block" data-testid="collection-reason">{collection.reason}</span>}
                </Bubble></Bot>
              )}

              {mode === 'resubmit' && !result && !returnSteps && (
                <ResubmitSummary
                  rows={[
                    { label: 'Monthly rent', value: formatUGX(amount), step: 'rent' },
                    { label: 'Days', value: answerOf('days') || 'Missing', step: 'days' },
                    { label: 'Tenant’s name', value: tenantName || 'Missing', step: 'tenantName' },
                    { label: 'Tenant’s phone', value: tenantPhone || 'Missing', step: 'tenantPhone' },
                    { label: 'NIN', value: answerOf('nationalId') || 'Missing', step: 'nationalId' },
                    { label: 'Language', value: language || 'Missing', step: 'language' },
                    { label: 'Smartphone', value: noSmartphone === null ? 'Missing' : answerOf('smartphone'), step: 'smartphone' },
                    { label: TENANT_FACE_PHOTO, value: tenantPhoto ? (tenantPhoto.file ? 'New photo taken' : 'On file ✓') : 'Missing', step: 'tenantPhoto', preview: tenantPhoto?.preview ?? null },
                    { label: 'Landlord', value: landlord?.name || 'Missing', step: 'landlord' },
                    { label: 'House', value: answerOf('category') || 'Missing', step: 'category' },
                    { label: 'House photos', value: answerOf('photos') || 'Missing', step: 'photos' },
                    { label: 'House GPS', value: gps ? (gps.accuracy ? 'Captured' : 'On file') : 'Missing', step: 'gps' },
                    { label: 'ID front photo', ...docRowValue(docRow('id_front')), step: 'idFront' },
                    { label: 'ID back photo', ...docRowValue(docRow('id_back')), step: 'idBack' },
                    { label: 'LC1 letter', ...docRowValue(docRow('lc1_letter')), step: 'lcLetter' },
                    ...(rejected?.registration_type !== 'renewal' ? [
                      { label: 'Household', value: answerOf('familySize') || 'Missing', step: 'familySize' as StepId },
                      { label: 'Work', value: work ? `${work}${workLocation ? ` · ${workLocation}` : ''}` : 'Missing', step: 'work' as StepId },
                    ] : []),
                    { label: 'Note for the reviewer', value: note || 'Missing', step: 'note' },
                  ]}
                  current={current}
                  onRedo={redo}
                />
              )}
              {mode !== 'resubmit' && steps.slice(0, idx).map((s) => (
                <div key={s} className="flex flex-col gap-3.5">
                  <Bot><Bubble>{questionOf(s)}</Bubble></Bot>
                  {answerOf(s) && (
                    <button type="button" onClick={() => !result && !posting && setCurrent(s)} className="self-end" aria-label={`Change answer: ${answerOf(s)}`}>
                      <MeBubble>{answerOf(s)}</MeBubble>
                    </button>
                  )}
                  {s === 'plan' && fees && <PlanSummary planType={planType!} fees={fees} amount={amount} />}
                  {s === 'landlord' && landlord && <LandlordStatusNote status={landlordStatus} agreement={agreementOnFile} verifyReq={verifyReq} onRequest={requestLandlordVerification} name={landlord.name} />}
                  {s === 'lc1' && lc1Mode === 'existing' && lc1Match && (
                    <Bot><Bubble><b>{lc1Match.name}</b>, LC1 for {lc1Match.village || 'their village'}{lc1Match.verified ? ' · verified ✅' : ' · not verified yet'}. I’ll send them a verification SMS 📩</Bubble></Bot>
                  )}
                  {s === 'lc1Phone' && lc1Match && (
                    <Bot><Bubble><b>{lc1Match.name}</b>, LC1 for {lc1Match.village || 'their village'}{lc1Match.verified ? ' · verified' : ' · not verified yet'}. I’ll send them a verification SMS.</Bubble></Bot>
                  )}
                </div>
              ))}

              {!result && (
                <div className="flex flex-col gap-3">
                  <Bot><Bubble>{questionOf(current)}</Bubble></Bot>
                  <div className="pl-9">{renderWidget()}</div>
                  {/* Step 8: consent and Post (or what is still left) on the same screen; no review step. */}
                  {mode === 'new' && SECTION_OF[current] === 'lc1_post' && <div className="pl-9">{postArea}</div>}
                  {recordChecking && <Bot><Bubble><Loader2 className="mr-1 inline h-4 w-4 animate-spin" /> Checking Welile’s records…</Bubble></Bot>}
                  {recordBlock && recordBlock.step === current && (
                    <RecordExistsNotice block={recordBlock} onRetry={() => { setDraft(''); setRecordBlock(null); }} />
                  )}
                  {tenantCheck && current === 'tenantPhone' && (
                    <TenantCheckNotice
                      check={tenantCheck}
                      onOpenMine={(id) => { onOpenChange(false); window.dispatchEvent(new CustomEvent('open-submissions', { detail: { tab: 'submitted', recordId: id } })); }}
                    />
                  )}
                  {error && (
                    <Bot>
                      <Bubble tone="warn"><span className="whitespace-pre-line">{error}</span></Bubble>
                      {fixOffer && (
                        <div className="flex flex-wrap gap-2">
                          <Chip onClick={() => { setDraft(fixOffer); void submitText(fixOffer); }}>Yes, use {fixOffer}</Chip>
                          <Chip onClick={() => { setError(null); setFixOffer(null); }}>No, I’ll retype it</Chip>
                        </div>
                      )}
                    </Bot>
                  )}
                </div>
              )}

              {result && (
                <>
                  <Bot>
                    <Bubble>
                      <span className="mb-1.5 inline-flex items-center gap-1 rounded-full bg-success/15 px-2 py-0.5 text-xs font-semibold text-success"><Check className="h-3 w-3" /> Sent to the Service Centre</span>
                      <br />
                      {sentLine}
                      {mode === 'new' && !result.existing && ` ${tenantNameParts.firstName} will get an SMS in ${language || 'English'} inviting them to join Welile.`}
                    </Bubble>
                  </Bot>
                  {vettingNotice && (
                    <div className="flex items-start gap-2 rounded-xl border border-primary/20 bg-primary/5 px-3 py-2 text-sm" role="note" data-testid="vetting-notice">
                  <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-primary" aria-hidden />
                  <span>{vettingNotice} <a href={AGENT_VERIFICATION_PATH} className="font-semibold text-primary underline underline-offset-4">Complete verification</a></span>
                </div>
                  )}
                  {result.lcLetterFailed && <Bot><Bubble tone="warn">The LC letter didn’t upload. Add it later from My rent requests.</Bubble></Bot>}
                  {mode === 'renewal' && renewRetry && renewRetry.failed.length > 0 && (
                    <Bot>
                      <Bubble tone="warn">
                        <span data-testid="renewal-doc-retry">
                          Renewal posted. {renewRetry.failed.length} document{renewRetry.failed.length === 1 ? '' : 's'} didn’t upload — tap to retry.
                        </span>
                        {renewRetry.failed.map((f) => <span key={f.kind} className="mt-1 block text-sm">{f.message}</span>)}
                        <button type="button" onClick={() => void retryRenewalDocs()} disabled={retryingDocs}
                          className="mt-2 flex min-h-11 items-center gap-1.5 font-semibold text-primary underline underline-offset-4 disabled:opacity-60">
                          {retryingDocs && <Loader2 className="h-4 w-4 animate-spin" />} Retry upload
                        </button>
                      </Bubble>
                    </Bot>
                  )}
                  {result.docErrors.map((e) => (
                    <Bot key={e}><Bubble tone="warn"><b>Not saved:</b> {e}</Bubble></Bot>
                  ))}
                  {result.lc1NoteError && (
                    <Bot><Bubble tone="warn"><b>LC1 reason not saved:</b> {result.lc1NoteError}</Bubble></Bot>
                  )}
                  {result.lc1AttachError && (
                    <Bot><Bubble tone="warn"><b>LC1 letter not saved:</b> {result.lc1AttachError}</Bubble></Bot>
                  )}
                  {result.referralError && (
                    <Bot><Bubble tone="warn"><span data-testid="landlord-referral-note"><b>Landlord referral code {landlordCode}:</b> {result.referralError}. The request was still sent.</span></Bubble></Bot>
                  )}
                  {result.intakeError && (
                    <Bot>
                      <Bubble tone="warn">
                        <b>Details not saved — open Complete your requests</b> on your home screen.
                        <span className="mt-1 block text-sm text-muted-foreground">{result.intakeError}</span>
                      </Bubble>
                    </Bot>
                  )}
                  <div className="flex flex-wrap gap-2 pl-9">
                    {mode === 'new' && <Chip onClick={reset}>Post another</Chip>}
                    <Chip onClick={() => onOpenChange(false)}>{mode === 'new' ? 'Back to dashboard' : 'Done'}</Chip>
                  </div>
                </>
              )}
            </>
          )}
        </div>
      </div>

      )}

      {!result && !gateBlocked && !needsWho && current !== 'review' && !(mode === 'new' && current === LAST_NEW_STEP) && (
        <footer className="border-t border-border bg-card px-3 pb-safe pt-2.5">
          {/* Save and finish later, on every step (E124). */}
          {showSaveDraft && <div className="mx-auto max-w-xl pb-2">{saveDraftBlock}</div>}
          <div className="mx-auto flex max-w-xl items-center gap-2 pb-3">
            {isTextStep ? (
              <form
                className="flex flex-1 items-center gap-2"
                onSubmit={(e) => { e.preventDefault(); void submitText(); }}
              >
                <input
                  aria-label="Your answer"
                  autoFocus
                  inputMode={['rent', 'days', 'tenantPhone', 'lc1Phone', 'familySize'].includes(current) ? 'numeric' : 'text'}
                  value={draft}
                  onChange={(e) => {
                    const v = e.target.value;
                    if (current === 'rent') setDraft(groupDigits(v));
                    else if (current === 'tenantPhone' || current === 'lc1Phone') setDraft(formatPhone(v));
                    else if (current === 'nationalId') setDraft(v.replace(/[^a-zA-Z0-9]/g, '').toUpperCase().slice(0, 14));
                    else if (current === 'familySize') setDraft(v.replace(/\D/g, '').slice(0, 2));
                    else if (current === 'days') setDraft(v.replace(/\D/g, '').slice(0, 3));
                    else setDraft(v);
                    setError(null);
                    setFixOffer(null);
                    setRecordBlock(null);
                    setTenantCheck(null);
                  }}
                  placeholder={placeholderOf(current)}
                  className="h-11 min-w-0 flex-1 rounded-full border border-border bg-background px-4 text-base outline-none focus:border-primary"
                />
                <button type="submit" aria-label="Send" disabled={lc1Looking || recordChecking} className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-success text-success-foreground hover:bg-success/90 disabled:opacity-60">
                  {lc1Looking || recordChecking ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
                </button>
              </form>
            ) : (
              <button
                type="button"
                onClick={continueStep}
                className="h-11 flex-1 rounded-full bg-primary font-semibold text-primary-foreground active:scale-[0.99] hover:bg-primary/90"
              >
                Continue
              </button>
            )}
          </div>
        </footer>
      )}

      {renewalFlow.dialogs}
      <RegisterLandlordDialog
        open={showRegisterLandlord}
        onOpenChange={setShowRegisterLandlord}
        onSuccess={(l) => {
          setShowRegisterLandlord(false);
          if (l) setLandlord({ id: l.id, name: l.name, phone: l.phone, property_address: l.property_address });
        }}
      />
    </div>
  );

  function renderWidget(): ReactNode {
    switch (current) {
      case 'rent':
        return <p className="text-sm text-muted-foreground">{RENT_HELPER}</p>;
      case 'type':
        return (
          <div className="flex flex-col gap-2">
            {([
              ['daily', 'Daily income earner', 'Pays back every day over 30, 60 or 90 days'],
              ['weekly', 'Weekly earner', 'Pays once a week'],
              ['monthly', 'Monthly earner', 'Pays after 1 month, or over 4 months'],
            ] as const).map(([v, title, sub]) => (
              <button
                key={v}
                type="button"
                onClick={() => {
                  hapticTap();
                  setPlanType(v);
                  if (v === 'daily') setDuration('30');
                  else setRepaymentPeriod(v === 'weekly' ? '7' : '30');
                  advance('type');
                }}
                className={cn('flex min-h-16 items-center gap-3 rounded-2xl border bg-card p-3 text-left', planType === v ? 'border-primary' : 'border-border')}
              >
                <span className="flex-1">
                  <span className="block font-display text-[15px] font-bold">{title}</span>
                  <span className="block text-xs text-muted-foreground">{sub}</span>
                </span>
              </button>
            ))}
          </div>
        );
      case 'plan': {
        const options: [string, string][] = planType === 'daily'
          ? [['30', '30 days'], ['60', '60 days'], ['90', '90 days']]
          : planType === 'weekly'
            ? [['7', '1 week'], ['14', '2 weeks'], ['21', '3 weeks']]
            : [['30', 'After 1 month'], ['120', 'Over 4 months']];
        const selected = planType === 'daily' ? duration : repaymentPeriod;
        return (
          <div className="flex flex-col gap-2.5">
            <div className="flex flex-wrap gap-2">
              {options.map(([v, label]) => (
                <Chip key={v} on={selected === v} onClick={() => (planType === 'daily' ? setDuration(v as '30' | '60' | '90') : setRepaymentPeriod(v))}>{label}</Chip>
              ))}
            </div>
            {fees && <PlanSummary planType={planType!} fees={fees} amount={amount} />}
          </div>
        );
      }
      case 'tenantName':
        return (
          <NameFields value={tenantNameParts} onChange={setTenantNameParts} />
        );
      case 'renewPlan': {
        const suggested = Number(renewalAdvice.data?.suggested_max_rent);
        return (
          <div className="flex max-w-sm flex-col gap-2.5" data-testid="renew-plan">
            {renewal?.tenantAsked && <span className="self-start rounded-full bg-primary/10 px-2.5 py-0.5 text-xs font-semibold text-primary">Tenant asked to renew</span>}
            <div className="rounded-2xl border border-border bg-card p-3 text-sm">
              <Row k="Last Rent Plan" v={`${formatUGX(renewal?.currentRent ?? 0)} · ${renewal?.currentDays ?? ''} days`} />
              <Row k="Result" v="Completed ✓" />
              {Number.isFinite(suggested) && suggested > 0 && <Row k="Suggested up to" v={formatUGX(suggested)} />}
            </div>
            {renewChoice && (
              <div className="rounded-2xl border border-primary/30 bg-primary/5 p-3 text-sm" data-testid="renew-choice">
                <Row k="New rent" v={formatUGX(renewChoice.newRent)} />
                <Row k="Days" v={`${renewChoice.newDays} days`} />
                {renewChoice.changed && <Row k="Reason" v={renewChoice.explanation || renewChoice.reasonCode || 'Given'} />}
              </div>
            )}
            <Chip on={!!renewChoice} onClick={() => void chooseRenewal()}>{renewChoice ? 'Change the rent or days' : 'Choose the new rent and days'}</Chip>
            {renewingOthersTenant && <p className="text-sm font-medium" data-testid="renew-other-agent">Agent Ops will confirm you as this tenant’s agent.</p>}
          </div>
        );
      }
      case 'renewChanges':
        return (
          <div className="flex max-w-sm flex-col gap-2.5" data-testid="renew-changes">
            <div className="flex flex-wrap gap-2">
              <Chip on={renewChange === 'same'} onClick={() => { setRenewChange('same'); setError(null); advance('renewChanges'); }}>Same house and landlord</Chip>
              <Chip on={renewChange === 'moved'} onClick={() => {
                // Moved (same landlord): new house photos and the GPS of the new house.
                setRenewChange('moved'); setError(null);
                setGps(null); setGpsOnFile(false); setHousePhotos([null, null, null, null]);
                setRenewalExtra((x) => Array.from(new Set([...(x ?? []), 'photos', 'gps'])) as StepId[]);
                setCurrent('photos');
              }}>Moved house (same landlord)</Chip>
              <Chip on={renewChange === 'landlord'} onClick={() => { setRenewChange('landlord'); setError(null); }}>New landlord</Chip>
            </div>
            {renewChange === 'same' && <p className="text-sm text-muted-foreground">Nothing to redo.</p>}
            {renewChange === 'landlord' && (
              <div className="flex flex-col gap-2 rounded-xl border border-border bg-card p-3 text-sm">
                <p>A new landlord means a new Rent Plan request: Agent Ops checks the new landlord.</p>
                <button type="button" className="min-h-11 self-start rounded-full bg-primary px-4 font-semibold text-primary-foreground"
                  onClick={() => openT4RentRequest({
                    mode: 'new', entry: 'renewal-new-landlord',
                    prefill: { tenantId: renewal?.tenantId ?? undefined, tenantName, tenantPhone, rentAmount: renewChoice?.newRent ?? renewal?.currentRent ?? null },
                  })}>
                  Post a new request for {tenantNameParts.firstName || 'the tenant'}
                </button>
              </div>
            )}
          </div>
        );
      case 'language':
        return (
          <div className="flex flex-wrap gap-2">
            {LANGUAGES.map((l) => <Chip key={l} on={language === l} onClick={() => { setLanguage(l); advance('language'); }}>{l}</Chip>)}
          </div>
        );
      case 'smartphone':
        return (
          <div className="flex flex-wrap gap-2">
            <Chip on={noSmartphone === false} onClick={() => { setNoSmartphone(false); advance('smartphone'); }}>Yes, a smartphone</Chip>
            <Chip on={noSmartphone === true} onClick={() => { setNoSmartphone(true); advance('smartphone'); }}>No smartphone</Chip>
          </div>
        );
      case 'lc1':
        return (
          <Lc1SearchStep
            selectedId={lc1Mode === 'existing' ? lc1Match?.id ?? null : null}
            nearDistrict={location?.district || district || null}
            nearVillage={location?.village || null}
            onPick={pickLc1}
            onNew={startNewLc1}
          />
        );
      case 'landlord':
        return (
          <div className="flex flex-col gap-2 rounded-2xl border border-border bg-card p-2">
            <LandlordSearchSelect value={landlord} inline registeredBy={null} onChange={(l) => { setLandlord(l); setError(null); }} onAddNew={() => setShowRegisterLandlord(true)} />
            {landlord && <LandlordStatusNote status={landlordStatus} agreement={agreementOnFile} verifyReq={verifyReq} onRequest={requestLandlordVerification} name={landlord.name} />}
            {/* The search only offers "register" when nothing matches; keep it in reach when a similar name shows up. */}
            <button
              type="button"
              onClick={() => { hapticTap(); setShowRegisterLandlord(true); }}
              className="inline-flex min-h-9 items-center gap-1.5 self-start rounded-full border border-primary/30 bg-card px-3.5 text-sm font-semibold text-primary"
            >
              <UserPlus className="h-4 w-4" /> Register a new landlord
            </button>
          </div>
        );
      case 'house':
        if (houses === null) return <p className="text-sm text-muted-foreground"><Loader2 className="mr-1 inline h-4 w-4 animate-spin" /> Looking up houses…</p>;
        return (
          <div className="flex flex-col gap-2">
            {houses.length === 0 && <p className="text-sm text-muted-foreground">No available houses are listed for this landlord.</p>}
            {houses.map((h) => {
              const usable = listingHasRealPhoto(h);
              return (
                <button
                  key={h.id}
                  type="button"
                  disabled={!usable}
                  onClick={() => pickHouse(h)}
                  className={cn('flex items-center gap-3 rounded-xl border bg-card p-2.5 text-left disabled:opacity-60', house?.id === h.id ? 'border-2 border-primary' : 'border-border')}
                >
                  {usable
                    ? <img src={h.image_urls[0]} alt="" className="h-11 w-11 shrink-0 rounded-lg object-cover" />
                    : <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg bg-muted"><Camera className="h-4 w-4 text-muted-foreground" /></span>}
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-bold">{h.title}</span>
                    <span className="block text-xs text-muted-foreground">
                      {usable ? `${h.image_urls.length} photo${h.image_urls.length === 1 ? '' : 's'}${h.monthly_rent ? ` · ${formatUGX(h.monthly_rent)}` : ''}` : 'No photos · can’t be used yet'}
                    </span>
                  </span>
                </button>
              );
            })}
            <Chip onClick={() => pickHouse(null)}>The house isn’t listed</Chip>
          </div>
        );
      case 'location':
        return (
          <div className="rounded-2xl border border-border bg-card p-3">
            <UgLocationPicker
              value={location}
              onChange={(sel) => {
                setLocation(sel);
                if (sel) {
                  if (!address) setAddress(sel.village);
                  setCity(sel.subcounty || sel.county);
                  setDistrict(normalizeDistrict(sel.district) || sel.district);
                  setLc1Village((v) => v || sel.village);
                }
              }}
            />
            <button type="button" onClick={() => advance('location')} className="mt-2 text-sm font-semibold text-primary">Skip, I’ll type the address</button>
          </div>
        );
      case 'category':
        return (
          <div className="flex flex-wrap gap-2">
            {HOUSE_CATEGORIES.map((c) => <Chip key={c.value} on={category === c.value} onClick={() => { setCategory(c.value); advance('category'); }}>{c.label}</Chip>)}
          </div>
        );
      case 'photos':
        return (
          <div className="grid max-w-xs grid-cols-2 gap-2">
            {PHOTO_SLOTS.map((label, i) => (
              <label key={label} className={cn('relative flex h-24 cursor-pointer flex-col items-center justify-center gap-1 overflow-hidden rounded-xl text-xs font-semibold', housePhotos[i] ? '' : 'border-2 border-dashed border-primary/40 bg-primary/5 text-primary')}
                onClick={(e) => openCamera(e, { title: `House: ${label}`, hint: 'Show the house clearly in good light.', facing: 'environment', oval: false, onPick: (f) => { void onHousePhoto(i, f); } })}>
                {housePhotos[i] ? (
                  <>
                    <img src={housePhotos[i]!.preview} alt={`${label} of the house`} className="absolute inset-0 h-full w-full object-cover" />
                    <span className="absolute inset-x-0 bottom-0 flex items-center gap-1 bg-gradient-to-t from-black/70 to-transparent px-2 py-1 text-white"><Check className="h-3 w-3" />{label}</span>
                  </>
                ) : (<><Camera className="h-5 w-5" />{label}</>)}
                <input type="file" accept="image/*" capture="environment" className="sr-only" onChange={(e) => { void onHousePhoto(i, e.target.files?.[0]); e.target.value = ''; }} />
              </label>
            ))}
          </div>
        );
      case 'tenantPhoto':
        return (
          <div className="flex items-center gap-3">
            <label
              className={cn('relative flex h-24 w-20 cursor-pointer items-center justify-center overflow-hidden rounded-xl', tenantPhoto ? '' : 'border-2 border-dashed border-primary/40 bg-primary/5 text-primary')}
              onClick={(e) => openCamera(e, { title: TENANT_FACE_PHOTO, hint: "Head and shoulders: point the camera at the tenant's face in good light, no hat.", facing: 'environment', oval: true, onPick: (f) => { void onTenantPhoto(f); } })}
            >
              {tenantPhoto ? <img src={tenantPhoto.preview} alt={TENANT_FACE_PHOTO} className="h-full w-full object-cover" /> : <ImagePlus className="h-6 w-6" />}
              <input type="file" accept="image/*" capture="environment" aria-label={TENANT_FACE_PHOTO} className="sr-only" onChange={(e) => { void onTenantPhoto(e.target.files?.[0]); e.target.value = ''; }} />
            </label>
            <p className="text-sm text-muted-foreground" data-testid="face-check-status">
              {!tenantPhoto ? 'Tap to take the photo: head and shoulders.'
                : !tenantPhoto.file ? 'On file ✓ Tap the photo to retake it.'
                : faceCheck?.status === 'checking' ? 'Checking the face…'
                : faceCheck?.status === 'no_face' ? 'No face found. You can retake it, or continue; the office will check it.'
                : faceCheck?.status === 'skipped_timeout' ? FACE_CHECK_SLOW_MESSAGE
                : faceCheck?.status === 'unavailable' ? 'Couldn’t check the face just now. You can continue; the office will check it.'
                : 'Face found. Looks good.'}
            </p>
          </div>
        );
      case 'idFront':
      case 'idBack': {
        const side = current === 'idFront' ? 'front' : 'back';
        const slot = current === 'idFront' ? idFront : idBack;
        const set = current === 'idFront' ? setIdFront : setIdBack;
        return (
          <div className="flex items-center gap-3">
            <label className={cn('relative flex h-20 w-32 cursor-pointer items-center justify-center overflow-hidden rounded-xl', slot?.file ? '' : 'border-2 border-dashed border-primary/40 bg-primary/5 text-primary')}
              onClick={(e) => openCamera(e, { title: `National ID ${side}`, hint: 'Fill the frame with the card; all text readable.', facing: 'environment', oval: false, onPick: (f) => { void readPhoto(f).then((p) => { if (p) { set(p); setError(null); } }); } })}>
              {slot?.file ? <img src={slot.preview} alt={`National ID ${side}`} className="h-full w-full object-cover" /> : <ImagePlus className="h-6 w-6" />}
              <input type="file" accept="image/*" capture="environment" aria-label={`National ID ${side} photo`} className="sr-only"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  e.target.value = '';
                  if (!f) return;
                  void readPhoto(f).then((p) => { if (p) { set(p); setError(null); } });
                }} />
            </label>
            <p className="text-sm text-muted-foreground">
              {!slot ? 'Tap to take the photo.' : slot.file ? 'Photo taken. Tap it to retake.' : 'On file. Tap to replace it.'}
            </p>
          </div>
        );
      }
      case 'gps':
        return (
          <div className="flex flex-wrap items-center gap-2">
            <GpsCapturePanel gps={gpsWatch} value={gps?.source === 'gps' ? gps : null} className="basis-full" />
            {gps && !gps.source && gps.accuracy === 0 && <span className="text-sm text-muted-foreground">{gpsOnFile ? 'GPS on file' : 'From the house listing'}</span>}
          </div>
        );
      case 'lc1Name':
        return <NameFields value={lc1NameParts} onChange={setLc1NameParts} />;
      case 'workLocation':
        return <Chip onClick={() => { setWorkLocation(''); setDraft(''); setError(null); advance('workLocation'); }}>Skip</Chip>;
      case 'lcLetter':
        return (
          <div className="flex max-w-xs flex-col gap-2.5" data-testid="lc1-letter-step">
            {lcLetter && (
              <img src={lcLetter.preview} alt="LC1 letter" className="h-32 w-full rounded-xl border border-border object-cover" />
            )}
            <label
              className="flex min-h-14 cursor-pointer items-center justify-center gap-2 rounded-2xl bg-primary px-4 text-base font-semibold text-primary-foreground"
              onClick={(e) => openCamera(e, { title: 'LC1 letter', hint: 'Fill the frame with the stamped letter; all the writing readable.', facing: 'environment', oval: false, onPick: (f) => { void onLcLetter(f); } })}
            >
              <Camera className="h-5 w-5" aria-hidden /> {lcLetter ? 'Retake' : 'Take photo of LC1 letter'}
              <input type="file" accept="image/*" capture="environment" aria-label="Take photo of LC1 letter" className="sr-only"
                onChange={(e) => { void onLcLetter(e.target.files?.[0]); e.target.value = ''; }} />
            </label>
            <label className="inline-flex min-h-11 cursor-pointer items-center justify-center gap-1.5 rounded-full border border-primary/30 bg-card px-3.5 text-sm font-semibold text-primary">
              <ImagePlus className="h-4 w-4" aria-hidden /> Choose from gallery
              <input type="file" accept="image/*" aria-label="LC1 letter photo" className="sr-only" onChange={(e) => { void onLcLetter(e.target.files?.[0]); e.target.value = ''; }} />
            </label>
            {!lcLetter && !lcOnFile && (
              <p className="text-sm text-muted-foreground" data-testid="lc1-no-letter-yet">
                {mode === 'new'
                  ? 'No letter yet? Tap “Save and finish later” — we remind you at 8 am.'
                  : mode === 'resubmit'
                    ? 'No letter yet? Come back when you have it; the request waits in To fix.'
                    : 'No letter yet? Come back when you have it.'}
              </p>
            )}
          </div>
        );
      case 'payoutDay':
        return (
          <div className="flex flex-col gap-2">
            <div className="flex flex-wrap gap-2">
              {PAYOUT_DAYS.map((d) => <Chip key={d} on={payoutDay === d} onClick={() => { setPayoutDay(d); advance('payoutDay'); }}>{ordinal(d)}</Chip>)}
            </div>
            <p className="text-xs text-muted-foreground">Any day from the 1st to the 28th.</p>
          </div>
        );
      case 'review':
        return (
          <div className="flex flex-col gap-3">
            {mode !== 'resubmit' && (
            <div className="rounded-2xl border border-border bg-card p-3 text-sm">
              {mode === 'renewal' ? (
                <>
                  <Row k="Rent Plan now" v={`${formatUGX(renewal?.currentRent ?? 0)} · ${renewal?.currentDays ?? ''} days`} />
                  <Row k="Tenant" v={`${tenantName}${tenantPhone ? ` · ${tenantPhone}` : ''}`} />
                  {renewal?.landlordName && <Row k="Landlord" v={renewal.landlordName} />}
                  {renewal?.houseLabel && <Row k="House" v={renewal.houseLabel} />}
                  <Row k="House photos" v={answerOf('photos') || 'Missing'} />
                  <Row k="House GPS" v={gps ? 'On file' : 'Missing'} />
                  <DocRow k="ID front photo" {...docRow('id_front')} />
                  <DocRow k="ID back photo" {...docRow('id_back')} />
                  <DocRow k="LC1 letter" {...docRow('lc1_letter')} />
                </>
              ) : (
              <>
              <Row k="Rent Plan" v={`${formatUGX(amount)} · ${answerOf('plan')}`} />
              <Row k="Tenant" v={`${tenantName} · ${tenantPhone}`} />
              <Row k="Landlord" v={`${landlord?.name ?? ''}${landlordStatus === 'unverified' ? ' (verification pending)' : ''}`} />
              <Row k="House" v={`${answerOf('category')} · ${address}`} />
              <Row k="LC1" v={`${lc1Name} · ${lc1Village}`} />
              <Row k="ID photos" v={idFront && idBack ? 'Front and back taken' : 'Missing'} />
              <Row k="LC1 letter" v={answerOf('lcLetter') || 'Missing'} />
              <Row k="Household" v={answerOf('familySize')} />
              <Row k="Work" v={`${work}${workLocation ? ` · ${workLocation}` : ''}`} />
              <Row k={TENANT_FACE_PHOTO} v={tenantPhoto ? 'Taken' : 'Missing'} />
              <Row k="Landlord paid on" v={`The ${ordinal(payoutDay)}`} />
              {landlordCode && <Row k="Landlord referral code" v={landlordCode} />}
              </>
              )}
            </div>
            )}
            {mode === 'resubmit' && returnSteps && (
              <div className="flex items-start justify-between gap-3 rounded-2xl border border-border bg-card p-3 text-sm" data-testid="resubmit-note">
                <span><span className="text-muted-foreground">Note for the reviewer: </span>{note || '—'}</span>
                <button type="button" onClick={() => fixItem('note')} className="min-h-11 shrink-0 font-semibold text-primary underline underline-offset-4">Edit</button>
              </div>
            )}
            {mode === 'renewal' && (
              <p className="text-sm text-muted-foreground">
                {renewChoice ? `New: ${formatUGX(renewChoice.newRent)} for ${renewChoice.newDays} days. ` : ''}
                {tenantNameParts.firstName || 'The tenant'} confirms with the code we text them, then it posts.
              </p>
            )}
            {renewingOthersTenant && <p className="text-sm font-medium" data-testid="renew-other-agent">Agent Ops will confirm you as this tenant’s agent.</p>}
            {mode === 'renewal' && renewOtpProblem && (
              <div className="flex flex-col gap-2 rounded-xl border border-warning/40 bg-warning/5 p-3 text-sm" role="alert" data-testid="renewal-otp-problem">
                <p className="font-medium">{renewOtpProblem}</p>
                <button type="button" onClick={() => { setRenewOtpProblem(null); void postRenewalPlan(); }}
                  className="min-h-11 self-start rounded-full bg-primary px-4 font-semibold text-primary-foreground">
                  Send a new code
                </button>
              </div>
            )}
            {mode === 'new' && (
              <label className="flex flex-col gap-1 text-sm">
                <span className="font-semibold">Landlord referral code <span className="font-normal text-muted-foreground">(optional)</span></span>
                <Input
                  value={landlordCode}
                  onChange={(e) => setLandlordCode(normalizeLandlordCode(e.target.value))}
                  placeholder="e.g. L4K7Q2M9X"
                  autoCapitalize="characters"
                  autoComplete="off"
                  spellCheck={false}
                  aria-label="Landlord referral code"
                  className="h-11 font-mono uppercase"
                />
                <span className="text-xs text-muted-foreground">From the landlord&apos;s link: L followed by 8 letters or numbers.</span>
              </label>
            )}
            {mode === 'new' && <GuarantorConsentCheckbox checked={consent} onCheckedChange={(c) => { setConsent(c); setError(null); }} />}
            <MissingChecklist items={missing} onFix={fixItem} />
            {showSaveDraft && (missing.length > 0 || saveOffer) && saveDraftBlock}
            {/* A tap on the disabled button lands on this wrapper: still a blocked press (E108). */}
            <div
              className="flex flex-col"
              onClick={() => {
                if (posting || missing.length === 0) return;
                if (tracking) blockedNow(t4FunnelItems(missing.map((m) => m.key)));
                else if (logResubmit) funnel.blocked(t4FunnelItems(missing.map((m) => m.key)));
              }}
              data-testid="send-button-wrap"
            >
            <button
              type="button"
              onClick={() => void post()}
              disabled={posting || sendProgress?.phase === 'sent' || missing.length > 0 || (mode === 'resubmit' && !original)}
              aria-live="polite"
              className="flex h-14 items-center justify-center gap-2 rounded-2xl bg-primary font-display text-base font-bold text-primary-foreground shadow-lg disabled:pointer-events-none disabled:opacity-50"
              data-testid="send-button"
            >
              {sendProgress?.phase === 'sent'
                ? <>{sendButtonLabel(sendProgress, '')}</>
                : posting
                  ? <><Loader2 className="h-5 w-5 animate-spin" /> {sendButtonLabel(sendProgress, 'Sending…')}</>
                  : <><Send className="h-5 w-5" /> {mode === 'resubmit' ? 'Resubmit rent request' : mode === 'renewal' ? 'Send the tenant’s code and renew' : 'Post rent request'}</>}
            </button>
            </div>
          </div>
        );
      default:
        // Text steps answer in the composer below.
        return null;
    }
  }
}

function ordinal(d: string): string {
  const n = parseInt(d, 10) || 1;
  const s = n % 10 === 1 && n !== 11 ? 'st' : n % 10 === 2 && n !== 12 ? 'nd' : n % 10 === 3 && n !== 13 ? 'rd' : 'th';
  return `${n}${s}`;
}

function placeholderOf(s: StepId): string {
  switch (s) {
    case 'rent': return 'e.g. 450,000';
    case 'days': return 'e.g. 30';
    case 'note': return 'e.g. Added the LC1 letter and fixed the landlord';
    case 'tenantPhone': case 'lc1Phone': return 'e.g. 0783 123 456';
    case 'nationalId': return 'e.g. CM12345678ABCD';
    case 'familySize': return 'e.g. 4';
    case 'work': return 'e.g. Sells clothes in Owino market';
    case 'workLocation': return 'e.g. Owino market, Kampala';
    case 'address': return 'e.g. Plot 14, Kireka Road';
    case 'lc1Village': return 'e.g. Kireka B';
    case 'city': return 'e.g. Kira';
    default: return 'Type your answer';
  }
}

function Avatar({ size = 'sm' }: { size?: 'sm' | 'lg' }) {
  return (
    <span
      aria-hidden="true"
      className={cn('flex shrink-0 items-center justify-center overflow-hidden rounded-full bg-primary', size === 'lg' ? 'h-9 w-9' : 'h-7 w-7')}
    >
      <img src={welileLogo} alt="" draggable={false} className="h-full w-full object-cover" />
    </span>
  );
}

interface RecordBlock {
  step: 'tenantPhone' | 'nationalId' | 'lc1Phone';
  /** The agent typed their own number or ID. */
  self: boolean;
  /** The refused value, masked. */
  masked: string;
}

function blockFor(step: RecordBlock['step'], self: boolean, value: string): RecordBlock {
  return { step, self, masked: step === 'nationalId' ? maskNationalId(value) : maskPhone(value) };
}

/** `spoken` drops the masked value, which reads badly aloud. */
function recordHeadline(block: RecordBlock, spoken: boolean): string {
  if (block.self) return block.step === 'nationalId' ? 'That’s your own National ID.' : 'That’s your own number.';
  if (spoken) return block.step === 'nationalId' ? 'That National ID is already on Welile.' : 'That number is already on Welile.';
  return `${block.masked} is already on Welile.`;
}

function recordBody(block: RecordBlock): string {
  if (block.self) {
    return block.step === 'lc1Phone'
      ? 'The LC1 has to be someone else, so they can vouch for the tenant.'
      : 'A tenant needs their own, so their Rent Plan messages reach them and not you.';
  }
  if (block.step === 'nationalId') return 'One National ID belongs to one person, so I can’t add it again. Check the card with the tenant and type it again.';
  if (block.step === 'lc1Phone') return 'It already belongs to someone else, so it can’t be a new LC1’s number. Ask the chairperson for their own phone.';
  return 'A new tenant needs a number that isn’t registered yet. Ask the tenant to read it out again, or use another number they own.';
}

/**
 * Shown when a typed number or ID is already on Welile. It says the record
 * exists, never whose it is, and the chat stays on the same question.
 */
function RecordExistsNotice({ block, onRetry }: { block: RecordBlock; onRetry: () => void }) {
  const [why, setWhy] = useState(false);
  const what = block.step === 'nationalId' ? 'National ID' : 'number';
  const headline = recordHeadline(block, false);
  const body = recordBody(block);
  return (
    <Bot>
      <Bubble tone="warn">
        <span className="mb-1 flex items-center gap-1.5 font-semibold"><Lock className="h-4 w-4 shrink-0" /> {headline}</span>
        {body}
        {!block.self && why && (
          <span className="mt-2 block text-sm text-muted-foreground">
            Numbers and IDs belong to people. If I showed who owns one, anyone could look people up, so I only tell you it’s taken. I won’t move to the next question until the {what} is new.
          </span>
        )}
      </Bubble>
      <div className="flex flex-wrap gap-2">
        <Chip onClick={onRetry}>Type a different {what}</Chip>
        {!block.self && !why && <Chip onClick={() => setWhy(true)}>Why can’t I see whose?</Chip>}
      </div>
    </Bot>
  );
}

function Bot({ children }: { children: ReactNode }) {
  return <div className="flex items-start gap-2"><Avatar /><div className="flex min-w-0 flex-col gap-2">{children}</div></div>;
}

function Bubble({ children, tone }: { children: ReactNode; tone?: 'warn' }) {
  return (
    <div className={cn(
      'max-w-[19rem] rounded-[6px_18px_18px_18px] border px-3.5 py-2.5 text-[15px] leading-[21px] shadow-[0_1px_2px_rgba(0,0,0,0.06),0_4px_12px_-4px_rgba(0,0,0,0.12)]',
      tone === 'warn' ? 'border-warning/40 bg-warning/10 text-foreground' : 'border-border bg-card',
    )}>
      {children}
    </div>
  );
}

function MeBubble({ children }: { children: ReactNode }) {
  return <div className="max-w-[17rem] rounded-[18px_6px_18px_18px] bg-primary px-3.5 py-2.5 text-left text-[15px] leading-[21px] text-primary-foreground shadow-[0_1px_2px_rgba(0,0,0,0.08),0_4px_12px_-4px_rgba(109,40,217,0.35)]">{children}</div>;
}

function Chip({ children, on, onClick }: { children: ReactNode; on?: boolean; onClick?: () => void }) {
  return (
    <button
      type="button"
      onClick={() => { hapticTap(); onClick?.(); }}
      aria-pressed={on}
      className={cn(
        'inline-flex min-h-9 items-center gap-1.5 rounded-full border px-3.5 text-sm font-semibold',
        on ? 'border-primary bg-primary text-primary-foreground' : 'border-primary/30 bg-card text-primary',
      )}
    >
      {on && <Check className="h-3.5 w-3.5" />}
      {children}
    </button>
  );
}

/**
 * What is still missing before Send turns on, in two groups: the Agent Ops gate
 * (exactly what _ao_gate_missing checks) and what this form needs to send.
 * Each line jumps to the question that fixes it.
 */
function MissingChecklist({ items, onFix }: { items: T4MissingItem[]; onFix: (k: T4ItemKey) => void }) {
  if (!items.length) {
    return (
      <p className="flex items-center gap-1.5 text-sm font-semibold text-success" data-testid="t4-ready">
        <Check className="h-4 w-4" /> Everything Agent Ops needs is in.
      </p>
    );
  }
  const groups: [string, T4MissingItem[]][] = [
    ['Agent Ops will refuse it without', items.filter((i) => i.group === 'gate')],
    ['To send this form', items.filter((i) => i.group === 'form')],
  ];
  return (
    <div className="rounded-2xl border border-warning/40 bg-warning/10 p-3 text-sm" role="status" aria-label="Still missing" data-testid="t4-missing">
      <p className="font-semibold">Still missing before you can send it ({items.length})</p>
      {groups.filter(([, list]) => list.length > 0).map(([title, list]) => (
        <div key={title} className="mt-2" data-testid={title.startsWith('Agent') ? 't4-missing-gate' : 't4-missing-form'}>
          <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{title}</p>
          <ul className="mt-1 flex flex-col gap-1">
            {list.map((i) => (
              <li key={i.key}>
                <button type="button" onClick={() => onFix(i.key)} className="text-left underline-offset-2 hover:underline">• {i.label}</button>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

/** The rent field's helper text, on every rent request form. */
export const RENT_HELPER = 'If the landlord wants several months together, enter ONE month. Landlord Ops will confirm the monthly rent with the landlord.';

/** A review line for a document: its state, with a small preview when there is one. */
function DocRow({ k, v, preview }: { k: string; v: string; preview: string | null }) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-border py-1.5 last:border-0">
      <span className="text-muted-foreground">{k}</span>
      <span className={cn('flex items-center gap-2 text-right font-medium', v === 'Missing' && 'text-destructive')}>
        {preview && <img src={preview} alt={`${k} on file`} className="h-8 w-8 rounded object-cover" />}
        {v}
      </span>
    </div>
  );
}

/** A document line's value and preview, for the resubmit summary. */
function docRowValue(d: { v: string; preview: string | null }): { value: string; preview: string | null } {
  return { value: d.v, preview: d.preview };
}

/** Resubmit: the whole request at once; every line opens its question to redo it. */
function ResubmitSummary({ rows, current, onRedo }: {
  rows: { label: string; value: string; step: StepId; preview?: string | null }[];
  current: StepId;
  onRedo: (s: StepId) => void;
}) {
  return (
    <div className="rounded-2xl border border-border bg-card p-2 text-sm" data-testid="resubmit-summary">
      <p className="px-1 pb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">The request · tap a line to redo it</p>
      {rows.map((r) => (
        <button
          key={r.step + r.label}
          type="button"
          onClick={() => onRedo(r.step)}
          aria-label={`Redo: ${r.label}`}
          aria-current={current === r.step ? 'step' : undefined}
          className={cn(
            'flex min-h-11 w-full items-center justify-between gap-3 rounded-lg border-b border-border px-1 py-1.5 text-left last:border-0',
            current === r.step && 'bg-primary/5',
          )}
        >
          <span className="text-muted-foreground">{r.label}</span>
          <span className={cn('flex items-center gap-2 text-right font-medium', r.value === 'Missing' && 'text-destructive')}>
            {r.preview && <img src={r.preview} alt={r.value.startsWith('On file') ? `${r.label} on file` : r.label} className="h-8 w-8 rounded object-cover" />}
            {r.value}
          </span>
        </button>
      ))}
    </div>
  );
}

/** Step 1 (E124/E127): why the tenant's phone stops here, and the way on. */
function TenantCheckNotice({ check, onOpenMine }: { check: IntakeTenantCheck; onOpenMine: (requestId: string) => void }) {
  let text: string;
  let open: string | null = null;
  if (check.kind === 'own_phone') {
    text = check.message ?? 'This is your own phone number. Type the tenant’s own phone number: the tenant must have their own phone.';
  } else if (check.kind === 'open_request') {
    text = check.where ? `This tenant already has a request at ${check.where}.` : (check.message ?? 'This tenant already has a request on its way.');
    text += check.mine ? ' It is yours: open it instead of posting a new one.' : ' Another agent is handling it, so you can’t post a new one.';
    if (check.mine && check.requestId) open = check.requestId;
  } else if (check.kind === 'returned_request') {
    text = check.mine
      ? 'This tenant’s request was sent back to you. Opening it so you can fix and resubmit…'
      : (check.message ?? 'This tenant’s request was sent back to another agent, so you can’t post a new one.');
  } else if (check.kind === 'phone_incomplete') {
    text = check.message ?? 'That phone number is incomplete. Type all 10 digits, like 0783 123 456.';
  } else {
    return null;
  }
  return (
    <Bot>
      <Bubble tone="warn">
        <span data-testid="tenant-check" data-kind={check.kind}>{text}</span>
        {open && (
          <button type="button" onClick={() => onOpenMine(open!)} className="mt-2 block min-h-11 font-semibold text-primary underline underline-offset-4">
            Open my request
          </button>
        )}
      </Bubble>
    </Bot>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex justify-between gap-3 border-b border-border py-1.5 last:border-0">
      <span className="text-muted-foreground">{k}</span>
      <span className="text-right font-medium">{v}</span>
    </div>
  );
}

function NameFields({ value, onChange }: { value: PersonNameParts; onChange: (v: PersonNameParts) => void }) {
  const cap = (s: string) => s.replace(/^\s+/, '').replace(/\s{2,}/g, ' ').replace(/\b\p{L}/gu, (c) => c.toUpperCase());
  const field = (key: keyof PersonNameParts, label: string, required: boolean) => (
    <label className="flex flex-col gap-1 text-xs font-semibold text-muted-foreground">
      {label}{required ? '' : ' (optional)'}
      <input
        value={value[key]}
        onChange={(e) => onChange({ ...value, [key]: cap(e.target.value) })}
        className="h-11 rounded-xl border border-border bg-background px-3 text-base font-normal text-foreground outline-none focus:border-primary"
      />
    </label>
  );
  return (
    <div className="flex max-w-xs flex-col gap-2 rounded-2xl border border-border bg-card p-3">
      {field('firstName', 'First name', true)}
      {field('otherNames', 'Other names', false)}
      {field('lastName', 'Last name', true)}
    </div>
  );
}

function PlanSummary({ planType, fees, amount }: { planType: PlanType; fees: NonNullable<ReturnType<typeof computeAssistantFees>>; amount: number }) {
  const [open, setOpen] = useState(false);
  const headline = planType === 'weekly'
    ? { label: 'Weekly repayment', value: formatUGX(weeklyRepaymentFor(amount)), unit: 'a week' }
    : planType === 'daily'
      ? { label: `${fees.durationDays}-day Rent Plan`, value: formatUGX(fees.dailyRepayment), unit: 'a day' }
      : { label: fees.durationDays === 30 ? '1 month' : '4 months', value: formatUGX(fees.totalRepayment), unit: 'in total' };
  return (
    <Bot>
      <div className="w-64 rounded-[6px_18px_18px_18px] border border-border bg-card px-3.5 py-2.5">
        <p className="text-xs text-muted-foreground">{headline.label}</p>
        <p className="flex items-baseline gap-1.5"><span className="font-mono text-[22px] font-semibold leading-7 text-primary">{headline.value}</span><span className="text-sm text-muted-foreground">{headline.unit}</span></p>
        <p className="text-sm leading-5">
          {planType === 'weekly'
            ? `One month’s rent plus 33%, split over 4 weeks. Payments start today.`
            : `That is ${formatUGX(fees.totalRepayment)} in total, starting the day after funding.`}
        </p>
        {open && (
          <div className="mt-2 space-y-1 border-t border-dashed border-border pt-2 text-[13px]">
            <div className="flex justify-between"><span className="text-muted-foreground">Rent</span><span className="font-mono">{formatUGX(fees.rentAmount)}</span></div>
            <div className="flex justify-between"><span className="text-muted-foreground">Access fee</span><span className="font-mono">{formatUGX(fees.accessFee)}</span></div>
            <div className="flex justify-between"><span className="text-muted-foreground">{planType === 'daily' ? 'Request fee' : 'Platform fee'}</span><span className="font-mono">{formatUGX(fees.requestFee)}</span></div>
          </div>
        )}
        <button type="button" onClick={() => setOpen((o) => !o)} className="mt-1 min-h-8 text-[13px] font-semibold text-primary">
          {open ? 'Hide breakdown' : 'See breakdown'}
        </button>
      </div>
    </Bot>
  );
}

function LandlordStatusNote({ status, agreement, verifyReq, onRequest, name }: {
  status: 'idle' | 'checking' | 'verified' | 'unverified' | 'missing';
  agreement: boolean | null;
  verifyReq: 'idle' | 'sending' | 'sent' | 'exists';
  onRequest: () => void;
  name: string;
}) {
  if (status === 'idle') return null;
  if (status === 'checking') return <p className="px-1 text-xs text-muted-foreground"><Loader2 className="mr-1 inline h-3 w-3 animate-spin" /> Checking {name}…</p>;
  if (status === 'missing') return <p className="px-1 text-sm text-destructive">{name} is no longer in the system. Pick another landlord or register them.</p>;
  return (
    <div className="flex flex-col gap-1.5 px-1">
      <div className="flex flex-wrap gap-1.5">
        <span className={cn('rounded-full px-2 py-0.5 text-xs font-semibold', status === 'verified' ? 'bg-success/15 text-success' : 'bg-warning/15 text-warning-foreground')}>
          {status === 'verified' ? 'Verified landlord' : 'Verification pending'}
        </span>
        {agreement === false && <span className="rounded-full bg-muted px-2 py-0.5 text-xs font-semibold text-muted-foreground">No signed agreement on file</span>}
      </div>
      {status === 'unverified' && (
        verifyReq === 'sent' || verifyReq === 'exists'
          ? <p className="text-xs text-muted-foreground">Landlord Ops {verifyReq === 'sent' ? 'have been asked' : 'were already asked'} to verify {name}. You can still post; the request waits for their check.</p>
          : (
            <button type="button" onClick={onRequest} disabled={verifyReq === 'sending'} className="self-start text-sm font-semibold text-primary disabled:opacity-60">
              {verifyReq === 'sending' ? 'Sending…' : `Ask Landlord Ops to verify ${name.split(' ')[0]}`}
            </button>
          )
      )}
    </div>
  );
}

