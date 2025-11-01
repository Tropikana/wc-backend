import express from "express";
import cors from "cors";
import { v4 as uuidv4 } from "uuid";
import { createRequire } from "module";

const require = createRequire(import.meta.url);

// ── конфигурация ───────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
const WC_PROJECT_ID = (process.env.WC_PROJECT_ID || "").trim();
const RELAY_URL = process.env.RELAY_URL || "wss://relay.walletconnect.com";
const FRONTEND_URL = process.env.FRONTEND_URL || "https://wc-backend-tpug.onrender.com";
if (!WC_PROJECT_ID) { console.error("[FATAL] Missing WC_PROJECT_ID"); process.exit(1); }

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
    wcProjectId_len: WC_PROJECT_ID.length,
    wcProjectId_preview: WC_PROJECT_ID ? (WC_PROJECT_ID.slice(0,3)+"..."+WC_PROJECT_ID.slice(-3)) : ""
  });
});

// ── robust импорт на @walletconnect/sign-client ────────────────────────────────
let SignClientFactory = null;
async function loadSignClient() {
  if (SignClientFactory) return SignClientFactory;

  let mod = null, mode = "esm";
  try { mod = await import("@walletconnect/sign-client"); }
  catch { mode = "cjs"; mod = require("@walletconnect/sign-client"); }
  console.log("[WC IMPORT] mode=", mode, "keys=", Object.keys(mod || {}));

  const Candidate =
    mod?.default?.init ? mod.default :
    mod?.SignClient?.init ? mod.SignClient :
    (typeof mod?.default === "function" ? mod.default :
     typeof mod?.SignClient === "function" ? mod.SignClient : null);

  if (!Candidate) throw new Error("WalletConnect SignClient export not recognized");

  // Единна фабрика – връща инстанция независимо дали е static init или constructor
  SignClientFactory = async (opts) => {
    if (typeof Candidate.init === "function") return Candidate.init(opts);
    const instance = new Candidate(opts);
    if (!instance || typeof instance.connect !== "function") throw new Error("Constructed SignClient has no .connect()");
    return instance;
  };
  return SignClientFactory;
}

// ── WalletConnect клиент (lazy init) ───────────────────────────────────────────
let signClient = null;
async function getSignClient() {
  if (signClient) return signClient;
  const create = await loadSignClient();
  signClient = await create({
    projectId: WC_PROJECT_ID,
    relayUrl: RELAY_URL,
    metadata: {
      name: "3DHome4U Login",
      description: "Login via WalletConnect / MetaMask",
      url: "https://wc-backend-tpug.onrender.com", // домейн от Allowlist
      icons: ["https://raw.githubusercontent.com/walletconnect/walletconnect-assets/master/Icon/Blue%20(Default)/Icon.png"]
    }
  });
  return signClient;
}

// ── in-memory store + TTL ─────────────────────────────────────────────────────
const PENDING_TTL_MS = 10 * 60 * 1000; // 10 мин за по-устойчиво поведение
const pendings = new Map();
setInterval(() => {
  const now = Date.now();
  for (const [id, row] of pendings) if (now - row.createdAt > PENDING_TTL_MS) pendings.delete(id);
}, 60_000);

// ── помощници ─────────────────────────────────────────────────────────────────
function toApprovalPromise(maybeFnOrPromise) {
  try {
    if (typeof maybeFnOrPromise === "function") {
      const ret = maybeFnOrPromise();
      return (ret && typeof ret.then === "function") ? ret : Promise.resolve(ret);
    }
    if (maybeFnOrPromise && typeof maybeFnOrPromise.then === "function") {
      return maybeFnOrPromise;
    }
    return new Promise(() => {}); // never resolves
  } catch (e) {
    return Promise.reject(e);
  }
}

function chainIdToName(id) {
  const map = {
    1: "Ethereum Mainnet",
    5: "Goerli (deprecated)",
    10: "Optimism",
    25: "Cronos",
    56: "BNB Chain",
    137: "Polygon",
    338: "Cronos Testnet",
    42161: "Arbitrum One",
    43114: "Avalanche C-Chain"
  };
  return map[id] || `eip155:${id}`;
}

// ── API: създай WalletConnect pairing ─────────────────────────────────────────
app.get("/wc-uri", async (_req, res) => {
  try {
    const client = await getSignClient();

    // Минимално изискан chain – ETH mainnet; останалите са optional
    const requiredNamespaces = {
      eip155: {
        methods: ["personal_sign","eth_sign","eth_signTypedData","eth_signTypedData_v4","eth_sendTransaction"],
        chains: ["eip155:1"],
        events: ["chainChanged","accountsChanged"]
      }
    };
    const optionalNamespaces = {
      eip155: {
        chains: ["eip155:137","eip155:25","eip155:338"],
        methods: ["personal_sign","eth_sign","eth_signTypedData","eth_signTypedData_v4","eth_sendTransaction"],
        events: ["chainChanged","accountsChanged"]
      }
    };

    const connectRes = await client.connect({ requiredNamespaces, optionalNamespaces });
    const wcUri = connectRes.uri;
    const approvalRaw = connectRes.approval;

    const id = uuidv4();
    const createdAt = Date.now();
    const row = { createdAt, approval: null, session: null };
    pendings.set(id, row);

    const approvalPromise = toApprovalPromise(approvalRaw);
    row.approval = approvalPromise;

    approvalPromise.then((session) => {
      const ns = session?.namespaces?.eip155;
      const first = ns?.accounts?.[0] || "";
      const [_, chainIdStr, address] = first.split(":");
      const chainId = Number(chainIdStr || 0);
      console.log("[WC APPROVED]", session.topic, ns?.accounts);
      row.session = {
        topic: session.topic,
        addresses: (ns?.accounts || []).map(a => a.split(":")[2]),
        chains: ns?.chains || [],
        address: address || null,
        chainId,
        networkName: chainIdToName(chainId)
      };
    }).catch((e) => {
      console.warn("[WC APPROVAL REJECTED]", e?.message || e);
    });

    const expiresAt = new Date(createdAt + PENDING_TTL_MS).toISOString();
    res.json({ id, uri: wcUri, expiresAt });
  } catch (e) {
    console.error("[WC CONNECT ERROR]", e?.message || e);
    res.status(500).json({ error: e?.message || String(e) });
  }
});

// ── API: провери статус ───────────────────────────────────────────────────────
app.get("/wc-status", async (req, res) => {
  const { id } = req.query;

  // Нормален път – имаме pending запис
  if (id && pendings.has(id)) {
    const row = pendings.get(id);
    const expired = Date.now() - row.createdAt > PENDING_TTL_MS;
    if (row.session) return res.json({ status: "approved", ...row.session });
    if (expired) { pendings.delete(id); return res.json({ status: "expired" }); }
    return res.json({ status: "pending" });
  }

  // Fallback: няма такъв id → опитай да върнеш активна сесия от SignClient
  try {
    const client = await getSignClient();
    const all = client?.session?.getAll ? client.session.getAll() : [];
    if (Array.isArray(all) && all.length > 0) {
      const s = all[0];
      const ns = s.namespaces?.eip155;
      const first = ns?.accounts?.[0] || "";
      const [__, chainIdStr, address] = first.split(":");
      const chainId = Number(chainIdStr || 0);
      return res.json({
        status: "approved",
        topic: s.topic,
        addresses: (ns?.accounts || []).map(a => a.split(":")[2]),
        chains: ns?.chains || [],
        address: address || null,
        chainId,
        networkName: chainIdToName(chainId)
      });
    }
  } catch (_) { /* ignore */ }

  return res.json({ status: "not_found" });
});

// ── статични файлове ───────────────────────────────────────────────────────────
app.use(express.static("public"));

// ── старт ─────────────────────────────────────────────────────────────────────
const server = app.listen(PORT, () => {
  console.log(`Listening on :${PORT}`);
  console.log(`[BOOT] WC_PROJECT_ID length=${WC_PROJECT_ID.length}, preview=${WC_PROJECT_ID.slice(0,3)}...${WC_PROJECT_ID.slice(-3)}`);
});
process.on("SIGINT", () => server.close(() => process.exit(0)));
process.on("SIGTERM", () => server.close(() => process.exit(0)));
