(() => {
  "use strict";

  const APP_VERSION = "4";

  // ---------- hjälpfunktioner ----------
  const DAYS = ["Måndag", "Tisdag", "Onsdag", "Torsdag", "Fredag", "Lördag", "Söndag"];
  const MON = ["jan", "feb", "mars", "apr", "maj", "juni", "juli", "aug", "sep", "okt", "nov", "dec"];
  const $ = (s, el = document) => el.querySelector(s);
  const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const h = html => { const t = document.createElement("template"); t.innerHTML = html.trim(); return t.content.firstElementChild; };
  const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
  const mondayOf = d => { const x = new Date(d); x.setHours(0, 0, 0, 0); x.setDate(x.getDate() - ((x.getDay() + 6) % 7)); return x; };
  function isoWeek(d) {
    const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
    const day = t.getUTCDay() || 7; t.setUTCDate(t.getUTCDate() + 4 - day);
    const y0 = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
    return { year: t.getUTCFullYear(), week: Math.ceil(((t - y0) / 864e5 + 1) / 7) };
  }
  const keyFor = (year, week) => `${year}-v${String(week).padStart(2, "0")}`;
  const weekKey = mon => { const w = isoWeek(mon); return keyFor(w.year, w.week); };
  function mondayFromKey(key) {
    const m = /^(\d{4})-v(\d{2})$/.exec(key); if (!m) return null;
    return addDays(mondayOf(new Date(+m[1], 0, 4)), (+m[2] - 1) * 7);
  }
  const fmtDate = d => `${d.getDate()} ${MON[d.getMonth()]}`;
  const fmtDateYear = d => `${d.getDate()} ${MON[d.getMonth()]} ${d.getFullYear()}`;
  const fmtNum = n => String(Math.round(n * 10) / 10).replace(".", ",");
  const newId = () => "r" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  const lsGet = (k, fb) => { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : fb; } catch { return fb; } };
  const lsSet = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch { return false; } };
  const lsDel = k => { try { localStorage.removeItem(k); } catch {} };
  const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  const isStandalone = window.navigator.standalone === true || window.matchMedia("(display-mode: standalone)").matches;
  const today0 = () => { const t = new Date(); t.setHours(0, 0, 0, 0); return t; };

  let toastTimer;
  function toast(msg) {
    document.querySelectorAll(".toast").forEach(n => n.remove());
    const n = h(`<div class="toast" role="status">${esc(msg)}</div>`); document.body.append(n);
    clearTimeout(toastTimer); toastTimer = setTimeout(() => n.remove(), 2600);
  }
  function setSync(text, kind = "") {
    const s = $("#sync"); s.textContent = text; s.className = "sync " + kind;
  }

  // ---------- lagring: Supabase i molnet, med kopia i telefonen ----------
  const CFG = window.MIDDAG_CONFIG || {};
  const CLOUD = !!(CFG.supabaseUrl && CFG.supabaseKey && window.supabase);
  const K_OUTBOX = "mb-outbox", K_FAMILY = "mb-family", K_JOIN = "mb-join";
  const cacheKey = fid => "mb-cache-" + (fid || "local");
  const BUCKET = "bilder";
  const opKey = op => (op.fid || "") + "/" + ({ r: "r", rd: "r", w: "w", rt: "t", s: "s" }[op.k]) + ":" + op.id;

  const store = {
    sb: null, user: null, me: CLOUD ? null : "me",
    family: null,          // id för vald familj
    families: [],          // [{id, name, invite_code, role}]
    members: {},           // user_id -> {name, role} i vald familj
    recipes: {}, weeks: {}, ratings: {}, shopping: {}, suggestions: [],
    outbox: lsGet(K_OUTBOX, []),
    flushing: false, channel: null, needsDbUpdate: false,

    get current() { return this.families.find(f => f.id === this.family) || null; },
    get myName() {
      const m = this.user && this.user.user_metadata;
      return (m && m.name) || (this.user && this.user.email ? this.user.email.split("@")[0] : "");
    },

    saveCache() {
      const ok = lsSet(cacheKey(this.family), { recipes: this.recipes, weeks: this.weeks, ratings: this.ratings, members: this.members, shopping: this.shopping, suggestions: this.suggestions });
      if (!ok && !CLOUD) toast("Telefonens lagring är full. Ta bort några bilder.");
      if (CLOUD) lsSet("mb-families", this.families);
    },
    loadCache() {
      const c = lsGet(cacheKey(this.family), null);
      this.recipes = (c && c.recipes) || {}; this.weeks = (c && c.weeks) || {};
      this.ratings = (c && c.ratings) || {}; this.members = (c && c.members) || {};
      this.shopping = (c && c.shopping) || {}; this.suggestions = (c && c.suggestions) || [];
      return !!c;
    },

    apply(op) {
      if (CLOUD && op.fid !== this.family) return; // ändringen gäller en annan familj
      if (op.k === "r") this.recipes[op.id] = op.data;
      else if (op.k === "rd") { delete this.recipes[op.id]; delete this.ratings[op.id]; }
      else if (op.k === "w") this.weeks[op.id] = op.data;
      else if (op.k === "s") this.shopping[op.id] = op.data;
      else if (op.k === "rt") {
        const r = { ...(this.ratings[op.id] || {}) };
        if (op.stars) r[this.me] = op.stars; else delete r[this.me];
        this.ratings[op.id] = r;
      }
    },

    // Alla ändringar går hit: visas direkt, sparas i molnet så fort det går.
    change(op) {
      op = { ...op, fid: op.fid || this.family };
      this.apply(op);
      this.saveCache();
      if (CLOUD) {
        const key = opKey(op);
        this.outbox = this.outbox.filter(o => opKey(o) !== key);
        this.outbox.push(op);
        lsSet(K_OUTBOX, this.outbox);
        this.flush();
      }
      render();
    },

    async flush() {
      if (!CLOUD || !this.user || this.flushing) return;
      this.flushing = true;
      try {
        while (this.outbox.length) {
          setSync("Sparar…");
          const op = this.outbox[0];
          let res;
          const now = new Date().toISOString();
          if (!op.fid) res = { error: null };
          else if (op.k === "r") res = await this.sb.from("recipes").upsert({ id: op.id, family_id: op.fid, ...recipeToRow(op.data), updated_at: now });
          else if (op.k === "rd") res = await this.sb.from("recipes").delete().eq("id", op.id);
          else if (op.k === "w") res = await this.sb.from("weeks").upsert({ family_id: op.fid, id: op.id, data: op.data, updated_at: now }, { onConflict: "family_id,id" });
          else if (op.k === "s") res = await this.sb.from("shopping").upsert({ family_id: op.fid, week_id: op.id, checked: op.data.checked || [], extras: op.data.extras || [], edits: op.data.edits || {}, updated_at: now }, { onConflict: "family_id,week_id" });
          else if (op.k === "rt") res = op.stars
            ? await this.sb.from("ratings").upsert({ recipe_id: op.id, user_id: this.me, stars: op.stars, updated_at: now })
            : await this.sb.from("ratings").delete().eq("recipe_id", op.id).eq("user_id", this.me);
          if (res.error) {
            if (isNetworkError(res.error)) { setSync("Offline", "warn"); return; }
            if (isAuthError(res.error)) { await this.sb.auth.refreshSession().catch(() => {}); setSync("Logga in igen", "warn"); return; }
            if (isSchemaError(res.error)) { this.needsDbUpdate = true; setSync("Databasen behöver uppdateras", "warn"); render(); return; }
            console.error(res.error);
            toast(/row-level security|permission/i.test(errText(res.error))
              ? "Ändringen sparades inte. Du har inte behörighet att ändra det här."
              : "En ändring kunde inte sparas: " + (res.error.message || "okänt fel"));
          }
          this.outbox.shift();
          lsSet(K_OUTBOX, this.outbox);
        }
        setSync("Synkad", "ok");
      } catch (e) {
        setSync("Offline", "warn");
      } finally {
        this.flushing = false;
      }
    },

    // Hämtar vilka familjer man är med i.
    async loadFamilies() {
      const { data, error } = await this.sb.from("family_members")
        .select("role, families(id, name, invite_code, display_key)").eq("user_id", this.me);
      if (error) {
        if (isSchemaError(error)) { this.needsDbUpdate = true; return "schema"; }
        this.families = lsGet("mb-families", []);
        return isNetworkError(error) ? "offline" : "error";
      }
      this.families = (data || []).filter(r => r.families).map(r => ({ ...r.families, role: r.role }))
        .sort((a, b) => a.name.localeCompare(b.name, "sv"));
      lsSet("mb-families", this.families);
      return "ok";
    },

    async pull() {
      if (!CLOUD || !this.user || !this.family) return;
      const fid = this.family;
      const [r, w, t, m, sh, sg] = await Promise.all([
        this.sb.from("recipes").select("*").eq("family_id", fid),
        this.sb.from("weeks").select("*").eq("family_id", fid),
        this.sb.from("ratings").select("recipe_id,user_id,stars"),
        this.sb.from("family_members").select("user_id,display_name,role").eq("family_id", fid),
        this.sb.from("shopping").select("week_id,checked,extras,edits").eq("family_id", fid),
        this.sb.from("suggestions").select("*").eq("family_id", fid).eq("status", "open")
      ]);
      if (fid !== this.family) return; // familjen byttes medan vi hämtade
      if (r.error || w.error) {
        const e = r.error || w.error;
        setSync(isNetworkError(e) ? "Offline" : "Kunde inte hämta", "warn");
        return;
      }
      const recipes = {}; r.data.forEach(row => recipes[row.id] = rowToRecipe(row));
      const weeks = {}; w.data.forEach(row => weeks[row.id] = row.data || {});
      const ratings = {};
      if (t.error) this.needsDbUpdate = true;
      else (t.data || []).forEach(row => { if (recipes[row.recipe_id]) (ratings[row.recipe_id] = ratings[row.recipe_id] || {})[row.user_id] = row.stars; });
      if (!m.error) { const mem = {}; m.data.forEach(x => mem[x.user_id] = { name: x.display_name, role: x.role }); this.members = mem; }
      if (sh.error || sg.error) this.needsDbUpdate = true;
      else {
        const shopping = {}; sh.data.forEach(x => shopping[x.week_id] = { checked: x.checked || [], extras: x.extras || [], edits: x.edits || {} });
        this.shopping = shopping;
        this.suggestions = sg.data;
      }
      this.recipes = recipes; this.weeks = weeks; this.ratings = ratings;
      this.outbox.forEach(op => this.apply(op)); // ändringar som inte hunnit sparas ligger kvar
      this.saveCache();
      state.loaded = true;
      if (this.needsDbUpdate) setSync("Databasen behöver uppdateras", "warn");
      else if (!this.outbox.length) setSync("Synkad", "ok");
      render();
    },

    subscribe() {
      if (this.channel) { this.sb.removeChannel(this.channel); this.channel = null; }
      if (!this.family) return;
      const fid = this.family, filter = "family_id=eq." + fid;
      const pending = key => this.outbox.some(o => opKey(o) === fid + "/" + key);
      this.channel = this.sb.channel("middagsboken-" + fid)
        .on("postgres_changes", { event: "*", schema: "public", table: "recipes", filter }, p => {
          const id = (p.new && p.new.id) || (p.old && p.old.id);
          if (!id || pending("r:" + id)) return;
          if (p.eventType === "DELETE") { delete this.recipes[id]; delete this.ratings[id]; } else this.recipes[id] = rowToRecipe(p.new);
          this.saveCache(); render();
        })
        .on("postgres_changes", { event: "*", schema: "public", table: "weeks", filter }, p => {
          const id = (p.new && p.new.id) || (p.old && p.old.id);
          if (!id || pending("w:" + id)) return;
          if (p.eventType === "DELETE") delete this.weeks[id]; else this.weeks[id] = p.new.data || {};
          this.saveCache(); render();
        })
        .on("postgres_changes", { event: "*", schema: "public", table: "ratings" }, p => {
          const row = p.eventType === "DELETE" ? p.old : p.new;
          if (!row || !row.recipe_id || !row.user_id || !this.recipes[row.recipe_id]) return;
          if (row.user_id === this.me && pending("t:" + row.recipe_id)) return;
          const cur = { ...(this.ratings[row.recipe_id] || {}) };
          if (p.eventType === "DELETE") delete cur[row.user_id]; else cur[row.user_id] = row.stars;
          this.ratings[row.recipe_id] = cur;
          this.saveCache(); render();
        })
        .on("postgres_changes", { event: "*", schema: "public", table: "family_members", filter }, () => {
          this.refreshMembers();
        })
        .on("postgres_changes", { event: "*", schema: "public", table: "shopping", filter }, p => {
          const row = p.new; if (!row || !row.week_id || pending("s:" + row.week_id)) return;
          this.shopping[row.week_id] = { checked: row.checked || [], extras: row.extras || [], edits: row.edits || {} };
          this.saveCache(); render();
        })
        .on("postgres_changes", { event: "*", schema: "public", table: "suggestions", filter }, () => {
          this.loadSuggestions();
        })
        .subscribe();
    },

    async loadSuggestions() {
      if (!CLOUD || !this.family) return;
      const fid = this.family;
      const { data, error } = await this.sb.from("suggestions").select("*").eq("family_id", fid).eq("status", "open");
      if (error || fid !== this.family) return;
      this.suggestions = data; this.saveCache(); render();
    },

    async refreshMembers() {
      const fid = this.family;
      const [m] = await Promise.all([
        this.sb.from("family_members").select("user_id,display_name,role").eq("family_id", fid),
        this.loadFamilies()
      ]);
      if (fid !== this.family) return;
      if (!this.families.some(f => f.id === fid)) { toast("Du är inte längre med i familjen"); chooseFamily(); return; }
      if (!m.error) { const mem = {}; m.data.forEach(x => mem[x.user_id] = { name: x.display_name, role: x.role }); this.members = mem; this.saveCache(); }
      renderHeader(); render();
    },

    async switchFamily(fid) {
      this.family = fid; lsSet(K_FAMILY, fid);
      if (this.outbox.some(o => !o.fid)) { this.outbox.forEach(o => { if (!o.fid) o.fid = fid; }); lsSet(K_OUTBOX, this.outbox); }
      lsDel("mb-cache");
      this.needsDbUpdate = false;
      this.loadCache();
      state.loaded = Object.keys(this.recipes).length > 0;
      state.offset = 0; state.tag = ""; state.q = "";
      closeSheet();
      document.body.classList.remove("locked");
      renderHeader(); render();
      this.subscribe();
      await this.refresh();
    },

    async refresh() { await this.flush(); await this.pull(); },

    async signOut() {
      if (this.channel) { this.sb.removeChannel(this.channel); this.channel = null; }
      await this.sb.auth.signOut().catch(() => {});
      Object.keys(localStorage).filter(k => k.startsWith("mb-cache-")).forEach(lsDel);
      ["mb-families", K_FAMILY, K_OUTBOX].forEach(lsDel);
      this.user = null; this.me = null; this.family = null; this.families = []; this.members = {};
      this.recipes = {}; this.weeks = {}; this.ratings = {}; this.outbox = [];
      closeSheet(); renderHeader(); showLogin();
    }
  };

  function recipeToRow(d) {
    const row = { name: d.name, time: d.time || "", servings: d.servings || 4, tags: d.tags || [], ingredients: d.ingredients || [], steps: d.steps || [] };
    if (!store.needsDbUpdate) { row.image = d.image || ""; row.source = d.source || ""; }
    return row;
  }
  function rowToRecipe(row) {
    return { name: row.name || "", time: row.time || "", servings: row.servings || 4, tags: row.tags || [], ingredients: row.ingredients || [], steps: row.steps || [], image: row.image || "", source: row.source || "" };
  }
  const errText = e => ((e && (e.message || e.details || e.code)) || "") + "";
  const isNetworkError = e => !navigator.onLine || /fetch|network|load failed|timeout/i.test(errText(e));
  const isAuthError = e => /jwt|token|401|not authenticated/i.test(errText(e));
  const isSchemaError = e => /column|relation|schema cache|does not exist|PGRST20|function .* not found|Could not find/i.test(errText(e));

  // ---------- bilder ----------
  async function shrinkImage(file, max) {
    const url = URL.createObjectURL(file);
    try {
      const img = await new Promise((ok, fail) => { const i = new Image(); i.onload = () => ok(i); i.onerror = fail; i.src = url; });
      const scale = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
      const c = document.createElement("canvas");
      c.width = Math.round(img.naturalWidth * scale); c.height = Math.round(img.naturalHeight * scale);
      c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
      return await new Promise(ok => c.toBlob(ok, "image/jpeg", 0.8));
    } finally { URL.revokeObjectURL(url); }
  }
  async function uploadImage(file) {
    if (!CLOUD) {
      const blob = await shrinkImage(file, 700);
      return await new Promise(ok => { const fr = new FileReader(); fr.onload = () => ok(fr.result); fr.readAsDataURL(blob); });
    }
    if (!navigator.onLine) throw new Error("offline");
    const blob = await shrinkImage(file, 1400);
    const path = `${store.family || store.me}/${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}.jpg`;
    const { error } = await store.sb.storage.from(BUCKET).upload(path, blob, { contentType: "image/jpeg", cacheControl: "31536000" });
    if (error) throw error;
    return store.sb.storage.from(BUCKET).getPublicUrl(path).data.publicUrl;
  }
  function deleteImage(url) {
    if (!CLOUD || !url) return;
    const marker = `/storage/v1/object/public/${BUCKET}/`;
    const i = url.indexOf(marker); if (i < 0) return; // externa bilder (från importerade recept) lämnas
    store.sb.storage.from(BUCKET).remove([decodeURIComponent(url.slice(i + marker.length))]).catch(() => {});
  }

  // ---------- tillstånd ----------
  const state = { tab: "week", offset: 0, loaded: false, q: "", tag: "", sort: lsGet("mb-sort", "name") };
  const t0 = lsGet("mb-tab", "week"); if (["week", "recipes", "shop"].includes(t0)) state.tab = t0;

  const monday = () => addDays(mondayOf(new Date()), 7 * state.offset);
  const recipeById = id => store.recipes[id] ? { id, ...store.recipes[id] } : null;
  function getWeek(key = weekKey(monday())) {
    const w = store.weeks[key] || {};
    const days = Array.from({ length: 7 }, (_, i) => ({ recipeId: "", note: "", ...((w.days || [])[i] || {}) }));
    return { servings: w.servings || 4, days, checked: w.checked || [], extras: w.extras || [] };
  }
  const putWeek = (w, key = weekKey(monday())) => store.change({ k: "w", id: key, data: w });
  // Inköpslistan sparas för sig, så att alla i familjen kan bocka av och ändra.
  function getShop(key = weekKey(monday())) {
    const sh = store.shopping[key], w = store.weeks[key] || {};
    return { checked: (sh ? sh.checked : w.checked) || [], extras: (sh ? sh.extras : w.extras) || [], edits: (sh && sh.edits) || {} };
  }
  const putShop = (sh, key = weekKey(monday())) => store.change({ k: "s", id: key, data: sh });
  // Får den inloggade ändra menyer och recept i vald familj?
  const canEdit = () => !CLOUD || !!(store.current && (store.current.role === "owner" || store.current.role === "editor"));
  const ROLE_NAMES = { owner: "Ägare", editor: "Redigerare", member: "Medlem" };

  // Betyg
  function rating(id) {
    const all = Object.values(store.ratings[id] || {}).filter(Boolean);
    const mine = (store.ratings[id] || {})[store.me] || 0;
    return { avg: all.length ? all.reduce((a, b) => a + b, 0) / all.length : 0, n: all.length, mine };
  }
  // Historik: vilka dagar varje recept ätits (till och med i dag)
  function eatenIndex() {
    const idx = {}, t = today0();
    Object.entries(store.weeks).forEach(([key, w]) => {
      const mon = mondayFromKey(key); if (!mon) return;
      (w.days || []).forEach((d, i) => {
        if (!d || !d.recipeId) return;
        const date = addDays(mon, i); if (date > t) return;
        (idx[d.recipeId] = idx[d.recipeId] || []).push(date);
      });
    });
    Object.values(idx).forEach(a => a.sort((x, y) => y - x));
    return idx;
  }
  function recipeList() {
    return Object.entries(store.recipes).map(([id, r]) => ({ id, ...r })).sort((a, b) => (a.name || "").localeCompare(b.name || "", "sv"));
  }

  // ---------- flikar ----------
  document.querySelectorAll("#tabbar button").forEach(b => b.addEventListener("click", () => {
    state.tab = b.dataset.tab; lsSet("mb-tab", state.tab);
    render(); window.scrollTo(0, 0);
  }));
  $("#sync").addEventListener("click", openSettings);

  function render() {
    if (document.body.classList.contains("locked")) return;
    document.querySelectorAll("#tabbar button").forEach(b => b.setAttribute("aria-selected", String(b.dataset.tab === state.tab)));
    const nsug = CLOUD ? store.suggestions.filter(x => x.status === "open").length : 0, wb = $('#tabbar [data-tab="week"]');
    let badge = $(".badge", wb);
    if (nsug && canEdit()) { if (!badge) { badge = h(`<span class="badge"></span>`); wb.append(badge); } badge.textContent = nsug; }
    else if (badge) badge.remove();
    const main = $("#main");
    const active = document.activeElement && document.activeElement.id;
    const y = window.scrollY;
    main.replaceChildren();
    if (store.needsDbUpdate) main.append(h(`<div class="hint-card warn"><p><b>Databasen behöver uppdateras.</b> Kör filen supabase-setup.sql en gång till i Supabase (SQL Editor), så fungerar allt.</p></div>`));
    if (state.tab === "week") renderWeek(main);
    else if (state.tab === "recipes") renderRecipes(main);
    else renderShop(main);
    window.scrollTo(0, y);
    if (active === "rq") { const f = $("#rq"); if (f) { f.focus(); f.setSelectionRange(f.value.length, f.value.length); } }
  }

  // ---------- små byggstenar ----------
  const thumb = (r, cls = "thumb") => r && r.image ? `<img class="${cls}" src="${esc(r.image)}" alt="" loading="lazy" decoding="async">` : "";
  const starText = n => "★".repeat(n) + "☆".repeat(5 - n);
  function starsInput(value, onSet) {
    const el = h(`<div class="stars" role="radiogroup" aria-label="Ditt betyg"></div>`);
    for (let i = 1; i <= 5; i++) {
      const b = h(`<button type="button" role="radio" aria-checked="${value === i}" aria-label="${i} av 5" class="${i <= value ? "on" : ""}">★</button>`);
      b.onclick = () => onSet(value === i ? 0 : i);
      el.append(b);
    }
    return el;
  }
  function ratingLabel(id) {
    const r = rating(id);
    return r.n ? `★ ${fmtNum(r.avg)}${r.n > 1 ? ` (${r.n})` : ""}` : "";
  }

  // ---------- installera-tips ----------
  function installHint() {
    if (isStandalone || !isIOS || lsGet("mb-hint-closed", false)) return null;
    const el = h(`<div class="hint-card"><img src="icons/apple-touch-icon.png" alt="">
      <p><b>Lägg appen på hemskärmen.</b> Tryck på
      <svg class="share-ico" viewBox="0 0 24 24" aria-label="Dela"><path d="M12 3v12M7.5 7.5 12 3l4.5 4.5M5 11v9h14v-9"/></svg>
      Dela längst ner i Safari och välj <b>Lägg till på hemskärmen</b>.</p>
      <button class="x" aria-label="Stäng tipset">✕</button></div>`);
    $(".x", el).onclick = () => { lsSet("mb-hint-closed", true); el.remove(); };
    return el;
  }

  // ---------- veckomeny ----------
  function weekNav() {
    const mon = monday(), w = isoWeek(mon);
    const label = state.offset === 0 ? "Denna vecka" : state.offset === 1 ? "Nästa vecka" : state.offset === -1 ? "Förra veckan" : String(w.year);
    const el = h(`<div class="weekhead row spread">
      <div><h2>Vecka ${w.week}</h2><div class="dates">${esc(label)} · ${fmtDate(mon)} – ${fmtDate(addDays(mon, 6))}</div></div>
      <div class="row">
        <button class="btn icon" data-n="-1" aria-label="Föregående vecka">←</button>
        ${state.offset !== 0 ? `<button class="btn" data-n="0">I dag</button>` : ""}
        <button class="btn icon" data-n="1" aria-label="Nästa vecka">→</button>
      </div></div>`);
    el.querySelectorAll("[data-n]").forEach(b => b.onclick = () => { const n = +b.dataset.n; state.offset = n === 0 ? 0 : state.offset + n; render(); });
    return el;
  }
  function dayInner(d, r, past) {
    if (r) {
      const my = rating(r.id).mine;
      const meta = [r.time && r.time + " min", ...(r.tags || []).slice(0, 2)].filter(Boolean).map(esc).join(" · ");
      const rate = past ? (my ? `<span class="mine">${starText(my)}</span>` : `<span class="ask">Betygsätt</span>`) : "";
      return `${thumb(r)}<span class="txt"><span class="name">${esc(r.name)}</span><span class="meta">${meta}${rate ? (meta ? " · " : "") + rate : ""}</span></span>`;
    }
    if (d.recipeId) return `<span class="txt"><span class="name">Receptet är borttaget</span><span class="meta">Tryck för att välja ett nytt</span></span>`;
    if (d.note) return `<span class="txt"><span class="name">${esc(d.note)}</span><span class="meta">Egen anteckning</span></span>`;
    return `<span class="txt">+ Välj middag</span>`;
  }
  function renderWeek(main) {
    const hint = installHint(); if (hint) main.append(hint);
    main.append(weekNav());
    const wk = getWeek(), mon = monday(), today = today0(), edit = canEdit();
    if (edit) {
      const bar = h(`<div class="row spread" style="margin-bottom:14px">
        <div class="servings"><label for="serv" class="small muted">Antal personer</label><input id="serv" type="number" inputmode="numeric" min="1" max="20" value="${wk.servings}"></div>
        <div class="row"><button class="btn primary" id="rnd">Slumpa tomma dagar</button><button class="btn" id="clr">Töm veckan</button></div></div>`);
      $("#serv", bar).onchange = e => { const v = Math.max(1, Math.min(20, +e.target.value || 4)); putWeek({ ...wk, servings: v }); };
      $("#rnd", bar).onclick = () => randomize(wk);
      const clr = $("#clr", bar);
      clr.onclick = () => {
        if (!clr.classList.contains("armed")) { clr.classList.add("armed", "danger"); clr.textContent = "Ja, töm"; setTimeout(() => { clr.classList.remove("armed", "danger"); clr.textContent = "Töm veckan"; }, 3000); return; }
        putWeek({ ...wk, days: wk.days.map(() => ({ recipeId: "", note: "" })) }); toast("Veckan är tömd");
      };
      main.append(bar);
    } else {
      const bar = h(`<div class="row spread memberbar"><span class="small muted">Du är Medlem och kan föreslå middagar. Ägaren kan ge dig rätt att ändra menyn.</span><button class="btn primary" id="sug">+ Föreslå</button></div>`);
      $("#sug", bar).onclick = () => openSuggest({});
      main.append(bar);
    }

    const ul = h(`<ul class="days"></ul>`);
    wk.days.forEach((d, i) => {
      const date = addDays(mon, i), r = d.recipeId && recipeById(d.recipeId);
      const isToday = +date === +today;
      const empty = !r && !d.note;
      const li = h(`<li class="day${isToday ? " today" : ""}">
        <div class="when"><b>${DAYS[i]}</b><small>${fmtDate(date)}${isToday ? " · i dag" : ""}</small></div>
        <button class="dish ${r || d.note ? "filled" : "empty"}${r && r.image ? " has-img" : ""}">${empty && !edit ? `<span class="txt">+ Föreslå något</span>` : dayInner(d, r, date <= today)}</button></li>`);
      $(".dish", li).onclick = () => r ? openRecipe(r.id, edit ? i : undefined) : edit ? openPicker(i) : empty ? openSuggest({ day: i }) : null;
      ul.append(li);
    });
    main.append(ul);
    if (state.loaded && !recipeList().length) main.append(h(`<div class="empty-state" style="margin-top:20px"><p>${edit ? "Du har inga recept än. Lägg till några under Recept, så kan du välja dem här." : "Familjen har inga recept än."}</p></div>`));
    if (CLOUD) main.append(suggestionsSection());
    main.append(lastYear(wk));
  }

  function lastYear(cur) {
    const w = isoWeek(monday());
    const key = keyFor(w.year - 1, w.week);
    const old = store.weeks[key];
    const sec = h(`<div class="section lastyear"><div class="row spread"><h3>Vecka ${w.week} i fjol</h3><button class="btn small" id="hist">Visa all historik</button></div></div>`);
    $("#hist", sec).onclick = openHistory;
    const days = old ? getWeek(key).days : [];
    const filled = days.map((d, i) => ({ d, i })).filter(x => x.d.recipeId || x.d.note);
    if (!filled.length) {
      sec.append(h(`<p class="muted small" style="margin:4px 0 0">Ingen meny sparad för vecka ${w.week} ${w.year - 1}. Här visas vad ni åt för ett år sedan när appen har använts ett tag.</p>`));
      return sec;
    }
    const ul = h(`<ul class="mini"></ul>`);
    filled.forEach(({ d, i }) => {
      const r = d.recipeId && recipeById(d.recipeId);
      const li = h(`<li><span class="d">${DAYS[i].slice(0, 3)}</span><span class="n">${esc(r ? r.name : d.note || "Borttaget recept")}</span></li>`);
      if (r) { li.classList.add("link"); li.onclick = () => openRecipe(r.id); }
      ul.append(li);
    });
    sec.append(ul);
    const empty = cur.days.filter(d => !d.recipeId && !d.note).length;
    if (empty && canEdit()) {
      const b = h(`<button class="btn" style="margin-top:10px">Använd fjolårets meny på tomma dagar</button>`);
      b.onclick = () => {
        let n = 0;
        const oldDays = getWeek(key).days;
        const days = cur.days.map((d, i) => {
          if (d.recipeId || d.note) return d;
          const o = oldDays[i], exists = o.recipeId && store.recipes[o.recipeId];
          if (!exists && !o.note) return d;
          n++;
          return { recipeId: exists ? o.recipeId : "", note: exists ? "" : o.note };
        });
        if (!n) { toast("Inget att kopiera"); return; }
        putWeek({ ...cur, days }); toast(`${n} dagar kopierade`);
      };
      sec.append(b);
    }
    return sec;
  }

  function randomize(wk) {
    const all = recipeList();
    if (!all.length) { toast("Lägg till recept först"); return; }
    const used = new Set(wk.days.map(d => d.recipeId).filter(Boolean));
    const lastWeek = new Set(getWeek(weekKey(addDays(monday(), -7))).days.map(d => d.recipeId));
    let pool = all.filter(r => !used.has(r.id) && !lastWeek.has(r.id));
    if (pool.length < 7) pool = all.filter(r => !used.has(r.id));
    // Rätter med högt betyg kommer oftare, rätter med lågt betyg mer sällan.
    const weight = r => { const s = rating(r.id); return s.n ? Math.max(0.2, s.avg - 1) : 2.5; };
    pool = pool.map(r => [Math.pow(Math.random(), 1 / weight(r)), r]).sort((a, b) => b[0] - a[0]).map(x => x[1]);
    let n = 0;
    const days = wk.days.map(d => {
      if (d.recipeId || d.note) return d;
      const r = pool.length ? pool.shift() : all[Math.floor(Math.random() * all.length)];
      n++; return { recipeId: r.id, note: "" };
    });
    if (!n) { toast("Alla dagar är redan planerade"); return; }
    putWeek({ ...wk, days }); toast(`${n} dagar fyllda`);
  }

  // ---------- ark som glider upp ----------
  let onSheetClose = null;
  function openSheet(content, onClose) {
    if (onSheetClose) { const f = onSheetClose; onSheetClose = null; f(); }
    const shade = h(`<div class="shade"><div class="sheet" role="dialog" aria-modal="true"></div></div>`);
    $(".sheet", shade).append(content);
    shade.addEventListener("click", e => { if (e.target === shade) closeSheet(); });
    $("#layer").replaceChildren(shade);
    document.documentElement.style.overflow = "hidden";
    onSheetClose = onClose || null;
  }
  function closeSheet() {
    if (onSheetClose) { const f = onSheetClose; onSheetClose = null; f(); }
    $("#layer").replaceChildren(); document.documentElement.style.overflow = "";
  }
  document.addEventListener("keydown", e => { if (e.key === "Escape") closeSheet(); });
  const closeBtn = () => { const b = h(`<button type="button" class="btn icon close" aria-label="Stäng">✕</button>`); b.onclick = closeSheet; return b; };

  function openPicker(i) {
    const wk = getWeek(), d = wk.days[i], date = addDays(monday(), i);
    const box = h(`<div>
      <h2>${DAYS[i]} ${fmtDate(date)}</h2><p class="muted small" style="margin:0 0 10px">Välj ett recept eller skriv något eget.</p>
      <input class="search" id="pq" type="search" placeholder="Sök recept…" style="width:100%">
      <ul class="picklist"></ul>
      <div class="section" style="margin-top:18px"><div class="label">Eller skriv själv</div>
        <div class="addline"><input id="pnote" placeholder="T.ex. Rester, Pizza ute" value="${esc(d.note)}" enterkeyhint="done"><button class="btn" id="psave">Spara</button></div></div>
      <div class="row" style="margin-top:18px">${d.recipeId || d.note ? `<button class="btn danger" id="pclear">Ta bort middagen</button>` : ""}</div></div>`);
    box.prepend(closeBtn());
    const list = $(".picklist", box);
    const fill = () => {
      const q = $("#pq", box).value.trim().toLowerCase();
      const all = recipeList();
      list.replaceChildren();
      const rs = all.filter(r => !q || (r.name + " " + (r.tags || []).join(" ")).toLowerCase().includes(q))
        .sort((a, b) => rating(b.id).avg - rating(a.id).avg || 0);
      if (!rs.length) list.append(h(`<li class="muted small" style="padding:10px 4px">${all.length ? "Inget recept matchar." : "Inga recept än."}</li>`));
      rs.forEach(r => {
        const rl = ratingLabel(r.id);
        const li = h(`<li><button>${thumb(r, "pthumb")}<span><b>${esc(r.name)}</b>${r.id === d.recipeId ? " ✓" : ""}<span class="sub">${[rl, r.time && r.time + " min", ...(r.tags || [])].filter(Boolean).map(esc).join(" · ")}</span></span></button></li>`);
        $("button", li).onclick = () => { setDay(i, { recipeId: r.id, note: "" }); closeSheet(); };
        list.append(li);
      });
    };
    $("#pq", box).oninput = fill; fill();
    const sl = CLOUD ? openSuggestions() : [];
    if (sl.length) {
      const sec = h(`<div class="pick-sugg"><div class="label">Förslag från familjen</div><ul class="sugglist"></ul></div>`);
      sl.forEach(sg => $("ul", sec).append(suggestionItem(sg, x => useSuggestion(x, i))));
      $("#pq", box).before(sec);
    }
    const saveNote = () => { const v = $("#pnote", box).value.trim(); setDay(i, { recipeId: "", note: v }); closeSheet(); };
    $("#psave", box).onclick = saveNote;
    $("#pnote", box).onkeydown = e => { if (e.key === "Enter") saveNote(); };
    const c = $("#pclear", box); if (c) c.onclick = () => { setDay(i, { recipeId: "", note: "" }); closeSheet(); };
    openSheet(box);
  }
  function setDay(i, val) {
    const wk = getWeek(); const days = wk.days.slice(); days[i] = val; putWeek({ ...wk, days });
  }

  // ---------- förslag ----------
  const openSuggestions = () => store.suggestions.filter(x => x.status === "open")
    .sort((a, b) => (b.votes || []).length - (a.votes || []).length || String(a.created_at).localeCompare(String(b.created_at)));
  function suggestionTitle(sg) {
    const r = sg.recipe_id && recipeById(sg.recipe_id);
    return r ? r.name : (sg.text || "Förslag");
  }
  function suggestionMeta(sg) {
    const r = sg.recipe_id && recipeById(sg.recipe_id);
    const who = (store.members[sg.user_id] && store.members[sg.user_id].name) || "Någon";
    let when = "";
    if (sg.day != null && sg.week_id) {
      const mon = mondayFromKey(sg.week_id);
      when = mon ? ` · ${DAYS[sg.day].toLowerCase()} ${fmtDate(addDays(mon, sg.day))}` : "";
    }
    return `${esc(who)}${when}${r && sg.text ? ` · ”${esc(sg.text)}”` : ""}`;
  }
  async function voteSuggestion(sg) {
    const { error } = await store.sb.rpc("toggle_vote", { sid: sg.id });
    if (error) toast(rpcError(error, "Rösten kunde inte sparas.")); else store.loadSuggestions();
  }
  async function setSuggestionStatus(sg, status) {
    const { error } = await store.sb.from("suggestions").update({ status }).eq("id", sg.id);
    if (error) { toast(rpcError(error, "Förslaget kunde inte uppdateras.")); return false; }
    store.suggestions = store.suggestions.filter(x => x.id !== sg.id); store.saveCache(); render();
    return true;
  }
  async function deleteSuggestion(sg) {
    const { error } = await store.sb.from("suggestions").delete().eq("id", sg.id);
    if (error) { toast(rpcError(error, "Förslaget kunde inte tas bort.")); return; }
    store.suggestions = store.suggestions.filter(x => x.id !== sg.id); store.saveCache(); render();
  }
  // Lägg in ett förslag på en dag i den vecka som visas.
  async function useSuggestion(sg, dayIndex) {
    const r = sg.recipe_id && recipeById(sg.recipe_id);
    setDay(dayIndex, r ? { recipeId: r.id, note: "" } : { recipeId: "", note: sg.text.slice(0, 60) });
    await setSuggestionStatus(sg, "done");
    closeSheet(); toast(`Inlagt på ${DAYS[dayIndex].toLowerCase()}`);
  }
  function chooseDayFor(sg) {
    const wk = getWeek(), cur = weekKey(monday());
    const pre = sg.day != null && sg.week_id === cur ? sg.day : wk.days.findIndex(d => !d.recipeId && !d.note);
    const box = h(`<div><h2>Vilken dag?</h2><p class="small muted" style="margin:0 0 6px">${esc(suggestionTitle(sg))}, vecka ${isoWeek(monday()).week}</p><ul class="picklist"></ul></div>`);
    box.prepend(closeBtn());
    wk.days.forEach((d, i) => {
      const r = d.recipeId && recipeById(d.recipeId);
      const li = h(`<li><button${i === pre ? ' class="pre"' : ""}><span><b>${DAYS[i]} ${fmtDate(addDays(monday(), i))}</b><span class="sub">${r ? "Ersätter " + esc(r.name) : d.note ? "Ersätter " + esc(d.note) : "Ledig"}</span></span></button></li>`);
      $("button", li).onclick = () => useSuggestion(sg, i);
      $(".picklist", box).append(li);
    });
    openSheet(box);
  }
  function suggestionItem(sg, onPick) {
    const mine = (sg.votes || []).includes(store.me), n = (sg.votes || []).length;
    const li = h(`<li class="sugg">
      <div class="st"><b>${esc(suggestionTitle(sg))}</b><span class="small muted">${suggestionMeta(sg)}</span></div>
      <div class="sa"><button class="vote${mine ? " on" : ""}" aria-pressed="${mine}" aria-label="Tumme upp">👍 ${n || ""}</button></div></li>`);
    $(".vote", li).onclick = e => { e.stopPropagation(); voteSuggestion(sg); };
    const sa = $(".sa", li);
    if (onPick) {
      const b = h(`<button class="btn small primary">Välj</button>`); b.onclick = () => onPick(sg); sa.append(b);
    } else if (canEdit()) {
      const add = h(`<button class="btn small primary">Lägg in</button>`); add.onclick = () => chooseDayFor(sg);
      const no = h(`<button class="btn small" aria-label="Avfärda förslaget">✕</button>`);
      no.onclick = () => { if (!no.classList.contains("armed")) { no.classList.add("armed", "danger"); no.textContent = "Avfärda"; return; } setSuggestionStatus(sg, "dismissed"); };
      sa.append(add, no);
    } else if (sg.user_id === store.me) {
      const rm = h(`<button class="btn small">Ta bort</button>`); rm.onclick = () => deleteSuggestion(sg); sa.append(rm);
    }
    const r = sg.recipe_id && recipeById(sg.recipe_id);
    if (r) { $(".st", li).classList.add("link"); $(".st", li).onclick = () => openRecipe(r.id); }
    return li;
  }
  function suggestionsSection() {
    const list = openSuggestions();
    const sec = h(`<div class="section suggestions"><div class="row spread"><h3>Förslag från familjen${list.length ? ` (${list.length})` : ""}</h3><button class="btn small" id="sugadd">+ Föreslå</button></div></div>`);
    $("#sugadd", sec).onclick = () => openSuggest({});
    if (!list.length) {
      sec.append(h(`<p class="small muted" style="margin:4px 0 0">Inga förslag just nu. Alla i familjen kan föreslå rätter, och ${canEdit() ? "du lägger in dem på en dag med ett tryck." : "den som planerar ser dem direkt."}</p>`));
      return sec;
    }
    const ul = h(`<ul class="sugglist"></ul>`);
    list.forEach(sg => ul.append(suggestionItem(sg)));
    sec.append(ul);
    return sec;
  }
  function openSuggest({ recipeId, day }) {
    if (!CLOUD) { toast("Förslag fungerar när appen är kopplad till databasen."); return; }
    let chosen = recipeId || "";
    const cur = weekKey(monday());
    const box = h(`<form>
      <h2>Föreslå en middag</h2>
      <p class="small muted" style="margin:0 0 10px">Välj ett recept, skriv fritt eller gör båda.</p>
      <input class="search" id="sq" type="search" placeholder="Sök recept…" style="width:100%">
      <ul class="picklist short"></ul>
      <div class="field" style="margin-top:14px"><label for="stext">Fritext eller kommentar</label><input id="stext" maxlength="140" placeholder="T.ex. Något med fisk, eller Mormors lasagne"></div>
      <div class="field"><label for="sday">När?</label><select id="sday" class="btn"><option value="">Någon dag</option>${DAYS.map((d, i) => `<option value="${i}"${day === i ? " selected" : ""}>${d} ${fmtDate(addDays(monday(), i))} (v${isoWeek(monday()).week})</option>`).join("")}</select></div>
      <p class="err small" hidden></p>
      <button class="btn primary" type="submit">Skicka förslag</button></form>`);
    box.prepend(closeBtn());
    const list = $(".picklist", box);
    const fill = () => {
      const q = $("#sq", box).value.trim().toLowerCase();
      list.replaceChildren();
      recipeList().filter(r => !q || r.name.toLowerCase().includes(q) || r.id === chosen)
        .sort((a, b) => (b.id === chosen) - (a.id === chosen) || rating(b.id).avg - rating(a.id).avg)
        .slice(0, q ? 30 : 12).forEach(r => {
          const li = h(`<li><button type="button" class="${r.id === chosen ? "pre" : ""}">${thumb(r, "pthumb")}<span><b>${esc(r.name)}</b>${r.id === chosen ? " ✓" : ""}<span class="sub">${[ratingLabel(r.id), r.time && r.time + " min"].filter(Boolean).map(esc).join(" · ")}</span></span></button></li>`);
          $("button", li).onclick = () => { chosen = chosen === r.id ? "" : r.id; fill(); };
          list.append(li);
        });
    };
    $("#sq", box).oninput = fill; fill();
    box.onsubmit = async e => {
      e.preventDefault();
      const text = $("#stext", box).value.trim(), dv = $("#sday", box).value;
      const err = $(".err", box);
      if (!chosen && !text) { err.hidden = false; err.textContent = "Välj ett recept eller skriv något."; return; }
      const btn = $("button[type=submit]", box); btn.disabled = true;
      const { error } = await store.sb.from("suggestions").insert({ family_id: store.family, user_id: store.me, recipe_id: chosen || null, text, week_id: cur, day: dv === "" ? null : +dv });
      btn.disabled = false;
      if (error) { err.hidden = false; err.textContent = rpcError(error, "Förslaget kunde inte skickas."); return; }
      closeSheet(); toast("Tack för förslaget!"); store.loadSuggestions();
    };
    openSheet(box);
  }

  // ---------- historik ----------
  function openHistory() {
    const t = today0();
    const keys = Object.keys(store.weeks).filter(k => { const m = mondayFromKey(k); return m && m <= t; }).sort().reverse();
    const box = h(`<div><h2>Historik</h2><p class="muted small" style="margin:0 0 6px">Alla veckor med sparad meny, nyast först.</p><div id="hl"></div></div>`);
    box.prepend(closeBtn());
    const hl = $("#hl", box);
    let shown = 0;
    keys.forEach(k => {
      const w = getWeek(k), mon = mondayFromKey(k);
      const filled = w.days.map((d, i) => ({ d, i })).filter(x => x.d.recipeId || x.d.note);
      if (!filled.length) return;
      shown++;
      const wi = isoWeek(mon);
      const sec = h(`<div class="hweek"><div class="label">Vecka ${wi.week} · ${fmtDate(mon)} ${wi.year}</div><ul class="mini"></ul></div>`);
      filled.forEach(({ d, i }) => {
        const r = d.recipeId && recipeById(d.recipeId);
        const li = h(`<li><span class="d">${DAYS[i].slice(0, 3)}</span><span class="n">${esc(r ? r.name : d.note || "Borttaget recept")}</span></li>`);
        if (r) { li.classList.add("link"); li.onclick = () => openRecipe(r.id); }
        $("ul", sec).append(li);
      });
      hl.append(sec);
    });
    if (!shown) hl.append(h(`<p class="empty-state">Ingen historik än. Veckorna sparas automatiskt när ni planerar.</p>`));
    openSheet(box);
  }

  // ---------- recept ----------
  const SORTS = { name: "Namn A–Ö", rating: "Högst betyg", recent: "Senast lagad", count: "Mest lagad", long: "Inte lagad på länge" };
  function renderRecipes(main) {
    const top = h(`<div class="tools">
      <input class="search" id="rq" type="search" placeholder="Sök namn, ingrediens eller tagg…" value="${esc(state.q)}">
      <div class="row">${canEdit() ? `<button class="btn primary" id="newr">+ Nytt recept</button><button class="btn" id="imp">Importera</button>` : ""}<button class="btn" id="exp">Exportera</button></div></div>`);
    main.append(top);
    if (canEdit()) { $("#newr", top).onclick = () => openEditor(); $("#imp", top).onclick = openImport; }
    $("#exp", top).onclick = openExport;
    const all = recipeList();
    const tags = [...new Set(all.flatMap(r => r.tags || []))].sort((a, b) => a.localeCompare(b, "sv"));
    const chips = h(`<div class="chips"></div>`);
    ["", "★4", ...tags].forEach(t => {
      const b = h(`<button class="chip" aria-pressed="${state.tag === t}">${t === "" ? "Alla" : t === "★4" ? "★ Favoriter" : esc(t)}</button>`);
      b.onclick = () => { state.tag = t; render(); };
      chips.append(b);
    });
    main.append(chips);
    const sortRow = h(`<div class="row spread sortrow"><span class="small muted" id="cnt"></span>
      <label class="small muted">Sortera <select id="sort">${Object.entries(SORTS).map(([k, v]) => `<option value="${k}"${state.sort === k ? " selected" : ""}>${v}</option>`).join("")}</select></label></div>`);
    $("#sort", sortRow).onchange = e => { state.sort = e.target.value; lsSet("mb-sort", state.sort); render(); };
    main.append(sortRow);

    const eaten = eatenIndex();
    const grid = h(`<div class="grid"></div>`);
    const draw = () => {
      const q = state.q.trim().toLowerCase();
      let rs = all.filter(r =>
        (!state.tag || (state.tag === "★4" ? rating(r.id).avg >= 4 : (r.tags || []).includes(state.tag))) &&
        (!q || [r.name, (r.tags || []).join(" "), (r.ingredients || []).join(" ")].join(" ").toLowerCase().includes(q)));
      const last = r => (eaten[r.id] || [])[0] || 0;
      const cmp = {
        name: () => 0,
        rating: (a, b) => rating(b.id).avg - rating(a.id).avg,
        recent: (a, b) => last(b) - last(a),
        count: (a, b) => (eaten[b.id] || []).length - (eaten[a.id] || []).length,
        long: (a, b) => last(a) - last(b)
      }[state.sort] || (() => 0);
      rs = rs.slice().sort((a, b) => cmp(a, b) || a.name.localeCompare(b.name, "sv"));
      $("#cnt", sortRow).textContent = `${rs.length} recept`;
      grid.replaceChildren();
      rs.forEach(r => {
        const n = (eaten[r.id] || []).length, l = last(r);
        const info = [ratingLabel(r.id), r.time && r.time + " min", n ? `lagad ${n} ggr` : "", state.sort !== "name" && l ? `senast ${fmtDate(l)}` : ""].filter(Boolean);
        const c = h(`<button class="card${r.image ? " with-img" : ""}">${r.image ? `<img class="cover" src="${esc(r.image)}" alt="" loading="lazy" decoding="async">` : ""}
          <span class="body"><h3>${esc(r.name)}</h3>
          <span class="small muted">${info.map(esc).join(" · ")}</span>
          <span class="tags">${(r.tags || []).map(t => `<span class="tag">${esc(t)}</span>`).join("")}</span></span></button>`);
        c.onclick = () => openRecipe(r.id);
        grid.append(c);
      });
      if (!rs.length) grid.append(h(all.length
        ? `<div class="empty-state">Inget recept matchar.</div>`
        : `<div class="empty-state"><p>${state.loaded ? "Här samlas era recept. Lägg till ert första eller importera från en receptsida." : "Hämtar recept…"}</p></div>`));
    };
    $("#rq", top).oninput = e => { state.q = e.target.value; draw(); };
    draw();
    main.append(grid);
  }

  function openRecipe(id, dayIndex) {
    const r = recipeById(id); if (!r) return;
    const rt = rating(id), eaten = eatenIndex()[id] || [], edit = canEdit();
    const box = h(`<div>
      ${r.image ? `<img class="hero" src="${esc(r.image)}" alt="">` : ""}
      <h2>${esc(r.name)}</h2>
      <div class="tags row">${(r.tags || []).map(t => `<span class="tag">${esc(t)}</span>`).join("")}</div>
      <div class="facts">
        ${r.time ? `<div><b>${esc(r.time)} min</b><span class="muted">tillagning</span></div>` : ""}
        ${r.servings ? `<div><b>${esc(r.servings)}</b><span class="muted">portioner</span></div>` : ""}
        ${rt.n ? `<div><b>★ ${fmtNum(rt.avg)}</b><span class="muted">${rt.n === 1 ? "1 betyg" : rt.n + " betyg"}</span></div>` : ""}
        <div><b>${eaten.length}</b><span class="muted">${eaten.length ? `ggr, senast ${fmtDate(eaten[0])}` : "ggr lagad"}</span></div>
      </div>
      <div class="row actions"><button class="btn primary" id="cook">Laga</button><button class="btn" id="share">Dela</button><button class="btn" id="print">Skriv ut</button>${CLOUD ? `<button class="btn" id="suggest">Föreslå</button>` : ""}</div>
      <div class="rate"><span class="label">Ditt betyg</span></div>
      ${dayIndex != null && edit ? `<div class="section"><div class="label">${DAYS[dayIndex]} ${fmtDate(addDays(monday(), dayIndex))}</div>
        <div class="row" style="margin-top:6px"><button class="btn primary" id="swap">Byt middag</button><button class="btn" id="unplan">Ta bort från dagen</button></div></div>` : ""}
      <div class="section"><h3>Ingredienser</h3><ul class="ingr">${(r.ingredients || []).map(x => `<li>${esc(x)}</li>`).join("") || "<li class='muted'>Inga ingredienser angivna</li>"}</ul></div>
      <div class="section"><h3>Gör så här</h3><ol class="steps">${(r.steps || []).map(x => `<li>${esc(x)}</li>`).join("") || "<li class='muted'>Ingen beskrivning</li>"}</ol></div>
      ${r.source ? `<p class="small muted section">Källa: <a href="${esc(r.source)}" target="_blank" rel="noopener">${esc(r.source.replace(/^https?:\/\/(www\.)?/, "").split("/")[0])}</a></p>` : ""}
      ${eaten.length > 1 ? `<details class="section"><summary class="small">Alla gånger ni ätit den</summary><p class="small muted">${eaten.map(fmtDateYear).join(", ")}</p></details>` : ""}
      <div class="section"${dayIndex != null || !edit ? " hidden" : ""}><div class="label">Lägg på veckomenyn, vecka ${isoWeek(monday()).week}</div>
        <div class="row" style="margin-top:6px"><select id="addday" class="btn">${DAYS.map((d, i) => `<option value="${i}">${d} ${fmtDate(addDays(monday(), i))}</option>`).join("")}</select><button class="btn primary" id="addgo">Lägg till</button></div></div>
      <div class="row section">${edit ? `<button class="btn" id="edit">Redigera</button>` : ""}${CLOUD && store.families.length > 1 ? `<button class="btn" id="copyfam">Kopiera till annan familj</button>` : ""}${edit ? `<button class="btn danger" id="del">Ta bort</button>` : ""}</div></div>`);
    box.prepend(closeBtn());
    $("#cook", box).onclick = () => openCook(r);
    $("#share", box).onclick = () => shareRecipe(r);
    $("#print", box).onclick = () => printRecipes([r]);
    const sgb = $("#suggest", box); if (sgb) sgb.onclick = () => openSuggest({ recipeId: r.id });
    $(".rate", box).append(starsInput(rt.mine, v => { store.change({ k: "rt", id, stars: v }); toast(v ? `Du gav ${v} av 5` : "Betyget borttaget"); openRecipe(id, dayIndex); }));
    const others = Object.entries(store.ratings[id] || {}).filter(([uid, n]) => n && uid !== store.me && CLOUD);
    if (others.length) $(".rate", box).after(h(`<p class="small muted who">${others.map(([uid, n]) => `${esc((store.members[uid] && store.members[uid].name) || "Tidigare medlem")} ${"★".repeat(n)}`).join(" · ")}</p>`));
    const cp = $("#copyfam", box);
    if (cp) cp.onclick = () => {
      const opts = store.families.filter(f => f.id !== store.family);
      const b2 = h(`<div><h2>Kopiera till en annan familj</h2><p class="small muted">Receptet kopieras med ingredienser, steg och bild. Betyg och historik följer inte med.</p><ul class="famlist"></ul></div>`);
      b2.prepend(closeBtn());
      opts.forEach(f => {
        const li = h(`<li><button>${esc(f.name)}</button></li>`);
        $("button", li).onclick = async () => {
          const { error } = await store.sb.from("recipes").insert({ id: newId(), family_id: f.id, ...recipeToRow(r) });
          if (error) { toast(rpcError(error, "Receptet kunde inte kopieras.")); return; }
          closeSheet(); toast(`Kopierat till ${f.name}`);
        };
        $(".famlist", b2).append(li);
      });
      openSheet(b2);
    };
    if (dayIndex != null && edit) {
      $("#swap", box).onclick = () => openPicker(dayIndex);
      $("#unplan", box).onclick = () => { setDay(dayIndex, { recipeId: "", note: "" }); closeSheet(); toast("Borttagen från " + DAYS[dayIndex].toLowerCase()); };
    }
    const firstEmpty = getWeek().days.findIndex(d => !d.recipeId && !d.note);
    if (firstEmpty >= 0) $("#addday", box).value = firstEmpty;
    $("#addgo", box).onclick = () => { const i = +$("#addday", box).value; setDay(i, { recipeId: r.id, note: "" }); closeSheet(); toast(`Tillagd på ${DAYS[i].toLowerCase()}`); };
    if (edit) $("#edit", box).onclick = () => openEditor(r);
    const del = $("#del", box);
    if (del) del.onclick = () => {
      if (!del.classList.contains("armed")) { del.classList.add("armed"); del.textContent = "Ja, ta bort receptet"; return; }
      deleteImage(r.image);
      store.change({ k: "rd", id: r.id }); closeSheet(); toast("Receptet är borttaget");
    };
    openSheet(box);
  }

  function openEditor(r) {
    const isNew = !r || !r.id;
    r = { name: "", time: "", servings: 4, tags: [], ingredients: [], steps: [], image: "", source: "", ...(r || {}) };
    const originalImage = isNew ? "" : r.image;
    let image = r.image, uploaded = [];
    const box = h(`<form>
      <h2>${isNew ? "Nytt recept" : "Redigera recept"}</h2>
      <div class="field" style="margin-top:14px"><span class="flabel">Bild</span>
        <div class="imgpick"><div class="preview"></div>
          <div class="row"><label class="btn" for="f-img" id="imgbtn">Välj bild</label><button type="button" class="btn danger" id="imgdel">Ta bort bild</button></div>
          <input id="f-img" type="file" accept="image/*" hidden></div>
        <span class="hint">Ta ett foto eller välj från bildbiblioteket.</span></div>
      <div class="field"><label for="f-name">Namn</label><input id="f-name" required value="${esc(r.name)}" placeholder="T.ex. Köttbullar med potatismos"></div>
      <div class="two">
        <div class="field"><label for="f-time">Tid (minuter)</label><input id="f-time" type="number" inputmode="numeric" min="0" value="${esc(r.time)}"></div>
        <div class="field"><label for="f-serv">Portioner</label><input id="f-serv" type="number" inputmode="numeric" min="1" value="${esc(r.servings)}"></div>
      </div>
      <div class="field"><label for="f-tags">Taggar</label><input id="f-tags" value="${esc((r.tags || []).join(", "))}" placeholder="Fisk, Snabbt, Vegetariskt"><span class="hint">Skilj med kommatecken.</span></div>
      <div class="field"><label for="f-ingr">Ingredienser</label><textarea id="f-ingr" placeholder="500 g nötfärs&#10;1 gul lök&#10;2 dl grädde">${esc((r.ingredients || []).join("\n"))}</textarea><span class="hint">En per rad. Börja med mängd och enhet, så räknas inköpslistan ut automatiskt.</span></div>
      <div class="field"><label for="f-steps">Gör så här</label><textarea id="f-steps" placeholder="Hacka löken.&#10;Stek färsen…">${esc((r.steps || []).join("\n"))}</textarea><span class="hint">Ett steg per rad.</span></div>
      <div class="field"><label for="f-src">Källa (valfritt)</label><input id="f-src" type="url" value="${esc(r.source)}" placeholder="https://…"></div>
      <div class="row"><button class="btn primary" type="submit">Spara recept</button><button class="btn" type="button" id="cancel">Avbryt</button></div></form>`);
    box.prepend(closeBtn());
    const showImg = () => {
      $(".preview", box).innerHTML = image ? `<img src="${esc(image)}" alt="">` : `<span class="muted small">Ingen bild</span>`;
      $("#imgdel", box).hidden = !image;
      $("#imgbtn", box).textContent = image ? "Byt bild" : "Välj bild";
    };
    showImg();
    $("#f-img", box).onchange = async e => {
      const file = e.target.files && e.target.files[0]; e.target.value = "";
      if (!file) return;
      $(".preview", box).innerHTML = `<span class="muted small">Laddar upp…</span>`;
      try {
        image = await uploadImage(file); uploaded.push(image);
      } catch (err) {
        toast(err && err.message === "offline" ? "Bilder kan bara läggas till när du är online." : "Bilden kunde inte laddas upp.");
        console.error(err);
      }
      showImg();
    };
    $("#imgdel", box).onclick = () => { image = ""; showImg(); };
    let saved = false;
    const cleanup = () => { if (!saved) uploaded.forEach(deleteImage); };
    $("#cancel", box).onclick = () => { if (isNew) closeSheet(); else openRecipe(r.id); };
    box.onsubmit = e => {
      e.preventDefault();
      const lines = s => s.split("\n").map(x => x.trim()).filter(Boolean);
      const data = {
        name: $("#f-name", box).value.trim(),
        time: $("#f-time", box).value.trim(),
        servings: Math.max(1, +$("#f-serv", box).value || 4),
        tags: [...new Set($("#f-tags", box).value.split(",").map(t => t.trim()).filter(Boolean).map(t => t[0].toUpperCase() + t.slice(1)))],
        ingredients: lines($("#f-ingr", box).value),
        steps: lines($("#f-steps", box).value),
        image,
        source: $("#f-src", box).value.trim()
      };
      if (!data.name) { $("#f-name", box).focus(); return; }
      saved = true;
      uploaded.filter(u => u !== image).forEach(deleteImage);
      if (originalImage && originalImage !== image) deleteImage(originalImage);
      const id = isNew ? newId() : r.id;
      store.change({ k: "r", id, data });
      toast(isNew ? "Receptet är sparat" : "Ändringarna är sparade");
      openRecipe(id);
    };
    openSheet(box, cleanup);
  }

  // ---------- matlagningsläge ----------
  let wakeLock = null, cookOpen = false;
  async function keepAwake() {
    try {
      if (!("wakeLock" in navigator)) return false;
      if (wakeLock && !wakeLock.released) return true;
      wakeLock = await navigator.wakeLock.request("screen");
      return true;
    } catch { return false; }
  }
  function releaseAwake() { cookOpen = false; try { wakeLock && wakeLock.release(); } catch {} wakeLock = null; }
  document.addEventListener("visibilitychange", () => { if (cookOpen && document.visibilityState === "visible") keepAwake(); });

  function openCook(r) {
    const box = h(`<div class="cook">
      <div class="row spread cookhead"><span class="label" id="awake">Matlagningsläge</span></div>
      <h2>${esc(r.name)}</h2>
      ${r.time || r.servings ? `<p class="muted" style="margin:2px 0 0">${[r.time && r.time + " min", r.servings && r.servings + " portioner"].filter(Boolean).map(esc).join(" · ")}</p>` : ""}
      <div class="section"><h3>Ingredienser</h3><p class="small muted" style="margin:0 0 6px">Tryck för att bocka av det du har tagit fram.</p><ul class="cook-ingr"></ul></div>
      <div class="section"><h3>Gör så här</h3><p class="small muted" style="margin:0 0 6px">Tryck på steget du är på.</p><ol class="cook-steps"></ol></div>
      <button class="btn wide" id="cookdone" style="margin-top:24px">Klar, stäng</button>
    </div>`);
    box.prepend(closeBtn());
    (r.ingredients || []).forEach(x => {
      const li = h(`<li><button type="button"><span class="box" aria-hidden="true"></span><span>${esc(x)}</span></button></li>`);
      $("button", li).onclick = () => li.classList.toggle("done");
      $(".cook-ingr", box).append(li);
    });
    const steps = $(".cook-steps", box);
    (r.steps || []).forEach((x, i) => {
      const li = h(`<li><button type="button">${esc(x)}</button></li>`);
      $("button", li).onclick = () => {
        [...steps.children].forEach((el, j) => { el.classList.toggle("done", j < i); el.classList.toggle("cur", j === i); });
      };
      steps.append(li);
    });
    if (steps.firstElementChild) steps.firstElementChild.classList.add("cur");
    $("#cookdone", box).onclick = closeSheet;
    openSheet(box, releaseAwake);
    $(".shade").classList.add("full");
    cookOpen = true;
    keepAwake().then(ok => {
      const a = $("#awake"); if (!a) return;
      a.textContent = ok ? "☀︎ Skärmen hålls tänd" : "Matlagningsläge";
      if (!ok) a.after(h(`<span class="small muted">Din telefon tillåter inte att skärmen hålls tänd (kräver iOS 18.4 eller senare).</span>`));
    });
  }

  // ---------- dela, skriv ut och säkerhetskopiera ----------
  function recipeText(r) {
    const lines = [r.name];
    const meta = [r.time && r.time + " min", r.servings && r.servings + " portioner"].filter(Boolean).join(" · ");
    if (meta) lines.push(meta);
    if ((r.ingredients || []).length) lines.push("", "Ingredienser", ...r.ingredients.map(x => "• " + x));
    if ((r.steps || []).length) lines.push("", "Gör så här", ...r.steps.map((x, i) => `${i + 1}. ${x}`));
    if (r.source) lines.push("", "Källa: " + r.source);
    lines.push("", "Från Middagsboken");
    return lines.join("\n");
  }
  async function copyText(text, okMsg) {
    try { await navigator.clipboard.writeText(text); toast(okMsg); return true; } catch { return false; }
  }
  async function shareRecipe(r) {
    const text = recipeText(r);
    if (navigator.share) {
      try { await navigator.share({ title: r.name, text }); return; }
      catch (e) { if (e && e.name === "AbortError") return; }
    }
    if (!(await copyText(text, "Receptet är kopierat. Klistra in det där du vill dela det."))) {
      const box = h(`<div><h2>Dela recept</h2><p class="small muted">Markera och kopiera texten.</p><textarea class="sharetext" readonly></textarea></div>`);
      box.prepend(closeBtn()); $("textarea", box).value = text; openSheet(box); $("textarea", box).select();
    }
  }

  function printRecipes(list, title) {
    const area = $("#printarea") || document.body.appendChild(h(`<div id="printarea"></div>`));
    area.innerHTML = `${title ? `<header class="pb-title"><h1>${esc(title)}</h1><p>${list.length} recept · ${fmtDateYear(new Date())}</p></header>` : ""}` +
      list.map(r => `<article class="pr">
        ${r.image ? `<img src="${esc(r.image)}" alt="">` : ""}
        <h2>${esc(r.name)}</h2>
        <p class="pm">${[r.time && r.time + " min", r.servings && r.servings + " portioner", ...(r.tags || [])].filter(Boolean).map(esc).join(" · ")}</p>
        <div class="pcols"><section><h3>Ingredienser</h3><ul>${(r.ingredients || []).map(x => `<li>${esc(x)}</li>`).join("")}</ul></section>
        <section><h3>Gör så här</h3><ol>${(r.steps || []).map(x => `<li>${esc(x)}</li>`).join("")}</ol></section></div>
        ${r.source ? `<p class="pm">Källa: ${esc(r.source)}</p>` : ""}
      </article>`).join("");
    const box = h(`<div><h2>Skriv ut eller spara som PDF</h2>
      <p class="small muted">${list.length === 1 ? "Receptet" : list.length + " recept"} läggs upp för utskrift på A4. På iPhone väljer du <b>Skriv ut</b>. För att spara som PDF trycker du sedan på <b>Dela</b> och väljer <b>Spara i Filer</b>.</p>
      <button class="btn primary" id="doprint">Skriv ut</button>
      <p class="small muted" style="margin-top:12px">Händer inget? Öppna appen i Safari i stället för från hemskärmen och försök igen.</p></div>`);
    box.prepend(closeBtn());
    $("#doprint", box).onclick = () => { closeSheet(); setTimeout(() => { try { window.print(); } catch { toast("Utskrift stöds inte här. Prova i Safari."); } }, 150); };
    openSheet(box);
  }

  async function saveFile(name, text, type) {
    const blob = new Blob([text], { type });
    try {
      const file = new File([blob], name, { type });
      if (navigator.canShare && navigator.canShare({ files: [file] })) { await navigator.share({ files: [file], title: name }); return; }
    } catch (e) { if (e && e.name === "AbortError") return; }
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob); a.download = name; document.body.append(a); a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
  }
  function exportBackup() {
    const fam = store.current ? store.current.name : "Middagsboken";
    const data = {
      app: "Middagsboken", format: 1, exported: new Date().toISOString(), family: fam,
      recipes: recipeList().map(({ id, ...r }) => r)
    };
    const day = new Date().toISOString().slice(0, 10);
    const slug = fam.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "recept";
    saveFile(`middagsboken-${slug}-${day}.json`, JSON.stringify(data, null, 2), "application/json");
  }
  function importBackup(file) {
    const fr = new FileReader();
    fr.onload = () => {
      let data;
      try { data = JSON.parse(fr.result); } catch { toast("Filen gick inte att läsa. Välj en säkerhetskopia från Middagsboken."); return; }
      const list = Array.isArray(data) ? data : data && data.recipes;
      if (!Array.isArray(list)) { toast("Filen innehåller inga recept."); return; }
      const have = new Set(recipeList().map(r => r.name.trim().toLowerCase()));
      let added = 0, skipped = 0;
      list.forEach(x => {
        if (!x || typeof x.name !== "string" || !x.name.trim()) return;
        if (have.has(x.name.trim().toLowerCase())) { skipped++; return; }
        const arr = v => Array.isArray(v) ? v.map(String).filter(Boolean) : [];
        store.change({ k: "r", id: newId(), data: {
          name: x.name.trim().slice(0, 120), time: String(x.time || ""), servings: Math.max(1, +x.servings || 4),
          tags: arr(x.tags), ingredients: arr(x.ingredients), steps: arr(x.steps),
          image: typeof x.image === "string" ? x.image : "", source: typeof x.source === "string" ? x.source : ""
        } });
        have.add(x.name.trim().toLowerCase()); added++;
      });
      closeSheet();
      toast(`${added} recept importerade${skipped ? `, ${skipped} fanns redan` : ""}`);
    };
    fr.readAsText(file);
  }
  function openExport() {
    const n = recipeList().length;
    const box = h(`<div><h2>Exportera</h2>
      <div class="section" style="margin-top:12px"><h3>Säkerhetskopia</h3>
        <p class="small muted" style="margin:0 0 8px">Alla ${n} recept i en fil som du kan spara i Filer, iCloud eller mejla till dig själv. Den kan importeras tillbaka, även till en annan familj. Bilder sparas som länkar.</p>
        <button class="btn primary" id="xb">Spara säkerhetskopia</button></div>
      <div class="section"><h3>Receptbok</h3>
        <p class="small muted" style="margin:0 0 8px">Alla recept uppställda för utskrift, eller för att spara som en PDF.</p>
        <button class="btn" id="xp">Skriv ut receptbok</button></div>
      <p class="small muted section">Vill du dela ett enda recept? Öppna receptet och tryck <b>Dela</b>.</p></div>`);
    box.prepend(closeBtn());
    $("#xb", box).onclick = exportBackup;
    $("#xp", box).onclick = () => printRecipes(recipeList(), (store.current ? store.current.name : "Middagsboken") + " · Recept");
    openSheet(box);
  }

  // ---------- import ----------
  function openImport() {
    const box = h(`<div>
      <h2>Importera recept</h2>
      <div class="section" style="margin-top:14px"><h3>Från en länk</h3>
        <p class="small muted" style="margin:0 0 8px">Fungerar med de flesta receptsidor, till exempel ICA, Köket, Arla och Coop. Kopiera adressen till receptet och klistra in den här.</p>
        <div class="addline" style="margin-top:0"><input id="iurl" type="url" inputmode="url" placeholder="https://www.ica.se/recept/…" enterkeyhint="go"><button class="btn primary" id="igo">Hämta</button></div>
        <p class="err small" id="ierr" hidden></p></div>
      <div class="section"><h3>Klistra in text</h3>
        <p class="small muted" style="margin:0 0 8px">Kopiera ett recept från en sida, ett mejl eller en anteckning. Första raden blir namnet. Rader med mängd, som "2 dl grädde", blir ingredienser och resten blir steg.</p>
        <div class="field"><textarea id="itext" placeholder="Pasta carbonara&#10;400 g spaghetti&#10;150 g bacon&#10;3 äggulor&#10;Koka pastan.&#10;Stek baconet…"></textarea></div>
        <button class="btn" id="iparse">Tolka texten</button></div>
      <div class="section"><h3>Från säkerhetskopia</h3>
        <p class="small muted" style="margin:0 0 8px">Välj en fil som exporterats från Middagsboken. Recept med samma namn som ett befintligt hoppas över.</p>
        <label class="btn" for="ifile">Välj fil</label><input id="ifile" type="file" accept=".json,application/json" hidden></div>
    </div>`);
    box.prepend(closeBtn());
    const err = t => { const p = $("#ierr", box); p.hidden = !t; p.textContent = t || ""; };
    const go = async () => {
      const url = $("#iurl", box).value.trim();
      if (!/^https?:\/\/\S+\.\S+/.test(url)) { err("Klistra in en hel adress som börjar med https://"); return; }
      if (!CLOUD) { err("Import från länk fungerar när appen är kopplad till databasen."); return; }
      if (!navigator.onLine) { err("Du behöver vara online för att hämta ett recept."); return; }
      err(""); const b = $("#igo", box); b.disabled = true; b.textContent = "Hämtar…";
      try {
        const { data, error } = await store.sb.functions.invoke("importera-recept", { body: { url } });
        if (error) {
          let msg = "";
          try { msg = (await error.context.json()).error; } catch {}
          if (!msg && /not found|404|FunctionsRelayError|FunctionsFetchError/i.test(errText(error))) msg = "Importfunktionen är inte installerad i Supabase än.";
          throw new Error(msg || "Kunde inte hämta receptet.");
        }
        openEditor({ ...data, source: url });
        toast("Kontrollera receptet och tryck Spara");
      } catch (e) {
        err(e.message || "Kunde inte hämta receptet.");
      } finally { b.disabled = false; b.textContent = "Hämta"; }
    };
    $("#igo", box).onclick = go;
    $("#iurl", box).onkeydown = e => { if (e.key === "Enter") go(); };
    $("#ifile", box).onchange = e => { const f = e.target.files && e.target.files[0]; if (f) importBackup(f); };
    $("#iparse", box).onclick = () => {
      const r = parseRecipeText($("#itext", box).value);
      if (!r) { toast("Klistra in ett recept först"); return; }
      openEditor(r);
      toast("Kontrollera receptet och tryck Spara");
    };
    openSheet(box);
  }

  function parseRecipeText(text) {
    const lines = text.split(/\r?\n/).map(l => l.replace(/^[\s•*·\-–—]+/, "").trim()).filter(Boolean);
    if (!lines.length) return null;
    const r = { name: lines.shift(), time: "", servings: 4, tags: [], ingredients: [], steps: [], image: "" };
    const ingHead = /^(ingredienser|ingrediens|du behöver|det här behöver du)\b/i;
    const stepHead = /^(gör så här|så här gör du|instruktioner|tillagning|tillvägagångssätt|beskrivning|gör så)\b/i;
    const portions = /(\d+)\s*(portioner|port|personer|pers)\b/i;
    const minutes = /(\d+)\s*(min|minuter)\b/i;
    let mode = "";
    lines.forEach(l => {
      if (ingHead.test(l)) { mode = "i"; return; }
      if (stepHead.test(l)) { mode = "s"; return; }
      if (l.length < 40 && portions.test(l) && !mode) { r.servings = +l.match(portions)[1]; return; }
      if (l.length < 40 && minutes.test(l) && !mode) { r.time = l.match(minutes)[1]; return; }
      const looksIng = /^[\d½¼¾]/.test(l) && l.length < 70 && !/^\d+[.)]\s/.test(l);
      if (mode === "i") { if (l.length > 90) { mode = "s"; r.steps.push(l); } else r.ingredients.push(l); }
      else if (mode === "s") r.steps.push(l.replace(/^\d+[.)]\s*/, ""));
      else if (looksIng) r.ingredients.push(l);
      else r.steps.push(l.replace(/^\d+[.)]\s*/, ""));
    });
    return r;
  }

  // ---------- inköpslista ----------
  const UNITS = ["kg", "g", "hg", "l", "dl", "cl", "ml", "msk", "tsk", "krm", "st", "förp", "paket", "pkt", "burk", "burkar", "klyfta", "klyftor", "knippe", "påse", "påsar", "skivor", "skiva", "kruka"];
  function parseAmount(s) {
    s = s.replace("½", ".5").replace("¼", ".25").replace("¾", ".75").replace(",", ".");
    if (/^\d+\/\d+$/.test(s)) { const [a, b] = s.split("/"); return a / b; }
    if (/^\d*\.?\d+$/.test(s)) return parseFloat(s);
    return NaN;
  }
  function parseLine(line) {
    line = line.replace(/^(\d+)\s+([½¼¾])/, "$1$2");
    const m = line.match(/^([\d.,½¼¾\/]+)\s*(\S+)?\s*(.*)$/);
    if (!m) return { qty: NaN, unit: "", name: line };
    const qty = parseAmount(m[1]);
    if (isNaN(qty)) return { qty: NaN, unit: "", name: line };
    let unit = (m[2] || "").toLowerCase(), name = m[3];
    if (!UNITS.includes(unit)) { name = ((m[2] || "") + " " + name).trim(); unit = ""; }
    return { qty, unit, name: name || line };
  }
  function buildShop(wk) {
    const items = new Map();
    wk.days.forEach((d, i) => {
      const r = d.recipeId && recipeById(d.recipeId); if (!r) return;
      const factor = wk.servings / (r.servings || wk.servings);
      (r.ingredients || []).forEach(line => {
        const p = parseLine(line);
        const key = (isNaN(p.qty) ? "~" : p.unit) + "|" + p.name.toLowerCase();
        const it = items.get(key) || { key, name: p.name, unit: p.unit, qty: 0, text: [], from: new Set() };
        if (isNaN(p.qty)) { if (!it.text.includes(line)) it.text.push(line); } else it.qty += p.qty * factor;
        it.from.add(DAYS[i].slice(0, 3).toLowerCase());
        items.set(key, it);
      });
    });
    return [...items.values()].sort((a, b) => a.name.localeCompare(b.name, "sv"));
  }
  function renderShop(main) {
    main.append(weekNav());
    const wk = getWeek(), sh = getShop(), items = buildShop(wk), checked = new Set(sh.checked), edits = sh.edits;
    const save = patch => putShop({ ...getShop(), ...patch });
    const toggle = key => {
      const s2 = new Set(getShop().checked); s2.has(key) ? s2.delete(key) : s2.add(key);
      save({ checked: [...s2] });
    };
    const planned = wk.days.filter(d => d.recipeId && recipeById(d.recipeId)).length;
    main.append(h(`<p class="muted" style="margin:0 0 12px">${planned ? `Ingredienser för ${planned === 1 ? "1 middag" : planned + " middagar"}, beräknat för ${wk.servings} personer. Tryck ✎ för att ändra en vara.` : "Planera veckans middagar först, så fylls listan i automatiskt."}</p>`));
    const label = it => {
      const e = edits[it.key];
      if (e && e.text) return `${esc(e.text)} <span class="edited">ändrad</span>`;
      const amt = it.qty ? fmtNum(it.qty) + (it.unit ? " " + it.unit : "") : "";
      return it.text.length && !it.qty ? esc(it.text.join(", ")) : `${amt ? `<span class="amt">${esc(amt)}</span>` : ""}${esc(it.name)}${it.text.length ? " + " + esc(it.text.join(", ")) : ""}`;
    };
    const plain = it => {
      const amt = it.qty ? fmtNum(it.qty) + (it.unit ? " " + it.unit : "") + " " : "";
      return it.text.length && !it.qty ? it.text.join(", ") : amt + it.name + (it.text.length ? " + " + it.text.join(", ") : "");
    };
    const visible = items.filter(it => !(edits[it.key] && edits[it.key].hidden));
    const hidden = items.filter(it => edits[it.key] && edits[it.key].hidden);
    if (visible.length) {
      const left = visible.filter(i => !checked.has(i.key)).length;
      main.append(h(`<div class="label" style="margin-bottom:4px">${left} kvar att handla</div>`));
      const ul = h(`<ul class="shop"></ul>`);
      visible.sort((a, b) => checked.has(a.key) - checked.has(b.key)).forEach((it, n) => {
        const li = h(`<li class="${checked.has(it.key) ? "done" : ""}"><input type="checkbox" id="s${n}" ${checked.has(it.key) ? "checked" : ""}><label for="s${n}">${label(it)}<span class="from">${[...it.from].join(", ")}</span></label><button class="x" aria-label="Ändra">✎</button></li>`);
        $("input", li).onchange = () => toggle(it.key);
        $(".x", li).onclick = () => editShopItem(it, plain(it));
        ul.append(li);
      });
      main.append(ul);
    }
    if (hidden.length) {
      const d = h(`<details class="section hiddenitems"><summary class="small">Har hemma (${hidden.length})</summary><ul class="shop"></ul></details>`);
      hidden.forEach(it => {
        const li = h(`<li><span class="lbl">${label(it)}</span><button class="btn small">Lägg tillbaka</button></li>`);
        $("button", li).onclick = () => { const e2 = { ...getShop().edits }; const cur = { ...(e2[it.key] || {}) }; delete cur.hidden; if (Object.keys(cur).length) e2[it.key] = cur; else delete e2[it.key]; save({ edits: e2 }); };
        $("ul", d).append(li);
      });
      main.append(d);
    }
    const sec = h(`<div class="section"><h3>Övrigt att handla</h3><ul class="shop"></ul>
      <form class="addline"><input id="extra" placeholder="T.ex. Mjölk, kaffe, tandkräm" enterkeyhint="done"><button class="btn" type="submit">Lägg till</button></form></div>`);
    const eul = $("ul", sec);
    sh.extras.forEach((x, i) => {
      const key = "extra:" + x;
      const li = h(`<li class="${checked.has(key) ? "done" : ""}"><input type="checkbox" id="e${i}" ${checked.has(key) ? "checked" : ""}><label for="e${i}">${esc(x)}</label><button class="x" aria-label="Ta bort ${esc(x)}">✕</button></li>`);
      $("input", li).onchange = () => toggle(key);
      $(".x", li).onclick = () => { const c = getShop(); save({ extras: c.extras.filter(e => e !== x), checked: c.checked.filter(k => k !== key) }); };
      eul.append(li);
    });
    $("form", sec).onsubmit = e => {
      e.preventDefault(); const v = $("#extra", sec).value.trim(); if (!v) return;
      const c = getShop(); if (!c.extras.includes(v)) save({ extras: [...c.extras, v] });
      setTimeout(() => { const f = $("#extra"); if (f) f.focus(); }, 0);
    };
    main.append(sec);
    if (checked.size) {
      const b2 = h(`<button class="btn" style="margin-top:18px">Avmarkera allt</button>`);
      b2.onclick = () => save({ checked: [] });
      main.append(b2);
    }
  }

  function editShopItem(it, original) {
    const cur = (getShop().edits[it.key] || {});
    const box = h(`<form><h2>Ändra vara</h2>
      <p class="small muted" style="margin:0 0 10px">Från receptet: ${esc(original)}</p>
      <div class="field"><label for="se">Det här ska stå på listan</label><input id="se" value="${esc(cur.text || original)}" maxlength="80"></div>
      <div class="row"><button class="btn primary" type="submit">Spara</button><button class="btn" type="button" id="home">Har hemma</button>${cur.text ? `<button class="btn" type="button" id="reset">Återställ</button>` : ""}</div>
      <p class="small muted" style="margin-top:12px">Ändringen gäller bara den här veckans lista. Receptet ändras inte.</p></form>`);
    box.prepend(closeBtn());
    const setEdit = patch => {
      const e2 = { ...getShop().edits }; const next = { ...(e2[it.key] || {}), ...patch };
      Object.keys(next).forEach(k => { if (next[k] === undefined || next[k] === "") delete next[k]; });
      if (Object.keys(next).length) e2[it.key] = next; else delete e2[it.key];
      putShop({ ...getShop(), edits: e2 });
    };
    box.onsubmit = e => { e.preventDefault(); const v = $("#se", box).value.trim(); setEdit({ text: v && v !== original ? v : undefined }); closeSheet(); };
    $("#home", box).onclick = () => { setEdit({ hidden: true }); closeSheet(); toast("Flyttad till Har hemma"); };
    const rs = $("#reset", box); if (rs) rs.onclick = () => { setEdit({ text: undefined }); closeSheet(); };
    openSheet(box);
  }

  // ---------- sidhuvud ----------
  function renderHeader() {
    const b = $("#fam");
    const f = CLOUD && store.user && store.current;
    b.hidden = !f;
    if (f) b.textContent = f.name + " ▾";
  }
  $("#fam").addEventListener("click", openFamily);

  // ---------- familj ----------
  const inviteLink = code => location.origin + location.pathname + "?join=" + encodeURIComponent(code);

  async function rpc(name, args) {
    const { data, error } = await store.sb.rpc(name, args);
    if (error) throw error;
    return data;
  }
  function rpcError(e, fallback) {
    const t = errText(e);
    if (/Okänd kod/.test(t)) return "Koden finns inte. Kontrollera att den är rätt skriven.";
    if (isNetworkError(e)) return "Ingen internetanslutning. Försök igen när du är online.";
    if (isSchemaError(e)) return "Databasen behöver uppdateras. Kör supabase-setup.sql i Supabase.";
    return fallback;
  }

  async function createFamily(name, withSeed) {
    const fid = await rpc("create_family", { p_name: name, p_display: store.myName });
    await store.loadFamilies();
    await store.switchFamily(fid);
    if (withSeed) (window.MIDDAG_SEED || []).forEach(({ id, ...r }) => store.change({ k: "r", id: newId() + id.slice(0, 3), data: r }));
    toast(`Familjen "${name}" är skapad`);
  }
  async function joinFamily(code) {
    const fid = await rpc("join_family", { p_code: code, p_display: store.myName });
    lsDel(K_JOIN);
    await store.loadFamilies();
    await store.switchFamily(fid);
    toast(`Välkommen till ${store.current ? store.current.name : "familjen"}!`);
  }

  // Formulär för att skapa eller gå med, används både första gången och från familjemenyn.
  function familyForms(code) {
    const el = h(`<div class="famforms">
      <form class="famcard" id="fc">
        <h3>Skapa en familj</h3>
        <p class="small muted">Du blir ägare och kan sedan bjuda in andra.</p>
        <div class="field"><label for="fn">Familjens namn</label><input id="fn" required placeholder="T.ex. Familjen Lind" maxlength="40"></div>
        <label class="check small"><input type="checkbox" id="fseed" checked> Börja med 8 startrecept</label>
        <p class="err small" hidden></p>
        <button class="btn primary" type="submit">Skapa familj</button>
      </form>
      <form class="famcard" id="fj">
        <h3>Gå med i en familj</h3>
        <p class="small muted">Be någon i familjen om inbjudningskoden. Den finns under familjens namn högst upp i appen.</p>
        <div class="field"><label for="fcode">Inbjudningskod</label><input id="fcode" required placeholder="T.ex. 7K3F9A" maxlength="6" autocapitalize="characters" autocomplete="off" value="${esc(code || "")}" class="code-input"></div>
        <p class="err small" hidden></p>
        <button class="btn primary" type="submit">Gå med</button>
      </form></div>`);
    const err = (form, t) => { const p = $(".err", form); p.hidden = !t; p.textContent = t || ""; };
    $("#fc", el).onsubmit = async e => {
      e.preventDefault(); const f = e.currentTarget, btn = $("button[type=submit]", f);
      btn.disabled = true; err(f, "");
      try { await createFamily($("#fn", f).value.trim(), $("#fseed", f).checked); }
      catch (x) { err(f, rpcError(x, "Familjen kunde inte skapas. Försök igen.")); }
      finally { btn.disabled = false; }
    };
    $("#fj", el).onsubmit = async e => {
      e.preventDefault(); const f = e.currentTarget, btn = $("button[type=submit]", f);
      btn.disabled = true; err(f, "");
      try { await joinFamily($("#fcode", f).value.trim()); }
      catch (x) { err(f, rpcError(x, "Det gick inte att gå med. Försök igen.")); }
      finally { btn.disabled = false; }
    };
    return el;
  }

  function showOnboarding() {
    document.body.classList.add("locked");
    store.family = null; renderHeader();
    const box = h(`<div class="login onboard">
      <img class="logo" src="icons/apple-touch-icon.png" alt="">
      <h2>Hej ${esc(store.myName)}!</h2>
      <p>För att komma igång skapar du en familj eller går med i en som redan finns. Du kan vara med i flera familjer, till exempel ert hushåll och en syskongrupp.</p>
    </div>`);
    box.append(familyForms(lsGet(K_JOIN, "")));
    const out = h(`<p class="small" style="margin-top:20px"><button type="button" class="btn">Logga ut</button></p>`);
    $("button", out).onclick = () => store.signOut();
    box.append(out);
    $("#main").replaceChildren(box);
  }

  async function openJoinPrompt(code) {
    let name = null;
    try { name = await rpc("family_name_by_code", { p_code: code }); } catch (e) {
      if (isNetworkError(e)) return; // försök igen nästa gång appen öppnas
    }
    if (!name) { lsDel(K_JOIN); toast("Inbjudan gäller inte längre. Be om en ny kod."); return; }
    const already = store.families.find(f => f.invite_code === code.toUpperCase());
    if (already) { lsDel(K_JOIN); if (already.id !== store.family) store.switchFamily(already.id); return; }
    const box = h(`<div><h2>Du är inbjuden</h2>
      <p>Vill du gå med i <b>${esc(name)}</b>? Då ser du familjens recept, veckomeny och inköpslista, och kan ändra i dem.</p>
      <p class="err small" hidden></p>
      <div class="row"><button class="btn primary" id="jy">Gå med</button><button class="btn" id="jn">Inte nu</button></div></div>`);
    $("#jy", box).onclick = async () => {
      try { await joinFamily(code); } catch (x) { const p = $(".err", box); p.hidden = false; p.textContent = rpcError(x, "Det gick inte att gå med."); }
    };
    $("#jn", box).onclick = () => { lsDel(K_JOIN); closeSheet(); };
    openSheet(box);
  }

  function chooseFamily() {
    const saved = lsGet(K_FAMILY, null);
    const f = store.families.find(x => x.id === saved) || store.families[0];
    if (f) store.switchFamily(f.id); else showOnboarding();
  }

  function openFamily() {
    const f = store.current; if (!f) return;
    const owner = f.role === "owner";
    const ids = Object.keys(store.members).sort((a, b) => (store.members[a].name || "").localeCompare(store.members[b].name || "", "sv"));
    const box = h(`<div class="family">
      <h2>${esc(f.name)}</h2>
      <p class="small muted" style="margin:0">${ids.length === 1 ? "1 medlem" : ids.length + " medlemmar"}${owner ? " · du är ägare" : ""}</p>
      ${owner ? `<form class="addline" id="rn" style="margin-top:12px"><input id="rnn" value="${esc(f.name)}" maxlength="40" aria-label="Familjens namn"><button class="btn" type="submit">Byt namn</button></form>` : ""}

      <div class="section"><h3>Bjud in</h3>
        <p class="small muted" style="margin:0 0 10px">Skicka länken till den som ska vara med, eller ge dem koden. De skapar ett eget konto och kommer direkt in i familjen.</p>
        <div class="invite"><span class="label">Kod</span><span class="code">${esc(f.invite_code)}</span></div>
        <div class="row" style="margin-top:10px"><button class="btn primary" id="share">Dela inbjudan</button><button class="btn" id="copy">Kopiera länk</button>${owner ? `<button class="btn" id="newcode">Ny kod</button>` : ""}</div>
        <p class="small muted linktext" id="lt">${esc(inviteLink(f.invite_code))}</p>
      </div>

      <div class="section"><h3>Medlemmar</h3>
        <p class="small muted" style="margin:0 0 4px"><b>Medlem</b> ser allt, betygsätter, bockar av inköpslistan och föreslår middagar. <b>Redigerare</b> ändrar också menyer och recept. <b>Ägare</b> hanterar dessutom familjen. Nya medlemmar börjar som Medlem.</p>
        <ul class="members"></ul></div>
      ${owner ? `<div class="section"><h3>Väggskärm</h3>
        <p class="small muted" style="margin:0 0 8px">En egen sida som bara visar veckans meny, till exempel på en surfplatta med Home Assistant. Den behöver ingen inloggning, så dela bara länken med skärmen.</p>
        <div id="disp"></div></div>` : ""}

      ${store.families.length > 1 ? `<div class="section"><h3>Dina familjer</h3><ul class="famlist"></ul></div>` : ""}

      <div class="section row"><button class="btn" id="newfam">Skapa eller gå med i en annan familj</button></div>
      <div class="section row"><button class="btn danger" id="leave">Lämna ${esc(f.name)}</button></div>
    </div>`);
    box.prepend(closeBtn());

    const ul = $(".members", box);
    ids.forEach(uid => {
      const m = store.members[uid], me = uid === store.me;
      const li = h(`<li><span class="mname">${esc(m.name || "Namnlös")}${me ? " <span class='muted'>(du)</span>" : ""}</span><span class="mact"></span></li>`);
      const act = $(".mact", li);
      if (owner && !(me && !ids.some(x => x !== uid && store.members[x].role === "owner"))) {
        const sel = h(`<select class="btn small" aria-label="Roll för ${esc(m.name || "")}">${Object.entries(ROLE_NAMES).map(([k, v]) => `<option value="${k}"${m.role === k ? " selected" : ""}>${v}</option>`).join("")}</select>`);
        sel.onchange = async () => {
          try { await rpc("set_member_role", { fid: f.id, uid, p_role: sel.value }); await store.refreshMembers(); openFamily(); toast(`${m.name || "Medlemmen"} är nu ${ROLE_NAMES[sel.value].toLowerCase()}`); }
          catch (e) { toast(rpcError(e, "Rollen kunde inte ändras.")); openFamily(); }
        };
        act.append(sel);
      } else act.append(h(`<span class="tag">${ROLE_NAMES[m.role] || "Medlem"}</span>`));
      if (owner && !me) {
        const rm = h(`<button class="btn small danger">Ta bort</button>`);
        rm.onclick = async () => {
          if (!rm.classList.contains("armed")) { rm.classList.add("armed"); rm.textContent = "Ja, ta bort"; return; }
          const { error } = await store.sb.from("family_members").delete().eq("family_id", f.id).eq("user_id", uid);
          if (error) { toast(rpcError(error, "Det gick inte att ta bort.")); return; }
          await store.refreshMembers(); openFamily(); toast(`${m.name || "Medlemmen"} är borttagen`);
        };
        act.append(rm);
      }
      ul.append(li);
    });

    const fl = $(".famlist", box);
    if (fl) store.families.forEach(x => {
      const li = h(`<li><button class="${x.id === f.id ? "cur" : ""}">${esc(x.name)}${x.id === f.id ? " ✓" : ""}</button></li>`);
      $("button", li).onclick = () => { if (x.id !== f.id) store.switchFamily(x.id); };
      fl.append(li);
    });

    const disp = $("#disp", box);
    if (disp) {
      const url = f.display_key ? new URL("visa.html?nyckel=" + f.display_key, location.href).href : "";
      if (url) {
        disp.append(h(`<div><p class="small linktext">${esc(url)}</p><div class="row" style="margin-top:8px"><button class="btn" id="dcopy">Kopiera länk</button><a class="btn" href="${esc(url)}" target="_blank" rel="noopener">Öppna</a><button class="btn danger" id="dnew">Ny länk</button><button class="btn danger" id="doff">Stäng av</button></div></div>`));
        $("#dcopy", disp).onclick = () => copyText(url, "Länken är kopierad");
        const dn = $("#dnew", disp);
        dn.onclick = async () => {
          if (!dn.classList.contains("armed")) { dn.classList.add("armed"); dn.textContent = "Ja, ny länk"; toast("Den gamla länken slutar fungera"); return; }
          try { await rpc("new_display_key", { fid: f.id }); await store.loadFamilies(); openFamily(); } catch (e) { toast(rpcError(e, "Det gick inte.")); }
        };
        const off = $("#doff", disp);
        off.onclick = async () => {
          if (!off.classList.contains("armed")) { off.classList.add("armed"); off.textContent = "Ja, stäng av"; return; }
          try { await rpc("remove_display_key", { fid: f.id }); await store.loadFamilies(); openFamily(); toast("Väggskärmen är avstängd"); } catch (e) { toast(rpcError(e, "Det gick inte.")); }
        };
      } else {
        const on = h(`<button class="btn primary">Skapa länk till väggskärm</button>`);
        on.onclick = async () => { try { await rpc("new_display_key", { fid: f.id }); await store.loadFamilies(); openFamily(); } catch (e) { toast(rpcError(e, "Det gick inte att skapa länken.")); } };
        disp.append(on);
      }
    }
    const rn = $("#rn", box);
    if (rn) rn.onsubmit = async e => {
      e.preventDefault(); const name = $("#rnn", box).value.trim(); if (!name || name === f.name) return;
      const { error } = await store.sb.from("families").update({ name }).eq("id", f.id);
      if (error) { toast(rpcError(error, "Namnet kunde inte sparas.")); return; }
      await store.loadFamilies(); renderHeader(); openFamily(); toast("Namnet är ändrat");
    };
    const link = inviteLink(f.invite_code);
    const text = `Häng med i "${f.name}" i Middagsboken, så planerar vi middagarna tillsammans. Öppna länken och skapa ett konto: ${link} (kod ${f.invite_code})`;
    const copy = async () => {
      try { await navigator.clipboard.writeText(link); toast("Länken är kopierad"); }
      catch { const r = document.createRange(); r.selectNodeContents($("#lt", box)); const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r); toast("Markerad. Välj Kopiera."); }
    };
    $("#share", box).onclick = async () => {
      if (navigator.share) { try { await navigator.share({ title: "Middagsboken", text }); } catch {} }
      else copy();
    };
    $("#copy", box).onclick = copy;
    const nc = $("#newcode", box);
    if (nc) nc.onclick = async () => {
      if (!nc.classList.contains("armed")) { nc.classList.add("armed"); nc.textContent = "Ja, ny kod"; toast("Den gamla koden och länken slutar fungera"); return; }
      try { await rpc("new_invite_code", { fid: f.id }); await store.loadFamilies(); openFamily(); toast("Ny kod skapad"); }
      catch (e) { toast(rpcError(e, "Det gick inte att byta kod.")); }
    };
    $("#newfam", box).onclick = () => {
      const b2 = h(`<div><h2>Fler familjer</h2></div>`); b2.prepend(closeBtn()); b2.append(familyForms("")); openSheet(b2);
    };
    const lv = $("#leave", box);
    lv.onclick = async () => {
      if (!lv.classList.contains("armed")) {
        lv.classList.add("armed");
        lv.textContent = ids.length === 1 ? "Ja, lämna (familjen raderas inte)" : "Ja, lämna familjen";
        return;
      }
      const { error } = await store.sb.from("family_members").delete().eq("family_id", f.id).eq("user_id", store.me);
      if (error) { toast(rpcError(error, "Det gick inte att lämna.")); return; }
      lsDel(cacheKey(f.id)); lsDel(K_FAMILY);
      await store.loadFamilies(); closeSheet(); toast(`Du har lämnat ${f.name}`); chooseFamily();
    };
    openSheet(box);
  }

  // ---------- inställningar ----------
  function openSettings() {
    const box = h(`<div class="settings">
      <h2>Inställningar</h2>
      <dl>
        <dt>Status</dt><dd>${esc($("#sync").textContent)}</dd>
        ${CLOUD && store.user ? `<dt>Inloggad</dt><dd>${esc(store.user.email)}</dd>` : ""}
        ${CLOUD && store.current ? `<dt>Familj</dt><dd>${esc(store.current.name)}</dd>` : ""}
        ${!CLOUD ? `<dt>Läge</dt><dd>Testläge. Allt sparas bara på den här enheten.</dd>` : ""}
        ${store.outbox.length ? `<dt>Väntar</dt><dd>${store.outbox.length} ändringar sparas när du är online</dd>` : ""}
        <dt>Recept</dt><dd>${recipeList().length} st</dd>
        <dt>Version</dt><dd>${APP_VERSION}</dd>
      </dl>
      ${CLOUD && store.user ? `<form class="field" id="myname"><label for="mn">Ditt namn (syns för familjen)</label><div class="addline" style="margin-top:0"><input id="mn" value="${esc(store.myName)}" maxlength="30"><button class="btn" type="submit">Spara</button></div></form>` : ""}
      <div class="row" id="acts"></div>
      ${!isStandalone ? `<div class="section"><div class="label">Installera</div><p class="small">Öppna sidan i Safari, tryck på Dela och välj <b>Lägg till på hemskärmen</b>.</p></div>` : ""}
    </div>`);
    box.prepend(closeBtn());
    const acts = $("#acts", box);
    if (CLOUD && store.user) {
      $("#myname", box).onsubmit = async e => {
        e.preventDefault(); const name = $("#mn", box).value.trim(); if (!name) return;
        const { data, error } = await store.sb.auth.updateUser({ data: { name } });
        if (error) { toast(rpcError(error, "Namnet kunde inte sparas.")); return; }
        store.user = data.user;
        try { await rpc("set_display_name", { p_name: name }); } catch {}
        if (store.family) await store.refreshMembers();
        toast("Namnet är sparat");
      };
      if (store.current) {
        const fam = h(`<button class="btn">Familj och inbjudan</button>`); fam.onclick = openFamily; acts.append(fam);
      }
      const rf = h(`<button class="btn">Uppdatera nu</button>`);
      rf.onclick = async () => { rf.disabled = true; store.needsDbUpdate = false; await store.loadFamilies(); await store.refresh(); closeSheet(); toast("Uppdaterad"); };
      const pw = h(`<button class="btn">Byt lösenord</button>`);
      pw.onclick = () => openNewPassword(false);
      const out = h(`<button class="btn danger">Logga ut</button>`);
      out.onclick = () => store.signOut();
      acts.append(rf, pw, out);
    }
    openSheet(box);
  }

  function openNewPassword(fromEmail) {
    const box = h(`<form>
      <h2>${fromEmail ? "Välj ett nytt lösenord" : "Byt lösenord"}</h2>
      <div class="field" style="margin-top:14px"><label for="np">Nytt lösenord</label><input id="np" type="password" minlength="6" autocomplete="new-password" required></div>
      <p class="err" hidden></p>
      <button class="btn primary" type="submit">Spara lösenord</button></form>`);
    box.prepend(closeBtn());
    box.onsubmit = async e => {
      e.preventDefault();
      const { error } = await store.sb.auth.updateUser({ password: $("#np", box).value });
      if (error) { const p = $(".err", box); p.hidden = false; p.textContent = "Lösenordet kunde inte sparas. Det måste vara minst 6 tecken."; return; }
      closeSheet(); toast("Lösenordet är bytt");
    };
    openSheet(box);
  }

  // ---------- inloggning och konto ----------
  function showLogin(message, mode) {
    document.body.classList.add("locked");
    const invited = !!lsGet(K_JOIN, "");
    mode = mode || (invited ? "signup" : "login");
    const signup = mode === "signup";
    const box = h(`<form class="login">
      <img class="logo" src="icons/apple-touch-icon.png" alt="">
      <h2>${signup ? "Skapa konto" : "Välkommen"}</h2>
      <p>${invited ? "Du har blivit inbjuden till en familj i Middagsboken. " : ""}${signup ? "Fyll i dina uppgifter. Sedan skapar du en familj eller går med i en." : "Logga in för att se familjens recept och veckomeny."}</p>
      <p class="err" ${message ? "" : "hidden"}>${esc(message || "")}</p>
      ${signup ? `<div class="field"><label for="ln">Ditt namn</label><input id="ln" autocomplete="given-name" required maxlength="30" placeholder="Det här ser familjen"></div>` : ""}
      <div class="field"><label for="le">E-post</label><input id="le" type="email" autocomplete="email" autocapitalize="off" required></div>
      <div class="field"><label for="lp">Lösenord</label><input id="lp" type="password" ${signup ? `minlength="6" autocomplete="new-password"` : `autocomplete="current-password"`} required>${signup ? `<span class="hint">Minst 6 tecken.</span>` : ""}</div>
      <button class="btn primary wide" type="submit">${signup ? "Skapa konto" : "Logga in"}</button>
      <p class="small switch">${signup ? "Har du redan ett konto?" : "Ny här?"} <button type="button" class="linkbtn" id="mode">${signup ? "Logga in" : "Skapa konto"}</button></p>
      ${signup ? "" : `<p class="small"><button type="button" class="linkbtn" id="forgot">Glömt lösenordet?</button></p>`}
    </form>`);
    const err = t => { const p = $(".err", box); p.hidden = !t; p.textContent = t || ""; };
    $("#mode", box).onclick = () => showLogin("", signup ? "login" : "signup");
    box.onsubmit = async e => {
      e.preventDefault(); err("");
      const btn = $("button[type=submit]", box), label = btn.textContent;
      btn.disabled = true; btn.textContent = signup ? "Skapar konto…" : "Loggar in…";
      const email = $("#le", box).value.trim(), password = $("#lp", box).value;
      let res;
      if (signup) {
        res = await store.sb.auth.signUp({ email, password, options: { data: { name: $("#ln", box).value.trim() }, emailRedirectTo: location.origin + location.pathname } });
      } else {
        res = await store.sb.auth.signInWithPassword({ email, password });
      }
      btn.disabled = false; btn.textContent = label;
      const { data, error } = res;
      if (error) {
        const t = errText(error);
        if (isNetworkError(error)) err("Ingen internetanslutning. Försök igen när du är online.");
        else if (/already registered|already exists/i.test(t)) err("Det finns redan ett konto med den e-posten. Logga in i stället.");
        else if (/signups not allowed|signup.*disabled/i.test(t)) err("Det går inte att skapa nya konton just nu. Registrering är avstängd i Supabase.");
        else if (/email not confirmed/i.test(t)) err("Bekräfta din e-post först. Kolla inkorgen efter ett mejl från Supabase.");
        else if (/password/i.test(t) && signup) err("Lösenordet måste vara minst 6 tecken.");
        else if (/rate limit/i.test(t)) err("För många försök. Vänta en stund och försök igen.");
        else err(signup ? "Kontot kunde inte skapas: " + t : "Fel e-post eller lösenord.");
        return;
      }
      if (signup && !data.session) {
        showLogin("", "login");
        const p = $(".login .err"); p.hidden = false; p.className = "ok";
        p.textContent = `Nästan klart! Vi har skickat ett mejl till ${email}. Klicka på länken i mejlet och logga sedan in här.`;
        return;
      }
      afterLogin(data.session);
    };
    const fg = $("#forgot", box);
    if (fg) fg.onclick = async () => {
      const email = $("#le", box).value.trim();
      if (!email) { err("Skriv din e-post först, så skickar vi en länk."); $("#le", box).focus(); return; }
      const { error } = await store.sb.auth.resetPasswordForEmail(email, { redirectTo: location.origin + location.pathname });
      err(""); toast(error ? "Kunde inte skicka. Försök igen om en stund." : "Kolla din e-post efter en länk.");
    };
    $("#main").replaceChildren(box);
  }

  let loggingIn = false;
  async function afterLogin(session) {
    if (loggingIn || (store.user && store.user.id === session.user.id && store.family)) return;
    loggingIn = true;
    try {
      store.user = session.user; store.me = session.user.id;
      setSync("Ansluter…");
      const status = await store.loadFamilies();
      if (status === "schema") {
        document.body.classList.add("locked");
        $("#main").replaceChildren(h(`<div class="login"><h2>Databasen behöver uppdateras</h2>
          <p>Den här versionen av appen har stöd för familjer. Kör filen <b>supabase-setup.sql</b> en gång till i Supabase (SQL Editor → New query → klistra in → Run) och öppna sedan appen igen.</p></div>`));
        return;
      }
      const join = lsGet(K_JOIN, "");
      if (!store.families.length) {
        if (status !== "ok") { showLogin("Kunde inte nå databasen. Kontrollera internetanslutningen och försök igen."); store.user = null; return; }
        showOnboarding();
        if (join) openJoinPrompt(join);
        return;
      }
      chooseFamily();
      if (join) setTimeout(() => openJoinPrompt(join), 400);
    } finally { loggingIn = false; }
  }

  // ---------- start ----------
  async function start() {
    const joinCode = new URLSearchParams(location.search).get("join");
    if (joinCode) {
      lsSet(K_JOIN, joinCode.trim().toUpperCase());
      history.replaceState(null, "", location.pathname + location.hash);
    }
    if (!CLOUD) {
      store.family = null;
      if (!store.loadCache()) {
        (window.MIDDAG_SEED || []).forEach(({ id, ...r }) => store.recipes[id] = r);
        store.saveCache();
      }
      state.loaded = true;
      setSync("Testläge", "warn");
      render();
      return;
    }
    store.sb = window.supabase.createClient(CFG.supabaseUrl, CFG.supabaseKey, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
    });
    store.sb.auth.onAuthStateChange((event, session) => {
      if (event === "PASSWORD_RECOVERY") setTimeout(() => openNewPassword(true), 300);
      if (event === "SIGNED_IN" && session && !store.user) afterLogin(session);
    });
    setSync("Ansluter…");
    const { data } = await store.sb.auth.getSession();
    if (data && data.session) afterLogin(data.session);
    else showLogin();

    window.addEventListener("online", () => store.refresh());
    window.addEventListener("offline", () => setSync("Offline", "warn"));
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible" && store.user && store.family) { store.subscribe(); store.refresh(); }
    });
  }

  // Exponeras för tester
  window.__middag = { parseRecipeText, mondayFromKey, keyFor, store };

  start();
})();
