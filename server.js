// server.js
import express from "express";
import cors from "cors";
import path from "path";
import { fileURLToPath } from "url";
import SignClient from "@walletconnect/sign-client";

// ---------- базова конфигурация ----------
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = process.env.PORT || 10000;
const WC_PROJECT_ID =
  process.env.WC_PROJECT_ID ||
  // постави си реалния projectId тук, ако не го подаваш през env
  "YOUR_WALLETCONNECT_PROJECT_ID";

if (!WC_PROJECT_ID || WC_PROJECT_ID === "YOUR_WALLETCONNECT_PROJECT_ID") {
  console.warn(
    "[WARN] WC_PROJECT_ID не е зададен. Сложи реален projectId от WalletConnect Cloud!"
  );
}

const app = express();
app.use(cors());
app.use(express.json());

// Статични файлове от /public
const publicDir = path.join(__dirname, "public");
app.use(express.static(publicDir));
app.get("/", (_req, res) => res.sendFile(path.join(publicDir, "index.html")));

// ---------- WalletConnect ----------

/** singleton на SignClient */
let wcClient = null;

/** тема -> запазена информация за сесията */
const sessions = new Map();

/** поддържани EIP-155 мрежи, които искаме при connect */
const SUPPORTED_CHAINS = [
  1, // Ethereum Mainnet
  137, // Polygon
  56, // BNB Chain
  97, // BNB Testnet
  59144, // Linea Mainnet
];

/** полезни имена за показване */
const CHAIN_NAMES = {
  1: "Ethereum Mainnet",
  137: "Polygon",
  56: "BNB Chain",
  97: "BNB Testnet",
  59144: "Linea",
};

const REQUIRED_METHODS = [
  "eth_chainId",
  "eth_accounts",
  "personal_sign",
  "eth_sendTransaction",
  "eth_signTransaction",
  "eth_signTypedData",
  "wallet_switchEthereumChain",
];
const REQUIRED_EVENTS = ["accountsChanged", "chainChanged"];

/** lazy init на SignClient */
async function getSignClient() {
  if (wcClient) return wcClient;

  wcClient = await SignClient.init({
    projectId: WC_PROJECT_ID,
    // relayUrl: "wss://relay.walletconnect.com", // по подразбиране
    metadata: {
      name: "3DHome4U Login",
      description: "WalletConnect / MetaMask login demo",
      url: "https://3dhome4u.com",
      icons: ["https://walletconnect.com/walletconnect-logo.png"],
    },
  });

  console.log("[BOOT] SignClient готов.");
  return wcClient;
}

/** извлича topic от wc-uri (формат wc:{topic}@2?... ) */
function extractTopicFromUri(uri) {
  const m = /^wc:([^@]+)@/i.exec(uri);
  return m ? m[1] : undefined;
}

/** от session.namespaces взима 1) адреса за първия акаунт, 2) chainId на този акаунт */
function pickActiveAccountAndChain(session) {
  try {
    const ns = session?.namespaces?.eip155;
    const accounts = ns?.accounts || [];
    if (!accounts.length) return {};

    // eip155:{chainId}:{address}
    const [_, chainIdStr, address] = accounts[0].split(":");
    const chainId = Number(chainIdStr);
    return { address, chainId, allAccounts: accounts };
  } catch {
    return {};
  }
}

/** формат за фронтенда */
function formatSessionForClient(session) {
  const { address, chainId, allAccounts } = pickActiveAccountAndChain(session);
  return {
    ok: true,
    topic: session.topic,
    address,
    addressShort: address
      ? `${address.slice(0, 6)}...${address.slice(-4)}`
      : undefined,
    chainId,
    chainName: chainId ? CHAIN_NAMES[chainId] || `eip155:${chainId}` : undefined,
    allAccounts,
  };
}

// ---------- API ----------

/**
 * GET /wc-uri
 * Създава нова pairing/връзка и връща wc-uri + topic.
 */
app.get("/wc-uri", async (_req, res) => {
  try {
    const client = await getSignClient();

    const requiredNamespaces = {
      eip155: {
        methods: REQUIRED_METHODS,
        events: REQUIRED_EVENTS,
        chains: SUPPORTED_CHAINS.map((id) => `eip155:${id}`),
      },
    };

    const { uri, approval } = await client.connect({ requiredNamespaces });

    if (!uri) {
      return res.status(500).json({ ok: false, error: "No URI from connect()" });
    }

    const topic = extractTopicFromUri(uri) || "";

    console.log(
      `[WC IMPORT] chains= [ ${requiredNamespaces.eip155.chains
        .map((c) => `'${c}'`)
        .join(", ")} ]`
    );
    console.log(`[WC URI] ${topic}`);

    // изчакваме асинхронно одобрението, без да блокираме отговора към клиента
    approval()
      .then((session) => {
        const info = formatSessionForClient(session);
        sessions.set(session.topic, session);
        console.log(
          `[WC APPROVED] topic=${session.topic}  chainId: ${info.chainId}, address: ${info.address}`
        );
      })
      .catch((err) => {
        console.error("[WC APPROVAL ERROR]", err?.message || err);
      });

    return res.json({ ok: true, uri, topic });
  } catch (err) {
    console.error("[/wc-uri] ERROR:", err?.message || err);
    return res
      .status(500)
      .json({ ok: false, error: "Неуспешно /wc-uri", details: String(err) });
  }
});

/**
 * GET /wc-status?topic=...
 * Връща информация за текущата сесия (адрес, мрежа).
 */
app.get("/wc-status", async (req, res) => {
  try {
    const { topic } = req.query;
    if (!topic) return res.json({ ok: false, error: "Missing topic" });

    const session = sessions.get(String(topic));
    if (!session) return res.json({ ok: false, error: "not_found" });

    return res.json(formatSessionForClient(session));
  } catch (err) {
    console.error("[/wc-status] ERROR:", err?.message || err);
    return res.status(500).json({ ok: false, error: "status_error" });
  }
});

/**
 * POST /wc-switch
 * body: { topic: string, chainId: number }
 * Изисква смяна на мрежата в портфейла (ако е одобрена).
 */
app.post("/wc-switch", async (req, res) => {
  try {
    const { topic, chainId } = req.body || {};
    if (!topic || !chainId) {
      return res
        .status(400)
        .json({ ok: false, error: "Missing topic or chainId" });
    }

    const client = await getSignClient();
    const session = sessions.get(String(topic));
    if (!session) return res.json({ ok: false, error: "not_found" });

    const hexChain =
      "0x" + Number(chainId).toString(16); // '0x89' за 137 и т.н.

    // През WalletConnect v2 е нужна "routing chain" – използваме target chain-а.
    await client.request({
      topic: session.topic,
      chainId: `eip155:${chainId}`,
      request: {
        method: "wallet_switchEthereumChain",
        params: [{ chainId: hexChain }],
      },
    });

    // обновяваме кеша (някои портфейли връщат нов "активен" chain на първа позиция)
    const fresh = await client.session.get(session.topic);
    sessions.set(session.topic, fresh);

    return res.json(formatSessionForClient(fresh));
  } catch (err) {
    console.error("[/wc-switch] ERROR:", err?.message || err);
    return res
      .status(500)
      .json({ ok: false, error: "switch_error", details: String(err) });
  }
});

// ---------- старт ----------
app.listen(PORT, () => {
  console.log(`Listening on :${PORT}`);
  console.log("==> Your service is live 🎉");
  console.log("==> ///////////////////////////////////////////////");
  console.log(
    `==> Available at your primary URL https://wc-backend-tpug.onrender.com`
  );
  console.log("==> ///////////////////////////////////////////////");
});
