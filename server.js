// server.js  — ESM
import express from "express";
import cors from "cors";
import crypto from "crypto";
import SignClient from "@walletconnect/sign-client";

const app = express();
app.use(express.json());
app.use(cors());

// ---- helpers ----
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const toHexUtf8 = (msg) => "0x" + Buffer.from(String(msg), "utf8").toString("hex");

// ---- init WalletConnect Sign Client ----
const signClient = await SignClient.init({
  projectId: process.env.WC_PROJECT_ID, // <- задължително (WalletConnect Dashboard)
  relayUrl: "wss://relay.walletconnect.com",
  metadata: {
    name: "3DHome4U UE5",
    description: "Login via WalletConnect",
    url: "https://www.3dhome4u.com", // увери се, че е allowlisted в reown
    icons: ["https://www.3dhome4u.com/favicon.ico"],
  },
});

// (по новите версии трябва)
if (signClient?.core?.start) {
  await signClient.core.start();
}

// памет за чакащи/одобрени сесии (dev прототип — за продукция ползвай Redis/DB)
const pendings = new Map(); // id -> { approval, session, createdAt }

// ---- endpoints ----

// health
app.get("/", (_, res) => res.json({ ok: true, name: "wc-backend" }));

// 1) Издаване на wc: URI (за QR) + регистриране на approval()
app.get("/wc-uri", async (req, res) => {
  try {
    // Минимално валидно предложение за MetaMask:
    const { uri, approval } = await signClient.connect({
      // задължителни (минимални) — само mainnet и само подписващи методи
      requiredNamespaces: {
        eip155: {
          methods: [
            "personal_sign",
            "eth_sign",
            "eth_signTypedData",
            "eth_signTypedData_v3",
            "eth_signTypedData_v4",
          ],
          chains: ["eip155:1"], // Ethereum mainnet
          events: ["accountsChanged", "chainChanged"],
        },
      },
      // опционални — вериги и методи, които можем да ползваме по-късно (след connect)
      optionalNamespaces: {
        eip155: {
          chains: ["eip155:25", "eip155:338", "eip155:137"], // Cronos main/test, Polygon
          methods: [
            "wallet_switchEthereumChain",
            "wallet_addEthereumChain",
            "eth_sendTransaction",
          ],
          events: ["accountsChanged", "chainChanged"],
        },
      },
    });

    if (!uri) return res.status(500).json({ error: "No URI returned" });

    const id = crypto.randomUUID();
    // маркираме pending; session ще попълним при approve()
    pendings.set(id, { approval, session: null, createdAt: Date.now() });

    // когато уолета одобри — пазим chains/methods и „пингваме“
    approval()
      .then(async (session) => {
        const ns = session?.namespaces?.eip155;
        const acct = ns?.accounts?.[0]; // "eip155:1:0xabc..."
        if (!acct) return;
        const [, chainStr, addr] = acct.split(":");

        // записваме сесията
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

        // лек „пинг“ (някои телефони/ОS „събуждат“ UI)
        setTimeout(async () => {
          try {
            await signClient.request({
              topic: session.topic,
              chainId: `eip155:${chainStr}`,
              request: { method: "eth_chainId", params: [] },
            });
          } catch (_) {}
        }, 300);
      })
      .catch(() => pendings.delete(id));

    res.json({ id, uri });
  } catch (e) {
    res.status(500).json({ error: e?.message || "connect failed" });
  }
});

// 2) Проверка на статуса на сесията (pending/approved/expired)
app.get("/wc-status", (req, res) => {
  const id = String(req.query.id || "");
  const item = pendings.get(id);
  if (!item) return res.json({ status: "not_found" });

  if (item.session) return res.json({ status: "approved" });

  if (Date.now() - item.createdAt > 2 * 60 * 1000) {
    pendings.delete(id);
    return res.json({ status: "expired" });
  }
  return res.json({ status: "pending" });
});

// 3) Инспекция — какво точно има в сесията (chains/methods/address)
app.get("/wc-session", (req, res) => {
  const id = String(req.query.id || "");
  const item = pendings.get(id);
  if (!item?.session) return res.status(404).json({ error: "no session" });
  res.json(item.session);
});

// 4) Логин: изпраща заявка за подписване (само разрешени методи!)
app.post("/wc-login", async (req, res) => {
  try {
    const { id } = req.body || {};
    const s = pendings.get(String(id))?.session;
    if (!s) return res.status(400).json({ error: "no session" });

    // ако е позволено — "събуди" веригата (ако не е позволено, просто продължи)
    if (s.methods.includes("wallet_switchEthereumChain")) {
      try {
        await signClient.request({
          topic: s.topic,
          chainId: `eip155:${s.chainId}`,
          request: {
            method: "wallet_switchEthereumChain",
            params: [{ chainId: "0x" + s.chainId.toString(16) }],
          },
        });
        await sleep(250);
      } catch (_) {
        // ignore
      }
    }

    // Кандидати за подпис — само ако са позволени
    const msg = "Login to 3DHome4U";
    const hexMsg = toHexUtf8(msg);

    const attempts = [
      s.methods.includes("personal_sign")
        ? async () =>
            signClient.request({
              topic: s.topic,
              chainId: `eip155:${s.chainId}`,
              request: { method: "personal_sign", params: [hexMsg, s.address] },
            })
        : null,
      s.methods.includes("eth_sign")
        ? async () =>
            signClient.request({
              topic: s.topic,
              chainId: `eip155:${s.chainId}`,
              request: { method: "eth_sign", params: [s.address, hexMsg] },
            })
        : null,
      s.methods.includes("eth_signTypedData_v4")
        ? async () => {
            const typed = {
              domain: { name: "3DHome4U", version: "1", chainId: s.chainId },
              message: { purpose: "Login", ts: Date.now() },
              primaryType: "Login",
              types: {
                EIP712Domain: [
                  { name: "name", type: "string" },
                  { name: "version", type: "string" },
                  { name: "chainId", type: "uint256" },
                ],
                Login: [
                  { name: "purpose", type: "string" },
                  { name: "ts", type: "uint256" },
                ],
              },
            };
            return signClient.request({
              topic: s.topic,
              chainId: `eip155:${s.chainId}`,
              request: {
                method: "eth_signTypedData_v4",
                params: [s.address, JSON.stringify(typed)],
              },
            });
          }
        : null,
      s.methods.includes("eth_signTypedData_v3")
        ? async () => {
            const typed = {
              types: {
                EIP712Domain: [
                  { name: "name", type: "string" },
                  { name: "version", type: "string" },
                ],
                Mail: [{ name: "contents", type: "string" }],
              },
              primaryType: "Mail",
              domain: { name: "3DHome4U", version: "1" },
              message: { contents: msg },
            };
            return signClient.request({
              topic: s.topic,
              chainId: `eip155:${s.chainId}`,
              request: {
                method: "eth_signTypedData_v3",
                params: [s.address, JSON.stringify(typed)],
              },
            });
          }
        : null,
      s.methods.includes("eth_signTypedData")
        ? async () => {
            const typed = [
              { type: "string", name: "message", value: msg },
              { type: "uint32", name: "time", value: String(Date.now()) },
            ];
            return signClient.request({
              topic: s.topic,
              chainId: `eip155:${s.chainId}`,
              request: {
                method: "eth_signTypedData",
                params: [s.address, typed],
              },
            });
          }
        : null,
    ].filter(Boolean);

    if (!attempts.length) {
      return res.status(400).json({ error: "no_approved_methods", methods: s.methods });
    }

    let signature = null;
    let lastError = null;
    for (const doAttempt of attempts) {
      try {
        signature = await doAttempt();
        if (signature) break;
      } catch (e) {
        lastError = String(e?.message || e);
        // лека пауза между опитите
        await sleep(150);
      }
    }

    if (!signature) {
      return res.status(500).json({ error: "sign_failed", lastError });
    }

    // успех — можеш да издадеш сесионен токен към фронтенда, ако искаш
    res.json({ ok: true, address: s.address, chainId: s.chainId, signature });
  } catch (e) {
    res.status(500).json({ error: String(e?.message || e) });
  }
});

// 5) Бутон за development — чисти стари pairings (ако се „заклещи“)
app.post("/wc-reset", async (_, res) => {
  try {
    const pairings = signClient.core.pairing.getPairings();
    for (const p of pairings) {
      try {
        await signClient.core.pairing.disconnect({ topic: p.topic });
      } catch (_) {}
      try {
        await signClient.core.pairing.delete(p.topic, "reset");
      } catch (_) {}
    }
    res.json({ ok: true, removed: pairings.length });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// ---- start ----
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`WalletConnect backend listening on :${PORT}`);
});
