// Middagsboken: importera ett recept från en receptsida (ICA, Köket, Arla, Coop m.fl.).
// Installeras i Supabase: Edge Functions → Deploy a new function → Via Editor,
// namnge funktionen "importera-recept", klistra in hela den här filen och tryck Deploy.
// Läser sidans standardiserade receptdata (schema.org/Recipe) och skickar tillbaka
// namn, ingredienser, steg, tid, portioner, taggar och bild.

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", aring: "å", auml: "ä", ouml: "ö", Aring: "Å", Auml: "Ä", Ouml: "Ö", eacute: "é", frac12: "½", frac14: "¼", frac34: "¾", ndash: "–", mdash: "—", deg: "°" };
function clean(s: unknown): string {
  return String(s ?? "")
    .replace(/<br\s*\/?>|<\/?(p|div|li|ul|ol|h\d)\b[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&([a-z0-9]+);/gi, (m, n) => ENTITIES[n] ?? m)
    .replace(/[ \t ]+/g, " ")
    .trim();
}

function isRecipe(node: any): boolean {
  const t = node && node["@type"];
  return Array.isArray(t) ? t.includes("Recipe") : t === "Recipe";
}
function findRecipe(node: any): any {
  if (!node || typeof node !== "object") return null;
  if (Array.isArray(node)) { for (const n of node) { const r = findRecipe(n); if (r) return r; } return null; }
  if (isRecipe(node)) return node;
  for (const k of ["@graph", "mainEntity", "itemListElement"]) {
    const r = findRecipe(node[k]); if (r) return r;
  }
  return null;
}

function minutes(iso: unknown): string {
  const m = /P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?/i.exec(String(iso ?? ""));
  if (!m) return "";
  const total = (+(m[1] || 0)) * 1440 + (+(m[2] || 0)) * 60 + (+(m[3] || 0));
  return total ? String(total) : "";
}

function steps(ins: any): string[] {
  if (!ins) return [];
  if (typeof ins === "string") return clean(ins).split(/\n+|(?<=\.)\s+(?=[A-ZÅÄÖ])/).map(s => s.trim()).filter(Boolean);
  if (Array.isArray(ins)) return ins.flatMap(steps);
  if (typeof ins === "object") {
    if (ins.itemListElement) return steps(ins.itemListElement);
    if (ins.text) return steps(ins.text);
    if (ins.name) return steps(ins.name);
  }
  return [];
}

function image(img: any): string {
  if (!img) return "";
  if (typeof img === "string") return img;
  if (Array.isArray(img)) return image(img[0]);
  return img.url || img.contentUrl || "";
}

function tags(r: any): string[] {
  const list: string[] = [];
  const add = (v: any) => {
    if (!v) return;
    if (Array.isArray(v)) v.forEach(add);
    else String(v).split(",").forEach(s => { const t = clean(s); if (t && t.length < 25) list.push(t[0].toUpperCase() + t.slice(1)); });
  };
  add(r.recipeCategory); add(r.recipeCuisine); add(r.keywords);
  return [...new Set(list)].slice(0, 4);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "Fel anrop." }, 405);

  let url: URL;
  try {
    const body = await req.json();
    url = new URL(String(body.url || ""));
    if (!/^https?:$/.test(url.protocol)) throw new Error();
    if (/^(localhost|127\.|10\.|192\.168\.|169\.254\.|0\.)/.test(url.hostname)) throw new Error();
  } catch {
    return json({ error: "Det där ser inte ut som en webbadress." }, 400);
  }

  let html = "";
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
        "Accept": "text/html,application/xhtml+xml",
        "Accept-Language": "sv-SE,sv;q=0.9,en;q=0.5",
      },
      redirect: "follow",
      signal: AbortSignal.timeout(12000),
    });
    if (!res.ok) return json({ error: `Sidan svarade med fel (${res.status}).` }, 422);
    html = (await res.text()).slice(0, 3_000_000);
  } catch {
    return json({ error: "Kunde inte nå sidan. Kontrollera adressen." }, 422);
  }

  let recipe: any = null;
  const re = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  for (let m; (m = re.exec(html)) && !recipe;) {
    try { recipe = findRecipe(JSON.parse(m[1].trim())); } catch { /* trasig data, prova nästa */ }
  }
  if (!recipe) {
    return json({ error: "Hittade inget recept på sidan. Prova att kopiera texten och använd \"Klistra in text\" i stället." }, 422);
  }

  const yieldText = Array.isArray(recipe.recipeYield) ? recipe.recipeYield.join(" ") : String(recipe.recipeYield ?? "");
  const servings = parseInt((/\d+/.exec(yieldText) || ["4"])[0], 10) || 4;
  const ingredients = (Array.isArray(recipe.recipeIngredient) ? recipe.recipeIngredient : recipe.ingredients || [])
    .map(clean).filter(Boolean);

  return json({
    name: clean(recipe.name) || "Importerat recept",
    time: minutes(recipe.totalTime) || minutes(recipe.cookTime) || "",
    servings: Math.min(servings, 50),
    tags: tags(recipe),
    ingredients,
    steps: steps(recipe.recipeInstructions),
    image: image(recipe.image),
  });
});
