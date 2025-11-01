// server.js
import express from "express";
import cors from "cors";
import QRCode from "qrcode";

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static("public"));

/* ---------------- WalletConnect config ---------------- */
const WC_PROJECT_ID = process.env.WC_PROJECT_ID || "2b73902ef2084063237c17f37e9b1e9e";
const RELAY_URL = "wss://relay.walletconnect.com";

/**
 * Зареждаме SignClient по „устойчив“ начин, така че
 * независимо от ESM/CJS интероп да имаме клас с .init()
 */
async function loadSignClientCtor() {
  // Първо опит с основния entry
  const mod = await import("@walletconnect/sign-client");
  const maybe = mod?.default ?? mod?.SignClient ?? mod;

  if (maybe && typeof maybe.init === "function") return maybe;

  // Понякога в новите Node версии default е „модул“, а класът стои в .default.default
  const deep = maybe?.default;
  if (deep && typeof deep.init === "function") return deep;

  // Като авариен вариант – пробваме и CJS сборката (някои среди я изискват)
  try {
    const cjs = await import("@walletconnect/sign-client/dist/cjs/index.js");
    const ctor = cjs?.default ?? cjs?.SignClient ?? cjs;
    if (ctor && typeof ctor.init === "function") return ctor;
  } catch (_) {}

  throw new Error(
    "[WC IMPORT] SignClient.init not found. keys=" + Object.keys(mod || {})
  );
}

let wcClient = null;
let session = null; // ще държим активната сесия (за демо)

/** Инициализация (singleton) */
async function getClient() {
  if (wcClient) return wcClient;

  const SignClient = await loadSignClientCtor();

  wcClient = await SignClient.init({
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

  // Събитие: потребителят одобри сесия -> пазим topic, адрес, chainId
  wcClient.on("session_update", (ev) => {
    if (!session) return;
    const { namespaces } = ev.params;
    session.namespaces = namespaces;
  });

  wcClient.on("session_delete", () => {
    session = null;
  });

  return wcClient;
}

/* ------------- помощни: извличане на адрес и мрежа от session ------------- */

const CHAIN_NAMES = {
  1: "Ethereum Mainnet",
  56: "BNB Chain",
  137: "Polygon",
  59144: "Linea",
  97: "BNB Testnet"
};

function hexChainId(n) {
  return "0x" + Number(n).toString(16);
}

function readPrimaryAccount(namespaces) {
  // eip155 namespace
  const ns = namespaces?.eip155;
  if (!ns) return { address: null, chainId: null };

  const caipAddrs = ns.accounts || [];
  // взимаме първия, формат: "eip155:<chainId>:<address>"
  const parts = (caipAddrs[0] || "").split(":");
  const chainId = Number(parts[1] || 0);
  const address = parts[2] || null;
  return { address, chainId };
}

/* ----------------------- API ----------------------- */

// 1) генерира WC URI + QR (като картинка)
app.get("/wc-uri", async (req, res) => {
  try {
    const client = await getClient();

    // optionalNamespaces вместо requiredNamespaces (по-ново API, да няма warning)
    const { uri, approval } = await client.connect({
      optionalNamespaces: {
        eip155: {
          methods: [
            "eth_sendTransaction",
            "personal_sign",
            "eth_sign",
            "eth_signTypedData",
            "wallet_switchEthereumChain",
            "wallet_addEthereumChain"
          ],
          chains: ["eip155:1", "eip155:56", "eip155:97", "eip155:137", "eip155:59144"],
          events: ["chainChanged", "accountsChanged"]
        }
      }
    });

    if (!uri) {
      return res.status(500).json({ error: "No URI" });
    }

    const png = await QRCode.toDataURL(uri);

    // чакаме одобрение в бекграунд, но не блокираме UI – връщаме png и topic
    (async () => {
      try {
        session = await approval(); // { topic, namespaces, ... }
        const { address, chainId } = readPrimaryAccount(session.namespaces);
        console.log("[WC APPROVED]", session.topic, "chainId:", chainId, "address:", address);
      } catch (e) {
        console.error("[WC APPROVAL ERROR]", e);
      }
    })();

    res.json({ png, uri });
  } catch (e) {
    console.error("[/wc-uri] ERROR", e);
    res.status(500).json({ error: String(e.message || e) });
  }
});

// 2) статус за UI – адрес, име на мрежа и topic
app.get("/wc-status", (req, res) => {
  if (!session) {
    return res.json({ connected: false });
  }
  const { address, chainId } = readPrimaryAccount(session.namespaces);
  res.json({
    connected: true,
    topic: session.topic,
    address,
    chainId,
    chainName: CHAIN_NAMES[chainId] || `Chain ${chainId}`
  });
});

// 3) смяна на мрежа през WalletConnect (ако я няма – опит за add + switch)
app.post("/switch-chain", async (req, res) => {
  try {
    const { targetChainId } = req.body; // number
    if (!session) throw new Error("No active session");
    const client = await getClient();

    const hexId = hexChainId(targetChainId);
    const topic = session.topic;

    // wallet_switchEthereumChain
    try {
      await client.request({
        topic,
        chainId: `eip155:${targetChainId}`,
        request: {
          method: "wallet_switchEthereumChain",
          params: [{ chainId: hexId }]
        }
      });
    } catch (err) {
      // Ако портфейлът върне грешка „непозната мрежа“ – добавяме я
      if (String(err?.message || "").includes("Unrecognized chain ID")) {
        const paramsById = {
          56: {
            chainId: hexId,
            chainName: "BNB Chain",
            nativeCurrency: { name: "BNB", symbol: "BNB", decimals: 18 },
            rpcUrls: ["https://bsc-dataseed1.binance.org"],
            blockExplorerUrls: ["https://bscscan.com"]
          },
          137: {
            chainId: hexId,
            chainName: "Polygon",
            nativeCurrency: { name: "MATIC", symbol: "MATIC", decimals: 18 },
            rpcUrls: ["https://polygon-rpc.com"],
            blockExplorerUrls: ["https://polygonscan.com"]
          },
          59144: {
            chainId: hexId,
            chainName: "Linea",
            nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 },
            rpcUrls: ["https://rpc.linea.build"],
            blockExplorerUrls: ["https://lineascan.build"]
          }
        };
        const addParams = paramsById[targetChainId];
        if (addParams) {
          await client.request({
            topic,
            chainId: `eip155:${targetChainId}`,
            request: { method: "wallet_addEthereumChain", params: [addParams] }
          });
          // след add – пак switch
          await client.request({
            topic,
            chainId: `eip155:${targetChainId}`,
            request: { method: "wallet_switchEthereumChain", params: [{ chainId: hexId }] }
          });
        } else {
          throw err;
        }
      } else {
        throw err;
      }
    }

    // обновяваме локалния статус (ще дойде и session_update, но да не чакаме)
    const { address, chainId } = readPrimaryAccount(session.namespaces);
    res.json({
      ok: true,
      address,
      chainId,
      chainName: CHAIN_NAMES[chainId] || `Chain ${chainId}`
    });
  } catch (e) {
    console.error("[/switch-chain] ERROR", e);
    res.status(500).json({ error: String(e.message || e) });
  }
});

/* ----------------------- старт ----------------------- */
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log("Listening on :", PORT);
  console.log("==> Your service is live 🎉");
});
