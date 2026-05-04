import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { automationRulesTable } from "@workspace/db";
import { UpdateRulesBody } from "@workspace/api-zod";

const router: IRouter = Router();

router.get("/rules", async (_req, res) => {
  const rules = await db.select().from(automationRulesTable).limit(1);
  if (rules.length === 0) {
    const [defaultRules] = await db
      .insert(automationRulesTable)
      .values({
        createTeams: true,
        createBots: true,
        linkBots: true,
        quantity: 10,
        botPrefix: "True-Studio",
        waitMinutes: 15,
      })
      .returning();
    res.json(defaultRules);
    return;
  }
  res.json(rules[0]);
});

router.put("/rules", async (req, res) => {
  const body = UpdateRulesBody.parse(req.body);
  const existing = await db.select().from(automationRulesTable).limit(1);
  if (existing.length === 0) {
    const [rules] = await db.insert(automationRulesTable).values(body).returning();
    res.json(rules);
    return;
  }
  const { eq } = await import("drizzle-orm");
  const [rules] = await db
    .update(automationRulesTable)
    .set(body)
    .where(eq(automationRulesTable.id, existing[0].id))
    .returning();
  res.json(rules);
});

export default router;
