-- Middagsboken: kör hela den här filen en gång i Supabase (SQL Editor → New query → klistra in → Run).

-- 1. Tabeller
create table if not exists public.recipes (
  id          text primary key,
  name        text not null,
  time        text default '',
  servings    integer default 4,
  tags        jsonb default '[]'::jsonb,
  ingredients jsonb default '[]'::jsonb,
  steps       jsonb default '[]'::jsonb,
  updated_at  timestamptz default now()
);

create table if not exists public.weeks (
  id         text primary key,          -- t.ex. 2026-v41
  data       jsonb not null default '{}'::jsonb,
  updated_at timestamptz default now()
);

-- 2. Säkerhet: bara inloggade familjemedlemmar kan läsa och ändra
alter table public.recipes enable row level security;
alter table public.weeks   enable row level security;

drop policy if exists "Inloggade får allt" on public.recipes;
create policy "Inloggade får allt" on public.recipes
  for all to authenticated using (true) with check (true);

drop policy if exists "Inloggade får allt" on public.weeks;
create policy "Inloggade får allt" on public.weeks
  for all to authenticated using (true) with check (true);

-- 3. Live-uppdatering mellan telefoner
do $$ begin
  alter publication supabase_realtime add table public.recipes;
exception when duplicate_object then null; end $$;
do $$ begin
  alter publication supabase_realtime add table public.weeks;
exception when duplicate_object then null; end $$;

-- 4. Startrecept (bara första gången, innan familjer fanns)
do $seed$ begin
  if not exists (select 1 from information_schema.columns
                 where table_schema = 'public' and table_name = 'recipes' and column_name = 'family_id') then
insert into public.recipes (id, name, time, servings, tags, ingredients, steps) values
  ($q$kottbullar$q$, $q$Köttbullar med potatismos$q$, $q$45$q$, 4, $q$["Kött","Klassiker"]$q$::jsonb, $q$["500 g blandfärs","1 gul lök","1 ägg","0,5 dl ströbröd","1 dl mjölk","1 kg potatis","2 dl mjölk","30 g smör","2 dl grädde","1 msk soja","1 burk lingonsylt","Salt och peppar"]$q$::jsonb, $q$["Blanda ströbröd och 1 dl mjölk, låt svälla 5 minuter.","Riv eller finhacka löken. Blanda färs, lök, ägg och ströbrödsblandningen. Salta och peppra.","Rulla bullar och stek dem gyllene i smör, ca 8 minuter.","Koka potatisen mjuk, häll av och mosa med varm mjölk och smör.","Häll grädde och soja i stekpannan, låt puttra till en sås.","Servera med mos, sås och lingonsylt."]$q$::jsonb),
  ($q$laxugn$q$, $q$Ugnsbakad lax med citron och dill$q$, $q$30$q$, 4, $q$["Fisk","Snabbt"]$q$::jsonb, $q$["600 g laxfilé","1 citron","1 knippe dill","800 g potatis","2 dl crème fraiche","Salt och peppar"]$q$::jsonb, $q$["Sätt ugnen på 200 grader. Koka potatisen.","Lägg laxen i en form, salta, peppra och lägg på citronskivor.","Baka i ugnen ca 15–18 minuter.","Rör ner hackad dill i crème fraiche.","Servera laxen med potatis och dillsås."]$q$::jsonb),
  ($q$pyttipanna$q$, $q$Pytt i panna$q$, $q$30$q$, 4, $q$["Kött","Snabbt","Klassiker"]$q$::jsonb, $q$["800 g kokt potatis","400 g kokt skinka eller korv","1 gul lök","4 ägg","1 burk inlagda rödbetor","30 g smör","Salt och peppar"]$q$::jsonb, $q$["Tärna potatis, kött och lök.","Stek löken mjuk i smör, tillsätt potatis och stek tills den får färg.","Lägg i köttet och stek några minuter till. Smaka av med salt och peppar.","Stek äggen och servera ovanpå med rödbetor."]$q$::jsonb),
  ($q$kycklinggryta$q$, $q$Krämig kycklinggryta med ris$q$, $q$35$q$, 4, $q$["Kyckling","Barnvänligt"]$q$::jsonb, $q$["600 g kycklingfilé","1 gul lök","2 klyftor vitlök","1 röd paprika","3 dl matlagningsgrädde","2 msk tomatpuré","1 tsk paprikapulver","3 dl ris","Salt och peppar"]$q$::jsonb, $q$["Koka riset enligt förpackningen.","Skär kycklingen i bitar och bryn den i en stor panna.","Lägg i hackad lök, vitlök och paprika och fräs ett par minuter.","Rör ner tomatpuré, paprikapulver och grädde. Låt puttra 10 minuter.","Smaka av och servera med riset."]$q$::jsonb),
  ($q$pastapesto$q$, $q$Pasta med pesto och ugnsrostade tomater$q$, $q$20$q$, 4, $q$["Vegetariskt","Snabbt"]$q$::jsonb, $q$["400 g pasta","1 burk grön pesto","250 g körsbärstomater","1 påse ruccola","50 g parmesan","2 msk olivolja","Salt"]$q$::jsonb, $q$["Sätt ugnen på 225 grader. Rosta tomaterna med olivolja och salt i 12 minuter.","Koka pastan.","Blanda pastan med pesto.","Toppa med tomater, ruccola och riven parmesan."]$q$::jsonb),
  ($q$tacos$q$, $q$Fredagstacos$q$, $q$30$q$, 4, $q$["Kött","Barnvänligt","Fredag"]$q$::jsonb, $q$["500 g nötfärs","1 påse tacokrydda","8 st tortillabröd","1 isbergssallad","2 tomater","1 gurka","1 burk majs","2 dl riven ost","1 burk tacosås","2 dl gräddfil"]$q$::jsonb, $q$["Bryn färsen och tillsätt tacokrydda och vatten enligt påsen.","Skär grönsakerna i små bitar.","Värm tortillabröden.","Ställ fram allt och låt alla bygga sina egna tacos."]$q$::jsonb),
  ($q$linssoppa$q$, $q$Röd linssoppa$q$, $q$30$q$, 4, $q$["Vegetariskt","Soppa"]$q$::jsonb, $q$["3 dl röda linser","1 gul lök","2 klyftor vitlök","2 morötter","1 burk krossade tomater","1 l grönsaksbuljong","1 tsk spiskummin","2 dl kokosmjölk","Salt och peppar"]$q$::jsonb, $q$["Fräs hackad lök, vitlök och morot i en kastrull.","Tillsätt linser, tomater, buljong och spiskummin.","Koka ca 15 minuter tills linserna är mjuka.","Rör ner kokosmjölken och mixa soppan slät. Smaka av."]$q$::jsonb),
  ($q$fiskgratang$q$, $q$Fiskgratäng med räkor$q$, $q$40$q$, 4, $q$["Fisk"]$q$::jsonb, $q$["600 g torskfilé","150 g räkor","3 dl matlagningsgrädde","1 dl riven ost","1 citron","1 knippe dill","1 kg potatis","Salt och peppar"]$q$::jsonb, $q$["Sätt ugnen på 200 grader. Koka potatisen.","Lägg fisken i en ugnsform och salta och peppra.","Strö över räkor och hackad dill. Häll över grädden och riv lite citronskal.","Toppa med ost och gratinera ca 20 minuter.","Servera med potatis."]$q$::jsonb)
on conflict (id) do nothing;
  end if;
end $seed$;

-- =====================================================================
-- Version 2: bilder, källa, betyg. Ofarligt att köra flera gånger.
-- =====================================================================

-- 5. Bild och källa på recept
alter table public.recipes add column if not exists image  text default '';
alter table public.recipes add column if not exists source text default '';

-- 6. Betyg: varje person sätter 1–5 stjärnor per recept
create table if not exists public.ratings (
  recipe_id  text not null references public.recipes(id) on delete cascade,
  user_id    uuid not null default auth.uid() references auth.users(id) on delete cascade,
  stars      integer not null check (stars between 1 and 5),
  updated_at timestamptz default now(),
  primary key (recipe_id, user_id)
);
alter table public.ratings enable row level security;

drop policy if exists "Inloggade ser alla betyg" on public.ratings;
create policy "Inloggade ser alla betyg" on public.ratings
  for select to authenticated using (true);

drop policy if exists "Man sätter sina egna betyg" on public.ratings;
create policy "Man sätter sina egna betyg" on public.ratings
  for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());

do $$ begin
  alter publication supabase_realtime add table public.ratings;
exception when duplicate_object then null; end $$;

-- 7. Bildlagring (mappen "bilder")
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('bilder', 'bilder', true, 5242880, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do nothing;

drop policy if exists "Inloggade ser bilder" on storage.objects;
create policy "Inloggade ser bilder" on storage.objects
  for select to authenticated using (bucket_id = 'bilder');

drop policy if exists "Inloggade laddar upp bilder" on storage.objects;
create policy "Inloggade laddar upp bilder" on storage.objects
  for insert to authenticated with check (bucket_id = 'bilder');

drop policy if exists "Inloggade ändrar bilder" on storage.objects;
create policy "Inloggade ändrar bilder" on storage.objects
  for update to authenticated using (bucket_id = 'bilder');

drop policy if exists "Inloggade tar bort bilder" on storage.objects;
create policy "Inloggade tar bort bilder" on storage.objects
  for delete to authenticated using (bucket_id = 'bilder');

-- Uppdatera appens cache av databasens struktur
notify pgrst, 'reload schema';

-- =====================================================================
-- Version 3: familjer. Varje familj har egna recept, menyer och betyg.
-- Ofarligt att köra flera gånger.
-- =====================================================================

-- 8. Familjer och medlemmar
create table if not exists public.families (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  invite_code text unique not null,
  created_by  uuid references auth.users(id) on delete set null,
  created_at  timestamptz default now()
);

create table if not exists public.family_members (
  family_id    uuid not null references public.families(id) on delete cascade,
  user_id      uuid not null references auth.users(id) on delete cascade,
  role         text not null default 'member' check (role in ('owner', 'member')),
  display_name text not null default '',
  joined_at    timestamptz default now(),
  primary key (family_id, user_id)
);

alter table public.families       enable row level security;
alter table public.family_members enable row level security;

-- Hjälpfunktioner för reglerna
create or replace function public.is_member(fid uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from family_members where family_id = fid and user_id = auth.uid());
$$;

create or replace function public.is_owner(fid uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from family_members where family_id = fid and user_id = auth.uid() and role = 'owner');
$$;

create or replace function public.new_code() returns text
language plpgsql volatile set search_path = public as $$
declare c text;
begin
  loop
    c := upper(substr(translate(md5(random()::text || clock_timestamp()::text), '01', ''), 1, 6));
    exit when length(c) = 6 and not exists (select 1 from families where invite_code = c);
  end loop;
  return c;
end $$;

-- 9. Flytta befintliga recept och menyer till en första familj
alter table public.recipes add column if not exists family_id uuid references public.families(id) on delete cascade;
alter table public.weeks   add column if not exists family_id uuid references public.families(id) on delete cascade;

do $$
declare fid uuid;
begin
  if exists (select 1 from public.recipes where family_id is null)
     or exists (select 1 from public.weeks where family_id is null) then
    insert into public.families (name, invite_code) values ('Min familj', public.new_code()) returning id into fid;
    insert into public.family_members (family_id, user_id, role, display_name)
      select fid, u.id,
             case when row_number() over (order by u.created_at) = 1 then 'owner' else 'member' end,
             coalesce(nullif(u.raw_user_meta_data->>'name', ''), split_part(u.email, '@', 1))
      from auth.users u
      on conflict do nothing;
    update public.recipes set family_id = fid where family_id is null;
    update public.weeks   set family_id = fid where family_id is null;
  end if;
end $$;

alter table public.recipes alter column family_id set not null;
alter table public.weeks   alter column family_id set not null;

-- Samma veckonummer kan nu finnas i flera familjer
alter table public.weeks drop constraint if exists weeks_pkey;
alter table public.weeks add primary key (family_id, id);

create index if not exists recipes_family_idx on public.recipes (family_id);

-- 10. Regler: man ser och ändrar bara sin egen familjs saker
drop policy if exists "Inloggade får allt" on public.recipes;
drop policy if exists "Familjen får allt" on public.recipes;
create policy "Familjen får allt" on public.recipes
  for all to authenticated using (public.is_member(family_id)) with check (public.is_member(family_id));

drop policy if exists "Inloggade får allt" on public.weeks;
drop policy if exists "Familjen får allt" on public.weeks;
create policy "Familjen får allt" on public.weeks
  for all to authenticated using (public.is_member(family_id)) with check (public.is_member(family_id));

drop policy if exists "Inloggade ser alla betyg" on public.ratings;
drop policy if exists "Familjen ser betyg" on public.ratings;
create policy "Familjen ser betyg" on public.ratings
  for select to authenticated
  using (exists (select 1 from public.recipes r where r.id = recipe_id and public.is_member(r.family_id)));

drop policy if exists "Man sätter sina egna betyg" on public.ratings;
create policy "Man sätter sina egna betyg" on public.ratings
  for all to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid() and exists (select 1 from public.recipes r where r.id = recipe_id and public.is_member(r.family_id)));

drop policy if exists "Medlemmar ser familjen" on public.families;
create policy "Medlemmar ser familjen" on public.families
  for select to authenticated using (public.is_member(id));

drop policy if exists "Ägare ändrar familjen" on public.families;
create policy "Ägare ändrar familjen" on public.families
  for update to authenticated using (public.is_owner(id)) with check (public.is_owner(id));

drop policy if exists "Ägare tar bort familjen" on public.families;
create policy "Ägare tar bort familjen" on public.families
  for delete to authenticated using (public.is_owner(id));

drop policy if exists "Medlemmar ser varandra" on public.family_members;
create policy "Medlemmar ser varandra" on public.family_members
  for select to authenticated using (public.is_member(family_id));

drop policy if exists "Lämna eller ta bort medlem" on public.family_members;
create policy "Lämna eller ta bort medlem" on public.family_members
  for delete to authenticated using (user_id = auth.uid() or public.is_owner(family_id));

-- 11. Funktioner som appen anropar
create or replace function public.create_family(p_name text, p_display text)
returns uuid language plpgsql security definer set search_path = public as $$
declare fid uuid;
begin
  if auth.uid() is null then raise exception 'Inte inloggad'; end if;
  insert into families (name, invite_code, created_by)
    values (coalesce(nullif(trim(p_name), ''), 'Min familj'), new_code(), auth.uid())
    returning id into fid;
  insert into family_members (family_id, user_id, role, display_name)
    values (fid, auth.uid(), 'owner', coalesce(trim(p_display), ''));
  return fid;
end $$;

create or replace function public.family_name_by_code(p_code text)
returns text language sql stable security definer set search_path = public as $$
  select name from families where invite_code = upper(trim(p_code));
$$;

create or replace function public.join_family(p_code text, p_display text)
returns uuid language plpgsql security definer set search_path = public as $$
declare fid uuid;
begin
  if auth.uid() is null then raise exception 'Inte inloggad'; end if;
  select id into fid from families where invite_code = upper(trim(p_code));
  if fid is null then raise exception 'Okänd kod'; end if;
  insert into family_members (family_id, user_id, role, display_name)
    values (fid, auth.uid(), 'member', coalesce(trim(p_display), ''))
    on conflict (family_id, user_id) do nothing;
  return fid;
end $$;

create or replace function public.new_invite_code(fid uuid)
returns text language plpgsql security definer set search_path = public as $$
declare c text;
begin
  if not is_owner(fid) then raise exception 'Bara ägaren kan byta kod'; end if;
  c := new_code();
  update families set invite_code = c where id = fid;
  return c;
end $$;

create or replace function public.set_display_name(p_name text)
returns void language sql security definer set search_path = public as $$
  update family_members set display_name = trim(p_name) where user_id = auth.uid();
$$;

create or replace function public.set_member_role(fid uuid, uid uuid, p_role text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not is_owner(fid) then raise exception 'Bara ägaren kan ändra roller'; end if;
  if p_role not in ('owner', 'member') then raise exception 'Okänd roll'; end if;
  update family_members set role = p_role where family_id = fid and user_id = uid;
end $$;

revoke execute on function public.new_code() from public, anon, authenticated;
grant execute on function public.create_family(text, text), public.family_name_by_code(text),
  public.join_family(text, text), public.new_invite_code(uuid), public.set_display_name(text),
  public.set_member_role(uuid, uuid, text), public.is_member(uuid), public.is_owner(uuid) to authenticated;

do $$ begin
  alter publication supabase_realtime add table public.family_members;
exception when duplicate_object then null; end $$;

notify pgrst, 'reload schema';

-- =====================================================================
-- Version 4: roller, egen inköpslista, förslag och väggskärm.
-- Ofarligt att köra flera gånger.
-- =====================================================================

create table if not exists public.app_migrations (name text primary key, done_at timestamptz default now());
alter table public.app_migrations enable row level security;

-- 12. Roller: ägare, redigerare och medlem
alter table public.family_members drop constraint if exists family_members_role_check;
alter table public.family_members add constraint family_members_role_check check (role in ('owner', 'editor', 'member'));

-- De som redan var med när rollerna infördes får fortsätta redigera (görs bara en gång)
do $$ begin
  if not exists (select 1 from public.app_migrations where name = 'v4_roller') then
    update public.family_members set role = 'editor' where role = 'member';
    insert into public.app_migrations (name) values ('v4_roller');
  end if;
end $$;

create or replace function public.can_edit(fid uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from family_members where family_id = fid and user_id = auth.uid() and role in ('owner', 'editor'));
$$;

drop policy if exists "Familjen får allt" on public.recipes;
drop policy if exists "Familjen ser recept" on public.recipes;
create policy "Familjen ser recept" on public.recipes for select to authenticated using (public.is_member(family_id));
drop policy if exists "Redigerare ändrar recept" on public.recipes;
create policy "Redigerare ändrar recept" on public.recipes for all to authenticated
  using (public.can_edit(family_id)) with check (public.can_edit(family_id));

drop policy if exists "Familjen får allt" on public.weeks;
drop policy if exists "Familjen ser menyer" on public.weeks;
create policy "Familjen ser menyer" on public.weeks for select to authenticated using (public.is_member(family_id));
drop policy if exists "Redigerare ändrar menyer" on public.weeks;
create policy "Redigerare ändrar menyer" on public.weeks for all to authenticated
  using (public.can_edit(family_id)) with check (public.can_edit(family_id));

create or replace function public.set_member_role(fid uuid, uid uuid, p_role text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not is_owner(fid) then raise exception 'Bara ägaren kan ändra roller'; end if;
  if p_role not in ('owner', 'editor', 'member') then raise exception 'Okänd roll'; end if;
  if uid = auth.uid() and p_role <> 'owner'
     and not exists (select 1 from family_members where family_id = fid and role = 'owner' and user_id <> uid) then
    raise exception 'Familjen måste ha minst en ägare';
  end if;
  update family_members set role = p_role where family_id = fid and user_id = uid;
end $$;

-- 13. Inköpslistan: alla i familjen kan bocka av och ändra
create table if not exists public.shopping (
  family_id  uuid not null references public.families(id) on delete cascade,
  week_id    text not null,
  checked    jsonb not null default '[]'::jsonb,
  extras     jsonb not null default '[]'::jsonb,
  edits      jsonb not null default '{}'::jsonb,
  updated_at timestamptz default now(),
  primary key (family_id, week_id)
);
alter table public.shopping enable row level security;
drop policy if exists "Familjen handlar" on public.shopping;
create policy "Familjen handlar" on public.shopping for all to authenticated
  using (public.is_member(family_id)) with check (public.is_member(family_id));

do $$ begin
  if not exists (select 1 from public.app_migrations where name = 'v4_inkop') then
    insert into public.shopping (family_id, week_id, checked, extras)
      select family_id, id, coalesce(data->'checked', '[]'::jsonb), coalesce(data->'extras', '[]'::jsonb)
      from public.weeks
      where jsonb_array_length(coalesce(data->'checked', '[]'::jsonb)) > 0
         or jsonb_array_length(coalesce(data->'extras', '[]'::jsonb)) > 0
      on conflict do nothing;
    insert into public.app_migrations (name) values ('v4_inkop');
  end if;
end $$;

-- 14. Förslagslådan
create table if not exists public.suggestions (
  id         uuid primary key default gen_random_uuid(),
  family_id  uuid not null references public.families(id) on delete cascade,
  user_id    uuid not null default auth.uid() references auth.users(id) on delete cascade,
  recipe_id  text references public.recipes(id) on delete set null,
  text       text not null default '',
  week_id    text,
  day        integer check (day between 0 and 6),
  votes      uuid[] not null default '{}',
  status     text not null default 'open' check (status in ('open', 'done', 'dismissed')),
  created_at timestamptz default now()
);
create index if not exists suggestions_family_idx on public.suggestions (family_id, status);
alter table public.suggestions enable row level security;

drop policy if exists "Familjen ser förslag" on public.suggestions;
create policy "Familjen ser förslag" on public.suggestions for select to authenticated using (public.is_member(family_id));
drop policy if exists "Alla föreslår" on public.suggestions;
create policy "Alla föreslår" on public.suggestions for insert to authenticated
  with check (public.is_member(family_id) and user_id = auth.uid() and status = 'open' and votes = '{}');
drop policy if exists "Redigerare hanterar förslag" on public.suggestions;
create policy "Redigerare hanterar förslag" on public.suggestions for update to authenticated
  using (public.can_edit(family_id)) with check (public.can_edit(family_id));
drop policy if exists "Ta bort förslag" on public.suggestions;
create policy "Ta bort förslag" on public.suggestions for delete to authenticated
  using (user_id = auth.uid() or public.can_edit(family_id));

create or replace function public.toggle_vote(sid uuid)
returns void language plpgsql security definer set search_path = public as $$
declare fid uuid;
begin
  select family_id into fid from suggestions where id = sid;
  if fid is null or not is_member(fid) then raise exception 'Förslaget finns inte'; end if;
  update suggestions
     set votes = case when auth.uid() = any(votes) then array_remove(votes, auth.uid()) else array_append(votes, auth.uid()) end
   where id = sid;
end $$;

-- 15. Väggskärm: en hemlig nyckel som bara kan läsa veckomenyn
alter table public.families add column if not exists display_key text unique;

create or replace function public.new_display_key(fid uuid)
returns text language plpgsql security definer set search_path = public as $$
declare k text;
begin
  if not is_owner(fid) then raise exception 'Bara ägaren kan skapa visningsnyckel'; end if;
  k := md5(random()::text || clock_timestamp()::text) || substr(md5(random()::text), 1, 8);
  update families set display_key = k where id = fid;
  return k;
end $$;

create or replace function public.remove_display_key(fid uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not is_owner(fid) then raise exception 'Bara ägaren kan ta bort visningsnyckeln'; end if;
  update families set display_key = null where id = fid;
end $$;

create or replace function public.public_menu(p_key text, p_weeks text[])
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare fam families; result jsonb;
begin
  if p_key is null or length(p_key) < 20 then return null; end if;
  select * into fam from families where display_key = p_key;
  if fam.id is null then return null; end if;
  select jsonb_build_object(
    'family', fam.name,
    'weeks', coalesce(jsonb_object_agg(w.id, (
      select jsonb_agg(jsonb_build_object(
        'note', coalesce(d.value->>'note', ''),
        'name', r.name, 'image', coalesce(r.image, ''), 'time', coalesce(r.time, ''), 'tags', coalesce(r.tags, '[]'::jsonb)
      ) order by d.ordinality)
      from jsonb_array_elements(coalesce(w.data->'days', '[]'::jsonb)) with ordinality d
      left join recipes r on r.id = d.value->>'recipeId' and r.family_id = fam.id
    )), '{}'::jsonb)
  ) into result
  from weeks w where w.family_id = fam.id and w.id = any(p_weeks[1:4]);
  return coalesce(result, jsonb_build_object('family', fam.name, 'weeks', '{}'::jsonb));
end $$;

create or replace function public.join_family(p_code text, p_display text)
returns uuid language plpgsql security definer set search_path = public as $$
declare fid uuid;
begin
  if auth.uid() is null then raise exception 'Inte inloggad'; end if;
  select id into fid from families where invite_code = upper(trim(p_code));
  if fid is null then raise exception 'Okänd kod'; end if;
  insert into family_members (family_id, user_id, role, display_name)
    values (fid, auth.uid(), 'member', coalesce(trim(p_display), ''))
    on conflict (family_id, user_id) do nothing;
  return fid;
end $$;

revoke execute on function public.public_menu(text, text[]) from public;
grant execute on function public.public_menu(text, text[]) to anon, authenticated;
grant execute on function public.can_edit(uuid), public.toggle_vote(uuid), public.new_display_key(uuid),
  public.remove_display_key(uuid), public.set_member_role(uuid, uuid, text) to authenticated;

do $$ begin alter publication supabase_realtime add table public.shopping;
exception when duplicate_object then null; end $$;
do $$ begin alter publication supabase_realtime add table public.suggestions;
exception when duplicate_object then null; end $$;

notify pgrst, 'reload schema';
