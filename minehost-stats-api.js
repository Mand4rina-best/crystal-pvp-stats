require("dotenv").config();

const express = require("express");
const cors = require("cors");
const SftpClient = require("ssh2-sftp-client");
const path = require("path");

const app = express();
const port = Number(process.env.WEB_PORT || 3000);

let statsCache = null;
let statsCacheTime = 0;
let statusCache = null;
let statusCacheTime = 0;
let teamsCache = null;
let teamsCacheTime = 0;
let pvpStatsCache = null;
let pvpStatsCacheTime = 0;
let pvpTeamsCache = null;
let pvpTeamsCacheTime = 0;
const cacheMs = Number(process.env.STATS_CACHE_SECONDS || 10) * 1000;

app.use(cors());
app.use(express.static(__dirname));

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "leaderboard-crystal.html"));
});

function env(name) {
  return process.env[name]?.trim();
}

function prefixedEnv(prefix, name) {
  return env(`${prefix}${name}`) || env(name);
}

function requiredEnv(name, prefix = "") {
  const value = prefixedEnv(prefix, name);

  if (!value) {
    throw new Error(`Falta configurar ${prefix}${name} en el archivo .env`);
  }

  return value;
}

function getRemoteStatsPath(prefix = "", fallback = "/.config/EXILED/Configs/NoAimRankData.json") {
  return prefixedEnv(prefix, "SFTP_RANK_PATH") || prefixedEnv(prefix, "SFTP_STATS_PATH") || fallback;
}

function getRemoteStatusPath() {
  return env("SFTP_STATUS_PATH") || "/.config/EXILED/Configs/CrystalStatus.json";
}

function getRemoteTeamsPath(prefix = "") {
  return prefixedEnv(prefix, "SFTP_TEAMS_PATH") || "/.config/EXILED/Configs/CrystalTeams.json";
}

async function readJsonFromSftp(remotePath, prefix = "") {
  const sftp = new SftpClient();

  try {
    await sftp.connect({
      host: requiredEnv("SFTP_HOST", prefix),
      port: Number(prefixedEnv(prefix, "SFTP_PORT") || 22),
      username: requiredEnv("SFTP_USER", prefix),
      password: requiredEnv("SFTP_PASSWORD", prefix)
    });

    const buffer = await sftp.get(remotePath);
    return JSON.parse(buffer.toString("utf8"));
  } finally {
    await sftp.end().catch(() => {});
  }
}

async function readJsonFromUrl(url) {
  const response = await fetch(url, {
    headers: {
      accept: "application/json,text/plain,*/*"
    }
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} leyendo STATS_SOURCE_URL`);
  }

  return response.json();
}

function normalizePlayersObject(raw) {
  if (raw && raw.players) return raw.players;
  return raw;
}

function toSteamId64(value) {
  const text = String(value || "").trim();
  if (!text) return "";

  const onlyDigits = text.match(/\d{15,20}/)?.[0];
  if (onlyDigits) return onlyDigits;

  const steam3 = text.match(/\[U:1:(\d+)\]/i);
  if (steam3) return String(76561197960265728n + BigInt(steam3[1]));

  const steam2 = text.match(/STEAM_[0-5]:(\d):(\d+)/i);
  if (steam2) {
    return String(76561197960265728n + BigInt(steam2[1]) + BigInt(steam2[2]) * 2n);
  }

  const accountId = text.match(/^\d{1,12}$/)?.[0];
  if (accountId) return String(76561197960265728n + BigInt(accountId));

  return "";
}

function getPlayerSteamId(player, idFromObject = "") {
  return toSteamId64(
    player?.steam_id ||
    player?.steamId ||
    player?.SteamID ||
    player?.SteamId ||
    player?.ID ||
    player?.Id ||
    player?.UserId ||
    player?.UserID ||
    idFromObject
  );
}

function getSteamIds(players) {
  const source = normalizePlayersObject(players);

  if (Array.isArray(source)) {
    return source
      .map((player) => getPlayerSteamId(player))
      .filter(Boolean)
      .map(String);
  }

  return Object.entries(source || {})
    .map(([id, player]) => getPlayerSteamId(player, id))
    .filter(Boolean)
    .map(String);
}

async function getSteamProfiles(steamIds) {
  const key = process.env.STEAM_API_KEY;
  const ids = [...new Set(steamIds)].filter((id) => /^\d{15,20}$/.test(id));

  if (!key || !ids.length) return new Map();

  const profiles = new Map();

  for (let index = 0; index < ids.length; index += 100) {
    const chunk = ids.slice(index, index + 100);
    const url = new URL("https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v2/");
    url.searchParams.set("key", key);
    url.searchParams.set("steamids", chunk.join(","));

    const response = await fetch(url);
    if (!response.ok) throw new Error(`Steam API HTTP ${response.status}`);

    const payload = await response.json();
    for (const profile of payload.response?.players || []) {
      profiles.set(String(profile.steamid), profile);
    }
  }

  return profiles;
}

async function addSteamProfiles(raw) {
  const source = normalizePlayersObject(raw);
  const profiles = await getSteamProfiles(getSteamIds(source));

  if (!profiles.size) return raw;

  if (Array.isArray(source)) {
    source.forEach((player) => {
      const id = getPlayerSteamId(player);
      const profile = profiles.get(id);
      if (!profile) return;

      player.steam_id = id;
      player.avatar = profile.avatarfull || profile.avatarmedium || profile.avatar;
      player.avatarMedium = profile.avatarmedium || profile.avatar;
      player.profileUrl = profile.profileurl;
    });
    return raw;
  }

  for (const [id, player] of Object.entries(source || {})) {
    const steamId = getPlayerSteamId(player, id);
    const profile = profiles.get(steamId);
    if (!profile) continue;

    player.steam_id = steamId;
    player.avatar = profile.avatarfull || profile.avatarmedium || profile.avatar;
    player.avatarMedium = profile.avatarmedium || profile.avatar;
    player.profileUrl = profile.profileurl;
  }

  return raw;
}

async function readStats(prefix = "", fallbackPath = "/.config/EXILED/Configs/NoAimRankData.json") {
  const sourceUrl = prefixedEnv(prefix, "STATS_SOURCE_URL");

  if (sourceUrl) {
    return readJsonFromUrl(sourceUrl);
  }

  return readJsonFromSftp(getRemoteStatsPath(prefix, fallbackPath), prefix);
}

async function readStatus() {
  const sourceUrl = env("STATUS_SOURCE_URL");

  if (sourceUrl) {
    return readJsonFromUrl(sourceUrl);
  }

  return readJsonFromSftp(getRemoteStatusPath());
}

async function readTeams(prefix = "") {
  const sourceUrl = prefixedEnv(prefix, "TEAMS_SOURCE_URL");

  if (sourceUrl) {
    return readJsonFromUrl(sourceUrl);
  }

  return readJsonFromSftp(getRemoteTeamsPath(prefix), prefix);
}

app.get("/stats.json", async (req, res) => {
  try {
    const now = Date.now();

    if (!statsCache || now - statsCacheTime > cacheMs) {
      statsCache = await addSteamProfiles(await readStats());
      statsCacheTime = now;
    }

    res.setHeader("Cache-Control", "no-store");
    res.json({
      updatedAt: new Date(statsCacheTime).toISOString(),
      players: statsCache
    });
  } catch (error) {
    console.error("No pude leer NoAimRankData.json desde Minehost:", error);
    res.status(500).json({ error: "No pude leer las stats desde Minehost" });
  }
});

app.get("/status.json", async (req, res) => {
  try {
    const now = Date.now();

    if (!statusCache || now - statusCacheTime > cacheMs) {
      statusCache = await readStatus();
      statusCacheTime = now;
    }

    res.setHeader("Cache-Control", "no-store");
    res.json({
      updatedAt: new Date(statusCacheTime).toISOString(),
      status: statusCache
    });
  } catch (error) {
    console.error("No pude leer CrystalStatus.json desde Minehost:", error);
    res.status(500).json({ error: "No pude leer el status desde Minehost" });
  }
});

app.get("/teams.json", async (req, res) => {
  try {
    const now = Date.now();

    if (!teamsCache || now - teamsCacheTime > cacheMs) {
      teamsCache = await readTeams();
      teamsCacheTime = now;
    }

    res.setHeader("Cache-Control", "no-store");
    res.json({
      updatedAt: new Date(teamsCacheTime).toISOString(),
      teams: teamsCache
    });
  } catch (error) {
    console.error("No pude leer CrystalTeams.json desde Minehost:", error);
    res.status(500).json({ error: "No pude leer los teams desde Minehost" });
  }
});

app.get("/pvp/stats.json", async (req, res) => {
  try {
    const now = Date.now();

    if (!pvpStatsCache || now - pvpStatsCacheTime > cacheMs) {
      pvpStatsCache = await addSteamProfiles(await readStats("PVP_", "/.config/EXILED/Configs/CrystalPvPData.json"));
      pvpStatsCacheTime = now;
    }

    res.setHeader("Cache-Control", "no-store");
    res.json({
      updatedAt: new Date(pvpStatsCacheTime).toISOString(),
      players: pvpStatsCache
    });
  } catch (error) {
    console.error("No pude leer CrystalPvPData.json desde Minehost:", error);
    res.status(500).json({ error: "No pude leer las stats PVP T desde Minehost" });
  }
});

app.get("/pvp/teams.json", async (req, res) => {
  try {
    const now = Date.now();

    if (!pvpTeamsCache || now - pvpTeamsCacheTime > cacheMs) {
      pvpTeamsCache = await readTeams("PVP_");
      pvpTeamsCacheTime = now;
    }

    res.setHeader("Cache-Control", "no-store");
    res.json({
      updatedAt: new Date(pvpTeamsCacheTime).toISOString(),
      teams: pvpTeamsCache
    });
  } catch (error) {
    console.error("No pude leer CrystalTeams.json de PVP T desde Minehost:", error);
    res.status(500).json({ error: "No pude leer los teams PVP T desde Minehost" });
  }
});

app.listen(port, () => {
  console.log(`Stats API lista: http://localhost:${port}/stats.json`);
  console.log(`Status API lista: http://localhost:${port}/status.json`);
  console.log(`Teams API lista: http://localhost:${port}/teams.json`);
  console.log(`PVP T Stats API lista: http://localhost:${port}/pvp/stats.json`);
  console.log(`PVP T Teams API lista: http://localhost:${port}/pvp/teams.json`);
});
