import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { botsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import {
  CreateBotBody,
  UpdateBotBody,
  GetBotParams,
  UpdateBotParams,
  DeleteBotParams,
} from "@workspace/api-zod";

const router: IRouter = Router();

router.get("/bots", async (req, res) => {
  const bots = await db.select().from(botsTable).orderBy(botsTable.createdAt);
  res.json(
    bots.map((b) => ({
      ...b,
      createdAt: b.createdAt.toISOString(),
    }))
  );
});

router.post("/bots", async (req, res) => {
  const body = CreateBotBody.parse(req.body);
  const [bot] = await db
    .insert(botsTable)
    .values({
      accountId: body.accountId ?? null,
      name: body.name,
      token: body.token,
      prefix: body.prefix,
      status: body.status ?? "active",
    })
    .returning();
  res.status(201).json({ ...bot, createdAt: bot.createdAt.toISOString() });
});

router.get("/bots/:id", async (req, res) => {
  const { id } = GetBotParams.parse({ id: Number(req.params.id) });
  const [bot] = await db.select().from(botsTable).where(eq(botsTable.id, id));
  if (!bot) {
    res.status(404).json({ error: "Bot not found" });
    return;
  }
  res.json({ ...bot, createdAt: bot.createdAt.toISOString() });
});

router.put("/bots/:id", async (req, res) => {
  const { id } = UpdateBotParams.parse({ id: Number(req.params.id) });
  const body = UpdateBotBody.parse(req.body);
  const [bot] = await db
    .update(botsTable)
    .set({
      accountId: body.accountId ?? null,
      name: body.name,
      token: body.token,
      prefix: body.prefix,
      status: body.status ?? "active",
    })
    .where(eq(botsTable.id, id))
    .returning();
  if (!bot) {
    res.status(404).json({ error: "Bot not found" });
    return;
  }
  res.json({ ...bot, createdAt: bot.createdAt.toISOString() });
});

router.delete("/bots/:id", async (req, res) => {
  const { id } = DeleteBotParams.parse({ id: Number(req.params.id) });
  await db.delete(botsTable).where(eq(botsTable.id, id));
  res.json({ success: true });
});

export default router;
