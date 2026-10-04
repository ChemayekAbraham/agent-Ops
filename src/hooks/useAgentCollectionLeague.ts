/**
 * Agent Collection League — data access.
 *
 * All figures come from secured SECURITY DEFINER RPCs that aggregate
 * `agent_collections` (valid, non-reversed, positive) against
 * `agent_expected_day_plans`, attributed to the team the collecting agent
 * belonged to on that day (`agent_team_membership_history`).
 *
 * No client-side money maths, no mock data.
 */
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

export type HeatLevel =
  | 'none'
  | 'dark_red'
  | 'red'
  | 'light_red'
  | 'light_green'
  | 'green'
  | 'dark_green';

export interface LeagueDay {
  date: string;
  expected_amount: number;
  collected_amount: number;
  performance_percentage: number | null;
  heat_level: HeatLevel;
  is_future: boolean;
}

export interface LeagueTeamSummary {
  parent_agent_id: string;
  is_parent: boolean;
  team_name: string;
  rank: number | null;
  total_teams: number;
  expected_amount: number;
  collected_amount: number;
  performance_percentage: number | null;
  active_collectors: number;
  total_members: number;
  previous_rank: number | null;
  rank_change: number | null;
  active_collector_rate?: number | null;
  consistency_days?: number;
}

export interface LeagueHome {
  week_start: string;
  week_end: string;
  has_team: boolean;
  my_team: LeagueTeamSummary;
  current_week_days: LeagueDay[];
  error?: string;
}

export interface LeagueMember {
  agent_id: string;
  is_parent: boolean;
  is_me: boolean;
  name: string;
  avatar_url: string | null;
  expected_amount: number;
  collected_amount: number;
  collection_count: number;
  last_collection_at: string | null;
  performance_percentage: number | null;
}

export interface LeagueRow {
  rank: number;
  team_name: string;
  /** Parent agent's profile photo for the team, when available. */
  team_avatar_url?: string | null;
  performance_percentage: number | null;
  rank_change?: number | null;
  is_me: boolean;
  achievement: 'top_team' | 'full_collection' | 'green_week' | null;
  /** Only present for the caller's own team — never for competing teams. */
  expected_amount: number | null;
  collected_amount: number | null;
}

export interface LeagueDetails {
  week: { week_start: string; week_end: string };
  has_team: boolean;
  my_team_summary: LeagueTeamSummary;
  heatmap: LeagueDay[];
  team_members: LeagueMember[];
  leaderboard: LeagueRow[];
  leaderboard_meta: { total_teams: number; my_rank: number | null };
  previous_week_summary: {
    week_start: string;
    week_end: string;
    rank: number | null;
    performance_percentage: number | null;
    expected_amount: number;
    collected_amount: number;
  } | null;
  error?: string;
}

/** Compact home-card payload: current week only. */
export function useAgentCollectionLeagueHome(enabled = true) {
  return useQuery({
    queryKey: ['agent-collection-league-home'],
    enabled,
    staleTime: 60_000,
    refetchInterval: 5 * 60_000,
    queryFn: async (): Promise<LeagueHome> => {
      const { data, error } = await supabase.rpc('get_agent_collection_league_home');
      if (error) throw error;
      return data as unknown as LeagueHome;
    },
  });
}

/** Full league payload: summary + heatmap + members + leaderboard + last week. */
export function useAgentCollectionLeagueDetails(weekStart?: string, historyWeeks = 12) {
  return useQuery({
    queryKey: ['agent-collection-league-details', weekStart ?? 'current', historyWeeks],
    staleTime: 60_000,
    refetchInterval: 5 * 60_000,
    queryFn: async (): Promise<LeagueDetails> => {
      const { data, error } = await supabase.rpc('get_agent_collection_league_details', {
        p_week_start: weekStart ?? null,
        p_history_weeks: historyWeeks,
      });
      if (error) throw error;
      return data as unknown as LeagueDetails;
    },
  });
}

export interface LeaderboardPage {
  rows: LeagueRow[];
  total_teams: number;
  offset: number;
}

/** Explicit "load more" only — never auto-paginates. */
export async function fetchLeagueLeaderboardPage(
  weekStart: string | null,
  offset: number,
  limit = 20,
): Promise<LeaderboardPage> {
  const { data, error } = await supabase.rpc('get_agent_collection_league_leaderboard', {
    p_week_start: weekStart,
    p_offset: offset,
    p_limit: limit,
  });
  if (error) throw error;
  return data as unknown as LeaderboardPage;
}

/** Single source of truth for heat colours in the UI. */
export const HEAT_CLASS: Record<HeatLevel, string> = {
  none: 'bg-muted text-muted-foreground',
  dark_red: 'bg-destructive text-destructive-foreground',
  red: 'bg-destructive/70 text-destructive-foreground',
  light_red: 'bg-destructive/40 text-foreground',
  light_green: 'bg-emerald-500/35 text-foreground',
  green: 'bg-emerald-500/70 text-white',
  dark_green: 'bg-emerald-600 text-white',
};

export const HEAT_LABEL: Record<HeatLevel, string> = {
  none: 'Nothing expected',
  dark_red: 'Nothing collected',
  red: 'Under 40%',
  light_red: '40–59%',
  light_green: '60–79%',
  green: '80–99%',
  dark_green: '100% or more',
};

/* ------------------------------------------------------------------ *
 * Weekly champion team (Monday celebration)
 * ------------------------------------------------------------------ */

export interface ChampionCollector {
  position: number;
  agent_id: string;
  name: string;
  collected_amount: number;
  payments: number;
  is_me: boolean;
}

export interface ChampionTeam {
  parent_agent_id: string;
  team_name: string;
  is_my_team: boolean;
  expected_amount: number;
  collected_amount: number;
  performance_percentage: number | null;
  active_collectors: number;
  total_members: number;
  consistency_days: number | null;
}

export interface WeeklyChampion {
  week_start: string;
  week_end: string;
  has_champion: boolean;
  team?: ChampionTeam;
  top_collectors?: ChampionCollector[];
  error?: string;
}

/** Last completed week's #1 team plus its three best collectors. */
export function useWeeklyChampionTeam(enabled = true) {
  return useQuery({
    queryKey: ['agent-weekly-champion-team'],
    enabled,
    staleTime: 30 * 60 * 1000,
    queryFn: async (): Promise<WeeklyChampion> => {
      const { data, error } = await supabase.rpc('get_agent_weekly_champion_team', {});
      if (error) throw error;
      return data as unknown as WeeklyChampion;
    },
  });
}
