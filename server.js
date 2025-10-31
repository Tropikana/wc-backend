// server.js
import express from "express";
import cors from "cors";

/* ----------------------- 1) Устойчив loader за sign-client ----------------------- */
async function importSignClientModule() {
  try { return await import("@walletconnect/sign-client"); } catch {}
  try { return await import("@walletconnect/sign-client/dist/index.js"); } catch {}
  try { return await import("@walletconnect/sign-client/dist/cjs/index.js"); } catch {}
  try { return await import("@walletconnect/sign-client/cjs/index.js"); } catch {}
  return {};
}

async function makeSignClient(opts) {
  const mod = await importSignClientModule();
  const d = mod?.default;

  const builders = [];

  // клас-конструктор
  if (typeof mod === "function") builders.push(() => new mod(opts));
  if (typeof d === "function") builders.push(() => new d(opts));
  if (mod?.SignClient && typeof mod.SignClient === "function")
    builders.push(() => new mod.SignClient(opts));

  // фабрична init функция
  if (typeof mod?.init === "function") builders.push(() => mod.init(opts));
  if (typeof d?.init === "function") builders.push(() => d.init(opts));

  let lastErr;
  for (const build of builders) {
    try {
      const c = await build();
      if (c) return c;
    } catch (e) {
      lastErr = e;
    }
  }

  try {
    console.error("[WC] sign-client module keys:", Object.keys(mod || {}));
    if (d) console.error("[WC] sign-client.default keys:", Object.keys(d));
    if (lastErr) console.error("[WC] last error:", lastErr?.message);
  } catch {}

  throw new Error("All walletconnect/sign-client export attempts failed");
}

/* ----------------------- 2) Express app ----------------------- */
const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 10000;
const PROJECT_ID = process.env.WC_PROJECT_ID; // <-- сложи го в Render Env Vars

if (!PROJECT_ID) {
  console.warn("[WC] Missing WC_PROJECT_ID env variable!");
}

/* ----------------------- 3) Глобален клиент + памет ----------------------- */
let signClient /*: any */ = null;
// id -> { approval, session|null, createdAt }
const pendings = new Map();

/* полезен sleep */
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

/* стартираме клиента веднъж */
async function ensureClient() {
  if (signClient) return signClient;

  const client = await makeSignClient({
    projectId: PROJECT_ID,
    relayUrl: "wss://relay.walletconnect.com",
    metadata: {
      name: "3DHome4U UE5",
      description: "Login via WalletConnect",
      url: "https://www.3dhome4u.com",
      icons: ["https://www.3dhome4u.com/favicon.ico"],
    },
  });

  // някои версии имат .core.start()
  try {
    await client.core?.start?.();
  } catch {}

  console.log("[WC] client ready");
  signClient = client;
  return client;
}

/* ----------------------- 4) Ендпойнти ----------------------- */

/** 4.1 Генерира wc: URI за QR */
app.get("/wc-uri", async (_req, res) => {
  try {
    const client = await ensureClient();

    const { uri, approval } = await client.connect({
      requiredNamespaces: {
        eip155: {
          methods: [
            "personal_sign",
            "eth_signTypedData",
            "eth_sendTransaction",
            "eth_chainId",
          ],
          // Cronos mainnet/testnet + Ethereum mainnet за съвместимост
          chains: ["eip155:25", "eip155:338", "eip155:1"],
          events: ["accountsChanged", "chainChanged"],
        },
      },
    });

    if (!uri) return res.status(500).json({ error: "No URI returned" });

    const id = cryptoRandomId();
    pendings.set(id, { approval, session: null, createdAt: Date.now() });

    // чакаме одобрение асинхронно
    approval()
      .then(async (session) => {
        const ns = session.namespaces?.eip155;
        const acct = ns?.accounts?.[0]; // "eip155:1:0xabc..."
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

        // лек „пинг“ да се „събуди“ UI-то
        await sleep(300);
        try {
          await client.request({
            topic: session.topic,
            chainId: `eip155:${Number(chainStr)}`,
            request: { method: "eth_chainId", params: [] },
          });
        } catch {}
      })
      .catch(() => {
        pendings.delete(id);
      });

    res.json({ id, uri });
  } catch (e) {
    res.status(500).json({ error: e?.message || "connect failed" });
  }
});

/** 4.2 Проверка на статуса */
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

/** 4.3 Инспекция на текуща сесия */
app.get("/wc-session", (req, res) => {
  const id = String(req.query.id || "");
  const sess = pendings.get(id)?.session;
  if (!sess) return res.status(404).json({ error: "no session yet" });
  res.json(sess);
});

/** 4.4 Примерно „login“ – подписва nonce чрез personal_sign */
app.post("/wc-login", async (req, res) => {
  try {
    const { id } = req.body || {};
    if (!id) return res.status(400).json({ error: "Missing id" });

    const s = pendings.get(id)?.session;
    if (!s) return res.status(400).json({ error: "No approved session" });

    const client = await ensureClient();

    // nonce, който ще бъде подписан – в реален бекенд го пазиш/валидиаш
    const nonce = `3DHome4U:${Date.now()}`;

    // personal_sign изисква [data, address] (или обратния ред според имплементацията)
    let sig;
    try {
      sig = await client.request({
        topic: s.topic,
        chainId: `eip155:${s.chainId}`,
        request: {
          method: "personal_sign",
          params: [toHex(nonce), s.address],
        },
      });
    } catch (e) {
      // fallback към eth_signTypedData (някои портфейли предпочитат това)
      const typed = {
        types: {
          EIP712Domain: [{ name: "name", type: "string" }],
          Login: [{ name: "nonce", type: "string" }],
        },
        domain: { name: "3DHome4U" },
        primaryType: "Login",
        message: { nonce },
      };
      sig = await client.request({
        topic: s.topic,
        chainId: `eip155:${s.chainId}`,
        request: {
          method: "eth_signTypedData",
          params: [s.address, JSON.stringify(typed)],
        },
      });
    }

    // тук валидираш подписа и издаваш твой сес. токен
    res.json({ address: s.address, chainId: s.chainId, nonce, signature: sig });
  } catch (e) {
    res.status(500).json({ error: e?.message || "login failed" });
  }
});

/* ----------------------- 5) Помощни ----------------------- */
function toHex(str) {
  return (
    "0x" +
    Buffer.from(String(str), "utf8")
      .toString("hex")
      .padStart(2, "0")
  );
}
function cryptoRandomId() {
  // достатъчно за временен id
  return ([1e7]+-1e3+-4e3+-8e3+-1e11)
    .replace(/[018]/g,c=>(c ^ (crypto.getRandomValues(new Uint8Array(1))[0] & (15 >> (c/4)))).toString(16));
}

/* ----------------------- 6) Старт на сървъра ----------------------- */
app.listen(PORT, async () => {
  console.log(`WalletConnect backend listening on :${PORT}`);
  try {
    await ensureClient();
  } catch (e) {
    console.error("[WC] client boot error:", e?.message);
  }
});
