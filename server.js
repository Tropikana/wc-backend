// server.js
import express from "express";
import cors from "cors";
import { v4 as uuidv4 } from "uuid";
import { createRequire } from "module";
import path from "path";
import { fileURLToPath } from "url";

const require = createRequire(import.meta.url);

const PORT = process.env.PORT || 3000;
const WC_PROJECT_ID = (process.env.WC_PROJECT_ID || "").trim();
const RELAY_URL = process.env.RELAY_URL || "wss://relay.walletconnect.com";
if (!WC_PROJECT_ID) {
  console.error("[FATAL] Missing WC_PROJECT_ID");
  process.exit(1);
}

const app = express();

// CORS allowlist
const ALLOWLIST = new Set([
  "https://wc-backend-tpug.onrender.com",
  "https://www.3dhome4u.com",
  "https://3dhome4u.com", // добавено за без www
]);
app.use(
  cors({
    origin: (origin, cb) => {
      if (!origin) return cb(null, true); // UE/Server-side без Origin
      if (ALLOWLIST.has(origin)) return cb(null, true);
      return cb(new Error("Not allowed by CORS"));
    },
    credentials: true,
  })
);
app.use(express.json());

// ------- WalletConnect Sign Client (robust import) -------
let SignClientFactory = null;
async function loadSignClient() {
  if (SignClientFactory) return SignClientFactory;
  let mod = null;
  try { mod = await import("@walletconnect/sign-client"); }
  catch { mod = require("@walletconnect/sign-client"); }

  const Candidate =
    mod?.default?.init ? mod.default :
    mod?.SignClient?.init ? mod.SignClient :
    typeof mod?.default === "function" ? mod.default :
    typeof mod?.SignClient === "function" ? mod.SignClient : null;

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
      icons: [
        "https://raw.githubusercontent.com/walletconnect/walletconnect-assets/master/Icon/Blue%20(Default)/Icon.png",
      ],
    },
  });

  // при смяна на мрежа -> обнови кеша
  signClient.on("session_update", ({ topic, params }) => {
    const ns = params?.namespaces?.eip155;
    if (!ns) return;
    for (const [, row] of pendings) {
      if (row.session?.topic === topic) {
        const picked = pickPreferred(ns, row.preferredChainRef);
        row.session = {
          ...row.session,
          addresses: (ns.accounts || []).map((a) => parseAccount(a).address),
          chains: ns.chains || [],
          address: picked.address || null,
          chainId: picked.chainId,
          networkName: chainIdToName(picked.chainId),
          selectedChainRef: picked.chainRef,
        };
      }
    }
  });

  return signClient;
}

// ------- helpers / state -------
const PENDING_TTL_MS = 10 * 60 * 1000;
const pendings = new Map();
setInterval(() => {
  const now = Date.now();
  for (const [id, row] of pendings)
    if (now - row.createdAt > PENDING_TTL_MS) pendings.delete(id);
}, 60_000);

const EIP155_NAMES = {
  1: "Ethereum Mainnet",
  56: "BNB Chain",
  97: "BNB Testnet",
  137: "Polygon",
  59144: "Linea",
  25: "Cronos",
  338: "Cronos Testnet",
  42161: "Arbitrum One",
  43114: "Avalanche C-Chain",
  8453: "Base",
};
const ALLOWED_CHAIN_REFS = new Set(
  Object.keys(EIP155_NAMES).map((id) => `eip155:${id}`)
);

function chainIdToName(id) { return EIP155_NAMES[id] || `eip155:${id}`; }
function parseAccount(ac) {
  const [ns, cid, addr] = String(ac || "").split(":");
  return { ns, chainId: Number(cid || 0), address: addr || "" };
}
function decToHexChainId(n) { return "0x" + Number(n).toString(16); }
function hexToBigInt(hex) { return BigInt(hex); }
function formatEtherFromHexWei(hexWei) {
  const wei = hexToBigInt(hexWei);
  const etherInt = wei / 10n**18n;
  const etherFrac = (wei % 10n**18n).toString().padStart(18, "0").replace(/0+$/, "");
  return etherFrac ? `${etherInt}.${etherFrac}` : `${etherInt}`;
}

// избери адрес/chain според предпочитаната верига, иначе първата смислена
function pickPreferred(ns, preferredChainRef) {
  const accounts = Array.isArray(ns?.accounts) ? ns.accounts.map(parseAccount) : [];
  const chains = Array.isArray(ns?.chains) ? ns.chains : [];
  const prefId = Number(String(preferredChainRef || "").split(":")[1] || 0);

  // 1) опитай да намериш account за предпочитаната
  if (prefId && accounts.length) {
    const acc = accounts.find((a) => a.chainId === prefId);
    if (acc?.address) {
      return { chainId: prefId, address: acc.address, chainRef: `eip155:${prefId}` };
    }
  }
  // 2) ако няма – ако chains съдържа предпочитаната, ползвай първия адрес
  if (prefId && chains.includes(`eip155:${prefId}`) && accounts[0]?.address) {
    return { chainId: prefId, address: accounts[0].address, chainRef: `eip155:${prefId}` };
  }
  // 3) иначе – първия account
  if (accounts[0]?.address) {
    return { chainId: accounts[0].chainId, address: accounts[0].address, chainRef: `eip155:${accounts[0].chainId}` };
  }
  // 4) fallback към първата верига
  const firstChain = chains[0] || "eip155:1";
  const firstId = Number(firstChain.split(":")[1] || 1);
  return { chainId: firstId, address: accounts[0]?.address || "", chainRef: firstChain };
}

// помощник: намира row.session по topic
function getSessionByTopic(topic) {
  for (const [, row] of pendings) {
    if (row.session?.topic === topic) return row.session;
  }
  return null;
}

// ------- API: генерира WC URI за избраната мрежа -------
app.get("/wc-uri", async (req, res) => {
  try {
    const client = await getSignClient();

    const chainRef = String(req.query.chain || "").trim();
    const selectedChain = ALLOWED_CHAIN_REFS.has(chainRef) ? chainRef : "eip155:1";

    const optionalNamespaces = {
      eip155: {
        methods: ["personal_sign", "eth_accounts", "eth_chainId", "wallet_switchEthereumChain", "eth_sendTransaction", "eth_signTypedData", "eth_signTypedData_v4", "eth_call", "eth_estimateGas"],
        chains: [selectedChain],              // искаме approval за тази
        events: [],
      },
    };

    const { uri, approval } = await client.connect({ optionalNamespaces });

    const id = uuidv4();
    const createdAt = Date.now();
    const row = { createdAt, approval: null, session: null, preferredChainRef: selectedChain };
    pendings.set(id, row);

    const approvalPromise = (typeof approval === "function") ? approval() : approval;
    row.approval = approvalPromise;

    approvalPromise
      .then((session) => {
        const ns = session?.namespaces?.eip155;
        const picked = pickPreferred(ns, row.preferredChainRef);
        row.session = {
          topic: session.topic,
          addresses: (ns?.accounts || []).map((a) => parseAccount(a).address),
          chains: ns?.chains || [],
          address: picked.address || null,
          chainId: picked.chainId,
          networkName: chainIdToName(picked.chainId),
          selectedChainRef: picked.chainRef,
        };
        console.log("[WC APPROVED]", session.topic, "chains=", ns?.chains, "picked=", picked);
      })
      .catch((e) => console.warn("[WC APPROVAL REJECTED]", e?.message || e));

    res.json({ id, uri, expiresAt: new Date(createdAt + PENDING_TTL_MS).toISOString() });
  } catch (e) {
    console.error("[WC CONNECT ERROR]", e?.message || e);
    res.status(500).json({ error: e?.message || String(e) });
  }
});

// ------- API: статус -------
app.get("/wc-status", async (req, res) => {
  const { id } = req.query;
  if (id && pendings.has(id)) {
    const row = pendings.get(id);
    const expired = Date.now() - row.createdAt > PENDING_TTL_MS;
    if (row.session) return res.json({ status: "approved", ...row.session });
    if (expired) { pendings.delete(id); return res.json({ status: "expired" }); }
    return res.json({ status: "pending" });
  }
  // fallback: ако има активна сесия в клиента
  try {
    const client = await getSignClient();
    const all = client?.session?.getAll ? client.session.getAll() : [];
    if (Array.isArray(all) && all.length > 0) {
      const s = all[0];
      const ns = s.namespaces?.eip155;
      const picked = pickPreferred(ns, null);
      return res.json({
        status: "approved",
        topic: s.topic,
        addresses: (ns?.accounts || []).map((a) => parseAccount(a).address),
        chains: ns?.chains || [],
        address: picked.address || null,
        chainId: picked.chainId,
        networkName: chainIdToName(picked.chainId),
        selectedChainRef: picked.chainRef,
      });
    }
  } catch {}
  return res.json({ status: "not_found" });
});

// ------- API: смяна на мрежа -------
app.post("/wc-switch", async (req, res) => {
  try {
    const { topic, chainRef } = req.body;
    if (!topic || !chainRef) return res.status(400).json({ error: "topic and chainRef are required" });

    const client = await getSignClient();
    const decId = Number(String(chainRef).split(":")[1] || 0);
    const hexId = decToHexChainId(decId);

    await client.request({
      topic,
      chainId: chainRef,
      request: { method: "wallet_switchEthereumChain", params: [{ chainId: hexId }] },
    });

    // обнови кеша на избраната верига (ако имаме запис)
    const s = getSessionByTopic(topic);
    if (s) {
      s.selectedChainRef = chainRef;
      s.chainId = Number(String(chainRef).split(":")[1] || s.chainId);
      s.networkName = chainIdToName(s.chainId);
    }

    res.json({ ok: true });
  } catch (e) {
    console.warn("[WC SWITCH ERROR]", e?.message || e);
    res.status(500).json({ error: e?.message || String(e) });
  }
});

// ------- Нов универсален endpoint: транзакции/подписи/четения -------
const ALLOWED_METHODS = new Set([
  "eth_sendTransaction",
  "eth_call",
  "eth_sign",
  "personal_sign",
  "eth_signTypedData",
  "eth_signTypedData_v4",
  "wallet_switchEthereumChain",
  "eth_estimateGas",
  "eth_getBalance",
]);

/**
 * POST /wc-request
 * {
 *   "topic": "wc-topic",                // взимаш го от /wc-status
 *   "method": "eth_sendTransaction" | ...,
 *   "params": [...],                    // стандартни RPC params
 *   "chainRef": "eip155:56"             // optional; ако липсва -> ползваме selectedChainRef от сесията
 * }
 */
app.post("/wc-request", async (req, res) => {
  try {
    const { topic, method, params, chainRef } = req.body || {};
    if (!topic || typeof topic !== "string") {
      return res.status(400).json({ error: "Missing or invalid 'topic'." });
    }
    if (!method || typeof method !== "string" || !ALLOWED_METHODS.has(method)) {
      return res.status(400).json({ error: "Method not allowed or invalid." });
    }
    if (!Array.isArray(params)) {
      return res.status(400).json({ error: "Invalid 'params' — must be an array." });
    }

    const sess = getSessionByTopic(topic);
    if (!sess) {
      return res.status(404).json({ error: "Session not found or not approved." });
    }
    const effectiveChainRef = chainRef || sess.selectedChainRef || `eip155:${sess.chainId}`;

    // Защита при eth_sendTransaction — принуждаваме from да е адресът от сесията
    if (method === "eth_sendTransaction") {
      const tx = params?.[0];
      if (!tx || typeof tx !== "object") {
        return res.status(400).json({ error: "eth_sendTransaction expects params[0] tx object." });
      }
      if (!tx.from) tx.from = sess.address;
      if (typeof tx.from !== "string") {
        return res.status(400).json({ error: "Invalid 'from' field in tx." });
      }
      if (tx.from.toLowerCase() !== (sess.address || "").toLowerCase()) {
        return res.status(400).json({ error: "Transaction 'from' must match session address." });
      }
    }

    const client = await getSignClient();
    const result = await Promise.race([
      client.request({
        topic,
        chainId: effectiveChainRef,
        request: { method, params },
      }),
      new Promise((_, rej) => setTimeout(() => rej(new Error("WalletConnect request timed out")), 120_000)),
    ]);

    return res.json({ ok: true, result });
  } catch (e) {
    console.error("wc-request error:", e);
    return res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});

// ------- RPC balance (Reown RPC) -------
app.post("/rpc-balance", async (req, res) => {
  try {
    const { chainRef, address } = req.body || {};
    if (!chainRef || !address) return res.status(400).json({ error: "chainRef and address are required" });

    const url = `https://rpc.walletconnect.com/v1/?chainId=${encodeURIComponent(chainRef)}&projectId=${encodeURIComponent(WC_PROJECT_ID)}`;
    const payload = { id: Date.now(), jsonrpc: "2.0", method: "eth_getBalance", params: [address, "latest"] };

    const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
    const j = await r.json();
    if (j.error) throw new Error(j.error.message || "RPC error");

    res.json({ balanceWei: j.result, balanceEther: formatEtherFromHexWei(j.result) });
  } catch (e) {
    console.warn("[RPC BALANCE ERROR]", e?.message || e);
    res.status(500).json({ error: e?.message || String(e) });
  }
});

// ------- static / index.html -------
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
app.use(express.static(path.join(__dirname, "public")));
app.get("/", (_req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));
app.get("*", (_req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

const server = app.listen(PORT, () => {
  console.log(`Listening on :${PORT}`);
  console.log(`[BOOT] WC_PROJECT_ID length=${WC_PROJECT_ID.length}`);
});
process.on("SIGINT", () => server.close(() => process.exit(0)));
process.on("SIGTERM", () => server.close(() => process.exit(0)));
