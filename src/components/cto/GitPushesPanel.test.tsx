import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import GitPushesPanel from './GitPushesPanel';
import type { GithubPushEvent, GithubPushFilters } from '@/hooks/useGithubPushEvents';

const state = vi.hoisted(() => ({ rows: [] as GithubPushEvent[], error: null as Error | null, calls: [] as GithubPushFilters[], refetch: vi.fn() }));
vi.mock('@/hooks/useGithubPushEvents', () => ({ useGithubPushEvents: (filters: GithubPushFilters) => {
  state.calls.push(filters);
  return { data: state.rows.filter(row => (!filters.senderLogin || row.senderLogin === filters.senderLogin) && (!filters.branch || row.branch === filters.branch)), error: state.error, isLoading: false, isFetching: false, refetch: state.refetch };
} }));
const windows = [{ label: '7 days', days: 7 }, { label: '30 days', days: 30 }, { label: '90 days', days: 90 }, { label: 'All time', days: 0 }];
const push = (id: string, person: string, branch: string): GithubPushEvent => ({ id, pushedBy: person, senderLogin: person, branch, repoFullName: 'org/repo', isTag: false, senderAvatarUrl: null, pusherEmail: null, beforeSha: null, afterSha: null, created: false, deleted: false, forced: false, compareUrl: null, commitCount: 1, distinctCommitCount: 1, headCommitMessage: 'Update', commits: [], filesAdded: 0, filesModified: 0, filesRemoved: 0, receivedAt: '2026-10-19T16:00:00Z' });

describe('Git push filters', () => {
  beforeEach(() => { cleanup(); state.calls = []; state.error = null; state.rows = [push('1', 'alice', 'main'), push('2', 'bob', 'dev')]; state.refetch.mockClear(); });
  it('passes the requested day window to the existing hook', () => {
    render(<GitPushesPanel windows={windows} />);
    fireEvent.click(screen.getByRole('button', { name: '7 days' }));
    expect(state.calls.at(-1)?.days).toBe(7);
    fireEvent.click(screen.getByRole('button', { name: 'All time' }));
    expect(state.calls.at(-1)?.days).toBe(0);
  });
  it('passes sender login and branch to the hook without losing window options', () => {
    render(<GitPushesPanel windows={windows} />);
    fireEvent.click(screen.getByRole('combobox', { name: 'Filter pushes by person' }));
    fireEvent.click(screen.getByRole('option', { name: 'alice' }));
    expect(state.calls.at(-1)?.senderLogin).toBe('alice');
    fireEvent.click(screen.getByRole('combobox', { name: 'Filter pushes by branch' }));
    fireEvent.click(screen.getByRole('option', { name: 'dev' }));
    expect(state.calls.at(-1)).toEqual({ days: 30, senderLogin: 'alice', branch: 'dev' });
  });
  it('refreshes push data through the hook', () => {
    render(<GitPushesPanel windows={windows} />);
    fireEvent.click(screen.getByRole('button', { name: 'Refresh pushes' }));
    expect(state.refetch).toHaveBeenCalledTimes(1);
  });
});