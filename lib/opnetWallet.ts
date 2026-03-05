"use client";

import { bech32m } from "bech32";
import type { OPWallet } from "@btc-vision/transaction";
import type { UTXO } from "@btc-vision/transaction";

// ─── Config ──────────────────────────────────────────────────────────────────
// Fill in once the contract is deployed to OP_NET testnet
export const VAULT_CONTRACT_ADDRESS = "opt1sqr3wssn4w90mkuym8hd0asv0m96fexay4svx7rdy";
export const OPNET_TESTNET_RPC = "https://testnet.opnet.org";
export const OPNET_PRIORITY_FEE = 1000n; // satoshis

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
    throw new Error(
      "OPWallet not found. Install it from https://opwallet.org"
    );
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

// ─── UTXO / fee fetching via OP_NET JSON-RPC ─────────────────────────────────
interface RawUTXO {
  transactionId: string;
  outputIndex: number;
  value: string;
  scriptPubKey?: string;
}

export async function fetchUTXOs(address: string): Promise<UTXO[]> {
  const res = await fetch(OPNET_TESTNET_RPC, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "btc_getUTXOs",
      params: [{ address, optimize: false }],
    }),
  });
  const json = await res.json();
  if (json.error) throw new Error(json.error.message ?? "Failed to fetch UTXOs");
  const { confirmed = [], pending = [] }: { confirmed: RawUTXO[]; pending: RawUTXO[] } =
    json.result ?? {};
  const toUTXO = (u: RawUTXO): UTXO => ({
    transactionId: u.transactionId,
    outputIndex: u.outputIndex,
    value: BigInt(u.value),
    scriptPubKey: { hex: u.scriptPubKey ?? "" },
  });
  return [...confirmed, ...pending].map(toUTXO);
}

export async function fetchFeeRate(): Promise<number> {
  try {
    const res = await fetch(OPNET_TESTNET_RPC, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "btc_gas", params: [] }),
    });
    const json = await res.json();
    if (json.result?.gasPrice) return Number(json.result.gasPrice);
  } catch {
    // fall through
  }
  return 10;
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
  const decoded = bech32m.decode(addr);
  const bytes = bech32m.fromWords(decoded.words.slice(1));
  if (bytes.length !== 32) {
    throw new Error(`Expected 32-byte address, got ${bytes.length} from: ${addr}`);
  }
  return new Uint8Array(bytes);
}

function concat(...arrays: Uint8Array[]): Buffer {
  const total = arrays.reduce((s, a) => s + a.length, 0);
  const out = Buffer.alloc(total);
  let offset = 0;
  for (const a of arrays) { out.set(a, offset); offset += a.length; }
  return out;
}

export async function encodeDeposit(
  heirAddress: string,
  timerBlocks: bigint,
  satoshis: bigint
): Promise<Buffer> {
  const sel = await makeSelector("deposit(address,u64,u256)");
  return concat(
    writeU32BE(sel),
    decodeAddressTo32Bytes(heirAddress),
    writeU64BE(timerBlocks),
    writeU256BE(satoshis)
  );
}

export async function encodeHeartbeat(): Promise<Buffer> {
  return Buffer.from(writeU32BE(await makeSelector("heartbeat()")));
}

export async function encodeClaim(): Promise<Buffer> {
  return Buffer.from(writeU32BE(await makeSelector("claim()")));
}

// ─── Transaction signing & broadcast ─────────────────────────────────────────
export interface TxResult {
  success: boolean;
  txId?: string;
  error?: string;
}

export async function sendVaultInteraction(
  calldata: Buffer,
  utxos: UTXO[],
  feeRate: number
): Promise<TxResult> {
  if (!isOpNetWalletInstalled() || !window.opnet?.web3) {
    throw new Error("OPWallet not connected");
  }
  if (!VAULT_CONTRACT_ADDRESS) throw new Error("CONTRACT_NOT_DEPLOYED");

  // The OPWallet extension supplies `network`, `signer`, and `gasSatFee` internally;
  // we cast to bypass the strict TS type while passing the fields we control.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [, interactionResult] =
    await window.opnet!.web3.signAndBroadcastInteraction({
      to: VAULT_CONTRACT_ADDRESS as string,
      calldata,
      utxos,
      feeRate,
      priorityFee: OPNET_PRIORITY_FEE,
    } as any);

  if (!interactionResult.success) {
    return { success: false, error: interactionResult.error ?? "Transaction failed" };
  }
  return { success: true, txId: interactionResult.result };
}
