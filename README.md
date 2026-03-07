# Legacy Vault

Bitcoin inheritance on-chain — powered by [OP_NET](https://opnet.org).

**Live app:** https://legacy-vault-opnet.vercel.app/

---

## What it does

Legacy Vault lets you lock BTC on Bitcoin with a countdown timer and designate an heir. As long as you're alive, you can cancel the vault and reclaim your BTC at any time. If you go silent for the set number of blocks, the vault expires and your heir can claim the funds — along with an optional time capsule message you left for them.

## How it works

1. **Owner deposits BTC** — sets an heir address, a block timer, and an optional message
2. **Owner stays alive** — can cancel the vault to reclaim BTC at any time
3. **Timer runs out** — if the owner goes silent, the vault expires after the set number of Bitcoin blocks
4. **Heir claims** — the heir connects their wallet, the app auto-detects their role, and they claim the BTC + message

## Tech stack

- **Smart contract:** AssemblyScript → WASM, deployed on OP_NET (Bitcoin L1)
- **Frontend:** Next.js + Tailwind CSS, deployed on Vercel
- **Wallet:** OPWallet (MLDSA post-quantum signatures)
- **Network:** OP_NET Testnet

## Contract

- **Address:** `opt1sqrx6feek2ky0pu44l7anzym26d7lj6jas59eyv89`
- **Methods:** `deposit`, `depositWithMessage`, `heartbeat`, `withdraw`, `claim`, `getInfo`

## Development

```bash
npm install
npm run dev
```

Deploy to Vercel:

```bash
npx vercel --prod
```

## Block reference

| Period | Blocks |
|--------|--------|
| 1 day  | 144    |
| 30 days | 4,320 |
| 1 year | 52,560 |
