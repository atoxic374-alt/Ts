import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { accountsTable, botsTable, sessionsTable } from "@workspace/db";
import { eq, count, desc } from "drizzle-orm";

const router: IRouter = Router();

router.get("/stats", async (_req, res) => {
  const [totalAccountsResult] = await db.select({ count: count() }).from(accountsTable);
  const [activeAccountsResult] = await db
    .select({ count: count() })
    .from(accountsTable)
    .where(eq(accountsTable.status, "active"));
  const [totalBotsResult] = await db.select({ count: count() }).from(botsTable);
  const [activeBotsResult] = await db
    .select({ count: count() })
    .from(botsTable)
    .where(eq(botsTable.status, "active"));
  const [totalSessionsResult] = await db.select({ count: count() }).from(sessionsTable);
  const [lastSession] = await db
    .select({ status: sessionsTable.status })
    .from(sessionsTable)
    .orderBy(desc(sessionsTable.createdAt))
    .limit(1);

  res.json({
    totalAccounts: totalAccountsResult.count,
    activeAccounts: activeAccountsResult.count,
    totalBots: totalBotsResult.count,
    activeBots: activeBotsResult.count,
    totalSessions: totalSessionsResult.count,
    lastSessionStatus: lastSession?.status ?? null,
  });
});

export default router;
