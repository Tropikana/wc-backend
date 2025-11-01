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

  const keys = Object.keys(mod || {});
  console.log(`[WC IMPORT] mode=${mode}, keys=${JSON.stringify(keys)}`);

  // кандидати
  const Candidate =
    mod?.default?.init ? mod.default :
    mod?.SignClient?.init ? mod.SignClient :
    (typeof mod?.default === "function" ? mod.default :
     typeof mod?.SignClient === "function" ? mod.SignClient : null);

  if (!Candidate) {
    throw new Error(`WalletConnect SignClient export not recognized. mode=${mode}, keys=${JSON.stringify(keys)}`);
  }

  // нормализирана фабрика -> връща инстанция
  SignClientFactory = async (opts) => {
    if (typeof Candidate.init === "function") return Candidate.init(opts); // static init
    const instance = new Candidate(opts);                                  // конструктор
    if (!instance || typeof instance.connect !== "function") {
      throw new Error("Constructed SignClient has no .connect()");
    }
    return instance;
  };
  return SignClientFactory;
}

// ── WalletConnect клиент (lazy init) ───────────────────────────────────────────
let signClient = null;
async function getSignClient() {
  if (signClient) return signClient;
  const create = await loadSignClient();
  try {
    signClient = await create({
      projectId: WC_PROJECT_ID,
      relayUrl: RELAY_URL,
      metadata: {
        name: "3DHome4U Login",
        description: "Login via WalletConnect / MetaMask",
        url: "https://wc-backend-tpug.onrender.com", // трябва да е в Allowlist
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
const PENDING_TTL_MS = 2 * 60 * 1000;
const pendings = new Map();
setInterval(() => {
  const now = Date.now();
  for (const [id, row] of pendings) if (now - row.createdAt > PENDING_TTL_MS) pendings.delete(id);
}, 30_000);

// ── помощник: нормализиран approval → Promise<session> ────────────────────────
function toApprovalPromise(approvalMaybeFnOrPromise) {
  try {
    if (typeof approvalMaybeFnOrPromise === "function") {
      const ret = approvalMaybeFnOrPromise();           // някои билдове връщат функция
      return (ret && typeof ret.then === "function") ? ret : Promise.resolve(ret);
    }
    if (approvalMaybeFnOrPromise && typeof approvalMaybeFnOrPromise.then === "function") {
      return approvalMaybeFnOrPromise;                  // директен Promise
    }
    // fallback: ако нищо не е върнато, връщаме обещание, което никога не изпълнява
    return new Promise(() => {});
  } catch (e) {
    return Promise.reject(e);
  }
}

// ── API: създай WalletConnect pairing ─────────────────────────────────────────
app.get("/wc-uri", async (_req, res) => {
  try {
    const client = await getSignClient();
    const requiredNamespaces = {
      eip155: {
        methods: ["personal_sign","eth_sign","eth_signTypedData","eth_signTypedData_v4","eth_sendTransaction"],
        chains: ["eip155:1"], // минимално изискване → Ethereum Mainnet
        events: ["chainChanged","accountsChanged"]
      }
    };
    // по желание: дай шанс на уолета да добави още вериги
    const optionalNamespaces = {
      eip155: {
        chains: ["eip155:137","eip155:25","eip155:338"],
        methods: ["personal_sign","eth_sign","eth_signTypedData","eth_signTypedData_v4","eth_sendTransaction"],
        events: ["chainChanged","accountsChanged"]
      }
    };
    const { uri, approval } = await client.connect({
      requiredNamespaces,
      optionalNamespaces
    });

    const { uri, approval } = await client.connect({ requiredNamespaces });

    const id = uuidv4();
    const createdAt = Date.now();
    const row = { createdAt, approval: null, session: null };
    pendings.set(id, row);

    // нормализирай approval
    const approvalPromise = toApprovalPromise(approval);
    row.approval = approvalPromise;

    approvalPromise.then((session) => {
      const ns = session?.namespaces?.eip155;
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

// ── статични файлове ───────────────────────────────────────────────────────────
app.use(express.static("public"));

// ── старт ─────────────────────────────────────────────────────────────────────
const server = app.listen(PORT, () => {
  console.log(`Listening on :${PORT}`);
  console.log(`[BOOT] WC_PROJECT_ID length=${WC_PROJECT_ID.length}, preview=${WC_PROJECT_ID.slice(0,3)}...${WC_PROJECT_ID.slice(-3)}`);
});
process.on("SIGINT", () => server.close(() => process.exit(0)));
process.on("SIGTERM", () => server.close(() => process.exit(0)));
