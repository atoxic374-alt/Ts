import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { accountsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import {
  CreateAccountBody,
  UpdateAccountBody,
  GetAccountParams,
  UpdateAccountParams,
  DeleteAccountParams,
} from "@workspace/api-zod";

const router: IRouter = Router();

router.get("/accounts", async (req, res) => {
  const accounts = await db.select().from(accountsTable).orderBy(accountsTable.createdAt);
  res.json(
    accounts.map((a) => ({
      ...a,
      createdAt: a.createdAt.toISOString(),
    }))
  );
});

router.post("/accounts", async (req, res) => {
  const body = CreateAccountBody.parse(req.body);
  const [account] = await db
    .insert(accountsTable)
    .values({
      name: body.name,
      email: body.email,
      password: body.password,
      twofaSecret: body.twofaSecret ?? null,
      status: body.status ?? "active",
    })
    .returning();
  res.status(201).json({ ...account, createdAt: account.createdAt.toISOString() });
});

router.get("/accounts/:id", async (req, res) => {
  const { id } = GetAccountParams.parse({ id: Number(req.params.id) });
  const [account] = await db.select().from(accountsTable).where(eq(accountsTable.id, id));
  if (!account) {
    res.status(404).json({ error: "Account not found" });
    return;
  }
  res.json({ ...account, createdAt: account.createdAt.toISOString() });
});

router.put("/accounts/:id", async (req, res) => {
  const { id } = UpdateAccountParams.parse({ id: Number(req.params.id) });
  const body = UpdateAccountBody.parse(req.body);
  const [account] = await db
    .update(accountsTable)
    .set({
      name: body.name,
      email: body.email,
      password: body.password,
      twofaSecret: body.twofaSecret ?? null,
      status: body.status ?? "active",
    })
    .where(eq(accountsTable.id, id))
    .returning();
  if (!account) {
    res.status(404).json({ error: "Account not found" });
    return;
  }
  res.json({ ...account, createdAt: account.createdAt.toISOString() });
});

router.delete("/accounts/:id", async (req, res) => {
  const { id } = DeleteAccountParams.parse({ id: Number(req.params.id) });
  await db.delete(accountsTable).where(eq(accountsTable.id, id));
  res.json({ success: true });
});

export default router;
