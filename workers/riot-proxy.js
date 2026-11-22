// Hardened Riot proxy (nirlau.de/api.nirlau.de). Logic mirrors the live worker;
// hardening: method allowlist, CORS only for allowlisted origins, strict input
// validation, per-IP rate limiting and no upstream calls for invalid input.
const ALLOWED_ORIGINS = ['https://nirlau.de', 'https://www.nirlau.de'];

// Riot IDs: letters/numbers plus a few safe separators. Anything else is
// rejected before any upstream call is made.
const NAME_PATTERN = /^[\p{L}\p{N} _.\-+']{1,20}$/u;
const TAG_PATTERN = /^[\p{L}\p{N}]{1,8}$/u;

const REGIONS = new Set(['euw', 'euw1', 'eun', 'eun1', 'na', 'na1', 'br', 'br1', 'la1', 'la2', 'oc', 'oc1', 'jp', 'jp1', 'kr', 'tr', 'tr1', 'ru']);

// Simple abuse guard: fixed window per client IP, backed by the Cache API.
const RATE_LIMIT = 30; // requests
const RATE_WINDOW_SECONDS = 60;

function corsHeaders(origin) {
  const headers = new Headers({
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type": "application/json"
  });
  // An unknown or missing Origin never receives an ACAO header.
  if (origin) headers.set("Access-Control-Allow-Origin", origin);
  headers.set("Vary", "Origin");
  return headers;
}

function allowedOrigin(req) {
  const reqOrigin = req.headers.get('Origin');
  return reqOrigin && ALLOWED_ORIGINS.includes(reqOrigin) ? reqOrigin : null;
}

function json(obj, status = 200, origin = null) {
  const headers = corsHeaders(origin);
  // Errors, 404s and rate-limit responses must never be cached.
  if (status !== 200) headers.set('Cache-Control', 'no-store');
  return new Response(JSON.stringify(obj), { status, headers });
}

async function rateLimit(req) {
  const ip = req.headers.get('CF-Connecting-IP') || 'unknown';
  const url = new URL(req.url);
  // Bucket by client IP and first path segment for consistency with the other
  // proxies. Window rollover happens implicitly via the cache TTL.
  const window = Math.floor(Date.now() / (RATE_WINDOW_SECONDS * 1000));
  const bucket = url.pathname.split('/').filter(Boolean)[0] || 'root';
  const key = new Request(`https://rate-limit.local/riot-proxy/${ip}/${bucket}/${window}`);
  const cached = await caches.default.match(key);
  const count = cached ? Number(await cached.text()) || 0 : 0;
  if (count >= RATE_LIMIT) return false;
  const counter = new Response(String(count + 1));
  counter.headers.set('Cache-Control', `public, max-age=${RATE_WINDOW_SECONDS}`);
  await caches.default.put(key, counter);
  return true;
}

async function fetchCached(url, headers, ctx, okTTL = 120) {
  const key = new Request(url);
  let res = await caches.default.match(key);
  if (res) return res.clone();
  const up = await fetch(url, { headers });
  const wrapped = new Response(await up.arrayBuffer(), { status: up.status, headers: up.headers });
  if (up.ok) {
    wrapped.headers.set("Cache-Control", `public, max-age=${okTTL}`);
    ctx.waitUntil(caches.default.put(key, wrapped.clone()));
  }
  return wrapped;
}

async function fetchMasteries({ puuid, summonerId, platform, H, ctx }) {
  let r = await fetchCached(`https://${platform}.api.riotgames.com/lol/champion-mastery/v4/champion-masteries/by-puuid/${puuid}`, H, ctx, 300);
  if (r.ok) return r.json();
  if (r.status === 404 || r.status === 403) {
    r = await fetchCached(`https://${platform}.api.riotgames.com/lol/champion-mastery/v4/champion-masteries/by-summoner/${summonerId}`, H, ctx, 300);
    if (r.ok) return r.json();
  }
  return { error: "mastery", status: r.status, body: await safeText(r) };
}

async function fetchRecentMatches({ puuid, route, H, ctx, count = 10 }) {
  const idsURL = `https://${route}.api.riotgames.com/lol/match/v5/matches/by-puuid/${puuid}/ids?start=0&count=${count}`;
  const idsRes = await fetchCached(idsURL, H, ctx, 60);
  if (!idsRes.ok) return { error: "match-ids", status: idsRes.status, body: await safeText(idsRes) };
  const ids = await idsRes.json();
  let accountCreatedAt = null;
  const accRes = await fetchCached(`https://${route}.api.riotgames.com/riot/account/v1/accounts/by-puuid/${puuid}`, H, ctx, 300);
  if (accRes.ok) {
    const acc = await accRes.json();
    accountCreatedAt = acc.createdAt || acc.createdAtMillis ? new Date(acc.createdAt || acc.createdAtMillis).toISOString() : null;
  }
  const limited = ids.slice(0, count);
  const matches = await Promise.all(limited.map(async (id) => {
    const mRes = await fetchCached(`https://${route}.api.riotgames.com/lol/match/v5/matches/${id}`, H, ctx, 120);
    if (!mRes.ok) return { matchId: id, error: { status: mRes.status } };
    const m = await mRes.json();
    const info = m.info || {};
    const me = (info.participants || []).find((p) => p.puuid === puuid) || null;
    return {
      matchId: id,
      queueId: info.queueId,
      gameMode: info.gameMode || null,
      gameType: info.gameType || null,
      gameCreation: info.gameCreation ? new Date(info.gameCreation).toISOString() : null,
      gameDuration: info.gameDuration ?? null,
      isArena: [1700, 1710].includes(info.queueId || -1),
      you: me ? {
        championId: me.championId,
        championName: me.championName,
        win: !!me.win,
        kills: me.kills,
        deaths: me.deaths,
        assists: me.assists,
        kda: me.deaths ? ((me.kills + me.assists) / Math.max(1, me.deaths)).toFixed(2) : "Perfect",
        cs: (me.totalMinionsKilled ?? 0) + (me.neutralMinionsKilled ?? 0),
        role: me.teamPosition || me.role || null,
        arenaPlacement: typeof me.subteamPlacement === "number" ? me.subteamPlacement : null,
        subteamId: typeof me.playerSubteamId === "number" ? me.playerSubteamId : null
      } : null
    };
  }));
  const times = matches.map((m) => Date.parse(m.gameCreation || "")).filter((n) => Number.isFinite(n));
  const earliestMatchAt = times.length ? new Date(Math.min(...times)).toISOString() : null;
  return { matches, accountCreatedAt, earliestMatchAt };
}

function normalizePlatform(s) {
  const x = s.toLowerCase();
  const map = {
    euw: "euw1", euw1: "euw1",
    eun: "eun1", eun1: "eun1",
    na: "na1", na1: "na1",
    br: "br1", br1: "br1",
    la1: "la1", la2: "la2",
    oc: "oc1", oc1: "oc1",
    jp: "jp1", jp1: "jp1",
    kr: "kr",
    tr: "tr1", tr1: "tr1",
    ru: "ru"
  };
  return map[x];
}

function routeRegion(platform) {
  if (["euw1", "eun1", "tr1", "ru"].includes(platform)) return "europe";
  if (["na1", "br1", "la1", "la2"].includes(platform)) return "americas";
  if (["jp1", "kr"].includes(platform)) return "asia";
  if (["oc1"].includes(platform)) return "sea";
  return "europe";
}

async function safeText(resp) {
  const t = await resp.text().catch(() => "");
  return t.length > 500 ? t.slice(0, 500) + "\u2026" : t;
}

async function passthrough(where, resp, origin) {
  return json({ error: where, status: resp.status, body: await safeText(resp) }, resp.status, origin);
}

export default {
  async fetch(req, env, ctx) {
    const origin = allowedOrigin(req);

    if (req.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }
    if (req.method !== "GET") {
      return json({ error: "Method not allowed" }, 405, origin);
    }
    if (!(await rateLimit(req))) {
      return json({ error: "Too many requests" }, 429, origin);
    }

    const url = new URL(req.url);
    const parts = url.pathname.split("/").filter(Boolean);
    const debug = url.searchParams.get("debug") === "1";

    if (parts.length === 0) {
      return json({
        ok: true,
        usage: [
          "/lol/<gameName>/<tagLine>/<region>?debug=1  // Riot ID",
          "/lol/<summonerName>/<region>?debug=1        // legacy"
        ]
      }, 200, origin);
    }

    if (parts[0] !== "lol") return json({ error: "Invalid route" }, 400, origin);
    if (!env.RIOT_API_KEY) return json({ error: "RIOT_API_KEY missing" }, 500, origin);

    const H = { "X-Riot-Token": env.RIOT_API_KEY };
    let gameName, tagLine, region, legacyName;
    if (parts.length === 4) {
      [, gameName, tagLine, region] = parts;
      if (!NAME_PATTERN.test(gameName) || !TAG_PATTERN.test(tagLine)) {
        return json({ error: "Invalid Riot ID" }, 400, origin);
      }
    } else if (parts.length === 3) {
      [, legacyName, region] = parts;
      if (!NAME_PATTERN.test(legacyName)) {
        return json({ error: "Invalid summoner name" }, 400, origin);
      }
    } else {
      return json({ error: "Use /lol/<game>/<tag>/<region> or /lol/<name>/<region>" }, 400, origin);
    }

    if (!REGIONS.has((region || "").toLowerCase())) {
      return json({ error: "Unsupported region" }, 400, origin);
    }
    region = region.toLowerCase();
    const platform = normalizePlatform(region);
    if (!platform) return json({ error: "Unsupported region" }, 400, origin);
    const route = routeRegion(platform);
    const out = { errors: [] };

    try {
      let puuid;
      if (gameName && tagLine) {
        const accURL = `https://${route}.api.riotgames.com/riot/account/v1/accounts/by-riot-id/${encodeURIComponent(gameName)}/${encodeURIComponent(tagLine)}`;
        const acc = await fetchCached(accURL, H, ctx, 300);
        if (!acc.ok) return passthrough("riot-id", acc, origin);
        const a = await acc.json();
        puuid = a.puuid;
        if (debug) out.riotId = { gameName: a.gameName, tagLine: a.tagLine };
      } else {
        const byNameURL = `https://${platform}.api.riotgames.com/lol/summoner/v4/summoners/by-name/${encodeURIComponent(legacyName)}`;
        const s = await fetchCached(byNameURL, H, ctx, 120);
        if (!s.ok) return passthrough("by-name", s, origin);
        const sj = await s.json();
        puuid = sj.puuid;
      }

      const byPuuidURL = `https://${platform}.api.riotgames.com/lol/summoner/v4/summoners/by-puuid/${puuid}`;
      const s2 = await fetchCached(byPuuidURL, H, ctx, 300);
      if (!s2.ok) return passthrough("by-puuid", s2, origin);
      const summ = await s2.json();
      out.summonerName = summ.name;
      out.level = summ.summonerLevel;
      if (debug) out._ids = { id: summ.id, puuid: summ.puuid };

      const rankedURL = `https://${platform}.api.riotgames.com/lol/league/v4/entries/by-summoner/${summ.id}`;
      const r1 = await fetchCached(rankedURL, H, ctx, 120);
      if (r1.ok) {
        const arr = await r1.json();
        const solo = Array.isArray(arr) ? arr.find((e) => e.queueType === "RANKED_SOLO_5x5") : null;
        out.ranked = solo ? { tier: solo.tier, rank: solo.rank, lp: solo.leaguePoints, wins: solo.wins, losses: solo.losses } : null;
      } else {
        out.ranked = null;
        out.errors.push({ where: "ranked", status: r1.status });
      }

      const mastery = await fetchMasteries({ puuid: summ.puuid, summonerId: summ.id, platform, H, ctx });
      if (Array.isArray(mastery)) {
        const top3 = mastery.slice(0, 3).map((x) => ({ championId: x.championId, points: x.championPoints }));
        const totalMasteryPoints = mastery.reduce((a, b) => a + (b.championPoints | 0), 0);
        out.masteryTop3 = top3;
        out.totalMasteryPoints = totalMasteryPoints;
      } else {
        out.masteryTop3 = [];
        out.totalMasteryPoints = 0;
        out.errors.push(mastery);
      }

      const recent = await fetchRecentMatches({ puuid: summ.puuid, route, H, ctx, count: 10 });
      if (Array.isArray(recent.matches)) {
        out.recentMatches = recent.matches;
        out.accountCreatedAt = recent.accountCreatedAt ?? null;
        out.accountCreatedAtApprox = recent.earliestMatchAt ?? null;
      } else {
        out.recentMatches = [];
        out.accountCreatedAt = null;
        out.accountCreatedAtApprox = null;
        out.errors.push(recent);
      }

      const body = debug ? out : {
        summonerName: out.summonerName,
        level: out.level,
        ranked: out.ranked,
        totalMasteryPoints: out.totalMasteryPoints,
        masteryTop3: out.masteryTop3,
        accountCreatedAt: out.accountCreatedAt,
        accountCreatedAtApprox: out.accountCreatedAtApprox,
        recentMatches: out.recentMatches
      };

      return json(body, 200, origin);
    } catch (e) {
      out.errors.push({ where: "catch", message: String(e) });
      return json(out, 500, origin);
    }
  }
};
