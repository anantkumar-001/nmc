import {
  Connection,
  PublicKey,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import type { ParsedTransactionWithMeta } from "@solana/web3.js";
import { ESCROW_WALLET } from "../config/env.js";

const RPC_URL = process.env.SOLANA_RPC_URL ?? "https://api.devnet.solana.com";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Balance arrays follow [static keys…, loaded writable…, loaded readonly…] for v0 txs. */
function accountKeysForBalanceLookup(tx: ParsedTransactionWithMeta): PublicKey[] {
  const meta = tx.meta;
  const staticKeys = tx.transaction.message.accountKeys.map((a) => a.pubkey);
  const preLen = meta?.preBalances?.length ?? staticKeys.length;
  if (staticKeys.length === preLen) return staticKeys;
  const loaded = meta?.loadedAddresses;
  if (
    loaded &&
    staticKeys.length < preLen &&
    (loaded.writable.length > 0 || loaded.readonly.length > 0)
  ) {
    return [...staticKeys, ...loaded.writable, ...loaded.readonly];
  }
  return staticKeys;
}

export interface VerificationResult {
  success: boolean;
  error?: string;
  sender?: string;
  receiver?: string;
  amountSol?: number;
}

export async function verifyTransaction(
  txHash: string,
  expectedSender: string,
  expectedAmountSol: number
): Promise<VerificationResult> {
  if (!ESCROW_WALLET) {
    return { success: false, error: "ESCROW_WALLET not configured" };
  }

  const connection = new Connection(RPC_URL, "confirmed");

  try {
    // Retry: RPC indexing lag + flaky public RPCs often throw "Internal error" on getParsedTransaction
    let tx: ParsedTransactionWithMeta | null = null;
    for (let attempt = 1; attempt <= 5; attempt++) {
      try {
        tx = await connection.getParsedTransaction(txHash, {
          maxSupportedTransactionVersion: 0,
          commitment: "confirmed",
        });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error(
          `verifyTransaction: getParsedTransaction failed (attempt ${attempt}/5):`,
          msg
        );
        tx = null;
      }
      if (tx) break;
      if (attempt < 5) {
        console.log(
          `verifyTransaction: attempt ${attempt}/5 — missing tx or RPC error, retrying in 3s…`
        );
        await sleep(3000);
      }
    }

    if (!tx) {
      return {
        success: false,
        error:
          "Could not load the transaction from Solana RPC after retries. Try again in a moment, or set SOLANA_RPC_URL to a reliable endpoint (e.g. Helius devnet).",
      };
    }

    if (tx.meta?.err) {
      return { success: false, error: "Transaction failed on-chain" };
    }

    // Find SOL transfer from sender to escrow (full key order must match preBalances indices)
    const accountKeys = accountKeysForBalanceLookup(tx);
    const preBalances = tx.meta?.preBalances ?? [];
    const postBalances = tx.meta?.postBalances ?? [];
    if (
      preBalances.length > 0 &&
      accountKeys.length !== preBalances.length
    ) {
      return {
        success: false,
        error:
          "Could not verify transaction: account keys do not match balance metadata.",
      };
    }

    const senderIndex = accountKeys.findIndex(
      (k) => k.toBase58() === expectedSender
    );
    const escrowIndex = accountKeys.findIndex(
      (k) => k.toBase58() === ESCROW_WALLET
    );

    if (senderIndex < 0) {
      return { success: false, error: "Sender not in transaction" };
    }
    if (escrowIndex < 0) {
      return { success: false, error: "Escrow wallet not in transaction" };
    }

    // Parse balance changes from pre/post
    const lamportsReceived =
      (postBalances[escrowIndex] ?? 0) - (preBalances[escrowIndex] ?? 0);
    const lamportsSent =
      (preBalances[senderIndex] ?? 0) - (postBalances[senderIndex] ?? 0);

    const amountSol = lamportsReceived / LAMPORTS_PER_SOL;

    // Verify sender sent SOL to escrow
    if (lamportsReceived <= 0 || lamportsSent <= 0) {
      return {
        success: false,
        error: "No SOL transfer from sender to escrow found",
      };
    }

    if (Math.abs(amountSol - expectedAmountSol) > 0.0001) {
      return {
        success: false,
        error: `Amount mismatch: expected ${expectedAmountSol} SOL, got ${amountSol}`,
      };
    }

    return {
      success: true,
      sender: expectedSender,
      receiver: ESCROW_WALLET,
      amountSol,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Verification failed";
    return { success: false, error: msg };
  }
}
