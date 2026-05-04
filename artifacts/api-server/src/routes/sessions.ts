import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { sessionsTable } from "@workspace/db";
import { eq, desc } from "drizzle-orm";
import {
  CreateSessionBody,
  UpdateSessionBody,
  GetSessionParams,
  UpdateSessionParams,
  StopSessionParams,
} from "@workspace/api-zod";

const router: IRouter = Router();

const formatSession = (s: typeof sessionsTable.$inferSelect) => ({
  ...s,
  createdAt: s.createdAt.toISOString(),
  updatedAt: s.updatedAt.toISOString(),
});

router.get("/sessions", async (_req, res) => {
  const sessions = await db
    .select()
    .from(sessionsTable)
    .orderBy(desc(sessionsTable.createdAt));
  res.json(sessions.map(formatSession));
});

router.post("/sessions", async (req, res) => {
  const body = CreateSessionBody.parse(req.body);
  const [session] = await db
    .insert(sessionsTable)
    .values({
      total: body.total,
      waitSeconds: body.waitSeconds,
      status: "running",
      progress: 0,
      logs: "",
    })
    .returning();
  res.status(201).json(formatSession(session));
});

router.get("/sessions/active", async (_req, res) => {
  const [session] = await db
    .select()
    .from(sessionsTable)
    .where(eq(sessionsTable.status, "running"))
    .orderBy(desc(sessionsTable.createdAt))
    .limit(1);
  if (!session) {
    const [waiting] = await db
      .select()
      .from(sessionsTable)
      .where(eq(sessionsTable.status, "waiting"))
      .orderBy(desc(sessionsTable.createdAt))
      .limit(1);
    if (waiting) {
      res.json({ exists: true, session: formatSession(waiting) });
      return;
    }
    res.json({ exists: false });
    return;
  }
  res.json({ exists: true, session: formatSession(session) });
});

router.get("/sessions/:id", async (req, res) => {
  const { id } = GetSessionParams.parse({ id: Number(req.params.id) });
  const [session] = await db.select().from(sessionsTable).where(eq(sessionsTable.id, id));
  if (!session) {
    res.status(404).json({ error: "Session not found" });
    return;
  }
  res.json(formatSession(session));
});

router.put("/sessions/:id", async (req, res) => {
  const { id } = UpdateSessionParams.parse({ id: Number(req.params.id) });
  const body = UpdateSessionBody.parse(req.body);
  const updates: Partial<typeof sessionsTable.$inferInsert> = {
    updatedAt: new Date(),
  };
  if (body.status !== undefined) updates.status = body.status;
  if (body.progress !== undefined) updates.progress = body.progress;
  if (body.logs !== undefined) updates.logs = body.logs;
  const [session] = await db
    .update(sessionsTable)
    .set(updates)
    .where(eq(sessionsTable.id, id))
    .returning();
  if (!session) {
    res.status(404).json({ error: "Session not found" });
    return;
  }
  res.json(formatSession(session));
});

router.post("/sessions/:id/stop", async (req, res) => {
  const { id } = StopSessionParams.parse({ id: Number(req.params.id) });
  const [session] = await db
    .update(sessionsTable)
    .set({ status: "stopped", updatedAt: new Date() })
    .where(eq(sessionsTable.id, id))
    .returning();
  if (!session) {
    res.status(404).json({ error: "Session not found" });
    return;
  }
  res.json(formatSession(session));
});

export default router;
