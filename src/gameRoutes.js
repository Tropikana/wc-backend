// src/gameRoutes.js

import { ethers } from "ethers";
import {
  gameCurrencyContract,
  resourceNFTContract,
  landNFTContract,
  parcelStateContract,
  toGameCurrencyUnits,
  gameServerAddress,
} from "./blockchain.js";

/**
 * Регистрира маршрутите за играта върху подаден Express app.
 * Вика се от server.js:  setupGameRoutes(app)
 */
export function setupGameRoutes(app) {
  // малък helper за лог
  console.log("[gameRoutes] GAME_SERVER_WALLET =", gameServerAddress);

  /* --------- Health check за blockchain слоя --------- */
  app.get("/game/health", async (_req, res) => {
    try {
      const network = await (await import("ethers")).then((m) =>
        m.getDefaultProvider ? null : null
      ); // просто placeholder – по-долу ще върнем basic info

      res.json({
        ok: true,
        gameServerAddress,
        hasGameCurrency: !!gameCurrencyContract,
        hasResourceNFT: !!resourceNFTContract,
        hasLandNFT: !!landNFTContract,
        hasParcelState: !!parcelStateContract,
      });
    } catch (e) {
      console.error("[/game/health] error:", e);
      res.status(500).json({ ok: false, error: e?.message || String(e) });
    }
  });

  /* ======================= CURRENCY ======================= */

  // Mint валута към играча (изкарване от играта → on-chain)
  app.post("/game/currency/mint", async (req, res) => {
    try {
      if (!gameCurrencyContract) {
        return res
          .status(500)
          .json({ error: "GameCurrency contract not configured" });
      }

      const { playerAddress, amount } = req.body || {};

      if (!ethers.isAddress(playerAddress)) {
        return res.status(400).json({ error: "Invalid playerAddress" });
      }
      if (!Number.isInteger(amount) || amount <= 0) {
        return res.status(400).json({
          error: "Invalid amount (must be positive integer)",
        });
      }

      // Тук по-късно може да проверяваш login/session на играча

      // Преобразуваме amount (цяло число) към 18-десетични единици
      const onChainAmount = toGameCurrencyUnits(amount);

      // ✅ Името на функцията в договора е mintTo, не mintToPlayer
      const tx = await gameCurrencyContract.mintTo(
        playerAddress,
        onChainAmount
      );
      const receipt = await tx.wait();

      res.json({
        ok: true,
        txHash: receipt.transactionHash,
      });
    } catch (e) {
      console.error("[/game/currency/mint] error:", e);
      res.status(500).json({ error: e?.message || String(e) });
    }
  });

  // Burn валута от играча (вкарване в играта → off-chain)
  app.post("/game/currency/burn", async (req, res) => {
    try {
      if (!gameCurrencyContract) {
        return res
          .status(500)
          .json({ error: "GameCurrency contract not configured" });
      }

      const { playerAddress, amount } = req.body || {};

      if (!ethers.isAddress(playerAddress)) {
        return res.status(400).json({ error: "Invalid playerAddress" });
      }
      if (!Number.isInteger(amount) || amount <= 0) {
        return res.status(400).json({
          error: "Invalid amount (must be positive integer)",
        });
      }

      const onChainAmount = toGameCurrencyUnits(amount);

      const tx = await gameCurrencyContract.burnFromAccount(
        playerAddress,
        onChainAmount
      );
      const receipt = await tx.wait();

      res.json({
        ok: true,
        txHash: receipt.transactionHash,
      });
    } catch (e) {
      console.error("[/game/currency/burn] error:", e);
      res.status(500).json({ error: e?.message || String(e) });
    }
  });

  /* ======================= RESOURCES ======================= */

  // Mint ресурс към играча
  app.post("/game/resource/mint", async (req, res) => {
    try {
      if (!resourceNFTContract) {
        return res
          .status(500)
          .json({ error: "ResourceNFT contract not configured" });
      }

      const { playerAddress, resourceId, amount } = req.body || {};

      if (!ethers.isAddress(playerAddress)) {
        return res.status(400).json({ error: "Invalid playerAddress" });
      }
      if (!Number.isInteger(resourceId) || resourceId <= 0) {
        return res.status(400).json({ error: "Invalid resourceId" });
      }
      if (!Number.isInteger(amount) || amount <= 0) {
        return res.status(400).json({ error: "Invalid amount" });
      }

      // data може да е празно:
      const data = "0x";

      const tx = await resourceNFTContract.mintResource(
        playerAddress,
        resourceId,
        amount,
        data
      );
      const receipt = await tx.wait();

      res.json({
        ok: true,
        txHash: receipt.transactionHash,
      });
    } catch (e) {
      console.error("[/game/resource/mint] error:", e);
      res.status(500).json({ error: e?.message || String(e) });
    }
  });

  // Burn ресурс от играча
  app.post("/game/resource/burn", async (req, res) => {
    try {
      if (!resourceNFTContract) {
        return res
          .status(500)
          .json({ error: "ResourceNFT contract not configured" });
      }

      const { playerAddress, resourceId, amount } = req.body || {};

      if (!ethers.isAddress(playerAddress)) {
        return res.status(400).json({ error: "Invalid playerAddress" });
      }
      if (!Number.isInteger(resourceId) || resourceId <= 0) {
        return res.status(400).json({ error: "Invalid resourceId" });
      }
      if (!Number.isInteger(amount) || amount <= 0) {
        return res.status(400).json({ error: "Invalid amount" });
      }

      const tx = await resourceNFTContract.burnResource(
        playerAddress,
        resourceId,
        amount
      );
      const receipt = await tx.wait();

      res.json({
        ok: true,
        txHash: receipt.transactionHash,
      });
    } catch (e) {
      console.error("[/game/resource/burn] error:", e);
      res.status(500).json({ error: e?.message || String(e) });
    }
  });

  /* ======================= LAND / PARCEL STATE ======================= */

  // По желание: admin / server-only – минт на нов парцел
  app.post("/game/land/mint", async (req, res) => {
    try {
      if (!landNFTContract) {
        return res
          .status(500)
          .json({ error: "LandNFT contract not configured" });
      }

      const { playerAddress, tokenId } = req.body || {};

      if (!ethers.isAddress(playerAddress)) {
        return res.status(400).json({ error: "Invalid playerAddress" });
      }
      if (!Number.isInteger(tokenId) || tokenId <= 0) {
        return res.status(400).json({ error: "Invalid tokenId" });
      }

      const tx = await landNFTContract.mintLand(playerAddress, tokenId);
      const receipt = await tx.wait();

      res.json({
        ok: true,
        txHash: receipt.transactionHash,
      });
    } catch (e) {
      console.error("[/game/land/mint] error:", e);
      res.status(500).json({ error: e?.message || String(e) });
    }
  });

  // Активиране/строеж на сграда върху парцел (ParcelState.activateBuilding)
  app.post("/game/parcel/activate-building", async (req, res) => {
    try {
      if (!parcelStateContract || !landNFTContract) {
        return res.status(500).json({
          error: "ParcelState or LandNFT contract not configured",
        });
      }

      const { playerAddress, landId, buildingType } = req.body || {};

      if (!ethers.isAddress(playerAddress)) {
        return res.status(400).json({ error: "Invalid playerAddress" });
      }
      if (!Number.isInteger(landId) || landId <= 0) {
        return res.status(400).json({ error: "Invalid landId" });
      }
      if (!Number.isInteger(buildingType) || buildingType < 0 || buildingType > 5) {
        return res
          .status(400)
          .json({ error: "Invalid buildingType (0..5)" });
      }

      // проверка, че playerAddress е собственик на landId
      const owner = await landNFTContract.ownerOf(landId);
      if (owner.toLowerCase() !== playerAddress.toLowerCase()) {
        return res.status(403).json({ error: "Player is not owner of landId" });
      }

      // ✅ Редът на параметрите трябва да е (landId, playerAddress, buildingType)
      const tx = await parcelStateContract.activateBuilding(
        landId,
        playerAddress,
        buildingType
      );
      const receipt = await tx.wait();

      res.json({
        ok: true,
        txHash: receipt.transactionHash,
      });
    } catch (e) {
      console.error("[/game/parcel/activate-building] error:", e);
      res.status(500).json({ error: e?.message || String(e) });
    }
  });

  // Включване/изключване на съществуваща сграда (setBuildingActive)
  app.post("/game/parcel/set-building-active", async (req, res) => {
    try {
      if (!parcelStateContract || !landNFTContract) {
        return res.status(500).json({
          error: "ParcelState or LandNFT contract not configured",
        });
      }

      const { playerAddress, landId, buildingType, active } = req.body || {};

      if (!ethers.isAddress(playerAddress)) {
        return res.status(400).json({ error: "Invalid playerAddress" });
      }
      if (!Number.isInteger(landId) || landId <= 0) {
        return res.status(400).json({ error: "Invalid landId" });
      }
      if (!Number.isInteger(buildingType) || buildingType < 0 || buildingType > 5) {
        return res
          .status(400)
          .json({ error: "Invalid buildingType (0..5)" });
      }
      if (typeof active !== "boolean") {
        return res
          .status(400)
          .json({ error: "Invalid active flag (must be boolean)" });
      }

      // проверка, че playerAddress е собственик на landId
      const owner = await landNFTContract.ownerOf(landId);
      if (owner.toLowerCase() !== playerAddress.toLowerCase()) {
        return res.status(403).json({ error: "Player is not owner of landId" });
      }

      // ✅ Редът на параметрите: (landId, playerAddress, buildingType, active)
      const tx = await parcelStateContract.setBuildingActive(
        landId,
        playerAddress,
        buildingType,
        active
      );
      const receipt = await tx.wait();

      res.json({
        ok: true,
        txHash: receipt.transactionHash,
      });
    } catch (e) {
      console.error("[/game/parcel/set-building-active] error:", e);
      res.status(500).json({ error: e?.message || String(e) });
    }
  });
}
