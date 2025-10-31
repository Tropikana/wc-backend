// server.js  (ESM)

import express from "express";
import cors from "cors";
import SignClient from "@walletconnect/sign-client";

const app = express();
app.use(express.json());
app.use(cors());

// ---- helpers ---------------------------------------------------------------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const cryptoRandomId =
  () => (globalThis.crypto?.randomUUID?.() || Math.random().toString(36).slice(2));

// изчакване (с ретраили) при cold start на Render
async function waitFor(ms, fn, retries = 1) {
  let err;
  for (let i = 0; i <= retries; i++) {
    try {
      return await fn();
    } catch (e) {
      err = e;
      await sleep(ms);
    }
  }
  throw err;
}

// ---- WalletConnect client (кеширана инициализация) ------------------------

let clientPromise = null;

async function ensureClient() {
  if (clientPromise) return clientPromise;

  clientPromise = (async () => {
    if (!process.env.WC_PROJECT_ID) {
      throw new Error("Missing WC_PROJECT_ID");
    }

    const client = await SignClient.init({
      projectId: process.env.WC_PROJECT_ID,
      relayUrl: "wss://relay.walletconnect.com",
      metadata: {
        name: "3DHome4U UE5",
        description: "Login via WalletConnect",
        url: "https://www.3dhome4u.com",
        icons: ["https://www.3dhome4u.com/favicon.ico"],
      },
    });

    // опитай да „вдигнеш“ relayer и core
    try { await client.core?.relayer?.connect?.(); } catch {}
    try { await client.core?.start?.(); } catch {}

    console.log("[WC] client ready");
    return client;
  })();

  return clientPromise;
}

// ---- in-memory store за чакащи сесии --------------------------------------

/** Map<id, {approval: Function|null, session: {topic,address,chainId,chains,methods}|null, createdAt:number}> */
const pendings = new Map();

// ---- health / info ---------------------------------------------------------

app.get("/health", (_req, res) => res.json({ ok: true }));
app.get("/", (_req, res) => res.json({ ok: true, name: "wc-backend" }));

// ---- warmup: „събуди“ клиента/релайъра ------------------------------------

app.get("/warmup", async (_req, res) => {
  try {
    const c = await ensureClient();
    try { await c.core?.relayer?.connect?.(); } catch {}
    try { await c.core?.start?.(); } catch {}
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e?.message || "warmup failed" });
  }
});

// ---- /wc-uri: генерира wc: URI + ID ---------------------------------------

app.get("/wc-uri", async (_req, res) => {
  try {
    const client = await ensureClient();

    // малък delay при cold start
    await sleep(300);
    try { await client.core?.relayer?.connect?.(); } catch {}
    await sleep(250);

    const requiredNamespaces = {
      eip155: {
        methods: [
          "personal_sign",
          "eth_signTypedData",
          "eth_sendTransaction",
          "eth_chainId",
        ],
        chains: ["eip155:25", "eip155:338", "eip155:1"],
        events: ["accountsChanged", "chainChanged"],
      },
    };

    // Два опита за connect (двойният опит често стабилизира UI-то при студен релайър)
    let out = await client.connect({ requiredNamespaces }).catch(() => null);
    if (!out?.uri) {
      await sleep(650);
      out = await client.connect({ requiredNamespaces }).catch(() => null);
    }
    if (!out?.uri) {
      return res.status(503).json({ error: "Not initialized. engine" });
    }

    const { uri, approval } = out;
    const id = cryptoRandomId();
    pendings.set(id, { approval, session: null, createdAt: Date.now() });

    // След като потребителят одобри в MetaMask:
    approval()
      .then(async (session) => {
        const ns = session.namespaces?.eip155;
        const acct = ns?.accounts?.[0]; // "eip155:<chainId>:0x..."
        if (!acct) return;

        const [, chainStr, addr] = acct.split(":");
        pendings.set(id, {
          approval: null,
          session: {
            topic: session.topic,
            address: addr,
            chainId: Number(chainStr),
            chains: ns?.chains || [],
            methods: ns?.methods || [],
          },
          createdAt: Date.now(),
        });

        // мини-пинг към уолета (помага на някои телефони да покажат UI веднага)
        await sleep(300);
        try {
          await client.request({
            topic: session.topic,
            chainId: `eip155:${Number(chainStr)}`,
            request: { method: "eth_chainId", params: [] },
          });
        } catch {}
      })
      .catch(() => pendings.delete(id));

    res.json({ id, uri });
  } catch (e) {
    res.status(500).json({ error: e?.message || "connect failed" });
  }
});

// ---- /wc-status: проверка на статуса --------------------------------------

app.get("/wc-status", (req, res) => {
  const id = String(req.query.id || "");
  const item = pendings.get(id);
  if (!item) return res.json({ status: "not_found" });

  if (item.session) {
    const { topic, address, chainId, chains = [], methods = [] } = item.session;
    return res.json({
      status: "approved",
      topic,
      address,
      chainId,
      chains,
      methods,
    });
  }

  // изтичане след 2 минути
  if (Date.now() - item.createdAt > 2 * 60 * 1000) {
    pendings.delete(id);
    return res.json({ status: "expired" });
  }

  return res.json({ status: "pending" });
});

// ---- /wc-login: примерна заявка за подписване ------------------------------

/**
 * POST /wc-login
 * body: { id: string, message?: string }
 *
 * - намира одобрената сесия от /wc-uri → /wc-status
 * - вика personal_sign към MetaMask
 */
app.post("/wc-login", async (req, res) => {
  try {
    const { id, message } = req.body || {};
    if (!id) return res.status(400).json({ error: "Missing id" });

    const item = pendings.get(id);
    if (!item?.session) return res.status(400).json({ error: "Not approved" });

    const client = await ensureClient();
    const { topic, address, chainId } = item.session;
    const msg = message || `Login to 3DHome4U at ${new Date().toISOString()}`;

    // personal_sign: [hexMessage, address]
    const hex = "0x" + Buffer.from(msg, "utf8").toString("hex");
    const signature = await waitFor(
      300,
      () =>
        client.request({
          topic,
          chainId: `eip155:${Number(chainId)}`,
          request: {
            method: "personal_sign",
            params: [hex, address],
          },
        }),
      1 // 1 повторен опит
    );

    return res.json({ ok: true, address, chainId, signature });
  } catch (e) {
    console.error("[/wc-login] error:", e?.message);
    res.status(500).json({ error: e?.message || "login failed" });
  }
});

// ---- start -----------------------------------------------------------------

const PORT = process.env.PORT || 10000;
app.listen(PORT, () =>
  console.log(`WalletConnect backend listening on :${PORT}`)
);
