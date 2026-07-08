create function public.enforce_friendship_immutability()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if new.requester_id <> old.requester_id or new.addressee_id <> old.addressee_id then
    raise exception 'friendship participants are immutable';
  end if;
  if old.status = 'accepted' and new.status <> 'accepted' then
    raise exception 'accepted friendships cannot be reverted';
  end if;
  return new;
end;
$$;

create trigger friendship_immutability
  before update on public.friendships
  for each row execute function public.enforce_friendship_immutability();

-- Remove reverse-direction duplicates (keep the older row) so the index can build
delete from public.friendships f
using public.friendships g
where f.requester_id = g.addressee_id
  and f.addressee_id = g.requester_id
  and (f.created_at > g.created_at
       or (f.created_at = g.created_at and f.id > g.id));

create unique index friendships_canonical_pair
  on public.friendships (least(requester_id, addressee_id), greatest(requester_id, addressee_id));
