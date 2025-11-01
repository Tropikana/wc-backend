import express from "express";
import cors from "cors";
import { v4 as uuidv4 } from "uuid";
import { createRequire } from "module";
import path from "path";
import { fileURLToPath } from "url";

const require = createRequire(import.meta.url);

// ── конфигурация ───────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
const WC_PROJECT_ID = (process.env.WC_PROJECT_ID || "").trim();
const RELAY_URL = process.env.RELAY_URL || "wss://relay.walletconnect.com";
if (!WC_PROJECT_ID) {
  console.error("[FATAL] Missing WC_PROJECT_ID");
  process.exit(1);
}

// ── app ────────────────────────────────────────────────────────────────────────
const app = express();

// CORS allowlist
const ALLOWLIST = new Set([
  "https://wc-backend-tpug.onrender.com",
  "https://www.3dhome4u.com",
]);
app.use(
  cors({
    origin: (origin, cb) => {
      if (!origin) return cb(null, true);
      if (ALLOWLIST.has(origin)) return cb(null, true);
      return cb(new Error("Not allowed by CORS"));
    },
    credentials: true,
  })
);
app.use(express.json());

// ── robust import на @walletconnect/sign-client ────────────────────────────────
let SignClientFactory = null;
async function loadSignClient() {
  if (SignClientFactory) return SignClientFactory;
  let mod = null,
    mode = "esm";
  try {
    mod = await import("@walletconnect/sign-client");
  } catch {
    mode = "cjs";
    mod = require("@walletconnect/sign-client");
  }
  console.log("[WC IMPORT] mode=", mode, "keys=", Object.keys(mod || {}));

  const Candidate =
    mod?.default?.init
      ? mod.default
      : mod?.SignClient?.init
      ? mod.SignClient
      : typeof mod?.default === "function"
      ? mod.default
      : typeof mod?.SignClient === "function"
      ? mod.SignClient
      : null;

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

  signClient.on("session_update", ({ topic, params }) => {
    try {
      const ns = params?.namespaces?.eip155;
      if (!ns) return;
      for (const [, row] of pendings) {
        if (row.session?.topic === topic) {
          const picked = pickActive(ns);
          row.session = {
            ...row.session,
            addresses: (ns.accounts || []).map((a) => parseAccount(a).address),
            chains: ns.chains || [],
            address: picked.address || null,
            chainId: picked.chainId,
            networkName: chainIdToName(picked.chainId),
          };
        }
      }
    } catch {}
  });

  return signClient;
}

// ── store + TTL ────────────────────────────────────────────────────────────────
const PENDING_TTL_MS = 10 * 60 * 1000;
const pendings = new Map();
setInterval(() => {
  const now = Date.now();
  for (const [id, row] of pendings)
    if (now - row.createdAt > PENDING_TTL_MS) pendings.delete(id);
}, 60_000);

// ── helpers ───────────────────────────────────────────────────────────────────
function toApprovalPromise(x) {
  try {
    if (typeof x === "function") {
      const r = x();
      return r && r.then ? r : Promise.resolve(r);
    }
    if (x && x.then) return x;
    return new Promise(() => {});
  } catch (e) {
    return Promise.reject(e);
  }
}
function chainIdToName(id) {
  const map = {
    1: "Ethereum Mainnet",
    10: "Optimism",
    25: "Cronos",
    56: "BNB Chain",
    97: "BNB Testnet",
    137: "Polygon",
    250: "Fantom",
    324: "zkSync Era",
    338: "Cronos Testnet",
    8453: "Base",
    42161: "Arbitrum One",
    43114: "Avalanche C-Chain",
    59144: "Linea",
  };
  return map[id] || `eip155:${id}`;
}
function parseAccount(ac) {
  const [ns, cid, addr] = String(ac || "").split(":");
  return { ns, chainId: Number(cid || 0), address: addr || "" };
}
function pickActive(ns) {
  const accounts = Array.isArray(ns?.accounts) ? ns.accounts.map(parseAccount) : [];
  if (accounts.length > 0 && accounts[0].chainId && accounts[0].address) {
    return {
      chainId: accounts[0].chainId,
      address: accounts[0].address,
      allAddresses: accounts.map((a) => a.address),
    };
  }
  const firstChain =
    Array.isArray(ns?.chains) && ns.chains.length
      ? Number(String(ns.chains[0]).split(":")[1] || 0)
      : 0;
  const firstAddr = accounts[0]?.address || "";
  return {
    chainId: firstChain || accounts[0]?.chainId || 0,
    address: firstAddr,
    allAddresses: accounts.map((a) => a.address),
  };
}
function decToHexChainId(n) {
  return "0x" + Number(n).toString(16);
}

// ── списъкът с вериги за бутони и за connect ───────────────────────────────────
const EIP155_CHAIN_REFS = [
  "eip155:1",
  "eip155:10",
  "eip155:25",
  "eip155:56",
  "eip155:97",
  "eip155:137",
  "eip155:250",
  "eip155:324",
  "eip155:338",
  "eip155:8453",
  "eip155:42161",
  "eip155:43114",
  "eip155:59144",
];

// ── API: генерира WC URI ──────────────────────────────────────────────────────
app.get("/wc-uri", async (_req, res) => {
  try {
    const client = await getSignClient();

    // използваме optionalNamespaces (required е deprecated)
    const optionalNamespaces = {
      eip155: {
        methods: ["personal_sign", "eth_accounts", "eth_chainId", "wallet_switchEthereumChain"],
        chains: EIP155_CHAIN_REFS,
        events: [],
      },
    };

    const { uri, approval } = await client.connect({ optionalNamespaces });

    const id = uuidv4();
    const createdAt = Date.now();
    const row = { createdAt, approval: null, session: null };
    pendings.set(id, row);

    const approvalPromise = toApprovalPromise(approval);
    row.approval = approvalPromise;

    approvalPromise
      .then((session) => {
        const ns = session?.namespaces?.eip155;
        const picked = pickActive(ns);
        row.session = {
          topic: session.topic,
          addresses: picked.allAddresses,
          chains: ns?.chains || [],
          address: picked.address || null,
          chainId: picked.chainId,
          networkName: chainIdToName(picked.chainId),
        };
        console.log(
          "[WC APPROVED]",
          session.topic,
          "chains=",
          ns?.chains,
          "picked=",
          picked
        );
      })
      .catch((e) => console.warn("[WC APPROVAL REJECTED]", e?.message || e));

    res.json({ id, uri, expiresAt: new Date(createdAt + PENDING_TTL_MS).toISOString() });
  } catch (e) {
    console.error("[WC CONNECT ERROR]", e?.message || e);
    res.status(500).json({ error: e?.message || String(e) });
  }
});

// ── API: статус ────────────────────────────────────────────────────────────────
app.get("/wc-status", async (req, res) => {
  const { id } = req.query;
  if (id && pendings.has(id)) {
    const row = pendings.get(id);
    const expired = Date.now() - row.createdAt > PENDING_TTL_MS;
    if (row.session) return res.json({ status: "approved", ...row.session });
    if (expired) {
      pendings.delete(id);
      return res.json({ status: "expired" });
    }
    return res.json({ status: "pending" });
  }
  try {
    const client = await getSignClient();
    const all = client?.session?.getAll ? client.session.getAll() : [];
    if (Array.isArray(all) && all.length > 0) {
      const s = all[0];
      const ns = s.namespaces?.eip155;
      const picked = pickActive(ns);
      return res.json({
        status: "approved",
        topic: s.topic,
        addresses: picked.allAddresses,
        chains: ns?.chains || [],
        address: picked.address || null,
        chainId: picked.chainId,
        networkName: chainIdToName(picked.chainId),
      });
    }
  } catch {}
  return res.json({ status: "not_found" });
});

// ── API: смяна на мрежа (wallet_switchEthereumChain) ──────────────────────────
app.post("/wc-switch", async (req, res) => {
  try {
    const { topic, chainRef } = req.body;
    if (!topic || !chainRef)
      return res.status(400).json({ error: "topic and chainRef are required" });

    const client = await getSignClient();
    const decId = Number(String(chainRef).split(":")[1] || 0);
    const hexId = decToHexChainId(decId);

    await client.request({
      topic,
      chainId: chainRef,
      request: {
        method: "wallet_switchEthereumChain",
        params: [{ chainId: hexId }],
      },
    });

    res.json({ ok: true });
  } catch (e) {
    console.warn("[WC SWITCH ERROR]", e?.message || e);
    res.status(500).json({ error: e?.message || String(e) });
  }
});

// ── API: баланс през Reown Blockchain API (unified RPC) ───────────────────────
/**
 * POST /rpc-balance
 * body: { chainRef: "eip155:56", address: "0x..." }
 * Връща { balanceWei: "0x...", balanceEther: "..." }
 */
app.post("/rpc-balance", async (req, res) => {
  try {
    const { chainRef, address } = req.body || {};
    if (!chainRef || !address) return res.status(400).json({ error: "chainRef and address are required" });

    // JSON-RPC към Reown Blockchain API.
    // Примерен ендпойнт: https://rpc.walletconnect.com/v1/?chainId=eip155:56&projectId=WC_PROJECT_ID
    const url = `https://rpc.walletconnect.com/v1/?chainId=${encodeURIComponent(chainRef)}&projectId=${encodeURIComponent(WC_PROJECT_ID)}`;

    const payload = {
      id: Date.now(),
      jsonrpc: "2.0",
      method: "eth_getBalance",
      params: [address, "latest"],
    };

    const r = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    const j = await r.json();
    if (j.error) throw new Error(j.error.message || "RPC error");
    const balanceWeiHex = j.result; // hex
    const wei = BigInt(balanceWeiHex);
    // повечето EVM вериги са 18 десетични
    const ether = Number(wei) / 1e18;
    res.json({ balanceWei: balanceWeiHex, balanceEther: ether.toString() });
  } catch (e) {
    console.warn("[RPC BALANCE ERROR]", e?.message || e);
    res.status(500).json({ error: e?.message || String(e) });
  }
});

// ── healthcheck ────────────────────────────────────────────────────────────────
app.get("/healthz", (_req, res) => res.send("ok"));

// ── статични файлове + root към public/index.html ─────────────────────────────
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

app.use(express.static(path.join(__dirname, "public")));
app.get("/", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});
app.get("*", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// ── старт ─────────────────────────────────────────────────────────────────────
const server = app.listen(PORT, () => {
  console.log(`Listening on :${PORT}`);
  console.log(`[BOOT] WC_PROJECT_ID length=${WC_PROJECT_ID.length}, preview=${WC_PROJECT_ID.slice(0,3)}.${WC_PROJECT_ID.slice(-3)}`);
});
process.on("unhandledRejection", (e) => console.warn("[UNHANDLED REJECTION]", e?.message || e));
process.on("uncaughtException", (e) => console.warn("[UNCAUGHT EXCEPTION]", e?.message || e));
process.on("SIGINT", () => server.close(() => process.exit(0)));
process.on("SIGTERM", () => server.close(() => process.exit(0)));
