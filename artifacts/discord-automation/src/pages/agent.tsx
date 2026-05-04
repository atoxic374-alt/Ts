import { useState, useRef, useEffect, useCallback } from "react";
import { useListAccounts } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  Bot, Play, Square, RefreshCw, AlertTriangle, CheckCircle,
  XCircle, Info, Eye, Cpu, MousePointer, Keyboard, CornerDownLeft,
  Pause, PlayCircle, WifiOff,
} from "lucide-react";

const BW = 1280;
const BH = 800;
const SESSION_KEY = "discord_agent_session";

type AgentEvent =
  | { type: "session_id"; sessionId: string }
  | { type: "log"; message: string; level: "info" | "warn" | "error" | "success" }
  | { type: "screenshot"; data: string }
  | { type: "captcha"; message: string }
  | { type: "captcha_solved" }
  | { type: "action"; action: string; detail?: string }
  | { type: "done"; success: boolean; message: string }
  | { type: "error"; message: string }
  | { type: "paused" }
  | { type: "resumed" };

type LogEntry = { id: number; message: string; level: "info" | "warn" | "error" | "success" | "action"; time: string };
type TaskKind = "login" | "create_bot" | "reset_token";
type InteractMode = "none" | "captcha" | "paused";

function ts() {
  const n = new Date();
  return `${n.getHours().toString().padStart(2, "0")}:${n.getMinutes().toString().padStart(2, "0")}:${n.getSeconds().toString().padStart(2, "0")}`;
}

function imgToBrowser(el: HTMLImageElement, clientX: number, clientY: number): { x: number; y: number } {
  const rect = el.getBoundingClientRect();
  return {
    x: Math.round(((clientX - rect.left) / rect.width) * BW),
    y: Math.round(((clientY - rect.top) / rect.height) * BH),
  };
}

function saveSession(sessionId: string) {
  localStorage.setItem(SESSION_KEY, JSON.stringify({ sessionId, savedAt: Date.now() }));
}
function clearSession() {
  localStorage.removeItem(SESSION_KEY);
}
function getSavedSession(): string | null {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const { sessionId, savedAt } = JSON.parse(raw) as { sessionId: string; savedAt: number };
    if (Date.now() - savedAt > 4 * 60 * 60 * 1000) { clearSession(); return null; } // 4h expiry
    return sessionId;
  } catch { return null; }
}

export default function Agent() {
  const accounts = useListAccounts();

  const [selectedAccountId, setSelectedAccountId] = useState("");
  const [taskKind, setTaskKind] = useState<TaskKind>("login");
  const [botName, setBotName] = useState("My Bot");
  const [botPrefix, setBotPrefix] = useState("!");
  const [appId, setAppId] = useState("");

  const [running, setRunning] = useState(false);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [agentShot, setAgentShot] = useState<string | null>(null);
  const [liveShot, setLiveShot] = useState<string | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [interactMode, setInteractMode] = useState<InteractMode>("none");
  const [captchaMsg, setCaptchaMsg] = useState("");
  const [typeText, setTypeText] = useState("");
  const [status, setStatus] = useState<"idle" | "running" | "paused" | "done" | "error">("idle");
  const [finalMsg, setFinalMsg] = useState("");
  const [cursorPos, setCursorPos] = useState<{ x: number; y: number } | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [dragStart, setDragStart] = useState<{ x: number; y: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [reconnecting, setReconnecting] = useState(false);

  const logsEndRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const interactImgRef = useRef<HTMLImageElement>(null);
  const logId = useRef(0);
  const lastMoveRef = useRef(0);
  const sessionIdRef = useRef<string | null>(null);

  useEffect(() => { sessionIdRef.current = sessionId; }, [sessionId]);
  useEffect(() => { logsEndRef.current?.scrollIntoView({ behavior: "smooth" }); }, [logs]);

  // Poll screenshot when in interact mode (captcha or paused)
  useEffect(() => {
    const sid = sessionId;
    if (interactMode !== "none" && sid) {
      const poll = async () => {
        try {
          const r = await fetch(`/api/agent/screenshot/${sid}`);
          if (r.ok) { const d = await r.json() as { screenshot: string }; setLiveShot(d.screenshot); }
        } catch {}
      };
      poll();
      pollRef.current = setInterval(poll, 400);
    } else {
      if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
    }
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [interactMode, sessionId]);

  // ── On mount: check for saved session and reconnect ───────────────────────
  useEffect(() => {
    const saved = getSavedSession();
    if (!saved) return;
    (async () => {
      try {
        setReconnecting(true);
        const r = await fetch(`/api/agent/status/${saved}`);
        if (!r.ok) { clearSession(); setReconnecting(false); return; }
        const data = await r.json() as {
          exists: boolean; status: string; lastScreenshot: string | null;
        };
        if (!data.exists || (data.status !== "running" && data.status !== "paused")) {
          clearSession(); setReconnecting(false); return;
        }
        // Reconnect!
        addLog("🔄 إعادة ربط بالجلسة النشطة...", "info");
        setSessionId(saved);
        sessionIdRef.current = saved;
        setRunning(true);
        if (data.status === "paused") setStatus("paused");
        else setStatus("running");
        if (data.lastScreenshot) setAgentShot(data.lastScreenshot);
        subscribeToSession(saved);
      } catch {
        clearSession();
      } finally {
        setReconnecting(false);
      }
    })();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const addLog = useCallback((message: string, level: LogEntry["level"]) => {
    logId.current += 1;
    setLogs((p) => [...p.slice(-499), { id: logId.current, message, level, time: ts() }]);
  }, []);

  // Subscribe to SSE stream (for reconnect)
  const subscribeToSession = useCallback((sid: string) => {
    const abort = new AbortController();
    abortRef.current = abort;
    (async () => {
      try {
        const res = await fetch(`/api/agent/reconnect/${sid}`, { signal: abort.signal });
        if (!res.body) return;
        const reader = res.body.getReader();
        const dec = new TextDecoder();
        let buf = "";
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          const parts = buf.split("\n\n");
          buf = parts.pop() ?? "";
          for (const part of parts) {
            const line = part.trim();
            if (!line.startsWith("data:")) continue;
            try { handleEvent(JSON.parse(line.slice(5).trim()) as AgentEvent); } catch {}
          }
        }
      } catch (err) {
        if ((err as Error).name !== "AbortError") addLog("انقطع الاتصال", "error");
      } finally {
        setRunning(false);
      }
    })();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [addLog]);

  const send = useCallback(async (action: object, silent = false): Promise<string | null> => {
    const sid = sessionIdRef.current;
    if (!sid) return null;
    try {
      const r = await fetch(`/api/agent/interact/${sid}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
      if (!r.ok) return null;
      const d = await r.json() as { success: boolean; screenshot: string | null };
      if (d.screenshot && !silent) setLiveShot(d.screenshot);
      return d.screenshot ?? null;
    } catch { return null; }
  }, []);

  // ── Pointer handlers for the interactive browser image ───────────────────
  const handlePointerDown = useCallback(async (e: React.PointerEvent<HTMLImageElement>) => {
    if (!interactImgRef.current) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    const { x, y } = imgToBrowser(e.currentTarget, e.clientX, e.clientY);
    setIsDragging(false);
    setDragStart({ x, y });
    setCursorPos({ x: e.clientX - e.currentTarget.getBoundingClientRect().left, y: e.clientY - e.currentTarget.getBoundingClientRect().top });
    setBusy(true);
    await send({ type: "mousedown", x, y });
  }, [send]);

  const handlePointerMove = useCallback(async (e: React.PointerEvent<HTMLImageElement>) => {
    if (!interactImgRef.current) return;
    const rect = e.currentTarget.getBoundingClientRect();
    setCursorPos({ x: e.clientX - rect.left, y: e.clientY - rect.top });
    if (e.buttons !== 1) return;
    const { x, y } = imgToBrowser(e.currentTarget, e.clientX, e.clientY);
    if (dragStart && (Math.abs(x - dragStart.x) > 4 || Math.abs(y - dragStart.y) > 4)) setIsDragging(true);
    const now = Date.now();
    if (now - lastMoveRef.current < 33) return;
    lastMoveRef.current = now;
    await send({ type: "mousemove", x, y }, true);
  }, [send, dragStart]);

  const handlePointerUp = useCallback(async (e: React.PointerEvent<HTMLImageElement>) => {
    if (!interactImgRef.current) return;
    const { x, y } = imgToBrowser(e.currentTarget, e.clientX, e.clientY);
    if (!isDragging && dragStart) {
      addLog(`نقر: (${x}, ${y})`, "action");
      await send({ type: "click", x, y });
    } else if (isDragging) {
      addLog(`سحب: (${dragStart?.x ?? x},${dragStart?.y ?? y}) → (${x},${y})`, "action");
      await send({ type: "mouseup", x, y });
    }
    setIsDragging(false); setDragStart(null); setBusy(false);
  }, [send, isDragging, dragStart, addLog]);

  const handlePointerLeave = useCallback(async (e: React.PointerEvent<HTMLImageElement>) => {
    setCursorPos(null);
    if (isDragging && e.buttons === 1) {
      const { x, y } = imgToBrowser(e.currentTarget, e.clientX, e.clientY);
      await send({ type: "mouseup", x, y });
      setIsDragging(false); setDragStart(null); setBusy(false);
    }
  }, [send, isDragging]);

  const handleType = useCallback(async () => {
    if (!typeText || !sessionId || busy) return;
    addLog(`كتابة: ${typeText}`, "action");
    setBusy(true);
    await send({ type: "type", text: typeText });
    setTypeText(""); setBusy(false);
  }, [typeText, sessionId, busy, send, addLog]);

  const handleKey = useCallback(async (key: string) => {
    if (!sessionId || busy) return;
    addLog(`مفتاح: ${key}`, "action");
    setBusy(true);
    await send({ type: "key", key });
    setBusy(false);
  }, [sessionId, busy, send, addLog]);

  // ── handleEvent — processes both live SSE and replayed events ────────────
  const handleEvent = useCallback((ev: AgentEvent) => {
    switch (ev.type) {
      case "session_id":
        setSessionId(ev.sessionId);
        sessionIdRef.current = ev.sessionId;
        addLog(`جلسة: ${ev.sessionId}`, "info");
        break;
      case "log":          addLog(ev.message, ev.level); break;
      case "screenshot":   setAgentShot(ev.data); break;
      case "action":       addLog(`[${ev.action.toUpperCase()}] ${ev.detail ?? ""}`, "action"); break;
      case "captcha":
        setCaptchaMsg(ev.message);
        setInteractMode("captcha");
        addLog("توقف — حل الكابتشا", "warn");
        break;
      case "captcha_solved":
        setInteractMode("none"); setLiveShot(null);
        addLog("تم — استمرار التنفيذ", "success");
        break;
      case "paused":
        setStatus("paused");
        setInteractMode("paused");
        setRunning(true);
        addLog("⏸ مؤقت — يمكنك التحكم الآن", "warn");
        break;
      case "resumed":
        setStatus("running");
        setInteractMode("none"); setLiveShot(null);
        setRunning(true);
        addLog("▶ استُؤنف التنفيذ", "success");
        break;
      case "done":
        setStatus(ev.success ? "done" : "error");
        setFinalMsg(ev.message);
        addLog(ev.message, ev.success ? "success" : "error");
        setRunning(false); setInteractMode("none");
        clearSession();
        break;
      case "error":
        setStatus("error"); setFinalMsg(ev.message);
        addLog(ev.message, "error"); setRunning(false);
        clearSession();
        break;
    }
  }, [addLog]);

  // ── Start agent ──────────────────────────────────────────────────────────
  const handleStart = async () => {
    if (!selectedAccountId) return;
    const acc = accounts.data?.find((a) => a.id === Number(selectedAccountId));
    if (!acc) return;

    setLogs([]); setAgentShot(null); setLiveShot(null);
    setRunning(true); setStatus("running"); setFinalMsg(""); setInteractMode("none");
    logId.current = 0;

    const task: object =
      taskKind === "login"
        ? { kind: "login", email: acc.email, password: acc.password, twofaSecret: acc.twofaSecret ?? undefined }
        : taskKind === "create_bot"
        ? { kind: "create_bot", email: acc.email, password: acc.password, twofaSecret: acc.twofaSecret ?? undefined, botName, prefix: botPrefix }
        : { kind: "reset_token", email: acc.email, password: acc.password, twofaSecret: acc.twofaSecret ?? undefined, appId };

    const abort = new AbortController();
    abortRef.current = abort;

    try {
      const res = await fetch("/api/agent/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ task }),
        signal: abort.signal,
      });
      if (!res.body) throw new Error("no body");
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      let firstSessionId: string | null = null;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const parts = buf.split("\n\n");
        buf = parts.pop() ?? "";
        for (const part of parts) {
          const line = part.trim();
          if (!line.startsWith("data:")) continue;
          try {
            const ev = JSON.parse(line.slice(5).trim()) as AgentEvent;
            handleEvent(ev);
            // Save session to localStorage once we have the ID
            if (ev.type === "session_id" && !firstSessionId) {
              firstSessionId = ev.sessionId;
              saveSession(ev.sessionId);
            }
          } catch {}
        }
      }
    } catch (err) {
      if ((err as Error).name !== "AbortError") addLog("انقطع الاتصال", "error");
    } finally {
      setRunning(false);
    }
  };

  const handleStop = async () => {
    abortRef.current?.abort();
    await fetch("/api/agent/stop", { method: "POST" }).catch(() => {});
    setRunning(false); setStatus("idle"); setInteractMode("none");
    clearSession();
    addLog("أُوقف العميل", "warn");
  };

  const handlePause = async () => {
    const sid = sessionIdRef.current;
    if (!sid) return;
    addLog("⏸ طلب إيقاف مؤقت...", "info");
    await fetch(`/api/agent/pause/${sid}`, { method: "POST" }).catch(() => {});
  };

  const handleResume = async () => {
    const sid = sessionIdRef.current;
    if (!sid) return;
    await fetch(`/api/agent/resume/${sid}`, { method: "POST" }).catch(() => {});
    setInteractMode("none"); setLiveShot(null);
  };

  const handleCaptchaDone = async () => {
    const sid = sessionIdRef.current;
    if (!sid) return;
    await fetch(`/api/agent/captcha-solved/${sid}`, { method: "POST" }).catch(() => {});
    setInteractMode("none"); setLiveShot(null);
    addLog("إشارة متابعة أُرسلت للعميل", "success");
  };

  const logIcon = (lv: LogEntry["level"]) => {
    if (lv === "success") return <CheckCircle className="h-3 w-3 text-primary shrink-0" />;
    if (lv === "error")   return <XCircle className="h-3 w-3 text-destructive shrink-0" />;
    if (lv === "warn")    return <AlertTriangle className="h-3 w-3 text-yellow-400 shrink-0" />;
    if (lv === "action")  return <Cpu className="h-3 w-3 text-blue-400 shrink-0" />;
    return <Info className="h-3 w-3 text-muted-foreground shrink-0" />;
  };
  const logColor = (lv: LogEntry["level"]) => {
    if (lv === "success") return "text-primary";
    if (lv === "error")   return "text-destructive";
    if (lv === "warn")    return "text-yellow-400";
    if (lv === "action")  return "text-blue-400";
    return "text-muted-foreground";
  };

  const displayShot = interactMode !== "none" ? (liveShot ?? agentShot) : agentShot;
  const selectedAccount = accounts.data?.find((a) => a.id === Number(selectedAccountId));
  const interactOpen = interactMode !== "none";
  const isPaused = status === "paused";

  // ── Shared Interactive Browser UI ─────────────────────────────────────────
  const interactiveHeader = interactMode === "paused"
    ? { color: "text-blue-400", badge: "أنت في التحكم", icon: <Pause className="h-4 w-4" />, borderColor: "border-blue-400/50" }
    : { color: "text-yellow-400", badge: "انقر أو اسحب", icon: <AlertTriangle className="h-4 w-4" />, borderColor: "border-yellow-400/50" };

  return (
    <div className="space-y-6" dir="rtl">

      {/* Reconnecting banner */}
      {reconnecting && (
        <div className="flex items-center gap-2 bg-blue-500/10 border border-blue-500/30 rounded-lg px-4 py-3 text-blue-400 text-sm">
          <WifiOff className="h-4 w-4 animate-pulse" />
          <span>جاري إعادة الربط بالجلسة النشطة...</span>
        </div>
      )}

      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">عميل الأتمتة الذكي</h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            ذكاء اصطناعي يتحكم بمتصفح حقيقي · توقف وتدخّل في أي وقت
          </p>
        </div>
        <div className="flex items-center gap-2">
          {status === "running" && <Badge className="bg-blue-500/15 text-blue-400 border-blue-500/30 animate-pulse"><Cpu className="h-3 w-3 mr-1"/>يعمل</Badge>}
          {status === "paused"  && <Badge className="bg-blue-400/15 text-blue-300 border-blue-400/30"><Pause className="h-3 w-3 mr-1"/>مؤقت</Badge>}
          {status === "done"    && <Badge className="bg-primary/15 text-primary border-primary/30"><CheckCircle className="h-3 w-3 mr-1"/>اكتمل</Badge>}
          {status === "error"   && <Badge className="bg-destructive/15 text-destructive border-destructive/30"><XCircle className="h-3 w-3 mr-1"/>فشل</Badge>}
        </div>
      </div>

      {/* Config + preview row */}
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">

        {/* Config */}
        <Card className="bg-card border-border">
          <CardHeader className="border-b border-border pb-4">
            <CardTitle className="text-sm font-semibold flex items-center gap-2">
              <Bot className="h-4 w-4 text-primary"/>إعدادات المهمة
            </CardTitle>
          </CardHeader>
          <CardContent className="pt-4 space-y-4">

            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">الحساب</Label>
              <Select value={selectedAccountId} onValueChange={setSelectedAccountId} disabled={running}>
                <SelectTrigger className="bg-input border-border">
                  <SelectValue placeholder="اختر حساباً..." />
                </SelectTrigger>
                <SelectContent className="bg-card border-border">
                  {!accounts.data?.length && <SelectItem value="_" disabled>لا يوجد حسابات — أضف من Accounts</SelectItem>}
                  {accounts.data?.map((a) => (
                    <SelectItem key={a.id} value={String(a.id)}>{a.name} — {a.email}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {selectedAccount && (
              <div className="rounded-md bg-secondary/30 border border-border p-3 text-xs font-mono space-y-1">
                <div className="flex justify-between"><span className="text-muted-foreground">Email</span><span>{selectedAccount.email}</span></div>
                <div className="flex justify-between"><span className="text-muted-foreground">2FA</span><span className={selectedAccount.twofaSecret ? "text-primary" : ""}>{selectedAccount.twofaSecret ? "✓ مفعّل" : "غير مفعّل"}</span></div>
                <div className="flex justify-between"><span className="text-muted-foreground">الحالة</span><span className={selectedAccount.status === "active" ? "text-primary" : ""}>{selectedAccount.status}</span></div>
              </div>
            )}

            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">نوع المهمة</Label>
              <Select value={taskKind} onValueChange={(v) => setTaskKind(v as TaskKind)} disabled={running}>
                <SelectTrigger className="bg-input border-border">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="bg-card border-border">
                  <SelectItem value="login">تسجيل الدخول فقط</SelectItem>
                  <SelectItem value="create_bot">إنشاء بوت جديد</SelectItem>
                  <SelectItem value="reset_token">إعادة تعيين توكن بوت</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {taskKind === "create_bot" && (
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label className="text-xs text-muted-foreground">اسم البوت</Label>
                  <Input value={botName} onChange={(e) => setBotName(e.target.value)} disabled={running} className="bg-input border-border font-mono"/>
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs text-muted-foreground">البادئة</Label>
                  <Input value={botPrefix} onChange={(e) => setBotPrefix(e.target.value)} disabled={running} className="bg-input border-border font-mono"/>
                </div>
              </div>
            )}

            {taskKind === "reset_token" && (
              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground">App ID</Label>
                <Input value={appId} onChange={(e) => setAppId(e.target.value)} disabled={running} className="bg-input border-border font-mono" placeholder="1234567890123456789"/>
              </div>
            )}

            <div className="flex gap-2 pt-1">
              {!running ? (
                <Button onClick={handleStart} disabled={!selectedAccountId} className="flex-1 bg-primary text-black font-bold hover:bg-primary/90">
                  <Play className="h-4 w-4 mr-2"/>تشغيل العميل
                </Button>
              ) : (
                <>
                  {/* Pause / Resume button */}
                  {!isPaused ? (
                    <Button onClick={handlePause} variant="outline" className="flex-1 border-blue-500/50 text-blue-400 hover:bg-blue-500/10 font-bold">
                      <Pause className="h-4 w-4 mr-2"/>إيقاف مؤقت
                    </Button>
                  ) : (
                    <Button onClick={handleResume} variant="outline" className="flex-1 border-primary/50 text-primary hover:bg-primary/10 font-bold">
                      <PlayCircle className="h-4 w-4 mr-2"/>متابعة
                    </Button>
                  )}
                  <Button onClick={handleStop} variant="destructive" className="font-bold">
                    <Square className="h-4 w-4 mr-2"/>إيقاف
                  </Button>
                </>
              )}
              <Button variant="outline" onClick={() => { setLogs([]); setAgentShot(null); setStatus("idle"); setFinalMsg(""); }} disabled={running} className="border-border hover:bg-secondary">
                <RefreshCw className="h-4 w-4"/>
              </Button>
            </div>

            {finalMsg && (
              <div className={`rounded p-3 text-xs font-mono border break-all ${status === "done" ? "bg-primary/10 border-primary/30 text-primary" : "bg-destructive/10 border-destructive/30 text-destructive"}`}>
                {finalMsg}
              </div>
            )}
          </CardContent>
        </Card>

        {/* Live browser view */}
        <Card className="bg-card border-border">
          <CardHeader className="border-b border-border pb-4">
            <CardTitle className="text-sm font-semibold flex items-center gap-2">
              <Eye className="h-4 w-4 text-primary"/>نظرة المتصفح المباشرة
              {running && !isPaused && <span className="mr-auto text-[10px] text-blue-400 font-mono animate-pulse">● LIVE</span>}
              {isPaused && <span className="mr-auto text-[10px] text-blue-300 font-mono">⏸ مؤقت</span>}
            </CardTitle>
          </CardHeader>
          <CardContent className="pt-4">
            {displayShot ? (
              <div className="relative rounded-md overflow-hidden border border-border bg-black">
                <img
                  src={`data:image/jpeg;base64,${displayShot}`}
                  alt="Browser"
                  className="w-full h-auto block select-none"
                  draggable={false}
                />
                <div className="absolute top-2 right-2 flex items-center gap-1 bg-black/75 rounded px-2 py-0.5">
                  <div className={`h-1.5 w-1.5 rounded-full ${isPaused ? "bg-blue-300" : "bg-primary animate-pulse"}`}/>
                  <span className={`text-[10px] font-mono ${isPaused ? "text-blue-300" : "text-primary"}`}>{isPaused ? "PAUSED" : "LIVE"}</span>
                </div>
              </div>
            ) : (
              <div className="flex flex-col items-center justify-center h-52 rounded-md border border-dashed border-border text-muted-foreground">
                <Eye className="h-8 w-8 mb-2 opacity-30"/>
                <span className="text-sm">في انتظار بدء العميل...</span>
              </div>
            )}
            <p className="text-[10px] text-muted-foreground mt-2 text-center font-mono">
              سكرين شوت تلقائي · اضغط "إيقاف مؤقت" للتحكم الكامل بالمتصفح
            </p>
          </CardContent>
        </Card>
      </div>

      {/* Log */}
      <Card className="bg-card border-border">
        <CardHeader className="border-b border-border pb-3">
          <CardTitle className="text-sm font-semibold flex items-center gap-2">
            <Cpu className="h-4 w-4 text-primary"/>سجل النشاط
            <span className="mr-auto text-xs text-muted-foreground font-normal font-mono">{logs.length} حدث</span>
          </CardTitle>
        </CardHeader>
        <CardContent className="pt-0">
          <div className="h-52 overflow-y-auto font-mono text-xs p-3 space-y-0.5 bg-background/50 rounded border border-border">
            {!logs.length
              ? <div className="flex items-center justify-center h-full text-muted-foreground">لا يوجد نشاط</div>
              : logs.map((l) => (
                <div key={l.id} className="flex items-start gap-2 py-0.5">
                  <span className="text-muted-foreground/50 shrink-0 w-16">{l.time}</span>
                  {logIcon(l.level)}
                  <span className={logColor(l.level)}>{l.message}</span>
                </div>
              ))
            }
            <div ref={logsEndRef}/>
          </div>
        </CardContent>
      </Card>

      {/* ══════════════════════════════════════════════
          INTERACTIVE BROWSER DIALOG (captcha OR paused)
          ══════════════════════════════════════════════ */}
      <Dialog open={interactOpen} onOpenChange={() => {}}>
        <DialogContent className={`bg-card border-border max-w-3xl w-full p-0 gap-0`} data-testid="dialog-interact">
          <DialogHeader className="border-b border-border px-4 py-3">
            <DialogTitle className={`flex items-center gap-2 text-sm ${interactiveHeader.color}`}>
              {interactiveHeader.icon}
              {interactMode === "paused" ? "أنت في التحكم — تدخّل وحل المشكلة ثم اضغط متابعة" : "تدخّل مطلوب — حل الكابتشا"}
              <Badge className={`mr-auto bg-current/10 border-current/30 text-[10px] ${interactiveHeader.color}`}>
                {isDragging ? "⠿ جاري السحب..." : interactiveHeader.badge}
              </Badge>
            </DialogTitle>
          </DialogHeader>

          <div className="p-4 space-y-3">
            {interactMode === "captcha" && (
              <p className="text-xs text-center text-muted-foreground bg-secondary/30 border border-border rounded p-2">
                {captchaMsg}
              </p>
            )}
            {interactMode === "paused" && (
              <p className="text-xs text-center text-blue-400/80 bg-blue-500/5 border border-blue-500/20 rounded p-2">
                العميل متوقف — تصرّف يدوياً في المتصفح ثم اضغط <strong>متابعة الأتمتة</strong> ليكمل هو من مكانك
              </p>
            )}

            {/* LIVE INTERACTIVE IMAGE */}
            <div
              className={`relative rounded-md overflow-hidden border-2 bg-black select-none ${isDragging ? "border-blue-400/70" : interactiveHeader.borderColor}`}
              style={{ touchAction: "none" }}
            >
              {(liveShot ?? agentShot) ? (
                <div className="relative">
                  <img
                    ref={interactImgRef}
                    src={`data:image/jpeg;base64,${liveShot ?? agentShot}`}
                    alt="Live browser"
                    className="w-full h-auto block"
                    draggable={false}
                    style={{ cursor: isDragging ? "grabbing" : "crosshair", userSelect: "none" }}
                    onPointerDown={handlePointerDown}
                    onPointerMove={handlePointerMove}
                    onPointerUp={handlePointerUp}
                    onPointerLeave={handlePointerLeave}
                  />

                  {cursorPos && (
                    <div
                      className="absolute pointer-events-none rounded-full border-2 transition-none"
                      style={{
                        left: cursorPos.x - 8, top: cursorPos.y - 8,
                        width: 16, height: 16,
                        borderColor: isDragging ? "#60a5fa" : interactMode === "paused" ? "#60a5fa" : "#facc15",
                        boxShadow: isDragging ? "0 0 8px rgba(96,165,250,0.8)" : "0 0 8px rgba(250,204,21,0.7)",
                      }}
                    />
                  )}

                  {isDragging && dragStart && cursorPos && interactImgRef.current && (
                    <svg className="absolute inset-0 w-full h-full pointer-events-none" style={{ overflow: "visible" }}>
                      <line
                        x1={(dragStart.x / BW) * interactImgRef.current.clientWidth}
                        y1={(dragStart.y / BH) * interactImgRef.current.clientHeight}
                        x2={cursorPos.x} y2={cursorPos.y}
                        stroke="#60a5fa" strokeWidth="2" strokeDasharray="4 2" opacity="0.7"
                      />
                    </svg>
                  )}

                  {busy && !isDragging && (
                    <div className="absolute inset-0 bg-black/20 flex items-center justify-center pointer-events-none">
                      <span className={`text-xs font-mono animate-pulse ${interactMode === "paused" ? "text-blue-400" : "text-yellow-400"}`}>ينفذ...</span>
                    </div>
                  )}

                  <div className="absolute top-2 right-2 flex items-center gap-1 bg-black/75 rounded px-2 py-0.5">
                    <div className={`h-1.5 w-1.5 rounded-full animate-pulse ${interactMode === "paused" ? "bg-blue-400" : "bg-yellow-400"}`}/>
                    <span className={`text-[10px] font-mono ${interactMode === "paused" ? "text-blue-400" : "text-yellow-400"}`}>
                      {isDragging ? "DRAG" : "LIVE"}
                    </span>
                  </div>

                  {cursorPos && interactImgRef.current && (
                    <div className="absolute bottom-2 left-2 bg-black/75 rounded px-2 py-0.5 font-mono text-[10px] text-yellow-400">
                      {Math.round((cursorPos.x / interactImgRef.current.clientWidth) * BW)}
                      {" , "}
                      {Math.round((cursorPos.y / interactImgRef.current.clientHeight) * BH)}
                    </div>
                  )}
                </div>
              ) : (
                <div className="flex items-center justify-center h-40 text-muted-foreground text-sm">
                  جاري تحميل الصفحة...
                </div>
              )}
            </div>

            <p className="text-[10px] text-muted-foreground text-center font-mono">
              انقر للضغط · اضغط واسحب لتحريك السلايدر · الإحداثيات دقيقة 1:1 مع المتصفح
            </p>

            {/* Controls */}
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground flex items-center gap-1">
                  <Keyboard className="h-3 w-3"/>كتابة نص
                </Label>
                <div className="flex gap-2">
                  <Input
                    value={typeText}
                    onChange={(e) => setTypeText(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter") handleType(); }}
                    placeholder="اكتب ثم Enter..."
                    className="bg-input border-border font-mono text-xs flex-1"
                    dir="ltr"
                  />
                  <Button size="sm" onClick={handleType} disabled={!typeText || busy} className="bg-primary text-black hover:bg-primary/90 shrink-0">
                    <CornerDownLeft className="h-3 w-3"/>
                  </Button>
                </div>
              </div>

              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground flex items-center gap-1">
                  <MousePointer className="h-3 w-3"/>مفاتيح سريعة
                </Label>
                <div className="flex flex-wrap gap-1.5">
                  {[
                    { label: "Enter ↵", key: "Enter" },
                    { label: "Tab",     key: "Tab" },
                    { label: "Esc",     key: "Escape" },
                    { label: "⌫",       key: "Backspace" },
                    { label: "Space",   key: "Space" },
                  ].map(({ label, key }) => (
                    <Button key={key} size="sm" variant="outline" onClick={() => handleKey(key)} disabled={busy}
                      className="border-border hover:bg-secondary text-xs font-mono h-7 px-2.5">
                      {label}
                    </Button>
                  ))}
                </div>
              </div>
            </div>

            <div className="flex gap-3 pt-1">
              {interactMode === "captcha" ? (
                <Button onClick={handleCaptchaDone} className="flex-1 bg-primary text-black font-bold hover:bg-primary/90">
                  <CheckCircle className="h-4 w-4 mr-2"/>تم — متابعة الأتمتة
                </Button>
              ) : (
                <Button onClick={handleResume} className="flex-1 bg-blue-500 text-white font-bold hover:bg-blue-600">
                  <PlayCircle className="h-4 w-4 mr-2"/>متابعة الأتمتة
                </Button>
              )}
              <Button variant="destructive" onClick={handleStop} className="font-bold">
                <Square className="h-4 w-4 mr-2"/>إيقاف نهائي
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
