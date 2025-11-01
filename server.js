// server.js (ESM)
import express from "express";
import cors from "cors";
import QRCode from "qrcode";
import UniversalProvider from "@walletconnect/universal-provider";

const app = express();
app.use(cors());
app.use(express.json());

// Настройки
const PORT = process.env.PORT || 10000;
const WC_PROJECT_ID = process.env.WC_PROJECT_ID; // задължително!
const APP_URL = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;

if (!WC_PROJECT_ID) {
  console.error("[BOOT] Missing WC_PROJECT_ID env var!");
}

// Памет за активни сесии/провайдъри по topic
const sessions = new Map(); // topic -> { provider, accounts[], chainId, address }

// Хелпъри
const parseAccount = (accStr) => {
  // формат: "eip155:137:0xabc..."
  const [, chainPart, address] = accStr.split(":");
  const chainId = Number(chainPart);
  return { chainId, address };
};

const chainLabel = (id) => {
  switch (id) {
    case 1: return "Ethereum Mainnet";
    case 56: return "BNB Chain";
    case 97: return "BNB Testnet";
    case 137: return "Polygon";
    case 59144: return "Linea";
    default: return `eip155:${id}`;
  }
};

// =========================
//   REST ЕНДПОИНТИ
// =========================

// 1) Генерирай WalletConnect URI + topic
app.get("/wc-uri", async (req, res) => {
  try {
    // Създаваме Universal Provider
    const provider = await UniversalProvider.init({
      projectId: WC_PROJECT_ID,
      metadata: {
        name: "WC Login Demo",
        description: "Demo login",
        url: APP_URL,
        icons: ["https://walletconnect.com/walletconnect-logo.png"]
      }
    });

    // Ще върнем URI през този промис (идва от събитието)
    const uriPromise = new Promise((resolve) => {
      provider.on("display_uri", (uri) => resolve(uri));
    });

    // Изискваме сесия (declare namespaces)
    // Тук позволяваме всички вериги, които искаш да поддържаш
    const methods = [
      "eth_sendTransaction",
      "eth_sign",
      "personal_sign",
      "eth_signTypedData",
      "wallet_switchEthereumChain"
    ];
    const events = ["accountsChanged", "chainChanged"];

    await provider.connect({
      namespaces: {
        eip155: {
          methods,
          events,
          chains: [
            "eip155:1",    // Ethereum
            "eip155:56",   // BNB Chain
            "eip155:97",   // BNB Testnet (ако я ползваш)
            "eip155:137",  // Polygon
            "eip155:59144" // Linea (пример)
          ]
        }
      }
    });

    // Изчакваме URI-то от display_uri
    const uri = await uriPromise;

    // След одобрение от потребителя ще получим session
    provider.on("session_update", (event) => {
      // при update – обновяваме паметта
      const sess = provider.session;
      if (!sess) return;
      const topic = sess.topic;
      const accounts = sess.namespaces.eip155?.accounts ?? [];
      const { chainId, address } = accounts.length ? parseAccount(accounts[0]) : { chainId: null, address: null };
      sessions.set(topic, { provider, accounts, chainId, address });
    });

    provider.on("session_delete", () => {
      // почисти от паметта
      const topic = provider.session?.topic;
      if (topic) sessions.delete(topic);
    });

    provider.on("display_uri", () => {
      // игнорираме следващи display_uri евенти
    });

    // Върни и бърз QR (по избор)
    const qrPng = await QRCode.toDataURL(uri);
    res.json({ ok: true, uri, qrPng });

  } catch (err) {
    console.error("[/wc-uri] ERROR:", err);
    res.status(500).json({ ok: false, error: String(err) });
  }
});

// 2) Статус по topic – адрес и мрежа (след като user е одобрил в MetaMask)
app.get("/status", async (req, res) => {
  try {
    // обхождаме всички провайдъри и гледаме дали вече имат session
    // (UniversalProvider няма „topic“ докато не се установи сесията;
    //  затова тук просто взимаме последната активна)
    let result = null;

    for (const [topic, data] of sessions.entries()) {
      const { chainId, address } = data;
      if (address && chainId) {
        result = { topic, address, chainId, network: chainLabel(chainId) };
        break;
      }
    }

    if (!result) return res.json({ ok: true, connected: false });

    res.json({ ok: true, connected: true, ...result });
  } catch (err) {
    console.error("[/status] ERROR:", err);
    res.status(500).json({ ok: false, error: String(err) });
  }
});

// 3) Статичните файлове (ако имаш /public/index.html)
app.use(express.static("public"));

app.listen(PORT, () => {
  console.log(`Listening on :${PORT}`);
  console.log(`==> Available at your primary URL ${APP_URL}`);
});
