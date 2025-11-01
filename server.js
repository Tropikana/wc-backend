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

  // единна фабрика
  SignClientFactory = async (opts) => {
    if (typeof Candidate.init === "function") return Candidate.init(opts);
    const instance = new Candidate(opts);
    if (!instance || typeof instance.connect !== "function")
      throw new Error("Constructed SignClient has no .connect()");
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
      url: "https://wc-backend-tpug.onrender.com",
      icons: ["https://raw.githubusercontent.com/walletconnect/walletconnect-assets/master/Icon/Blue%20(Default)/Icon.png"]
    }
  });
  return signClient;
}

// ── in-memory store + TTL ─────────────────────────────────────────────────────
const PENDING_TTL_MS = 10 * 60 * 1000; // 10 мин
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
    return new Promise(() => {}); // никога не резолвва
  } catch (e) {
    return Promise.reject(e);
  }
}
function chainIdToName(id) {
  const map = {
    1: "Ethereum Mainnet",
    56: "BNB Chain",
    137: "Polygon",
    25: "Cronos",
    338: "Cronos Testnet",
    42161: "Arbitrum One",
    43114: "Avalanche C-Chain"
  };
  return map[id] || `eip155:${id}`;
}
function parseAccount(ac) {
  const [ns, cid, addr] = String(ac || "").split(":");
  return { ns, chainId: Number(cid || 0), address: addr || "" };
}
// избира адрес по предпочитан ред, но само сред **наистина свързаните** chain-ове
function pickBest(ns, preferredOrder = [137, 56, 1]) {
  const accounts = Array.isArray(ns?.accounts) ? ns.accounts.map(parseAccount) : [];
  const connected = new Set(
    (ns?.chains || []).map(c => Number(String(c).split(":")[1] || 0))
  );
  const byChain = new Map(); // chainId -> first address
  for (const a of accounts) if (a.chainId && a.address && !byChain.has(a.chainId)) byChain.set(a.chainId, a.address);

  let chosen = preferredOrder.find(cid => connected.has(cid) && byChain.has(cid));
  if (!chosen) chosen = [...connected][0] || (accounts[0]?.chainId || 0);
  const address = byChain.get(chosen) || (accounts[0]?.address || "");
  return { chainId: chosen, address, allAddresses: accounts.map(a => a.address) };
}

// ── API: създай WalletConnect pairing ─────────────────────────────────────────
app.get("/wc-uri", async (_req, res) => {
  try {
    const client = await getSignClient();

    // минимално; искане за Polygon, BNB, Ethereum
    const requiredNamespaces = {
      eip155: {
        methods: ["personal_sign"],
        chains: ["eip155:137", "eip155:56", "eip155:1"],
        events: ["accountsChanged", "chainChanged"]
      }
    };

    const connectRes = await client.connect({ requiredNamespaces });
    const wcUri = connectRes.uri;
    const approvalRaw = connectRes.approval;

    const id = uuidv4();
    const createdAt = Date.now();
    const row = { createdAt, approval: null, session: null };
    pendings.set(id, row);

    const approvalPromise = toApprovalPromise(approvalRaw);
    row.approval = approvalPromise;

    approvalPromise.then((session) => {
      try {
        const ns = session?.namespaces?.eip155;
        const picked = pickBest(ns, [137, 56, 1]); // Polygon → BNB → ETH
        row.session = {
          topic: session.topic,
          addresses: picked.allAddresses,
          chains: ns?.chains || [],
          address: picked.address || null,
          chainId: picked.chainId,
          networkName: chainIdToName(picked.chainId)
        };
        console.log("[WC APPROVED]", session.topic, "chains=", ns?.chains, "picked=", picked);
      } catch (e) {
        console.warn("[WC APPROVED PARSE ERROR]", e?.message || e);
      }
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

  if (id && pendings.has(id)) {
    const row = pendings.get(id);
    const expired = Date.now() - row.createdAt > PENDING_TTL_MS;
    if (row.session) return res.json({ status: "approved", ...row.session });
    if (expired) { pendings.delete(id); return res.json({ status: "expired" }); }
    return res.json({ status: "pending" });
  }

  // fallback след рестарт: върни първата активна сесия
  try {
    const client = await getSignClient();
    const all = client?.session?.getAll ? client.session.getAll() : [];
    if (Array.isArray(all) && all.length > 0) {
      const s = all[0];
      const ns = s.namespaces?.eip155;
      const picked = pickBest(ns, [137, 56, 1]);
      return res.json({
        status: "approved",
        topic: s.topic,
        addresses: picked.allAddresses,
        chains: ns?.chains || [],
        address: picked.address || null,
        chainId: picked.chainId,
        networkName: chainIdToName(picked.chainId)
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
