import { Blockchain } from "@btc-vision/btc-runtime/runtime";
import { revertOnError } from "@btc-vision/btc-runtime/runtime/abort/abort";
import { DeadPersonVault } from "./contracts/DeadPersonVault";

// Register the contract. The runtime calls this factory lazily on first execution.
// ONLY CHANGE THE CLASS NAME — do not add custom logic here.
Blockchain.contract = (): DeadPersonVault => new DeadPersonVault();

// Re-export the WASM entry points (execute, onDeploy) required by the OP_NET runtime.
export * from "@btc-vision/btc-runtime/runtime/exports";

// Required abort handler — maps AssemblyScript traps to OP_NET reverts.
export function abort(
  message: string,
  fileName: string,
  line: u32,
  column: u32,
): void {
  revertOnError(message, fileName, line, column);
}
