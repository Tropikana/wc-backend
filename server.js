import express from "express";
import cors from "cors";
import * as SignNS from "@walletconnect/sign-client";
import crypto from "crypto";

const app = express();
app.use(express.json());
app.use(cors());

const opts = {
  projectId: process.env.WC_PROJECT_ID,
  relayUrl: "wss://relay.walletconnect.com",
  metadata: {
    name: "3DHome4U",
    description: "UE5 login via WalletConnect",
    url: "https://wc-backend-tpug.onrender.com",
    icons: ["https://wc-backend-tpug.onrender.com/icon.png"],
    redirect: { native: "metamask://", universal: "https://metamask.app.link" }
  }
};

// --- Create SignClient (в твоя билд е клас) + start engine
const SignClient = SignNS.SignClient ?? SignNS.default?.SignClient;
if (!SignClient) throw new Error("SignClient class not found in @walletconnect/sign-client");
const signClient = new SignClient(opts);
if (signClient?.core?.start) await signClient.core.start();

// In-memory storage
const pendings = new Map(); // id -> { approval, session|null, createdAt }
const nonces = new Map();   // id -> last nonce (за алтернативна валидация)

// Helpers
const utf8ToHex = (s) => "0x" + Buffer.from(s, "utf8").toString("hex");

// 1) Връща wc: URI за QR
app.get("/wc-uri", async (_req, res) => {
  try {
    // важно: подсигуряваме engine-а точно преди connect
    await signClient.core.start();
    await new Promise(r => setTimeout(r, 100));
    
    const { uri, approval } = await signClient.connect({
      requiredNamespaces: {
        eip155: {
          chains: ["eip155:1"],                 // минимално за да се покаже Connect
          methods: ["personal_sign"],
          events: ["accountsChanged", "chainChanged"]
        }
      },
      optionalNamespaces: {
        eip155: {
          chains: ["eip155:137", "eip155:25", "eip155:338"], // Polygon + Cronos
          methods: ["eth_sign", "eth_signTypedData", "eth_sendTransaction"],
          events: ["accountsChanged", "chainChanged"]
        }
      }
    });

    if (!uri) return res.status(500).json({ error: "No URI returned" });

    const id = crypto.randomUUID();
    pendings.set(id, { approval, session: null, createdAt: Date.now() });

    approval()
      .then((session) => {
        const acct = session.namespaces.eip155.accounts[0]; // "eip155:1:0x..."
        const [, chainStr, addr] = acct.split(":");
        pendings.set(id, {
          approval: null,
          session: { topic: session.topic, address: addr, chainId: Number(chainStr) },
          createdAt: Date.now()
        });
      })
      .catch(() => pendings.delete(id));

    res.json({ id, uri });
  } catch (e) {
    res.status(500).json({ error: e?.message || "connect failed" });
  }
});

// 2) Проверка на статуса
app.get("/wc-status", (req, res) => {
  const id = String(req.query.id || "");
  const item = pendings.get(id);
  if (!item) return res.json({ status: "not_found" });
  if (item.session) return res.json({ status: "approved", ...item.session });

  if (Date.now() - item.createdAt > 2 * 60 * 1000) {
    pendings.delete(id);
    return res.json({ status: "expired" });
  }
  res.json({ status: "pending" });
});

// 3) Задейства подпис за логин (personal_sign)
app.post("/wc-login", async (req, res) => {
  try {
    const id = String(req.body?.id || "");
    const item = pendings.get(id);
    if (!item || !item.session) return res.status(400).json({ error: "no_session" });

    const { topic, address, chainId } = item.session;

    // проста nonce-базирана „Sign-In“
    const nonce = crypto.randomBytes(8).toString("hex");
    nonces.set(id, nonce);

    const message =
      `Login to 3DHome4U\n` +
      `Address: ${address}\n` +
      `Nonce: ${nonce}\n` +
      `Issued At: ${new Date().toISOString()}`;

    const hexMsg = utf8ToHex(message);

    const signature = await signClient.request({
      topic,
      chainId: `eip155:${chainId || 1}`,
      request: {
        method: "personal_sign",
        params: [hexMsg, address] // MetaMask приема hex + адрес
      }
    });

    // тук можеш да валидираш подписа (ecrecover) и да издадеш JWT/сесия
    res.json({ signature, message, address });
  } catch (e) {
    res.status(500).json({ error: e?.message || "sign failed" });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`WalletConnect backend listening on :${PORT}`));
