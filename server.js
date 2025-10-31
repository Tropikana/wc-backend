import express from "express";
import cors from "cors";
import * as SignNS from "@walletconnect/sign-client";
import crypto from "crypto";

const app = express();
app.use(express.json());
app.use(cors());

// ---------- устойчиво създаване на клиента ----------
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

// ще опитаме няколко възможни експорта
async function makeSignClient() {
  const tried = [];

  // помощник: опитай да инициализираш по два начина
  const tryBuild = async (cand, label) => {
    if (!cand) return null;
    tried.push(label);
    if (typeof cand === "function") {
      return await cand(opts);
    }
    if (typeof cand?.init === "function") {
      return await cand.init(opts);
    }
    return null;
  };

  // логни какво реално виждаме в пакета (еднократно)
  try {
    const keys = Object.keys(SignNS || {});
    console.log("[WC] sign-client keys:", keys);
    if (SignNS?.default && typeof SignNS.default === "object") {
      console.log("[WC] sign-client.default keys:", Object.keys(SignNS.default));
    }
  } catch { /* ignore */ }

  // 1) namespace модул
  let c =
    (await tryBuild(SignNS, "SignNS")) ||
    (await tryBuild(SignNS?.default, "SignNS.default")) ||
    (await tryBuild(SignNS?.SignClient, "SignNS.SignClient")) ||
    (await tryBuild(SignNS?.default?.SignClient, "SignNS.default.SignClient"));

  // 2) опитай различни dist входни точки (някои среди ги искат)
  if (!c) {
    try {
      const Dist = await import("@walletconnect/sign-client/dist/index.js");
      c =
        (await tryBuild(Dist?.default ?? Dist, "dist/index")) ||
        (await tryBuild(Dist?.SignClient, "dist/index SignClient"));
    } catch { /* ignore */ }
  }
  if (!c) {
    try {
      const DistEsm = await import("@walletconnect/sign-client/dist/esm/index.js");
      c =
        (await tryBuild(DistEsm?.default ?? DistEsm, "dist/esm/index")) ||
        (await tryBuild(DistEsm?.SignClient, "dist/esm/index SignClient"));
    } catch { /* ignore */ }
  }

  if (!c) {
    console.error("[WC] Tried shapes:", tried.join(" -> "));
    throw new Error("Cannot create WalletConnect SignClient from any export shape");
  }
  console.log("[WC] SignClient created via:", tried.at(-1));
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
      requiredNamespaces: {
        eip155: {
          methods: [
            "personal_sign",
            "eth_sign",
            "eth_signTypedData",
            "eth_sendTransaction"
          ],
          chains: ["eip155:1", "eip155:137", "eip155:25", "eip155:338"],
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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`WalletConnect backend listening on :${PORT}`));
