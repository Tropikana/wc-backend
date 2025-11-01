import express from "express";
import cors from "cors";
import UniversalProvider from "@walletconnect/universal-provider";

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 10000;
const PROJECT_ID = process.env.WC_PROJECT_ID; // поставете вашия Project ID от WalletConnect Cloud

if (!PROJECT_ID) {
  console.error("Missing WC_PROJECT_ID env var.");
  process.exit(1);
}

/**
 * Поддържаме един provider в процеса + текущата сесия/топик
 */
let provider = null;
let session = null;       // последната одобрена сесия
let lastUri = null;       // последният генериран wc: URI

// Човешки имена за веригите
const CHAIN_NAME = {
  1: "Ethereum Mainnet",
  56: "BNB Chain",
  97: "BNB Testnet",
  137: "Polygon",
  59144: "Linea",
};

// позволени вериги (можете да разширявате)
const EIP155_CHAINS = [1, 56, 97, 137, 59144];

/**
 * Инициализация (еднократно)
 */
async function getProvider() {
  if (provider) return provider;

  provider = await UniversalProvider.init({
    projectId: PROJECT_ID,
    metadata: {
      name: "3DHome4U Login",
      description: "Login via WalletConnect / MetaMask",
      url: "https://3dhome4u.com",
      icons: ["https://walletconnect.com/walletconnect-logo.png"],
    },
  });

  // Събития
  provider.on("display_uri", (uri) => {
    lastUri = uri; // QR за сканиране
  });

  provider.on("session_delete", () => {
    session = null;
  });

  provider.on("session_ping", () => {/* noop */});
  provider.on("session_event", () => {/* noop */});

  return provider;
}

/**
 * Генериране на QR (wc: uri) за логване.
 * Може да поискате специфична верига чрез query ?chainId=137 и т.н.,
 * но по-долу оставяме „опционални“ вериги – потребителят избира в портфейла.
 */
app.get("/wc-uri", async (_req, res) => {
  try {
    const p = await getProvider();

    // зануляваме старото, за да вдигнем ново събитие display_uri
    lastUri = null;
    session = null;

    // Искаме достъп до eip155 за изброените вериги
    const chains = EIP155_CHAINS.map((id) => `eip155:${id}`);

    // ВАЖНО: UniversalProvider работи с namespaces (optionalNamespaces е достатъчно).
    // Методи, които ви трябват: четене, подпис, изпращане и СМЯНА на мрежа.
    const optionalNamespaces = {
      eip155: {
        methods: [
          "eth_chainId",
          "eth_sendTransaction",
          "eth_sign",
          "eth_signTypedData",
          "personal_sign",
          "wallet_switchEthereumChain",
        ],
        chains,
        events: ["chainChanged", "accountsChanged"],
      },
    };

    // Взимаме URI чрез събитието 'display_uri'.
    // След това чакаме одобрение (approval()) да върне сесията.
    const waitForUri = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("No wc:uri")), 15000);
      const check = () => {
        if (lastUri) {
          clearTimeout(timeout);
          resolve(lastUri);
        } else {
          setTimeout(check, 50);
        }
      };
      check();
    });

    const approvalPromise = p.connect({ optionalNamespaces });
    const uri = await waitForUri; // QR за фронтенда

    // Паралелно чакаме приемането
    approvalPromise.then((_session) => {
      session = _session;
    }).catch(() => {/* игнорираме тук; фронтът ще пита /status */});

    res.json({ ok: true, uri });
  } catch (err) {
    console.error("[/wc-uri] ERROR:", err);
    res.status(500).json({ ok: false, error: String(err.message || err) });
  }
});

/**
 * Статус – връща адрес (съкратен) и човешко име на мрежата.
 */
app.get("/status", async (_req, res) => {
  try {
    if (!session) {
      return res.json({ ok: true, status: "not_found" });
    }

    // В eip155.accounts стойностите са "eip155:{CHAIN_ID}:{ADDRESS}"
    const accs = session.namespaces?.eip155?.accounts || [];
    const first = accs[0]; // вземаме първия
    if (!first) return res.json({ ok: true, status: "not_found" });

    const [, chainIdStr, address] = first.split(":"); // ["eip155","137","0x..."]
    const chainId = Number(chainIdStr);
    const networkName = CHAIN_NAME[chainId] || `Chain ${chainId}`;

    const short = address
      ? `${address.slice(0, 6)}...${address.slice(-4)}`
      : "";

    res.json({
      ok: true,
      status: "connected",
      topic: session.topic,
      address,
      addressShort: short,
      chainId,
      networkName,
    });
  } catch (err) {
    console.error("[/status] ERROR:", err);
    res.status(500).json({ ok: false, error: String(err.message || err) });
  }
});

/**
 * Смяна на мрежа от бутоните (пример: { "chainId": 137 }).
 * За MetaMask: params.chainId трябва да е hex (0x89 за Polygon, 0x38 за BNB и т.н.).
 */
app.post("/switch-chain", async (req, res) => {
  try {
    const p = await getProvider();
    if (!session) return res.status(400).json({ ok: false, error: "No active session" });

    const target = Number(req.body?.chainId);
    if (!EIP155_CHAINS.includes(target)) {
      return res.status(400).json({ ok: false, error: "Unsupported chain" });
    }

    // hex без leading zeros
    const hex = "0x" + target.toString(16);

    // заявката се препраща през WalletConnect към портфейла
    await p.request({
      topic: session.topic,
      chainId: `eip155:${target}`,
      request: {
        method: "wallet_switchEthereumChain",
        params: [{ chainId: hex }],
      },
    });

    // Обновяваме статуса
    const accs = session.namespaces?.eip155?.accounts || [];
    const first = accs[0] || "";
    const [, , address] = first.split(":");
    res.json({
      ok: true,
      address,
      chainId: target,
      networkName: CHAIN_NAME[target] || `Chain ${target}`,
    });
  } catch (err) {
    console.error("[/switch-chain] ERROR:", err);
    res.status(500).json({ ok: false, error: String(err.message || err) });
  }
});

/**
 * Отписване (по избор)
 */
app.post("/disconnect", async (_req, res) => {
  try {
    if (provider && session) {
      await provider.disconnect();
    }
    session = null;
    lastUri = null;
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err.message || err) });
  }
});

app.listen(PORT, () => {
  console.log(`Listening on :${PORT}`);
});
