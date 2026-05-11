import { Router } from "express";
import { prisma } from "../config/db.js";
import { authMiddleware, AuthRequest } from "../middleware/auth.js";
import { verifyTransaction } from "../services/solana.service.js";
import { SOL_PER_USD, VALUATION } from "../config/env.js";

export const investRouter = Router();

investRouter.post("/", authMiddleware, async (req: AuthRequest, res) => {
  try {
    const { startupId, amountSol, txHash, senderWallet } = req.body;
    const userId = req.userId;

    if (!userId) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }

    if (!startupId || amountSol == null || !txHash || !senderWallet) {
      res.status(400).json({
        error: "Missing required fields: startupId, amountSol, txHash, senderWallet",
      });
      return;
    }

    const amount = Number(amountSol);
    if (amount <= 0 || !Number.isFinite(amount)) {
      res.status(400).json({ error: "Invalid amountSol" });
      return;
    }

    const [startup, user] = await Promise.all([
      prisma.startup.findUnique({ where: { id: startupId } }),
      prisma.user.findUnique({ where: { id: userId } }),
    ]);

    if (!startup) {
      res.status(404).json({ error: "Startup not found" });
      return;
    }

    if (!user) {
      res.status(404).json({ error: "User not found" });
      return;
    }

    if (new Date() < startup.fundingOpenAt) {
      res.status(400).json({
        error: "Funding not yet open for this startup",
      });
      return;
    }

    // Verify transaction on Solana using the actual connected wallet
    const verification = await verifyTransaction(
      txHash,
      senderWallet,
      amount
    );

    if (!verification.success) {
      res.status(400).json({
        error: verification.error ?? "Transaction verification failed",
      });
      return;
    }

    // Stake calculation: 1 SOL = $100, stake = investmentUSD / 20000
    const investmentUSD = amount * SOL_PER_USD;
    const stake = investmentUSD / VALUATION;

    const investment = await prisma.$transaction(async (tx) => {
      const inv = await tx.investment.create({
        data: {
          startupId,
          investorId: userId,
          amountSol: amount,
          stake,
          txHash,
        },
      });
      await tx.startup.update({
        where: { id: startupId },
        data: { totalRaised: { increment: investmentUSD } },
      });
      return inv;
    });

    res.status(201).json(investment);
  } catch (err) {
    console.error("Invest error:", err);
    const msg = err instanceof Error ? err.message : "Investment failed";
    res.status(500).json({ error: "Investment failed", details: msg });
  }
});
