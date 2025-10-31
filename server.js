import express from "express";
import cors from "cors";
import SignClient from "@walletconnect/sign-client";
import crypto from "crypto";

const app = express();
app.use(express.json());
app.use(cors());

// -------- WalletConnect client (works for both export shapes) --------
const opts = {
  projectId: process.env.WC_PROJECT_ID,
  relayUrl: "wss://relay.walletconnect.com",
  metadata: {
    name: "3DHome4U",
    description: "UE5 login via WalletConnect",
    url: "https://wc-backend-tpug.onrender.com",
    icons: ["https://wc-backend-tpug.onrender.com/icon.png"],
    redirect: {
      native: "metamask://",
      universal: "https://metamask.app.link"
    }
  }
};

let signClient;
if (typeof SignClient === "function") {
  // new export shape: default is a factory function
  signClient = await SignClient(opts);
} else if (SignClient?.init) {
  // classic export shape: class with .init()
  signClient = await SignClient.init(opts);
} else {
  throw new Error("Unexpected @walletconnect/sign-client export shape");
}
// --------------------------------------------------------------------

// In-memory pending sessions
const pendings = new Map(); // id -> { approval, session|null, createdAt }

// 1) Return wc: URI for QR
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
        const acct = session.namespaces.eip155.accounts[0]; // "eip155:1:0xabc..."
        const [, chainStr, addr] = acct.split(":");
        pendings.set(id, {
          approval: null,
          session: {
            topic: session.topic,
            address: addr,
            chainId: Number(chainStr)
          },
          createdAt: Date.now()
        });
      })
      .catch(() => pendings.delete(id));

    res.json({ id, uri });
  } catch (e) {
    res.status(500).json({ error: e?.message || "connect failed" });
  }
});

// 2) Poll status
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
app.listen(PORT, () =>
  console.log(`WalletConnect backend listening on :${PORT}`)
);
