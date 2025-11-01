import express from "express";
import cors from "cors";

// -------- WalletConnect SignClient (устойчив импорт) ----------
async function getSignClient() {
  const mod = await import("@walletconnect/sign-client");
  // при някои сборки default липсва -> взимаме default || module
  const SignClient = mod.default || mod;
  return await SignClient.init({
    projectId: process.env.WC_PROJECT_ID || "00000000000000000000000000000000",
    metadata: {
      name: "3DHome4U Login",
      description: "Login via WalletConnect / MetaMask",
      url: "https://wc-backend-demo.local",
      icons: ["https://walletconnect.com/walletconnect-logo.png"]
    }
  });
}
// ---------------------------------------------------------------

const app = express();
app.use(cors());
app.use(express.json());

// държим един клиент + последна сесия за показване във фронта
let clientPromise = null;
let lastSession = null; // {topic, address, chainId}

// за по-лесно име по chainId
const CHAIN_NAMES = {
  1: "Ethereum Mainnet",
  56: "BNB Chain",
  97: "BNB Testnet",
  137: "Polygon",
  59144: "Linea"
};

// разрешени методи/събития/вериги
const REQUIRED = {
  eip155: {
    methods: [
      "eth_sendTransaction",
      "personal_sign",
      "eth_signTypedData",
      "wallet_switchEthereumChain"
    ],
    events: ["accountsChanged", "chainChanged"],
    chains: ["eip155:1", "eip155:56", "eip155:97", "eip155:137", "eip155:59144"]
  }
};

function parseSession(session) {
  // Взимаме първия акаунт от eip155: "eip155:137:0xabc..."
  const accounts = session.namespaces?.eip155?.accounts || [];
  const first = accounts[0] || "";
  const parts = first.split(":"); // ['eip155','137','0x...']
  const chainId = Number(parts[1] || 0);
  const address = parts[2] || "";
  return { chainId, address };
}

async function ensureClient() {
  if (!clientPromise) clientPromise = getSignClient();
  return clientPromise;
}

/**
 * 1) Генерира QR URI за свързване. Връща {uri, topic}
 *    Одобрението се обработва във фонов режим и се пази в lastSession.
 */
app.get("/wc-uri", async (req, res) => {
  try {
    const client = await ensureClient();

    const { uri, approval } = await client.connect({
      requiredNamespaces: REQUIRED
    });

    // обработка на одобрението "встрани", за да върнем URI веднага
    (async () => {
      try {
        const session = await approval();
        const { address, chainId } = parseSession(session);
        lastSession = {
          topic: session.topic,
          address,
          chainId
        };
        console.log(
          `[WC APPROVED] ${session.topic} chainId: ${chainId} address: ${address}`
        );
      } catch (err) {
        console.error("[WC APPROVAL ERROR]", err);
      }
    })();

    // topic още го нямаме докато не се одобри -> връщаме само uri
    res.json({ ok: true, uri });
  } catch (err) {
    console.error("[/wc-uri] TypeError:", err?.message || err);
    res.status(500).json({ ok: false, error: err?.message || "wc-uri failed" });
  }
});

/**
 * 2) Дава последната свързана сесия (за показване във фронта)
 */
app.get("/wc-latest", (req, res) => {
  if (!lastSession) return res.json({ ok: true, connected: false });
  const { chainId, address, topic } = lastSession;
  res.json({
    ok: true,
    connected: true,
    topic,
    address,
    chainId,
    chainName: CHAIN_NAMES[chainId] || `Chain ${chainId}`
  });
});

/**
 * 3) Смяна на мрежата през WalletConnect (wallet_switchEthereumChain)
 *    POST { chainId }
 */
app.post("/wc-switch", async (req, res) => {
  try {
    const client = await ensureClient();
    if (!lastSession?.topic) {
      return res.status(400).json({ ok: false, error: "No active session" });
    }
    const { chainId } = req.body || {};
    if (!chainId) {
      return res.status(400).json({ ok: false, error: "Missing chainId" });
    }

    await client.request({
      topic: lastSession.topic,
      chainId: `eip155:${lastSession.chainId}`, // текущият chainId за маршрутизиране
      request: {
        method: "wallet_switchEthereumChain",
        params: [{ chainId: "0x" + Number(chainId).toString(16) }]
      }
    });

    // Ако портфейлът приеме – обновяваме lastSession.chainId:
    lastSession.chainId = Number(chainId);

    res.json({
      ok: true,
      chainId: lastSession.chainId,
      chainName: CHAIN_NAMES[lastSession.chainId] || `Chain ${lastSession.chainId}`
    });
  } catch (err) {
    console.error("[/wc-switch] ERROR", err);
    res.status(500).json({ ok: false, error: err?.message || "switch failed" });
  }
});

app.use(express.static("./public"));

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log("Listening on :", PORT);
});
