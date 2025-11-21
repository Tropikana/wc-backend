// src/blockchain.js
import { ethers } from "ethers";

// Зареждаме ABI-тата на договорите
// (папка abi/ трябва да е в root-а на проекта)
import GameCurrencyAbi from "../abi/GameCurrency.json" assert { type: "json" };
import ResourceNFTAbi from "../abi/ResourceNFT.json" assert { type: "json" };
import LandNFTAbi from "../abi/LandNFT.json" assert { type: "json" };
import ParcelStateAbi from "../abi/ParcelState.json" assert { type: "json" };

// Четем нужните променливи от средата
const {
  RPC_URL,
  PRIVATE_KEY,
  GameCurrency_ADDRESS,
  ResourceNFT_CONTRACT_ADDRESS,
  LandNFT_CONTRACT_ADDRESS,
  ParcelState_CONTRACT_ADDRESS
} = process.env;

// Базови проверки – без тези две няма как да тръгнем
if (!RPC_URL) {
  console.error("[blockchain] Missing RPC_URL env var");
  throw new Error("RPC_URL is required");
}

if (!PRIVATE_KEY) {
  console.error("[blockchain] Missing PRIVATE_KEY env var");
  throw new Error("PRIVATE_KEY is required");
}

// Създаваме provider и wallet (GAME_SERVER_WALLET)
export const provider = new ethers.JsonRpcProvider(RPC_URL);
export const wallet = new ethers.Wallet(PRIVATE_KEY, provider);
export const gameServerAddress = wallet.address;

console.log("[blockchain] GAME_SERVER_WALLET address:", gameServerAddress);

// Helper за създаване на контракт инстанция
function createContract(address, abi, name) {
  if (!address) {
    console.warn(`[blockchain] No address provided for ${name} (env var missing). Contract will be null.`);
    return null;
  }

  if (!ethers.isAddress(address)) {
    console.warn(`[blockchain] Invalid address for ${name}: ${address}`);
    return null;
  }

  return new ethers.Contract(address, abi, wallet);
}

// Инстанции на договорите (ако адресите са зададени)
export const gameCurrencyContract = createContract(
  GameCurrency_ADDRESS,
  GameCurrencyAbi,
  "GameCurrency"
);

export const resourceNFTContract = createContract(
  ResourceNFT_CONTRACT_ADDRESS,
  ResourceNFTAbi,
  "ResourceNFT"
);

export const landNFTContract = createContract(
  LandNFT_CONTRACT_ADDRESS,
  LandNFTAbi,
  "LandNFT"
);

export const parcelStateContract = createContract(
  ParcelState_CONTRACT_ADDRESS,
  ParcelStateAbi,
  "ParcelState"
);

// Helpers за работа с GameCurrency (decimals = 18)

/**
 * Превръща цяло число от играта (напр. 5) в on-chain стойност (5 * 10^18).
 * Пример: toGameCurrencyUnits(5) -> BigInt("5000000000000000000")
 */
export function toGameCurrencyUnits(amountInteger) {
  if (!Number.isInteger(amountInteger)) {
    throw new Error("toGameCurrencyUnits expects integer amount");
  }
  return ethers.parseUnits(amountInteger.toString(), 18);
}

/**
 * Превръща on-chain стойност (BigInt) в цяло число за играта.
 * Ако има дробна част, тя се отрязва.
 */
export function fromGameCurrencyUnits(onChainAmount) {
  const s = ethers.formatUnits(onChainAmount, 18); // връща string, напр. "5.0"
  return Math.floor(Number(s));
}
