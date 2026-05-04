import { Router } from "express";
import type { Response } from "express";
import {
  runDiscordAgent,
  stopActiveAgent,
  getSessionScreenshot,
  interactWithSession,
  pauseSession,
  resumeSession,
  type AgentTask,
  type AgentEvent,
} from "../agent/discordAgent";

const router = Router();

// ── Session store (in-memory, survives client refresh) ───────────────────────
interface StoredEvent { ev: AgentEvent | { type: "session_id"; sessionId: string } }
interface SessionState {
  task: AgentTask;
  events: StoredEvent[];
  lastScreenshot: string | null;
  status: "running" | "paused" | "done" | "error";
  sseClients: Set<Response>;
}
const sessions = new Map<string, SessionState>();
const captchaPending = new Map<string, { resolve: () => void }>();

function broadcast(sessionId: string, data: object) {
  const session = sessions.get(sessionId);
  if (!session) return;
  const msg = `data: ${JSON.stringify(data)}\n\n`;
  for (const client of session.sseClients) {
    if (!client.writableEnded) client.write(msg);
  }
}

function storeAndBroadcast(sessionId: string, event: AgentEvent | { type: "session_id"; sessionId: string }) {
  const session = sessions.get(sessionId);
  if (!session) return;
  session.events.push({ ev: event });
  if (session.events.length > 1200) session.events.splice(0, session.events.length - 1200);
  if (event.type === "screenshot") session.lastScreenshot = (event as { type: "screenshot"; data: string }).data;
  if (event.type === "done") session.status = (event as { type: "done"; success: boolean }).success ? "done" : "error";
  if (event.type === "error") session.status = "error";
  if (event.type === "paused") session.status = "paused";
  if (event.type === "resumed") session.status = "running";
  broadcast(sessionId, event);
}

// ── POST /agent/start ─────────────────────────────────────────────────────────
router.post("/agent/start", async (req, res) => {
  const { task } = req.body as { task: AgentTask };
  if (!task?.kind) { res.status(400).json({ error: "task.kind مطلوب" }); return; }

  const sessionId = `sess_${Date.now()}`;

  // Create session state
  const session: SessionState = {
    task, events: [], lastScreenshot: null, status: "running", sseClients: new Set(),
  };
  sessions.set(sessionId, session);

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();

  session.sseClients.add(res);

  // Store + send session_id event
  const sessionIdEvent = { type: "session_id" as const, sessionId };
  storeAndBroadcast(sessionId, sessionIdEvent);

  const captchaResolver = (): Promise<void> =>
    new Promise((resolve) => {
      captchaPending.set(sessionId, { resolve });
    });

  req.on("close", () => {
    session.sseClients.delete(res);
    captchaPending.delete(sessionId);
  });

  await runDiscordAgent(sessionId, task, (event) => {
    storeAndBroadcast(sessionId, event);
    if ((event.type === "done" || event.type === "error") && !res.writableEnded) res.end();
  }, captchaResolver);

  session.sseClients.delete(res);
  if (!res.writableEnded) res.end();
});

// ── GET /agent/status/:sessionId — check session alive ───────────────────────
router.get("/agent/status/:sessionId", (req, res) => {
  const { sessionId } = req.params;
  const session = sessions.get(sessionId);
  if (!session) { res.status(404).json({ exists: false }); return; }
  res.json({
    exists: true,
    status: session.status,
    lastScreenshot: session.lastScreenshot,
    eventCount: session.events.length,
  });
});

// ── GET /agent/reconnect/:sessionId — SSE reconnect with full replay ──────────
router.get("/agent/reconnect/:sessionId", (req, res) => {
  const { sessionId } = req.params;
  const session = sessions.get(sessionId);
  if (!session) { res.status(404).json({ error: "جلسة غير موجودة" }); return; }

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();

  // Replay all stored events (skip heavy screenshot events except the last one)
  const events = session.events;
  for (let i = 0; i < events.length; i++) {
    const ev = events[i].ev;
    if (ev.type === "screenshot" && i < events.length - 1) continue; // skip all but last screenshot
    if (!res.writableEnded) res.write(`data: ${JSON.stringify(ev)}\n\n`);
  }

  // Subscribe for future events if session is still active
  if (session.status === "running" || session.status === "paused") {
    session.sseClients.add(res);
    req.on("close", () => session.sseClients.delete(res));
  } else {
    res.end();
  }
});

// ── POST /agent/pause/:sessionId ─────────────────────────────────────────────
router.post("/agent/pause/:sessionId", (req, res) => {
  const { sessionId } = req.params;
  pauseSession(sessionId);
  res.json({ success: true });
});

// ── POST /agent/resume/:sessionId ────────────────────────────────────────────
router.post("/agent/resume/:sessionId", (req, res) => {
  const { sessionId } = req.params;
  resumeSession(sessionId);
  res.json({ success: true });
});

// ── GET /agent/screenshot/:sessionId ─────────────────────────────────────────
router.get("/agent/screenshot/:sessionId", async (req, res) => {
  const { sessionId } = req.params;
  const data = await getSessionScreenshot(sessionId);
  if (!data) { res.status(404).json({ error: "no active page" }); return; }
  res.json({ screenshot: data });
});

// ── POST /agent/interact/:sessionId ──────────────────────────────────────────
router.post("/agent/interact/:sessionId", async (req, res) => {
  const { sessionId } = req.params;
  const { action } = req.body as {
    action:
      | { type: "click"; x: number; y: number }
      | { type: "mousedown"; x: number; y: number }
      | { type: "mousemove"; x: number; y: number }
      | { type: "mouseup"; x: number; y: number }
      | { type: "type"; text: string }
      | { type: "key"; key: string }
      | { type: "scroll"; deltaY: number };
  };
  if (!action) { res.status(400).json({ error: "action مطلوب" }); return; }
  const result = await interactWithSession(sessionId, action);
  // If got a new screenshot, store it
  if (result.screenshotAfter) {
    const session = sessions.get(sessionId);
    if (session) session.lastScreenshot = result.screenshotAfter;
  }
  res.json({ success: result.ok, screenshot: result.screenshotAfter ?? null });
});

// ── POST /agent/captcha-solved/:sessionId ────────────────────────────────────
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

// ── POST /agent/stop ──────────────────────────────────────────────────────────
router.post("/agent/stop", async (_req, res) => {
  await stopActiveAgent();
  captchaPending.clear();
  res.json({ success: true });
});

export default router;
