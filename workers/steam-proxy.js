const STEAM = "https://api.steampowered.com";
const ALLOWED_ORIGINS = ['https://nirlau.de', 'https://www.nirlau.de'];

// SteamID64 is exactly 17 digits; anything else is rejected before any upstream call.
const STEAMID_PATTERN = /^\d{17}$/;

// Public route segments. Requests for anything else are answered 404 without
// touching the rate limiter (no bucket creation for invalid routes).
const ROUTES = new Set(["currently-playing", "owned", "rarest-achievements", "profile"]);

// Best-effort abuse guard: fixed window per client IP, backed by the Cache
// API. It is colo-local (per data centre), not globally consistent, and it
// FAILS OPEN when the cache backend errors — a cost guard, never a security
// boundary. Zone-level rate limiting rules would be required for global
// enforcement (missing permission; see docs/cloudflare-write-plan.md).
const RATE_LIMIT = 30; // requests
const RATE_WINDOW_SECONDS = 60;

function corsHeaders(origin) {
  const headers = {
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type": "application/json; charset=utf-8"
  };
  // An unknown or missing Origin never receives an ACAO header.
  if (origin) headers["Access-Control-Allow-Origin"] = origin;
  headers["Vary"] = "Origin";
  return headers;
}

function allowedOrigin(req) {
  const reqOrigin = req.headers.get('Origin');
  return reqOrigin && ALLOWED_ORIGINS.includes(reqOrigin) ? reqOrigin : null;
}

const json = (data, status = 200, origin = null) =>
  new Response(JSON.stringify(data), { status, headers: withCachePolicy(status, corsHeaders(origin)) });

// Errors, 404s and rate-limit responses must never be cached.
function withCachePolicy(status, headers) {
  if (status !== 200) headers['Cache-Control'] = 'no-store';
  return headers;
}

async function rateLimit(req) {
  const ip = req.headers.get('CF-Connecting-IP') || 'unknown';
  const url = new URL(req.url);
  // Bucket by client IP and first path segment (matches the route selection
  // below, which only looks at the first segment). Window rollover happens
  // implicitly via the cache TTL.
  const window = Math.floor(Date.now() / (RATE_WINDOW_SECONDS * 1000));
  const bucket = url.pathname.split('/').filter(Boolean)[0] || 'root';
  const key = new Request(`https://rate-limit.local/steam-proxy/${ip}/${bucket}/${window}`);
  // Best-effort guard: if the cache backend fails, requests are served (fail-open).
  try {
    const cached = await caches.default.match(key);
    const count = cached ? Number(await cached.text()) || 0 : 0;
    if (count >= RATE_LIMIT) return false;
    const counter = new Response(String(count + 1));
    counter.headers.set('Cache-Control', `public, max-age=${RATE_WINDOW_SECONDS}`);
    await caches.default.put(key, counter);
    return true;
  } catch {
    return true;
  }
}

// Returns the parsed JSON body, or null when the upstream call failed.
// Callers MUST treat null as an upstream failure (502) — a missing/empty
// payload is never reported as success.
async function steamFetch(url) {
  const r = await fetch(url, { cf: { cacheTtl: 3600, cacheEverything: true } });
  if (!r.ok) return null;
  return r.json();
}

async function handle(req, env) {
  const origin = allowedOrigin(req);

  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders(origin) });
  }
  if (req.method !== "GET") {
    return json({ error: "Method not allowed" }, 405, origin);
  }

  const u = new URL(req.url);
  const [seg] = u.pathname.split("/").filter(Boolean);
  const steamid = u.searchParams.get("steamid");

  // Validate route and input BEFORE the rate limiter: invalid requests are
  // answered directly and must not create limiter buckets.
  if (!STEAMID_PATTERN.test(steamid || "")) {
    return json({ error: "Valid steamid (SteamID64) required" }, 400, origin);
  }
  if (!ROUTES.has(seg)) {
    return json({ error: "Not found" }, 404, origin);
  }
  if (!(await rateLimit(req))) {
    return json({ error: "Too many requests" }, 429, origin);
  }
  if (!env.STEAM_API_KEY) {
    return json({ error: "STEAM_API_KEY missing" }, 500, origin);
  }

  try {
    if (seg === "currently-playing") {
      const data = await steamFetch(`${STEAM}/ISteamUser/GetPlayerSummaries/v2/?key=${env.STEAM_API_KEY}&steamids=${steamid}`);
      if (data?.response == null) return json({ error: "upstream_error" }, 502, origin);
      const p = (data.response.players || [])[0];
      if (!p) return json({ error: "not_found" }, 404, origin);
      return json({ game: p.gameextrainfo || null, appid: p.gameid || null }, 200, origin);
    }

    if (seg === "owned") {
      const data = await
      steamFetch(`${STEAM}/IPlayerService/GetOwnedGames/v1/?key=${env.STEAM_API_KEY}&steamid=${steamid}&include_appinfo=1&include_played_free_games=1`);
      if (data?.response == null) return json({ error: "upstream_error" }, 502, origin);
      const games = (data.response.games || []).map((g) => ({
        appid: g.appid,
        name: g.name,
        playtime_minutes: g.playtime_forever ?? 0,
        img_logo_url: g.img_logo_url
      })).sort((a, b) => b.playtime_minutes - a.playtime_minutes);
      return json({ total_minutes: games.reduce((s, g) => s + g.playtime_minutes, 0), games }, 200, origin);
    }

    if (seg === "rarest-achievements") {
      const ownedData = await steamFetch(`${STEAM}/IPlayerService/GetOwnedGames/v1/?key=${env.STEAM_API_KEY}&steamid=${steamid}&include_appinfo=1`);
      if (ownedData?.response == null) return json({ error: "upstream_error" }, 502, origin);
      const games = (ownedData.response.games || [])
        .sort((a, b) => b.playtime_forever - a.playtime_forever)
        .filter(g => g.playtime_forever > 0)
        .filter(g => g.appid !== 346110)
        .slice(0, 15);

      const playerResults = await Promise.all(games.map(async (g) => {
        const res = await steamFetch(`${STEAM}/ISteamUserStats/GetPlayerAchievements/v1/?key=${env.STEAM_API_KEY}&steamid=${steamid}&appid=${g.appid}`);
        if (res?.playerstats?.success && res.playerstats.achievements) {
          return { appid: g.appid, name: g.name, achievements: res.playerstats.achievements.filter(a => a.achieved === 1) };
        }
        return null;
      }));

      const validGamesWithUnlocked = playerResults.filter(r => r && r.achievements.length > 0);

      const globalResults = await Promise.all(validGamesWithUnlocked.map(async (rg) => {
        const res = await steamFetch(`${STEAM}/ISteamUserStats/GetGlobalAchievementPercentagesForApp/v2/?gameid=${rg.appid}`);
        if (res?.achievementpercentages?.achievements) {
          const percentages = res.achievementpercentages.achievements;
          return rg.achievements.map(ua => {
            const info = percentages.find(p => p.name === ua.apiname);
            return { appid: rg.appid, gameName: rg.name, apiname: ua.apiname, percent: info ? parseFloat(info.percent) : 100 };
          });
        }
        return [];
      }));

      const flattened = globalResults.flat().sort((a, b) => a.percent - b.percent).slice(0, 10);

      const neededAppids = Array.from(new Set(flattened.map(f => f.appid)));
      const schemaMaps = {};
      await Promise.all(neededAppids.map(async (appid) => {
        const res = await steamFetch(`${STEAM}/ISteamUserStats/GetSchemaForGame/v2/?key=${env.STEAM_API_KEY}&appid=${appid}`);
        if (res?.game?.availableGameStats?.achievements) {
          schemaMaps[appid] = res.game.availableGameStats.achievements;
        }
      }));

      const rarest = flattened.map(f => {
        const achievements = schemaMaps[f.appid];
        const info = achievements?.find(a => a.name === f.apiname);
        return { gameName: f.gameName, name: info ? info.displayName : f.apiname, icon: info ? info.icon : "", percent: parseFloat(f.percent.toFixed(1)) };
      });

      return json({ rarest }, 200, origin);
    }

    if (seg === "profile") {
      const data = await steamFetch(`${STEAM}/ISteamUser/GetPlayerSummaries/v2/?key=${env.STEAM_API_KEY}&steamids=${steamid}`);
      if (data?.response == null) return json({ error: "upstream_error" }, 502, origin);
      const p = (data.response.players || [])[0];
      if (!p) return json({ error: "not_found" }, 404, origin);
      return json({ steamid: p.steamid, persona: p.personaname, avatar: p.avatarfull, profileurl: p.profileurl }, 200, origin);
    }

    return json({ error: "Not found" }, 404, origin);
  } catch (err) {
    // Never echo internal error details to the public endpoint.
    return json({ error: "upstream_error" }, 502, origin);
  }
}

export default {
  async fetch(req, env) {
    return handle(req, env);
  }
};
