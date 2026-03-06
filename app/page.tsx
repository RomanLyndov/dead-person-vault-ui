"use client";

import { useState, useEffect, useCallback } from "react";
import {
  VaultState,
  VaultEvent,
  formatBTC,
  blocksRemaining,
  isExpired,
  expiryPercent,
  shortAddr,
} from "../lib/vault";
import {
  VAULT_CONTRACT_ADDRESS,
  connectOpNetWallet,
  getConnectedAccounts,
  getWalletBalance,
  isOpNetWalletInstalled,
  fetchUTXOs,
  fetchFeeRate,
  encodeDeposit,
  encodeDepositWithMessage,
  encodeClaim,
  encodeWithdraw,
  sendVaultInteraction,
  fetchVaultInfo,
  getMyAddressHex,
} from "../lib/opnetWallet";

const DEMO_HEIR = "0000000000000000000000000000000000000000000000000000000000000000";

function emptyVault(): VaultState {
  return {
    isActive: false,
    isClaimed: false,
    owner: "",
    heir: DEMO_HEIR,
    balance: 0n,
    lastHeartbeat: 0n,
    timerDuration: 5n,
    currentBlock: 840000n,
    message: undefined,
  };
}

type Role = "owner" | "heir" | "observer" | "unknown";

export default function Home() {
  const [vault, setVault] = useState<VaultState>(emptyVault());
  const [events, setEvents] = useState<VaultEvent[]>([]);
  const [depositAmount, setDepositAmount] = useState("0.01");
  const [timerBlocks, setTimerBlocks] = useState("5");
  const [heirAddress, setHeirAddress] = useState(DEMO_HEIR);
  const [capsuleMessage, setCapsuleMessage] = useState("");

  const [walletAddress, setWalletAddress] = useState<string | null>(null);
  const [walletBalance, setWalletBalance] = useState<number | null>(null);
  const [myHex, setMyHex] = useState<string | null>(null);
  const [role, setRole] = useState<Role>("unknown");
  const [isConnecting, setIsConnecting] = useState(false);
  const [isSyncing, setIsSyncing] = useState(false);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [walletError, setWalletError] = useState<string | null>(null);
  const [txPending, setTxPending] = useState(false);
  const [txMessage, setTxMessage] = useState<{ type: "ok" | "err" | "info"; text: string } | null>(null);

  const isSimulation = !VAULT_CONTRACT_ADDRESS;

  // Simulated block ticker
  useEffect(() => {
    const interval = setInterval(() => {
      setVault((v) => ({ ...v, currentBlock: v.currentBlock + 1n }));
    }, 3000);
    return () => clearInterval(interval);
  }, []);

  const addEvent = useCallback((type: VaultEvent["type"], message: string, block: bigint) => {
    setEvents((prev) => [{ type, message, block, timestamp: new Date() }, ...prev.slice(0, 19)]);
  }, []);

  function showTx(type: "ok" | "err" | "info", text: string) {
    setTxMessage({ type, text });
    setTimeout(() => setTxMessage(null), 7000);
  }

  // Determine user role from on-chain data
  function determineRole(ownerHex: string, beneficiaryHex: string, hex: string | null): Role {
    if (!hex) return "observer";
    if (hex === ownerHex) return "owner";
    if (hex === beneficiaryHex) return "heir";
    return "observer";
  }

  // Fetch on-chain vault state and update UI
  async function syncFromChain(hex: string | null) {
    setIsSyncing(true);
    setSyncError(null);
    try {
      const info = await fetchVaultInfo();
      if (!info) {
        setSyncError("Could not read vault state. The RPC call may have failed — check console.");
        return;
      }
      if (!info.initialized) {
        setSyncError("Vault is not initialized on-chain.");
        setVault((v) => ({ ...v, isActive: false, isClaimed: false }));
        setRole("unknown");
        return;
      }
      setVault((v) => ({
        ...v,
        isActive: !info.claimed,
        isClaimed: info.claimed,
        owner: info.ownerHex,
        heir: info.beneficiaryHex,
        balance: info.amount,
        lastHeartbeat: info.lastSeen,
        timerDuration: info.timeout,
        message: info.message || undefined,
      }));
      const r = determineRole(info.ownerHex, info.beneficiaryHex, hex);
      setRole(r);
      setSyncError(null);
    } catch (e) {
      setSyncError("Sync failed: " + (e instanceof Error ? e.message : String(e)));
    } finally {
      setIsSyncing(false);
    }
  }

  async function handleConnect() {
    setWalletError(null);
    setIsConnecting(true);
    try {
      const accounts = await connectOpNetWallet();
      if (accounts.length === 0) throw new Error("No accounts returned");
      setWalletAddress(accounts[0]!);
      getWalletBalance().then((b) => setWalletBalance(b.total)).catch(() => {});
      const hex = await getMyAddressHex();
      setMyHex(hex);
      // Auto-sync after connecting
      await syncFromChain(hex);
    } catch (e) {
      setWalletError(e instanceof Error ? e.message : "Connection failed");
    } finally {
      setIsConnecting(false);
    }
  }

  // On load, check if already connected
  useEffect(() => {
    getConnectedAccounts().then(async (accounts) => {
      if (accounts.length > 0) {
        setWalletAddress(accounts[0]!);
        getWalletBalance().then((b) => setWalletBalance(b.total)).catch(() => {});
        const hex = await getMyAddressHex();
        setMyHex(hex);
        await syncFromChain(hex);
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function ensureConnected(): Promise<string | null> {
    if (walletAddress) return walletAddress;
    await handleConnect();
    return walletAddress;
  }

  async function handleUseMyWallet() {
    if (!isOpNetWalletInstalled()) { showTx("err", "OPWallet not connected"); return; }
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const pubkeyHex: string = await (window as any).opnet.getPublicKey();
      const bytes = new Uint8Array(pubkeyHex.match(/.{2}/g)!.map((b: string) => parseInt(b, 16)));
      const hashBuf = await crypto.subtle.digest("SHA-256", bytes);
      const hex = Array.from(new Uint8Array(hashBuf)).map((b) => b.toString(16).padStart(2, "0")).join("");
      setHeirAddress(hex);
      showTx("ok", "Filled heir address from your wallet public key");
    } catch (e) {
      showTx("err", "Could not derive address: " + (e instanceof Error ? e.message : String(e)));
    }
  }

  async function handleDeposit() {
    const satoshis = BigInt(Math.round(parseFloat(depositAmount) * 1e8));
    if (satoshis <= 0n) return;
    const duration = BigInt(parseInt(timerBlocks));
    const msg = capsuleMessage.trim();
    if (isSimulation) {
      setVault((v) => ({ ...v, isActive: true, balance: v.balance + satoshis, lastHeartbeat: v.currentBlock, timerDuration: duration, message: msg || undefined }));
      addEvent("Deposit", `[SIM] Deposited ${formatBTC(satoshis)}, timer: ${timerBlocks} blocks`, vault.currentBlock);
      setRole("owner");
      return;
    }
    const addr = await ensureConnected();
    if (!addr) return;
    setTxPending(true);
    showTx("info", "Building transaction...");
    try {
      const calldataPromise = msg
        ? encodeDepositWithMessage(heirAddress, duration, satoshis, msg)
        : encodeDeposit(heirAddress, duration, satoshis);
      const [utxos, feeRate, calldata] = await Promise.all([fetchUTXOs(), fetchFeeRate(), calldataPromise]);
      if (utxos.length === 0) throw new Error("No UTXOs available. Fund your wallet first.");
      showTx("info", "Check OPWallet to sign...");
      const result = await sendVaultInteraction(calldata, utxos, feeRate, addr!);
      if (result.success) {
        showTx("ok", "Vault activated! TX: " + (result.txId?.slice(0, 16) ?? "") + "...");
        setVault((v) => ({ ...v, isActive: true, balance: v.balance + satoshis, lastHeartbeat: v.currentBlock, timerDuration: duration, message: msg || undefined }));
        setRole("owner");
        addEvent("Deposit", `Deposited ${formatBTC(satoshis)}, timer: ${timerBlocks} blocks`, vault.currentBlock);
      } else {
        showTx("err", result.error ?? "Transaction failed");
        addEvent("Error", result.error ?? "Deposit failed", vault.currentBlock);
      }
    } catch (e) {
      const m = e instanceof Error ? e.message : "Unknown error";
      showTx("err", m);
      addEvent("Error", m, vault.currentBlock);
    } finally { setTxPending(false); }
  }

  async function handleWithdraw() {
    if (!vault.isActive || vault.isClaimed) return;
    if (isSimulation) {
      setVault((v) => ({ ...v, isActive: false, balance: 0n, message: undefined }));
      addEvent("Withdrawn", `[SIM] Owner cancelled vault`, vault.currentBlock);
      setRole("unknown");
      return;
    }
    const addr = await ensureConnected();
    if (!addr) return;
    setTxPending(true);
    showTx("info", "Building withdraw transaction...");
    try {
      const [utxos, feeRate, calldata] = await Promise.all([fetchUTXOs(), fetchFeeRate(), encodeWithdraw()]);
      showTx("info", "Check OPWallet to sign...");
      const result = await sendVaultInteraction(calldata, utxos, feeRate, addr!);
      if (result.success) {
        showTx("ok", "Vault cancelled! TX: " + (result.txId?.slice(0, 16) ?? "") + "...");
        setVault((v) => ({ ...v, isActive: false, balance: 0n, message: undefined }));
        setRole("unknown");
        addEvent("Withdrawn", "Vault cancelled on-chain", vault.currentBlock);
      } else {
        showTx("err", result.error ?? "Transaction failed");
        addEvent("Error", result.error ?? "Withdraw failed", vault.currentBlock);
      }
    } catch (e) {
      const m = e instanceof Error ? e.message : "Unknown error";
      showTx("err", m);
      addEvent("Error", m, vault.currentBlock);
    } finally { setTxPending(false); }
  }

  async function handleClaim() {
    if (!vault.isActive || vault.isClaimed) return;
    if (isSimulation) {
      setVault((v) => ({ ...v, isClaimed: true, isActive: false, balance: 0n }));
      addEvent("Claimed", `[SIM] Heir claimed ${formatBTC(vault.balance)}`, vault.currentBlock);
      return;
    }
    const addr = await ensureConnected();
    if (!addr) return;
    setTxPending(true);
    showTx("info", "Building claim transaction...");
    try {
      const [utxos, feeRate, calldata] = await Promise.all([fetchUTXOs(), fetchFeeRate(), encodeClaim()]);
      showTx("info", "Check OPWallet to sign...");
      const result = await sendVaultInteraction(calldata, utxos, feeRate, addr!);
      if (result.success) {
        showTx("ok", "Claimed! TX: " + (result.txId?.slice(0, 16) ?? "") + "...");
        setVault((v) => ({ ...v, isClaimed: true, isActive: false, balance: 0n }));
        addEvent("Claimed", "Vault claimed on-chain", vault.currentBlock);
      } else {
        showTx("err", result.error ?? "Transaction failed");
        addEvent("Error", result.error ?? "Claim failed", vault.currentBlock);
      }
    } catch (e) {
      const m = e instanceof Error ? e.message : "Unknown error";
      showTx("err", m);
      addEvent("Error", m, vault.currentBlock);
    } finally { setTxPending(false); }
  }

  function handleReset() {
    setVault(emptyVault());
    setEvents([]);
    setTxMessage(null);
    setCapsuleMessage("");
    setRole("unknown");
    setSyncError(null);
  }

  const expired = isExpired(vault);
  const pct = expiryPercent(vault);
  const remaining = blocksRemaining(vault);
  const barColor = pct >= 90 ? "bg-red-500" : pct >= 60 ? "bg-amber-400" : "bg-emerald-400";

  const roleLabel: Record<Role, string> = {
    owner: "You are the OWNER",
    heir: "You are the HEIR",
    observer: "Observer",
    unknown: "",
  };
  const roleColor: Record<Role, string> = {
    owner: "text-amber-400 border-amber-700 bg-amber-950/40",
    heir: "text-violet-400 border-violet-700 bg-violet-950/40",
    observer: "text-zinc-400 border-zinc-700 bg-zinc-900/40",
    unknown: "",
  };

  return (
    <main className="min-h-screen p-6 max-w-4xl mx-auto">
      {/* Toast */}
      {txMessage && (
        <div className={`fixed top-4 right-4 z-50 px-4 py-3 rounded-lg text-sm font-mono max-w-sm shadow-xl border ${
          txMessage.type === "ok" ? "bg-emerald-950 border-emerald-500 text-emerald-300"
          : txMessage.type === "err" ? "bg-red-950 border-red-500 text-red-300"
          : "bg-zinc-900 border-zinc-600 text-zinc-200"
        }`}>
          {txMessage.text}
        </div>
      )}

      {/* Header */}
      <div className="mb-8 pb-6 border-b border-zinc-800">
        <div className="flex items-start justify-between flex-wrap gap-4">
          <div>
            <h1 className="text-3xl font-black tracking-tight">
              <span className="text-amber-400">☠</span>{" "}
              <span className="bg-gradient-to-r from-amber-400 to-orange-500 bg-clip-text text-transparent">
                DEAD PERSON VAULT
              </span>
            </h1>
            <p className="text-zinc-500 text-sm mt-1">Bitcoin inheritance on-chain — powered by OP_NET</p>
          </div>
          <div className="flex flex-col items-end gap-2">
            {walletAddress ? (
              <div className="flex flex-col items-end gap-1">
                <div className="flex items-center gap-2">
                  <div className="w-2 h-2 rounded-full bg-emerald-400 shadow-[0_0_6px_#34d399]" />
                  <span className="text-emerald-400 text-xs font-mono">{shortAddr(walletAddress)}</span>
                </div>
                {walletBalance !== null && (
                  <span className="text-zinc-500 text-xs">{(walletBalance / 1e8).toFixed(8)} BTC</span>
                )}
                {role !== "unknown" && (
                  <span className={`text-xs px-2 py-0.5 rounded-full border font-bold ${roleColor[role]}`}>
                    {roleLabel[role]}
                  </span>
                )}
              </div>
            ) : (
              <button onClick={handleConnect} disabled={isConnecting}
                className="bg-amber-500 hover:bg-amber-400 disabled:opacity-50 text-black font-bold py-1.5 px-4 rounded-lg text-sm transition-colors shadow-[0_0_12px_rgba(245,158,11,0.3)]">
                {isConnecting ? "Connecting..." : "Connect OPWallet"}
              </button>
            )}
            {walletError && <span className="text-red-400 text-xs max-w-xs text-right">{walletError}</span>}
          </div>
        </div>
        <div className="flex items-center justify-between mt-3 flex-wrap gap-2">
          <div className="text-xs text-zinc-600 font-mono">Block #{vault.currentBlock.toString()}</div>
          <div className="flex items-center gap-2">
            {walletAddress && (
              <button onClick={() => syncFromChain(myHex)} disabled={isSyncing}
                className="text-xs text-zinc-500 hover:text-zinc-300 border border-zinc-800 hover:border-zinc-600 px-2 py-0.5 rounded transition-colors disabled:opacity-50">
                {isSyncing ? "Syncing..." : "⟳ Sync from chain"}
              </button>
            )}
            {isSimulation ? (
              <span className="text-xs bg-amber-950 text-amber-400 border border-amber-800 px-2 py-0.5 rounded-full">SIMULATION MODE</span>
            ) : (
              <span className="text-xs bg-emerald-950 text-emerald-400 border border-emerald-800 px-2 py-0.5 rounded-full shadow-[0_0_8px_rgba(52,211,153,0.2)]">LIVE — OP_NET Testnet</span>
            )}
          </div>
        </div>
        {syncError && (
          <div className="mt-2 text-xs text-red-400 bg-red-950/40 border border-red-800 rounded px-3 py-2">{syncError}</div>
        )}
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {/* Left column */}
        <div className="space-y-4">

          {/* Vault status */}
          <div className={`rounded-xl p-4 border ${
            vault.isClaimed ? "border-violet-700 bg-violet-950/30"
            : vault.isActive && expired ? "border-red-600 bg-red-950/30 shadow-[0_0_20px_rgba(239,68,68,0.15)]"
            : vault.isActive ? "border-emerald-700 bg-emerald-950/20 shadow-[0_0_20px_rgba(52,211,153,0.1)]"
            : "border-zinc-800 bg-zinc-900/40"
          }`}>
            <div className="flex items-center gap-3 mb-4">
              <div className={`w-3 h-3 rounded-full flex-shrink-0 ${
                vault.isClaimed ? "bg-violet-400 shadow-[0_0_8px_#a78bfa]"
                : vault.isActive && expired ? "bg-red-500 animate-pulse shadow-[0_0_8px_#ef4444]"
                : vault.isActive ? "bg-emerald-400 animate-pulse shadow-[0_0_8px_#34d399]"
                : "bg-zinc-600"
              }`} />
              <span className={`text-lg font-black tracking-wide ${
                vault.isClaimed ? "text-violet-400"
                : vault.isActive && expired ? "text-red-400"
                : vault.isActive ? "text-emerald-400"
                : "text-zinc-500"
              }`}>
                {vault.isClaimed ? "CLAIMED"
                  : vault.isActive && expired ? "EXPIRED — CLAIMABLE"
                  : vault.isActive ? "ACTIVE"
                  : "INACTIVE"}
              </span>
            </div>

            {vault.isActive || vault.isClaimed ? (
              <div className="space-y-2 text-sm">
                <Row label="Balance" value={formatBTC(vault.balance)} accent />
                <Row label="Owner" value={shortAddr(vault.owner)} mono />
                <Row label="Heir" value={shortAddr(vault.heir)} mono />
                <Row label="Timer" value={`${vault.timerDuration} blocks`} />
                {vault.isActive && <Row label="Last activity" value={`Block #${vault.lastHeartbeat}`} />}
              </div>
            ) : (
              <p className="text-zinc-600 text-sm">
                {walletAddress
                  ? 'No active vault found. Create one below, or click "Sync from chain" if you expect one to exist.'
                  : "Connect your wallet to see vault state."}
              </p>
            )}

            {/* Time capsule message */}
            {vault.message && (
              <div className="mt-4 p-3 rounded-lg border border-amber-700/50 bg-amber-950/30">
                <div className="text-xs text-amber-500 font-bold mb-1">✉ TIME CAPSULE MESSAGE</div>
                <p className="text-amber-200 text-sm italic leading-relaxed">"{vault.message}"</p>
              </div>
            )}
          </div>

          {/* Timer bar */}
          {vault.isActive && !vault.isClaimed && (
            <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-4">
              <div className="text-xs text-zinc-500 uppercase tracking-widest mb-3">Expiry Timer</div>
              <div className="w-full bg-zinc-800 rounded-full h-2.5 mb-2">
                <div className={`h-2.5 rounded-full transition-all duration-500 ${barColor}`}
                  style={{ width: `${Math.min(100, pct)}%` }} />
              </div>
              <div className="flex justify-between text-xs text-zinc-500">
                <span>{pct.toFixed(1)}% elapsed</span>
                {expired
                  ? <span className="text-red-400 font-bold animate-pulse">TIMER EXPIRED</span>
                  : <span className="text-zinc-400">{remaining.toString()} blocks left</span>}
              </div>
            </div>
          )}

          {/* Actions */}
          <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-4 space-y-3">
            <div className="text-xs text-zinc-500 uppercase tracking-widest mb-1">Actions</div>

            {/* Connect prompt */}
            {!walletAddress && !isSimulation && (
              <button onClick={handleConnect} disabled={isConnecting}
                className="w-full bg-amber-500 hover:bg-amber-400 disabled:opacity-50 text-black font-black py-2.5 px-4 rounded-lg text-sm transition-colors">
                {isConnecting ? "Connecting..." : "Connect OPWallet"}
              </button>
            )}

            {/* Deposit form — show when no active vault or simulation */}
            {(!vault.isActive && !vault.isClaimed && (role === "owner" || role === "unknown" || isSimulation)) && (
              <div className="space-y-3">
                <div className="flex gap-2">
                  <div className="flex-1">
                    <label className="text-xs text-zinc-500 block mb-1">Amount (BTC)</label>
                    <input type="number" step="0.001" min="0.001" value={depositAmount}
                      onChange={(e) => setDepositAmount(e.target.value)}
                      className="w-full bg-zinc-950 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-amber-500 transition-colors" />
                  </div>
                  <div className="flex-1">
                    <label className="text-xs text-zinc-500 block mb-1">Timer (blocks)</label>
                    <input type="number" min="1" value={timerBlocks}
                      onChange={(e) => setTimerBlocks(e.target.value)}
                      className="w-full bg-zinc-950 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-amber-500 transition-colors" />
                  </div>
                </div>
                <div>
                  <div className="flex items-center justify-between mb-1">
                    <label className="text-xs text-zinc-500">Heir address (64-char hex)</label>
                    <button type="button" onClick={handleUseMyWallet}
                      className="text-xs text-amber-400 hover:text-amber-300 underline transition-colors">
                      Use my wallet
                    </button>
                  </div>
                  <input type="text" value={heirAddress} onChange={(e) => setHeirAddress(e.target.value)}
                    placeholder="64-char hex pubkey hash"
                    className="w-full bg-zinc-950 border border-zinc-700 rounded-lg px-3 py-2 text-xs font-mono text-white focus:outline-none focus:border-amber-500 transition-colors" />
                </div>
                <div>
                  <label className="text-xs text-zinc-500 block mb-1">
                    ✉ Time capsule message{" "}
                    <span className="text-zinc-600">(optional)</span>
                  </label>
                  <textarea rows={3} value={capsuleMessage} onChange={(e) => setCapsuleMessage(e.target.value)}
                    placeholder="Dear heir, if you're reading this..."
                    className="w-full bg-zinc-950 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-amber-500 transition-colors resize-none" />
                </div>
                <button onClick={handleDeposit} disabled={txPending}
                  className="w-full bg-amber-500 hover:bg-amber-400 disabled:opacity-50 text-black font-black py-2.5 px-4 rounded-lg text-sm transition-colors shadow-[0_0_16px_rgba(245,158,11,0.25)]">
                  {txPending ? "SIGNING..." : isSimulation ? "ACTIVATE VAULT (SIMULATION)" : "ACTIVATE VAULT"}
                </button>
              </div>
            )}

            {/* Heir — claim */}
            {vault.isActive && !vault.isClaimed && (role === "heir" || isSimulation) && (
              <button onClick={handleClaim} disabled={txPending || !expired}
                className={`w-full font-black py-2.5 px-4 rounded-lg text-sm transition-colors ${
                  expired
                    ? "bg-violet-600 hover:bg-violet-500 text-white animate-pulse shadow-[0_0_20px_rgba(167,139,250,0.4)]"
                    : "border border-zinc-700 text-zinc-600 cursor-not-allowed"
                } disabled:opacity-50`}>
                {txPending ? "SIGNING..."
                  : expired
                    ? (isSimulation ? "⚡ CLAIM VAULT (SIMULATION)" : "⚡ CLAIM VAULT")
                    : `⚡ CLAIM (${remaining.toString()} blocks remaining)`}
              </button>
            )}

            {/* Owner — cancel */}
            {vault.isActive && !vault.isClaimed && (role === "owner" || isSimulation) && (
              <button onClick={handleWithdraw} disabled={txPending}
                className="w-full border border-zinc-700 hover:border-zinc-500 text-zinc-400 hover:text-white disabled:opacity-50 font-bold py-2 px-4 rounded-lg text-sm transition-colors">
                {txPending ? "SIGNING..." : isSimulation ? "↩ CANCEL VAULT (SIMULATION)" : "↩ CANCEL VAULT"}
              </button>
            )}

            {/* Observer with active vault */}
            {vault.isActive && !vault.isClaimed && role === "observer" && (
              <div className="text-xs text-zinc-600 text-center py-2">
                Connected wallet is neither owner nor heir of this vault.
              </div>
            )}

            {/* Claimed state */}
            {vault.isClaimed && (
              <div className="space-y-3">
                <div className="p-4 rounded-xl border border-violet-700 bg-violet-950/40 text-center">
                  <div className="text-violet-400 font-black text-lg mb-1">VAULT CLAIMED</div>
                  <div className="text-zinc-400 text-xs">The inheritance has been transferred.</div>
                </div>
                {vault.message && (
                  <div className="p-4 rounded-xl border border-amber-700/60 bg-amber-950/30">
                    <div className="text-amber-500 text-xs font-bold mb-2">✉ MESSAGE FROM THE OWNER</div>
                    <p className="text-amber-200 text-sm italic leading-relaxed">"{vault.message}"</p>
                  </div>
                )}
                <button onClick={handleReset}
                  className="w-full border border-zinc-700 hover:border-zinc-500 text-zinc-400 hover:text-white py-2 px-4 rounded-lg text-sm transition-colors">
                  RESET
                </button>
              </div>
            )}

            {(vault.isActive || vault.isClaimed) && !vault.isClaimed && (
              <button onClick={handleReset}
                className="w-full border border-zinc-800 hover:border-zinc-700 text-zinc-600 hover:text-zinc-400 py-1.5 px-4 rounded-lg text-xs transition-colors">
                Reset demo
              </button>
            )}
          </div>
        </div>

        {/* Right column */}
        <div className="space-y-4">
          {/* How it works */}
          <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-4">
            <div className="text-xs text-zinc-500 uppercase tracking-widest mb-4">How It Works</div>
            <div className="space-y-4">
              <Step n="1" color="text-amber-400" title="Owner deposits BTC">
                Lock BTC on-chain with a block countdown and choose an heir.
                Optionally write a time capsule message — stored permanently on Bitcoin.
              </Step>
              <Step n="2" color="text-emerald-400" title="Owner stays alive">
                As long as you&apos;re alive, you can{" "}
                <code className="text-zinc-300 bg-zinc-800 px-1 rounded">Cancel Vault</code>{" "}
                to reclaim your BTC at any time.
              </Step>
              <Step n="3" color="text-red-400" title="Timer runs out">
                If the owner goes silent for the set number of blocks, the vault expires
                and becomes claimable by the heir.
              </Step>
              <Step n="4" color="text-violet-400" title="Heir claims">
                The heir connects their wallet — the site auto-detects their role.
                They click{" "}
                <code className="text-zinc-300 bg-zinc-800 px-1 rounded">Claim Vault</code>{" "}
                and receive the BTC + the message.
              </Step>
            </div>
          </div>

          {/* Contract methods */}
          <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-4">
            <div className="text-xs text-zinc-500 uppercase tracking-widest mb-3">Contract</div>
            <div className="space-y-1 text-xs font-mono">
              <Method name="deposit(address,u64,u256)" color="text-amber-400" />
              <Method name="depositWithMessage(address,u64,u256,string)" color="text-amber-300" />
              <Method name="withdraw()" color="text-emerald-400" />
              <Method name="claim()" color="text-violet-400" />
              <Method name="getInfo()" color="text-zinc-500" />
            </div>
            {VAULT_CONTRACT_ADDRESS && (
              <div className="mt-3 text-xs text-zinc-600 font-mono break-all">{VAULT_CONTRACT_ADDRESS}</div>
            )}
          </div>

          {/* Event log */}
          <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-4">
            <div className="text-xs text-zinc-500 uppercase tracking-widest mb-3">Event Log</div>
            {events.length === 0 ? (
              <div className="text-zinc-700 text-sm italic">No events yet.</div>
            ) : (
              <div className="space-y-2 max-h-64 overflow-y-auto">
                {events.map((ev, i) => (
                  <div key={i} className="text-xs border-l-2 pl-2 py-0.5" style={{
                    borderColor:
                      ev.type === "Deposit" ? "#f59e0b"
                      : ev.type === "Claimed" ? "#a78bfa"
                      : ev.type === "Withdrawn" ? "#facc15"
                      : ev.type === "Error" ? "#ef4444"
                      : "#6b7280",
                  }}>
                    <div className="flex justify-between gap-2">
                      <span className={
                        ev.type === "Deposit" ? "text-amber-400"
                        : ev.type === "Claimed" ? "text-violet-400"
                        : ev.type === "Withdrawn" ? "text-yellow-400"
                        : ev.type === "Error" ? "text-red-400"
                        : "text-zinc-500"
                      }>[{ev.type}]</span>
                      <span className="text-zinc-600">#{ev.block.toString()}</span>
                    </div>
                    <div className="text-zinc-300">{ev.message}</div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Block reference */}
          <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-4">
            <div className="text-xs text-zinc-500 uppercase tracking-widest mb-2">Block Reference</div>
            <div className="text-xs text-zinc-500 space-y-1 font-mono">
              <div>1 day ≈ <span className="text-zinc-300">144 blocks</span></div>
              <div>30 days = <span className="text-zinc-300">4,320 blocks</span></div>
              <div>1 year = <span className="text-zinc-300">52,560 blocks</span></div>
              <div className="pt-1 text-zinc-700">UI demo: 1 block / 3 sec</div>
            </div>
          </div>
        </div>
      </div>

      <div className="mt-8 border-t border-zinc-900 pt-4 text-center text-xs text-zinc-800">
        Dead Person Vault — OP_NET Vibecoding — AssemblyScript WASM on Bitcoin
      </div>
    </main>
  );
}

function Row({ label, value, accent, mono }: { label: string; value: string; accent?: boolean; mono?: boolean }) {
  return (
    <div className="flex justify-between items-center">
      <span className="text-zinc-500">{label}</span>
      <span className={`${accent ? "text-amber-400 font-bold" : "text-zinc-200"} ${mono ? "font-mono text-xs" : ""}`}>
        {value}
      </span>
    </div>
  );
}

function Step({ n, color, title, children }: { n: string; color: string; title: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-3">
      <div className={`${color} font-black text-lg leading-none mt-0.5 w-5 flex-shrink-0`}>{n}</div>
      <div>
        <div className={`${color} font-bold text-sm`}>{title}</div>
        <div className="text-zinc-400 text-xs mt-0.5 leading-relaxed">{children}</div>
      </div>
    </div>
  );
}

function Method({ name, color }: { name: string; color: string }) {
  return <div className={`${color} opacity-75 hover:opacity-100 transition-opacity`}>{name}</div>;
}
