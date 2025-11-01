import express from "express";
import cors from "cors";
import path from "path";
import { fileURLToPath } from "url";
import QRCode from "qrcode";
import SignClient from "@walletconnect/sign-client";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const PORT = process.env.PORT || 10000;
const WC_PROJECT_ID = process.env.WC_PROJECT_ID || "2b73902ef2084063237c17f37e9b1e9e"; // <-- твоя Project ID

// Поддържани мрежи (eip155)
const CHAINS = {
  1:  { key: "eip155:1",    name: "Ethereum Mainnet",  hex: "0x1"  },
  56: { key: "eip155:56",   name: "BNB Chain",         hex: "0x38" },
  97: { key: "eip155:97",   name: "BNB Testnet",       hex: "0x61" },
  137:{ key: "eip155:137",  name: "Polygon",           hex: "0x89" },
  59144:{key: "eip155:59144",name: "Linea",            hex: "0xe738" }
};

// Държим client инстанция в процеса
let signClient;

/** lazy init на SignClient */
async function getClient() {
  if (signClient) return signClient;
  signClient = await SignClient.init({
    projectId: WC_PROJECT_ID,
    relayUrl: "wss://relay.walletconnect.com",
    metadata: {
      name: "3DHome4U Login",
      description: "Login via WalletConnect / MetaMask",
      url: "https://wc-backend-tpug.onrender.com",
      icons: ["https://raw.githubusercontent.com/walletconnect/walletconnect-assets/master/Icon/Blue%20(Default)/Icon.png"]
    }
  });

  // полезни логове
  signClient.on("session_update", ({ topic, params }) => {
    const { namespaces } = params;
    console.log("[WC UPDATE]", topic, summarizeNamespaces(namespaces));
  });
  signClient.on("session_event", (e) => console.log("[WC EVENT]", e));
  signClient.on("session_delete", (e) => console.log("[WC DELETE]", e));

  return signClient;
}

/** удобен логер */
function summarizeNamespaces(namespaces) {
  try {
    const e = namespaces.eip155;
    const chains = e?.chains || [];
    const accounts = e?.accounts || [];
    return { chains, accounts };
  } catch {
    return {};
  }
}

/** API: вземи wc uri + proposal topic */
app.get("/wc-uri", async (req, res) => {
  try {
    const client = await getClient();

    // Набор от мрежи, които *искаме* да поддържаме
    const optChains = Object.values(CHAINS).map(c => c.key);

    // Важното: v2 – използваме optionalNamespaces, requiredNamespaces вече е deprec.
    const { uri, approval } = await client.connect({
      optionalNamespaces: {
        eip155: {
          chains: optChains,
          methods: [
            "eth_sendTransaction",
            "personal_sign",
            "eth_signTypedData",
            "wallet_switchEthereumChain",
            "wallet_addEthereumChain",
            "eth_sign"
          ],
          events: ["accountsChanged", "chainChanged"]
        }
      }
    });

    if (!uri) {
      return res.status(500).json({ error: "No WC URI" });
    }

    // Ще държим promiseId в паметта на този процес (Render държи инстанцията жива)
    const promiseId = Math.random().toString(36).slice(2);

    // Записваме promise на одобрение в map, достъпен по promiseId
    approvals.set(promiseId, approval);

    const png = await QRCode.toDataURL(uri);
    res.json({ uri, id: promiseId, qr: png });
  } catch (e) {
    console.error("[WC CONNECT ERROR]", e?.message);
    res.status(500).json({ error: e?.message || "wc error" });
  }
});

// map на чакащи approvals
const approvals = new Map();

/** API: чакаме/взимаме резултата от одобрението */
app.get("/wc-approve/:id", async (req, res) => {
  const id = req.params.id;
  const approval = approvals.get(id);
  if (!approval) return res.status(404).json({ error: "not_found" });

  try {
    const session = await approval(); // <- чакаме потребителя да одобри в портфейла
    approvals.delete(id);
    // Връщаме summary за фронта
    res.json(serializeSession(session));
  } catch (e) {
    approvals.delete(id);
    console.error("[UNHANDLED REJECTION]", e?.message);
    res.status(500).json({ error: e?.message || "approval failed" });
  }
});

/** API: изпрати wallet_switchEthereumChain към портфейла */
app.post("/wc-switch", async (req, res) => {
  try {
    const { topic, targetChainIdHex, selectedAccount } = req.body;
    const client = await getClient();

    // примерен fallback: ако не е подаден account – вземи първия от последната сесия по topic
    const session = client.session.get(topic);
    const account = selectedAccount || (session?.namespaces?.eip155?.accounts?.[0] ?? "");

    const [ns, chainIdStr] = account.split(":"); // "eip155:56:0xabc" -> ["eip155","56","0xabc"]
    if (!topic || !session) throw new Error("unknown session/topic");

    // подаваме chainId като hex (напр. 0x38)
    const request = {
      method: "wallet_switchEthereumChain",
      params: [{ chainId: targetChainIdHex }]
    };

    await client.request({
      topic,
      chainId: `${ns}:${parseInt(targetChainIdHex, 16)}`, // напр. "eip155:56"
      request
    });

    // след успешен switch – прочети актуалния chain от wallet-а
    const newChain = await client.request({
      topic,
      chainId: `${ns}:${parseInt(targetChainIdHex, 16)}`,
      request: { method: "eth_chainId", params: [] }
    });

    res.json({ ok: true, chainIdHex: newChain });
  } catch (e) {
    console.error("[SWITCH ERR]", e?.message);
    res.status(500).json({ error: e?.message || "switch failed" });
  }
});

/** helper – сериализация за фронта */
function serializeSession(session) {
  // реален адрес и мрежа вземаме от accounts:
  // формат: "eip155:137:0x1234..."
  const acc = session?.namespaces?.eip155?.accounts?.[0] || "";
  const parts = acc.split(":"); // ["eip155","137","0x...."]
  const chainIdNum = Number(parts[1] || 1);
  const address = parts[2] || "";

  const chainInfo = CHAINS[chainIdNum] || CHAINS[1];

  const all = session?.namespaces?.eip155?.accounts || [];
  const allAddresses = all.map(a => a.split(":")[2]);

  console.log(
    "[WC APPROVED]",
    session.topic,
    "chains=",
    session.namespaces?.eip155?.chains,
    "picked=",
    { chainId: chainIdNum, address, allAddresses }
  );

  return {
    topic: session.topic,
    chainId: chainIdNum,
    chainName: chainInfo.name,
    chainHex: chainInfo.hex,
    address,
    allAddresses
  };
}

app.listen(PORT, () => {
  console.log(`Listening on :${PORT}`);
  console.log("==> Your service is live");
});
