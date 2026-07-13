// Worker de Cloudflare para la app de Club Almagro.
//
// Expone:
//   GET /fixture            -> { proximos: [...], resultados: [...], actualizado: "ISO date" }
//                               (scrapea la pagina del equipo en Promiedos)
//   GET /standings?zona=A|B -> { grupo: "A"|"B", equipos: [...], actualizado: "ISO date" }
//                               (usa la API JSON publica de ESPN, no HTML scraping)
//
// Cachea cada resultado 30 minutos en el edge de Cloudflare para no golpear
// las fuentes en cada visita, y siempre devuelve CORS abierto para que la PWA
// (servida desde cualquier dominio) pueda consumirlas con fetch().
//
// Como desplegarlo (gratis, sin tarjeta):
//  1. Entra a https://dash.cloudflare.com -> Workers & Pages -> Create -> Worker
//  2. Pega este archivo entero reemplazando el codigo de ejemplo
//  3. Deploy. Te da una URL tipo https://TU-WORKER.TU-SUBDOMINIO.workers.dev
//  4. Probalo en el navegador: .../fixture y .../standings?zona=B
//  5. Pega esa URL base en index.html, en la constante WORKER_BASE

const TEAM_URL = "https://www.promiedos.com.ar/team/almagro/hbag";
const STANDINGS_API = "https://site.api.espn.com/apis/v2/sports/soccer/arg.2/standings";
const CACHE_TTL_SECONDS = 1800; // 30 minutos

// Mapa fijo de "id de equipo en ESPN" -> zona, tomado directamente de la tabla
// de posiciones de la Primera Nacional 2026 (arg.2) al momento de escribir esto.
// Usamos esto en vez de tratar de adivinar la zona a partir de texto tipo
// "Grupo A"/"Grupo B" en la respuesta, porque esa parte del HTML es la que
// resulto ser fragil. Si la AFA reordena las zonas en una temporada futura,
// este mapa hay que actualizarlo a mano.
const TEAM_ZONE = {
  // Zona A
  "9743": "A", // Ferro Carril Oeste
  "10154": "A", // Deportivo Moron
  "7": "A", // Colon (Santa Fe)
  "21799": "A", // Ciudad de Bolivar
  "13": "A", // Los Andes
  "9740": "A", // Almirante Brown
  "18260": "A", // Deportivo Madryn
  "17352": "A", // Estudiantes (Buenos Aires)
  "6756": "A", // Godoy Cruz Antonio Tomba
  "10058": "A", // San Miguel
  "10151": "A", // Defensores de Belgrano
  "19145": "A", // Racing (Cordoba)
  "10157": "A", // San Telmo
  "9786": "A", // All Boys
  "11993": "A", // Central Norte
  "10145": "A", // Acassuso
  "11990": "A", // Mitre (Santiago del Estero)
  "11963": "A", // Chaco For Ever
  // Zona B
  "5263": "B", // Gimnasia y Esgrima (Jujuy)
  "10146": "B", // Atlanta
  "10163": "B", // Tristan Suarez
  "10162": "B", // Temperley
  "10109": "B", // Midland
  "9747": "B", // Atletico Rafaela
  "17814": "B", // San Martin (Tucuman)
  "11978": "B", // Deportivo Maipu
  "236": "B", // Nueva Chicago
  "2": "B", // Almagro
  "2741": "B", // Quilmes
  "10743": "B", // Gimnasia y Tiro (Salta)
  "10149": "B", // Colegiales
  "7845": "B", // San Martin (San Juan)
  "6": "B", // Chacarita Juniors
  "10374": "B", // Patronato
  "18284": "B", // Guemes
  "13913": "B", // Agropecuario
};

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders() });
    }

    if (url.pathname === "/fixture") {
      return withEdgeCache(url, request, ctx, function () { return scrapePromiedos(); });
    }
    if (url.pathname === "/standings") {
      const zonaParam = (url.searchParams.get("zona") || "B").toUpperCase();
      const zona = zonaParam === "A" ? "A" : "B";
      return withEdgeCache(url, request, ctx, function () { return fetchStandings(zona); });
    }
    return json({ error: "Ruta no encontrada. Usa /fixture o /standings?zona=A|B" }, 404);
  },
};

// Envuelve un scraper con cache de edge + manejo de errores, para no repetir codigo.
async function withEdgeCache(url, request, ctx, scraperFn) {
  const cache = caches.default;
  const cacheKey = new Request(url.toString(), request);
  const cached = await cache.match(cacheKey);
  if (cached) return cached;

  try {
    const data = await scraperFn();
    const response = json(data, 200);
    response.headers.set("Cache-Control", "public, max-age=" + CACHE_TTL_SECONDS);
    ctx.waitUntil(cache.put(cacheKey, response.clone()));
    return response;
  } catch (err) {
    return json({ error: "No se pudo obtener los datos", detail: String(err) }, 502);
  }
}

// ---------- FIXTURE Y RESULTADOS (Promiedos) ----------

async function scrapePromiedos() {
  const res = await fetch(TEAM_URL, {
    headers: { "User-Agent": "Mozilla/5.0 (compatible; AlmagroPWA/1.0)" },
  });
  if (!res.ok) throw new Error("Promiedos respondio " + res.status);
  const html = await res.text();

  const proximosMarker = html.indexOf("PROXIMOS PARTIDOS") !== -1 ? "PROXIMOS PARTIDOS" : "PR\u00d3XIMOS PARTIDOS";
  const proximos = extractMatchTable(html, proximosMarker, "Resultados");
  const resultados = extractMatchTable(html, ">Resultados<", "PLANTEL");

  return {
    proximos: proximos,
    resultados: resultados,
    actualizado: new Date().toISOString(),
  };
}

// Busca el <table> que aparece entre dos marcadores de texto y devuelve sus filas parseadas.
function extractMatchTable(html, startMarker, endMarker) {
  const startIdx = html.indexOf(startMarker);
  if (startIdx === -1) return [];
  const endIdx = html.indexOf(endMarker, startIdx);
  const chunk = html.slice(startIdx, endIdx === -1 ? undefined : endIdx);

  const tableMatch = chunk.match(/<table[\s\S]*?<\/table>/i);
  if (!tableMatch) return [];

  const rows = Array.from(tableMatch[0].matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi));
  const parsed = [];

  for (let r = 0; r < rows.length; r++) {
    const row = rows[r];
    const cellMatches = Array.from(row[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi));
    const cells = cellMatches.map(function (c) { return dedupe(stripTags(c[1])); });
    if (cells.length < 3) continue; // saltea filas de encabezado

    const dia = cells[0];
    const cond = cells[1];
    const rivalRaw = cells[2];
    const extra = cells[3];
    if (!dia || !/^\d{1,2}\/\d{1,2}$/.test(dia.trim())) continue;

    parsed.push({
      dia: dia.trim(),
      condicion: (cond || "").trim(),
      rival: (rivalRaw || "").trim(),
      dato: (extra || "").trim(),
    });
  }
  return parsed;
}

// ---------- TABLA DE POSICIONES (API JSON de ESPN) ----------
// Usamos la API JSON no oficial de ESPN en vez de scrapear el HTML de la
// pagina de posiciones: es mucho mas estable, porque no depende de que el
// marcado de <table>/<td> coincida con lo que esperamos.

async function fetchStandings(zona) {
  const res = await fetch(STANDINGS_API, {
    headers: { "User-Agent": "Mozilla/5.0 (compatible; AlmagroPWA/1.0)", Accept: "application/json" },
  });
  if (!res.ok) throw new Error("ESPN respondio " + res.status);
  const data = await res.json();

  const groups = [];
  collectStandingsGroups(data, groups);
  if (!groups.length) throw new Error("La respuesta de ESPN no trae standings.entries");

  const allEntries = [];
  for (let g = 0; g < groups.length; g++) {
    const entries = groups[g].entries;
    for (let i = 0; i < entries.length; i++) allEntries.push(entries[i]);
  }

  const wanted = allEntries.filter(function (e) {
    return e && e.team && TEAM_ZONE[String(e.team.id)] === zona;
  });
  if (!wanted.length) throw new Error("No se encontraron equipos de la Zona " + zona + " en la respuesta de ESPN");

  const equipos = wanted.map(function (e) {
    return {
      pos: 0, // se completa abajo, despues de ordenar
      equipoId: e.team.id,
      equipo: e.team.displayName || e.team.name || e.team.shortDisplayName,
      jugados: statVal(e, "gamesPlayed"),
      ganados: statVal(e, "wins"),
      empatados: statVal(e, "ties"),
      perdidos: statVal(e, "losses"),
      gf: statVal(e, "pointsFor"),
      gc: statVal(e, "pointsAgainst"),
      dif: statVal(e, "pointDifferential"),
      pts: statVal(e, "points"),
    };
  });

  equipos.sort(function (a, b) {
    if (b.pts !== a.pts) return b.pts - a.pts;
    if (b.dif !== a.dif) return b.dif - a.dif;
    return (b.gf || 0) - (a.gf || 0);
  });
  for (let i = 0; i < equipos.length; i++) equipos[i].pos = i + 1;

  return {
    grupo: zona,
    equipos: equipos,
    actualizado: new Date().toISOString(),
  };
}

function statVal(entry, name) {
  if (!entry.stats) return null;
  for (let i = 0; i < entry.stats.length; i++) {
    if (entry.stats[i].name === name) return entry.stats[i].value;
  }
  return null;
}

// Recorre el JSON de ESPN buscando cualquier nodo con standings.entries (la
// API a veces anida la temporada/grupo actual bajo "children"), y junta todos
// los bloques de entries que encuentre. Despues filtramos por equipo usando
// TEAM_ZONE, en vez de confiar en como ESPN nombre cada bloque.
function collectStandingsGroups(node, out) {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i++) collectStandingsGroups(node[i], out);
    return;
  }
  if (node.standings && Array.isArray(node.standings.entries)) {
    out.push({ name: node.name || null, entries: node.standings.entries });
  }
  if (Array.isArray(node.children)) {
    for (let i = 0; i < node.children.length; i++) collectStandingsGroups(node.children[i], out);
  }
}

// ---------- HELPERS ----------

function stripTags(str) {
  return str.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}

// Promiedos suele repetir el nombre del equipo dos veces en la misma celda
// (ej. "Estudiantes  Estudiantes"). Esto lo colapsa a una sola aparicion.
function dedupe(str) {
  const s = str.trim();
  const half = s.length / 2;
  if (Number.isInteger(half)) {
    const a = s.slice(0, half).trim();
    const b = s.slice(half).trim();
    if (a && a === b) return a;
  }
  const words = s.split(" ");
  if (words.length % 2 === 0) {
    const mid = words.length / 2;
    const a = words.slice(0, mid).join(" ");
    const b = words.slice(mid).join(" ");
    if (a === b) return a;
  }
  return s;
}

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status: status,
    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, OPTIONS", "Access-Control-Allow-Headers": "Content-Type" },
  });
}
