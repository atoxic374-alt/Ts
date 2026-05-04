import { useState, useRef, useEffect, useCallback } from "react";
import { useListAccounts } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  Bot, Play, Square, RefreshCw, AlertTriangle, CheckCircle,
  XCircle, Info, Eye, Cpu, MousePointer, Keyboard, CornerDownLeft,
} from "lucide-react";

// ─── Types ────────────────────────────────────────────────────────────────────
type AgentEvent =
  | { type: "session_id"; sessionId: string }
  | { type: "log"; message: string; level: "info" | "warn" | "error" | "success" }
  | { type: "screenshot"; data: string }
  | { type: "captcha"; message: string }
  | { type: "captcha_pending"; sessionId: string }
  | { type: "captcha_solved" }
  | { type: "action"; action: string; detail?: string }
  | { type: "done"; success: boolean; message: string }
  | { type: "error"; message: string };

type LogEntry = { id: number; message: string; level: "info" | "warn" | "error" | "success" | "action"; time: string };
type TaskKind = "login" | "create_bot" | "reset_token";

// ─── Helpers ──────────────────────────────────────────────────────────────────
function ts() {
  const n = new Date();
  return `${n.getHours().toString().padStart(2,"0")}:${n.getMinutes().toString().padStart(2,"0")}:${n.getSeconds().toString().padStart(2,"0")}`;
}

// ─── Component ────────────────────────────────────────────────────────────────
export default function Agent() {
  const accounts = useListAccounts();

  // Config state
  const [selectedAccountId, setSelectedAccountId] = useState("");
  const [taskKind, setTaskKind] = useState<TaskKind>("login");
  const [botName, setBotName] = useState("My Bot");
  const [botPrefix, setBotPrefix] = useState("!");
  const [appId, setAppId] = useState("");

  // Runtime state
  const [running, setRunning] = useState(false);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [agentShot, setAgentShot] = useState<string | null>(null);   // from SSE during AI run
  const [liveShot, setLiveShot] = useState<string | null>(null);     // from polling during captcha
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [captchaOpen, setCaptchaOpen] = useState(false);
  const [captchaMsg, setCaptchaMsg] = useState("");
  const [typeText, setTypeText] = useState("");
  const [status, setStatus] = useState<"idle" | "running" | "done" | "error">("idle");
  const [finalMsg, setFinalMsg] = useState("");
  const [cursorPos, setCursorPos] = useState<{ x: number; y: number } | null>(null); // visual cursor on img
  const [busy, setBusy] = useState(false); // while interaction in flight

  const logsEndRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const logId = useRef(0);

  // Auto-scroll log
  useEffect(() => { logsEndRef.current?.scrollIntoView({ behavior: "smooth" }); }, [logs]);

  // ── Polling: live screenshot every 450ms while captcha open ───────────────
  useEffect(() => {
    if (captchaOpen && sessionId) {
      const poll = async () => {
        try {
          const r = await fetch(`/api/agent/screenshot/${sessionId}`);
          if (r.ok) { const d = await r.json() as { screenshot: string }; setLiveShot(d.screenshot); }
        } catch {}
      };
      poll();                                           // immediate first fetch
      pollRef.current = setInterval(poll, 450);
    } else {
      if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
    }
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [captchaOpen, sessionId]);

  // ── Log helper ────────────────────────────────────────────────────────────
  const addLog = useCallback((message: string, level: LogEntry["level"]) => {
    logId.current += 1;
    setLogs((p) => [...p.slice(-299), { id: logId.current, message, level, time: ts() }]);
  }, []);

  // ── Interact: send action → get screenshot back in same response ──────────
  const interact = useCallback(async (action: object): Promise<string | null> => {
    if (!sessionId) return null;
    setBusy(true);
    try {
      const r = await fetch(`/api/agent/interact/${sessionId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
      if (!r.ok) return null;
      const d = await r.json() as { success: boolean; screenshot: string | null };
      if (d.screenshot) setLiveShot(d.screenshot);
      return d.screenshot ?? null;
    } catch { return null; }
    finally { setBusy(false); }
  }, [sessionId]);

  // ── Click on screenshot → forward to real browser mouse ──────────────────
  const handleImgClick = useCallback(async (e: React.MouseEvent<HTMLImageElement>) => {
    if (!sessionId || !imgRef.current || busy) return;
    const rect = imgRef.current.getBoundingClientRect();
    const relX = (e.clientX - rect.left) / rect.width;
    const relY = (e.clientY - rect.top) / rect.height;
    const bx = Math.round(relX * 1280);
    const by = Math.round(relY * 800);
    addLog(`نقر على (${bx}, ${by})`, "action");
    await interact({ type: "click", x: bx, y: by });
  }, [sessionId, busy, interact, addLog]);

  // Track cursor position on image for visual indicator
  const handleImgMouseMove = useCallback((e: React.MouseEvent<HTMLImageElement>) => {
    if (!imgRef.current) return;
    const rect = imgRef.current.getBoundingClientRect();
    setCursorPos({ x: e.clientX - rect.left, y: e.clientY - rect.top });
  }, []);

  const handleImgMouseLeave = useCallback(() => setCursorPos(null), []);

  // ── Type text ─────────────────────────────────────────────────────────────
  const handleType = useCallback(async () => {
    if (!typeText || !sessionId || busy) return;
    addLog(`كتابة: ${typeText}`, "action");
    await interact({ type: "type", text: typeText });
    setTypeText("");
  }, [typeText, sessionId, busy, interact, addLog]);

  // ── Key press ─────────────────────────────────────────────────────────────
  const handleKey = useCallback(async (key: string) => {
    if (!sessionId || busy) return;
    addLog(`مفتاح: ${key}`, "action");
    await interact({ type: "key", key });
  }, [sessionId, busy, interact, addLog]);

  // ── Start agent session ───────────────────────────────────────────────────
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
      case "session_id":   setSessionId(ev.sessionId); addLog(`جلسة: ${ev.sessionId}`, "info"); break;
      case "log":          addLog(ev.message, ev.level); break;
      case "screenshot":   setAgentShot(ev.data); break;
      case "action":       addLog(`[${ev.action.toUpperCase()}] ${ev.detail ?? ""}`, "action"); break;
      case "captcha":
        setCaptchaMsg(ev.message);
        setCaptchaOpen(true);
        addLog("توقف — تدخّل لحل الكابتشا", "warn");
        break;
      case "captcha_solved":
        setCaptchaOpen(false);
        setLiveShot(null);
        addLog("تم الحل — استمرار التنفيذ", "success");
        break;
      case "done":
        setStatus(ev.success ? "done" : "error");
        setFinalMsg(ev.message);
        addLog(ev.message, ev.success ? "success" : "error");
        setRunning(false);
        setCaptchaOpen(false);
        break;
      case "error":
        setStatus("error");
        setFinalMsg(ev.message);
        addLog(ev.message, "error");
        setRunning(false);
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
    addLog("متابعة — إرسال إشارة للعميل", "success");
  };

  // ── Log icons / colours ───────────────────────────────────────────────────
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

  // ── Shared interactive browser view ──────────────────────────────────────
  const BrowserView = ({
    src, clickable, label,
  }: { src: string | null; clickable?: boolean; label: string }) => (
    <div className="relative rounded-md overflow-hidden border-2 border-yellow-400/40 bg-black">
      {src ? (
        <div className="relative">
          <img
            ref={imgRef}
            src={`data:image/jpeg;base64,${src}`}
            alt="Browser"
            className={`w-full h-auto block select-none ${clickable ? "cursor-crosshair" : ""}`}
            draggable={false}
            onClick={clickable ? handleImgClick : undefined}
            onMouseMove={clickable ? handleImgMouseMove : undefined}
            onMouseLeave={clickable ? handleImgMouseLeave : undefined}
            data-testid="img-browser"
          />
          {/* Visual cursor dot */}
          {clickable && cursorPos && (
            <div
              className="absolute pointer-events-none w-4 h-4 rounded-full border-2 border-primary"
              style={{ left: cursorPos.x - 8, top: cursorPos.y - 8, boxShadow: "0 0 6px #00ff88" }}
            />
          )}
          {/* Busy overlay */}
          {busy && (
            <div className="absolute inset-0 bg-black/30 flex items-center justify-center">
              <div className="text-primary text-xs font-mono animate-pulse">ينفذ...</div>
            </div>
          )}
          {/* Status badge */}
          <div className="absolute top-2 right-2 flex items-center gap-1 bg-black/75 rounded px-2 py-0.5">
            <div className={`h-1.5 w-1.5 rounded-full ${captchaOpen ? "bg-yellow-400" : "bg-primary"} animate-pulse`} />
            <span className={`text-[10px] font-mono ${captchaOpen ? "text-yellow-400" : "text-primary"}`}>{label}</span>
          </div>
        </div>
      ) : (
        <div className="flex flex-col items-center justify-center h-52 text-muted-foreground">
          <Eye className="h-8 w-8 mb-2 opacity-30" />
          <span className="text-sm">في انتظار بدء العميل...</span>
        </div>
      )}
    </div>
  );

  const selectedAccount = accounts.data?.find((a) => a.id === Number(selectedAccountId));
  const displayShot = captchaOpen ? (liveShot ?? agentShot) : agentShot;

  // ─────────────────────────────────────────────────────────────────────────
  return (
    <div className="space-y-6" dir="rtl">

      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">عميل الأتمتة الذكي</h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            ذكاء اصطناعي يتحكم بمتصفح حقيقي · ماوس البراوزر الفعلي · تدخّل متى تريد
          </p>
        </div>
        <div className="flex items-center gap-2">
          {status === "running" && <Badge className="bg-blue-500/15 text-blue-400 border-blue-500/30 animate-pulse"><Cpu className="h-3 w-3 mr-1"/>يعمل</Badge>}
          {status === "done"    && <Badge className="bg-primary/15 text-primary border-primary/30"><CheckCircle className="h-3 w-3 mr-1"/>اكتمل</Badge>}
          {status === "error"   && <Badge className="bg-destructive/15 text-destructive border-destructive/30"><XCircle className="h-3 w-3 mr-1"/>فشل</Badge>}
        </div>
      </div>

      {/* Main grid */}
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">

        {/* Config */}
        <Card className="bg-card border-border">
          <CardHeader className="border-b border-border pb-4">
            <CardTitle className="text-sm font-semibold flex items-center gap-2">
              <Bot className="h-4 w-4 text-primary"/>إعدادات المهمة
            </CardTitle>
          </CardHeader>
          <CardContent className="pt-4 space-y-4">

            {/* Account picker */}
            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">الحساب</Label>
              <Select value={selectedAccountId} onValueChange={setSelectedAccountId}>
                <SelectTrigger className="bg-input border-border" data-testid="select-account">
                  <SelectValue placeholder="اختر حساباً..." />
                </SelectTrigger>
                <SelectContent className="bg-card border-border">
                  {!accounts.data?.length && (
                    <SelectItem value="_empty" disabled>لا يوجد حسابات — أضف من صفحة Accounts</SelectItem>
                  )}
                  {accounts.data?.map((a) => (
                    <SelectItem key={a.id} value={String(a.id)}>{a.name} — {a.email}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {/* Account summary */}
            {selectedAccount && (
              <div className="rounded-md bg-secondary/30 border border-border p-3 text-xs font-mono space-y-1">
                <div className="flex justify-between"><span className="text-muted-foreground">Email</span><span>{selectedAccount.email}</span></div>
                <div className="flex justify-between"><span className="text-muted-foreground">2FA</span><span className={selectedAccount.twofaSecret ? "text-primary" : "text-muted-foreground"}>{selectedAccount.twofaSecret ? "✓ مفعّل" : "غير مفعّل"}</span></div>
                <div className="flex justify-between"><span className="text-muted-foreground">الحالة</span><span className={selectedAccount.status === "active" ? "text-primary" : ""}>{selectedAccount.status}</span></div>
              </div>
            )}

            {/* Task kind */}
            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">نوع المهمة</Label>
              <Select value={taskKind} onValueChange={(v) => setTaskKind(v as TaskKind)}>
                <SelectTrigger className="bg-input border-border" data-testid="select-task">
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
                  <Input value={botName} onChange={(e) => setBotName(e.target.value)} className="bg-input border-border font-mono" data-testid="input-bot-name"/>
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs text-muted-foreground">البادئة</Label>
                  <Input value={botPrefix} onChange={(e) => setBotPrefix(e.target.value)} className="bg-input border-border font-mono" data-testid="input-prefix"/>
                </div>
              </div>
            )}

            {taskKind === "reset_token" && (
              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground">App ID</Label>
                <Input value={appId} onChange={(e) => setAppId(e.target.value)} className="bg-input border-border font-mono" placeholder="1234567890123456789" data-testid="input-app-id"/>
              </div>
            )}

            {/* Actions */}
            <div className="flex gap-2 pt-1">
              {!running ? (
                <Button onClick={handleStart} disabled={!selectedAccountId} className="flex-1 bg-primary text-black font-bold hover:bg-primary/90" data-testid="button-start">
                  <Play className="h-4 w-4 mr-2"/>تشغيل العميل
                </Button>
              ) : (
                <Button onClick={handleStop} variant="destructive" className="flex-1 font-bold" data-testid="button-stop">
                  <Square className="h-4 w-4 mr-2"/>إيقاف
                </Button>
              )}
              <Button variant="outline" onClick={() => { setLogs([]); setAgentShot(null); setStatus("idle"); setFinalMsg(""); }} className="border-border hover:bg-secondary" data-testid="button-clear">
                <RefreshCw className="h-4 w-4"/>
              </Button>
            </div>

            {/* Result message */}
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
            <BrowserView src={displayShot} label={captchaOpen ? "وضع التحكم اليدوي" : "LIVE"} />
            <p className="text-[10px] text-muted-foreground mt-2 text-center font-mono">
              السكرين شوت يتحدث تلقائياً · التفاعل متاح عند ظهور كابتشا
            </p>
          </CardContent>
        </Card>
      </div>

      {/* Activity log */}
      <Card className="bg-card border-border">
        <CardHeader className="border-b border-border pb-3">
          <CardTitle className="text-sm font-semibold flex items-center gap-2">
            <Cpu className="h-4 w-4 text-primary"/>سجل النشاط
            <span className="mr-auto text-xs text-muted-foreground font-normal font-mono">{logs.length} حدث</span>
          </CardTitle>
        </CardHeader>
        <CardContent className="pt-0">
          <div className="h-52 overflow-y-auto font-mono text-xs p-3 space-y-0.5 bg-background/50 rounded border border-border" data-testid="div-log">
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

      {/* ═══════════════════════════════════════════════════════════════
          INTERACTIVE CAPTCHA / VERIFICATION DIALOG
          ═══════════════════════════════════════════════════════════════ */}
      <Dialog open={captchaOpen} onOpenChange={() => {}}>
        <DialogContent className="bg-card border-border max-w-3xl w-full p-0 gap-0" data-testid="dialog-captcha">
          <DialogHeader className="border-b border-border px-4 py-3">
            <DialogTitle className="flex items-center gap-2 text-yellow-400 text-sm">
              <AlertTriangle className="h-4 w-4"/>
              تدخّل مطلوب — تحكّم بالمتصفح مباشرة
              <Badge className="mr-auto bg-yellow-400/10 text-yellow-400 border-yellow-400/30 text-[10px]">
                وضع التحكم اليدوي
              </Badge>
            </DialogTitle>
          </DialogHeader>

          <div className="p-4 space-y-3">
            {/* Message */}
            <p className="text-xs text-center text-muted-foreground bg-secondary/30 border border-border rounded p-2">
              {captchaMsg}
            </p>

            {/* LIVE clickable browser */}
            <div
              className="relative rounded-md overflow-hidden border-2 border-yellow-400/50 bg-black cursor-crosshair"
              data-testid="div-captcha-browser"
            >
              {(liveShot ?? agentShot) ? (
                <div className="relative">
                  <img
                    ref={imgRef}
                    src={`data:image/jpeg;base64,${liveShot ?? agentShot}`}
                    alt="Live browser"
                    className="w-full h-auto block select-none cursor-crosshair"
                    draggable={false}
                    onClick={handleImgClick}
                    onMouseMove={handleImgMouseMove}
                    onMouseLeave={handleImgMouseLeave}
                    data-testid="img-captcha"
                  />
                  {/* Cursor dot */}
                  {cursorPos && (
                    <div
                      className="absolute pointer-events-none rounded-full border-2 border-yellow-400"
                      style={{ left: cursorPos.x - 8, top: cursorPos.y - 8, width: 16, height: 16, boxShadow: "0 0 8px rgba(250,204,21,0.7)" }}
                    />
                  )}
                  {/* Busy overlay */}
                  {busy && (
                    <div className="absolute inset-0 bg-black/25 flex items-center justify-center pointer-events-none">
                      <span className="text-yellow-400 text-xs font-mono animate-pulse">جاري التنفيذ...</span>
                    </div>
                  )}
                  {/* Live indicator */}
                  <div className="absolute top-2 right-2 flex items-center gap-1 bg-black/75 rounded px-2 py-0.5">
                    <div className="h-1.5 w-1.5 rounded-full bg-yellow-400 animate-pulse"/>
                    <span className="text-[10px] font-mono text-yellow-400">LIVE · انقر مباشرة</span>
                  </div>
                  {/* Coords display */}
                  {cursorPos && imgRef.current && (
                    <div className="absolute bottom-2 left-2 bg-black/75 rounded px-2 py-0.5 font-mono text-[10px] text-yellow-400">
                      {Math.round((cursorPos.x / imgRef.current.clientWidth) * 1280)} , {Math.round((cursorPos.y / imgRef.current.clientHeight) * 800)}
                    </div>
                  )}
                </div>
              ) : (
                <div className="flex items-center justify-center h-40 text-muted-foreground text-sm">
                  جاري تحميل الصفحة...
                </div>
              )}
            </div>

            {/* Controls row */}
            <div className="grid grid-cols-2 gap-3">
              {/* Type text */}
              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground flex items-center gap-1">
                  <Keyboard className="h-3 w-3"/>كتابة نص في المتصفح
                </Label>
                <div className="flex gap-2">
                  <Input
                    value={typeText}
                    onChange={(e) => setTypeText(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter") handleType(); }}
                    placeholder="اكتب ثم Enter..."
                    className="bg-input border-border font-mono text-xs flex-1"
                    dir="ltr"
                    data-testid="input-type"
                  />
                  <Button size="sm" onClick={handleType} disabled={!typeText || busy} className="bg-primary text-black hover:bg-primary/90 shrink-0" data-testid="button-send-type">
                    <CornerDownLeft className="h-3 w-3"/>
                  </Button>
                </div>
              </div>

              {/* Quick keys */}
              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground flex items-center gap-1">
                  <MousePointer className="h-3 w-3"/>مفاتيح سريعة
                </Label>
                <div className="flex flex-wrap gap-1.5">
                  {[
                    { label: "Enter ↵", key: "Enter" },
                    { label: "Tab ⇥",   key: "Tab" },
                    { label: "Esc",      key: "Escape" },
                    { label: "⌫",        key: "Backspace" },
                    { label: "Space",    key: "Space" },
                  ].map(({ label, key }) => (
                    <Button key={key} size="sm" variant="outline" onClick={() => handleKey(key)} disabled={busy}
                      className="border-border hover:bg-secondary text-xs font-mono h-7 px-2.5" data-testid={`btn-key-${key}`}>
                      {label}
                    </Button>
                  ))}
                </div>
              </div>
            </div>

            {/* Action buttons */}
            <div className="flex gap-3 pt-1">
              <Button onClick={handleCaptchaDone} className="flex-1 bg-primary text-black font-bold hover:bg-primary/90" data-testid="button-continue">
                <CheckCircle className="h-4 w-4 mr-2"/>تم — متابعة الأتمتة
              </Button>
              <Button variant="destructive" onClick={handleStop} className="font-bold" data-testid="button-stop-captcha">
                <Square className="h-4 w-4 mr-2"/>إيقاف
              </Button>
            </div>

            <p className="text-[10px] text-muted-foreground text-center font-mono">
              الماوس حقيقي داخل المتصفح · يتحرك بشكل طبيعي قبل كل نقرة · الصفحة تتحدث كل 450ms
            </p>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
