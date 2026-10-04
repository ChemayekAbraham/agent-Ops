/**
 * HR data access — Recruitment
 */
import { supabase, unwrap, requireUserId } from './client';
import type {
  Application,
  Candidate,
  HiringRequisition,
  JobPosting,
  Rubric,
} from '../types';

const NOT_PROVISIONED = 'Recruitment tables are not provisioned yet';

export async function getHiringRequisitions(): Promise<HiringRequisition[]> {
  return [];
}

export async function getJobPostings(_status?: string): Promise<JobPosting[]> {
  const { data: postings, error } = await supabase
    .from('hr_job_postings')
    .select('*')
    .order('created_at', { ascending: false });
  if (error) throw new Error(error.message);
  if (!postings || postings.length === 0) return [];

  const sourceStrings = postings.map((p) => `welile.com/careers?c=${p.public_slug}`);
  const { data: applications, error: appError } = await supabase
    .from('job_applications')
    .select('source')
    .in('source', sourceStrings);
  if (appError) throw new Error(appError.message);

  const countMap = new Map<string, number>();
  for (const row of applications || []) {
    const slug = (row.source || '').replace('welile.com/careers?c=', '');
    countMap.set(slug, (countMap.get(slug) || 0) + 1);
  }

  return postings.map((p) => ({
    ...p,
    application_count: countMap.get(p.public_slug) || 0,
  })) as unknown as JobPosting[];
}

export async function setJobPostingStatus(
  id: string,
  status: 'draft' | 'open' | 'closed',
): Promise<JobPosting> {
  const userId = await requireUserId();
  const now = new Date().toISOString();
  const isClosed = status === 'closed';

  const res = await supabase
    .from('hr_job_postings')
    .update({
      status,
      updated_at: now,
      closed_at: isClosed ? now : null,
      closed_by: isClosed ? userId : null,
    })
    .eq('id', id)
    .select()
    .single();

  return unwrap(res) as unknown as JobPosting;
}

export async function getJobPosting(_jobId: string): Promise<JobPosting | null> {
  return null;
}

export async function getCandidates(): Promise<Candidate[]> {
  return [];
}

export async function getRubrics(): Promise<Rubric[]> {
  return [];
}

export async function getRubric(_rubricId: string): Promise<Rubric | null> {
  return null;
}

export async function getApplications(
  _params: { jobPostingId?: string; stage?: string } = {},
): Promise<Application[]> {
  return [];
}

export async function getApplication(_applicationId: string): Promise<Application | null> {
  return null;
}

export async function setApplicationStage(
  _applicationId: string,
  _stage: Application['stage'],
  _decidedByEmployeeId: string,
  _reason: string,
): Promise<Application> {
  throw new Error(NOT_PROVISIONED);
}
