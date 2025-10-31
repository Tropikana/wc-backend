import express from "express";
import cors from "cors";
import SignClientMod from "@walletconnect/sign-client"; // формата варира
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

let signClient = null;

// 1) опитай директно default експорта – функция (новите билдове)
try {
  if (!signClient && typeof SignClientMod === "function") {
    signClient = await SignClientMod(opts);
  }
} catch { /* ignore */ }

// 2) опитай default.init() – класическият API
try {
  if (!signClient && SignClientMod?.init) {
    signClient = await SignClientMod.init(opts);
  }
} catch { /* ignore */ }

// 3) опитай default вътрешно (някои ESM/interop варианти)
try {
  if (!signClient && SignClientMod?.default) {
    const D = SignClientMod.default;
    if (typeof D === "function") signClient = await D(opts);
    else if (D?.init)          signClient = await D.init(opts);
  }
} catch { /* ignore */ }

// 4) опитай директно от dist/ (някои среди връщат формата там)
try {
  if (!signClient) {
    const Dist = await import("@walletconnect/sign-client/dist/index.js");
    const D = Dist.default ?? Dist;
    if (typeof D === "function") signClient = await D(opts);
    else if (D?.init)            signClient = await D.init(opts);
  }
} catch { /* ignore */ }

if (!signClient) {
  throw new Error("Cannot create WalletConnect SignClient from any export shape");
}
// -----------------------------------------------------

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
          // ETH + Polygon + Cronos
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
