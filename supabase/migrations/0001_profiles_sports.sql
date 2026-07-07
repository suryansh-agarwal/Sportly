create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  username text not null unique check (username ~ '^[a-z0-9_]{3,20}$'),
  display_name text not null check (char_length(display_name) between 1 and 50),
  created_at timestamptz not null default now()
);

alter table public.profiles enable row level security;

create policy "authenticated users can read profiles"
  on public.profiles for select to authenticated using (true);

create policy "users can update own profile"
  on public.profiles for update to authenticated
  using (id = (select auth.uid()));

create function public.handle_new_user()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  insert into public.profiles (id, username, display_name)
  values (
    new.id,
    new.raw_user_meta_data ->> 'username',
    coalesce(new.raw_user_meta_data ->> 'display_name',
             new.raw_user_meta_data ->> 'username')
  );
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

create table public.sports (
  id text primary key,
  name text not null
);

alter table public.sports enable row level security;

create policy "authenticated users can read sports"
  on public.sports for select to authenticated using (true);

insert into public.sports (id, name) values
  ('football', 'Football'),
  ('cricket', 'Cricket'),
  ('basketball', 'Basketball'),
  ('tennis', 'Tennis'),
  ('padel', 'Padel'),
  ('pickleball', 'Pickleball'),
  ('table_tennis', 'Table Tennis'),
  ('badminton', 'Badminton');
