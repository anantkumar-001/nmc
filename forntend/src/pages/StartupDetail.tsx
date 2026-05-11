import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { useWalletModal } from "@solana/wallet-adapter-react-ui";
import { WalletSendTransactionError } from "@solana/wallet-adapter-base";
import {
  PublicKey,
  SendTransactionError,
  SystemProgram,
  LAMPORTS_PER_SOL,
  Transaction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import axios from "axios";
import { startups, invest } from "../lib/api";
import { useAuth } from "../context/AuthContext";

/** Deep log for Wallet Standard / Phantom opaque failures — check browser console. */
function logWalletSendTransactionFailure(
  label: string,
  error: unknown
): void {
  console.group(`[invest] ${label}`);
  console.error("raw:", error);
  if (error instanceof WalletSendTransactionError) {
    console.error("WalletSendTransactionError.message:", error.message);
    console.error("WalletSendTransactionError.name:", error.name);
    console.error("WalletSendTransactionError.error (nested):", error.error);
    const inner = error.error;
    if (inner instanceof SendTransactionError) {
      console.error("SendTransactionError.transactionError:", inner.transactionError);
      console.error("SendTransactionError.logs:", inner.logs);
    }
    if (inner instanceof Error) {
      console.error("inner.stack:", inner.stack);
    }
    if (inner && typeof inner === "object") {
      const o = inner as Record<string, unknown>;
      if ("logs" in o) console.error("inner.logs:", o.logs);
      if ("data" in o) console.error("inner.data:", o.data);
    }
  }
  console.groupEnd();
}

function investErrorMessage(error: unknown): string {
  if (axios.isAxiosError(error)) {
    const data = error.response?.data as
      | { error?: string; details?: string }
      | undefined;
    if (data?.details && typeof data.details === "string") return data.details;
    if (data?.error && typeof data.error === "string") return data.error;
  }
  if (error instanceof WalletSendTransactionError) {
    const inner = error.error;
    if (inner instanceof SendTransactionError) {
      const logs = inner.logs?.length
        ? `\nLogs:\n${inner.logs.slice(-15).join("\n")}`
        : "";
      return `${error.message}: ${inner.message}${logs}`;
    }
    const innerMsg =
      inner instanceof Error
        ? inner.message
        : inner && typeof inner === "object" && "message" in inner
          ? String((inner as { message: unknown }).message)
          : "";
    if (innerMsg && innerMsg !== "Internal error") {
      return `${error.message}${innerMsg ? `: ${innerMsg}` : ""}`;
    }
    return `${error.message}. Open the browser console for the expanded [invest] log. Common causes: Phantom not on Devnet, VITE_SOLANA_NETWORK=devnet + RPC URL must contain "devnet" (or use our auto-hint in solanaRpc.ts), flaky public RPC (use Helius), or VITE_ESCROW_WALLET must be a normal wallet — not the system program (1111…).`;
  }
  if (error instanceof Error) return error.message;
  return "Investment failed";
}

const VALUATION = 20_000;
const ESCROW_WALLET = import.meta.env.VITE_ESCROW_WALLET ?? "";

interface Investment {
  id: string;
  amountSol: number;
  stake: number;
  investor: { name: string; walletAddress: string };
}

interface StartupDetail {
  id: string;
  name: string;
  description: string;
  valuation: number;
  totalRaised: number;
  fundingOpenAt: string;
  founder: { name: string };
  investments: Investment[];
  categories?: string[];
  githubUrl?: string | null;
  linkedinUrl?: string | null;
  xUrl?: string | null;
}

function formatCountdown(dateStr: string) {
  const target = new Date(dateStr).getTime();
  const now = Date.now();
  const diff = target - now;
  if (diff <= 0) return "Funding open";
  const mins = Math.floor(diff / 60_000);
  const secs = Math.floor((diff % 60_000) / 1000);
  return `${mins}m ${secs}s`;
}

export function StartupDetail() {
  const { id } = useParams<{ id: string }>();
  const [startup, setStartup] = useState<StartupDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [investAmount, setInvestAmount] = useState("");
  const [investing, setInvesting] = useState(false);
  const [investError, setInvestError] = useState("");
  const [countdown, setCountdown] = useState("");

  const { publicKey, sendTransaction, signTransaction, wallet } = useWallet();
  const { setVisible: setWalletModalVisible } = useWalletModal();
  const { connection } = useConnection();
  const { user } = useAuth();
  const [pendingInvestAmount, setPendingInvestAmount] = useState<number | null>(
    null
  );

  useEffect(() => {
    if (!id) return;
    startups
      .get(id)
      .then(({ data }) => {
        setStartup(data);
        setCountdown(formatCountdown(data.fundingOpenAt));
      })
      .catch(() => setError("Startup not found"))
      .finally(() => setLoading(false));
  }, [id]);

  useEffect(() => {
    if (!startup) return;
    const isOpen = new Date(startup.fundingOpenAt) <= new Date();
    if (isOpen) {
      setCountdown("Funding open");
      return;
    }
    const t = setInterval(
      () => setCountdown(formatCountdown(startup.fundingOpenAt)),
      1000
    );
    return () => clearInterval(t);
  }, [startup?.fundingOpenAt]);

  const isFundingOpen = startup && new Date(startup.fundingOpenAt) <= new Date();
  const progress = startup
    ? Math.min(100, (startup.totalRaised / VALUATION) * 100)
    : 0;

  // Auto-invest when wallet connects after user clicked Invest
  useEffect(() => {
    if (!publicKey || pendingInvestAmount === null) return;
    const amount = pendingInvestAmount;
    setPendingInvestAmount(null);
    handleInvestWithAmount(amount);
  }, [publicKey, pendingInvestAmount]);

  async function handleInvestWithAmount(amountSol: number) {
    if (!publicKey || !startup || !id) return;

    try {
      setInvesting(true);
      setInvestError("");

      const escrowPubkey = new PublicKey(ESCROW_WALLET);
      const lamports = Math.floor(amountSol * LAMPORTS_PER_SOL);
      if (lamports < 1) {
        setInvestError("Amount is too small to send (needs at least ~0.000000001 SOL).");
        return;
      }

      const balance = await connection.getBalance(publicKey);
      const feeEstimate = 5000;
      if (balance < lamports + feeEstimate) {
        setInvestError(`Insufficient balance. You have ${balance / LAMPORTS_PER_SOL} SOL, but need ${amountSol + (feeEstimate / LAMPORTS_PER_SOL)} SOL (including network fee).`);
        setInvesting(false);
        return;
      }

      const transferInstruction = SystemProgram.transfer({
        fromPubkey: publicKey,
        toPubkey: escrowPubkey,
        lamports,
      });

      let blockhash: string;
      let lastValidBlockHeight: number;
      let signature: string;

      const buildTx = (recentBlockhash: string) =>
        new VersionedTransaction(
          new TransactionMessage({
            payerKey: publicKey,
            recentBlockhash,
            instructions: [transferInstruction],
          }).compileToV0Message()
        );

      const sendOpts = (skipPreflight: boolean) => ({
        skipPreflight,
        maxRetries: 5,
        preflightCommitment: "confirmed" as const,
      });

      const fresh = await connection.getLatestBlockhash("confirmed");
      blockhash = fresh.blockhash;
      lastValidBlockHeight = fresh.lastValidBlockHeight;
      let tx = buildTx(blockhash);

      // RPC-side simulation (does not use Phantom) — surfaces invalid ix / balance / cluster issues.
      try {
        const { value: sim } = await connection.simulateTransaction(tx, {
          sigVerify: false,
          replaceRecentBlockhash: true,
          commitment: "confirmed",
        });
        if (sim.err) {
          const logText = sim.logs?.join("\n") ?? "";
          console.error("[invest] simulateTransaction (v0): err=", sim.err, "logs=", sim.logs);
          throw new Error(
            `Simulation failed (check cluster + escrow + balance):\n${JSON.stringify(sim.err)}${logText ? `\n${logText.slice(0, 4000)}` : ""}`
          );
        }
      } catch (simErr) {
        if (simErr instanceof Error && simErr.message.startsWith("Simulation failed")) {
          throw simErr;
        }
        console.warn(
          "[invest] simulateTransaction threw (RPC flake); continuing to wallet send:",
          simErr
        );
      }

      try {
        signature = await sendTransaction(tx, connection, sendOpts(false));
      } catch (firstErr) {
        if (!(firstErr instanceof WalletSendTransactionError)) throw firstErr;
        logWalletSendTransactionFailure(
          "sendTransaction v0 skipPreflight=false",
          firstErr
        );

        const again = await connection.getLatestBlockhash("confirmed");
        blockhash = again.blockhash;
        lastValidBlockHeight = again.lastValidBlockHeight;

        const legacyTx = new Transaction({
          feePayer: publicKey,
          blockhash,
          lastValidBlockHeight,
        }).add(transferInstruction);

        try {
          // Legacy overload: (tx, signers?, ...) — do not pass a config object here.
          const { value: simLegacy } =
            await connection.simulateTransaction(legacyTx);
          if (simLegacy.err) {
            console.error(
              "[invest] simulateTransaction (legacy): err=",
              simLegacy.err,
              "logs=",
              simLegacy.logs
            );
          }
        } catch (e) {
          console.warn("[invest] legacy simulate threw:", e);
        }

        try {
          signature = await sendTransaction(
            legacyTx,
            connection,
            sendOpts(true)
          );
        } catch (legacySendErr) {
          logWalletSendTransactionFailure(
            "sendTransaction legacy skipPreflight=true",
            legacySendErr
          );
          tx = buildTx(blockhash);
          try {
            signature = await sendTransaction(tx, connection, sendOpts(true));
          } catch (v0SkipErr) {
            logWalletSendTransactionFailure(
              "sendTransaction v0 skipPreflight=true",
              v0SkipErr
            );
            if (!signTransaction) throw firstErr;
            const signed = await signTransaction(tx);
            signature = await connection.sendRawTransaction(signed.serialize(), {
              skipPreflight: true,
              maxRetries: 5,
              preflightCommitment: "confirmed",
            });
          }
        }
      }

      await connection.confirmTransaction({
        signature,
        blockhash,
        lastValidBlockHeight,
      });

      // Give RPC a moment to index before backend queries it
      await new Promise((r) => setTimeout(r, 2000));

      await invest.create({
        startupId: id,
        amountSol,
        txHash: signature,
        senderWallet: publicKey.toBase58(),
      });

      const { data } = await startups.get(id);
      setStartup(data);
      setInvestAmount("");
    } catch (error: unknown) {
      if (error instanceof WalletSendTransactionError) {
        logWalletSendTransactionFailure("handleInvestWithAmount (final catch)", error);
      }
      console.error(error);
      setInvestError(investErrorMessage(error));
    } finally {
      setInvesting(false);
    }
  }

  function handleInvestClick() {
    const amount = parseFloat(investAmount);
    if (!Number.isFinite(amount) || amount <= 0) {
      setInvestError("Invalid amount");
      return;
    }
    const remainingUSD = VALUATION - (startup?.totalRaised ?? 0);
    if (amount * 100 > remainingUSD) {
      setInvestError("Amount exceeds remaining target");
      return;
    }
    if (!user) {
      setInvestError("Please log in to invest");
      return;
    }
    if (!ESCROW_WALLET) {
      setInvestError("Escrow wallet not configured");
      return;
    }

    if (!publicKey) {
      // Not connected: store amount, open wallet (Phantom)
      setPendingInvestAmount(amount);
      setInvestError("");
      if (wallet) {
        wallet.adapter.connect();
      } else {
        setWalletModalVisible(true); // Open modal to pick Phantom
      }
    } else {
      // Already connected: send tx directly
      handleInvestWithAmount(amount);
    }
  }

  if (loading) {
    return (
      <div className="flex min-h-[40vh] items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-emerald-500 border-t-transparent" />
      </div>
    );
  }

  if (error || !startup) {
    return (
      <div>
        <p className="text-red-400">{error ?? "Not found"}</p>
        <Link to="/app/startups" className="mt-4 inline-block text-emerald-400 hover:underline">
          ← Back to startups
        </Link>
      </div>
    );
  }

  return (
    <div>
      <Link
        to="/app/startups"
        className="mb-8 inline-flex items-center gap-2 text-sm font-medium text-slate-400 hover:text-white transition-colors"
      >
        ← Back to startups
      </Link>
      <div className="rounded-xl border border-white/5 bg-[#0c0c0c] p-6 sm:p-8" data-testid="startup-detail-content">
        <div className="flex items-center gap-3">
          <h1 className="text-2xl font-bold" data-testid="startup-title">{startup.name}</h1>
          {startup.githubUrl && (
            <a
              href={startup.githubUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-slate-400 hover:text-white transition-colors inline-flex items-center gap-1"
              aria-label="GitHub"
            >
              <svg className="w-5 h-5" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
                <path fillRule="evenodd" d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.531 1.032 1.531 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0112 6.844c.85.004 1.705.115 2.504.337 1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.019 10.019 0 0022 12.017C22 6.484 17.522 2 12 2z" clipRule="evenodd" />
              </svg>
              <span className="text-sm">GitHub</span>
            </a>
          )}
        </div>
        <p className="mt-2 text-slate-400" data-testid="startup-description">{startup.description}</p>
        <div data-testid="Founder section" className="mt-2">
          <p className="text-sm text-slate-500 flex items-center gap-2 flex-wrap">
            <span>by {startup.founder.name}</span>
            <span data-testid="Social links" className="flex items-center gap-2">
              {startup.githubUrl && (
                <a href={startup.githubUrl} target="_blank" rel="noopener noreferrer" className="text-slate-500 hover:text-slate-300 transition-colors text-xs">GitHub</a>
              )}
              {startup.linkedinUrl && (
                <a href={startup.linkedinUrl} target="_blank" rel="noopener noreferrer" className="text-slate-500 hover:text-slate-300 transition-colors inline-flex items-center gap-1">
                  <svg className="w-3.5 h-3.5 opacity-80" viewBox="0 0 24 24" fill="currentColor" aria-hidden><path d="M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433c-1.144 0-2.063-.926-2.063-2.065 0-1.138.92-2.063 2.063-2.063 1.14 0 2.064.925 2.064 2.063 0 1.139-.925 2.065-2.064 2.065zm1.782 13.019H3.555V9h3.564v11.452zM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.271V1.729C24 .774 23.2 0 22.222 0h.003z"/></svg>
                  <span className="text-xs">LinkedIn</span>
                </a>
              )}
              {startup.xUrl && (
                <a href={startup.xUrl} target="_blank" rel="noopener noreferrer" className="text-slate-500 hover:text-slate-300 transition-colors inline-flex items-center gap-1">
                  <svg className="w-3.5 h-3.5 opacity-80" viewBox="0 0 24 24" fill="currentColor" aria-hidden><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/></svg>
                  <span className="text-xs">X</span>
                </a>
              )}
            </span>
          </p>
        </div>

        <div className="mt-8 flex flex-wrap items-center gap-4 text-sm">
          <span className="text-slate-400">
            Valuation: ${startup.valuation.toLocaleString()}
          </span>
          <span
            className={
              isFundingOpen ? "text-[#1b7f53] font-medium" : "text-amber-500 font-medium"
            }
          >
            {countdown}
          </span>
        </div>

        <div className="mt-4">
          <div className="h-3 overflow-hidden rounded-full border border-white/5 bg-[#1a1a1a]" data-testid="Funding progress bar" role="progressbar" aria-valuenow={progress} aria-valuemin={0} aria-valuemax={100}>
            <div
              className="h-full rounded-full bg-[#1b7f53] transition-all"
              style={{ width: `${progress}%` }}
            />
          </div>
          <p className="mt-2 text-sm text-slate-500">
            ${startup.totalRaised.toFixed(0)} / ${VALUATION.toLocaleString()} (
            {progress.toFixed(0)}%)
          </p>
          {startup.categories && startup.categories.length > 0 && (
            <div className="mt-3 flex flex-wrap gap-1.5" data-testid="Category tags">
              {startup.categories.map((tag) => (
                <span
                  key={tag}
                  className="rounded-md border border-white/10 px-2 py-0.5 text-xs text-slate-400"
                >
                  {tag}
                </span>
              ))}
            </div>
          )}
        </div>

        {!isFundingOpen && (
          <p className="mt-6 text-sm text-amber-500 font-medium" data-testid="funding-closed-message">Funding not yet open</p>
        )}

        {isFundingOpen && user && (
          <div className="mt-8 rounded-xl border border-white/5 bg-[#1a1a1a] p-5 sm:p-6">
            <h3 className="font-semibold text-white">Invest with SOL</h3>
            <p className="mt-1.5 text-xs text-slate-500 font-medium">
              1 SOL = $100 • Stake = (amount × 100) / $20,000
            </p>
            <div className="mt-4 flex flex-wrap items-center gap-3">
              <label htmlFor="invest-sol-amount" className="sr-only">SOL amount</label>
              <input
                id="invest-sol-amount"
                type="number"
                step="0.01"
                min="0"
                placeholder="Amount in SOL"
                value={investAmount}
                onChange={(e) => setInvestAmount(e.target.value)}
                className="w-48 rounded-lg border border-white/10 bg-[#111] px-4 py-2.5 text-sm text-slate-100 placeholder-[#666] focus:border-[#444] focus:bg-[#1a1a1a] focus:outline-none focus:ring-1 focus:ring-[#444] transition-all"
                aria-label="SOL amount"
              />
              <button
                onClick={handleInvestClick}
                disabled={investing}
                className="rounded-lg bg-white px-6 py-2.5 text-sm font-medium text-black hover:bg-slate-200 disabled:opacity-50 transition-colors shadow-lg"
              >
                {investing ? "Processing…" : "Invest"}
              </button>
            </div>
            {investError && (
              <p className="mt-2 text-sm text-red-400">{investError}</p>
            )}
          </div>
        )}
      </div>

      <div className="mt-10">
        <h2 className="mb-4 text-sm font-bold text-white tracking-wide">Investors</h2>
        <ul className="space-y-3" data-testid="Investors list">
            {startup.investments.map((inv) => (
              <li
                key={inv.id}
                className="flex items-center rounded-lg border border-white/5 bg-[#111] px-5 py-3.5 text-sm transition-colors hover:border-white/10"
              >
                <span className="font-medium text-slate-300">{inv.investor.name}</span>
                <span className="mx-3 text-slate-700">•</span>
                <span className="font-semibold text-[#1b7f53]">{inv.amountSol} SOL</span>
                <span className="mx-3 text-slate-700">•</span>
                <span className="text-slate-500 font-medium">
                  {(inv.stake * 100).toFixed(2)}% stake
                </span>
              </li>
            ))}
          </ul>
      </div>
    </div>
  );
}
