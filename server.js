import express from "express";
import cors from "cors";
import SignClient from "@walletconnect/sign-client";
import crypto from "crypto";

const app = express();
app.use(express.json());
app.use(cors());

// Инициализация на WalletConnect клиента (ползва Project ID от ENV)
const signClient = await SignClient.init({
  projectId: process.env.WC_PROJECT_ID, // <-- ще го зададем при deploy
  relayUrl: "wss://relay.walletconnect.com",
  metadata: {
    name: "3DHome4U UE5",
    description: "Login via WalletConnect",
    url: "https://www.3dhome4u.com",
    icons: ["https://www.3dhome4u.com/favicon.ico"]
  }
});

// Проста памет за чакащи сесии (за продакшън -> Redis/DB)
const pendings = new Map(); // id -> { approval, session|null, createdAt }

// 1) Взимане на wc: URI за QR
app.get("/wc-uri", async (req, res) => {
  try {
    const { uri, approval } = await signClient.connect({
      requiredNamespaces: {
        eip155: {
          methods: ["personal_sign","eth_signTypedData","eth_sendTransaction"],
          chains: ["eip155:25","eip155:338"], // Cronos mainnet/testnet
          events: ["accountsChanged","chainChanged"]
        }
      }
    });

    if (!uri) return res.status(500).json({ error: "No URI returned" });

    const id = crypto.randomUUID();
    pendings.set(id, { approval, session: null, createdAt: Date.now() });

    // изчакваме одобрение в MetaMask (асинхронно)
    approval().then((session) => {
      const acct = session.namespaces.eip155.accounts[0]; // "eip155:25:0xabc..."
      const [, chainStr, addr] = acct.split(":");
      pendings.set(id, {
        approval: null,
        session: { topic: session.topic, address: addr, chainId: Number(chainStr) },
        createdAt: Date.now()
      });
    }).catch(() => pendings.delete(id));

    res.json({ id, uri }); // <-- това 'uri' ще стане QR в UE5
  } catch (e) {
    res.status(500).json({ error: e?.message || "connect failed" });
  }
});

// 2) Проверка на статуса на сесията
app.get("/wc-status", (req, res) => {
  const id = String(req.query.id || "");
  const item = pendings.get(id);
  if (!item) return res.json({ status: "not_found" });

  if (item.session) return res.json({ status: "approved", ...item.session });

  // изтичане след 2 минути
  if (Date.now() - item.createdAt > 2 * 60 * 1000) {
    pendings.delete(id);
    return res.json({ status: "expired" });
  }
  return res.json({ status: "pending" });
});

app.listen(3000, () => console.log("WalletConnect backend listening on :3000"));
