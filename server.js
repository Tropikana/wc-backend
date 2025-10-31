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
app.get("/wc-uri", async (_req, res) => {
  try {
    if (signClient?.core?.start) await signClient.core.start();
    await sleep(100); // micro-stabilize

    const { uri, approval } = await signClient.connect({
      // По-надеждно за MetaMask: минимален required, останалото – optional
      requiredNamespaces: {
        eip155: {
          chains: ["eip155:1"],
          methods: ["personal_sign"],
          events: ["accountsChanged", "chainChanged"]
        }
      },
      optionalNamespaces: {
        eip155: {
          chains: ["eip155:137", "eip155:25", "eip155:338"],
          methods: ["eth_sign", "eth_signTypedData", "eth_signTypedData_v4", "eth_sendTransaction"],
          events: ["accountsChanged", "chainChanged"]
        }
      }
    });

    if (!uri) return res.status(500).json({ error: "No URI returned" });

    const id = crypto.randomUUID();
    pendings.set(id, { approval, session: null, createdAt: Date.now() });

    approval()
      .then(async (session) => {
        // Примерен акаунт: "eip155:1:0xabc..."
        const acct = session.namespaces.eip155.accounts[0];
        const [, chainStr, addr] = acct.split(":");

        // Малък delay – иначе при някои билдове на MM UI може да „примигне“ и да се затвори
        await sleep(300);

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

    const { topic, address, chainId } = item.session;
    // За сигурност – ако веригата е „екзотична“, форсираме eip155:1 за подписа
    const chain = [1, 137, 25, 338].includes(Number(chainId))
      ? `eip155:${chainId}`
      : "eip155:1";

    const nonce = crypto.randomBytes(8).toString("hex");
    const message =
      `Login to 3DHome4U\n` +
      `Address: ${address}\n` +
      `Nonce: ${nonce}\n` +
      `Issued At: ${new Date().toISOString()}`;

    // Опити: personal_sign (hex/utf8, двата реда на params) + eth_sign + typedData v4
    const attempts = [
      { method: "personal_sign", params: [toHex(message), address] },
      { method: "personal_sign", params: [address, toHex(message)] },
      { method: "personal_sign", params: [message, address] },
      { method: "eth_sign",      params: [address, toHex(message)] },
      {
        method: "eth_signTypedData_v4",
        params: [
          address,
          JSON.stringify({
            types: {
              EIP712Domain: [{ name: "name", type: "string" }],
              Mail: [{ name: "contents", type: "string" }]
            },
            domain: { name: "3DHome4U" },
            primaryType: "Mail",
            message: { contents: message }
          })
        ]
      }
    ];

    let signature = null;
    for (const a of attempts) {
      await sleep(150); // кратка пауза – избягва „полу-показан“ и затворен UI
      signature = await wcRequest(topic, chain, a.method, a.params);
      if (signature) { console.log("[WC] signed with", a.method); break; }
    }

    if (!signature) return res.status(500).json({ error: "sign_rejected_or_unsupported" });
    res.json({ address, message, signature });
  } catch (e) {
    res.status(500).json({ error: e?.message || "sign failed" });
  }
});

/* ------------------------------------------------------------------
   Healthcheck
------------------------------------------------------------------- */
app.get("/health", (_req, res) => res.json({ ok: true }));

/* ------------------------------------------------------------------
   Start
------------------------------------------------------------------- */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`WalletConnect backend listening on :${PORT}`));
