import express from "express";
import cors from "cors";
import SignClient from "@walletconnect/sign-client";

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static("public")); // ще сложим index.html в /public

// === Конфиг ===
const WC_PROJECT_ID = process.env.WC_PROJECT_ID || "2b73902ef2084063237c17f37e9b1e9e"; // твоя Project ID
const RELAY_URL = "wss://relay.walletconnect.com"; // по подразбиране
const METADATA = {
  name: "3DHome4U Login",
  description: "Login via WalletConnect / MetaMask",
  url: "https://wc-backend-tpug.onrender.com", // домейнът ти (allowlisted в Reown)
  icons: [
    "https://raw.githubusercontent.com/walletconnect/walletconnect-assets/master/Icon/Blue%20(Default)/Icon.png",
  ],
};

// Поддържани вериги
const CHAINS = {
  1:  { key: "eip155:1",    name: "Ethereum Mainnet", hex: "0x1" },
  56: { key: "eip155:56",   name: "BNB Chain",        hex: "0x38",
        add: {
          chainId: "0x38",
          chainName: "BNB Chain",
          nativeCurrency: { name: "BNB", symbol: "BNB", decimals: 18 },
          rpcUrls: ["https://bsc-dataseed.binance.org"],
          blockExplorerUrls: ["https://bscscan.com"]
        }
      },
  97: { key: "eip155:97",   name: "BNB Testnet",      hex: "0x61",
        add: {
          chainId: "0x61",
          chainName: "BNB Testnet",
          nativeCurrency: { name: "tBNB", symbol: "tBNB", decimals: 18 },
          rpcUrls: ["https://data-seed-prebsc-1-s1.binance.org:8545"],
          blockExplorerUrls: ["https://testnet.bscscan.com"]
        }
      },
  137:{ key: "eip155:137",  name: "Polygon",          hex: "0x89",
        add: {
          chainId: "0x89",
          chainName: "Polygon",
          nativeCurrency: { name: "MATIC", symbol: "MATIC", decimals: 18 },
          rpcUrls: ["https://polygon-rpc.com"],
          blockExplorerUrls: ["https://polygonscan.com"]
        }
      },
  59144:{ key: "eip155:59144", name: "Linea",         hex: "0xe704",
        add: {
          chainId: "0xe704",
          chainName: "Linea",
          nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 },
          rpcUrls: ["https://rpc.linea.build"],
          blockExplorerUrls: ["https://lineascan.build"]
        }
      }
};

const REQUIRED = {
  eip155: {
    methods: [
      "eth_requestAccounts",
      "eth_accounts",
      "eth_chainId",
      "eth_sign",
      "personal_sign",
      "eth_signTypedData",
      "eth_sendTransaction",
      "wallet_switchEthereumChain",
      "wallet_addEthereumChain",
    ],
    chains: Object.values(CHAINS).map((c) => c.key),
    events: ["chainChanged", "accountsChanged"],
  },
};

// Сингълтон на клиента/сесията
let client = null;
let currentSession = null;

// Инициализация на SignClient
async function getClient() {
  if (client) return client;
  client = await SignClient.init({
    projectId: WC_PROJECT_ID,
    relayUrl: RELAY_URL,
    metadata: METADATA,
  });
  // слушай апдейти – при сменена мрежа/акаунт обновяваме кеша
  client.on("session_update", ({ topic, params }) => {
    if (currentSession && topic === currentSession.topic) {
      const { namespaces } = params;
      currentSession.namespaces = namespaces;
    }
  });
  client.on("session_delete", () => {
    currentSession = null;
  });
  return client;
}

// Помощни
function parseFirstAccount(session) {
  // взимаме първия акаунт – wallet-ът обикновено връща текущата мрежа първа
  const accs = session?.namespaces?.eip155?.accounts || [];
  if (!accs.length) return { address: null, chainId: null };
  const [ns, chainIdStr, address] = accs[0].split(":");
  return { address, chainId: Number(chainIdStr) };
}

async function getLiveChainId(session) {
  // за по-сигурно пита портфейла коя е текущата верига
  try {
    const anyChain = Object.values(CHAINS)[0].key; // все някоя валидна
    const hex = await client.request({
      topic: session.topic,
      chainId: anyChain,
      request: { method: "eth_chainId", params: [] },
    });
    return parseInt(hex, 16) || null;
  } catch {
    return null;
  }
}

// === API ===

// Генерира QR (URI) и стартира очакване за одобрение
app.get("/wc-uri", async (req, res) => {
  try {
    const c = await getClient();

    // затвори стари pairing-и за да няма „pending“
    for (const p of c.core.pairing.getPairings()) {
      if (!p.active) await c.core.pairing.disconnect({ topic: p.topic });
    }

    const { uri, approval } = await c.connect({
      requiredNamespaces: REQUIRED,
    });

    // не чакаме тук – одобрението идва след сканиране
    approval()
      .then(async (session) => {
        currentSession = session;
        // опитай да определиш реалната текуща мрежа
        const fallback = parseFirstAccount(session);
        const live = (await getLiveChainId(session)) ?? fallback.chainId;
        if (live) {
          // подреди акаунтите така, че текущата мрежа да е първа (за фронта)
          const accs = session.namespaces.eip155.accounts.slice();
          const idx = accs.findIndex((a) => a.startsWith(`eip155:${live}:`));
          if (idx > 0) {
            const cur = accs.splice(idx, 1)[0];
            accs.unshift(cur);
            currentSession.namespaces.eip155.accounts = accs;
          }
        }
        console.log(`[WC APPROVED] ${session.topic}  chainId: ${live ?? fallback.chainId}  address: ${fallback.address}`);
      })
      .catch(() => { /* отхвърлена връзка */ });

    if (!uri) return res.status(500).json({ ok: false, error: "no_uri" });
    return res.json({ ok: true, uri });
  } catch (e) {
    console.error("[/wc-uri]", e);
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// Статус за фронта
app.get("/session", async (req, res) => {
  if (!currentSession) return res.json({ connected: false });
  const { address, chainId } = parseFirstAccount(currentSession);
  const chain = CHAINS[chainId] ? CHAINS[chainId].name : `eip155:${chainId}`;
  res.json({
    connected: true,
    topic: currentSession.topic,
    address,
    chainId,
    chainName: chain,
  });
});

// Смяна на мрежа
app.post("/switch", async (req, res) => {
  try {
    const { targetChainId } = req.body; // напр. 56, 137, 1, 97, 59144
    if (!currentSession) return res.status(400).json({ ok: false, error: "no_session" });
    const cfg = CHAINS[targetChainId];
    if (!cfg) return res.status(400).json({ ok: false, error: "unsupported_chain" });

    // ако веригата я няма във wallet-а, първо add
    try {
      await client.request({
        topic: currentSession.topic,
        chainId: cfg.key,
        request: {
          method: "wallet_switchEthereumChain",
          params: [{ chainId: cfg.hex }],
        },
      });
    } catch (e) {
      // MetaMask Mobile иска add преди switch при някои вериги
      if (cfg.add) {
        await client.request({
          topic: currentSession.topic,
          chainId: CHAINS[1].key, // рутни през валидна
          request: {
            method: "wallet_addEthereumChain",
            params: [cfg.add],
          },
        });
        await client.request({
          topic: currentSession.topic,
          chainId: cfg.key,
          request: {
            method: "wallet_switchEthereumChain",
            params: [{ chainId: cfg.hex }],
          },
        });
      } else {
        throw e;
      }
    }

    // изискай актуалния chainId и обнови реда на accounts
    const liveHex = await client.request({
      topic: currentSession.topic,
      chainId: cfg.key,
      request: { method: "eth_chainId", params: [] },
    });
    const live = parseInt(liveHex, 16);
    const accs = currentSession.namespaces.eip155.accounts.slice();
    const idx = accs.findIndex((a) => a.startsWith(`eip155:${live}:`));
    if (idx > 0) {
      const cur = accs.splice(idx, 1)[0];
      accs.unshift(cur);
      currentSession.namespaces.eip155.accounts = accs;
    }

    return res.json({ ok: true, chainId: live, chainName: CHAINS[live]?.name || live });
  } catch (e) {
    console.error("[/switch]", e);
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log("Listening on :", PORT);
  console.log("==> Your service is live");
});
