import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '../supabase';
import type { MatchFormat, MatchRow, MatchType, ParticipantRow, Side } from '../types';

const MATCH_SELECT =
  'id, sport_id, match_type, format, played_at, score_a, score_b, ' +
  'participants:match_participants(profile_id, score, outcome, side, rank, stats)';

const MATCH_DETAIL_SELECT =
  'id, sport_id, match_type, format, played_at, score_a, score_b, ' +
  'participants:match_participants(profile_id, score, outcome, side, rank, stats, profile:profiles(username))';

export type MatchDetailParticipant = ParticipantRow & { profile: { username: string } };
export type MatchDetailRow = Omit<MatchRow, 'participants'> & { participants: MatchDetailParticipant[] };

export function useSports() {
  return useQuery({
    queryKey: ['sports'],
    queryFn: async (): Promise<{ id: string; name: string }[]> => {
      const { data, error } = await supabase.from('sports').select('id, name').order('name');
      if (error) throw error;
      return data;
    },
  });
}

export function useMatches() {
  return useQuery({
    queryKey: ['matches'],
    queryFn: async (): Promise<MatchRow[]> => {
      const { data, error } = await supabase
        .from('matches')
        .select(MATCH_SELECT)
        .order('played_at', { ascending: false })
        .order('created_at', { ascending: false });
      if (error) throw error;
      return data as unknown as MatchRow[];
    },
  });
}

export function useMatch(id: string) {
  return useQuery({
    queryKey: ['match', id],
    enabled: !!id,
    queryFn: async (): Promise<MatchDetailRow> => {
      const { data, error } = await supabase
        .from('matches')
        .select(MATCH_DETAIL_SELECT)
        .eq('id', id)
        .single();
      if (error) throw error;
      return data as unknown as MatchDetailRow;
    },
  });
}

export type LogMatchParticipant = {
  profile_id: string;
  side: Side | null;
  rank: number | null;
  score: number | null;
  stats: Record<string, number> | null;
};

export type LogMatchInput = {
  sportId: string;
  matchType: MatchType;
  format: MatchFormat;
  scoreA: number | null;
  scoreB: number | null;
  participants: LogMatchParticipant[];
};

export function useLogMatch() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: LogMatchInput) => {
      const { error } = await supabase.rpc('log_match', {
        p_sport_id: input.sportId,
        p_match_type: input.matchType,
        p_format: input.format,
        p_score_a: input.scoreA,
        p_score_b: input.scoreB,
        p_participants: input.participants,
      });
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['matches'] }),
  });
}
