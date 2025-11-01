// server.js
import express from "express";
import cors from "cors";
import path from "path";
import { fileURLToPath } from "url";
import UniversalProvider from "@walletconnect/universal-provider";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

// ====== CONFIG ======
const PORT = process.env.PORT || 10000;
const WC_PROJECT_ID = process.env.WC_PROJECT_ID || ""; // <-- сложи си го в Render
const CORS_ORIGINS = (process.env.CORS_ORIGINS || "*")
  .split(",")
  .map(s => s.trim())
  .filter(Boolean);

// ====== MIDDLEWARE ======
app.use(cors({
  origin: CORS_ORIGINS.length ? CORS_ORIGINS : "*"
}));
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// ====== WALLETCONNECT SINGLETON ======
let provider = null;
let coreInitWarningShown = false;

// „mutex“ за да няма паралелни /wc-uri
let generating = false;

// Създаваме/връщаме единствен provider
async function getProvider() {
  if (provider) return provider;

  if (!WC_PROJECT_ID) {
    throw new Error("Missing WC_PROJECT_ID env var");
  }

  provider = await UniversalProvider.init({
    projectId: WC_PROJECT_ID,
    metadata: {
      name: "WC Login Demo",
      description: "Login with WalletConnect / MetaMask",
      url: "https://example.org",
      icons: ["https://avatars.githubusercontent.com/u/37784886?s=200&v=4"]
    }
  });

  // Диагностика – показваме предупреждението само веднъж
  if (!coreInitWarningShown) {
    try {
      // @walletconnect/core показва предупреждение ако се извика повече от веднъж;
      // Ние сме в единствения init – просто логваме, че е готов.
      console.log("[WC] UniversalProvider initialized");
    } finally {
      coreInitWarningShown = true;
    }
  }

  return provider;
}

// Затваряме стари pairings (ако има), за да не „висят“
async function cleanupOldPairings(client) {
  try {
    const pairings = client?.core?.pairing?.pairings || [];
    for (const p of pairings) {
      if (!p.active) {
        await client.core.pairing.delete({ topic: p.topic, reason: { code: 7000, message: "cleanup" } });
      }
    }
  } catch (e) {
    console.warn("[WC] cleanupOldPairings warn:", e.message);
  }
}

// ====== ROUTES ======

// Здраве
app.get("/health", (_, res) => res.json({ ok: true }));

// Генерира pairing URI (едновременно само 1)
app.get("/wc-uri", async (req, res) => {
  if (generating) {
    return res.status(429).json({ ok: false, error: "busy" });
  }
  generating = true;

  // safety unlock след 15 секунди
  const unlock = setTimeout(() => { generating = false; }, 15000);

  try {
    const p = await getProvider();
    const client = p.client;

    // чистим стари
    await cleanupOldPairings(client);

    // Създаваме нов pairing (URI + topic)
    const { uri, topic } = await client.core.pairing.create({});
    if (!uri || !topic) {
      throw new Error("pairing.create() returned empty uri/topic");
    }

    // Връщаме на фронтенда за QR
    return res.json({ ok: true, uri, topic });
  } catch (err) {
    console.error("[/wc-uri] ERROR:", err);
    return res.status(500).json({ ok: false, error: err.message || "server_error" });
  } finally {
    clearTimeout(unlock);
    generating = false;
  }
});

// Опционално: показвай index.html
app.get("/", (_, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// ====== START ======
app.listen(PORT, () => {
  console.log(`Listening on :${PORT}`);
  console.log(`==> Available at your primary URL https://wc-backend-tpug.onrender.com`);
});
