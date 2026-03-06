"use client";

import type { OPWallet } from "@btc-vision/transaction";
import type { UTXO } from "@btc-vision/transaction";

// ─── Config ──────────────────────────────────────────────────────────────────
export const VAULT_CONTRACT_ADDRESS = "opt1sqzhu4nxjyj7hgwx4khnfm5h5cp39xxymcsdjzrs4";
export const OPNET_PRIORITY_FEE = 1000n; // satoshis
export const OPNET_DEFAULT_FEE_RATE = 10;  // sat/vbyte fallback
export const OPNET_GAS_SAT_FEE = 330n;    // sat — passed to wallet for gas

// ─── Window type augmentation ─────────────────────────────────────────────────
declare global {
  interface Window {
    opnet?: OPWallet;
  }
}

// ─── Wallet connection ────────────────────────────────────────────────────────
export function isOpNetWalletInstalled(): boolean {
  return typeof window !== "undefined" && !!window.opnet;
}

export async function connectOpNetWallet(): Promise<string[]> {
  if (!isOpNetWalletInstalled()) {
    throw new Error("OPWallet not found. Install it from https://opwallet.org");
  }
  return window.opnet!.requestAccounts();
}

export async function getConnectedAccounts(): Promise<string[]> {
  if (!isOpNetWalletInstalled()) return [];
  try {
    return await window.opnet!.getAccounts();
  } catch {
    return [];
  }
}

export async function getWalletBalance(): Promise<{
  confirmed: number;
  unconfirmed: number;
  total: number;
}> {
  if (!isOpNetWalletInstalled()) return { confirmed: 0, unconfirmed: 0, total: 0 };
  return window.opnet!.getBalance();
}

// ─── UTXO fetching via OPWallet (no direct RPC needed) ───────────────────────
//
// OPWallet connects to the OP_NET node through its own authenticated background
// service.  Calling window.opnet.getBitcoinUtxos() is both simpler and more
// reliable than hitting the public RPC endpoint from the browser.

export async function fetchUTXOs(): Promise<UTXO[]> {
  if (!isOpNetWalletInstalled()) return [];
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const raw = await (window.opnet as any).getBitcoinUtxos(0, 50);
    if (Array.isArray(raw)) return raw as UTXO[];
  } catch {
    // fall through
  }
  return [];
}

export async function fetchFeeRate(): Promise<number> {
  return OPNET_DEFAULT_FEE_RATE;
}

// ─── Calldata encoding ────────────────────────────────────────────────────────
async function sha256Bytes(input: string): Promise<Uint8Array> {
  const encoded = new TextEncoder().encode(input);
  const hashBuffer = await crypto.subtle.digest("SHA-256", encoded);
  return new Uint8Array(hashBuffer);
}

async function makeSelector(sig: string): Promise<number> {
  const hash = await sha256Bytes(sig);
  return (
    ((hash[0]! << 24) | (hash[1]! << 16) | (hash[2]! << 8) | hash[3]!) >>> 0
  );
}

function writeU32BE(v: number): Uint8Array {
  return new Uint8Array([(v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff]);
}

function writeU64BE(v: bigint): Uint8Array {
  const buf = new Uint8Array(8);
  let n = v;
  for (let i = 7; i >= 0; i--) { buf[i] = Number(n & 0xffn); n >>= 8n; }
  return buf;
}

function writeU256BE(v: bigint): Uint8Array {
  const buf = new Uint8Array(32);
  let n = v;
  for (let i = 31; i >= 0; i--) { buf[i] = Number(n & 0xffn); n >>= 8n; }
  return buf;
}

function decodeAddressTo32Bytes(addr: string): Uint8Array {
  const clean = addr.startsWith("0x") ? addr.slice(2) : addr;
  if (clean.length !== 64) {
    throw new Error("Heir address must be a 64-character hex string");
  }
  const result = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {
    result[i] = parseInt(clean.substring(i * 2, i * 2 + 2), 16);
  }
  return result;
}

function concat(...arrays: Uint8Array[]): Uint8Array {
  const total = arrays.reduce((s, a) => s + a.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const a of arrays) { out.set(a, offset); offset += a.length; }
  return out;
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function encodeDeposit(
  heirAddress: string,
  timerBlocks: bigint,
  satoshis: bigint
): Promise<string> {
  const sel = await makeSelector("deposit(address,u64,u256)");
  return toHex(concat(
    writeU32BE(sel),
    decodeAddressTo32Bytes(heirAddress),
    writeU64BE(timerBlocks),
    writeU256BE(satoshis)
  ));
}

export async function encodeHeartbeat(): Promise<string> {
  return toHex(writeU32BE(await makeSelector("heartbeat()")));
}

export async function encodeClaim(): Promise<string> {
  return toHex(writeU32BE(await makeSelector("claim()")));
}

// ─── Transaction signing & broadcast ─────────────────────────────────────────
export interface TxResult {
  success: boolean;
  txId?: string;
  error?: string;
}

export async function sendVaultInteraction(
  calldata: string,
  utxos: UTXO[],
  feeRate: number,
  from: string
): Promise<TxResult> {
  if (!isOpNetWalletInstalled() || !window.opnet?.web3) {
    throw new Error("OPWallet not connected");
  }
  if (!VAULT_CONTRACT_ADDRESS) throw new Error("CONTRACT_NOT_DEPLOYED");

  // Wallet expects calldata as Uint8Array (bytes), not a hex string.
  // pageProvider.js applies bytesToHex() on it before sending to background.
  const calldataBytes = new Uint8Array(
    calldata.match(/.{2}/g)!.map((b) => parseInt(b, 16))
  );

  const interactionObject = {
    from,
    to: VAULT_CONTRACT_ADDRESS,
    contract: VAULT_CONTRACT_ADDRESS,
    calldata: calldataBytes,
    utxos,
    feeRate,
    priorityFee: Number(OPNET_PRIORITY_FEE),
    gasSatFee: Number(OPNET_GAS_SAT_FEE),
  };
  console.log("SENDING TO WALLET:", interactionObject);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [, interactionResult] =
    await window.opnet!.web3.signAndBroadcastInteraction(interactionObject as any);

  if (!interactionResult.success) {
    return { success: false, error: interactionResult.error ?? "Transaction failed" };
  }
  return { success: true, txId: interactionResult.result };
}
