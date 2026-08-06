const express = require('express');
const path = require('path');
const app = express();

function env(name) {
  return process.env[name];
}

app.use(express.json());

// Sirve los archivos estáticos (index.html, css, js, etc.) que estén
// en la raíz del repo, al lado de este archivo.
app.use(express.static(__dirname));

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
    if (!botTicketUrl || !botApiKey) {
      console.error("Falta configurar BOT_TICKET_URL / BOT_API_KEY en las variables de entorno");
      return res.status(500).json({ error: "El sistema de tickets no está configurado" });
    }

    const ticketResp = await fetch(botTicketUrl, {
      headers: { "x-api-key": botApiKey }
    });

    if (!ticketResp.ok) {
      const detalle = await ticketResp.text().catch(() => "");
      console.error("El bot rechazó la solicitud de ticket:", ticketResp.status, detalle);
      return res.status(502).json({ error: "No se pudo generar el ticket" });
    }

    const { ticket } = await ticketResp.json();
    if (!ticket) {
      return res.status(502).json({ error: "El bot no devolvió un ticket válido" });
    }

    console.log("Nuevo registro:", { idJugador, nickname, ticket });
    res.json({ ok: true, ticket });
  } catch (error) {
    console.error("Error procesando /api/register:", error);
    res.status(500).json({ error: "Error interno registrando al jugador" });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Servidor escuchando en el puerto ${PORT}`);
});
