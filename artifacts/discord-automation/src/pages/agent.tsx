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

type LogEntry = {
  id: number;
  message: string;
  level: "info" | "warn" | "error" | "success" | "action";
  time: string;
};

type TaskKind = "login" | "create_bot" | "reset_token";

export default function Agent() {
  const accounts = useListAccounts();

  const [selectedAccountId, setSelectedAccountId] = useState<string>("");
  const [taskKind, setTaskKind] = useState<TaskKind>("login");
  const [botName, setBotName] = useState("My Bot");
  const [botPrefix, setBotPrefix] = useState("!");
  const [appId, setAppId] = useState("");

  const [running, setRunning] = useState(false);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [screenshot, setScreenshot] = useState<string | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [captchaOpen, setCaptchaOpen] = useState(false);
  const [captchaMsg, setCaptchaMsg] = useState("");
  const [captchaScreenshot, setCaptchaScreenshot] = useState<string | null>(null);
  const [typeText, setTypeText] = useState("");
  const [status, setStatus] = useState<"idle" | "running" | "done" | "error">("idle");
  const [finalMsg, setFinalMsg] = useState("");
  const [clickFeedback, setClickFeedback] = useState<{ x: number; y: number } | null>(null);

  const logsEndRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const logCountRef = useRef(0);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const imgRef = useRef<HTMLImageElement>(null);

  useEffect(() => {
    logsEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [logs]);

  // Poll live screenshot during captcha mode
  useEffect(() => {
    if (captchaOpen && sessionId) {
      pollRef.current = setInterval(async () => {
        try {
          const res = await fetch(`/api/agent/screenshot/${sessionId}`);
          if (res.ok) {
            const data = await res.json() as { screenshot: string };
            setCaptchaScreenshot(data.screenshot);
          }
        } catch {}
      }, 900);
    } else {
      if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
    }
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [captchaOpen, sessionId]);

  const addLog = useCallback((message: string, level: LogEntry["level"]) => {
    logCountRef.current += 1;
    const id = logCountRef.current;
    const now = new Date();
    const time = `${now.getHours().toString().padStart(2, "0")}:${now.getMinutes().toString().padStart(2, "0")}:${now.getSeconds().toString().padStart(2, "0")}`;
    setLogs((prev) => [...prev.slice(-299), { id, message, level, time }]);
  }, []);

  const sendInteraction = useCallback(async (action: object) => {
    if (!sessionId) return;
    await fetch(`/api/agent/interact/${sessionId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action }),
    }).catch(() => {});
  }, [sessionId]);

  // Click on the live screenshot → forward to browser
  const handleScreenshotClick = useCallback(async (e: React.MouseEvent<HTMLImageElement>) => {
    if (!sessionId || !imgRef.current) return;
    const rect = imgRef.current.getBoundingClientRect();
    // Map click position to browser viewport (1280×800)
    const relX = (e.clientX - rect.left) / rect.width;
    const relY = (e.clientY - rect.top) / rect.height;
    const browserX = Math.round(relX * 1280);
    const browserY = Math.round(relY * 800);

    setClickFeedback({ x: e.clientX - rect.left, y: e.clientY - rect.top });
    setTimeout(() => setClickFeedback(null), 600);

    addLog(`نقر: (${browserX}, ${browserY})`, "action");
    await sendInteraction({ type: "click", x: browserX, y: browserY });

    // Refresh screenshot after click
    setTimeout(async () => {
      try {
        const res = await fetch(`/api/agent/screenshot/${sessionId}`);
        if (res.ok) {
          const data = await res.json() as { screenshot: string };
          setCaptchaScreenshot(data.screenshot);
        }
      } catch {}
    }, 600);
  }, [sessionId, sendInteraction, addLog]);

  const handleType = async () => {
    if (!typeText || !sessionId) return;
    addLog(`كتابة: ${typeText}`, "action");
    await sendInteraction({ type: "type", text: typeText });
    setTypeText("");
    setTimeout(async () => {
      try {
        const res = await fetch(`/api/agent/screenshot/${sessionId}`);
        if (res.ok) { const d = await res.json() as { screenshot: string }; setCaptchaScreenshot(d.screenshot); }
      } catch {}
    }, 700);
  };

  const handleKey = async (key: string) => {
    if (!sessionId) return;
    addLog(`مفتاح: ${key}`, "action");
    await sendInteraction({ type: "key", key });
    setTimeout(async () => {
      try {
        const res = await fetch(`/api/agent/screenshot/${sessionId}`);
        if (res.ok) { const d = await res.json() as { screenshot: string }; setCaptchaScreenshot(d.screenshot); }
      } catch {}
    }, 500);
  };

  const handleStart = async () => {
    if (!selectedAccountId) return;
    const account = accounts.data?.find((a) => a.id === Number(selectedAccountId));
    if (!account) return;

    setLogs([]);
    setScreenshot(null);
    setRunning(true);
    setStatus("running");
    setFinalMsg("");
    logCountRef.current = 0;

    const task =
      taskKind === "login"
        ? { kind: "login" as const, email: account.email, password: account.password, twofaSecret: account.twofaSecret ?? undefined }
        : taskKind === "create_bot"
        ? { kind: "create_bot" as const, email: account.email, password: account.password, twofaSecret: account.twofaSecret ?? undefined, botName, prefix: botPrefix }
        : { kind: "reset_token" as const, email: account.email, password: account.password, twofaSecret: account.twofaSecret ?? undefined, appId };

    const abort = new AbortController();
    abortRef.current = abort;

    try {
      const res = await fetch("/api/agent/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ task }),
        signal: abort.signal,
      });
      if (!res.body) throw new Error("No stream");

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const parts = buffer.split("\n\n");
        buffer = parts.pop() ?? "";
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
  };

  const handleEvent = (event: AgentEvent) => {
    switch (event.type) {
      case "session_id":
        setSessionId(event.sessionId);
        addLog(`جلسة: ${event.sessionId}`, "info");
        break;
      case "log":
        addLog(event.message, event.level);
        break;
      case "screenshot":
        setScreenshot(event.data);
        break;
      case "action":
        addLog(`[${event.action.toUpperCase()}] ${event.detail ?? ""}`, "action");
        break;
      case "captcha":
        setCaptchaMsg(event.message);
        setCaptchaOpen(true);
        addLog("كابتشا أو تحقق — تدخّل", "warn");
        break;
      case "captcha_solved":
        setCaptchaOpen(false);
        setCaptchaScreenshot(null);
        addLog("تم الحل — استمرار", "success");
        break;
      case "done":
        setStatus(event.success ? "done" : "error");
        setFinalMsg(event.message);
        addLog(event.message, event.success ? "success" : "error");
        setRunning(false);
        setCaptchaOpen(false);
        break;
      case "error":
        setStatus("error");
        setFinalMsg(event.message);
        addLog(event.message, "error");
        setRunning(false);
        break;
    }
  };

  const handleStop = async () => {
    abortRef.current?.abort();
    await fetch("/api/agent/stop", { method: "POST" }).catch(() => {});
    setRunning(false);
    setStatus("idle");
    setCaptchaOpen(false);
    addLog("أُوقف العميل", "warn");
  };

  const handleCaptchaDone = async () => {
    if (!sessionId) return;
    await fetch(`/api/agent/captcha-solved/${sessionId}`, { method: "POST" }).catch(() => {});
    setCaptchaOpen(false);
    setCaptchaScreenshot(null);
    addLog("متابعة — أُرسل للعميل", "success");
  };

  const logIcon = (level: LogEntry["level"]) => {
    if (level === "success") return <CheckCircle className="h-3 w-3 text-primary shrink-0" />;
    if (level === "error") return <XCircle className="h-3 w-3 text-destructive shrink-0" />;
    if (level === "warn") return <AlertTriangle className="h-3 w-3 text-yellow-400 shrink-0" />;
    if (level === "action") return <Cpu className="h-3 w-3 text-blue-400 shrink-0" />;
    return <Info className="h-3 w-3 text-muted-foreground shrink-0" />;
  };

  const logColor = (level: LogEntry["level"]) => {
    if (level === "success") return "text-primary";
    if (level === "error") return "text-destructive";
    if (level === "warn") return "text-yellow-400";
    if (level === "action") return "text-blue-400";
    return "text-muted-foreground";
  };

  const selectedAccount = accounts.data?.find((a) => a.id === Number(selectedAccountId));
  const liveImg = captchaOpen ? (captchaScreenshot ?? screenshot) : screenshot;

  return (
    <div className="space-y-6" dir="rtl">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-foreground">عميل الأتمتة الذكي</h1>
          <p className="text-sm text-muted-foreground mt-1">
            ذكاء اصطناعي يتحكم بمتصفح حقيقي — يمكنك التدخل في أي وقت
          </p>
        </div>
        <div className="flex items-center gap-2">
          {status === "running" && (
            <Badge className="bg-blue-500/20 text-blue-400 border-blue-500/30 animate-pulse">
              <Cpu className="h-3 w-3 mr-1" />يعمل
            </Badge>
          )}
          {status === "done" && (
            <Badge className="bg-primary/20 text-primary border-primary/30">
              <CheckCircle className="h-3 w-3 mr-1" />اكتمل
            </Badge>
          )}
          {status === "error" && (
            <Badge className="bg-destructive/20 text-destructive border-destructive/30">
              <XCircle className="h-3 w-3 mr-1" />فشل
            </Badge>
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
        {/* ── Config Panel ── */}
        <Card className="bg-card border-border">
          <CardHeader className="border-b border-border pb-4">
            <CardTitle className="text-sm font-semibold flex items-center gap-2">
              <Bot className="h-4 w-4 text-primary" />إعدادات المهمة
            </CardTitle>
          </CardHeader>
          <CardContent className="pt-4 space-y-4">
            <div className="space-y-2">
              <Label className="text-xs text-muted-foreground">الحساب</Label>
              <Select value={selectedAccountId} onValueChange={setSelectedAccountId}>
                <SelectTrigger className="bg-input border-border" data-testid="select-account">
                  <SelectValue placeholder="اختر حساباً..." />
                </SelectTrigger>
                <SelectContent className="bg-card border-border">
                  {accounts.data?.length === 0 && (
                    <SelectItem value="_empty" disabled>لا يوجد حسابات — أضف من صفحة Accounts</SelectItem>
                  )}
                  {accounts.data?.map((acc) => (
                    <SelectItem key={acc.id} value={String(acc.id)}>
                      {acc.name} — {acc.email}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {selectedAccount && (
              <div className="rounded-md bg-secondary/30 border border-border p-3 text-xs font-mono space-y-1">
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Email</span>
                  <span>{selectedAccount.email}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">2FA</span>
                  <span>{selectedAccount.twofaSecret ? "✓ متوفر" : "غير مفعل"}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">الحالة</span>
                  <span className={selectedAccount.status === "active" ? "text-primary" : "text-muted-foreground"}>
                    {selectedAccount.status}
                  </span>
                </div>
              </div>
            )}

            <div className="space-y-2">
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
              <div className="space-y-3">
                <div className="space-y-1">
                  <Label className="text-xs text-muted-foreground">اسم البوت</Label>
                  <Input value={botName} onChange={(e) => setBotName(e.target.value)} className="bg-input border-border font-mono" data-testid="input-bot-name" />
                </div>
                <div className="space-y-1">
                  <Label className="text-xs text-muted-foreground">البادئة</Label>
                  <Input value={botPrefix} onChange={(e) => setBotPrefix(e.target.value)} className="bg-input border-border font-mono" data-testid="input-bot-prefix" />
                </div>
              </div>
            )}

            {taskKind === "reset_token" && (
              <div className="space-y-1">
                <Label className="text-xs text-muted-foreground">معرف التطبيق (App ID)</Label>
                <Input value={appId} onChange={(e) => setAppId(e.target.value)} className="bg-input border-border font-mono" placeholder="1234567890123456789" data-testid="input-app-id" />
              </div>
            )}

            <div className="flex gap-3 pt-1">
              {!running ? (
                <Button onClick={handleStart} disabled={!selectedAccountId} className="flex-1 bg-primary text-black font-bold hover:bg-primary/90" data-testid="button-start">
                  <Play className="h-4 w-4 mr-2" />تشغيل العميل
                </Button>
              ) : (
                <Button onClick={handleStop} variant="destructive" className="flex-1 font-bold" data-testid="button-stop">
                  <Square className="h-4 w-4 mr-2" />إيقاف
                </Button>
              )}
              <Button variant="outline" onClick={() => { setLogs([]); setScreenshot(null); setStatus("idle"); setFinalMsg(""); }} className="border-border hover:bg-secondary" data-testid="button-clear">
                <RefreshCw className="h-4 w-4" />
              </Button>
            </div>

            {finalMsg && (
              <div className={`rounded-md p-3 text-xs font-mono border break-all ${
                status === "done"
                  ? "bg-primary/10 border-primary/30 text-primary"
                  : "bg-destructive/10 border-destructive/30 text-destructive"
              }`}>
                {finalMsg}
              </div>
            )}
          </CardContent>
        </Card>

        {/* ── Live Browser View ── */}
        <Card className="bg-card border-border">
          <CardHeader className="border-b border-border pb-4">
            <CardTitle className="text-sm font-semibold flex items-center gap-2">
              <Eye className="h-4 w-4 text-primary" />
              نظرة المتصفح المباشرة
              {running && <span className="mr-auto text-[10px] text-blue-400 font-mono animate-pulse">● LIVE</span>}
            </CardTitle>
          </CardHeader>
          <CardContent className="pt-4">
            {liveImg ? (
              <div className="relative rounded-md overflow-hidden border border-border cursor-crosshair">
                <img
                  ref={imgRef}
                  src={`data:image/jpeg;base64,${liveImg}`}
                  alt="Browser"
                  className="w-full h-auto block select-none"
                  draggable={false}
                  data-testid="img-browser"
                />
                {clickFeedback && (
                  <div
                    className="absolute pointer-events-none"
                    style={{
                      left: clickFeedback.x - 10,
                      top: clickFeedback.y - 10,
                      width: 20,
                      height: 20,
                      borderRadius: "50%",
                      border: "2px solid #00ff88",
                      opacity: 0.8,
                      animation: "ping 0.6s ease-out",
                    }}
                  />
                )}
              </div>
            ) : (
              <div className="flex flex-col items-center justify-center h-52 rounded-md border border-dashed border-border text-muted-foreground">
                <Eye className="h-8 w-8 mb-2 opacity-30" />
                <span className="text-sm">في انتظار بدء العميل...</span>
              </div>
            )}
            <p className="text-[10px] text-muted-foreground mt-2 text-center font-mono">
              الكاميرا تتحدث تلقائياً — التفاعل متاح عند الكابتشا
            </p>
          </CardContent>
        </Card>
      </div>

      {/* ── Activity Log ── */}
      <Card className="bg-card border-border">
        <CardHeader className="border-b border-border pb-3">
          <CardTitle className="text-sm font-semibold flex items-center gap-2">
            <Cpu className="h-4 w-4 text-primary" />
            سجل النشاط
            <span className="mr-auto text-xs text-muted-foreground font-normal font-mono">{logs.length} حدث</span>
          </CardTitle>
        </CardHeader>
        <CardContent className="pt-0">
          <div className="h-52 overflow-y-auto font-mono text-xs space-y-0.5 p-3 bg-background/50 rounded-md border border-border" data-testid="div-log">
            {logs.length === 0
              ? <div className="flex items-center justify-center h-full text-muted-foreground">لا يوجد نشاط</div>
              : logs.map((log) => (
                <div key={log.id} className="flex items-start gap-2 py-0.5">
                  <span className="text-muted-foreground/50 shrink-0 w-16">{log.time}</span>
                  {logIcon(log.level)}
                  <span className={logColor(log.level)}>{log.message}</span>
                </div>
              ))
            }
            <div ref={logsEndRef} />
          </div>
        </CardContent>
      </Card>

      {/* ════════════════════════════════════════
          CAPTCHA / VERIFICATION INTERACTIVE DIALOG
          ════════════════════════════════════════ */}
      <Dialog open={captchaOpen} onOpenChange={() => {}}>
        <DialogContent className="bg-card border-border max-w-3xl w-full p-0 gap-0" data-testid="dialog-captcha">
          <DialogHeader className="border-b border-border p-4">
            <DialogTitle className="flex items-center gap-2 text-yellow-400 text-sm">
              <AlertTriangle className="h-4 w-4" />
              تدخّل مطلوب — تحكّم بالمتصفح مباشرة
              <Badge className="mr-auto bg-yellow-400/10 text-yellow-400 border-yellow-400/30 text-[10px]">
                وضع التحكم اليدوي
              </Badge>
            </DialogTitle>
          </DialogHeader>

          <div className="p-4 space-y-3">
            <p className="text-xs text-muted-foreground text-center bg-secondary/30 rounded p-2 border border-border">
              {captchaMsg}
            </p>

            {/* Live clickable screenshot */}
            <div className="relative rounded-md overflow-hidden border-2 border-yellow-400/40 cursor-crosshair bg-black">
              {captchaScreenshot ?? screenshot ? (
                <img
                  ref={imgRef}
                  src={`data:image/jpeg;base64,${captchaScreenshot ?? screenshot}`}
                  alt="Live browser"
                  className="w-full h-auto block select-none"
                  draggable={false}
                  onClick={handleScreenshotClick}
                  data-testid="img-captcha-browser"
                />
              ) : (
                <div className="flex items-center justify-center h-40 text-muted-foreground text-sm">
                  جاري تحميل الصفحة...
                </div>
              )}
              {clickFeedback && (
                <div
                  className="absolute pointer-events-none rounded-full border-2 border-primary"
                  style={{
                    left: clickFeedback.x - 12,
                    top: clickFeedback.y - 12,
                    width: 24,
                    height: 24,
                    animation: "ping 0.6s ease-out forwards",
                  }}
                />
              )}
              <div className="absolute top-2 left-2 flex items-center gap-1 bg-black/70 rounded px-2 py-0.5">
                <div className="h-1.5 w-1.5 rounded-full bg-yellow-400 animate-pulse" />
                <span className="text-[10px] text-yellow-400 font-mono">LIVE — انقر مباشرة</span>
              </div>
            </div>

            {/* Keyboard controls */}
            <div className="grid grid-cols-2 gap-3">
              {/* Type text */}
              <div className="space-y-2">
                <Label className="text-xs text-muted-foreground flex items-center gap-1">
                  <Keyboard className="h-3 w-3" />كتابة نص
                </Label>
                <div className="flex gap-2">
                  <Input
                    value={typeText}
                    onChange={(e) => setTypeText(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter") handleType(); }}
                    placeholder="اكتب هنا..."
                    className="bg-input border-border font-mono text-xs flex-1"
                    data-testid="input-type-text"
                    dir="ltr"
                  />
                  <Button size="sm" onClick={handleType} disabled={!typeText} className="bg-primary text-black hover:bg-primary/90 shrink-0" data-testid="button-type-send">
                    <CornerDownLeft className="h-3 w-3" />
                  </Button>
                </div>
              </div>

              {/* Quick keys */}
              <div className="space-y-2">
                <Label className="text-xs text-muted-foreground flex items-center gap-1">
                  <MousePointer className="h-3 w-3" />مفاتيح سريعة
                </Label>
                <div className="flex gap-2 flex-wrap">
                  {[
                    { label: "Enter", key: "Enter" },
                    { label: "Tab", key: "Tab" },
                    { label: "Esc", key: "Escape" },
                    { label: "⌫", key: "Backspace" },
                    { label: "Space", key: "Space" },
                  ].map(({ label, key }) => (
                    <Button
                      key={key}
                      size="sm"
                      variant="outline"
                      onClick={() => handleKey(key)}
                      className="border-border hover:bg-secondary text-xs font-mono h-7 px-2"
                      data-testid={`button-key-${key.toLowerCase()}`}
                    >
                      {label}
                    </Button>
                  ))}
                </div>
              </div>
            </div>

            <div className="flex gap-3 pt-1">
              <Button
                onClick={handleCaptchaDone}
                className="flex-1 bg-primary text-black font-bold hover:bg-primary/90"
                data-testid="button-captcha-continue"
              >
                <CheckCircle className="h-4 w-4 mr-2" />
                تم — متابعة الأتمتة
              </Button>
              <Button
                variant="destructive"
                onClick={handleStop}
                className="font-bold"
                data-testid="button-captcha-stop"
              >
                <Square className="h-4 w-4 mr-2" />
                إيقاف
              </Button>
            </div>

            <p className="text-[10px] text-muted-foreground text-center font-mono">
              انقر مباشرة على الصفحة لحل الكابتشا أو إدخال رمز التحقق · الصفحة تتحدث كل ثانية
            </p>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
