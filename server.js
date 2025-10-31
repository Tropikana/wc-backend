import express from "express";
import cors from "cors";
import * as SignClientPkg from "@walletconnect/sign-client"; // хващаме namespace импорта
import crypto from "crypto";

const app = express();
app.use(express.json());
app.use(cors());

// Унифицирана фабрика за създаване на клиента – покрива всички варианти:
const makeSignClient = async (opts) => {
  // 1) ESM default експортира ФУНКЦИЯ (новите версии)
  if (typeof SignClientPkg?.default === "function") {
    return await SignClientPkg.default(opts);
  }
  // 2) ESM default експортира ОБЕКТ с .init (класическо 2.11.0 API)
  if (SignClientPkg?.default?.init) {
    return await SignClientPkg.default.init(opts);
  }
  // 3) Стар namespace с .init директно
  if (typeof SignClientPkg?.init === "function") {
    return await SignClientPkg.init(opts);
  }
  // 4) Някои сборки имат вътре ключ SignClient
  if (SignClientPkg?.SignClient?.init) {
    return await SignClientPkg.SignClient.init(opts);
  }
  throw new Error("WalletConnect sign-client: unknown export shape");
};

const signClient = await makeSignClient({
  projectId: process.env.WC_PROJECT_ID,
  relayUrl: "wss://relay.walletconnect.com",
  metadata: {
    name: "3DHome4U",
    description: "UE5 login via WalletConnect",
    // ВАЖНО: използвай домейн, който е в Reown allowlist (Render URL-а)
    url: "https://wc-backend-tpug.onrender.com",
    icons: ["https://wc-backend-tpug.onrender.com/icon.png"],
    // помага на някои уолети да се „върнат“ към приложението
    redirect: {
      native: "metamask://",
      universal: "https://metamask.app.link"
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
          methods: ["personal_sign","eth_sign","eth_signTypedData","eth_sendTransaction"],
          chains: ["eip155:1","eip155:137","eip155:25","eip155:338"], // ETH, Polygon, Cronos
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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`WalletConnect backend listening on :${PORT}`));

