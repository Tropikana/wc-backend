import express from "express";
import cors from "cors";
import { v4 as uuidv4 } from "uuid";

const PORT = process.env.PORT || 3000;
const WC_PROJECT_ID = process.env.WC_PROJECT_ID;
const CORS_ORIGIN = process.env.CORS_ORIGIN || "*"; // по желание ограничи домейна

if (!WC_PROJECT_ID) {
  console.error("[FATAL] Missing WC_PROJECT_ID env var.");
  process.exit(1);
}

const app = express();
app.use(cors({ origin: CORS_ORIGIN }));
app.use(express.json());

// --- WalletConnect SignClient (lazy init) ---
let signClient = null;
async function getSignClient() {
  if (signClient) return signClient;
  let SignClient;
  try {
    const mod = await import("@walletconnect/sign-client");
    SignClient = mod?.default || mod?.SignClient || mod;
  } catch (e) {
    console.error("Failed to import @walletconnect/sign-client", e);
    throw e;
  }
  signClient = await SignClient.init({
    projectId: WC_PROJECT_ID,
    relayUrl: "wss://relay.walletconnect.com",
    metadata: {
      name: "WC Login Demo",
      description: "QR login via WalletConnect",
      url: "https://example.com",
      icons: ["https://raw.githubusercontent.com/walletconnect/walletconnect-assets/master/Icon/Blue%20(Default)/Icon.png"]
    }
  });
  return signClient;
}

// --- In-memory pending store with TTL ---
const PENDING_TTL_MS = 2 * 60 * 1000; // 2 минути
/** id -> { createdAt, approval, session | null } */
const pendings = new Map();

// периодично почистване
setInterval(() => {
  const now = Date.now();
  for (const [id, row] of pendings) {
    if (now - row.createdAt > PENDING_TTL_MS) {
      pendings.delete(id);
    }
  }
}, 30 * 1000);

// Health
app.get("/health", (_req, res) => {
  res.json({ ok: true, pendingCount: pendings.size });
});

// Вземи нов wc-uri + едноразово id
app.get("/wc-uri", async (_req, res) => {
  try {
    const client = await getSignClient();

    const id = uuidv4();
    const requiredNamespaces = {
      eip155: {
        methods: [
          "personal_sign",
          "eth_sign",
          "eth_signTypedData",
          "eth_signTypedData_v4",
          "eth_sendTransaction"
        ],
        chains: ["eip155:1", "eip155:137", "eip155:25", "eip155:338"],
        events: ["chainChanged", "accountsChanged"]
      }
    };

    const { uri, approval } = await client.connect({ requiredNamespaces });

    // съхраняваме promise-а и по-късно сетваме session
    const createdAt = Date.now();
    const row = { createdAt, approval, session: null };
    pendings.set(id, row);

    approval
      .then((session) => {
        // вземаме първия акаунт/верига от eip155
        const ns = session.namespaces?.eip155;
        const account = ns?.accounts?.[0] || "";
        const [namespace, chainId, address] = account.split(/:|@/).length === 1
          ? (account.split(":")[2] ? ["eip155", account.split(":")[1], account.split(":")[2]] : ["", "", ""])
          : ["", "", ""];

        row.session = {
          topic: session.topic,
          addresses: ns?.accounts?.map(a => a.split(":")[2]) || [],
          chains: ns?.chains || [],
          // за удобство връщаме и първите:
          address: address || (ns?.accounts?.[0]?.split(":")[2] ?? null),
          chainId: Number((ns?.accounts?.[0]?.split(":")[1]) ?? "0")
        };
      })
      .catch(() => {
        // ако потребителят откаже в app-а
        // оставяме row.session = null, ще изтече по TTL
      });

    const expiresAt = new Date(createdAt + PENDING_TTL_MS).toISOString();
    res.json({ id, uri, expiresAt });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to create WalletConnect pairing" });
  }
});

// Проверка на статус по id
app.get("/wc-status", (req, res) => {
  const { id } = req.query;
  if (!id || !pendings.has(id)) {
    return res.json({ status: "not_found" });
    }
  const row = pendings.get(id);
  const age = Date.now() - row.createdAt;
  const expired = age > PENDING_TTL_MS;

  if (row.session) {
    return res.json({ status: "approved", ...row.session });
  }
  if (expired) {
    pendings.delete(id);
    return res.json({ status: "expired" });
  }
  return res.json({ status: "pending" });
});

// статичен фронт
app.use(express.static("public"));

const server = app.listen(PORT, () => {
  console.log(`Server listening on :${PORT}`);
});

process.on("SIGINT", () => {
  server.close(() => process.exit(0));
});
process.on("SIGTERM", () => {
  server.close(() => process.exit(0));
});
