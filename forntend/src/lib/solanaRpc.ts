/**
 * Wallet Standard (`StandardWalletAdapter`) calls `getChainForEndpoint(connection.rpcEndpoint)`
 * before send. That helper only maps URLs to devnet when they match `/\bdevnet\b/i` (or
 * testnet/localhost/mainnet-beta). A custom devnet RPC without the substring "devnet" is
 * misclassified as MAINNET, Phantom (on devnet) rejects the chain, and you get
 * `WalletSendTransactionError: Internal error`.
 *
 * @see https://github.com/solana-labs/wallet-standard/blob/master/packages/wallet-standard-util/src/endpoint.ts
 */
export type SolanaNetwork = "devnet" | "mainnet";

export function getConfiguredSolanaNetwork(): SolanaNetwork {
  const v = (import.meta.env.VITE_SOLANA_NETWORK ?? "devnet")
    .toString()
    .trim()
    .toLowerCase();
  return v === "mainnet" ? "mainnet" : "devnet";
}

function withQuery(url: string, fragment: string): string {
  const sep = url.includes("?") ? "&" : "?";
  return `${url}${sep}${fragment}`;
}

/** RPC URL passed to `ConnectionProvider` — safe for Wallet Standard chain detection. */
export function getSolanaConnectionEndpoint(): string {
  const network = getConfiguredSolanaNetwork();
  const fallback =
    network === "mainnet"
      ? "https://api.mainnet-beta.solana.com"
      : "https://api.devnet.solana.com";
  const raw = (import.meta.env.VITE_SOLANA_RPC ?? "").trim() || fallback;

  if (network === "devnet" && !/\bdevnet\b/i.test(raw)) {
    // Don't append "devnet" to local URLs — would match devnet regex before localhost in getChainForEndpoint.
    if (/\blocalhost\b/i.test(raw) || /\b127\.0\.0\.1\b/i.test(raw)) return raw;
    return withQuery(raw, "solana-devnet=1");
  }
  return raw;
}
