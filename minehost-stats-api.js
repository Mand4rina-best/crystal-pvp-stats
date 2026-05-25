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
const cacheMs = Number(process.env.STATS_CACHE_SECONDS || 10) * 1000;

app.use(cors());
app.use(express.static(__dirname));

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "leaderboard-crystal.html"));
});

function env(name) {
  return process.env[name]?.trim();
}

function requiredEnv(name) {
  const value = env(name);

  if (!value) {
    throw new Error(`Falta configurar ${name} en el archivo .env`);
  }

  return value;
}

function getRemoteStatsPath() {
  return env("SFTP_RANK_PATH") || env("SFTP_STATS_PATH") || "/.config/EXILED/Configs/NoAimRankData.json";
}

function getRemoteStatusPath() {
  return env("SFTP_STATUS_PATH") || "/.config/EXILED/Configs/CrystalStatus.json";
}

async function readJsonFromSftp(remotePath) {
  const sftp = new SftpClient();

  try {
    await sftp.connect({
      host: requiredEnv("SFTP_HOST"),
      port: Number(env("SFTP_PORT") || 22),
      username: requiredEnv("SFTP_USER"),
      password: requiredEnv("SFTP_PASSWORD")
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

function getSteamIds(players) {
  const source = normalizePlayersObject(players);

  if (Array.isArray(source)) {
    return source
      .map((player) => player.steam_id || player.steamId || player.SteamID || player.SteamId || player.ID || player.Id)
      .filter(Boolean)
      .map(String);
  }

  return Object.entries(source || {})
    .map(([id, player]) => player.steam_id || player.steamId || player.SteamID || player.SteamId || id)
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
      const id = String(player.steam_id || player.steamId || player.SteamID || player.SteamId || player.ID || player.Id || "");
      const profile = profiles.get(id);
      if (!profile) return;

      player.avatar = profile.avatarfull || profile.avatarmedium || profile.avatar;
      player.profileUrl = profile.profileurl;
    });
    return raw;
  }

  for (const [id, player] of Object.entries(source || {})) {
    const steamId = String(player.steam_id || player.steamId || player.SteamID || player.SteamId || id);
    const profile = profiles.get(steamId);
    if (!profile) continue;

    player.avatar = profile.avatarfull || profile.avatarmedium || profile.avatar;
    player.profileUrl = profile.profileurl;
  }

  return raw;
}

async function readStats() {
  const sourceUrl = env("STATS_SOURCE_URL");

  if (sourceUrl) {
    return readJsonFromUrl(sourceUrl);
  }

  return readJsonFromSftp(getRemoteStatsPath());
}

async function readStatus() {
  const sourceUrl = env("STATUS_SOURCE_URL");

  if (sourceUrl) {
    return readJsonFromUrl(sourceUrl);
  }

  return readJsonFromSftp(getRemoteStatusPath());
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

app.listen(port, () => {
  console.log(`Stats API lista: http://localhost:${port}/stats.json`);
  console.log(`Status API lista: http://localhost:${port}/status.json`);
});
