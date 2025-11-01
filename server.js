// server.js
import express from "express";
import cors from "cors";
import path from "path";
import { fileURLToPath } from "url";

// ---------- Helpers ----------
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// WalletConnect SignClient – надежден импорт (default / named)
let _SignClient = null;
async function getSignClient() {
  if (_SignClient) return _SignClient;
  const mod = await import("@walletconnect/sign-client");
  _SignClient = mod?.default ?? mod;
  if (typeof _SignClient?.init !== "function") {
    throw new Error("SignClient.init not available (bad import)");
  }
  return _SignClient;
}

// Мап с активни заявки по topic
const store = new Map(); // topic -> { client, approval, session }

// Поддържани вериги и имена
const CHAIN_NAME = {
  1: "Ethereum Mainnet",
  56: "BNB Chain",
  97: "BNB Testnet",
  137: "Polygon",
  59144: "Linea",
};

// Изгражда requiredNamespaces за eip155
function makeNamespaces(chainIds) {
  const chains = chainIds.map((id) => `eip155:${id}`);
  return {
    eip155: {
      methods: [
        "eth_sendTransaction",
        "eth_signTransaction",
        "eth_sign",
        "personal_sign",
        "eth_signTypedData",
        "eth_signTypedData_v4",
      ],
      chains,
      events: ["accountsChanged", "chainChanged"],
    },
  };
}

// Чете адрес и chainId от сесията (eip155)
function pickPrimary(session) {
  const accs = session?.namespaces?.eip155?.accounts ?? [];
  if (!accs.length) return { address: null, chainId: null };
  // формат: 'eip155:<chainId>:<address>'
  const [_, chainStr, addr] = accs[0].split(":");
  return { address: addr, chainId: Number(chainStr) };
}

// ---------- App ----------
const app = express();
app.use(cors());
app.use(express.json());

// сервирай фронта от /public
app.use(express.static(path.join(__dirname, "public")));

// Health
app.get("/health", (_req, res) => res.json({ ok: true }));

/**
 * GET /wc-uri
 * params:
 * - chains: CSV от chainId (по умолчание 1,56,137,59144)
 *
 * Връща { ok, uri, topic }
 */
app.get("/wc-uri", async (req, res) => {
  try {
    const SignClient = await getSignClient();

    const projectId =
      process.env.WC_PROJECT_ID && process.env.WC_PROJECT_ID.trim()
        ? process.env.WC_PROJECT_ID.trim()
        : null;

    if (!projectId) {
      return res
        .status(500)
        .json({ ok: false, error: "Missing WC_PROJECT_ID env" });
    }

    const chainsParam = (req.query.chains ?? "").toString().trim();
    const chainIds = (chainsParam
      ? chainsParam.split(",")
      : ["1", "56", "137", "59144"]
    )
      .map((s) => Number(s))
      .filter((n) => !Number.isNaN(n));

    const requiredNamespaces = makeNamespaces(chainIds);

    const client = await SignClient.init({
      projectId,
      relayUrl: "wss://relay.walletconnect.com",
      logger: "error",
      metadata: {
        name: "3DHome4U Login",
        description: "Login via WalletConnect / MetaMask",
        url: "https://3dhome4u.com",
        icons: ["https://walletconnect.com/walletconnect-logo.png"],
      },
    });

    // Инициране на връзка
    const { uri, approval } = await client.connect({ requiredNamespaces });

    if (!uri) {
      return res
        .status(500)
        .json({ ok: false, error: "No URI returned from connect()" });
    }

    // Вадим topic от URI (topic=<uuid>)
    const topic =
      new URL(uri).searchParams.get("topic") ||
      (uri.match(/topic=([^&]+)/)?.[1] ?? null);

    if (!topic) {
      return res
        .status(500)
        .json({ ok: false, error: "Cannot extract topic from URI" });
    }

    // Съхраняваме approval и клиента
    store.set(topic, { client, approval, session: null });

    // Когато има одобрение – пазим сесията
    approval
      .then((session) => {
        const k = store.get(topic);
        if (k) k.session = session;
      })
      .catch(() => {
        // rejected / timeout
        store.delete(topic);
      });

    return res.json({ ok: true, uri, topic });
  } catch (err) {
    console.error("[/wc-uri] ERROR:", err);
    return res.status(500).json({ ok: false, error: String(err?.message || err) });
  }
});

/**
 * GET /status?topic=<topic>
 * Връща:
 *  - { state: "pending" } – докато чакаме approval
 *  - { state: "connected", address, chainId, networkName }
 *  - { state: "unknown" } – невалиден topic
 */
app.get("/status", async (req, res) => {
  const topic = (req.query.topic ?? "").toString();
  if (!topic || !store.has(topic)) {
    return res.json({ state: "unknown" });
  }

  const entry = store.get(topic);

  if (!entry.session) {
    return res.json({ state: "pending" });
  }

  const { address, chainId } = pickPrimary(entry.session);
  return res.json({
    state: "connected",
    address,
    chainId,
    networkName: CHAIN_NAME[chainId] || `eip155:${chainId}`,
  });
});

/**
 * POST /disconnect { topic }
 */
app.post("/disconnect", async (req, res) => {
  const { topic } = req.body || {};
  const entry = topic && store.get(topic);
  if (!entry) return res.json({ ok: true });

  try {
    if (entry.session) {
      await entry.client.disconnect({
        topic: entry.session.topic,
        reason: { code: 6000, message: "User disconnected" },
      });
    }
  } catch (_) {
    // ignore
  }
  store.delete(topic);
  return res.json({ ok: true });
});

// Fallback към index.html (ако ползваш SPA във /public)
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// ---------- Start ----------
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log("Listening on :", PORT);
  console.log("==> Your service is live 🎉");
  console.log("==> ////////////////////////////////////////////////");
  console.log(
    "==>  Available at your primary URL",
    process.env.RENDER_EXTERNAL_URL || "(set RENDER_EXTERNAL_URL)"
  );
  console.log("==> ////////////////////////////////////////////////");
});
