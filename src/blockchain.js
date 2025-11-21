// src/blockchain.js

import { ethers } from "ethers";
import { createRequire } from "module";

const require = createRequire(import.meta.url);

// Зареждаме ABI-тата през require, за да избегнем проблеми с import assertions
const GameCurrencyJson = require("../abi/GameCurrency.json");
const ResourceNFTJson = require("../abi/ResourceNFT.json");
const LandNFTJson = require("../abi/LandNFT.json");
const ParcelStateJson = require("../abi/ParcelState.json");

// При някои билдове ABI-то е в .abi, при други – целият JSON е само abi масив.
// Затова взимаме .abi ако го има, иначе целия обект.
const GameCurrencyAbi = GameCurrencyJson.abi || GameCurrencyJson;
const ResourceNFTAbi = ResourceNFTJson.abi || ResourceNFTJson;
const LandNFTAbi = LandNFTJson.abi || LandNFTJson;
const ParcelStateAbi = ParcelStateJson.abi || ParcelStateJson;

// ------- ENV променливи -------

const RPC_URL = (process.env.RPC_URL || "").trim();
const PRIVATE_KEY = (process.env.PRIVATE_KEY || "").trim();

const GAME_CURRENCY_ADDRESS = (process.env.GameCurrency_ADDRESS || "").trim();
const RESOURCE_NFT_ADDRESS = (process.env.ResourceNFT_CONTRACT_ADDRESS || "").trim();
const LAND_NFT_ADDRESS = (process.env.LandNFT_CONTRACT_ADDRESS || "").trim();
const PARCEL_STATE_ADDRESS = (process.env.ParcelState_CONTRACT_ADDRESS || "").trim();

if (!RPC_URL) {
  console.warn("[blockchain] WARNING: RPC_URL is not set");
}
if (!PRIVATE_KEY) {
  console.warn("[blockchain] WARNING: PRIVATE_KEY is not set");
}

// ------- Provider & Wallet -------

export const provider = RPC_URL
  ? new ethers.JsonRpcProvider(RPC_URL)
  : null;

export const wallet =
  provider && PRIVATE_KEY
    ? new ethers.Wallet(
        PRIVATE_KEY.startsWith("0x") ? PRIVATE_KEY : "0x" + PRIVATE_KEY,
        provider
      )
    : null;

export const gameServerAddress = wallet ? wallet.address : null;

if (gameServerAddress) {
  console.log("[blockchain] GAME_SERVER_WALLET address:", gameServerAddress);
} else {
  console.warn("[blockchain] GAME_SERVER_WALLET is not initialized (missing RPC_URL or PRIVATE_KEY)");
}

// ------- Contract инстанции -------

function makeContract(address, abi, name) {
  if (!provider || !wallet) {
    console.warn(`[blockchain] Cannot create ${name} contract – provider or wallet missing`);
    return null;
  }
  if (!address) {
    console.warn(`[blockchain] ${name} address is not set in env`);
    return null;
  }
  try {
    const contract = new ethers.Contract(address, abi, wallet);
    console.log(`[blockchain] ${name} contract bound at`, address);
    return contract;
  } catch (e) {
    console.error(`[blockchain] Failed to create ${name} contract:`, e?.message || e);
    return null;
  }
}

export const gameCurrencyContract = makeContract(
  GAME_CURRENCY_ADDRESS,
  GameCurrencyAbi,
  "GameCurrency"
);

export const resourceNFTContract = makeContract(
  RESOURCE_NFT_ADDRESS,
  ResourceNFTAbi,
  "ResourceNFT"
);

export const landNFTContract = makeContract(
  LAND_NFT_ADDRESS,
  LandNFTAbi,
  "LandNFT"
);

export const parcelStateContract = makeContract(
  PARCEL_STATE_ADDRESS,
  ParcelStateAbi,
  "ParcelState"
);

// ------- Helpers за GameCurrency -------

/**
 * Превръща цяло число (например 10) в 18-десетични единици
 * за on-chain (10 * 10^18).
 */
export function toGameCurrencyUnits(amountInt) {
  const n = BigInt(amountInt);
  return n * 10n ** 18n;
}

/**
 * Превръща 18-десетични единици от блокчейна към цяло число за играта.
 */
export function fromGameCurrencyUnits(units) {
  const big = BigInt(units);
  return big / 10n ** 18n;
}
