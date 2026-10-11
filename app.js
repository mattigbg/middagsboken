(() => {
  "use strict";

  const APP_VERSION = "3";

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
  const opKey = op => (op.fid || "") + "/" + ({ r: "r", rd: "r", w: "w", rt: "t" }[op.k]) + ":" + op.id;

  const store = {
    sb: null, user: null, me: CLOUD ? null : "me",
    family: null,          // id för vald familj
    families: [],          // [{id, name, invite_code, role}]
    members: {},           // user_id -> {name, role} i vald familj
    recipes: {}, weeks: {}, ratings: {},
    outbox: lsGet(K_OUTBOX, []),
    flushing: false, channel: null, needsDbUpdate: false,

    get current() { return this.families.find(f => f.id === this.family) || null; },
    get myName() {
      const m = this.user && this.user.user_metadata;
      return (m && m.name) || (this.user && this.user.email ? this.user.email.split("@")[0] : "");
    },

    saveCache() {
      const ok = lsSet(cacheKey(this.family), { recipes: this.recipes, weeks: this.weeks, ratings: this.ratings, members: this.members });
      if (!ok && !CLOUD) toast("Telefonens lagring är full. Ta bort några bilder.");
      if (CLOUD) lsSet("mb-families", this.families);
    },
    loadCache() {
      const c = lsGet(cacheKey(this.family), null);
      this.recipes = (c && c.recipes) || {}; this.weeks = (c && c.weeks) || {};
      this.ratings = (c && c.ratings) || {}; this.members = (c && c.members) || {};
      return !!c;
    },

    apply(op) {
      if (CLOUD && op.fid !== this.family) return; // ändringen gäller en annan familj
      if (op.k === "r") this.recipes[op.id] = op.data;
      else if (op.k === "rd") { delete this.recipes[op.id]; delete this.ratings[op.id]; }
      else if (op.k === "w") this.weeks[op.id] = op.data;
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
          else if (op.k === "rt") res = op.stars
            ? await this.sb.from("ratings").upsert({ recipe_id: op.id, user_id: this.me, stars: op.stars, updated_at: now })
            : await this.sb.from("ratings").delete().eq("recipe_id", op.id).eq("user_id", this.me);
          if (res.error) {
            if (isNetworkError(res.error)) { setSync("Offline", "warn"); return; }
            if (isAuthError(res.error)) { await this.sb.auth.refreshSession().catch(() => {}); setSync("Logga in igen", "warn"); return; }
            if (isSchemaError(res.error)) { this.needsDbUpdate = true; setSync("Databasen behöver uppdateras", "warn"); render(); return; }
            console.error(res.error);
            toast("En ändring kunde inte sparas: " + (res.error.message || "okänt fel"));
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
        .select("role, families(id, name, invite_code)").eq("user_id", this.me);
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
      const [r, w, t, m] = await Promise.all([
        this.sb.from("recipes").select("*").eq("family_id", fid),
        this.sb.from("weeks").select("*").eq("family_id", fid),
        this.sb.from("ratings").select("recipe_id,user_id,stars"),
        this.sb.from("family_members").select("user_id,display_name,role").eq("family_id", fid)
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
        .subscribe();
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
    const wk = getWeek(), mon = monday(), today = today0();
    const bar = h(`<div class="row spread" style="margin-bottom:14px">
      <div class="servings"><label for="serv" class="small muted">Antal personer</label><input id="serv" type="number" inputmode="numeric" min="1" max="20" value="${wk.servings}"></div>
      <div class="row"><button class="btn primary" id="rnd">Slumpa tomma dagar</button><button class="btn" id="clr">Töm veckan</button></div></div>`);
    $("#serv", bar).onchange = e => { const v = Math.max(1, Math.min(20, +e.target.value || 4)); putWeek({ ...wk, servings: v }); };
    $("#rnd", bar).onclick = () => randomize(wk);
    const clr = $("#clr", bar);
    clr.onclick = () => {
      if (!clr.classList.contains("armed")) { clr.classList.add("armed", "danger"); clr.textContent = "Ja, töm"; setTimeout(() => { clr.classList.remove("armed", "danger"); clr.textContent = "Töm veckan"; }, 3000); return; }
      putWeek({ ...wk, days: wk.days.map(() => ({ recipeId: "", note: "" })), checked: [] }); toast("Veckan är tömd");
    };
    main.append(bar);

    const ul = h(`<ul class="days"></ul>`);
    wk.days.forEach((d, i) => {
      const date = addDays(mon, i), r = d.recipeId && recipeById(d.recipeId);
      const isToday = +date === +today;
      const li = h(`<li class="day${isToday ? " today" : ""}">
        <div class="when"><b>${DAYS[i]}</b><small>${fmtDate(date)}${isToday ? " · i dag" : ""}</small></div>
        <button class="dish ${r || d.note ? "filled" : "empty"}${r && r.image ? " has-img" : ""}">${dayInner(d, r, date <= today)}</button></li>`);
      $(".dish", li).onclick = () => r ? openRecipe(r.id, i) : openPicker(i);
      ul.append(li);
    });
    main.append(ul);
    if (state.loaded && !recipeList().length) main.append(h(`<div class="empty-state" style="margin-top:20px"><p>Du har inga recept än. Lägg till några under Recept, så kan du välja dem här.</p></div>`));
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
    if (empty) {
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
    const saveNote = () => { const v = $("#pnote", box).value.trim(); setDay(i, { recipeId: "", note: v }); closeSheet(); };
    $("#psave", box).onclick = saveNote;
    $("#pnote", box).onkeydown = e => { if (e.key === "Enter") saveNote(); };
    const c = $("#pclear", box); if (c) c.onclick = () => { setDay(i, { recipeId: "", note: "" }); closeSheet(); };
    openSheet(box);
  }
  function setDay(i, val) {
    const wk = getWeek(); const days = wk.days.slice(); days[i] = val; putWeek({ ...wk, days });
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
      <div class="row"><button class="btn primary" id="newr">+ Nytt recept</button><button class="btn" id="imp">Importera</button></div></div>`);
    main.append(top);
    $("#newr", top).onclick = () => openEditor();
    $("#imp", top).onclick = openImport;
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
    const rt = rating(id), eaten = eatenIndex()[id] || [];
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
      <div class="rate"><span class="label">Ditt betyg</span></div>
      ${dayIndex != null ? `<div class="section"><div class="label">${DAYS[dayIndex]} ${fmtDate(addDays(monday(), dayIndex))}</div>
        <div class="row" style="margin-top:6px"><button class="btn primary" id="swap">Byt middag</button><button class="btn" id="unplan">Ta bort från dagen</button></div></div>` : ""}
      <div class="section"><h3>Ingredienser</h3><ul class="ingr">${(r.ingredients || []).map(x => `<li>${esc(x)}</li>`).join("") || "<li class='muted'>Inga ingredienser angivna</li>"}</ul></div>
      <div class="section"><h3>Gör så här</h3><ol class="steps">${(r.steps || []).map(x => `<li>${esc(x)}</li>`).join("") || "<li class='muted'>Ingen beskrivning</li>"}</ol></div>
      ${r.source ? `<p class="small muted section">Källa: <a href="${esc(r.source)}" target="_blank" rel="noopener">${esc(r.source.replace(/^https?:\/\/(www\.)?/, "").split("/")[0])}</a></p>` : ""}
      ${eaten.length > 1 ? `<details class="section"><summary class="small">Alla gånger ni ätit den</summary><p class="small muted">${eaten.map(fmtDateYear).join(", ")}</p></details>` : ""}
      <div class="section"${dayIndex != null ? " hidden" : ""}><div class="label">Lägg på veckomenyn, vecka ${isoWeek(monday()).week}</div>
        <div class="row" style="margin-top:6px"><select id="addday" class="btn">${DAYS.map((d, i) => `<option value="${i}">${d} ${fmtDate(addDays(monday(), i))}</option>`).join("")}</select><button class="btn primary" id="addgo">Lägg till</button></div></div>
      <div class="row section"><button class="btn" id="edit">Redigera</button>${CLOUD && store.families.length > 1 ? `<button class="btn" id="copyfam">Kopiera till annan familj</button>` : ""}<button class="btn danger" id="del">Ta bort</button></div></div>`);
    box.prepend(closeBtn());
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
    if (dayIndex != null) {
      $("#swap", box).onclick = () => openPicker(dayIndex);
      $("#unplan", box).onclick = () => { setDay(dayIndex, { recipeId: "", note: "" }); closeSheet(); toast("Borttagen från " + DAYS[dayIndex].toLowerCase()); };
    }
    const firstEmpty = getWeek().days.findIndex(d => !d.recipeId && !d.note);
    if (firstEmpty >= 0) $("#addday", box).value = firstEmpty;
    $("#addgo", box).onclick = () => { const i = +$("#addday", box).value; setDay(i, { recipeId: r.id, note: "" }); closeSheet(); toast(`Tillagd på ${DAYS[i].toLowerCase()}`); };
    $("#edit", box).onclick = () => openEditor(r);
    const del = $("#del", box);
    del.onclick = () => {
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
    const wk = getWeek(), items = buildShop(wk), checked = new Set(wk.checked);
    const toggle = key => {
      const w = getWeek(); const s = new Set(w.checked); s.has(key) ? s.delete(key) : s.add(key);
      putWeek({ ...w, checked: [...s] });
    };
    const planned = wk.days.filter(d => d.recipeId && recipeById(d.recipeId)).length;
    main.append(h(`<p class="muted" style="margin:0 0 12px">${planned ? `Ingredienser för ${planned} middagar, beräknat för ${wk.servings} personer.` : "Planera veckans middagar först, så fylls listan i automatiskt."}</p>`));
    if (items.length) {
      const left = items.filter(i => !checked.has(i.key)).length;
      main.append(h(`<div class="label" style="margin-bottom:4px">${left} kvar att handla</div>`));
      const ul = h(`<ul class="shop"></ul>`);
      items.sort((a, b) => checked.has(a.key) - checked.has(b.key)).forEach((it, n) => {
        const amt = it.qty ? fmtNum(it.qty) + (it.unit ? " " + it.unit : "") : "";
        const label = it.text.length && !it.qty ? esc(it.text.join(", ")) : `${amt ? `<span class="amt">${esc(amt)}</span>` : ""}${esc(it.name)}${it.text.length ? " + " + esc(it.text.join(", ")) : ""}`;
        const li = h(`<li class="${checked.has(it.key) ? "done" : ""}"><input type="checkbox" id="s${n}" ${checked.has(it.key) ? "checked" : ""}><label for="s${n}">${label}<span class="from">${[...it.from].join(", ")}</span></label></li>`);
        $("input", li).onchange = () => toggle(it.key);
        ul.append(li);
      });
      main.append(ul);
    }
    const sec = h(`<div class="section"><h3>Övrigt att handla</h3><ul class="shop"></ul>
      <form class="addline"><input id="extra" placeholder="T.ex. Mjölk, kaffe, tandkräm" enterkeyhint="done"><button class="btn" type="submit">Lägg till</button></form></div>`);
    const eul = $("ul", sec);
    wk.extras.forEach((x, i) => {
      const key = "extra:" + x;
      const li = h(`<li class="${checked.has(key) ? "done" : ""}"><input type="checkbox" id="e${i}" ${checked.has(key) ? "checked" : ""}><label for="e${i}">${esc(x)}</label><button class="x" aria-label="Ta bort ${esc(x)}">✕</button></li>`);
      $("input", li).onchange = () => toggle(key);
      $(".x", li).onclick = () => { const w = getWeek(); putWeek({ ...w, extras: w.extras.filter(e => e !== x), checked: w.checked.filter(c => c !== key) }); };
      eul.append(li);
    });
    $("form", sec).onsubmit = e => {
      e.preventDefault(); const v = $("#extra", sec).value.trim(); if (!v) return;
      const w = getWeek(); if (!w.extras.includes(v)) putWeek({ ...w, extras: [...w.extras, v] });
      setTimeout(() => { const f = $("#extra"); if (f) f.focus(); }, 0);
    };
    main.append(sec);
    if (checked.size) {
      const b = h(`<button class="btn" style="margin-top:18px">Avmarkera allt</button>`);
      b.onclick = () => putWeek({ ...getWeek(), checked: [] });
      main.append(b);
    }
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

      <div class="section"><h3>Medlemmar</h3><ul class="members"></ul></div>

      ${store.families.length > 1 ? `<div class="section"><h3>Dina familjer</h3><ul class="famlist"></ul></div>` : ""}

      <div class="section row"><button class="btn" id="newfam">Skapa eller gå med i en annan familj</button></div>
      <div class="section row"><button class="btn danger" id="leave">Lämna ${esc(f.name)}</button></div>
    </div>`);
    box.prepend(closeBtn());

    const ul = $(".members", box);
    ids.forEach(uid => {
      const m = store.members[uid], me = uid === store.me;
      const li = h(`<li><span class="mname">${esc(m.name || "Namnlös")}${me ? " <span class='muted'>(du)</span>" : ""}</span>${m.role === "owner" ? `<span class="tag">Ägare</span>` : ""}<span class="mact"></span></li>`);
      if (owner && !me) {
        const act = $(".mact", li);
        if (m.role !== "owner") {
          const up = h(`<button class="btn small">Gör till ägare</button>`);
          up.onclick = async () => { try { await rpc("set_member_role", { fid: f.id, uid, p_role: "owner" }); await store.refreshMembers(); openFamily(); } catch (e) { toast(rpcError(e, "Det gick inte.")); } };
          act.append(up);
        }
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
