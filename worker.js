// Worker de Cloudflare — scraper para la app de Club Almagro.
//
// Expone:
//   GET /fixture            -> { proximos: [...], resultados: [...], actualizado: "ISO date" }
//                               (scrapea la pagina del equipo en Promiedos)
//   GET /standings?zona=A|B -> { grupo: "A"|"B", equipos: [...], actualizado: "ISO date" }
//                               (scrapea la tabla de posiciones en ESPN; Almagro juega en la
//                               Zona B de la Primera Nacional, pero se puede pedir cualquiera
//                               de las dos para el comparador rapido)
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
const STANDINGS_URL = "https://www.espn.com.ar/futbol/posiciones/_/liga/arg.2";
const CACHE_TTL_SECONDS = 1800; // 30 minutos
const EQUIPOS_POR_ZONA = 18; // cantidad de equipos en cada zona de la Primera Nacional

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
      return withEdgeCache(url, request, ctx, function () { return scrapeStandings(zona); });
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

// ---------- TABLA DE POSICIONES (ESPN) ----------
// La tabla de Promiedos se hidrata con JavaScript del lado del cliente, asi que
// un fetch de servidor solo trae el esqueleto vacio. ESPN si la sirve completa
// en el HTML inicial. La pagina lista primero el Grupo A y despues el Grupo B,
// tanto en la lista de equipos como en los bloques de estadisticas (J, G, E, P...),
// asi que para la Zona B hay que saltear el primer bloque de cada tipo.

async function scrapeStandings(zona) {
  const res = await fetch(STANDINGS_URL, {
    headers: { "User-Agent": "Mozilla/5.0 (compatible; AlmagroPWA/1.0)" },
  });
  if (!res.ok) throw new Error("ESPN respondio " + res.status);
  const html = await res.text();

  const groupAStart = html.indexOf(">Grupo A<");
  const groupBStart = html.indexOf(">Grupo B<", groupAStart === -1 ? 0 : groupAStart);
  if (groupAStart === -1) throw new Error("No se encontro la seccion Grupo A");
  if (groupBStart === -1) throw new Error("No se encontro la seccion Grupo B");

  const namesChunk = zona === "A" ? html.slice(groupAStart, groupBStart) : html.slice(groupBStart);

  const teamLinkRegex = /futbol\/equipo\/_\/id\/(\d+)\/[a-z0-9\-]+"[^>]*>([^<]+)<\/a>/gi;
  const namesById = new Map();
  let m;
  while ((m = teamLinkRegex.exec(namesChunk)) !== null) {
    const id = m[1];
    const rawText = m[2].trim();
    const clean = rawText.replace(/^[A-Z\u00c1\u00c9\u00cd\u00d3\u00da\u00d10-9]{2,6}\s*\(/, "").replace(/\)$/, "");
    const prev = namesById.get(id);
    if (!prev || clean.length > prev.length) namesById.set(id, clean);
    if (namesById.size >= EQUIPOS_POR_ZONA) break;
  }
  const teamIds = Array.from(namesById.keys());
  const teamNames = Array.from(namesById.values());
  if (teamNames.length < 10) throw new Error("No se pudieron leer los nombres de la Zona " + zona);

  const marker = "ordenar/gamesplayed";
  const firstMarker = html.indexOf(marker);
  if (firstMarker === -1) throw new Error("No se encontro la tabla de estadisticas");
  const secondMarker = html.indexOf(marker, firstMarker + marker.length);

  const statsStart = zona === "A" ? firstMarker : (secondMarker === -1 ? firstMarker : secondMarker);
  const statsEnd = (zona === "A" && secondMarker !== -1) ? secondMarker : statsStart + 40000;
  const statsChunk = html.slice(statsStart, statsEnd);

  const cellRegex = /<td[^>]*>\s*([+-]?\d+)\s*<\/td>/gi;
  const numbers = Array.from(statsChunk.matchAll(cellRegex)).map(function (c) { return c[1]; });

  const equipos = [];
  const colsPerRow = 8;
  const rowCount = Math.min(teamNames.length, Math.floor(numbers.length / colsPerRow));

  for (let i = 0; i < rowCount; i++) {
    const slice = numbers.slice(i * colsPerRow, i * colsPerRow + colsPerRow);
    const nums = slice.map(Number);
    equipos.push({
      pos: i + 1,
      equipoId: teamIds[i],
      equipo: teamNames[i],
      jugados: nums[0],
      ganados: nums[1],
      empatados: nums[2],
      perdidos: nums[3],
      gf: nums[4],
      gc: nums[5],
      dif: nums[6],
      pts: nums[7],
    });
  }
  if (!equipos.length) throw new Error("No se pudieron cruzar nombres y estadisticas");

  return {
    grupo: zona,
    equipos: equipos,
    actualizado: new Date().toISOString(),
  };
}

// ---------- HELPERS ----------

function stripTags(str) {
  return str.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}

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
