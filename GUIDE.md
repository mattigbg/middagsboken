# Middagsboken: så kommer ni igång

Appen består av två delar:

- **Supabase** är databasen. Där sparas recept och veckomenyer, och där finns familjens inloggningar.
- **GitHub Pages** är webbadressen där appen ligger, till exempel `https://dittnamn.github.io/middagsboken`.

Båda är gratis. Du gör stegen nedan en gång, och resten sköter Claude.

---

## Del 1: Databasen (Supabase), cirka 10 minuter

1. Gå till **supabase.com** och tryck **Start your project**. Skapa ett konto. Det enklaste är att välja "Continue with GitHub" om du redan har gjort del 2.
2. Tryck **New project**:
   - Name: `middagsboken`
   - Database Password: välj ett lösenord och spara det någonstans. Appen behöver det inte, men det är bra att ha.
   - Region: **North EU (Stockholm)**
   - Tryck **Create new project** och vänta ett par minuter.
3. Välj **SQL Editor** i menyn till vänster och tryck sedan **New query**.
   Öppna filen `supabase-setup.sql`, kopiera **allt** innehåll, klistra in det och tryck **Run**.
   Det ska stå "Success". Nu finns tabellerna och de 8 startrecepten.
4. Välj **Authentication**, sedan **Users** och **Add user**, och sist **Create new user**:
   - Fyll i e-post och lösenord för dig själv.
   - Kryssa i **Auto Confirm User**.
   - Upprepa för varje familjemedlem.
5. Välj **Authentication** och sedan **Sign In / Providers** (ibland heter det "Providers" eller "Settings").
   Stäng av **Allow new users to sign up**. Då kan ingen utomstående skapa ett konto.
6. Gå till **Project Settings** (kugghjulet) och välj **API** eller **API Keys**. Kopiera:
   - **Project URL**, till exempel `https://abcdefgh.supabase.co`
   - **anon public**-nyckeln eller **Publishable key**. Det är en lång textsträng.

   Skicka båda till Claude. Den här nyckeln är gjord för att ligga i appen och är inte hemlig. Det som skyddar era data är inloggningen.
   Skicka **aldrig** nyckeln som heter `service_role` eller "Secret key".

## Del 2: Webbadressen (GitHub), cirka 5 minuter

1. Gå till **github.com** och skapa ett gratis konto. Användarnamnet syns i adressen, till exempel `dittnamn.github.io`.
2. Gå till **claude.ai/connect-github** och koppla ditt GitHub-konto till Claude.
3. Tryck **+** uppe till höger på GitHub och välj **New repository**:
   - Repository name: `middagsboken`
   - Välj **Public**. Det krävs för gratis GitHub Pages. Koden syns då, men inte era recept, eftersom de ligger bakom inloggningen.
   - Tryck **Create repository**.
4. Berätta för Claude att det är klart och skriv ditt GitHub-användarnamn. Claude laddar upp appen.
5. När Claude har laddat upp appen går du till repositoryt på GitHub och väljer **Settings**, sedan **Pages**:
   - Under Source väljer du **Deploy from a branch**.
   - Under Branch väljer du **main** och **/ (root)** och trycker sedan **Save**.
   - Efter ungefär en minut visas adressen överst, till exempel `https://dittnamn.github.io/middagsboken/`.
6. Gå tillbaka till Supabase och välj **Authentication** och sedan **URL Configuration**. Klistra in adressen i **Site URL** och tryck **Save**. Då fungerar "Glömt lösenordet?".

## Del 3: Installera på iPhone

1. Öppna adressen i **Safari**. Det måste vara Safari, inte Chrome.
2. Tryck på **Dela**-knappen (rutan med pilen uppåt).
3. Scrolla ner och välj **Lägg till på hemskärmen** och tryck sedan **Lägg till**.
4. Öppna appen från hemskärmen och logga in med e-post och lösenord från del 1.

Gör samma sak på varje familjemedlems telefon.

---

## Bra att veta

- **Utan internet:** Appen öppnas ändå och visar det som senast hämtades. Det ni ändrar sparas när telefonen är online igen.
- **Live:** När någon lägger till ett recept eller ändrar veckomenyn syns det direkt hos de andra.
- **Byta lösenord:** Tryck på statusknappen uppe till höger och välj "Byt lösenord".
- **Lägga till fler i familjen:** Använd Supabase, Authentication och Users som i del 1 steg 4.
- **Kostnad:** 0 kr. Supabase pausar gratisprojekt som inte har använts på 7 dagar. Ni öppnar det igen med ett klick på supabase.com, och ingen data försvinner.

---

## Familjer (från version 3)

Varje person har ett eget konto och kan vara med i en eller flera familjer. Varje familj har egna recept, en egen veckomeny och egna betyg.

**Inställningar i Supabase (görs en gång):**
1. Gå till **Authentication → Sign In / Providers** och slå **på** *Allow new users to sign up*. Då kan de du bjuder in skapa egna konton.
2. Under **Email** på samma sida stänger du **av** *Confirm email*. Då kommer man in direkt utan att behöva bekräfta via mejl. Supabase gratismejl kan bara skicka ett par mejl i timmen.

**Bjuda in någon:**
1. Tryck på familjens namn högst upp i appen.
2. Tryck **Dela inbjudan** och skicka länken med SMS, Messenger eller något annat.
3. Personen öppnar länken, skapar ett konto och trycker **Gå med**.

Det går också att ge dem den sexsiffriga **koden**, som de skriver in under "Gå med i en familj".

**Flera familjer:** Tryck på familjens namn och välj **Skapa eller gå med i en annan familj**. Du byter familj i samma meny. Recept kan kopieras mellan familjer med **Kopiera till annan familj**.

---

## Roller (från version 4)

| Roll | Kan |
|---|---|
| **Medlem** | Se allt, betygsätta, bocka av och ändra inköpslistan, föreslå middagar och rösta på förslag |
| **Redigerare** | Allt ovan, plus ändra veckomenyn och recepten |
| **Ägare** | Allt ovan, plus bjuda in, ändra roller, ta bort medlemmar och skapa länk till väggskärm |

Nya medlemmar börjar som **Medlem**. Ägaren ändrar roll genom att trycka på familjens namn och välja roll i listan vid personen.

## Väggskärm i Home Assistant

1. I appen trycker du på familjens namn, väljer **Skapa länk till väggskärm** och sedan **Kopiera länk**. Bara ägaren ser det här.
2. I Home Assistant öppnar du dashboarden och väljer **✎ Redigera → + Lägg till kort → Webbsida** (Webpage).
3. Klistra in länken som **URL** och spara.
4. Vill du att menyn ska fylla hela skärmen skapar du en ny **vy** av typen **Panel (ett kort)** och lägger webbsidekortet där.

Vill du alltid ha mörkt eller ljust tema lägger du till `&tema=mörk` eller `&tema=ljus` sist i länken.
Om länken har spridits trycker du **Ny länk**. Då slutar den gamla fungera, och du behöver klistra in den nya i Home Assistant.

## Matlagningsläge, dela och exportera

- **Laga** i ett recept håller skärmen tänd (kräver iOS 18.4 eller senare) och låter dig bocka av ingredienser och steg.
- **Dela** skickar receptet som text, till exempel via Messenger eller SMS.
- **Skriv ut** gör en A4-sida. På iPhone kan du spara den som PDF via Dela och sedan Spara i Filer.
- **Recept → Exportera** sparar en säkerhetskopia av alla recept eller skriver ut en hel receptbok. Säkerhetskopian läser du in igen under **Importera → Från säkerhetskopia**.
