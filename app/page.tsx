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
  BTC_DECIMALS,
  BLOCKS_PER_DAY,
} from "../lib/vault";

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
  const [tick, setTick] = useState(0);

  // Simulate block progression
  useEffect(() => {
    const interval = setInterval(() => {
      setVault((v) => ({ ...v, currentBlock: v.currentBlock + 1n }));
      setTick((t) => t + 1);
    }, 3000);
    return () => clearInterval(interval);
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

  function handleDeposit() {
    const satoshis = BigInt(Math.round(parseFloat(depositAmount) * 1e8));
    if (satoshis <= 0n) return;
    const duration = BigInt(parseInt(timerDays)) * BLOCKS_PER_DAY;
    setVault((v) => ({
      ...v,
      isActive: true,
      balance: v.balance + satoshis,
      lastHeartbeat: v.currentBlock,
      timerDuration: duration,
    }));
    addEvent(
      "Deposit",
      `Deposited ${formatBTC(satoshis)} — timer set to ${timerDays} days`,
      vault.currentBlock
    );
  }

  function handleHeartbeat() {
    if (!vault.isActive || vault.isClaimed) return;
    setVault((v) => ({ ...v, lastHeartbeat: v.currentBlock }));
    addEvent("Heartbeat", "Owner reset the dead man's timer", vault.currentBlock);
  }

  function handleClaim() {
    if (!vault.isActive || vault.isClaimed) return;
    if (!isExpired(vault)) return;
    setVault((v) => ({ ...v, isClaimed: true, isActive: false, balance: 0n }));
    addEvent(
      "Claimed",
      `Heir claimed ${formatBTC(vault.balance)}`,
      vault.currentBlock
    );
  }

  function handleReset() {
    setVault(initialState());
    setEvents([]);
  }

  const expired = isExpired(vault);
  const pct = expiryPercent(vault);
  const remaining = blocksRemaining(vault);

  const barColor =
    pct >= 90
      ? "bg-red-500"
      : pct >= 60
      ? "bg-yellow-500"
      : "bg-green-500";

  return (
    <main className="min-h-screen p-6 max-w-4xl mx-auto">
      {/* Header */}
      <div className="mb-8 border-b border-neutral-700 pb-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold text-orange-400 tracking-wider">
              ☠ DEAD PERSON VAULT
            </h1>
            <p className="text-neutral-400 text-sm mt-1">
              On-chain Bitcoin inheritance — powered by OP_NET
            </p>
          </div>
          <div className="text-right text-xs text-neutral-500">
            <div>Block #{vault.currentBlock.toString()}</div>
            <div className="mt-1 text-neutral-600">~3s per tick (demo)</div>
          </div>
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
                value={shortAddr(vault.owner)}
                mono
              />
              <Row
                label="Heir"
                value={shortAddr(vault.heir)}
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
                <button
                  onClick={handleDeposit}
                  className="w-full bg-orange-500 hover:bg-orange-400 text-black font-bold py-2 px-4 rounded text-sm transition-colors"
                >
                  DEPOSIT &amp; ACTIVATE VAULT
                </button>
              </div>
            )}

            {/* Heartbeat */}
            {vault.isActive && !vault.isClaimed && !expired && (
              <button
                onClick={handleHeartbeat}
                className="w-full bg-green-700 hover:bg-green-600 text-white font-bold py-2 px-4 rounded text-sm transition-colors"
              >
                ♥ SEND HEARTBEAT
              </button>
            )}

            {/* Claim */}
            {vault.isActive && expired && !vault.isClaimed && (
              <button
                onClick={handleClaim}
                className="w-full bg-red-700 hover:bg-red-600 text-white font-bold py-2 px-4 rounded text-sm transition-colors animate-pulse"
              >
                ⚠ HEIR: CLAIM VAULT
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
