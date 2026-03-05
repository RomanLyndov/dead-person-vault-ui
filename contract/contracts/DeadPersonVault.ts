import {
  Address,
  Blockchain,
  BytesWriter,
  Calldata,
  encodeSelector,
  NetEvent,
  OP_NET,
  Revert,
  Selector,
  StoredAddress,
  StoredString,
  StoredU256,
  StoredU64,
} from "@btc-vision/btc-runtime/runtime";
import { u256 } from "@btc-vision/as-bignum/assembly";

// ─── Events ──────────────────────────────────────────────────────────────────

class DepositEvent extends NetEvent {
  constructor(owner: Address, beneficiary: Address, timeout: u64, amount: u256) {
    // 32 (owner) + 32 (beneficiary) + 8 (timeout u64) + 32 (amount u256) = 104 bytes
    const data = new BytesWriter(104);
    data.writeAddress(owner);
    data.writeAddress(beneficiary);
    data.writeU64(timeout);
    data.writeU256(amount);
    super("Deposit", data);
  }
}

class HeartbeatEvent extends NetEvent {
  constructor(owner: Address, blockNumber: u64) {
    // 32 (owner) + 8 (block u64) = 40 bytes
    const data = new BytesWriter(40);
    data.writeAddress(owner);
    data.writeU64(blockNumber);
    super("Heartbeat", data);
  }
}

class ClaimedEvent extends NetEvent {
  constructor(beneficiary: Address, amount: u256) {
    // 32 (beneficiary) + 32 (amount u256) = 64 bytes
    const data = new BytesWriter(64);
    data.writeAddress(beneficiary);
    data.writeU256(amount);
    super("Claimed", data);
  }
}

// ─── Storage layout ──────────────────────────────────────────────────────────
//
//  Slot │  Type          │  Content
//  ─────┼────────────────┼────────────────────────────────────────────────────
//   0   │  StoredAddress │  owner  (who deposited)
//   1   │  StoredAddress │  beneficiary  (heir)
//   2   │  StoredU64     │  [0] lastSeen (block), [1] timeout (blocks)
//   3   │  StoredU256    │  vaultBalance (satoshis, virtual)
//   4   │  StoredU64     │  [0] initialized, [1] claimed  (0/1 flags)
//   5   │  StoredString  │  message (time-capsule, optional)
//
// ─────────────────────────────────────────────────────────────────────────────

// subPointer for StoredU64/StoredU256 must be exactly 30 bytes.
function emptySubPointer(): Uint8Array {
  return new Uint8Array(30);
}

@final
export class DeadPersonVault extends OP_NET {
  private readonly _owner: StoredAddress;
  private readonly _beneficiary: StoredAddress;
  private readonly _timerSlot: StoredU64;    // index 0 = lastSeen, index 1 = timeout
  private readonly _vaultBalance: StoredU256;
  private readonly _flags: StoredU64;        // index 0 = initialized, index 1 = claimed
  private readonly _message: StoredString;

  public constructor() {
    super();

    this._owner        = new StoredAddress(Blockchain.nextPointer);
    this._beneficiary  = new StoredAddress(Blockchain.nextPointer);
    this._timerSlot    = new StoredU64(Blockchain.nextPointer, emptySubPointer());
    this._vaultBalance = new StoredU256(Blockchain.nextPointer, emptySubPointer());
    this._flags        = new StoredU64(Blockchain.nextPointer, emptySubPointer());
    this._message      = new StoredString(Blockchain.nextPointer, 0);
  }

  // ─── Dispatch ─────────────────────────────────────────────────────────────

  public override execute(method: Selector, calldata: Calldata): BytesWriter {
    switch (method) {
      case encodeSelector("deposit(address,u64,u256)"):
        return this._deposit(calldata, false);

      case encodeSelector("depositWithMessage(address,u64,u256,string)"):
        return this._deposit(calldata, true);

      case encodeSelector("heartbeat()"):
        return this._heartbeat();

      case encodeSelector("claim()"):
        return this._claim();

      case encodeSelector("getInfo()"):
        return this._getInfo();

      default:
        return super.execute(method, calldata);
    }
  }

  // ─── deposit(address,u64,u256) — or depositWithMessage(address,u64,u256,string) ──

  private _deposit(calldata: Calldata, withMessage: bool): BytesWriter {
    if (this._flags.get(0) !== 0) throw new Revert("Vault already initialized");

    const beneficiary: Address = calldata.readAddress();
    const timeout: u64         = calldata.readU64();
    const amount: u256         = calldata.readU256();

    if (timeout === 0) throw new Revert("Timeout must be > 0 blocks");
    if (amount.isZero()) throw new Revert("Amount must be > 0");
    if (beneficiary.isZero()) throw new Revert("Invalid beneficiary address");

    const owner: Address = Blockchain.tx.sender;
    if (owner == beneficiary) throw new Revert("Owner and beneficiary must differ");

    const message: string = withMessage ? calldata.readStringWithLength() : "";

    // Persist state
    this._owner.value       = owner;
    this._beneficiary.value = beneficiary;

    this._timerSlot.set(0, Blockchain.block.number); // lastSeen = now
    this._timerSlot.set(1, timeout);
    this._timerSlot.save();

    this._vaultBalance.value = amount;

    this._flags.set(0, 1); // initialized = true
    this._flags.set(1, 0); // claimed     = false
    this._flags.save();

    this._message.value = message;

    this.emitEvent(new DepositEvent(owner, beneficiary, timeout, amount));

    const w = new BytesWriter(1);
    w.writeBoolean(true);
    return w;
  }

  // ─── heartbeat() ──────────────────────────────────────────────────────────
  //
  //  Called by the owner to prove they are alive. Resets the countdown.

  private _heartbeat(): BytesWriter {
    if (this._flags.get(0) === 0) throw new Revert("Vault not initialized");
    if (this._flags.get(1) !== 0) throw new Revert("Vault already claimed");

    if (Blockchain.tx.sender != this._owner.value) {
      throw new Revert("Only the owner can send a heartbeat");
    }

    const now: u64 = Blockchain.block.number;
    this._timerSlot.set(0, now);
    this._timerSlot.save();

    this.emitEvent(new HeartbeatEvent(this._owner.value, now));

    const w = new BytesWriter(8);
    w.writeU64(now);
    return w;
  }

  // ─── claim() ──────────────────────────────────────────────────────────────
  //
  //  Called by the beneficiary after the owner has been silent for `timeout` blocks.

  private _claim(): BytesWriter {
    if (this._flags.get(0) === 0) throw new Revert("Vault not initialized");
    if (this._flags.get(1) !== 0) throw new Revert("Vault already claimed");

    const lastSeen: u64 = this._timerSlot.get(0);
    const timeout: u64  = this._timerSlot.get(1);
    const now: u64      = Blockchain.block.number;

    // Use subtraction to avoid overflow: elapsed = now - lastSeen
    const elapsed: u64 = now > lastSeen ? now - lastSeen : 0;
    if (elapsed < timeout) {
      throw new Revert("Timer has not expired yet");
    }

    if (Blockchain.tx.sender != this._beneficiary.value) {
      throw new Revert("Only the beneficiary can claim");
    }

    const amount: u256 = this._vaultBalance.value;

    // Mark claimed BEFORE any external calls (checks-effects-interactions pattern)
    this._flags.set(1, 1);
    this._flags.save();

    this.emitEvent(new ClaimedEvent(this._beneficiary.value, amount));

    // The OP_NET execution environment routes the vault's UTXOs to the beneficiary
    // once this call succeeds (the contract authorises the transfer by returning success).

    const w = new BytesWriter(1);
    w.writeBoolean(true);
    return w;
  }

  // ─── getInfo() — read-only view ────────────────────────────────────────────

  private _getInfo(): BytesWriter {
    const initialized: bool = this._flags.get(0) !== 0;
    const claimed: bool     = this._flags.get(1) !== 0;
    const lastSeen: u64     = this._timerSlot.get(0);
    const timeout: u64      = this._timerSlot.get(1);
    const amount: u256      = this._vaultBalance.value;
    const message: string   = this._message.value;

    // Encode message to UTF-8 once so we know the byte length for pre-allocation.
    // writeStringWithLength writes: u32 (4 bytes length) + UTF-8 bytes
    const msgBytes = Uint8Array.wrap(String.UTF8.encode(message));

    // owner (32) + beneficiary (32) + lastSeen (8) + timeout (8)
    // + amount (32) + initialized (1) + claimed (1) + msgLen (4) + msgBytes
    const totalSize: i32 = 118 + msgBytes.byteLength;
    const w = new BytesWriter(totalSize);

    w.writeAddress(this._owner.value);
    w.writeAddress(this._beneficiary.value);
    w.writeU64(lastSeen);
    w.writeU64(timeout);
    w.writeU256(amount);
    w.writeBoolean(initialized);
    w.writeBoolean(claimed);
    w.writeU32(u32(msgBytes.byteLength));
    w.writeBytes(msgBytes);

    return w;
  }
}
