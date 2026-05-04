import { Router, type IRouter } from "express";
import {
  runDiscordAgent,
  stopActiveAgent,
  getSessionScreenshot,
  interactWithSession,
  type AgentTask,
} from "../agent/discordAgent";

const router: IRouter = Router();

// sessionId → captcha resolve function
const captchaPending = new Map<string, { resolve: () => void }>();

// ── Start agent (SSE stream) ──────────────────────────────────────────────────
router.post("/agent/start", async (req, res) => {
  const { task } = req.body as { task: AgentTask };
  if (!task?.kind) {
    res.status(400).json({ error: "task.kind مطلوب" });
    return;
  }

  const sessionId = `sess_${Date.now()}`;

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();

  const send = (data: object) => {
    if (!res.writableEnded) res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  send({ type: "session_id", sessionId });

  const captchaResolver = (): Promise<void> =>
    new Promise((resolve) => {
      captchaPending.set(sessionId, { resolve });
      send({ type: "captcha_pending", sessionId });
    });

  req.on("close", () => captchaPending.delete(sessionId));

  await runDiscordAgent(sessionId, task, (event) => {
    send(event);
    if ((event.type === "done" || event.type === "error") && !res.writableEnded) {
      res.end();
    }
  }, captchaResolver);

  if (!res.writableEnded) res.end();
});

// ── Live screenshot poll (called every ~800ms by frontend during captcha) ─────
router.get("/agent/screenshot/:sessionId", async (req, res) => {
  const { sessionId } = req.params;
  const data = await getSessionScreenshot(sessionId);
  if (!data) {
    res.status(404).json({ error: "no active page" });
    return;
  }
  res.json({ screenshot: data });
});

// ── Forward user interaction to browser ──────────────────────────────────────
router.post("/agent/interact/:sessionId", async (req, res) => {
  const { sessionId } = req.params;
  const { action } = req.body as {
    action:
      | { type: "click"; x: number; y: number }
      | { type: "type"; text: string }
      | { type: "key"; key: string }
      | { type: "scroll"; deltaY: number };
  };
  if (!action) {
    res.status(400).json({ error: "action مطلوب" });
    return;
  }
  const result = await interactWithSession(sessionId, action);
  // Return the fresh screenshot inline so the client doesn't need a second request
  res.json({ success: result.ok, screenshot: result.screenshotAfter ?? null });
});

// ── Mark captcha as solved → unblock agent ───────────────────────────────────
router.post("/agent/captcha-solved/:sessionId", (req, res) => {
  const { sessionId } = req.params;
  const pending = captchaPending.get(sessionId);
  if (pending) {
    pending.resolve();
    captchaPending.delete(sessionId);
    res.json({ success: true });
  } else {
    res.status(404).json({ error: "لا يوجد انتظار كابتشا لهذه الجلسة" });
  }
});

// ── Stop agent ────────────────────────────────────────────────────────────────
router.post("/agent/stop", async (_req, res) => {
  await stopActiveAgent();
  captchaPending.clear();
  res.json({ success: true });
});

export default router;
