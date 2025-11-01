import express from "express";
import cors from "cors";

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static("public"));

/* ---------- Конфиг ---------- */
const WC_PROJECT_ID = process.env.WC_PROJECT_ID || "PASTE_YOUR_PROJECT_ID";
const RELAY_URL = "wss://relay.walletconnect.com";

/* Поддържани мрежи */
const CHAINS = {
  ethereum: { id: 1,   hex: "0x1",   label: "Ethereum Mainnet" },
  linea:    { id: 59144, hex: "0xe708", label: "Linea" },
  bnb:      { id: 56,  hex: "0x38",  label: "BNB Chain" },
  polygon:  { id: 137, hex: "0x89",  label: "Polygon" }
};

const EIP155_ALL = Object.values(CHAINS).map(c => `eip155:${c.id}`);

let signClient = null;

/* за чакащите одобрения и активни сесии */
const approvals = new Map(); // token -> approval (Promise)
const sessions  = new Map(); // token -> { topic, accounts, chains }

/* lazy loader на SignClient с ESM/CJS съвместимост */
async function getSignClient() {
  if (signClient) return signClient;
  const mod = await import("@walletconnect/sign-client");
  const SignClient = mod.default || mod; // важно!
  signClient = await SignClient.init({
    projectId: WC_PROJECT_ID,
    relayUrl: RELAY_URL,
    metadata: {
      name: "3DHome4U Login",
      description: "Login via WalletConnect / MetaMask",
      url: process.env.APP_URL || "https://example.com",
      icons: ["https://raw.githubusercontent.com/walletconnect/walletconnect-assets/master/Icon/Blue%20(Default)/Icon.png"]
    }
  });
  return signClient;
}

/* помощна функция */
function short(addr) {
  return addr ? addr.replace(/^(0x.{4}).*(.{4})$/, "$1…$2") : "-";
}
function chainLabelFromId(idNum) {
  const found = Object.values(CHAINS).find(c => c.id === idNum);
  return found ? found.label : `eip155:${idNum}`;
}

/* ---------- API ---------- */

/* 1) Генерира WC URI и token, който ще използваме да чакаме одобрението */
app.get("/wc-uri", async (req, res) => {
  try {
    const client = await getSignClient();

    const requiredNamespaces = {
      eip155: {
        methods: [
          "eth_sendTransaction",
          "eth_signTransaction",
          "personal_sign",
          "eth_signTypedData",
          "wallet_switchEthereumChain"
        ],
        events: ["accountsChanged", "chainChanged"]
      }
    };

    const optionalNamespaces = {
      eip155: {
        chains: EIP155_ALL,
        methods: [
          "eth_sendTransaction",
          "eth_signTransaction",
          "personal_sign",
          "eth_signTypedData",
          "wallet_switchEthereumChain"
        ],
        events: ["accountsChanged", "chainChanged"]
      }
    };

    const { uri, approval } = await client.connect({
      requiredNamespaces,
      optionalNamespaces
    });

    if (!uri) {
      return res.status(500).json({ ok: false, error: "No URI from WalletConnect" });
    }

    // създаваме token за тази операция
    const token = Math.random().toString(36).slice(2);
    approvals.set(token, approval);

    res.json({ ok: true, uri, token });
  } catch (e) {
    console.error("[/wc-uri]", e);
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

/* 2) Чакаме (long-poll) одобрение и връщаме данни за сесията */
app.get("/wait-session", async (req, res) => {
  const token = req.query.token;
  const approval = approvals.get(token);
  if (!approval) return res.status(400).json({ ok: false, error: "Invalid token" });

  try {
    const session = await approval(); // чакаме потребителя да натисне "Connect"
    approvals.delete(token);

    const topic = session.topic;
    const accounts = session.namespaces?.eip155?.accounts || [];
    const chains   = session.namespaces?.eip155?.chains   || [];

    // взимаме първия адрес / chainId
    const firstAcc = accounts[0] || "";
    const address  = firstAcc.split(":")[2] || "";
    const firstChain = (chains[0] || accounts[0] || "eip155:1").split(":")[1];
    const chainIdNum = Number(firstChain);

    sessions.set(token, { topic, accounts, chains, chainIdNum, address });

    res.json({
      ok: true,
      topic,
      address,
      addressShort: short(address),
      chainId: chainIdNum,
      chainLabel: chainLabelFromId(chainIdNum)
    });
  } catch (e) {
    console.error("[/wait-session]", e);
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

/* 3) Взимане на текущото състояние (ако ни потрябва) */
app.get("/session", (req, res) => {
  const token = req.query.token;
  const s = sessions.get(token);
  if (!s) return res.json({ ok: false });
  res.json({
    ok: true,
    address: s.address,
    addressShort: short(s.address),
    chainId: s.chainIdNum,
    chainLabel: chainLabelFromId(s.chainIdNum),
    topic: s.topic
  });
});

/* 4) Смяна на мрежа през WC */
app.post("/switch", async (req, res) => {
  const { token, chainId } = req.body; // chainId като число (напр. 56)
  const s = sessions.get(token);
  if (!s) return res.status(400).json({ ok: false, error: "No session" });

  const chainNum = Number(chainId);
  const target = Object.values(CHAINS).find(c => c.id === chainNum);
  if (!target) return res.status(400).json({ ok: false, error: "Unsupported chain" });

  try {
    const client = await getSignClient();

    await client.request({
      topic: s.topic,
      chainId: `eip155:${chainNum}`,
      request: {
        method: "wallet_switchEthereumChain",
        params: [{ chainId: target.hex }]
      }
    });

    // обновяваме локално
    s.chainIdNum = chainNum;
    sessions.set(token, s);

    res.json({
      ok: true,
      chainId: chainNum,
      chainLabel: target.label
    });
  } catch (e) {
    console.error("[/switch]", e);
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

/* ---------- start ---------- */
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log("Listening on :", PORT);
  console.log("==> Your service is live 🚀");
});
