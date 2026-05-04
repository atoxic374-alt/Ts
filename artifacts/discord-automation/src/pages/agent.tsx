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
} from "lucide-react";

// Browser virtual size (must match Playwright viewport)
const BW = 1280;
const BH = 800;

type AgentEvent =
  | { type: "session_id"; sessionId: string }
  | { type: "log"; message: string; level: "info" | "warn" | "error" | "success" }
  | { type: "screenshot"; data: string }
  | { type: "captcha"; message: string }
  | { type: "captcha_solved" }
  | { type: "action"; action: string; detail?: string }
  | { type: "done"; success: boolean; message: string }
  | { type: "error"; message: string };

type LogEntry = { id: number; message: string; level: "info" | "warn" | "error" | "success" | "action"; time: string };
type TaskKind = "login" | "create_bot" | "reset_token";

function ts() {
  const n = new Date();
  return `${n.getHours().toString().padStart(2, "0")}:${n.getMinutes().toString().padStart(2, "0")}:${n.getSeconds().toString().padStart(2, "0")}`;
}

/** Map a click on the displayed image → browser coordinates */
function imgToBrowser(el: HTMLImageElement, clientX: number, clientY: number): { x: number; y: number } {
  const rect = el.getBoundingClientRect();
  const relX = (clientX - rect.left) / rect.width;
  const relY = (clientY - rect.top) / rect.height;
  return { x: Math.round(relX * BW), y: Math.round(relY * BH) };
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
  const [captchaOpen, setCaptchaOpen] = useState(false);
  const [captchaMsg, setCaptchaMsg] = useState("");
  const [typeText, setTypeText] = useState("");
  const [status, setStatus] = useState<"idle" | "running" | "done" | "error">("idle");
  const [finalMsg, setFinalMsg] = useState("");
  const [cursorPos, setCursorPos] = useState<{ x: number; y: number } | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [dragStart, setDragStart] = useState<{ x: number; y: number } | null>(null);
  const [busy, setBusy] = useState(false);

  const logsEndRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const captchaImgRef = useRef<HTMLImageElement>(null);   // only for the captcha dialog
  const logId = useRef(0);
  const lastMoveRef = useRef(0);               // throttle mousemove sends
  const sessionIdRef = useRef<string | null>(null);

  // Keep ref in sync so pointer handlers can read it without stale closure
  useEffect(() => { sessionIdRef.current = sessionId; }, [sessionId]);

  useEffect(() => { logsEndRef.current?.scrollIntoView({ behavior: "smooth" }); }, [logs]);

  // Poll screenshot every 400ms while captcha is open
  useEffect(() => {
    if (captchaOpen && sessionId) {
      const poll = async () => {
        try {
          const r = await fetch(`/api/agent/screenshot/${sessionId}`);
          if (r.ok) { const d = await r.json() as { screenshot: string }; setLiveShot(d.screenshot); }
        } catch {}
      };
      poll();
      pollRef.current = setInterval(poll, 400);
    } else {
      if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
    }
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [captchaOpen, sessionId]);

  const addLog = useCallback((message: string, level: LogEntry["level"]) => {
    logId.current += 1;
    setLogs((p) => [...p.slice(-299), { id: logId.current, message, level, time: ts() }]);
  }, []);

  // Core send — returns screenshot embedded in the response
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

  // ── Pointer events for the captcha image (click + drag) ──────────────────

  const handlePointerDown = useCallback(async (e: React.PointerEvent<HTMLImageElement>) => {
    if (!captchaImgRef.current) return;
    e.currentTarget.setPointerCapture(e.pointerId);  // keep events even if cursor leaves img
    const { x, y } = imgToBrowser(e.currentTarget, e.clientX, e.clientY);
    setIsDragging(false);
    setDragStart({ x, y });
    setCursorPos({ x: e.clientX - e.currentTarget.getBoundingClientRect().left, y: e.clientY - e.currentTarget.getBoundingClientRect().top });
    setBusy(true);
    await send({ type: "mousedown", x, y });
  }, [send]);

  const handlePointerMove = useCallback(async (e: React.PointerEvent<HTMLImageElement>) => {
    if (!captchaImgRef.current) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const lx = e.clientX - rect.left;
    const ly = e.clientY - rect.top;
    setCursorPos({ x: lx, y: ly });

    if (e.buttons !== 1) return;   // only while pressed

    // Mark as dragging if moved more than 4px from start
    const { x, y } = imgToBrowser(e.currentTarget, e.clientX, e.clientY);
    if (dragStart && (Math.abs(x - dragStart.x) > 4 || Math.abs(y - dragStart.y) > 4)) {
      setIsDragging(true);
    }

    // Throttle mousemove to ~30fps max to avoid flooding
    const now = Date.now();
    if (now - lastMoveRef.current < 33) return;
    lastMoveRef.current = now;
    await send({ type: "mousemove", x, y }, true);  // silent — no screenshot on every move
  }, [send, dragStart]);

  const handlePointerUp = useCallback(async (e: React.PointerEvent<HTMLImageElement>) => {
    if (!captchaImgRef.current) return;
    const { x, y } = imgToBrowser(e.currentTarget, e.clientX, e.clientY);

    if (!isDragging && dragStart) {
      // It was a click — use precise click action (not drag)
      addLog(`نقر: (${x}, ${y})`, "action");
      await send({ type: "click", x, y });
    } else if (isDragging) {
      // End of drag
      addLog(`سحب: (${dragStart?.x ?? x},${dragStart?.y ?? y}) → (${x},${y})`, "action");
      await send({ type: "mouseup", x, y });
    }

    setIsDragging(false);
    setDragStart(null);
    setBusy(false);
  }, [send, isDragging, dragStart, addLog]);

  const handlePointerLeave = useCallback(async (e: React.PointerEvent<HTMLImageElement>) => {
    setCursorPos(null);
    // If dragging and pointer leaves, release
    if (isDragging && e.buttons === 1) {
      const { x, y } = imgToBrowser(e.currentTarget, e.clientX, e.clientY);
      await send({ type: "mouseup", x, y });
      setIsDragging(false);
      setDragStart(null);
      setBusy(false);
    }
  }, [send, isDragging]);

  const handleType = useCallback(async () => {
    if (!typeText || !sessionId || busy) return;
    addLog(`كتابة: ${typeText}`, "action");
    setBusy(true);
    await send({ type: "type", text: typeText });
    setTypeText("");
    setBusy(false);
  }, [typeText, sessionId, busy, send, addLog]);

  const handleKey = useCallback(async (key: string) => {
    if (!sessionId || busy) return;
    addLog(`مفتاح: ${key}`, "action");
    setBusy(true);
    await send({ type: "key", key });
    setBusy(false);
  }, [sessionId, busy, send, addLog]);

  // ── Start agent ──────────────────────────────────────────────────────────

  const handleStart = async () => {
    if (!selectedAccountId) return;
    const acc = accounts.data?.find((a) => a.id === Number(selectedAccountId));
    if (!acc) return;

    setLogs([]); setAgentShot(null); setLiveShot(null);
    setRunning(true); setStatus("running"); setFinalMsg("");
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
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const parts = buf.split("\n\n");
        buf = parts.pop() ?? "";
        for (const part of parts) {
          const line = part.trim();
          if (!line.startsWith("data:")) continue;
          try { onEvent(JSON.parse(line.slice(5).trim()) as AgentEvent); } catch {}
        }
      }
    } catch (err) {
      if ((err as Error).name !== "AbortError") addLog("انقطع الاتصال", "error");
    } finally {
      setRunning(false);
    }
  };

  const onEvent = (ev: AgentEvent) => {
    switch (ev.type) {
      case "session_id":   setSessionId(ev.sessionId); sessionIdRef.current = ev.sessionId; addLog(`جلسة: ${ev.sessionId}`, "info"); break;
      case "log":          addLog(ev.message, ev.level); break;
      case "screenshot":   setAgentShot(ev.data); break;
      case "action":       addLog(`[${ev.action.toUpperCase()}] ${ev.detail ?? ""}`, "action"); break;
      case "captcha":
        setCaptchaMsg(ev.message);
        setCaptchaOpen(true);
        addLog("توقف — حل الكابتشا", "warn");
        break;
      case "captcha_solved":
        setCaptchaOpen(false); setLiveShot(null);
        addLog("تم — استمرار التنفيذ", "success");
        break;
      case "done":
        setStatus(ev.success ? "done" : "error");
        setFinalMsg(ev.message);
        addLog(ev.message, ev.success ? "success" : "error");
        setRunning(false); setCaptchaOpen(false);
        break;
      case "error":
        setStatus("error"); setFinalMsg(ev.message);
        addLog(ev.message, "error"); setRunning(false);
        break;
    }
  };

  const handleStop = async () => {
    abortRef.current?.abort();
    await fetch("/api/agent/stop", { method: "POST" }).catch(() => {});
    setRunning(false); setStatus("idle"); setCaptchaOpen(false);
    addLog("أُوقف العميل", "warn");
  };

  const handleCaptchaDone = async () => {
    if (!sessionId) return;
    await fetch(`/api/agent/captcha-solved/${sessionId}`, { method: "POST" }).catch(() => {});
    setCaptchaOpen(false); setLiveShot(null);
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

  const displayShot = captchaOpen ? (liveShot ?? agentShot) : agentShot;
  const selectedAccount = accounts.data?.find((a) => a.id === Number(selectedAccountId));

  return (
    <div className="space-y-6" dir="rtl">

      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">عميل الأتمتة الذكي</h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            ذكاء اصطناعي يتحكم بمتصفح حقيقي · تحكّم كامل بالماوس عند الحاجة
          </p>
        </div>
        <div className="flex items-center gap-2">
          {status === "running" && <Badge className="bg-blue-500/15 text-blue-400 border-blue-500/30 animate-pulse"><Cpu className="h-3 w-3 mr-1"/>يعمل</Badge>}
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
              <Select value={selectedAccountId} onValueChange={setSelectedAccountId}>
                <SelectTrigger className="bg-input border-border" data-testid="select-account">
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
              <Select value={taskKind} onValueChange={(v) => setTaskKind(v as TaskKind)}>
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
                  <Input value={botName} onChange={(e) => setBotName(e.target.value)} className="bg-input border-border font-mono"/>
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs text-muted-foreground">البادئة</Label>
                  <Input value={botPrefix} onChange={(e) => setBotPrefix(e.target.value)} className="bg-input border-border font-mono"/>
                </div>
              </div>
            )}

            {taskKind === "reset_token" && (
              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground">App ID</Label>
                <Input value={appId} onChange={(e) => setAppId(e.target.value)} className="bg-input border-border font-mono" placeholder="1234567890123456789"/>
              </div>
            )}

            <div className="flex gap-2 pt-1">
              {!running ? (
                <Button onClick={handleStart} disabled={!selectedAccountId} className="flex-1 bg-primary text-black font-bold hover:bg-primary/90">
                  <Play className="h-4 w-4 mr-2"/>تشغيل العميل
                </Button>
              ) : (
                <Button onClick={handleStop} variant="destructive" className="flex-1 font-bold">
                  <Square className="h-4 w-4 mr-2"/>إيقاف
                </Button>
              )}
              <Button variant="outline" onClick={() => { setLogs([]); setAgentShot(null); setStatus("idle"); setFinalMsg(""); }} className="border-border hover:bg-secondary">
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
              {running && <span className="mr-auto text-[10px] text-blue-400 font-mono animate-pulse">● LIVE</span>}
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
                  <div className="h-1.5 w-1.5 rounded-full bg-primary animate-pulse"/>
                  <span className="text-[10px] font-mono text-primary">LIVE</span>
                </div>
              </div>
            ) : (
              <div className="flex flex-col items-center justify-center h-52 rounded-md border border-dashed border-border text-muted-foreground">
                <Eye className="h-8 w-8 mb-2 opacity-30"/>
                <span className="text-sm">في انتظار بدء العميل...</span>
              </div>
            )}
            <p className="text-[10px] text-muted-foreground mt-2 text-center font-mono">
              سكرين شوت تلقائي · تحكّم كامل عند ظهور الكابتشا
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
          CAPTCHA INTERACTIVE DIALOG
          ══════════════════════════════════════════════ */}
      <Dialog open={captchaOpen} onOpenChange={() => {}}>
        <DialogContent className="bg-card border-border max-w-3xl w-full p-0 gap-0" data-testid="dialog-captcha">
          <DialogHeader className="border-b border-border px-4 py-3">
            <DialogTitle className="flex items-center gap-2 text-yellow-400 text-sm">
              <AlertTriangle className="h-4 w-4"/>
              تدخّل مطلوب
              <Badge className="mr-auto bg-yellow-400/10 text-yellow-400 border-yellow-400/30 text-[10px]">
                {isDragging ? "⠿ جاري السحب..." : "انقر أو اسحب على الصفحة"}
              </Badge>
            </DialogTitle>
          </DialogHeader>

          <div className="p-4 space-y-3">
            <p className="text-xs text-center text-muted-foreground bg-secondary/30 border border-border rounded p-2">
              {captchaMsg}
            </p>

            {/* ── LIVE INTERACTIVE IMAGE ── */}
            <div
              className={`relative rounded-md overflow-hidden border-2 bg-black select-none ${isDragging ? "border-blue-400/70" : "border-yellow-400/50"}`}
              style={{ touchAction: "none" }}
            >
              {(liveShot ?? agentShot) ? (
                <div className="relative">
                  <img
                    ref={captchaImgRef}
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

                  {/* Custom cursor dot */}
                  {cursorPos && (
                    <div
                      className="absolute pointer-events-none rounded-full border-2 transition-none"
                      style={{
                        left: cursorPos.x - 8,
                        top: cursorPos.y - 8,
                        width: 16, height: 16,
                        borderColor: isDragging ? "#60a5fa" : "#facc15",
                        boxShadow: isDragging ? "0 0 8px rgba(96,165,250,0.8)" : "0 0 8px rgba(250,204,21,0.7)",
                      }}
                    />
                  )}

                  {/* Drag trail line (visual) */}
                  {isDragging && dragStart && cursorPos && captchaImgRef.current && (
                    <svg
                      className="absolute inset-0 w-full h-full pointer-events-none"
                      style={{ overflow: "visible" }}
                    >
                      <line
                        x1={(dragStart.x / BW) * captchaImgRef.current.clientWidth}
                        y1={(dragStart.y / BH) * captchaImgRef.current.clientHeight}
                        x2={cursorPos.x}
                        y2={cursorPos.y}
                        stroke="#60a5fa"
                        strokeWidth="2"
                        strokeDasharray="4 2"
                        opacity="0.7"
                      />
                    </svg>
                  )}

                  {/* Busy overlay */}
                  {busy && !isDragging && (
                    <div className="absolute inset-0 bg-black/20 flex items-center justify-center pointer-events-none">
                      <span className="text-yellow-400 text-xs font-mono animate-pulse">ينفذ...</span>
                    </div>
                  )}

                  {/* Status chip */}
                  <div className="absolute top-2 right-2 flex items-center gap-1 bg-black/75 rounded px-2 py-0.5">
                    <div className={`h-1.5 w-1.5 rounded-full animate-pulse ${isDragging ? "bg-blue-400" : "bg-yellow-400"}`}/>
                    <span className={`text-[10px] font-mono ${isDragging ? "text-blue-400" : "text-yellow-400"}`}>
                      {isDragging ? "DRAG" : "LIVE"}
                    </span>
                  </div>

                  {/* Coords */}
                  {cursorPos && captchaImgRef.current && (
                    <div className="absolute bottom-2 left-2 bg-black/75 rounded px-2 py-0.5 font-mono text-[10px] text-yellow-400">
                      {Math.round((cursorPos.x / captchaImgRef.current.clientWidth) * BW)}
                      {" , "}
                      {Math.round((cursorPos.y / captchaImgRef.current.clientHeight) * BH)}
                    </div>
                  )}
                </div>
              ) : (
                <div className="flex items-center justify-center h-40 text-muted-foreground text-sm">
                  جاري تحميل الصفحة...
                </div>
              )}
            </div>

            {/* Hint */}
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
              <Button onClick={handleCaptchaDone} className="flex-1 bg-primary text-black font-bold hover:bg-primary/90">
                <CheckCircle className="h-4 w-4 mr-2"/>تم — متابعة الأتمتة
              </Button>
              <Button variant="destructive" onClick={handleStop} className="font-bold">
                <Square className="h-4 w-4 mr-2"/>إيقاف
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
