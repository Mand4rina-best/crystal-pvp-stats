const express = require('express');
const path = require('path');
const fs = require('fs');
const app = express();

function env(name) {
  return process.env[name];
}

app.use(express.json());

// Sirve los archivos estáticos (index.html, css, js, etc.) que estén
// en la raíz del repo, al lado de este archivo.
app.use(express.static(__dirname));

/* =========================================================
   ALMACENAMIENTO DE JUGADORES / CHATS
   Guardado en un JSON en disco para que sobreviva reinicios
   del proceso (aunque en el free tier de Render el disco
   puede resetearse en cada deploy — para algo más robusto,
   migrar esto a una base de datos real como Postgres/SQLite).
========================================================= */
const DATA_FILE = path.join(__dirname, "data", "players.json");

function loadPlayers() {
  try {
    const raw = fs.readFileSync(DATA_FILE, "utf8");
    return JSON.parse(raw);
  } catch (err) {
    return {};
  }
}

function savePlayers(players) {
  try {
    fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
    fs.writeFileSync(DATA_FILE, JSON.stringify(players, null, 2));
  } catch (err) {
    console.error("No se pudo guardar data/players.json:", err);
  }
}

// players: { [ticket]: { ticket, steamId64, verified, name, nationality,
//                         kills, deaths, kd, createdAt, messages: [{from, text, at}] } }
let players = loadPlayers();

function findByTicket(ticket) {
  return players[ticket] || null;
}

function findBySteamId(steamId64) {
  return Object.values(players).find(p => p.steamId64 === steamId64) || null;
}

/* =========================================================
   AUTENTICACIÓN DE ADMIN (simple, header x-admin-key)
   Reutiliza el mismo código que ya usa el panel en el front-end.
   Podés sobreescribirlo con la variable de entorno ADMIN_AUTH_CODE.
========================================================= */
const ADMIN_AUTH_CODE = env("ADMIN_AUTH_CODE") || "9912938414112";

function requireAdmin(req, res, next) {
  const key = req.header("x-admin-key");
  if (key !== ADMIN_AUTH_CODE) {
    return res.status(401).json({ error: "No autorizado" });
  }
  next();
}

/* =========================================================
   REGISTRO — crea el jugador pendiente y su chat automáticamente
========================================================= */
app.post("/api/register", async (req, res) => {
  try {
    const { steamId, steamId64, password, nickname } = req.body || {};
    const idJugador = steamId64 || steamId;
    if (!idJugador) {
      return res.status(400).json({ error: "Falta el SteamID64" });
    }

    // --- Pedirle un número de ticket al bot de Discord ---
    const botTicketUrl = env("BOT_TICKET_URL");
    const botApiKey = env("BOT_API_KEY");
    let ticket = null;

    if (botTicketUrl && botApiKey) {
      try {
        const ticketResp = await fetch(botTicketUrl, {
          headers: { "x-api-key": botApiKey }
        });
        if (ticketResp.ok) {
          const data = await ticketResp.json();
          ticket = data && data.ticket ? String(data.ticket) : null;
        } else {
          const detalle = await ticketResp.text().catch(() => "");
          console.error("El bot rechazó la solicitud de ticket:", ticketResp.status, detalle);
        }
      } catch (err) {
        console.error("No se pudo contactar al bot de tickets:", err);
      }
    } else {
      console.warn("BOT_TICKET_URL / BOT_API_KEY no configurados: usando ticket de respaldo.");
    }

    if (!ticket) {
      ticket = Math.floor(100000 + Math.random() * 900000).toString();
    }

    const now = new Date().toISOString();

    // Si ya existía un registro pendiente para ese SteamID, lo reciclamos
    // en vez de crear un chat duplicado.
    const existing = findBySteamId(idJugador);
    if (existing) {
      const oldTicket = existing.ticket;
      existing.ticket = ticket;
      existing.updatedAt = now;
      players[ticket] = existing;
      if (oldTicket !== ticket) delete players[oldTicket];
    } else {
      players[ticket] = {
        ticket,
        steamId64: idJugador,
        nickname: nickname || null,
        verified: false,
        name: "Jugador " + String(idJugador).slice(-4),
        nationality: null,
        kills: null,
        deaths: null,
        kd: null,
        createdAt: now,
        updatedAt: now,
        messages: [
          {
            from: "system",
            text: "Se creó tu ticket de verificación. El STAFF te va a responder por acá o por Discord.",
            at: now
          }
        ]
      };
    }

    savePlayers(players);

    console.log("Nuevo registro:", { idJugador, nickname, ticket });
    res.json({ ok: true, ticket });
  } catch (error) {
    console.error("Error procesando /api/register:", error);
    res.status(500).json({ error: "Error interno registrando al jugador" });
  }
});

/* =========================================================
   PERFIL — usado por el "gate" de todas las páginas para
   saber si la cuenta ya está verificada.
========================================================= */
app.get("/api/profile", (req, res) => {
  const steamId64 = req.query.steamId64;
  if (!steamId64) return res.status(400).json({ error: "Falta steamId64" });

  const player = findBySteamId(steamId64);
  if (!player) {
    return res.status(404).json({ error: "No encontrado" });
  }

  res.json({
    steamId64: player.steamId64,
    name: player.verified ? (player.nickname || player.name) : player.name,
    avatarUrl: "nexus-logo.png",
    nationality: player.nationality || "—",
    verified: !!player.verified,
    kills: player.kills ?? "—",
    deaths: player.deaths ?? "—",
    kd: player.kd ?? "—",
    ticket: player.ticket
  });
});

/* =========================================================
   CHAT — LADO JUGADOR (polling simple, sin login: se valida
   con el par ticket + steamId64 que ya tiene guardado en su navegador)
========================================================= */
app.get("/api/chat/:ticket/messages", (req, res) => {
  const player = findByTicket(req.params.ticket);
  if (!player) return res.status(404).json({ error: "Ticket no encontrado" });
  res.json({ messages: player.messages, verified: player.verified });
});

app.post("/api/chat/:ticket/messages", (req, res) => {
  const player = findByTicket(req.params.ticket);
  if (!player) return res.status(404).json({ error: "Ticket no encontrado" });

  const { text, steamId64 } = req.body || {};
  if (!text || !text.trim()) return res.status(400).json({ error: "Mensaje vacío" });
  if (steamId64 && steamId64 !== player.steamId64) {
    return res.status(403).json({ error: "SteamID64 no coincide con el ticket" });
  }

  const msg = { from: "player", text: text.trim(), at: new Date().toISOString() };
  player.messages.push(msg);
  player.updatedAt = msg.at;
  savePlayers(players);
  res.json({ ok: true, message: msg });
});

/* =========================================================
   CHAT — LADO ADMIN
========================================================= */
app.get("/api/admin/players", requireAdmin, (req, res) => {
  const list = Object.values(players)
    .sort((a, b) => new Date(b.updatedAt || b.createdAt) - new Date(a.updatedAt || a.createdAt))
    .map(p => {
      const last = p.messages[p.messages.length - 1];
      return {
        ticket: p.ticket,
        steamId64: p.steamId64,
        verified: p.verified,
        displayName: p.verified ? (p.nickname || p.name) : ("Nº " + p.ticket),
        lastMessage: last ? last.text : "",
        lastMessageFrom: last ? last.from : "",
        updatedAt: p.updatedAt || p.createdAt
      };
    });
  res.json({ players: list });
});

app.get("/api/admin/players/:ticket", requireAdmin, (req, res) => {
  const player = findByTicket(req.params.ticket);
  if (!player) return res.status(404).json({ error: "Ticket no encontrado" });
  res.json({ player });
});

app.post("/api/admin/players/:ticket/messages", requireAdmin, (req, res) => {
  const player = findByTicket(req.params.ticket);
  if (!player) return res.status(404).json({ error: "Ticket no encontrado" });

  const { text, adminName } = req.body || {};
  if (!text || !text.trim()) return res.status(400).json({ error: "Mensaje vacío" });

  const msg = { from: "admin", by: adminName || "STAFF", text: text.trim(), at: new Date().toISOString() };
  player.messages.push(msg);
  player.updatedAt = msg.at;
  savePlayers(players);
  res.json({ ok: true, message: msg });
});

app.post("/api/admin/players/:ticket/verify", requireAdmin, (req, res) => {
  const player = findByTicket(req.params.ticket);
  if (!player) return res.status(404).json({ error: "Ticket no encontrado" });

  player.verified = true;
  player.updatedAt = new Date().toISOString();
  const msg = { from: "system", text: "✅ Tu cuenta fue verificada por el STAFF.", at: player.updatedAt };
  player.messages.push(msg);
  savePlayers(players);
  res.json({ ok: true });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Servidor escuchando en el puerto ${PORT}`);
});
