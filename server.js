import express from "express";
import cors from "cors";
import { v4 as uuidv4 } from "uuid";

// ---- конфиг ----
const PORT = process.env.PORT || 3000;
const WC_PROJECT_ID = process.env.WC_PROJECT_ID; // <— сложи го в Render env
const FRONTEND_URL = process.env.FRONTEND_URL || "https://www.3dhome4u.com"; // домейнът на сайта ти
const RELAY_URL = process.env.RELAY_URL || "wss://relay.walletconnect.com";

if (!WC_PROJECT_ID) {
  console.error("[FATAL] Missing WC_PROJECT_ID env var");
  process.exit(1);
}

const app = express();
app.use(cors({ origin: [FRONTEND_URL, "http://localhost:3000", "http://localhost:5173", "https://wc-backend-tpug.onrender.com"], credentials: true }));
app.use(express.json());

// ---- WalletConnect SignClient (lazy init) ----
let signClient = null;
async function getSignClient() {
  if (signClient) return signClient;
  let SignClient;
  const mod = await import("@walletconnect/sign-client");
  SignClient = mod?.default || mod?.SignClient || mod;
  signClient = await SignClient.init({
    projectId: WC_PROJECT_ID,
    relayUrl: RELAY_URL,
    metadata: {
      name: "3DHome4U Login",
      description: "Login via WalletConnect / MetaMask",
      url: FRONTEND_URL, // трябва да е в allowlist в WalletConnect Cloud
      icons: ["https://raw.githubusercontent.com/walletconnect/walletconnect-assets/master/Icon/Blue%20(Default)/Icon.png"]
    }
  });
  return signClient;
}

// ---- in-memory store с TTL ----
const PENDING_TTL_MS = 2 * 60 * 1000; // 2 мин
/** Map<string, {createdAt:number, approval:Promise, session:null|object}> */
const pendings = new Map();

// почистване
setInterval(() => {
  const now = Date.now();
  for (const [id, row] of pendings) {
    if (now - row.createdAt > PENDING_TTL_MS) pendings.delete(id);
  }
}, 30_000);

// Health
app.get("/health", (_req, res) => {
  res.json({ ok: true, pending: pendings.size });
});

// Създай нов WalletConnect URI
app.get("/wc-uri", async (_req, res) => {
  try {
    const client = await getSignClient();

    const requiredNamespaces = {
      eip155: {
        methods: [
          "personal_sign",
          "eth_sign",
          "eth_signTypedData",
          "eth_signTypedData_v4",
          "eth_sendTransaction"
        ],
        chains: ["eip155:1", "eip155:137", "eip155:25", "eip155:338"],
        events: ["chainChanged", "accountsChanged"]
      }
    };

    const { uri, approval } = await client.connect({ requiredNamespaces });

    const id = uuidv4();
    const createdAt = Date.now();
    const row = { createdAt, approval, session: null };
    pendings.set(id, row);

    approval
      .then((session) => {
        const ns = session.namespaces?.eip155;
        // формат: "eip155:<chainId>:<address>"
        const first = ns?.accounts?.[0] || "";
        const [_, chainIdStr, address] = first.split(":");
        row.session = {
          topic: session.topic,
          addresses: (ns?.accounts || []).map(a => a.split(":")[2]),
          chains: ns?.chains || [],
          address: address || null,
          chainId: Number(chainIdStr || 0)
        };
      })
      .catch(() => { /* отказ в уолета—ще изтече по TTL */ });

    const expiresAt = new Date(createdAt + PENDING_TTL_MS).toISOString();
    res.json({ id, uri, expiresAt });
  } catch (e) {
    console.error("Failed to create wc uri:", e);
    res.status(500).json({ error: "Failed to create WalletConnect pairing" });
  }
});

// Провери статус
app.get("/wc-status", (req, res) => {
  const { id } = req.query;
  if (!id || !pendings.has(id)) return res.json({ status: "not_found" });

  const row = pendings.get(id);
  const expired = Date.now() - row.createdAt > PENDING_TTL_MS;

  if (row.session) return res.json({ status: "approved", ...row.session });
  if (expired) { pendings.delete(id); return res.json({ status: "expired" }); }
  return res.json({ status: "pending" });
});

// сервирай фронтенда (папка public)
app.use(express.static("public"));

const server = app.listen(PORT, () => {
  console.log(`Listening on :${PORT}`);
});

process.on("SIGINT", () => server.close(() => process.exit(0)));
process.on("SIGTERM", () => server.close(() => process.exit(0)));
