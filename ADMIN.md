# Middagsboken: administration

Det finns två nivåer:

| Var | Vem | Vad du kan göra |
|---|---|---|
| **I appen**, tryck på familjens namn | Ägare av en familj | Bjuda in, ta bort medlemmar, göra andra till ägare, byta kod och namn |
| **I Supabase** (supabase.com) | Du, som äger hela appen | Se alla konton och familjer, ta bort konton, sätta nya lösenord, rätta det mesta |

---

## 1. Vanliga situationer

### Någon utomstående har skapat ett konto
**De ser ingenting.** Ett nytt konto kommer inte åt några recept förrän personen har gått med i en familj, och det kräver en giltig kod. Utan kod hamnar de på startskärmen och kan bara skapa en egen, tom familj.

Vill du ta bort kontot ändå går du till **Supabase → Authentication → Users**. Leta upp e-postadressen, tryck på **⋯** och välj **Delete user**.

### En inbjudningslänk har spridits till fel person
Som ägare trycker du på familjens namn i appen och väljer **Ny kod**. Den gamla länken och koden slutar då fungera direkt. De som redan är med påverkas inte.

Har personen hunnit gå med tar du bort hen under **Medlemmar** i samma meny, med **Ta bort** och sedan **Ja, ta bort**.

### Vill du stoppa nya konton helt?
Gå till **Supabase → Authentication → Sign In / Providers** och stäng av **Allow new users to sign up**.
Ingen ny person kan då skapa konto, inte ens med en inbjudan. Slå på det igen när du ska bjuda in någon ny.

### Någon har glömt sitt lösenord
- **Enklast:** Personen trycker **Glömt lösenordet?** på inloggningssidan och får ett mejl. Det kräver att *Site URL* är ifyllt i Supabase under **Authentication → URL Configuration**.
- **Om mejlet inte kommer fram:** Sätt ett tillfälligt lösenord själv med kommando **E** nedan. Be sedan personen byta det i appen under statusknappen → **Byt lösenord**.

### Någon ser fel familj eller appen beter sig konstigt
Gör så här på personens telefon, i den här ordningen:
1. Tryck på statusknappen uppe till höger och välj **Uppdatera nu**.
2. Välj **Logga ut** och logga in igen.
3. Ta bort appen från hemskärmen, öppna adressen i Safari igen och lägg till den på nytt.

Recepten ligger kvar i databasen, så inget försvinner.

### Ägaren har lämnat och ingen kan längre administrera familjen
Gör en annan person till ägare med kommando **C** nedan.

### Någon har råkat ta bort ett recept
Det går inte att ångra i appen. Supabase gratisversion har inga automatiska säkerhetskopior som går att återställa från. Exportera gärna en kopia då och då med kommando **G**.

---

## 2. Färdiga kommandon i Supabase

Gå till **Supabase → SQL Editor → New query**, klistra in ett kommando, ändra det som står i *'citattecken'* och tryck **Run**.
Här i SQL Editor gäller inte appens säkerhetsregler, så du ser och kan ändra allt. Dubbelkolla innan du tar bort något.

**A. Översikt: alla familjer och medlemmar**
```sql
select f.name as familj, f.invite_code as kod, m.display_name as namn,
       u.email as epost, m.role as roll, u.last_sign_in_at as senast_inloggad
from family_members m
join families f on f.id = m.family_id
join auth.users u on u.id = m.user_id
order by f.name, m.role desc, m.display_name;
```

**B. Konton som inte är med i någon familj**, till exempel okända personer
```sql
select email, created_at as skapad, last_sign_in_at as senast_inloggad
from auth.users u
where not exists (select 1 from family_members m where m.user_id = u.id)
order by created_at desc;
```

**C. Gör någon till ägare av en familj**
```sql
update family_members set role = 'owner'
where user_id   = (select id from auth.users where email = 'anna@exempel.se')
  and family_id = (select id from families where name = 'Familjen Lind');
```

**D. Ta bort någon från en familj.** Kontot finns kvar.
```sql
delete from family_members
where user_id   = (select id from auth.users where email = 'anna@exempel.se')
  and family_id = (select id from families where name = 'Familjen Lind');
```

**E. Sätt ett tillfälligt lösenord åt någon**
```sql
update auth.users
set encrypted_password = crypt('TillfalligtLosen123', gen_salt('bf'))
where email = 'anna@exempel.se';
```

**F. Familjer utan medlemmar, och hur du tar bort dem.** Alla deras recept och menyer raderas också.
```sql
-- Visa
select f.name, f.created_at, (select count(*) from recipes r where r.family_id = f.id) as recept
from families f
where not exists (select 1 from family_members m where m.family_id = f.id);

-- Ta bort (kör bara om listan ovan ser rätt ut)
delete from families f
where not exists (select 1 from family_members m where m.family_id = f.id);
```

**G. Säkerhetskopiera en familjs recept**
```sql
select name, time, servings, tags, ingredients, steps, source
from recipes
where family_id = (select id from families where name = 'Familjen Lind')
order by name;
```
Tryck sedan **Export → CSV** ovanför resultatet och spara filen.

**H. Byt inbjudningskod åt en familj**
```sql
update families set invite_code = new_code() where name = 'Familjen Lind'
returning invite_code;
```

---

## 3. Bra att veta om säkerheten

- Varje familj ser **bara sina egna** recept, menyer och betyg. Det styrs av databasen och inte av appen, så det går inte att komma runt genom att ändra i appen.
- Bara **ägare** kan byta kod, ta bort andra och göra andra till ägare. Vanliga medlemmar kan lämna själva, och kan ändra och ta bort recept.
- Nyckeln i `config.js` är gjord för att vara offentlig. Nyckeln som heter **service_role** eller **Secret** i Supabase får aldrig delas.
- Bilder ligger i en mapp där den som har den exakta, slumpmässiga adressen kan se bilden. Lägg inte in bilder som är känsliga.
