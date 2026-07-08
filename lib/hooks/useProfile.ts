import { useQuery } from '@tanstack/react-query';
import { supabase } from '../supabase';

export type Profile = { id: string; username: string; display_name: string };

export function useProfile(id: string) {
  return useQuery({
    queryKey: ['profile', id],
    queryFn: async (): Promise<Profile> => {
      const { data, error } = await supabase
        .from('profiles')
        .select('id, username, display_name')
        .eq('id', id)
        .single();
      if (error) throw error;
      return data;
    },
  });
}
