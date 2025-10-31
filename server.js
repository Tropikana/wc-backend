import express from "express";
import cors from "cors";
import { v4 as uuidv4 } from "uuid";
import SignClient from "@walletconnect/sign-client"; // ✅ статичен ESM импорт

// ── конфигурация ───────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
const WC_PROJECT_ID = (process.env.WC_PROJECT_ID || "").trim(); // 32 символа
const RELAY_URL = process.env.RELAY_URL || "wss://relay.walletconnect.com";
// домейнът, от който реално отваряш страницата (трябва да е в Allowlist)
const FRONTEND_URL = process.env.FRONTEND_URL || "https://wc-backend-tpug.onrender.com";

if (!WC_PROJECT_ID) {
  console.error("[FATAL] Missing WC_PROJECT_ID env var");
  process.exit(1);
}

// ── app ────────────────────────────────────────────────────────────────────────
const app = express();
app.use(cors({
  origin: [FRONTEND_URL, "https://wc-backend-tpug.onrender.com", "http://localhost:3000", "http://localhost:5173"]
}));
app.use(express.json());

// диагностика
app.get("/health", (_req, res) => res.json({ ok: true, pending: pendings.size }));
app.get("/env", (_req, res) => {
  res.json({
    frontendUrl: FRONTEND_URL,
    relayUrl: RELAY_URL,
    wcProjectId_len: WC_PROJECT_ID.length, // трябва да е 32
    wcProjectId_preview: WC_PROJECT_ID ? (WC_PROJECT_ID.slice(0,3) + "..." + WC_PROJECT_ID.slice(-3)) : ""
  });
});

// ── WalletConnect SignClient (lazy init) ───────────────────────────────────────
let signClient = null;
async function getSignClient() {
  if (signClient) return signClient;
  try {
    signClient = await SignClient.init({
      projectId: WC_PROJECT_ID,
      relayUrl: RELAY_URL,
      metadata: {
        name: "3DHome4U Login",
        description: "Login via WalletConnect / MetaMask",
        // ТРЯБВА да е домейн от Allowlist в Reown/WalletConnect Cloud
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

// ── pending store с TTL ────────────────────────────────────────────────────────
const PENDING_TTL_MS = 2 * 60 * 1000; // 2 минути
/** @type {Map<string, {createdAt:number, approval:Promise<any>, session:any|null}>} */
const pendings = new Map();

setInterval(() => {
  const now = Date.now();
  for (const [id, row] of pendings) {
    if (now - row.createdAt > PENDING_TTL_MS) pendings.delete(id);
  }
}, 30_000);

// ── API: създай WalletConnect pairing ─────────────────────────────────────────
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
      .catch(() => { /* отказ в уолета — оставяме да изтече по TTL */ });

    const expiresAt = new Date(createdAt + PENDING_TTL_MS).toISOString();
    res.json({ id, uri, expiresAt });
  } catch (e) {
    console.error("[WC CONNECT ERROR]", e?.message || e);
    res.status(500).json({ error: e?.message || String(e) });
  }
});

// ── API: провери статус ───────────────────────────────────────────────────────
app.get("/wc-status", (req, res) => {
  const { id } = req.query;
  if (!id || !pendings.has(id)) return res.json({ status: "not_found" });

  const row = pendings.get(id);
  const expired = Date.now() - row.createdAt > PENDING_TTL_MS;

  if (row.session) return res.json({ status: "approved", ...row.session });
  if (expired) { pendings.delete(id); return res.json({ status: "expired" }); }
  return res.json({ status: "pending" });
});

// ── статични файлове (папка public/) ──────────────────────────────────────────
app.use(express.static("public"));

// ── старт ─────────────────────────────────────────────────────────────────────
const server = app.listen(PORT, () => {
  console.log(`Listening on :${PORT}`);
  console.log(`[BOOT] WC_PROJECT_ID length=${WC_PROJECT_ID.length}, preview=${WC_PROJECT_ID.slice(0,3)}...${WC_PROJECT_ID.slice(-3)}`);
});
process.on("SIGINT", () => server.close(() => process.exit(0)));
process.on("SIGTERM", () => server.close(() => process.exit(0)));
