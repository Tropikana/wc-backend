// server.js (ESM)

import express from "express";
import cors from "cors";
import * as SignNS from "@walletconnect/sign-client";
import crypto from "crypto";

const app = express();
app.use(express.json());
app.use(cors());

/* ------------------------------------------------------------------
   WalletConnect SignClient – стабилна инициализация за различни билдове
------------------------------------------------------------------- */
const WC_OPTS = {
  projectId: process.env.WC_PROJECT_ID,
  relayUrl: "wss://relay.walletconnect.com",
  metadata: {
    name: "3DHome4U",
    description: "UE5 login via WalletConnect",
    url: "https://www.3dhome4u.com", // реален https домейн
    // Валидна публична икона (256x256) – избягва странности в някои уолети
    icons: [
      "https://raw.githubusercontent.com/walletconnect/walletconnect-assets/master/Icon/Blue%20(Default)/Icon.png"
    ],
    redirect: { native: "metamask://", universal: "https://metamask.app.link" }
  }
};

async function makeSignClient() {
  const tried = [];
  const tryBuild = async (cand, label) => {
    if (!cand) return null;
    tried.push(label);
    if (typeof cand?.init === "function") {
      try { return await cand.init(WC_OPTS); } catch {}
    }
    try { return new cand(WC_OPTS); } catch {}
    if (typeof cand === "function") {
      try { return await cand(WC_OPTS); } catch {}
    }
    return null;
  };

  // 1) Различни export форми
  let c =
    (await tryBuild(SignNS?.SignClient, "SignNS.SignClient")) ||
    (await tryBuild(SignNS?.default?.SignClient, "default.SignClient")) ||
    (await tryBuild(SignNS?.default, "default")) ||
    (await tryBuild(SignNS, "namespace"));

  // 2) Опит през dist
  if (!c) {
    try {
      const Dist = await import("@walletconnect/sign-client/dist/index.js");
      const D = Dist?.SignClient ?? Dist?.default?.SignClient ?? Dist?.default ?? Dist;
      c = (await tryBuild(D, "dist/index")) || (await tryBuild(D?.SignClient, "dist/index SignClient"));
    } catch {}
  }
  if (!c) {
    try {
      const DistEsm = await import("@walletconnect/sign-client/dist/esm/index.js");
      const D = DistEsm?.SignClient ?? DistEsm?.default?.SignClient ?? DistEsm?.default ?? DistEsm;
      c = (await tryBuild(D, "dist/esm/index")) || (await tryBuild(D?.SignClient, "dist/esm/index SignClient"));
    } catch {}
  }

  if (!c) {
    console.error("[WC] Cannot create SignClient. Tried shapes:", tried.join(" -> "));
    throw new Error("Cannot create WalletConnect SignClient from any export shape");
  }

  // На Render free инстанции engine-ът трябва да се „събуди“
  if (c?.core?.start) await c.core.start();
  return c;
}

const signClient = await makeSignClient();

/* ------------------------------------------------------------------
   In-memory състояние
------------------------------------------------------------------- */
const pendings = new Map(); // id -> { approval, session|null, createdAt }

/* Helpers */
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const toHex = (s) => (s?.startsWith?.("0x") ? s : "0x" + Buffer.from(String(s), "utf8").toString("hex"));

async function wcRequest(topic, chainId, method, params) {
  try {
    return await signClient.request({ topic, chainId, request: { method, params } });
  } catch (e) {
    console.log("[WC][request] fail:", method, JSON.stringify(params), e?.message || e);
    return null;
  }
}

/* ------------------------------------------------------------------
   1) Връща wc: URI за QR / deeplink
------------------------------------------------------------------- */
app.get("/wc-uri", async (req, res) => {
  try {
    if (signClient?.core?.start) await signClient.core.start();

    const { uri, approval } = await signClient.connect({
      requiredNamespaces: {
        eip155: {
          // остави само това, което реално ще ползваш
          methods: ["personal_sign","eth_sign","eth_signTypedData","eth_signTypedData_v3","eth_signTypedData_v4"],
          chains: ["eip155:1","eip155:25","eip155:137","eip155:338"], // примери
          events: ["accountsChanged","chainChanged"]
        }
      }
    });

    if (!uri) return res.status(500).json({ error: "No URI returned" });

    const id = crypto.randomUUID();
    // първо маркираме "pending"
    pendings.set(id, { approval, session: null, createdAt: Date.now() });

    // когато wallet-ът одобри -> записваме сесията + пингваме
    approval()
      .then(async (session) => {
        const ns = session.namespaces?.eip155;
        const acct = ns?.accounts?.[0];                 // "eip155:1:0xabc..."
        if (!acct) return;                              // safety
        const [, chainStr, addr] = acct.split(":");

        // кратка пауза за стабилен UI
        await sleep(300);

        pendings.set(id, {
          approval: null,
          session: {
            topic: session.topic,
            address: addr,
            chainId: Number(chainStr),
            chains: ns?.chains || [],
            methods: ns?.methods || []
          },
          createdAt: Date.now()
        });

        // "пинг" към уолета – често „събужда“ модала
        setTimeout(async () => {
          try {
            const s = pendings.get(id)?.session;
            if (!s) return;
            await signClient.request({
              topic: s.topic,
              chainId: `eip155:${s.chainId}`,
              request: { method: "eth_chainId", params: [] }
            });
          } catch (_) {}
        }, 300);
      })
      .catch(() => pendings.delete(id));

    // връщаме wc: URI веднага – фронтът да покаже QR/deeplink
    res.json({ id, uri });
  } catch (e) {
    res.status(500).json({ error: e?.message || "connect failed" });
  }
});

/* ------------------------------------------------------------------
   2) Проверка на статуса на сесията
------------------------------------------------------------------- */
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

/* ------------------------------------------------------------------
   3) Диагностика – върни текущата сесия (ако е approved)
------------------------------------------------------------------- */
app.get("/wc-session", (req, res) => {
  const id = String(req.query.id || "");
  const item = pendings.get(id);
  if (!item || !item.session) return res.status(404).json({ error: "no_session" });
  res.json(item.session);
});

/* ------------------------------------------------------------------
   4) Подписване (login) – праща заявка към уолета
------------------------------------------------------------------- */
app.post("/wc-login", async (req, res) => {
  try {
    const id = String(req.body?.id || "");
    const item = pendings.get(id);
    if (!item || !item.session) return res.status(400).json({ error: "no_session" });

    if (signClient?.core?.start) await signClient.core.start();

    const { topic, address, chains = [], methods = [] } = item.session;

    // 1) Верига: ползваме тази от сесията (ако липсва — падаме към одобрената chainId)
    const approvedChainId = Number(item.session.chainId || 1);
    const chosenChain = chains.find(c => c.startsWith("eip155:")) || `eip155:${approvedChainId}`;
    const chosenChainId = Number(chosenChain.split(":")[1] || approvedChainId);

    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const toHex = (s) => (s?.startsWith?.("0x") ? s : "0x" + Buffer.from(String(s), "utf8").toString("hex"));

    // 2) „Събуждане“ и синхронизиране на веригата (дори да е същата)
    try {
      await signClient.request({
        topic,
        chainId: `eip155:${chosenChainId}`,
        request: {
          method: "wallet_switchEthereumChain",
          params: [{ chainId: "0x" + chosenChainId.toString(16) }]
        }
      });
      await sleep(250);
    } catch (e) {
      // Не е фатално; често MM връща грешка, ако вече е на същата верига
    }

    // 3) Избираме какво изобщо е разрешено да искаме
    const allowed = new Set(methods.map(m => m.toLowerCase()));
    const tryQueue = [];

    if (allowed.has("personal_sign")) {
      const nonce = crypto.randomBytes(8).toString("hex");
      const message =
        `Login to 3DHome4U\n` +
        `Address: ${address}\n` +
        `Nonce: ${nonce}\n` +
        `Issued At: ${new Date().toISOString()}`;

      const hexMsg = toHex(message);

      // и двата реда (hex, address) и (address, hex) — MM приема и двата
      tryQueue.push({ method: "personal_sign", params: [hexMsg, address], payload: { address, message } });
      tryQueue.push({ method: "personal_sign", params: [address, hexMsg], payload: { address, message } });
      tryQueue.push({ method: "personal_sign", params: [message, address], payload: { address, message } });
    }

    if (allowed.has("eth_sign")) {
      const nonce = crypto.randomBytes(8).toString("hex");
      const msg = `Login 3DHome4U (nonce:${nonce})`;
      tryQueue.push({ method: "eth_sign", params: [address, toHex(msg)], payload: { address, message: msg } });
    }

    // typed data (v3/v4) – добавяме само ако са разрешени
    const typedMsg = (txt) => JSON.stringify({
      types: {
        EIP712Domain: [{ name: "name", type: "string" }],
        Mail: [{ name: "contents", type: "string" }]
      },
      domain: { name: "3DHome4U" },
      primaryType: "Mail",
      message: { contents: txt }
    });

    if (allowed.has("eth_signtypeddata_v3") || allowed.has("eth_signtypeddata")) {
      tryQueue.push({
        method: "eth_signTypedData_v3",
        params: [address, typedMsg("Login to 3DHome4U (v3)")],
        payload: { address }
      });
    }
    if (allowed.has("eth_signtypeddata_v4")) {
      tryQueue.push({
        method: "eth_signTypedData_v4",
        params: [address, typedMsg("Login to 3DHome4U (v4)")],
        payload: { address }
      });
    }

    if (!tryQueue.length) {
      return res.status(400).json({
        error: "no_approved_methods",
        approved: Array.from(allowed)
      });
    }

    // 4) Пускаме опитите един по един, с пауза — за да се показва стабилно UI-то
    let result = null, used = null, lastErr = null;
    for (const attempt of tryQueue) {
      await sleep(200);
      try {
        used = attempt.method;
        result = await signClient.request({
          topic,
          chainId: `eip155:${chosenChainId}`,
          request: { method: attempt.method, params: attempt.params }
        });
        if (result) {
          // успех
          const payload = attempt.payload || {};
          return res.json({ method: used, signature: result, ...payload });
        }
      } catch (e) {
        lastErr = e?.message || String(e);
        // продължаваме със следващия метод
      }
    }

    return res.status(500).json({
      error: "sign_rejected_or_unsupported",
      lastError: lastErr
    });
  } catch (e) {
    res.status(500).json({ error: e?.message || "sign failed" });
  }
});
/* ------------------------------------------------------------------
   Start
------------------------------------------------------------------- */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`WalletConnect backend listening on :${PORT}`));
