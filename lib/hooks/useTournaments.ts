import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '../supabase';
import { useAuth } from '../auth';
import type { FixtureRow } from '../tournaments/standings';

export type TournamentRow = {
  id: string;
  name: string;
  sport_id: string;
  format: 'round_robin' | 'knockout';
  status: 'draft' | 'active' | 'completed' | 'cancelled';
  created_by: string;
  join_token: string;
  winner_id: string | null;
  created_at: string;
};

export type TournamentPlayer = {
  profile_id: string;
  status: 'invited' | 'accepted' | 'declined';
  created_at: string;
  profile: { username: string };
};

export type TournamentFixture = FixtureRow;

export type TournamentDetail = TournamentRow & {
  players: TournamentPlayer[];
  fixtures: TournamentFixture[];
};

const PLAYERS_SELECT = 'profile_id, status, created_at, profile:profiles(username)';
const FIXTURES_SELECT =
  'id, round, position, player_a, player_b, status, match_id, winner_id, score_a, score_b';

export function useTournaments() {
  const { session } = useAuth();
  const myId = session!.user.id;
  return useQuery({
    queryKey: ['tournaments'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('tournaments')
        .select('*, players:tournament_players(profile_id, status)')
        .order('created_at', { ascending: false });
      if (error) throw error;
      const rows = data as unknown as (TournamentRow & { players: { profile_id: string; status: string }[] })[];
      const invites = rows.filter((t) =>
        t.players.some((p) => p.profile_id === myId && p.status === 'invited')
      );
      const mine = rows.filter((t) => !invites.includes(t));
      return { mine, invites };
    },
  });
}

export function useTournament(id: string) {
  return useQuery({
    queryKey: ['tournament', id],
    enabled: !!id,
    queryFn: async (): Promise<TournamentDetail> => {
      const [t, p, f] = await Promise.all([
        supabase.from('tournaments').select('*').eq('id', id).single(),
        supabase.from('tournament_players').select(PLAYERS_SELECT).eq('tournament_id', id).order('created_at'),
        supabase.from('fixtures').select(FIXTURES_SELECT).eq('tournament_id', id).order('round').order('position'),
      ]);
      if (t.error) throw t.error;
      if (p.error) throw p.error;
      if (f.error) throw f.error;
      return {
        ...(t.data as unknown as TournamentRow),
        players: p.data as unknown as TournamentPlayer[],
        fixtures: f.data as unknown as TournamentFixture[],
      };
    },
  });
}

function useTournamentMutation<TInput, TResult = void>(
  fn: (input: TInput) => Promise<TResult>,
  extraKeys: (input: TInput) => string[][] = () => []
) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: (_res, input) => {
      qc.invalidateQueries({ queryKey: ['tournaments'] });
      for (const key of extraKeys(input)) qc.invalidateQueries({ queryKey: key });
    },
  });
}

export function useCreateTournament() {
  return useTournamentMutation(
    async (input: { name: string; sportId: string; format: 'round_robin' | 'knockout' }) => {
      const { data, error } = await supabase.rpc('create_tournament', {
        p_name: input.name, p_sport_id: input.sportId, p_format: input.format,
      });
      if (error) throw error;
      return data as string;
    }
  );
}

export function useInvite() {
  return useTournamentMutation(
    async (input: { tournamentId: string; profileId: string }) => {
      const { error } = await supabase.rpc('invite_to_tournament', {
        p_tournament_id: input.tournamentId, p_profile_id: input.profileId,
      });
      if (error) throw error;
    },
    (input) => [['tournament', input.tournamentId]]
  );
}

export function useRespondToInvite() {
  return useTournamentMutation(
    async (input: { tournamentId: string; accept: boolean }) => {
      const { error } = await supabase.rpc('respond_to_invite', {
        p_tournament_id: input.tournamentId, p_accept: input.accept,
      });
      if (error) throw error;
    },
    (input) => [['tournament', input.tournamentId]]
  );
}

export function usePreviewByToken(token: string) {
  return useQuery({
    queryKey: ['tournament-preview', token],
    enabled: !!token,
    queryFn: async () => {
      const { data, error } = await supabase.rpc('preview_tournament_by_token', { p_token: token });
      if (error) throw error;
      return data as {
        id: string; name: string; sport_id: string; format: string;
        status: string; creator: string; player_count: number;
      };
    },
  });
}

export function useJoinByToken() {
  return useTournamentMutation(async (token: string) => {
    const { data, error } = await supabase.rpc('join_by_token', { p_token: token });
    if (error) throw error;
    return data as string;
  });
}

export function useStartTournament() {
  return useTournamentMutation(
    async (tournamentId: string) => {
      const { error } = await supabase.rpc('start_tournament', { p_tournament_id: tournamentId });
      if (error) throw error;
    },
    (tournamentId) => [['tournament', tournamentId]]
  );
}

export function useRecordFixtureResult() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { fixtureId: string; matchId: string; tournamentId: string }) => {
      const { error } = await supabase.rpc('record_fixture_result', {
        p_fixture_id: input.fixtureId, p_match_id: input.matchId,
      });
      if (error) throw error;
    },
    onSuccess: (_res, input) => {
      qc.invalidateQueries({ queryKey: ['tournament', input.tournamentId] });
      qc.invalidateQueries({ queryKey: ['tournaments'] });
      qc.invalidateQueries({ queryKey: ['matches'] });
    },
  });
}

export function useCancelTournament() {
  return useTournamentMutation(
    async (tournamentId: string) => {
      const { error } = await supabase.rpc('cancel_tournament', { p_tournament_id: tournamentId });
      if (error) throw error;
    },
    (tournamentId) => [['tournament', tournamentId]]
  );
}
