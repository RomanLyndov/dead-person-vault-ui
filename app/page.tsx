"use client";

import { useState, useEffect, useCallback } from "react";
import {
  VaultState,
  VaultEvent,
  formatBTC,
  formatBlocks,
  blocksRemaining,
  isExpired,
  expiryPercent,
  shortAddr,
  BLOCKS_PER_DAY,
} from "../lib/vault";
import {
  VAULT_CONTRACT_ADDRESS,
  connectOpNetWallet,
  getConnectedAccounts,
  getWalletBalance,
  fetchUTXOs,
  fetchFeeRate,
  encodeDeposit,
  encodeHeartbeat,
  encodeClaim,
  sendVaultInteraction,
} from "../lib/opnetWallet";

const DEMO_OWNER = "opt1pvytqa0xkzm2nkzr8rf8kwvpqrjjpazjm9uwa";
const DEMO_HEIR = "opt1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4";

function initialState(): VaultState {
  return {
    isActive: false,
    isClaimed: false,
    owner: DEMO_OWNER,
    heir: DEMO_HEIR,
    balance: 0n,
    lastHeartbeat: 0n,
    timerDuration: 30n * BLOCKS_PER_DAY,
    currentBlock: 840000n,
  };
}

export default function Home() {
  const [vault, setVault] = useState<VaultState>(initialState());
  const [events, setEvents] = useState<VaultEvent[]>([]);
  const [depositAmount, setDepositAmount] = useState("0.01");
  const [timerDays, setTimerDays] = useState("30");
  const [heirAddress, setHeirAddress] = useState(DEMO_HEIR);

  // Wallet state
  const [walletAddress, setWalletAddress] = useState<string | null>(null);
  const [walletBalance, setWalletBalance] = useState<number | null>(null);
  const [isConnecting, setIsConnecting] = useState(false);
  const [walletError, setWalletError] = useState<string | null>(null);
  const [txPending, setTxPending] = useState(false);
  const [txMessage, setTxMessage] = useState<{ type: "ok" | "err" | "info"; text: string } | null>(null);

  const isSimulation = !VAULT_CONTRACT_ADDRESS;

  useEffect(() => {
    const interval = setInterval(() => {
      setVault((v) => ({ ...v, currentBlock: v.currentBlock + 1n }));
    }, 3000);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    getConnectedAccounts().then((accounts) => {
      if (accounts.length > 0) {
        setWalletAddress(accounts[0]!);
        getWalletBalance().then((b) => setWalletBalance(b.total)).catch(() => {});
      }
    });
  }, []);

  const addEvent = useCallback(
    (type: VaultEvent["type"], message: string, block: bigint) => {
      setEvents((prev) => [
        { type, message, block, timestamp: new Date() },
        ...prev.slice(0, 19),
      ]);
    },
    []
  );

  function showTx(type: "ok" | "err" | "info", text: string) {
    setTxMessage({ type, text });
    setTimeout(() => setTxMessage(null), 6000);
  }

  async function handleConnect() {
    setWalletError(null);
    setIsConnecting(true);
    try {
      const accounts = await connectOpNetWallet();
      if (accounts.length === 0) throw new Error("No accounts returned");
      setWalletAddress(accounts[0]!);
      getWalletBalance().then((b) => setWalletBalance(b.total)).catch(() => {});
      setVault((v) => ({ ...v, owner: accounts[0]! }));
    } catch (e) {
      setWalletError(e instanceof Error ? e.message : "Connection failed");
    } finally {
      setIsConnecting(false);
    }
  }

  async function ensureConnected(): Promise<string | null> {
    if (walletAddress) return walletAddress;
    await handleConnect();
    return walletAddress;
  }

  async function handleDeposit() {
    const satoshis = BigInt(Math.round(parseFloat(depositAmount) * 1e8));
    if (satoshis <= 0n) return;
    const duration = BigInt(parseInt(timerDays)) * BLOCKS_PER_DAY;
    if (isSimulation) {
      setVault((v) => ({ ...v, isActive: true, balance: v.balance + satoshis, lastHeartbeat: v.currentBlock, timerDuration: duration }));
      addEvent("Deposit", "[SIMULATION] Deposited " + formatBTC(satoshis) + " with " + timerDays + "-day timer", vault.currentBlock);
      return;
    }
    const addr = await ensureConnected();
    if (!addr) return;
    setTxPending(true);
    showTx("info", "Building transaction...");
    try {
      const [utxos, feeRate, calldata] = await Promise.all([fetchUTXOs(), fetchFeeRate(), encodeDeposit(heirAddress, duration, satoshis)]);
      if (utxos.length === 0) throw new Error("No UTXOs available. Fund your wallet first.");
      showTx("info", "Check OPWallet to sign...");
      const result = await sendVaultInteraction(calldata, utxos, feeRate);
      if (result.success) {
        showTx("ok", "Deposit sent! TX: " + (result.txId?.slice(0, 16) ?? "") + "...");
        setVault((v) => ({ ...v, isActive: true, balance: v.balance + satoshis, lastHeartbeat: v.currentBlock, timerDuration: duration }));
        addEvent("Deposit", "Deposited " + formatBTC(satoshis) + " on-chain", vault.currentBlock);
      } else {
        showTx("err", result.error ?? "Transaction failed");
        addEvent("Error", result.error ?? "Deposit failed", vault.currentBlock);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Unknown error";
      showTx("err", msg);
      addEvent("Error", msg, vault.currentBlock);
    } finally { setTxPending(false); }
  }

  async function handleHeartbeat() {
    if (!vault.isActive || vault.isClaimed) return;
    if (isSimulation) {
      setVault((v) => ({ ...v, lastHeartbeat: v.currentBlock }));
      addEvent("Heartbeat", "[SIMULATION] Owner reset the dead man timer", vault.currentBlock);
      return;
    }
    const addr = await ensureConnected();
    if (!addr) return;
    setTxPending(true);
    showTx("info", "Building heartbeat...");
    try {
      const [utxos, feeRate, calldata] = await Promise.all([fetchUTXOs(), fetchFeeRate(), encodeHeartbeat()]);
      showTx("info", "Check OPWallet to sign...");
      const result = await sendVaultInteraction(calldata, utxos, feeRate);
      if (result.success) {
        showTx("ok", "Heartbeat sent! TX: " + (result.txId?.slice(0, 16) ?? "") + "...");
        setVault((v) => ({ ...v, lastHeartbeat: v.currentBlock }));
        addEvent("Heartbeat", "On-chain heartbeat sent", vault.currentBlock);
      } else {
        showTx("err", result.error ?? "Transaction failed");
        addEvent("Error", result.error ?? "Heartbeat failed", vault.currentBlock);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Unknown error";
      showTx("err", msg);
      addEvent("Error", msg, vault.currentBlock);
    } finally { setTxPending(false); }
  }

  async function handleClaim() {
    if (!vault.isActive || vault.isClaimed) return;
    if (!isExpired(vault)) return;
    if (isSimulation) {
      setVault((v) => ({ ...v, isClaimed: true, isActive: false, balance: 0n }));
      addEvent("Claimed", "[SIMULATION] Heir claimed " + formatBTC(vault.balance), vault.currentBlock);
      return;
    }
    const addr = await ensureConnected();
    if (!addr) return;
    setTxPending(true);
    showTx("info", "Building claim transaction...");
    try {
      const [utxos, feeRate, calldata] = await Promise.all([fetchUTXOs(), fetchFeeRate(), encodeClaim()]);
      showTx("info", "Check OPWallet to sign...");
      const result = await sendVaultInteraction(calldata, utxos, feeRate);
      if (result.success) {
        showTx("ok", "Claim sent! TX: " + (result.txId?.slice(0, 16) ?? "") + "...");
        setVault((v) => ({ ...v, isClaimed: true, isActive: false, balance: 0n }));
        addEvent("Claimed", "On-chain claim sent", vault.currentBlock);
      } else {
        showTx("err", result.error ?? "Transaction failed");
        addEvent("Error", result.error ?? "Claim failed", vault.currentBlock);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Unknown error";
      showTx("err", msg);
      addEvent("Error", msg, vault.currentBlock);
    } finally { setTxPending(false); }
  }

  function handleReset() {
    setVault(initialState());
    setEvents([]);
    setTxMessage(null);
  }

  const expired = isExpired(vault);
  const pct = expiryPercent(vault);
  const remaining = blocksRemaining(vault);
  const barColor = pct >= 90 ? "bg-red-500" : pct >= 60 ? "bg-yellow-500" : "bg-green-500";

  return (
    <main className="min-h-screen p-6 max-w-4xl mx-auto">
      {/* TX toast */}
      {txMessage && (
        <div className={`fixed top-4 right-4 z-50 px-4 py-3 rounded text-sm font-mono max-w-sm shadow-lg border ${
          txMessage.type === "ok" ? "bg-green-900 border-green-600 text-green-200"
          : txMessage.type === "err" ? "bg-red-900 border-red-600 text-red-200"
          : "bg-neutral-800 border-neutral-600 text-neutral-200"
        }`}>
          {txMessage.text}
        </div>
      )}

      {/* Header */}
      <div className="mb-8 border-b border-neutral-700 pb-6">
        <div className="flex items-center justify-between flex-wrap gap-4">
          <div>
            <h1 className="text-2xl font-bold text-orange-400 tracking-wider">
              ☠ DEAD PERSON VAULT
            </h1>
            <p className="text-neutral-400 text-sm mt-1">
              On-chain Bitcoin inheritance — powered by OP_NET
            </p>
          </div>
          <div className="flex flex-col items-end gap-1">
            {walletAddress ? (
              <div className="flex flex-col items-end gap-1">
                <div className="flex items-center gap-2">
                  <div className="w-2 h-2 rounded-full bg-green-400" />
                  <span className="text-green-400 text-xs font-mono">{shortAddr(walletAddress)}</span>
                </div>
                {walletBalance !== null && (
                  <span className="text-neutral-500 text-xs">{(walletBalance / 1e8).toFixed(8)} BTC</span>
                )}
              </div>
            ) : (
              <button onClick={handleConnect} disabled={isConnecting}
                className="bg-orange-500 hover:bg-orange-400 disabled:opacity-50 text-black font-bold py-1.5 px-4 rounded text-sm transition-colors">
                {isConnecting ? "Connecting..." : "Connect OPWallet"}
              </button>
            )}
            {walletError && <span className="text-red-400 text-xs max-w-xs text-right">{walletError}</span>}
          </div>
        </div>
        <div className="flex items-center justify-between mt-3">
          <div className="text-xs text-neutral-500">
            Block #{vault.currentBlock.toString()}
            <span className="ml-2 text-neutral-700">~3s per tick (demo)</span>
          </div>
          {isSimulation ? (
            <span className="text-xs bg-yellow-900 text-yellow-300 border border-yellow-700 px-2 py-0.5 rounded">
              SIMULATION MODE — no contract deployed
            </span>
          ) : (
            <span className="text-xs bg-green-900 text-green-300 border border-green-700 px-2 py-0.5 rounded">
              LIVE — OP_NET Testnet
            </span>
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {/* Left column */}
        <div className="space-y-4">
          {/* Vault status card */}
          <div className="border border-neutral-700 rounded p-4">
            <div className="text-xs text-neutral-500 uppercase tracking-widest mb-3">
              Vault Status
            </div>
            <div className="flex items-center gap-3 mb-4">
              <div
                className={`w-3 h-3 rounded-full ${
                  vault.isClaimed
                    ? "bg-purple-400"
                    : vault.isActive && expired
                    ? "bg-red-500 animate-pulse"
                    : vault.isActive
                    ? "bg-green-500 animate-pulse"
                    : "bg-neutral-600"
                }`}
              />
              <span className="text-lg font-bold">
                {vault.isClaimed
                  ? "CLAIMED"
                  : vault.isActive && expired
                  ? "EXPIRED — CLAIMABLE"
                  : vault.isActive
                  ? "ACTIVE"
                  : "INACTIVE"}
              </span>
            </div>

            <div className="space-y-2 text-sm">
              <Row label="Balance" value={formatBTC(vault.balance)} highlight />
              <Row
                label="Owner"
                value={walletAddress ? shortAddr(walletAddress) : shortAddr(vault.owner)}
                mono
              />
              <Row
                label="Heir"
                value={shortAddr(heirAddress)}
                mono
              />
              <Row
                label="Timer"
                value={formatBlocks(vault.timerDuration)}
              />
              {vault.isActive && (
                <Row
                  label="Last heartbeat"
                  value={`Block ${vault.lastHeartbeat.toString()}`}
                />
              )}
            </div>
          </div>

          {/* Timer bar */}
          {vault.isActive && !vault.isClaimed && (
            <div className="border border-neutral-700 rounded p-4">
              <div className="text-xs text-neutral-500 uppercase tracking-widest mb-3">
                Expiry Timer
              </div>
              <div className="w-full bg-neutral-800 rounded h-3 mb-2">
                <div
                  className={`h-3 rounded transition-all duration-500 ${barColor}`}
                  style={{ width: `${Math.min(100, pct)}%` }}
                />
              </div>
              <div className="flex justify-between text-xs text-neutral-500">
                <span>{pct.toFixed(1)}% elapsed</span>
                {expired ? (
                  <span className="text-red-400 font-bold">TIMER EXPIRED</span>
                ) : (
                  <span>{formatBlocks(remaining)} left</span>
                )}
              </div>
            </div>
          )}

          {/* Actions */}
          <div className="border border-neutral-700 rounded p-4 space-y-3">
            <div className="text-xs text-neutral-500 uppercase tracking-widest mb-3">
              Actions
            </div>

            {/* Deposit */}
            {!vault.isActive && !vault.isClaimed && (
              <div className="space-y-2">
                <div className="flex gap-2">
                  <div className="flex-1">
                    <label className="text-xs text-neutral-500 block mb-1">
                      Amount (BTC)
                    </label>
                    <input
                      type="number"
                      step="0.001"
                      min="0.001"
                      value={depositAmount}
                      onChange={(e) => setDepositAmount(e.target.value)}
                      className="w-full bg-neutral-900 border border-neutral-600 rounded px-3 py-2 text-sm text-white focus:outline-none focus:border-orange-500"
                    />
                  </div>
                  <div className="flex-1">
                    <label className="text-xs text-neutral-500 block mb-1">
                      Timer (days)
                    </label>
                    <input
                      type="number"
                      min="1"
                      max="365"
                      value={timerDays}
                      onChange={(e) => setTimerDays(e.target.value)}
                      className="w-full bg-neutral-900 border border-neutral-600 rounded px-3 py-2 text-sm text-white focus:outline-none focus:border-orange-500"
                    />
                  </div>
                </div>
                <div>
                  <label className="text-xs text-neutral-500 block mb-1">
                    Heir address (opt1... or tb1p...)
                  </label>
                  <input
                    type="text"
                    value={heirAddress}
                    onChange={(e) => setHeirAddress(e.target.value)}
                    placeholder="opt1... or tb1p..."
                    className="w-full bg-neutral-900 border border-neutral-600 rounded px-3 py-2 text-xs font-mono text-white focus:outline-none focus:border-orange-500"
                  />
                </div>
                <button
                  onClick={handleDeposit}
                  disabled={txPending}
                  className="w-full bg-orange-500 hover:bg-orange-400 disabled:opacity-50 text-black font-bold py-2 px-4 rounded text-sm transition-colors"
                >
                  {txPending ? "SIGNING..." : isSimulation ? "DEPOSIT & ACTIVATE VAULT (SIMULATION)" : "DEPOSIT & ACTIVATE VAULT"}
                </button>
                {!walletAddress && !isSimulation && (
                  <p className="text-xs text-neutral-500 text-center">Will prompt OPWallet connection on click</p>
                )}
              </div>
            )}

            {/* Heartbeat */}
            {vault.isActive && !vault.isClaimed && !expired && (
              <button
                onClick={handleHeartbeat}
                disabled={txPending}
                className="w-full bg-green-700 hover:bg-green-600 disabled:opacity-50 text-white font-bold py-2 px-4 rounded text-sm transition-colors"
              >
                {txPending ? "SIGNING..." : isSimulation ? "♥ SEND HEARTBEAT (SIMULATION)" : "♥ SEND HEARTBEAT"}
              </button>
            )}

            {/* Claim */}
            {vault.isActive && expired && !vault.isClaimed && (
              <button
                onClick={handleClaim}
                disabled={txPending}
                className="w-full bg-red-700 hover:bg-red-600 disabled:opacity-50 text-white font-bold py-2 px-4 rounded text-sm transition-colors animate-pulse"
              >
                {txPending ? "SIGNING..." : isSimulation ? "⚠ HEIR: CLAIM VAULT (SIMULATION)" : "⚠ HEIR: CLAIM VAULT"}
              </button>
            )}

            {/* Reset */}
            {(vault.isClaimed || vault.isActive) && (
              <button
                onClick={handleReset}
                className="w-full border border-neutral-600 hover:border-neutral-400 text-neutral-400 hover:text-white py-2 px-4 rounded text-sm transition-colors"
              >
                RESET DEMO
              </button>
            )}
          </div>
        </div>

        {/* Right column — event log + info */}
        <div className="space-y-4">
          {/* How it works */}
          <div className="border border-neutral-700 rounded p-4">
            <div className="text-xs text-neutral-500 uppercase tracking-widest mb-3">
              How It Works
            </div>
            <ol className="space-y-2 text-sm text-neutral-300">
              <li className="flex gap-2">
                <span className="text-orange-400 font-bold">1.</span>
                Owner deposits BTC and sets a timer (e.g. 30 days = 4,320 blocks).
              </li>
              <li className="flex gap-2">
                <span className="text-orange-400 font-bold">2.</span>
                Owner must call <code className="text-green-400">heartbeat()</code> before
                the timer expires to prove they're alive.
              </li>
              <li className="flex gap-2">
                <span className="text-orange-400 font-bold">3.</span>
                If the timer runs out, the heir can call{" "}
                <code className="text-red-400">claim()</code> to inherit the BTC.
              </li>
              <li className="flex gap-2">
                <span className="text-orange-400 font-bold">4.</span>
                All logic runs on-chain via OP_NET (AssemblyScript → WASM on Bitcoin).
              </li>
            </ol>
          </div>

          {/* Contract info */}
          <div className="border border-neutral-700 rounded p-4">
            <div className="text-xs text-neutral-500 uppercase tracking-widest mb-3">
              Contract Methods
            </div>
            <div className="space-y-1 text-xs font-mono">
              <MethodRow name="deposit(address,u64,u256)" color="text-orange-400" />
              <MethodRow name="heartbeat()" color="text-green-400" />
              <MethodRow name="claim()" color="text-red-400" />
              <MethodRow name="getStatus()" color="text-blue-400" />
              <MethodRow name="isExpired()" color="text-blue-400" />
            </div>
            {VAULT_CONTRACT_ADDRESS ? (
              <div className="mt-3 text-xs text-neutral-500 font-mono break-all">Contract: {VAULT_CONTRACT_ADDRESS}</div>
            ) : (
              <div className="mt-3 text-xs text-yellow-600">
                Contract not deployed — set VAULT_CONTRACT_ADDRESS in lib/opnetWallet.ts
              </div>
            )}
          </div>

          {/* Event log */}
          <div className="border border-neutral-700 rounded p-4">
            <div className="text-xs text-neutral-500 uppercase tracking-widest mb-3">
              Event Log
            </div>
            {events.length === 0 ? (
              <div className="text-neutral-600 text-sm italic">
                No events yet. Deposit to activate vault.
              </div>
            ) : (
              <div className="space-y-2 max-h-64 overflow-y-auto">
                {events.map((ev, i) => (
                  <div
                    key={i}
                    className="text-xs border-l-2 pl-2 py-0.5"
                    style={{
                      borderColor:
                        ev.type === "Deposit"
                          ? "#f97316"
                          : ev.type === "Heartbeat"
                          ? "#22c55e"
                          : ev.type === "Claimed"
                          ? "#a855f7"
                          : "#ef4444",
                    }}
                  >
                    <div className="flex justify-between items-start gap-2">
                      <span
                        className={
                          ev.type === "Deposit"
                            ? "text-orange-400"
                            : ev.type === "Heartbeat"
                            ? "text-green-400"
                            : ev.type === "Claimed"
                            ? "text-purple-400"
                            : "text-red-400"
                        }
                      >
                        [{ev.type}]
                      </span>
                      <span className="text-neutral-600">
                        #{ev.block.toString()}
                      </span>
                    </div>
                    <div className="text-neutral-300">{ev.message}</div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Block info */}
          <div className="border border-neutral-700 rounded p-4">
            <div className="text-xs text-neutral-500 uppercase tracking-widest mb-2">
              Bitcoin Block Info
            </div>
            <div className="text-xs text-neutral-400 space-y-1">
              <div>1 day ≈ 144 blocks (10 min/block)</div>
              <div>30 days = 4,320 blocks</div>
              <div>1 year = 52,560 blocks</div>
              <div className="pt-1 text-neutral-600">
                Demo runs at 1 block / 3 seconds
              </div>
            </div>
          </div>
        </div>
      </div>

      <div className="mt-8 border-t border-neutral-800 pt-4 text-center text-xs text-neutral-700">
        Dead Person Vault — Week 2 OP_NET Vibecoding Event — AssemblyScript WASM on Bitcoin
      </div>
    </main>
  );
}

function Row({
  label,
  value,
  highlight,
  mono,
}: {
  label: string;
  value: string;
  highlight?: boolean;
  mono?: boolean;
}) {
  return (
    <div className="flex justify-between items-center">
      <span className="text-neutral-500">{label}</span>
      <span
        className={`${highlight ? "text-orange-400 font-bold" : "text-neutral-200"} ${
          mono ? "font-mono text-xs" : ""
        }`}
      >
        {value}
      </span>
    </div>
  );
}

function MethodRow({ name, color }: { name: string; color: string }) {
  return (
    <div className={`${color} opacity-80 hover:opacity-100 transition-opacity`}>
      {name}
    </div>
  );
}
