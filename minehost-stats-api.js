require('dotenv').config();
const express = require('express');
const path = require('path');
const { MongoClient } = require('mongodb');

const app = express();

function env(name) {
  return process.env[name];
}

app.use(express.json());

app.use(express.static(__dirname));


const MONGODB_URI = env("MONGODB_URI");
let playersCol = null;

async function connectDB() {
  if (!MONGODB_URI) {
    console.error("⚠️  Falta la variable de entorno MONGODB_URI. Configurala en Render → Environment.");
    return;
  }
  const client = new MongoClient(MONGODB_URI, {
    family: 4 
  });
  await client.connect();
  const db = client.db(); 
  playersCol = db.collection("players");
  await playersCol.createIndex({ ticket: 1 }, { unique: true });
  await playersCol.createIndex({ steamId64: 1 }, { unique: true });
  console.log("✅ Conectado a MongoDB Atlas");
}

function findByTicket(ticket) {
  return playersCol.findOne({ ticket });
}

function findBySteamId(steamId64) {
  return playersCol.findOne({ steamId64 });
}

const ADMIN_AUTH_CODE = env("ADMIN_AUTH_CODE") || "9912938414112";

function requireAdmin(req, res, next) {
  const key = req.header("x-admin-key");
  if (key !== ADMIN_AUTH_CODE) {
    return res.status(401).json({ error: "No autorizado" });
  }
  next();
}

async function requireStaff(req, res, next) {
  const key = req.header("x-admin-key");
  if (key === ADMIN_AUTH_CODE) return next();

  const staffSteamId = req.header("x-staff-steamid");
  if (staffSteamId) {
    try {
      const player = await findBySteamId(staffSteamId);
      if (player && player.verified && (player.role === "STAFF" || player.role === "ADMIN")) {
        return next();
      }
    } catch (err) {
      console.error("Error verificando rol STAFF:", err);
    }
  }
  return res.status(401).json({ error: "No autorizado" });
}

app.post("/api/register", async (req, res) => {
  try {
    const { steamId, steamId64, password, nickname } = req.body || {};
    const idJugador = steamId64 || steamId;
    if (!idJugador) {
      return res.status(400).json({ error: "Falta el SteamID64" });
    }

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

    const existing = await findBySteamId(idJugador);
    if (existing) {
      const oldTicket = existing.ticket;
      if (oldTicket !== ticket) {
        await playersCol.updateOne(
          { steamId64: idJugador },
          { $set: { ticket, updatedAt: now } }
        );
      } else {
        await playersCol.updateOne(
          { steamId64: idJugador },
          { $set: { updatedAt: now } }
        );
      }
    } else {
      await playersCol.insertOne({
        ticket,
        steamId64: idJugador,
        nickname: nickname || null,
        verified: false,
        role: "PLAYER",
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
      });
    }

    console.log("Nuevo registro:", { idJugador, nickname, ticket });
    res.json({ ok: true, ticket });
  } catch (error) {
    console.error("Error procesando /api/register:", error);
    res.status(500).json({ error: "Error interno registrando al jugador" });
  }
});

/* =========================================================
   PERFIL — usado por el "gate" de todas las páginas para
   saber si la cuenta ya está verificada, y por el front-end
   para saber si tiene rol STAFF (y mostrarle el Menú Admin).
========================================================= */
app.get("/api/profile", async (req, res) => {
  const steamId64 = req.query.steamId64;
  if (!steamId64) return res.status(400).json({ error: "Falta steamId64" });

  const player = await findBySteamId(steamId64);
  if (!player) {
    return res.status(404).json({ error: "No encontrado" });
  }

  res.json({
    steamId64: player.steamId64,
    name: player.verified ? (player.nickname || player.name) : player.name,
    avatarUrl: "nexus-logo.png",
    nationality: player.nationality || "—",
    verified: !!player.verified,
    role: player.role && player.role !== "PLAYER" ? player.role : null,
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
app.get("/api/chat/:ticket/messages", async (req, res) => {
  const player = await findByTicket(req.params.ticket);
  if (!player) return res.status(404).json({ error: "Ticket no encontrado" });
  res.json({ messages: player.messages, verified: player.verified });
});

app.post("/api/chat/:ticket/messages", async (req, res) => {
  const player = await findByTicket(req.params.ticket);
  if (!player) return res.status(404).json({ error: "Ticket no encontrado" });

  const { text, steamId64 } = req.body || {};
  if (!text || !text.trim()) return res.status(400).json({ error: "Mensaje vacío" });
  if (steamId64 && steamId64 !== player.steamId64) {
    return res.status(403).json({ error: "SteamID64 no coincide con el ticket" });
  }

  const msg = { from: "player", text: text.trim(), at: new Date().toISOString() };
  await playersCol.updateOne(
    { ticket: req.params.ticket },
    { $push: { messages: msg }, $set: { updatedAt: msg.at } }
  );
  res.json({ ok: true, message: msg });
});

/* =========================================================
   CHAT — LADO ADMIN / STAFF
   (requireStaff acepta el código maestro O un jugador
   verificado con role STAFF/ADMIN)
========================================================= */
app.get("/api/admin/players", requireStaff, async (req, res) => {
  const all = await playersCol.find({}).toArray();
  const list = all
    .sort((a, b) => new Date(b.updatedAt || b.createdAt) - new Date(a.updatedAt || a.createdAt))
    .map(p => {
      const last = p.messages[p.messages.length - 1];
      return {
        ticket: p.ticket,
        steamId64: p.steamId64,
        verified: p.verified,
        role: p.role || "PLAYER",
        displayName: p.verified ? (p.nickname || p.name) : ("Nº " + p.ticket),
        lastMessage: last ? last.text : "",
        lastMessageFrom: last ? last.from : "",
        updatedAt: p.updatedAt || p.createdAt
      };
    });
  res.json({ players: list });
});

app.get("/api/admin/players/:ticket", requireStaff, async (req, res) => {
  const player = await findByTicket(req.params.ticket);
  if (!player) return res.status(404).json({ error: "Ticket no encontrado" });
  res.json({ player });
});

app.post("/api/admin/players/:ticket/messages", requireStaff, async (req, res) => {
  const player = await findByTicket(req.params.ticket);
  if (!player) return res.status(404).json({ error: "Ticket no encontrado" });

  const { text, adminName } = req.body || {};
  if (!text || !text.trim()) return res.status(400).json({ error: "Mensaje vacío" });

  const msg = { from: "admin", by: adminName || "STAFF", text: text.trim(), at: new Date().toISOString() };
  await playersCol.updateOne(
    { ticket: req.params.ticket },
    { $push: { messages: msg }, $set: { updatedAt: msg.at } }
  );
  res.json({ ok: true, message: msg });
});

app.post("/api/admin/players/:ticket/verify", requireStaff, async (req, res) => {
  const player = await findByTicket(req.params.ticket);
  if (!player) return res.status(404).json({ error: "Ticket no encontrado" });

  const now = new Date().toISOString();
  const msg = { from: "system", text: "✅ Tu cuenta fue verificada por el STAFF.", at: now };
  await playersCol.updateOne(
    { ticket: req.params.ticket },
    { $push: { messages: msg }, $set: { verified: true, updatedAt: now } }
  );
  res.json({ ok: true });
});

/* =========================================================
   ROL — solo el código maestro puede ascender/descender a
   alguien de STAFF, para que un STAFF no pueda auto-ascenderse
   a ADMIN ni ascender a otros.
========================================================= */
app.post("/api/admin/players/:ticket/role", requireAdmin, async (req, res) => {
  const player = await findByTicket(req.params.ticket);
  if (!player) return res.status(404).json({ error: "Ticket no encontrado" });

  const { role } = req.body || {};
  const validRoles = ["PLAYER", "STAFF", "ADMIN"];
  if (!validRoles.includes(role)) {
    return res.status(400).json({ error: "Rol inválido. Usá PLAYER, STAFF o ADMIN." });
  }

  await playersCol.updateOne(
    { ticket: req.params.ticket },
    { $set: { role, updatedAt: new Date().toISOString() } }
  );
  res.json({ ok: true, role });
});

const PORT = process.env.PORT || 3000;

connectDB()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`Servidor escuchando en el puerto ${PORT}`);
    });
  })
  .catch((err) => {
    console.error("❌ No se pudo conectar a MongoDB, el servidor no va a arrancar:", err);
    process.exit(1);
  });
