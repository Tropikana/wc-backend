import express from "express";
import cors from "cors";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(cors());
app.use(express.json());

// статичен фронтенд
app.use(express.static(path.join(__dirname, "public")));

const PORT = process.env.PORT || 10000;
const WC_PROJECT_ID = process.env.WC_PROJECT_ID;

// позволени мрежи (eip155:<chainId>)
const CHAINS = [
  "eip155:1",     // Ethereum
  "eip155:56",    // BNB Chain
  "eip155:97",    // BNB Testnet
  "eip155:137",   // Polygon
  "eip155:59144", // Linea
];

// guard срещу паралелно генериране
let isGenerating = false;

async function getProvider() {
  // ВАЖНО: default import
  const UniversalProvider = (await import("@walletconnect/universal-provider")).default;

  const provider = await UniversalProvider.init({
    projectId: WC_PROJECT_ID,
    metadata: {
      name: "WC Login Demo",
      description: "Login via WalletConnect",
      url: process.env.PUBLIC_URL || "https://wc-backend-tpug.onrender.com",
      icons: ["https://avatars.githubusercontent.com/u/37784886?s=200&v=4"],
    },
  });

  return provider;
}

app.get("/wc-uri", async (req, res) => {
  if (!WC_PROJECT_ID) {
    return res.json({ ok: false, error: "missing_project_id" });
  }
  if (isGenerating) {
    return res.json({ ok: false, error: "busy" });
  }

  isGenerating = true;

  try {
    const provider = await getProvider();

    // Ще изчакаме display_uri (URI за QR)
    const uri = await new Promise(async (resolve, reject) => {
      let timer = setTimeout(() => reject(new Error("timeout")), 12000);

      const onceDisplay = (u) => {
        clearTimeout(timer);
        resolve(u);
      };

      provider.once("display_uri", onceDisplay);

      try {
        await provider.connect({
          namespaces: {
            eip155: {
              methods: [
                "eth_requestAccounts",
                "eth_accounts",
                "eth_chainId",
                "personal_sign",
                "eth_sign",
                "eth_signTypedData",
                "eth_sendTransaction",
              ],
              chains: CHAINS,
              events: ["accountsChanged", "chainChanged"],
            },
          },
        });
      } catch (err) {
        clearTimeout(timer);
        reject(err);
      }
    });

    const topic = provider?.session?.topic || null;

    return res.json({ ok: true, uri, topic });
  } catch (e) {
    console.error("[/wc-uri] ERROR:", e);
    return res.json({ ok: false, error: e?.message || "init_failed" });
  } finally {
    isGenerating = false;
  }
});

// index fallback (по избор; ако искаш SPA)
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, () => {
  console.log("Listening on :", PORT);
  console.log("==> Available at your primary URL",
    process.env.PUBLIC_URL || "http://localhost:" + PORT
  );
});
