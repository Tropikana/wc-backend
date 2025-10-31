import express from "express";
import cors from "cors";
import * as SignNS from "@walletconnect/sign-client";
import crypto from "crypto";

const app = express();
app.use(express.json());
app.use(cors());

/* -------------------- Конфиг -------------------- */
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
/* ------------------------------------------------ */

async function makeSignClient() {
  // помощник: опитай init() / new / фабрика; логваме формата, за да е стабилно
  const tryBuild = async (cand, label, tried) => {
    if (!cand) return null;
    tried.push(label);
    if (typeof cand?.init === "function") { try { return await cand.init(opts); } catch {} }
    try { return new cand(opts); } catch {}
    if (typeof cand === "function") { try { return await cand(opts); } catch {} }
    return null;
  };

  const tried = [];
  try {
    console.log("[WC] keys:", Object.keys(SignNS || {}));
    if (SignNS?.default && typeof SignNS.default === "object") {
      console.log("[WC] default keys:", Object.keys(SignNS.default));
    }
  } catch {}

  let c =
    (await tryBuild(SignNS?.SignClient, "SignNS.SignClient", tried)) ||
    (await tryBuild(SignNS?.default?.SignClient, "default.SignClient", tried)) ||
    (await tryBuild(SignNS?.default, "default", tried)) ||
    (await tryBuild(SignNS, "namespace", tried));

  if (!c) {
    try {
      const Dist = await import("@walletconnect/sign-client/dist/index.js");
      const D = Dist?.SignClient ?? Dist?.default?.SignClient ?? Dist?.default ?? Dist;
      c = (await tryBuild(D, "dist/index", tried)) || (await tryBuild(D?.SignClient, "dist/index SignClient", tried));
    } catch {}
  }
  if (!c) {
    try {
      const DistEsm = await import("@walletconnect/sign-client/dist/esm/index.js");
      const D = DistEsm?.SignClient ?? DistEsm?.default?.SignClient ?? DistEsm?.default ?? DistEsm;
      c = (await tryBuild(D, "dist/esm/index", tried)) || (await tryBuild(D?.SignClient, "dist/esm/index SignClient", tried));
    } catch {}
  }

  if (!c) {
    console.error("[WC] tried:", tried.join(" -> "));
    throw new Error("Cannot create WalletConnect SignClient from any export shape");
  }
  console.log("[WC] created via:", tried.at(-1));

  // ⚠️ важно: стартира вътрешния engine
  if (c?.core?.start) await c.core.start();

  return c;
}

const signClient = await makeSignClient();

/* In-memory състояние */
const pendings = new Map(); // id -> { approval, session|null, createdAt }
const nonces   = new Map(); // id -> nonce (за login подпис)

const utf8ToHex = (s) => "0x" + Buffer.from(s, "utf8").toString("hex");

/* 1) Връща wc: URI за QR */
app.get("/wc-uri", async (_req, res) => {
  try {
    // допълнителна гаранция при студен старт на Render
    if (signClient?.core?.start) await signClient.core.start();
    await new Promise(r => setTimeout(r, 100));

    const { uri, approval } = await signClient.connect({
      // Може да оставиш и „широките“ изисквания, но за по-сигурен Connect:
      // препоръчвам минимален required + optional (виж коментара по-долу).
      // Тук използвам „твоята“ широка версия (както в Server.txt):
      requiredNamespaces: {
        eip155: {
          methods: ["personal_sign", "eth_sign", "eth_signTypedData", "eth_sendTransaction"],
          chains:  ["eip155:1", "eip155:137", "eip155:25", "eip155:338"],
          events:  ["accountsChanged", "chainChanged"]
        }
      }

      /* Алтернатива (по-надежден Connect):
      requiredNamespaces: {
        eip155: { chains: ["eip155:1"], methods: ["personal_sign"], events: ["accountsChanged","chainChanged"] }
      },
      optionalNamespaces: {
        eip155: { chains: ["eip155:137","eip155:25","eip155:338"], methods: ["eth_sign","eth_signTypedData","eth_sendTransaction"], events: ["accountsChanged","chainChanged"] }
      }
      */
    });

    if (!uri) return res.status(500).json({ error: "No URI returned" });

    const id = crypto.randomUUID();
    pendings.set(id, { approval, session: null, createdAt: Date.now() });

    approval()
      .then((session) => {
        const acct = session.namespaces.eip155.accounts[0]; // "eip155:<chainId>:0x..."
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

/* 2) Проверка на статуса */
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

/* 3) Задейства подпис (login) чрез personal_sign */
app.post("/wc-login", async (req, res) => {
  try {
    const id = String(req.body?.id || "");
    const item = pendings.get(id);
    if (!item || !item.session) return res.status(400).json({ error: "no_session" });

    const { topic, address, chainId } = item.session;

    const nonce = crypto.randomBytes(8).toString("hex");
    nonces.set(id, nonce);

    const message =
      `Login to 3DHome4U\n` +
      `Address: ${address}\n` +
      `Nonce: ${nonce}\n` +
      `Issued At: ${new Date().toISOString()}`;

    const signature = await signClient.request({
      topic,
      chainId: `eip155:${chainId || 1}`,
      request: {
        method: "personal_sign",
        params: [utf8ToHex(message), address] // MetaMask иска hex-съобщение + адрес
      }
    });

    res.json({ address, message, signature });
  } catch (e) {
    res.status(500).json({ error: e?.message || "sign failed" });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`WalletConnect backend listening on :${PORT}`));
