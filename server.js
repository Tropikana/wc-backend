// server.js
import express from "express";
import cors from "cors";
import path from "path";
import { fileURLToPath } from "url";
import SignClient from "@walletconnect/sign-client";
import { v4 as uuidv4 } from "uuid";

// -------------------------------
// Config & bootstrap
// -------------------------------
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = process.env.PORT || 3000;
const WC_PROJECT_ID = process.env.WC_PROJECT_ID;

if (!WC_PROJECT_ID) {
  console.error("Missing env WC_PROJECT_ID (WalletConnect Project ID). Exiting.");
  process.exit(1);
}

const app = express();

// CORS allowlist (добави/премахни според нуждите си)
const allowlist = new Set([
  "https://wc-backend-tpug.onrender.com",
  "https://www.3dhome4u.com",
  // добави и без www ако ще се ползва
  "https://3dhome4u.com",
]);
app.use(
  cors({
    origin(origin, cb) {
      // Ако заявката идва без Origin (напр. от UE/Server side), позволи я
      if (!origin) return cb(null, true);
      if (allowlist.has(origin)) return cb(null, true);
      return cb(new Error("Not allowed by CORS"));
    },
    credentials: true,
  })
);

app.use(express.json({ limit: "1mb" }));

// -------------------------------
// WalletConnect Sign Client
// -------------------------------
const signClient = await SignClient.init({
  projectId: WC_PROJECT_ID,
  relayUrl: "wss://relay.walletconnect.com",
  metadata: {
    name: "3DHome4U WalletConnect",
    description: "UE5 Pixel Streaming WalletConnect backend",
    url: "https://www.3dhome4u.com",
    icons: ["https://walletconnect.com/walletconnect-logo.png"],
  },
});

// -------------------------------
// In-memory stores
// -------------------------------

// Временни „чакащи“ сесии (след /wc-uri, преди approve)
const pendingApprovals = new Map();
/*
pendingApprovals.set(sessionId, {
  approvalPromise: Promise<SessionStruct>,
  createdAt: number (ms)
})
*/

// Одобрени сесии, достъпни за заявки от UE
const approvedSessions = new Map();
/*
approvedSessions.set(sessionId, {
  topic: string,
  address: "0x...",
  chainId: "eip155:1",
  supportedChains: ["eip155:1", "eip155:137"]
})
*/

// -------------------------------
// Helpers
// -------------------------------
const DEFAULT_METHODS = [
  "eth_sendTransaction",
  "eth_call",
  "eth_sign",
  "personal_sign",
  "eth_signTypedData",
  "eth_signTypedData_v4",
  "wallet_switchEthereumChain",
  "eth_estimateGas",
  "eth_getBalance",
];
const DEFAULT_EVENTS = ["accountsChanged", "chainChanged"];

function eip155ToHex(chainRef) {
  // "eip155:1" -> "0x1"
  if (!chainRef || typeof chainRef !== "string") return null;
  const [ns, id] = chainRef.split(":");
  if (ns !== "eip155") return null;
  const n = Number(id);
  if (!Number.isFinite(n)) return null;
  return "0x" + n.toString(16);
}

function withTimeout(promise, ms, errMsg = "Request timed out") {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(errMsg)), ms)),
  ]);
}

// WalletConnect RPC proxy към Reown (бивш WalletConnect) публичния endpoint
async function wcRpcFetch(chainRef, method, params) {
  const url = `https://rpc.walletconnect.com/v1/?chainId=${encodeURIComponent(
    chainRef
  )}&projectId=${encodeURIComponent(WC_PROJECT_ID)}`;

  const body = {
    id: Date.now(),
    jsonrpc: "2.0",
    method,
    params,
  };

  const resp = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`RPC ${resp.status}: ${text}`);
  }
  const json = await resp.json();
  if (json.error) throw new Error(json.error.message || "RPC error");
  return json.result;
}

// -------------------------------
// Routes
// -------------------------------

/**
 * GET /wc-uri?chain=eip155:1
 * Връща { id, uri } за сканиране (QR). UE ползва id за последващ статус.
 */
app.get("/wc-uri", async (req, res) => {
  try {
    const chain = (req.query.chain || "eip155:1").toString();

    const requiredNamespaces = {
      eip155: {
        methods: DEFAULT_METHODS,
        chains: [chain],
        events: DEFAULT_EVENTS,
      },
    };

    const { uri, approval } = await signClient.connect({ requiredNamespaces });

    const sessionId = uuidv4();

    // Като се approve-не — прехвърляме в approvedSessions
    approval
      .then((session) => {
        try {
          const account =
            session.namespaces?.eip155?.accounts?.[0] || ""; // "eip155:1:0xabc..."
          const [ns, chainNum, addr] = account.split(":");
          const chainId = `${ns}:${chainNum}`;
          const supportedChains = session.namespaces?.eip155?.chains || [];

          approvedSessions.set(sessionId, {
            topic: session.topic,
            address: addr,
            chainId,
            supportedChains,
          });
        } finally {
          pendingApprovals.delete(sessionId);
        }
      })
      .catch(() => {
        pendingApprovals.delete(sessionId);
      });

    pendingApprovals.set(sessionId, {
      approvalPromise: approval,
      createdAt: Date.now(),
    });

    return res.json({ id: sessionId, uri });
  } catch (err) {
    console.error("wc-uri error:", err);
    return res.status(500).json({ error: String(err?.message || err) });
  }
});

/**
 * GET /wc-status?id=SESSION_ID
 * Връща:
 *  - { status: "approved", address, chainId, supportedChains }
 *  - { status: "pending" }
 *  - { status: "expired" } (след 10 мин)
 *  - 404 ако няма такава сесия
 */
app.get("/wc-status", async (req, res) => {
  try {
    const sessionId = (req.query.id || "").toString().trim();
    if (!sessionId) {
      return res.status(400).json({ error: "Missing 'id' query param." });
    }

    const approved = approvedSessions.get(sessionId);
    if (approved) {
      return res.json({
        status: "approved",
        address: approved.address,
        chainId: approved.chainId,
        supportedChains: approved.supportedChains || [],
      });
    }

    const pending = pendingApprovals.get(sessionId);
    if (!pending) {
      return res.status(404).json({ error: "Session not found." });
    }

    const maxWaitMs = 10 * 60 * 1000; // 10 мин
    if (Date.now() - pending.createdAt > maxWaitMs) {
      pendingApprovals.delete(sessionId);
      return res.json({ status: "expired" });
    }

    return res.json({ status: "pending" });
  } catch (err) {
    console.error("wc-status error:", err);
    return res.status(500).json({ error: String(err?.message || err) });
  }
});

/**
 * POST /wc-switch
 * { sessionId: "...", chainId: "eip155:137" }
 */
app.post("/wc-switch", async (req, res) => {
  try {
    const { sessionId, chainId } = req.body || {};
    if (!sessionId || !chainId) {
      return res
        .status(400)
        .json({ error: "Missing 'sessionId' or 'chainId' in body." });
    }
    const sess = approvedSessions.get(sessionId);
    if (!sess) return res.status(404).json({ error: "Session not found." });

    const hex = eip155ToHex(chainId);
    if (!hex) return res.status(400).json({ error: "Invalid chainId format." });

    const result = await withTimeout(
      signClient.request({
        topic: sess.topic,
        chainId,
        request: {
          method: "wallet_switchEthereumChain",
          params: [{ chainId: hex }],
        },
      }),
      120_000,
      "WalletConnect request timed out"
    );

    // Ако не хвърли грешка — приемаме успех; обнови текущата верига
    sess.chainId = chainId;
    approvedSessions.set(sessionId, sess);

    return res.json({ ok: true, result });
  } catch (err) {
    console.error("wc-switch error:", err);
    return res.status(500).json({ ok: false, error: String(err?.message || err) });
  }
});

/**
 * POST /rpc-balance
 * { chainRef: "eip155:1", address: "0x..." }
 */
app.post("/rpc-balance", async (req, res) => {
  try {
    const { chainRef, address } = req.body || {};
    if (!chainRef || !address) {
      return res
        .status(400)
        .json({ error: "Missing 'chainRef' or 'address' in body." });
    }
    const result = await wcRpcFetch(chainRef, "eth_getBalance", [address, "latest"]);
    // result е hex string wei, връщаме го директно (UE може да го форматира)
    return res.json({ ok: true, balance: result });
  } catch (err) {
    console.error("rpc-balance error:", err);
    return res.status(500).json({ ok: false, error: String(err?.message || err) });
  }
});

// -------------------------------
// Нов универсален endpoint за заявки към портфейла
// -------------------------------
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
 *   "sessionId": "uuid",
 *   "method": "eth_sendTransaction" | ...,
 *   "params": [...],
 *   "chainId": "eip155:1" // optional; ако липсва, ползваме тази от approve
 * }
 */
app.post("/wc-request", async (req, res) => {
  try {
    const { sessionId, method, params, chainId } = req.body || {};

    if (!sessionId || typeof sessionId !== "string") {
      return res.status(400).json({ error: "Missing or invalid 'sessionId'." });
    }
    if (!method || typeof method !== "string" || !ALLOWED_METHODS.has(method)) {
      return res.status(400).json({ error: "Method not allowed or invalid." });
    }
    if (!Array.isArray(params)) {
      return res.status(400).json({ error: "Invalid 'params' — must be an array." });
    }

    const sess = approvedSessions.get(sessionId);
    if (!sess) {
      return res.status(404).json({ error: "Session not found or not approved." });
    }
    const topic = sess.topic;
    const effectiveChainId = chainId || sess.chainId;
    if (!effectiveChainId) {
      return res
        .status(400)
        .json({ error: "No chainId provided and none stored for session." });
    }

    // Защита при eth_sendTransaction — принуждаваме from да е адресът от сесията
    if (method === "eth_sendTransaction") {
      const tx = params?.[0];
      if (!tx || typeof tx !== "object") {
        return res
          .status(400)
          .json({ error: "eth_sendTransaction expects params[0] tx object." });
      }
      if (!tx.from) tx.from = sess.address;
      if (typeof tx.from !== "string") {
        return res.status(400).json({ error: "Invalid 'from' field in tx." });
      }
      if (tx.from.toLowerCase() !== sess.address.toLowerCase()) {
        return res
          .status(400)
          .json({ error: "Transaction 'from' must match session address." });
      }
    }

    const result = await withTimeout(
      signClient.request({
        topic,
        chainId: effectiveChainId,
        request: { method, params },
      }),
      120_000,
      "WalletConnect request timed out"
    );

    return res.json({ ok: true, result });
  } catch (err) {
    console.error("wc-request error:", err);
    return res.status(500).json({ ok: false, error: String(err?.message || err) });
  }
});

// -------------------------------
/**
 * (По избор) Инфо за сесията
 * GET /wc-accounts?id=SESSION_ID
 */
app.get("/wc-accounts", (req, res) => {
  const sessionId = (req.query.id || "").toString();
  if (!sessionId) return res.status(400).json({ error: "Missing 'id'." });
  const sess = approvedSessions.get(sessionId);
  if (!sess) return res.status(404).json({ error: "Session not found." });
  return res.json({
    address: sess.address,
    chainId: sess.chainId,
    supportedChains: sess.supportedChains || [],
  });
});

// -------------------------------
// Static hosting (public/index.html) + SPA fallback
// -------------------------------
const publicDir = path.join(__dirname, "public");
app.use(express.static(publicDir));
app.get("*", (req, res) => {
  res.sendFile(path.join(publicDir, "index.html"));
});

// -------------------------------
// Start server
// -------------------------------
app.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
});
