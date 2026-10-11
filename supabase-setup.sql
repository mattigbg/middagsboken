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

-- 4. Startrecept (hoppar över de som redan finns)
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
