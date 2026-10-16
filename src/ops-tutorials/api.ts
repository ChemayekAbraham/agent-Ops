import { supabase } from '@/integrations/supabase/client';

// Untyped escape hatch keeps wrappers stable if generated types lag behind the live schema.
const db = supabase as any;

async function rpc<T = any>(fn: string, args?: Record<string, unknown>): Promise<T> {
  const { data, error } = await db.rpc(fn, args ?? {});
  if (error) throw new Error(error.message);
  return data as T;
}

async function rows<T = any>(q: PromiseLike<{ data: unknown; error: { message: string } | null }>): Promise<T[]> {
  const { data, error } = await q;
  if (error) throw new Error(error.message);
  return (data ?? []) as T[];
}

const WITH_TOPIC = '*, topic:ops_tutorial_topics(topic_code,title,tier)';

// ---- Creator ----
export const capabilities = () => rpc('ops_tutorial_my_capabilities');
export const proposeTopic = (a: { p_title: string; p_description: string; p_tier: string }) => rpc<string>('ops_tutorial_propose_topic', a);
export interface RegisterUploadArgs {
  p_topic_id: string; p_kind: string; p_supersedes_video_id: string | null; p_revision_reason: string | null;
  p_title: string; p_sha256: string; p_size_bytes: number; p_duration_seconds: number; p_video_codec: string; p_recorded_on: string | null;
}
export async function registerUpload(a: RegisterUploadArgs) {
  const data = await rpc<any>('ops_tutorial_register_upload', a as any);
  const row = Array.isArray(data) ? data[0] : data;
  if (!row) throw new Error('Upload could not be registered');
  return row as { video_id: string; video_code: string; storage_path: string; resumed: boolean };
}
export const markUploaded = (p_video_id: string) => rpc<void>('ops_tutorial_mark_uploaded', { p_video_id });
export const submitVideo = (p_video_id: string) => rpc<void>('ops_tutorial_submit', { p_video_id });
export const withdrawVideo = (p_video_id: string) => rpc<void>('ops_tutorial_withdraw', { p_video_id });

// ---- HR / reviewer ----
export const setMember = (a: { p_email: string; p_role: string; p_enabled: boolean; p_note: string | null }) => rpc<string>('ops_tutorial_set_member', a);
export const membersList = () => rpc<any[]>('ops_tutorial_members_list');
export const setRate = (a: { p_tier: string; p_amount: number }) => rpc<void>('ops_tutorial_set_rate', a);
export const setTopicStatus = (a: { p_topic_id: string; p_status: 'open' | 'closed' }) => rpc<void>('ops_tutorial_set_topic_status', a);
export const logView = (a: { p_video_id: string; p_context: 'review' | 'approval' | 'library' | 'own'; p_position_seconds: number; p_requisition_id?: string | null }) =>
  rpc<void>('ops_tutorial_log_view', { ...a, p_requisition_id: a.p_requisition_id ?? null });
export const acceptVideo = (a: { p_video_id: string; p_no_personal_data: boolean; p_note: string | null }) => rpc<void>('ops_tutorial_accept', a);
export const rejectVideo = (a: { p_video_id: string; p_reason: string }) => rpc<void>('ops_tutorial_reject', a);
export const setPublished = (a: { p_video_id: string; p_published: boolean }) => rpc<void>('ops_tutorial_set_published', a);

// ---- Claims ----
export async function claimPrepare(p_video_ids: string[]) {
  const data = await rpc<any[]>('ops_tutorial_claim_prepare', { p_video_ids });
  return (data ?? [])[0] as { claim_id: string; claim_code: string; total_amount: number; req_title: string; req_reason: string };
}
export const claimLink = (p_claim_id: string) => rpc<string>('ops_tutorial_claim_link', { p_claim_id });
export const claimCancel = (p_claim_id: string) => rpc<void>('ops_tutorial_claim_cancel', { p_claim_id });
export const claimRelease = (p_claim_id: string) => rpc<void>('ops_tutorial_claim_release', { p_claim_id });
export const claimsList = () => rpc<any[]>('ops_tutorial_claims_list');
export async function claimForRequisition(p_requisition_id: string) {
  const data = await rpc<any[]>('ops_tutorial_claim_for_requisition', { p_requisition_id });
  return (data ?? [])[0] ?? null;
}
export async function approverWatchStatus(p_requisition_id: string) {
  const data = await rpc<any[]>('ops_tutorial_approver_watch_status', { p_requisition_id });
  return ((data ?? [])[0] ?? { video_count: 0, started_count: 0 }) as { video_count: number; started_count: number };
}

// ---- Reads ----
export const listTopics = () => rows(db.from('ops_tutorial_topics').select('*').order('created_at', { ascending: false }));
export const listRates = () => rows(db.from('ops_tutorial_rates').select('*'));
export async function listMyVideos() {
  const { data: u } = await supabase.auth.getUser();
  if (!u.user) return [];
  return rows(db.from('ops_tutorial_videos').select(WITH_TOPIC).eq('uploaded_by', u.user.id).order('created_at', { ascending: false }));
}
export const listReviewQueue = () => rows(db.from('ops_tutorial_videos').select(WITH_TOPIC).eq('status', 'submitted').order('submitted_at', { ascending: true }));
export const listAccepted = () => rows(db.from('ops_tutorial_videos').select(WITH_TOPIC).eq('status', 'accepted').order('reviewed_at', { ascending: false }));
export const listTopicVideos = (topicId: string) => rows(db.from('ops_tutorial_videos').select('*').eq('topic_id', topicId).neq('status', 'withdrawn'));
export const listLibrary = () => rows(db.from('ops_tutorial_videos').select(WITH_TOPIC).eq('status', 'accepted').not('published_at', 'is', null).order('published_at', { ascending: false }));
export async function listMyLiveClaimVideoIds(): Promise<string[]> {
  const data = await rows<{ video_id: string }>(db.from('ops_tutorial_claim_lines').select('video_id').is('released_at', null));
  return data.map((r) => r.video_id);
}
export async function signedUrl(storagePath: string): Promise<string> {
  const { data, error } = await supabase.storage.from('ops-tutorials').createSignedUrl(storagePath, 3600);
  if (error) throw new Error(error.message);
  return data.signedUrl;
}
