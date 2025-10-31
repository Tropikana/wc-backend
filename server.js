import express from "express";
import cors from "cors";
import * as SignNS from "@walletconnect/sign-client";
import crypto from "crypto";

const app = express();
app.use(express.json());
app.use(cors());

// ---------- WalletConnect клиент (клас) ----------
const opts = {
  projectId: process.env.WC_PROJECT_ID,
  relayUrl: "wss://relay.walletconnect.com",
  metadata: {
    name: "3DHome4U",
    description: "UE5 login via WalletConnect",
    url: "https://wc-backend-tpug.onrender.com",     // домейнът ти от allowlist
    icons: ["https://wc-backend-tpug.onrender.com/icon.png"],
    redirect: { native: "metamask://", universal: "https://metamask.app.link" }
  }
};

// В твоя билд пакетът има клас SignClient → ползваме new
const SignClient = SignNS.SignClient ?? SignNS.default?.SignClient;
if (!SignClient) {
  throw new Error("SignClient class not found in @walletconnect/sign-client");
}
const signClient = new SignClient(opts);

// ВАЖНО: стартира вътрешния engine преди да ползваш connect()
await signClient.core.start();
// -------------------------------------------------

// Проста памет за чакащи сесии
const pendings = new Map(); // id -> { approval, session|null, createdAt }

// 1) Връща wc: URI за QR
app.get("/wc-uri", async (_req, res) => {
  try {
    const { uri, approval } = await signClient.connect({
      // Минимално изискване за да се покаже 'Connect'
      requiredNamespaces: {
        eip155: {
          chains: ["eip155:1"],                 // само ETH mainnet за първия екран
          methods: ["personal_sign"],
          events: ["accountsChanged", "chainChanged"]
        }
      },
      // Пожелателно – MetaMask може да добави след Connect
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

    // чакаме одобрение в уолета
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

  // изтичане след ~2 мин
  if (Date.now() - item.createdAt > 2 * 60 * 1000) {
    pendings.delete(id);
    return res.json({ status: "expired" });
  }
  res.json({ status: "pending" });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`WalletConnect backend listening on :${PORT}`));
