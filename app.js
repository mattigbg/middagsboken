(() => {
  "use strict";

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
  const weekKey = mon => { const w = isoWeek(mon); return `${w.year}-v${String(w.week).padStart(2, "0")}`; };
  const fmtDate = d => `${d.getDate()} ${MON[d.getMonth()]}`;
  const newId = () => "r" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  const lsGet = (k, fb) => { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : fb; } catch { return fb; } };
  const lsSet = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} };
  const lsDel = k => { try { localStorage.removeItem(k); } catch {} };
  const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  const isStandalone = window.navigator.standalone === true || window.matchMedia("(display-mode: standalone)").matches;

  let toastTimer;
  function toast(msg) {
    document.querySelectorAll(".toast").forEach(n => n.remove());
    const n = h(`<div class="toast" role="status">${esc(msg)}</div>`); document.body.append(n);
    clearTimeout(toastTimer); toastTimer = setTimeout(() => n.remove(), 2400);
  }
  function setSync(text, kind = "") {
    const s = $("#sync"); s.textContent = text; s.className = "sync " + kind;
  }

  // ---------- lagring: Supabase i molnet, med kopia i telefonen ----------
  const CFG = window.MIDDAG_CONFIG || {};
  const CLOUD = !!(CFG.supabaseUrl && CFG.supabaseKey && window.supabase);
  const K_CACHE = "mb-cache", K_OUTBOX = "mb-outbox";

  const store = {
    sb: null, user: null,
    recipes: {}, weeks: {},
    outbox: lsGet(K_OUTBOX, []),
    flushing: false, channel: null,

    saveCache() { lsSet(K_CACHE, { recipes: this.recipes, weeks: this.weeks }); },
    loadCache() {
      const c = lsGet(K_CACHE, null);
      if (c) { this.recipes = c.recipes || {}; this.weeks = c.weeks || {}; }
      return !!c;
    },

    // Tillämpa en ändring på den lokala kopian.
    apply(op) {
      if (op.k === "r") this.recipes[op.id] = op.data;
      else if (op.k === "rd") delete this.recipes[op.id];
      else if (op.k === "w") this.weeks[op.id] = op.data;
    },

    // Alla ändringar går hit: visas direkt, sparas i molnet så fort det går.
    change(op) {
      this.apply(op);
      this.saveCache();
      if (CLOUD) {
        const key = (op.k === "w" ? "w:" : "r:") + op.id;
        this.outbox = this.outbox.filter(o => ((o.k === "w" ? "w:" : "r:") + o.id) !== key);
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
          if (op.k === "r") res = await this.sb.from("recipes").upsert({ id: op.id, ...recipeToRow(op.data), updated_at: now });
          else if (op.k === "rd") res = await this.sb.from("recipes").delete().eq("id", op.id);
          else res = await this.sb.from("weeks").upsert({ id: op.id, data: op.data, updated_at: now });
          if (res.error) {
            if (isNetworkError(res.error)) { setSync("Offline", "warn"); return; }
            if (isAuthError(res.error)) { await this.sb.auth.refreshSession().catch(() => {}); setSync("Logga in igen", "warn"); return; }
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

    async pull() {
      if (!CLOUD || !this.user) return;
      const [r, w] = await Promise.all([
        this.sb.from("recipes").select("*"),
        this.sb.from("weeks").select("*")
      ]);
      if (r.error || w.error) {
        const e = r.error || w.error;
        setSync(isNetworkError(e) ? "Offline" : "Kunde inte hämta", "warn");
        return;
      }
      const recipes = {}; r.data.forEach(row => recipes[row.id] = rowToRecipe(row));
      const weeks = {}; w.data.forEach(row => weeks[row.id] = row.data || {});
      this.recipes = recipes; this.weeks = weeks;
      this.outbox.forEach(op => this.apply(op)); // ändringar som inte hunnit sparas ligger kvar
      this.saveCache();
      state.loaded = true;
      if (!this.outbox.length) setSync("Synkad", "ok");
      render();
    },

    subscribe() {
      if (this.channel) this.sb.removeChannel(this.channel);
      const pending = (k, id) => this.outbox.some(o => o.id === id && (k === "w" ? o.k === "w" : o.k !== "w"));
      this.channel = this.sb.channel("middagsboken")
        .on("postgres_changes", { event: "*", schema: "public", table: "recipes" }, p => {
          const id = (p.new && p.new.id) || (p.old && p.old.id);
          if (!id || pending("r", id)) return;
          if (p.eventType === "DELETE") delete this.recipes[id]; else this.recipes[id] = rowToRecipe(p.new);
          this.saveCache(); render();
        })
        .on("postgres_changes", { event: "*", schema: "public", table: "weeks" }, p => {
          const id = (p.new && p.new.id) || (p.old && p.old.id);
          if (!id || pending("w", id)) return;
          if (p.eventType === "DELETE") delete this.weeks[id]; else this.weeks[id] = p.new.data || {};
          this.saveCache(); render();
        })
        .subscribe();
    },

    async refresh() { await this.flush(); await this.pull(); },

    async signOut() {
      if (this.channel) { this.sb.removeChannel(this.channel); this.channel = null; }
      await this.sb.auth.signOut().catch(() => {});
      this.user = null; this.recipes = {}; this.weeks = {}; this.outbox = [];
      lsDel(K_CACHE); lsDel(K_OUTBOX);
      closeSheet(); showLogin();
    }
  };

  function recipeToRow(d) {
    return { name: d.name, time: d.time || "", servings: d.servings || 4, tags: d.tags || [], ingredients: d.ingredients || [], steps: d.steps || [] };
  }
  function rowToRecipe(row) {
    return { name: row.name || "", time: row.time || "", servings: row.servings || 4, tags: row.tags || [], ingredients: row.ingredients || [], steps: row.steps || [] };
  }
  function isNetworkError(e) {
    return !navigator.onLine || /fetch|network|load failed|timeout/i.test((e && (e.message || e.details)) || "");
  }
  function isAuthError(e) {
    return /jwt|token|401|not authenticated/i.test(((e && (e.message || e.code)) || "") + "");
  }

  // ---------- tillstånd ----------
  const state = { tab: "week", offset: 0, loaded: false, q: "", tag: "" };
  const t0 = lsGet("mb-tab", "week"); if (["week", "recipes", "shop"].includes(t0)) state.tab = t0;

  const monday = () => addDays(mondayOf(new Date()), 7 * state.offset);
  const recipeList = () => Object.entries(store.recipes).map(([id, r]) => ({ id, ...r })).sort((a, b) => (a.name || "").localeCompare(b.name || "", "sv"));
  const recipeById = id => store.recipes[id] ? { id, ...store.recipes[id] } : null;
  function getWeek(key = weekKey(monday())) {
    const w = store.weeks[key] || {};
    const days = Array.from({ length: 7 }, (_, i) => ({ recipeId: "", note: "", ...((w.days || [])[i] || {}) }));
    return { servings: w.servings || 4, days, checked: w.checked || [], extras: w.extras || [] };
  }
  const putWeek = (w, key = weekKey(monday())) => store.change({ k: "w", id: key, data: w });

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
    const y = window.scrollY;
    main.replaceChildren();
    if (state.tab === "week") renderWeek(main);
    else if (state.tab === "recipes") renderRecipes(main);
    else renderShop(main);
    window.scrollTo(0, y);
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
    const label = state.offset === 0 ? "Denna vecka" : state.offset === 1 ? "Nästa vecka" : state.offset === -1 ? "Förra veckan" : "";
    const el = h(`<div class="weekhead row spread">
      <div><h2>Vecka ${w.week}</h2><div class="dates">${label ? esc(label) + " · " : ""}${fmtDate(mon)} – ${fmtDate(addDays(mon, 6))}</div></div>
      <div class="row">
        <button class="btn icon" data-n="-1" aria-label="Föregående vecka">←</button>
        ${state.offset !== 0 ? `<button class="btn" data-n="0">I dag</button>` : ""}
        <button class="btn icon" data-n="1" aria-label="Nästa vecka">→</button>
      </div></div>`);
    el.querySelectorAll("[data-n]").forEach(b => b.onclick = () => { const n = +b.dataset.n; state.offset = n === 0 ? 0 : state.offset + n; render(); });
    return el;
  }
  function renderWeek(main) {
    const hint = installHint(); if (hint) main.append(hint);
    main.append(weekNav());
    const wk = getWeek(), mon = monday(), today = new Date(); today.setHours(0, 0, 0, 0);
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
      let inner;
      if (r) inner = `<span class="name">${esc(r.name)}</span><span class="meta">${r.time ? esc(r.time) + " min · " : ""}${(r.tags || []).map(esc).join(", ")}</span>`;
      else if (d.recipeId) inner = `<span class="name">Receptet är borttaget</span><span class="meta">Tryck för att välja ett nytt</span>`;
      else if (d.note) inner = `<span class="name">${esc(d.note)}</span><span class="meta">Egen anteckning</span>`;
      else inner = `<span>+ Välj middag</span>`;
      const li = h(`<li class="day${isToday ? " today" : ""}">
        <div class="when"><b>${DAYS[i]}</b><small>${fmtDate(date)}${isToday ? " · i dag" : ""}</small></div>
        <button class="dish ${r || d.note ? "filled" : "empty"}">${inner}</button></li>`);
      $(".dish", li).onclick = () => r ? openRecipe(r.id, i) : openPicker(i);
      ul.append(li);
    });
    main.append(ul);
    if (state.loaded && !recipeList().length) main.append(h(`<div class="empty-state" style="margin-top:20px"><p>Du har inga recept än. Lägg till några under Recept, så kan du välja dem här.</p></div>`));
  }
  function randomize(wk) {
    const all = recipeList();
    if (!all.length) { toast("Lägg till recept först"); return; }
    const used = new Set(wk.days.map(d => d.recipeId).filter(Boolean));
    const lastWeek = new Set(getWeek(weekKey(addDays(monday(), -7))).days.map(d => d.recipeId));
    let pool = all.filter(r => !used.has(r.id) && !lastWeek.has(r.id));
    if (pool.length < 7) pool = all.filter(r => !used.has(r.id));
    pool = pool.map(r => [Math.random(), r]).sort((a, b) => a[0] - b[0]).map(x => x[1]);
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
  function openSheet(content) {
    const shade = h(`<div class="shade"><div class="sheet" role="dialog" aria-modal="true"></div></div>`);
    $(".sheet", shade).append(content);
    shade.addEventListener("click", e => { if (e.target === shade) closeSheet(); });
    $("#layer").replaceChildren(shade);
    document.documentElement.style.overflow = "hidden";
  }
  function closeSheet() { $("#layer").replaceChildren(); document.documentElement.style.overflow = ""; }
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
      const rs = all.filter(r => !q || (r.name + " " + (r.tags || []).join(" ")).toLowerCase().includes(q));
      if (!rs.length) list.append(h(`<li class="muted small" style="padding:10px 4px">${all.length ? "Inget recept matchar." : "Inga recept än."}</li>`));
      rs.forEach(r => {
        const li = h(`<li><button><b>${esc(r.name)}</b>${r.id === d.recipeId ? " ✓" : ""}<div class="sub">${r.time ? esc(r.time) + " min · " : ""}${(r.tags || []).map(esc).join(", ")}</div></button></li>`);
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

  // ---------- recept ----------
  function renderRecipes(main) {
    const top = h(`<div class="tools">
      <input class="search" id="rq" type="search" placeholder="Sök namn, ingrediens eller tagg…" value="${esc(state.q)}">
      <button class="btn primary" id="newr">+ Nytt recept</button></div>`);
    main.append(top);
    $("#newr", top).onclick = () => openEditor();
    const all = recipeList();
    const tags = [...new Set(all.flatMap(r => r.tags || []))].sort((a, b) => a.localeCompare(b, "sv"));
    if (tags.length) {
      const chips = h(`<div class="chips"></div>`);
      ["", ...tags].forEach(t => {
        const b = h(`<button class="chip" aria-pressed="${state.tag === t}">${t ? esc(t) : "Alla"}</button>`);
        b.onclick = () => { state.tag = t; render(); };
        chips.append(b);
      });
      main.append(chips);
    }
    const grid = h(`<div class="grid"></div>`);
    const draw = () => {
      const q = state.q.trim().toLowerCase();
      const rs = all.filter(r => (!state.tag || (r.tags || []).includes(state.tag)) &&
        (!q || [r.name, (r.tags || []).join(" "), (r.ingredients || []).join(" ")].join(" ").toLowerCase().includes(q)));
      grid.replaceChildren();
      rs.forEach(r => {
        const c = h(`<button class="card"><h3>${esc(r.name)}</h3>
          <span class="small muted">${[r.time && r.time + " min", r.servings && r.servings + " port", (r.ingredients || []).length + " ingredienser"].filter(Boolean).map(esc).join(" · ")}</span>
          <span class="tags">${(r.tags || []).map(t => `<span class="tag">${esc(t)}</span>`).join("")}</span></button>`);
        c.onclick = () => openRecipe(r.id);
        grid.append(c);
      });
      if (!rs.length) grid.append(h(all.length
        ? `<div class="empty-state">Inget recept matchar sökningen.</div>`
        : `<div class="empty-state"><p>${state.loaded ? "Här samlas era recept. Lägg till ert första, till exempel en favorit ni lagar ofta." : "Hämtar recept…"}</p></div>`));
    };
    $("#rq", top).oninput = e => { state.q = e.target.value; draw(); };
    draw();
    main.append(grid);
  }

  function openRecipe(id, dayIndex) {
    const r = recipeById(id); if (!r) return;
    const box = h(`<div>
      <h2>${esc(r.name)}</h2>
      <div class="tags row">${(r.tags || []).map(t => `<span class="tag">${esc(t)}</span>`).join("")}</div>
      <div class="facts">${r.time ? `<div><b>${esc(r.time)} min</b><span class="muted">tillagning</span></div>` : ""}${r.servings ? `<div><b>${esc(r.servings)}</b><span class="muted">portioner</span></div>` : ""}</div>
      <div class="section"><h3>Ingredienser</h3><ul class="ingr">${(r.ingredients || []).map(x => `<li>${esc(x)}</li>`).join("") || "<li class='muted'>Inga ingredienser angivna</li>"}</ul></div>
      <div class="section"><h3>Gör så här</h3><ol class="steps">${(r.steps || []).map(x => `<li>${esc(x)}</li>`).join("") || "<li class='muted'>Ingen beskrivning</li>"}</ol></div>
      ${dayIndex != null ? `<div class="section"><div class="label">${DAYS[dayIndex]} ${fmtDate(addDays(monday(), dayIndex))}</div>
        <div class="row" style="margin-top:6px"><button class="btn primary" id="swap">Byt middag</button><button class="btn" id="unplan">Ta bort från dagen</button></div></div>` : ""}
      <div class="section"${dayIndex != null ? " hidden" : ""}><div class="label">Lägg på veckomenyn, vecka ${isoWeek(monday()).week}</div>
        <div class="row" style="margin-top:6px"><select id="addday" class="btn">${DAYS.map((d, i) => `<option value="${i}">${d} ${fmtDate(addDays(monday(), i))}</option>`).join("")}</select><button class="btn primary" id="addgo">Lägg till</button></div></div>
      <div class="row section"><button class="btn" id="edit">Redigera</button><button class="btn danger" id="del">Ta bort</button></div></div>`);
    box.prepend(closeBtn());
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
      store.change({ k: "rd", id: r.id }); closeSheet(); toast("Receptet är borttaget");
    };
    openSheet(box);
  }

  function openEditor(r) {
    const isNew = !r; r = r || { name: "", time: "", servings: 4, tags: [], ingredients: [], steps: [] };
    const box = h(`<form>
      <h2>${isNew ? "Nytt recept" : "Redigera recept"}</h2>
      <div class="field" style="margin-top:14px"><label for="f-name">Namn</label><input id="f-name" required value="${esc(r.name)}" placeholder="T.ex. Köttbullar med potatismos"></div>
      <div class="two">
        <div class="field"><label for="f-time">Tid (minuter)</label><input id="f-time" type="number" inputmode="numeric" min="0" value="${esc(r.time)}"></div>
        <div class="field"><label for="f-serv">Portioner</label><input id="f-serv" type="number" inputmode="numeric" min="1" value="${esc(r.servings)}"></div>
      </div>
      <div class="field"><label for="f-tags">Taggar</label><input id="f-tags" value="${esc((r.tags || []).join(", "))}" placeholder="Fisk, Snabbt, Vegetariskt"><span class="hint">Skilj med kommatecken.</span></div>
      <div class="field"><label for="f-ingr">Ingredienser</label><textarea id="f-ingr" placeholder="500 g nötfärs&#10;1 gul lök&#10;2 dl grädde">${esc((r.ingredients || []).join("\n"))}</textarea><span class="hint">En per rad. Börja med mängd och enhet, så räknas inköpslistan ut automatiskt.</span></div>
      <div class="field"><label for="f-steps">Gör så här</label><textarea id="f-steps" placeholder="Hacka löken.&#10;Stek färsen…">${esc((r.steps || []).join("\n"))}</textarea><span class="hint">Ett steg per rad.</span></div>
      <div class="row"><button class="btn primary" type="submit">Spara recept</button><button class="btn" type="button" id="cancel">Avbryt</button></div></form>`);
    box.prepend(closeBtn());
    $("#cancel", box).onclick = () => isNew ? closeSheet() : openRecipe(r.id);
    box.onsubmit = e => {
      e.preventDefault();
      const lines = s => s.split("\n").map(x => x.trim()).filter(Boolean);
      const data = {
        name: $("#f-name", box).value.trim(),
        time: $("#f-time", box).value.trim(),
        servings: Math.max(1, +$("#f-serv", box).value || 4),
        tags: [...new Set($("#f-tags", box).value.split(",").map(t => t.trim()).filter(Boolean).map(t => t[0].toUpperCase() + t.slice(1)))],
        ingredients: lines($("#f-ingr", box).value),
        steps: lines($("#f-steps", box).value)
      };
      if (!data.name) { $("#f-name", box).focus(); return; }
      const id = isNew ? newId() : r.id;
      store.change({ k: "r", id, data });
      toast(isNew ? "Receptet är sparat" : "Ändringarna är sparade");
      openRecipe(id);
    };
    openSheet(box);
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
    const m = line.match(/^([\d.,½¼¾\/]+)\s*(\S+)?\s*(.*)$/);
    if (!m) return { qty: NaN, unit: "", name: line };
    const qty = parseAmount(m[1]);
    if (isNaN(qty)) return { qty: NaN, unit: "", name: line };
    let unit = (m[2] || "").toLowerCase(), name = m[3];
    if (!UNITS.includes(unit)) { name = ((m[2] || "") + " " + name).trim(); unit = ""; }
    return { qty, unit, name: name || line };
  }
  const fmtQty = q => String(Math.round(q * 10) / 10).replace(".", ",");
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
        const amt = it.qty ? fmtQty(it.qty) + (it.unit ? " " + it.unit : "") : "";
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

  // ---------- inställningar ----------
  function openSettings() {
    const box = h(`<div class="settings">
      <h2>Inställningar</h2>
      <dl>
        <dt>Status</dt><dd>${esc($("#sync").textContent)}</dd>
        ${CLOUD && store.user ? `<dt>Inloggad</dt><dd>${esc(store.user.email)}</dd>` : ""}
        ${!CLOUD ? `<dt>Läge</dt><dd>Testläge. Allt sparas bara på den här enheten.</dd>` : ""}
        ${store.outbox.length ? `<dt>Väntar</dt><dd>${store.outbox.length} ändringar sparas när du är online</dd>` : ""}
        <dt>Recept</dt><dd>${recipeList().length} st</dd>
      </dl>
      <div class="row" id="acts"></div>
      ${!isStandalone ? `<div class="section"><div class="label">Installera</div><p class="small">Öppna sidan i Safari, tryck på Dela och välj <b>Lägg till på hemskärmen</b>.</p></div>` : ""}
    </div>`);
    box.prepend(closeBtn());
    const acts = $("#acts", box);
    if (CLOUD && store.user) {
      const rf = h(`<button class="btn">Uppdatera nu</button>`);
      rf.onclick = async () => { rf.disabled = true; await store.refresh(); closeSheet(); toast("Uppdaterad"); };
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

  // ---------- inloggning ----------
  function showLogin(message) {
    document.body.classList.add("locked");
    const main = $("#main");
    const box = h(`<form class="login">
      <img class="logo" src="icons/apple-touch-icon.png" alt="">
      <h2>Välkommen</h2>
      <p>Logga in för att se familjens recept och veckomeny.</p>
      <p class="err" ${message ? "" : "hidden"}>${esc(message || "")}</p>
      <div class="field"><label for="le">E-post</label><input id="le" type="email" autocomplete="email" autocapitalize="off" required></div>
      <div class="field"><label for="lp">Lösenord</label><input id="lp" type="password" autocomplete="current-password" required></div>
      <button class="btn primary wide" type="submit">Logga in</button>
      <p class="small" style="margin-top:16px"><button type="button" class="btn" id="forgot">Glömt lösenordet?</button></p>
    </form>`);
    const err = t => { const p = $(".err", box); p.hidden = !t; p.textContent = t || ""; };
    box.onsubmit = async e => {
      e.preventDefault(); err("");
      const btn = $("button[type=submit]", box); btn.disabled = true; btn.textContent = "Loggar in…";
      const { data, error } = await store.sb.auth.signInWithPassword({ email: $("#le", box).value.trim(), password: $("#lp", box).value });
      btn.disabled = false; btn.textContent = "Logga in";
      if (error) {
        err(isNetworkError(error) ? "Ingen internetanslutning. Försök igen när du är online." : "Fel e-post eller lösenord.");
        return;
      }
      afterLogin(data.session);
    };
    $("#forgot", box).onclick = async () => {
      const email = $("#le", box).value.trim();
      if (!email) { err("Skriv din e-post först, så skickar vi en länk."); $("#le", box).focus(); return; }
      const { error } = await store.sb.auth.resetPasswordForEmail(email, { redirectTo: location.origin + location.pathname });
      err(""); toast(error ? "Kunde inte skicka. Försök igen om en stund." : "Kolla din e-post efter en länk.");
    };
    main.replaceChildren(box);
  }

  async function afterLogin(session) {
    store.user = session.user;
    document.body.classList.remove("locked");
    store.loadCache();
    state.loaded = Object.keys(store.recipes).length > 0;
    render();
    store.subscribe();
    await store.refresh();
  }

  // ---------- start ----------
  async function start() {
    if (!CLOUD) {
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
    store.sb.auth.onAuthStateChange((event) => {
      if (event === "PASSWORD_RECOVERY") setTimeout(() => openNewPassword(true), 300);
    });
    setSync("Ansluter…");
    const { data } = await store.sb.auth.getSession();
    if (data && data.session) afterLogin(data.session);
    else showLogin();

    window.addEventListener("online", () => store.refresh());
    window.addEventListener("offline", () => setSync("Offline", "warn"));
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible" && store.user) { store.subscribe(); store.refresh(); }
    });
  }

  start();
})();
