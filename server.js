import express from "express";
import cors from "cors";
import { v4 as uuidv4 } from "uuid";
import { createRequire } from "module";

const require = createRequire(import.meta.url);

// ── config ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
const WC_PROJECT_ID = (process.env.WC_PROJECT_ID || "").trim();
const RELAY_URL = process.env.RELAY_URL || "wss://relay.walletconnect.com";
const FRONTEND_URL = process.env.FRONTEND_URL || "https://wc-backend-tpug.onrender.com";
if (!WC_PROJECT_ID) { console.error("[FATAL] Missing WC_PROJECT_ID"); process.exit(1); }

// ── app ───────────────────────────────────────────────────────────────────────
const app = express();
app.use(cors({
  origin: [FRONTEND_URL, "https://wc-backend-tpug.onrender.com", "http://localhost:3000", "http://localhost:5173"]
}));
app.use(express.json());

// health
app.get("/health", (_req, res) => res.json({ ok: true, pending: pendings.size }));

// ── robust import of sign-client ──────────────────────────────────────────────
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
  SignClientFactory = async (opts) => {
    if (typeof Candidate.init === "function") return Candidate.init(opts);
    const instance = new Candidate(opts);
    if (!instance || typeof instance.connect !== "function")
      throw new Error("Constructed SignClient has no .connect()");
    return instance;
  };
  return SignClientFactory;
}

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

// ── in-memory store + TTL ────────────────────────────────────────────────────
const PENDING_TTL_MS = 10 * 60 * 1000;
const pendings = new Map();
setInterval(() => {
  const now = Date.now();
  for (const [id, row] of pendings)
    if (now - row.createdAt > PENDING_TTL_MS) pendings.delete(id);
}, 60_000);

// ── helpers ──────────────────────────────────────────────────────────────────
function toApprovalPromise(x) {
  try {
    if (typeof x === "function") { const r = x(); return r && r.then ? r : Promise.resolve(r); }
    if (x && x.then) return x;
    return new Promise(() => {}); // never resolves
  } catch (e) { return Promise.reject(e); }
}
function chainIdToName(id) {
  const map = {
    1: "Ethereum Mainnet",
    56: "BNB Chain",
    97: "BNB Testnet",
    137: "Polygon",
    59144: "Linea",
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
function pickBest(ns, preferredOrder = [137, 56, 1]) {
  const accounts = Array.isArray(ns?.accounts) ? ns.accounts.map(parseAccount) : [];
  const connected = new Set((ns?.chains || []).map(c => Number(String(c).split(":")[1] || 0)));
  const byChain = new Map();
  for (const a of accounts) if (a.chainId && a.address && !byChain.has(a.chainId)) byChain.set(a.chainId, a.address);
  let chosen = preferredOrder.find(cid => connected.has(cid) && byChain.has(cid));
  if (!chosen) chosen = [...connected][0] || (accounts[0]?.chainId || 0);
  const address = byChain.get(chosen) || (accounts[0]?.address || "");
  return { chainId: chosen, address, allAddresses: accounts.map(a => a.address) };
}

// ── API: wc-uri ──────────────────────────────────────────────────────────────
app.get("/wc-uri", async (_req, res) => {
  try {
    const client = await getSignClient();

    // МИНИМАЛЕН namespace: без events (за да не гърми валидаторът)
    const requiredNamespaces = {
      eip155: {
        methods: ["personal_sign"],
        chains: ["eip155:137", "eip155:56", "eip155:1"],
        events: [] // <- важно
      }
    };

    const { uri, approval } = await client.connect({ requiredNamespaces });

    const id = uuidv4();
    const createdAt = Date.now();
    const row = { createdAt, approval: null, session: null };
    pendings.set(id, row);

    const approvalPromise = toApprovalPromise(approval);
    row.approval = approvalPromise;

    approvalPromise.then((session) => {
      const ns = session?.namespaces?.eip155;
      const picked = pickBest(ns, [137, 56, 1]);
      row.session = {
        topic: session.topic,
        addresses: picked.allAddresses,
        chains: ns?.chains || [],
        address: picked.address || null,
        chainId: picked.chainId,
        networkName: chainIdToName(picked.chainId)
      };
      console.log("[WC APPROVED]", session.topic, "chains=", ns?.chains, "picked=", picked);
    }).catch(e => console.warn("[WC APPROVAL REJECTED]", e?.message || e));

    res.json({ id, uri, expiresAt: new Date(createdAt + PENDING_TTL_MS).toISOString() });
  } catch (e) {
    console.error("[WC CONNECT ERROR]", e?.message || e);
    res.status(500).json({ error: e?.message || String(e) });
  }
});

// ── API: wc-status ───────────────────────────────────────────────────────────
app.get("/wc-status", async (req, res) => {
  const { id } = req.query;
  if (id && pendings.has(id)) {
    const row = pendings.get(id);
    const expired = Date.now() - row.createdAt > PENDING_TTL_MS;
    if (row.session) return res.json({ status: "approved", ...row.session });
    if (expired) { pendings.delete(id); return res.json({ status: "expired" }); }
    return res.json({ status: "pending" });
  }
  // fallback след рестарт
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
  } catch {}
  return res.json({ status: "not_found" });
});

// ── static ───────────────────────────────────────────────────────────────────
app.use(express.static("public"));

// ── start + guards ───────────────────────────────────────────────────────────
const server = app.listen(PORT, () => {
  console.log(`Listening on :${PORT}`);
  console.log(`[BOOT] WC_PROJECT_ID length=${WC_PROJECT_ID.length}, preview=${WC_PROJECT_ID.slice(0,3)}...${WC_PROJECT_ID.slice(-3)}`);
});

// не позволявай на process да умира от непоети грешки
process.on("unhandledRejection", (e) => console.warn("[UNHANDLED REJECTION]", e?.message || e));
process.on("uncaughtException",  (e) => console.warn("[UNCAUGHT EXCEPTION]", e?.message || e));
process.on("SIGINT",  () => server.close(() => process.exit(0)));
process.on("SIGTERM", () => server.close(() => process.exit(0)));
