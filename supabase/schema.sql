create extension if not exists pgcrypto;

create table if not exists public.families (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  owner_user_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.family_members (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references public.families(id) on delete cascade,
  name text not null,
  relationship text,
  date_of_birth date,
  phone text,
  email text,
  address text,
  profile_photo_path text,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.documents (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references public.families(id) on delete cascade,
  member_id uuid references public.family_members(id) on delete set null,
  document_name text not null,
  category text,
  original_filename text,
  storage_path text not null,
  file_type text,
  file_size text,
  notes text,
  is_important boolean not null default false,
  is_deleted boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.passports (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references public.families(id) on delete cascade,
  member_id uuid not null references public.family_members(id) on delete cascade,
  passport_number text not null,
  full_name text not null,
  date_of_birth date,
  nationality text,
  gender text,
  place_of_birth text,
  place_of_issue text,
  issue_date date,
  expiry_date date,
  passport_type text,
  document_id uuid references public.documents(id) on delete set null,
  passport_image_path text,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (family_id, member_id)
);

alter table public.passports add column if not exists passport_image_path text;

create table if not exists public.reminders (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references public.families(id) on delete cascade,
  member_id uuid references public.family_members(id) on delete cascade,
  reminder_type text not null,
  reminder_date timestamptz not null,
  message text,
  is_completed boolean not null default false,
  created_at timestamptz not null default now()
);

create table if not exists public.activity_logs (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references public.families(id) on delete cascade,
  action text not null,
  entity_type text,
  entity_id uuid,
  created_at timestamptz not null default now()
);

create index if not exists idx_documents_family_member on public.documents(family_id, member_id);
create index if not exists idx_passports_family_member on public.passports(family_id, member_id);
create index if not exists idx_family_members_family_id on public.family_members(family_id);

alter table public.families enable row level security;
alter table public.family_members enable row level security;
alter table public.documents enable row level security;
alter table public.passports enable row level security;
alter table public.reminders enable row level security;
alter table public.activity_logs enable row level security;

drop policy if exists "Family owners can access their family" on public.families;
create policy "Family owners can access their family" on public.families
for all using (auth.uid() = owner_user_id)
with check (auth.uid() = owner_user_id);

drop policy if exists "Family owners can access family members" on public.family_members;
create policy "Family owners can access family members" on public.family_members
for all using (
  exists (select 1 from public.families where id = family_id and owner_user_id = auth.uid())
)
with check (
  exists (select 1 from public.families where id = family_id and owner_user_id = auth.uid())
);

drop policy if exists "Family owners can access family documents" on public.documents;
create policy "Family owners can access family documents" on public.documents
for all using (
  exists (select 1 from public.families where id = family_id and owner_user_id = auth.uid())
)
with check (
  exists (select 1 from public.families where id = family_id and owner_user_id = auth.uid())
);

drop policy if exists "Family owners can access passports" on public.passports;
create policy "Family owners can access passports" on public.passports
for all using (
  exists (select 1 from public.families where id = family_id and owner_user_id = auth.uid())
)
with check (
  exists (select 1 from public.families where id = family_id and owner_user_id = auth.uid())
);

drop policy if exists "Family owners can access reminders" on public.reminders;
create policy "Family owners can access reminders" on public.reminders
for all using (
  exists (select 1 from public.families where id = family_id and owner_user_id = auth.uid())
)
with check (
  exists (select 1 from public.families where id = family_id and owner_user_id = auth.uid())
);

drop policy if exists "Family owners can access activity logs" on public.activity_logs;
create policy "Family owners can access activity logs" on public.activity_logs
for all using (
  exists (select 1 from public.families where id = family_id and owner_user_id = auth.uid())
)
with check (
  exists (select 1 from public.families where id = family_id and owner_user_id = auth.uid())
);

insert into storage.buckets (id, name, public, file_size_limit)
values ('family-documents', 'family-documents', false, 104857600)
on conflict (id) do update set public = false, file_size_limit = 104857600;

drop policy if exists "Storage bucket access stays private" on storage.objects;
drop policy if exists "Family docs can be uploaded by owner" on storage.objects;
drop policy if exists "Family docs can be updated by owner" on storage.objects;
drop policy if exists "Family docs can be deleted by owner" on storage.objects;
drop policy if exists "Family owners can access their stored files" on storage.objects;
drop policy if exists "Family owners can upload stored files" on storage.objects;
drop policy if exists "Family owners can update stored files" on storage.objects;
drop policy if exists "Family owners can delete stored files" on storage.objects;

create policy "Family owners can access their stored files" on storage.objects
for select to authenticated using (
  bucket_id = 'family-documents'
  and (
    (storage.foldername(name))[1] = auth.uid()::text
    or exists (
      select 1 from public.families f
      where f.id::text = (storage.foldername(name))[1]
        and f.owner_user_id = auth.uid()
    )
  )
);

create policy "Family owners can upload stored files" on storage.objects
for insert to authenticated with check (
  bucket_id = 'family-documents'
  and (
    (storage.foldername(name))[1] = auth.uid()::text
    or exists (
      select 1 from public.families f
      where f.id::text = (storage.foldername(name))[1]
        and f.owner_user_id = auth.uid()
    )
  )
);

create policy "Family owners can update stored files" on storage.objects
for update to authenticated using (
  bucket_id = 'family-documents'
  and (
    (storage.foldername(name))[1] = auth.uid()::text
    or exists (
      select 1 from public.families f
      where f.id::text = (storage.foldername(name))[1]
        and f.owner_user_id = auth.uid()
    )
  )
)
with check (
  bucket_id = 'family-documents'
  and (
    (storage.foldername(name))[1] = auth.uid()::text
    or exists (
      select 1 from public.families f
      where f.id::text = (storage.foldername(name))[1]
        and f.owner_user_id = auth.uid()
    )
  )
);

create policy "Family owners can delete stored files" on storage.objects
for delete to authenticated using (
  bucket_id = 'family-documents'
  and (
    (storage.foldername(name))[1] = auth.uid()::text
    or exists (
      select 1 from public.families f
      where f.id::text = (storage.foldername(name))[1]
        and f.owner_user_id = auth.uid()
    )
  )
);

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'family_members') then
      alter publication supabase_realtime add table public.family_members;
    end if;
    if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'documents') then
      alter publication supabase_realtime add table public.documents;
    end if;
    if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'passports') then
      alter publication supabase_realtime add table public.passports;
    end if;
  end if;
end $$;
