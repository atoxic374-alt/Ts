import { pgTable, serial, boolean, integer, text } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const automationRulesTable = pgTable("automation_rules", {
  id: serial("id").primaryKey(),
  createTeams: boolean("create_teams").notNull().default(true),
  createBots: boolean("create_bots").notNull().default(true),
  linkBots: boolean("link_bots").notNull().default(true),
  quantity: integer("quantity").notNull().default(10),
  botPrefix: text("bot_prefix").notNull().default("True-Studio"),
  waitMinutes: integer("wait_minutes").notNull().default(15),
});

export const insertAutomationRulesSchema = createInsertSchema(automationRulesTable).omit({ id: true });
export type InsertAutomationRules = z.infer<typeof insertAutomationRulesSchema>;
export type AutomationRules = typeof automationRulesTable.$inferSelect;
