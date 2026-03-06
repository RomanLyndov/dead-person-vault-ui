export interface VaultState {
  isActive: boolean;
  isClaimed: boolean;
  owner: string;
  heir: string;
  balance: bigint; // satoshis
  lastHeartbeat: bigint; // block number
  timerDuration: bigint; // blocks
  currentBlock: bigint;
}

export interface VaultEvent {
  type: "Deposit" | "Heartbeat" | "Claimed" | "Withdrawn" | "Error";
  message: string;
  block: bigint;
  timestamp: Date;
}

// 1 BTC = 100_000_000 satoshis
export const BTC_DECIMALS = 100_000_000n;
// 1 day ≈ 144 Bitcoin blocks
export const BLOCKS_PER_DAY = 144n;

export function formatBTC(satoshis: bigint): string {
  const btc = Number(satoshis) / Number(BTC_DECIMALS);
  return btc.toFixed(8) + " BTC";
}

export function formatBlocks(blocks: bigint): string {
  const days = blocks / BLOCKS_PER_DAY;
  const remainingBlocks = blocks % BLOCKS_PER_DAY;
  if (days === 0n) return `${blocks} blocks`;
  return `${days} days (${blocks} blocks)`;
}

export function blocksRemaining(state: VaultState): bigint {
  if (!state.isActive) return 0n;
  const expiry = state.lastHeartbeat + state.timerDuration;
  if (state.currentBlock >= expiry) return 0n;
  return expiry - state.currentBlock;
}

export function isExpired(state: VaultState): boolean {
  if (!state.isActive) return false;
  return state.currentBlock >= state.lastHeartbeat + state.timerDuration;
}

export function expiryPercent(state: VaultState): number {
  if (!state.isActive || state.timerDuration === 0n) return 0;
  const elapsed = state.currentBlock - state.lastHeartbeat;
  const pct = Number(elapsed * 100n) / Number(state.timerDuration);
  return Math.min(100, Math.max(0, pct));
}

export function shortAddr(addr: string): string {
  if (!addr || addr.length < 12) return addr;
  return addr.slice(0, 8) + "…" + addr.slice(-6);
}
