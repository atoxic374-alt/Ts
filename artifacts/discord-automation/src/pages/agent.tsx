import { useState, useRef, useEffect, useCallback } from "react";
import { useListAccounts } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import {
  Bot,
  Play,
  Square,
  RefreshCw,
  AlertTriangle,
  CheckCircle,
  XCircle,
  Info,
  Eye,
  Cpu,
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
  const [botName, setBotName] = useState("True-Studio Bot");
  const [botPrefix, setBotPrefix] = useState("True-Studio");
  const [appId, setAppId] = useState("");

  const [running, setRunning] = useState(false);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [screenshot, setScreenshot] = useState<string | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [captchaOpen, setCaptchaOpen] = useState(false);
  const [captchaMsg, setCaptchaMsg] = useState("");
  const [status, setStatus] = useState<"idle" | "running" | "done" | "error">("idle");
  const [finalMsg, setFinalMsg] = useState("");

  const logsEndRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const logCountRef = useRef(0);

  useEffect(() => {
    logsEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [logs]);

  const addLog = useCallback((message: string, level: LogEntry["level"]) => {
    logCountRef.current += 1;
    const id = logCountRef.current;
    const now = new Date();
    const time = `${now.getHours().toString().padStart(2, "0")}:${now.getMinutes().toString().padStart(2, "0")}:${now.getSeconds().toString().padStart(2, "0")}`;
    setLogs((prev) => [...prev.slice(-199), { id, message, level, time }]);
  }, []);

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
        ? {
            kind: "login" as const,
            email: account.email,
            password: account.password,
            twofaSecret: account.twofaSecret ?? undefined,
          }
        : taskKind === "create_bot"
        ? {
            kind: "create_bot" as const,
            email: account.email,
            password: account.password,
            twofaSecret: account.twofaSecret ?? undefined,
            botName,
            prefix: botPrefix,
          }
        : {
            kind: "reset_token" as const,
            email: account.email,
            password: account.password,
            twofaSecret: account.twofaSecret ?? undefined,
            appId,
          };

    const abort = new AbortController();
    abortRef.current = abort;

    try {
      const res = await fetch("/api/agent/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ task }),
        signal: abort.signal,
      });

      if (!res.body) throw new Error("No response body");

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
          try {
            const event: AgentEvent = JSON.parse(line.slice(5).trim());
            handleEvent(event);
          } catch {}
        }
      }
    } catch (err) {
      if ((err as Error).name !== "AbortError") {
        addLog("انقطع الاتصال", "error");
      }
    } finally {
      setRunning(false);
    }
  };

  const handleEvent = (event: AgentEvent) => {
    switch (event.type) {
      case "session_id":
        setSessionId(event.sessionId);
        addLog(`جلسة جديدة: ${event.sessionId}`, "info");
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
        addLog("كابتشا — يرجى التدخل", "warn");
        break;
      case "captcha_solved":
        setCaptchaOpen(false);
        addLog("تم حل الكابتشا", "success");
        break;
      case "done":
        setStatus(event.success ? "done" : "error");
        setFinalMsg(event.message);
        addLog(event.message, event.success ? "success" : "error");
        setRunning(false);
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
    addLog("أُوقف العميل يدوياً", "warn");
  };

  const handleCaptchaSolved = async () => {
    if (!sessionId) return;
    await fetch(`/api/agent/captcha-solved/${sessionId}`, { method: "POST" }).catch(() => {});
    setCaptchaOpen(false);
    addLog("تم إرسال حل الكابتشا", "success");
  };

  const logLevelIcon = (level: LogEntry["level"]) => {
    switch (level) {
      case "success": return <CheckCircle className="h-3 w-3 text-primary shrink-0" />;
      case "error": return <XCircle className="h-3 w-3 text-destructive shrink-0" />;
      case "warn": return <AlertTriangle className="h-3 w-3 text-yellow-400 shrink-0" />;
      case "action": return <Cpu className="h-3 w-3 text-blue-400 shrink-0" />;
      default: return <Info className="h-3 w-3 text-muted-foreground shrink-0" />;
    }
  };

  const logLevelColor = (level: LogEntry["level"]) => {
    switch (level) {
      case "success": return "text-primary";
      case "error": return "text-destructive";
      case "warn": return "text-yellow-400";
      case "action": return "text-blue-400";
      default: return "text-muted-foreground";
    }
  };

  const selectedAccount = accounts.data?.find((a) => a.id === Number(selectedAccountId));

  return (
    <div className="space-y-6" dir="rtl">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-foreground">عميل الأتمتة الذكي</h1>
          <p className="text-sm text-muted-foreground mt-1">
            ذكاء اصطناعي يتحكم بمتصفح حقيقي لتنفيذ مهام ديسكورد تلقائياً
          </p>
        </div>
        <div className="flex items-center gap-2">
          {status === "running" && (
            <Badge className="bg-blue-500/20 text-blue-400 border-blue-500/30 animate-pulse">
              <Cpu className="h-3 w-3 mr-1" /> يعمل
            </Badge>
          )}
          {status === "done" && (
            <Badge className="bg-primary/20 text-primary border-primary/30">
              <CheckCircle className="h-3 w-3 mr-1" /> اكتمل
            </Badge>
          )}
          {status === "error" && (
            <Badge className="bg-destructive/20 text-destructive border-destructive/30">
              <XCircle className="h-3 w-3 mr-1" /> فشل
            </Badge>
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
        {/* Config Panel */}
        <Card className="bg-card border-border">
          <CardHeader className="border-b border-border pb-4">
            <CardTitle className="text-sm font-semibold text-foreground flex items-center gap-2">
              <Bot className="h-4 w-4 text-primary" />
              إعدادات المهمة
            </CardTitle>
          </CardHeader>
          <CardContent className="pt-4 space-y-4">
            <div className="space-y-2">
              <Label className="text-xs text-muted-foreground">الحساب</Label>
              <Select value={selectedAccountId} onValueChange={setSelectedAccountId}>
                <SelectTrigger
                  className="bg-input border-border text-foreground"
                  data-testid="select-account"
                >
                  <SelectValue placeholder="اختر حساباً..." />
                </SelectTrigger>
                <SelectContent className="bg-card border-border">
                  {accounts.data?.map((acc) => (
                    <SelectItem key={acc.id} value={String(acc.id)}>
                      {acc.name} — {acc.email}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {selectedAccount && (
              <div className="rounded-md bg-secondary/40 border border-border p-3 space-y-1 text-xs font-mono">
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Email</span>
                  <span className="text-foreground">{selectedAccount.email}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">2FA</span>
                  <span className="text-foreground">
                    {selectedAccount.twofaSecret ? "متوفر" : "غير مفعل"}
                  </span>
                </div>
              </div>
            )}

            <div className="space-y-2">
              <Label className="text-xs text-muted-foreground">نوع المهمة</Label>
              <Select value={taskKind} onValueChange={(v) => setTaskKind(v as TaskKind)}>
                <SelectTrigger className="bg-input border-border text-foreground" data-testid="select-task">
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
              <>
                <div className="space-y-2">
                  <Label className="text-xs text-muted-foreground">اسم البوت</Label>
                  <Input
                    value={botName}
                    onChange={(e) => setBotName(e.target.value)}
                    className="bg-input border-border font-mono"
                    data-testid="input-bot-name"
                  />
                </div>
                <div className="space-y-2">
                  <Label className="text-xs text-muted-foreground">البادئة (Prefix)</Label>
                  <Input
                    value={botPrefix}
                    onChange={(e) => setBotPrefix(e.target.value)}
                    className="bg-input border-border font-mono"
                    data-testid="input-bot-prefix"
                  />
                </div>
              </>
            )}

            {taskKind === "reset_token" && (
              <div className="space-y-2">
                <Label className="text-xs text-muted-foreground">معرف التطبيق (App ID)</Label>
                <Input
                  value={appId}
                  onChange={(e) => setAppId(e.target.value)}
                  className="bg-input border-border font-mono"
                  placeholder="1234567890"
                  data-testid="input-app-id"
                />
              </div>
            )}

            <div className="flex gap-3 pt-2">
              {!running ? (
                <Button
                  onClick={handleStart}
                  disabled={!selectedAccountId}
                  className="flex-1 bg-primary text-black font-bold hover:bg-primary/90"
                  data-testid="button-start-agent"
                >
                  <Play className="h-4 w-4 mr-2" />
                  تشغيل العميل
                </Button>
              ) : (
                <Button
                  onClick={handleStop}
                  variant="destructive"
                  className="flex-1 font-bold"
                  data-testid="button-stop-agent"
                >
                  <Square className="h-4 w-4 mr-2" />
                  إيقاف العميل
                </Button>
              )}
              <Button
                variant="outline"
                onClick={() => { setLogs([]); setScreenshot(null); setStatus("idle"); setFinalMsg(""); }}
                className="border-border hover:bg-secondary"
                data-testid="button-clear-logs"
              >
                <RefreshCw className="h-4 w-4" />
              </Button>
            </div>

            {finalMsg && (
              <div className={`rounded-md p-3 text-xs font-mono border ${
                status === "done"
                  ? "bg-primary/10 border-primary/30 text-primary"
                  : "bg-destructive/10 border-destructive/30 text-destructive"
              }`}>
                {finalMsg}
              </div>
            )}
          </CardContent>
        </Card>

        {/* Live Screenshot */}
        <Card className="bg-card border-border">
          <CardHeader className="border-b border-border pb-4">
            <CardTitle className="text-sm font-semibold text-foreground flex items-center gap-2">
              <Eye className="h-4 w-4 text-primary" />
              نظرة المتصفح المباشرة
            </CardTitle>
          </CardHeader>
          <CardContent className="pt-4">
            {screenshot ? (
              <div className="relative rounded-md overflow-hidden border border-border">
                {running && (
                  <div className="absolute top-2 right-2 flex items-center gap-1 bg-black/70 rounded px-2 py-0.5">
                    <div className="h-1.5 w-1.5 rounded-full bg-primary animate-pulse" />
                    <span className="text-[10px] text-primary font-mono">LIVE</span>
                  </div>
                )}
                <img
                  src={`data:image/jpeg;base64,${screenshot}`}
                  alt="Browser view"
                  className="w-full h-auto"
                  data-testid="img-browser-screenshot"
                />
              </div>
            ) : (
              <div className="flex flex-col items-center justify-center h-48 rounded-md border border-dashed border-border text-muted-foreground">
                <Eye className="h-8 w-8 mb-2 opacity-30" />
                <span className="text-sm">في انتظار بدء العميل...</span>
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Activity Log */}
      <Card className="bg-card border-border">
        <CardHeader className="border-b border-border pb-4">
          <CardTitle className="text-sm font-semibold text-foreground flex items-center gap-2">
            <Cpu className="h-4 w-4 text-primary" />
            سجل النشاط
            <span className="ml-auto text-xs text-muted-foreground font-normal font-mono">
              {logs.length} حدث
            </span>
          </CardTitle>
        </CardHeader>
        <CardContent className="pt-0">
          <div
            className="h-52 overflow-y-auto font-mono text-xs space-y-0.5 p-3 bg-background/50 rounded-md border border-border"
            data-testid="div-activity-log"
          >
            {logs.length === 0 ? (
              <div className="flex items-center justify-center h-full text-muted-foreground">
                لا يوجد نشاط بعد
              </div>
            ) : (
              logs.map((log) => (
                <div key={log.id} className="flex items-start gap-2 py-0.5">
                  <span className="text-muted-foreground/60 shrink-0">{log.time}</span>
                  {logLevelIcon(log.level)}
                  <span className={logLevelColor(log.level)}>{log.message}</span>
                </div>
              ))
            )}
            <div ref={logsEndRef} />
          </div>
        </CardContent>
      </Card>

      {/* Captcha Dialog */}
      <Dialog open={captchaOpen} onOpenChange={() => {}}>
        <DialogContent className="bg-card border-border sm:max-w-md" data-testid="dialog-captcha">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-yellow-400">
              <AlertTriangle className="h-5 w-5" />
              كابتشا مطلوبة
            </DialogTitle>
            <DialogDescription className="text-muted-foreground text-sm">
              {captchaMsg}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            {screenshot && (
              <div className="rounded-md overflow-hidden border border-border">
                <img
                  src={`data:image/jpeg;base64,${screenshot}`}
                  alt="Captcha browser view"
                  className="w-full h-auto"
                />
              </div>
            )}
            <p className="text-xs text-muted-foreground text-center">
              العميل توقف وينتظرك. قم بحل الكابتشا ثم اضغط "تم الحل".
            </p>
            <Button
              onClick={handleCaptchaSolved}
              className="w-full bg-primary text-black font-bold hover:bg-primary/90"
              data-testid="button-captcha-solved"
            >
              <CheckCircle className="h-4 w-4 mr-2" />
              تم حل الكابتشا — استمر
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
