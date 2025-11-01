import express from "express";
import cors from "cors";
import { v4 as uuid } from "uuid";

// -------- WalletConnect client (ленив) --------
let wcClient = null;

// позволени вериги (добавяш/махаш по желание)
const ALLOWED_CHAINS = [
  "eip155:1",     // Ethereum Mainnet
  "eip155:56",    // BNB Chain
  "eip155:97",    // BNB Testnet
  "eip155:137",   // Polygon
  "eip155:59144"  // Linea
];

const REQUIRED_METHODS = [
  "eth_requestAccounts",
  "eth_sendTransaction",
  "eth_sign",
  "eth_signTransaction",
  "eth_signTypedData",
  "personal_sign",
  "wallet_switchEthereumChain"
];
const REQUIRED_EVENTS = ["accountsChanged", "chainChanged"];

const WC_PROJECT_ID = process.env.WC_PROJECT_ID || ""; // <— сложи си го в env (Render)
if (!WC_PROJECT_ID) {
  console.warn("[BOOT] WC_PROJECT_ID липсва! Сложи Project ID от WalletConnect Cloud.");
}

// helpers
const refToId = (ref) => Number(String(ref).split(":")[1] || 0);
const idToHex = (n) => "0x" + Number(n).toString(16);

// за бързо име на мрежа
const chainName = (ref) => {
  const id = refToId(ref);
  const map = {
    1: "Ethereum Mainnet",
    56: "BNB Chain",
    97: "BNB Testnet",
    137: "Polygon",
    59144: "Linea",
    42161: "Arbitrum One",
    43114: "Avalanche C-Chain",
    25: "Cronos",
    338: "Cronos Testnet"
  };
  return map[id] || ref;
};

// Състояние в паметта
// pending[id] = { uri, approval, chains }
const pending = new Map();
// sessions[topic] = { topic, address, chainRef, chains, session }
const sessions = new Map();

async function getSignClient() {
  if (wcClient) return wcClient;

  // robust import за ESM/CJS среди
  const mod = await import("@walletconnect/sign-client");
  const SignClient = mod?.default || mod?.SignClient || mod;

  if (!SignClient?.init) {
    throw new Error("SignClient.init not available (bad import)");
  }

  wcClient = await SignClient.init({
    projectId: WC_PROJECT_ID,
    relayUrl: "wss://relay.walletconnect.com",
    metadata: {
      name: "3DHome4U Login",
      description: "Login via WalletConnect / MetaMask",
      url: "https://www.3dhome4u.com/",
      icons: ["https://walletconnect.com/meta/favicon.png"]
    }
  });

  // слушаме session_update и session_delete
  wcClient.on("session_update", ({ topic, params }) => {
    const eip = params?.namespaces?.eip155;
    const acc = eip?.accounts?.[0] || "";
    const [, chainIdStr, address] = acc.split(":");
    const chainRef = chainIdStr ? `eip155:${chainIdStr}` : undefined;

    const rec = sessions.get(topic);
    if (rec) {
      if (address) rec.address = address;
      if (chainRef) rec.chainRef = chainRef;
      sessions.set(topic, rec);
      console.log(`[WC UPDATE] topic=${topic} chain=${chainRef} addr=${address}`);
    }
  });

  wcClient.on("session_delete", ({ topic }) => {
    sessions.delete(topic);
    console.log(`[WC DELETE] topic=${topic}`);
  });

  return wcClient;
}

function serializeApproved(rec) {
  return {
    status: "approved",
    topic: rec.topic,
    address: rec.address,
    chainRef: rec.chainRef,
    networkName: chainName(rec.chainRef),
    chains: rec.chains
  };
}

// -------- HTTP API --------
const app = express();
app.use(cors());
app.use(express.json());

// serve UI
app.get("/", (_, res) => res.sendFile(new URL("./index.html", import.meta.url).pathname));
app.use(express.static(new URL(".", import.meta.url).pathname));

/**
 * GET /wc-uri
 * Генерира pairing URI и започва connect()
 */
app.get("/wc-uri", async (req, res) => {
  try {
    const client = await getSignClient();

    const { uri, approval } = await client.connect({
      requiredNamespaces: {
        eip155: {
          methods: REQUIRED_METHODS,
          chains: ALLOWED_CHAINS,
          events: REQUIRED_EVENTS
        }
      }
    });

    if (!uri) {
      return res.status(500).json({ error: "No pairing URI" });
    }

    const id = uuid();
    pending.set(id, { uri, approval, chains: ALLOWED_CHAINS });

    // когато бъде одобрено – запиши сесията
    approval()
      .then((session) => {
        const eip = session?.namespaces?.eip155;
        const acc = eip?.accounts?.[0] || "";
        const [ns, chainIdStr, address] = acc.split(":");
        const chainRef = `${ns}:${chainIdStr}`;
        const topic = session.topic;

        const rec = {
          topic,
          address,
          chainRef,
          chains: ALLOWED_CHAINS,
          session
        };
        sessions.set(topic, rec);

        // маркирай и pending[id] като готов
        const p = pending.get(id);
        if (p) p.approved = rec;
        console.log(
          `[WC APPROVED] ${id} chainId: ${chainIdStr}, address: ${address}`
        );
      })
      .catch((err) => {
        console.warn("[WC approval error]", err?.message || err);
      });

    res.json({ id, uri });
  } catch (e) {
    console.error("[/wc-uri] error:", e?.message || e);
    res.status(500).json({ error: e?.message || "wc-uri failed" });
  }
});

/**
 * GET /wc-status?id=...
 * Връща:
 *  - {status:"pending"} докато чакаме approve
 *  - {status:"approved", address, networkName, ...} след одобрение
 *  - {status:"not_found"} ако няма нищо
 * Ако няма id, връща първата активна сесия (ако има).
 */
app.get("/wc-status", (req, res) => {
  const { id } = req.query;

  if (id && pending.has(id)) {
    const p = pending.get(id);
    if (p.approved) return res.json(serializeApproved(p.approved));
    return res.json({ status: "pending" });
  }

  // без id -> върни някоя активна сесия
  const first = sessions.values().next().value;
  if (first) return res.json(serializeApproved(first));

  res.json({ status: "not_found" });
});

/**
 * POST /wc-switch
 * body: { topic, chainRef }
 * Изпраща wallet_switchEthereumChain към портфейла.
 */
app.post("/wc-switch", async (req, res) => {
  try {
    const { topic, chainRef } = req.body || {};
    if (!topic || !chainRef) return res.status(400).json({ error: "Bad params" });

    const client = await getSignClient();

    const hexId = idToHex(refToId(chainRef));
    await client.request({
      topic,
      chainId: chainRef,
      request: {
        method: "wallet_switchEthereumChain",
        params: [{ chainId: hexId }]
      }
    });

    // някои портфейли пращат session_update; но за всеки случай – обнови локално
    const rec = sessions.get(topic);
    if (rec) {
      rec.chainRef = chainRef;
      sessions.set(topic, rec);
    }

    res.json({ ok: true });
  } catch (e) {
    console.error("[/wc-switch] error:", e?.message || e);
    res.status(500).json({ error: e?.message || "switch failed" });
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`Listening on :${PORT}`);
  console.log("==> Your service is live 🎉");
});
