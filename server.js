import express from "express";
import cors from "cors";
import { v4 as uuidv4 } from "uuid";

const PORT = process.env.PORT || 3000;
const WC_PROJECT_ID = (process.env.WC_PROJECT_ID || "").trim();
const FRONTEND_URL = process.env.FRONTEND_URL || "https://wc-backend-tpug.onrender.com";
const RELAY_URL = process.env.RELAY_URL || "wss://relay.walletconnect.com";

if (!WC_PROJECT_ID) {
  console.error("[FATAL] Missing WC_PROJECT_ID env var");
  process.exit(1);
}

const app = express();
app.use(cors({
  origin: [FRONTEND_URL, "https://wc-backend-tpug.onrender.com", "http://localhost:3000", "http://localhost:5173"],
}));

// health & env debug (safe)
app.get("/health", (_req, res) => res.json({ ok: true, pending: pendings.size }));
app.get("/env", (_req, res) => {
  res.json({
    frontendUrl: FRONTEND_URL,
    relayUrl: RELAY_URL,
    wcProjectId_len: WC_PROJECT_ID.length, // трябва да е 32
    wcProjectId_preview: WC_PROJECT_ID.slice(0, 3) + "..." + WC_PROJECT_ID.slice(-3) // не изтичаме целия
  });
});

// ---- WalletConnect SignClient (lazy init) ----
let signClient = null;
async function getSignClient() {
  if (signClient) return signClient;
  const mod = await import("@walletconnect/sign-client");
  const SignClient = mod?.default || mod?.SignClient || mod;
  try {
    signClient = await SignClient.init({
      projectId: WC_PROJECT_ID,
      relayUrl: RELAY_URL,
      metadata: {
        name: "3DHome4U Login",
        description: "Login via WalletConnect / MetaMask",
        // ВАЖНО: това трябва да е домейн в Allowlist
        url: "https://wc-backend-tpug.onrender.com",
        icons: ["https://raw.githubusercontent.com/walletconnect/walletconnect-assets/master/Icon/Blue%20(Default)/Icon.png"]
      }
    });
  } catch (e) {
    console.error("[WC INIT ERROR]", e?.message || e);
    throw e;
  }
  return signClient;
}

// ---- in-memory store с TTL ----
const PENDING_TTL_MS = 2 * 60 * 1000;
const pendings = new Map();
setInterval(() => {
  const now = Date.now();
  for (const [id, row] of pendings) if (now - row.createdAt > PENDING_TTL_MS) pendings.delete(id);
}, 30_000);

// Създай нов WalletConnect URI
app.get("/wc-uri", async (_req, res) => {
  try {
    const client = await getSignClient();
    const requiredNamespaces = {
      eip155: {
        methods: ["personal_sign", "eth_sign", "eth_signTypedData", "eth_signTypedData_v4", "eth_sendTransaction"],
        chains: ["eip155:1", "eip155:137", "eip155:25", "eip155:338"],
        events: ["chainChanged", "accountsChanged"]
      }
    };
    const { uri, approval } = await client.connect({ requiredNamespaces });

    const id = uuidv4();
    const createdAt = Date.now();
    const row = { createdAt, approval, session: null };
    pendings.set(id, row);

    approval.then((session) => {
      const ns = session.namespaces?.eip155;
      const first = ns?.accounts?.[0] || "";
      const [_, chainIdStr, address] = first.split(":");
      row.session = {
        topic: session.topic,
        addresses: (ns?.accounts || []).map(a => a.split(":")[2]),
        chains: ns?.chains || [],
        address: address || null,
        chainId: Number(chainIdStr || 0)
      };
    }).catch(() => { /* отказ в уолета */ });

    const expiresAt = new Date(createdAt + PENDING_TTL_MS).toISOString();
    res.json({ id, uri, expiresAt });
  } catch (e) {
    console.error("[WC CONNECT ERROR]", e?.message || e);
    res.status(500).json({ error: e?.message || String(e) });
  }
});

// статичен фронт
app.use(express.static("public"));

const server = app.listen(PORT, () => {
  console.log(`Listening on :${PORT}`);
  console.log(`[BOOT] WC_PROJECT_ID length=${WC_PROJECT_ID.length}, preview=${WC_PROJECT_ID.slice(0,3)}...${WC_PROJECT_ID.slice(-3)}`);
});

process.on("SIGINT", () => server.close(() => process.exit(0)));
process.on("SIGTERM", () => server.close(() => process.exit(0)));
