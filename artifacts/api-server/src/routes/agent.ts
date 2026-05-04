import { Router, type IRouter } from "express";
import { runDiscordAgent, stopActiveAgent, type AgentTask } from "../agent/discordAgent";

const router: IRouter = Router();

const activeSessions = new Map<string, { resolve: () => void }>();

router.post("/agent/start", async (req, res) => {
  const { task } = req.body as { task: AgentTask };
  if (!task || !task.kind) {
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
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  send({ type: "session_id", sessionId });

  const captchaResolver = (): Promise<void> => {
    return new Promise((resolve) => {
      activeSessions.set(sessionId, { resolve });
      send({ type: "captcha_pending", sessionId });
    });
  };

  req.on("close", () => {
    activeSessions.delete(sessionId);
  });

  await runDiscordAgent(
    task,
    (event) => {
      send(event);
      if ((event.type === "done" || event.type === "error") && !res.writableEnded) {
        res.end();
      }
    },
    captchaResolver
  );

  if (!res.writableEnded) res.end();
});

router.post("/agent/captcha-solved/:sessionId", (req, res) => {
  const { sessionId } = req.params;
  const session = activeSessions.get(sessionId);
  if (session) {
    session.resolve();
    activeSessions.delete(sessionId);
    res.json({ success: true });
  } else {
    res.status(404).json({ error: "Session not found" });
  }
});

router.post("/agent/stop", async (_req, res) => {
  await stopActiveAgent();
  res.json({ success: true });
});

export default router;
