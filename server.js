import express from "express";
import cors from "cors";
import * as SignNS from "@walletconnect/sign-client";
import crypto from "crypto";

const app = express();
app.use(express.json());
app.use(cors());

// ---------- УСТОЙЧИВО СЪЗДАВАНЕ НА КЛИЕНТА ----------
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

async function makeSignClient() {
  // помощник: опитай init() / new / direct-call
  const tryBuild = async (cand, label, tried) => {
    if (!cand) return null;
    tried.push(label);

    // 1) init()
    if (typeof cand?.init === "function") {
      try { return await cand.init(opts); } catch {}
    }
    // 2) new Class()
    try {
      // ако е клас – това ще успее
      return new cand(opts);
    } catch {}
    // 3) direct call като фабрика
    if (typeof cand === "function") {
      try { return await cand(opts); } catch {}
    }
    return null;
  };

  const tried = [];

  // полезен лог за формата на модула
  try {
    console.log("[WC] keys:", Object.keys(SignNS || {}));
    if (SignNS?.default && typeof SignNS.default === "object") {
      console.log("[WC] default keys:", Object.keys(SignNS.default));
    }
  } catch {}

  // последователност от кандидати (най-вероятни първи)
  let c =
    (await tryBuild(SignNS?.SignClient, "SignNS.SignClient", tried)) ||
    (await tryBuild(SignNS?.default?.SignClient, "default.SignClient", tried)) ||
    (await tryBuild(SignNS?.default, "default", tried)) ||
    (await tryBuild(SignNS, "namespace", tried));

  // пробвай и dist входни точки
  if (!c) {
    try {
      const Dist = await import("@walletconnect/sign-client/dist/index.js");
      const D = Dist?.SignClient ?? Dist?.default?.SignClient ?? Dist?.default ?? Dist;
      c =
        (await tryBuild(D, "dist/index", tried)) ||
        (await tryBuild(D?.SignClient, "dist/index SignClient", tried));
    } catch {}
  }
  if (!c) {
    try {
      const DistEsm = await import("@walletconnect/sign-client/dist/esm/index.js");
      const D = DistEsm?.SignClient ?? DistEsm?.default?.SignClient ?? DistEsm?.default ?? DistEsm;
      c =
        (await tryBuild(D, "dist/esm/index", tried)) ||
        (await tryBuild(D?.SignClient, "dist/esm/index SignClient", tried));
    } catch {}
  }

  if (!c) {
    console.error("[WC] tried:", tried.join(" -> "));
    throw new Error("Cannot create WalletConnect SignClient from any export shape");
  }
  console.log("[WC] created via:", tried.at(-1));
  return c;
}

const signClient = await makeSignClient();
// ----------------------------------------------------

// Памет за чакащи сесии
const pendings = new Map(); // id -> { approval, session|null, createdAt }

// 1) Връща wc: URI за QR
app.get("/wc-uri", async (_req, res) => {
  try {
    const { uri, approval } = await signClient.connect({
      // минимални изисквания за първия екран (да изкара Connect)
      requiredNamespaces: {
        eip155: {
          chains: ["eip155:1"],              // само Ethereum mainnet
          methods: ["personal_sign"],        // най-безобидният метод
          events: ["accountsChanged","chainChanged"]
        }
      },
      // всичко друго – пожелателно (MetaMask ще го добави след connect)
      optionalNamespaces: {
        eip155: {
          chains: ["eip155:137","eip155:25","eip155:338"], // Polygon + Cronos
          methods: ["eth_sign","eth_signTypedData","eth_sendTransaction"],
          events: ["accountsChanged","chainChanged"]
        }
      }
    });

    if (!uri) return res.status(500).json({ error: "No URI returned" });

    const id = crypto.randomUUID();
    pendings.set(id, { approval, session: null, createdAt: Date.now() });

    approval().then((session) => {
      const acct = session.namespaces.eip155.accounts[0]; // "eip155:1:0x..."
      const [, chainStr, addr] = acct.split(":");
      pendings.set(id, {
        approval: null,
        session: { topic: session.topic, address: addr, chainId: Number(chainStr) },
        createdAt: Date.now()
      });
    }).catch(() => pendings.delete(id));

    res.json({ id, uri });
  } catch (e) {
    res.status(500).json({ error: e?.message || "connect failed" });
  }
});

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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`WalletConnect backend listening on :${PORT}`));
