// server.js
import express from "express";
import cors from "cors";
import QRCode from "qrcode";
import UniversalProviderModule from "@walletconnect/universal-provider";

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 10000;
const WC_PROJECT_ID = process.env.WC_PROJECT_ID || ""; // сложи си го в Render
const APP_URL = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;

// --- най-важно: нормализираме импорта ---
// някъде идва като default, някъде – директно
const UniversalProvider =
  typeof UniversalProviderModule.init === "function"
    ? UniversalProviderModule
    : UniversalProviderModule.default;

if (!UniversalProvider) {
  console.error("[BOOT] Cannot load @walletconnect/universal-provider");
}

const sessions = new Map(); // topic -> { provider, accounts, chainId, address }

const parseAccount = (accStr) => {
  const parts = accStr.split(":");
  // eip155:137:0x123...
  const chainId = Number(parts[1]);
  const address = parts[2];
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

// ========================
//  /wc-uri
// ========================
app.get("/wc-uri", async (req, res) => {
  try {
    if (!WC_PROJECT_ID) {
      return res.status(500).json({ ok: false, error: "Missing WC_PROJECT_ID" });
    }
    if (!UniversalProvider || typeof UniversalProvider.init !== "function") {
      return res.status(500).json({ ok: false, error: "UniversalProvider.init not available" });
    }

    // 1. init
    const provider = await UniversalProvider.init({
      projectId: WC_PROJECT_ID,
      metadata: {
        name: "WC Login Demo",
        description: "Demo login",
        url: APP_URL,
        icons: ["https://walletconnect.com/walletconnect-logo.png"]
      }
    });

    // 2. чакаме display_uri
    const uriPromise = new Promise((resolve) => {
      provider.on("display_uri", (uri) => {
        resolve(uri);
      });
    });

    // 3. connect с всички мрежи, които искаме
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
            "eip155:1",
            "eip155:56",
            "eip155:97",
            "eip155:137",
            "eip155:59144"
          ]
        }
      }
    });

    const uri = await uriPromise;
    const qrPng = await QRCode.toDataURL(uri);

    // 4. след като потребителят одобри, provider.session ще е наличен
    provider.on("session_update", () => {
      const sess = provider.session;
      if (!sess) return;
      const topic = sess.topic;
      const accounts = sess.namespaces.eip155?.accounts ?? [];
      const { chainId, address } =
        accounts.length ? parseAccount(accounts[0]) : { chainId: null, address: null };
      sessions.set(topic, { provider, accounts, chainId, address });
    });

    provider.on("session_delete", () => {
      const topic = provider.session?.topic;
      if (topic) sessions.delete(topic);
    });

    res.json({ ok: true, uri, qrPng });
  } catch (err) {
    console.error("[/wc-uri] ERROR:", err);
    res.status(500).json({ ok: false, error: String(err) });
  }
});

// ========================
//  /status
// ========================
app.get("/status", (req, res) => {
  // най-простият вариант – връщаме първата активна сесия
  for (const [topic, data] of sessions.entries()) {
    const { chainId, address } = data;
    if (address && chainId) {
      return res.json({
        ok: true,
        connected: true,
        topic,
        address,
        chainId,
        network: chainLabel(chainId)
      });
    }
  }
  return res.json({ ok: true, connected: false });
});

// статично (ако имаш public/)
app.use(express.static("public"));

app.listen(PORT, () => {
  console.log(`Listening on :${PORT}`);
  console.log(`==> Available at your primary URL ${APP_URL}`);
});
