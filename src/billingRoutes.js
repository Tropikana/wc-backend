// src/billingRoutes.js

import { ethers } from "ethers";
import {
  provider,
  wallet,
  gameServerAddress,
  gameCurrencyContract,
  resourceNFTContract,
  landNFTContract,
  parcelStateContract,
  toGameCurrencyUnits,
} from "./blockchain.js";

/**
 * Адрес, към който играчите плащат таксите.
 * Ако не е зададен BILLING_TREASURY_ADDRESS, ползваме GAME_SERVER_WALLET.
 */
const BILLING_TREASURY_ADDRESS =
  (process.env.BILLING_TREASURY_ADDRESS || "").trim() || gameServerAddress;

// Помощна функция за парсване на цена от env, в native токен (18 десетични, като ETH/MATIC).
function parseNativePrice(envName, defaultValue = "0") {
  const raw = (process.env[envName] || "").trim();
  if (!raw) {
    console.warn(`[billing] Missing ${envName}, using default ${defaultValue}`);
    return ethers.parseUnits(defaultValue, 18); // 0 по подразбиране
  }
  try {
    // raw може да е "0.0001" и ще се парсне като 18-десетична стойност
    return ethers.parseUnits(raw, 18);
  } catch (e) {
    console.warn(`[billing] Could not parse ${envName}='${raw}':`, e);
    return ethers.parseUnits(defaultValue, 18);
  }
}

/**
 * Конфигурация на цените за различните действия.
 *
 * В .env трябва да зададеш:
 *  - PRICE_NATIVE_ITEM_NFT          (примерно за предметни NFT)
 *  - PRICE_NATIVE_RESOURCE_NFT      (ресурсни NFT)
 *  - PRICE_NATIVE_CURRENCY          (валута)
 *  - PRICE_NATIVE_LAND              (минт на парцели LandNFT)
 *  - PRICE_NATIVE_PARCELSTATE       (ParcelState операции – строеж / on-off на сгради)
 *
 * Пример:
 *  PRICE_NATIVE_ITEM_NFT=0.0002
 *  PRICE_NATIVE_RESOURCE_NFT=0.00008
 *  PRICE_NATIVE_CURRENCY=0.00008
 *  PRICE_NATIVE_LAND=0.0005
 *  PRICE_NATIVE_PARCELSTATE=0.00005
 */
const ACTION_CONFIG = {
  // --------- ITEM NFT (ако по-късно ги отделим от ресурсите) ---------
  ITEM_NFT_MINT: {
    priceWei: parseNativePrice("PRICE_NATIVE_ITEM_NFT", "0"),
    kind: "ITEM",
    operation: "MINT",
  },
  ITEM_NFT_BURN: {
    priceWei: parseNativePrice("PRICE_NATIVE_ITEM_NFT", "0"),
    kind: "ITEM",
    operation: "BURN",
  },

  // --------- RESOURCE NFT (ResourceNFT ERC1155) ---------
  RESOURCE_NFT_MINT: {
    priceWei: parseNativePrice("PRICE_NATIVE_RESOURCE_NFT", "0"),
    kind: "RESOURCE",
    operation: "MINT",
  },
  RESOURCE_NFT_BURN: {
    priceWei: parseNativePrice("PRICE_NATIVE_RESOURCE_NFT", "0"),
    kind: "RESOURCE",
    operation: "BURN",
  },

  // --------- CURRENCY (GameCurrency ERC20) ---------
  CURRENCY_MINT: {
    priceWei: parseNativePrice("PRICE_NATIVE_CURRENCY", "0"),
    kind: "CURRENCY",
    operation: "MINT",
  },
  CURRENCY_BURN: {
    priceWei: parseNativePrice("PRICE_NATIVE_CURRENCY", "0"),
    kind: "CURRENCY",
    operation: "BURN",
  },

  // --------- LAND (LandNFT ERC721) ---------
  // Минт на парцел към играча – LandNFT.mintLand(player, tokenId)
  LAND_NFT_MINT: {
    priceWei: parseNativePrice("PRICE_NATIVE_LAND", "0"),
    kind: "LAND",
    operation: "MINT",
  },

  // --------- PARCEL STATE (ParcelState) ---------
  // Строеж / активиране на сграда – ParcelState.activateBuilding(...)
  PARCEL_ACTIVATE_BUILDING: {
    priceWei: parseNativePrice("PRICE_NATIVE_PARCELSTATE", "0"),
    kind: "PARCEL",
    operation: "ACTIVATE_BUILDING",
  },
  // Включване/изключване на вече построена сграда – ParcelState.setBuildingActive(...)
  PARCEL_SET_BUILDING_ACTIVE: {
    priceWei: parseNativePrice("PRICE_NATIVE_PARCELSTATE", "0"),
    kind: "PARCEL",
    operation: "SET_BUILDING_ACTIVE",
  },
};

// За да не се преизползват платежни транзакции
const usedPaymentTxs = new Set();

/**
 * Регистрира маршрутите за биллинг върху подадения Express app.
 *
 * Поток:
 *  1) Unreal вика /billing/quote?actionType=RESOURCE_NFT_MINT
 *      -> получава priceWei, priceEther
 *  2) Unreal кара играча да плати тази сума към BILLING_TREASURY_ADDRESS
 *     през WalletConnect (eth_sendTransaction).
 *  3) След txHash, Unreal вика /billing/complete с:
 *      { actionType, txHash, playerAddress, details: {...} }
 *  4) Тук проверяваме плащането и правим съответното on-chain действие (mint/burn/...).
 */
export function setupBillingRoutes(app) {
  console.log("[billing] Treasury address:", BILLING_TREASURY_ADDRESS);

  // Дава цена за конкретен actionType
  app.get("/billing/quote", (req, res) => {
    try {
      const actionType = String(req.query.actionType || "").trim();
      const cfg = ACTION_CONFIG[actionType];
      if (!cfg) {
        return res.status(400).json({ error: "Unknown actionType" });
      }
      if (cfg.priceWei <= 0n) {
        return res.status(500).json({
          error: `Price for ${actionType} is not configured (env missing)`,
        });
      }

      const priceWei = cfg.priceWei;
      const priceEther = ethers.formatUnits(priceWei, 18);

      return res.json({
        actionType,
        priceWei: "0x" + priceWei.toString(16),
        priceEther,
        treasury: BILLING_TREASURY_ADDRESS,
      });
    } catch (e) {
      console.error("[/billing/quote] error:", e);
      return res.status(500).json({ error: e?.message || String(e) });
    }
  });

  // Финализира платена операция: проверява платен tx и прави on-chain действие
  app.post("/billing/complete", async (req, res) => {
    try {
      const { actionType, txHash, playerAddress, details } = req.body || {};

      if (!actionType || typeof actionType !== "string") {
        return res.status(400).json({ error: "Missing actionType" });
      }
      const cfg = ACTION_CONFIG[actionType];
      if (!cfg) {
        return res.status(400).json({ error: "Unknown actionType" });
      }
      if (cfg.priceWei <= 0n) {
        return res.status(500).json({
          error: `Price for ${actionType} is not configured`,
        });
      }

      if (!txHash || typeof txHash !== "string" || !txHash.startsWith("0x")) {
        return res.status(400).json({ error: "Invalid txHash" });
      }
      if (!ethers.isAddress(playerAddress)) {
        return res.status(400).json({ error: "Invalid playerAddress" });
      }

      const playerAddrLower = playerAddress.toLowerCase();
      const treasuryLower = BILLING_TREASURY_ADDRESS.toLowerCase();

      if (usedPaymentTxs.has(txHash)) {
        return res.status(400).json({ error: "Payment tx already used" });
      }

      // Четем транзакцията и receipt-а
      const tx = await provider.getTransaction(txHash);
      if (!tx) {
        return res.status(400).json({ error: "Payment transaction not found" });
      }
      const receipt = await provider.getTransactionReceipt(txHash);
      if (!receipt) {
        return res
          .status(400)
          .json({ error: "Payment transaction not yet mined" });
      }
      if (Number(receipt.status) !== 1) {
        return res.status(400).json({ error: "Payment transaction failed" });
      }

      if (!tx.to) {
        return res.status(400).json({ error: "Payment transaction has no 'to'" });
      }

      if (tx.from.toLowerCase() !== playerAddrLower) {
        return res.status(400).json({ error: "Payment not sent by this player" });
      }
      if (tx.to.toLowerCase() !== treasuryLower) {
        return res
          .status(400)
          .json({ error: "Payment not sent to billing treasury address" });
      }

      const valueWei = tx.value; // BigInt
      if (valueWei < cfg.priceWei) {
        return res.status(400).json({
          error: "Payment value is below required price",
          requiredWei: cfg.priceWei.toString(),
          sentWei: valueWei.toString(),
        });
      }

      // Маркираме плащането като използвано (за да не се преизползва)
      usedPaymentTxs.add(txHash);

      // Тук правим реалното действие според actionType
      let onchainTx = null;

      // RESOURCE / ITEM NFT през ResourceNFT
      if ((cfg.kind === "RESOURCE" || cfg.kind === "ITEM") && resourceNFTContract) {
        const { resourceId, amount } = details || {};
        if (!Number.isInteger(resourceId) || resourceId <= 0) {
          return res.status(400).json({ error: "Invalid resourceId" });
        }
        if (!Number.isInteger(amount) || amount <= 0) {
          return res.status(400).json({ error: "Invalid amount" });
        }

        if (cfg.operation === "MINT") {
          onchainTx = await resourceNFTContract.mintResource(
            playerAddress,
            resourceId,
            amount,
            "0x"
          );
        } else if (cfg.operation === "BURN") {
          onchainTx = await resourceNFTContract.burnResource(
            playerAddress,
            resourceId,
            amount
          );
        } else {
          return res.status(500).json({ error: "Unsupported NFT operation" });
        }
      }

      // CURRENCY (GameCurrency)
      else if (cfg.kind === "CURRENCY" && gameCurrencyContract) {
        const { amount } = details || {};
        if (!Number.isInteger(amount) || amount <= 0) {
          return res
            .status(400)
            .json({ error: "Invalid amount (integer tokens)" });
        }

        const amountUnits = toGameCurrencyUnits(amount);

        if (cfg.operation === "MINT") {
          onchainTx = await gameCurrencyContract.mintTo(
            playerAddress,
            amountUnits
          );
        } else if (cfg.operation === "BURN") {
          onchainTx = await gameCurrencyContract.burnFromAccount(
            playerAddress,
            amountUnits
          );
        } else {
          return res.status(500).json({ error: "Unsupported currency operation" });
        }
      }

      // LAND (LandNFT) – минт на парцел
      else if (cfg.kind === "LAND" && landNFTContract) {
        const { tokenId } = details || {};
        if (!Number.isInteger(tokenId) || tokenId <= 0) {
          return res.status(400).json({ error: "Invalid tokenId" });
        }

        if (cfg.operation === "MINT") {
          onchainTx = await landNFTContract.mintLand(playerAddress, tokenId);
        } else {
          return res.status(500).json({ error: "Unsupported LAND operation" });
        }
      }

      // PARCEL STATE – строеж / включване-изключване на сграда
      else if (cfg.kind === "PARCEL" && parcelStateContract && landNFTContract) {
        const { landId, buildingType, active } = details || {};

        if (!Number.isInteger(landId) || landId <= 0) {
          return res.status(400).json({ error: "Invalid landId" });
        }
        if (!Number.isInteger(buildingType) || buildingType < 0 || buildingType > 5) {
          return res
            .status(400)
            .json({ error: "Invalid buildingType (must be 0..5)" });
        }

        // проверка, че playerAddress е собственик на парцела
        const owner = await landNFTContract.ownerOf(landId);
        if (owner.toLowerCase() !== playerAddress.toLowerCase()) {
          return res.status(403).json({ error: "Player is not owner of landId" });
        }

        if (cfg.operation === "ACTIVATE_BUILDING") {
          // activateBuilding(uint256 landId, address player, uint8 buildingType)
          onchainTx = await parcelStateContract.activateBuilding(
            landId,
            playerAddress,
            buildingType
          );
        } else if (cfg.operation === "SET_BUILDING_ACTIVE") {
          if (typeof active !== "boolean") {
            return res
              .status(400)
              .json({ error: "Invalid 'active' flag (must be boolean)" });
          }

          // setBuildingActive(uint256 landId, address player, uint8 buildingType, bool active)
          onchainTx = await parcelStateContract.setBuildingActive(
            landId,
            playerAddress,
            buildingType,
            active
          );
        } else {
          return res.status(500).json({ error: "Unsupported PARCEL operation" });
        }
      }

      // Ако нито един от клоновете не е хванал действието
      else {
        return res.status(500).json({
          error:
            "Unsupported actionType or required contract not configured on server",
        });
      }

      const onchainReceipt = await onchainTx.wait();

      return res.json({
        ok: true,
        actionType,
        paymentTxHash: txHash,
        onchainTxHash: onchainReceipt.transactionHash,
      });
    } catch (e) {
      console.error("[/billing/complete] error:", e);
      return res.status(500).json({ error: e?.message || String(e) });
    }
  });
}
