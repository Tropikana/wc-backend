import express from "express";
import cors from "cors";

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static("public")); // ако имаш фронтенд тук

// === Конфиг ===
const WC_PROJECT_ID =
  process.env.WC_PROJECT_ID || "PUT_YOUR_PROJECT_ID_HERE";
const RELAY_URL = process.env.RELAY_URL || "wss://relay.walletconnect.com";
const APP_METADATA = {
  name: "3DHome4U Login",
  description: "Login via WalletConnect / MetaMask",
  url: "https://wc-backend-tpug.onrender.com",
  icons: ["https://walletconnect.com/meta/favicon.ico"]
};

// === Надежден loader за SignClient (+ кеш) ===
let signClientPromise = null;

async function getSignClient() {
  if (!signClientPromise) {
    signClientPromise = (async () => {
      const mod = await import("@walletconnect/sign-client");
      // модулът понякога идва като default, понякога като именован export
      const SignClient = mod?.default ?? mod?.SignClient ?? mod;
      if (!SignClient?.init) {
        throw new Error("SignClient.init not available (bad import)");
      }
      return await SignClient.init({
        projectId: WC_PROJECT_ID,
        relayUrl: RELAY_URL,
        metadata: APP_METADATA
      });
    })().catch((e) => {
      // ако има грешка – зануляваме кеша, за да опита пак на следваща заявка
      signClientPromise = null;
      throw e;
    });
  }
  return signClientPromise;
}

// === API за генериране на WC URI ===
app.get("/wc-uri", async (req, res) => {
  try {
    const client = await getSignClient();
    const { uri, topic } = await client.core.pairing.create({});

    if (!uri) {
      throw new Error("No WalletConnect URI returned");
    }

    res.json({ ok: true, uri, topic });
  } catch (err) {
    console.error("[/wc-uri] error:", err);
    res.status(500).json({
      ok: false,
      error: err?.message || String(err)
    });
  }
});

// health & корен
app.get("/", (_req, res) => res.send("WC backend OK"));

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log("Listening on :", PORT);
});
