import { chromium, type Browser, type Page } from "playwright";
import { ai } from "@workspace/integrations-gemini-ai";

export type AgentEvent =
  | { type: "log"; message: string; level: "info" | "warn" | "error" | "success" }
  | { type: "screenshot"; data: string }
  | { type: "captcha"; message: string }
  | { type: "captcha_solved" }
  | { type: "action"; action: string; detail?: string }
  | { type: "done"; success: boolean; message: string }
  | { type: "error"; message: string };

export type AgentTask =
  | { kind: "login"; email: string; password: string; twofaSecret?: string }
  | { kind: "create_bot"; email: string; password: string; twofaSecret?: string; botName: string; prefix: string }
  | { kind: "reset_token"; email: string; password: string; twofaSecret?: string; appId: string };

interface GeminiAction {
  action: "click" | "type" | "navigate" | "wait" | "done" | "captcha" | "scroll" | "press_key" | "hover";
  selector?: string;
  text?: string;
  url?: string;
  key?: string;
  message?: string;
  done_message?: string;
  success?: boolean;
}

let activeBrowser: Browser | null = null;

export async function stopActiveAgent() {
  if (activeBrowser) {
    await activeBrowser.close().catch(() => {});
    activeBrowser = null;
  }
}

export async function runDiscordAgent(
  task: AgentTask,
  onEvent: (event: AgentEvent) => void,
  captchaResolver: () => Promise<void>
) {
  onEvent({ type: "log", message: "تشغيل المتصفح...", level: "info" });

  const chromiumPath =
    process.env.CHROMIUM_PATH ||
    "/nix/store/qa9cnw4v5xkxyip6mb9kxqfq1z4x2dx1-chromium-138.0.7204.100/bin/chromium";

  const browser = await chromium.launch({
    executablePath: chromiumPath,
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--disable-accelerated-2d-canvas",
      "--no-zygote",
      "--single-process",
      "--disable-background-networking",
      "--disable-default-apps",
      "--disable-extensions",
      "--disable-sync",
      "--disable-translate",
      "--hide-scrollbars",
      "--metrics-recording-only",
      "--mute-audio",
      "--no-first-run",
    ],
  });
  activeBrowser = browser;

  const context = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    viewport: { width: 1280, height: 800 },
  });
  const page = await context.newPage();

  const systemPrompt = buildSystemPrompt(task);
  const history: string[] = [];

  try {
    onEvent({ type: "log", message: "جاري الاتصال بديسكورد...", level: "info" });

    const maxSteps = 35;
    let steps = 0;

    while (steps < maxSteps) {
      steps++;

      await page.waitForTimeout(800);

      const screenshotBuffer = await page.screenshot({ type: "jpeg", quality: 60, fullPage: false });
      const screenshotBase64 = screenshotBuffer.toString("base64");

      onEvent({ type: "screenshot", data: screenshotBase64 });

      const currentUrl = page.url();
      const historyText = history.length > 0 ? `\nالخطوات السابقة:\n${history.slice(-8).join("\n")}` : "";

      const response = await ai.models.generateContent({
        model: "gemini-2.5-flash",
        contents: [
          {
            role: "user",
            parts: [
              {
                inlineData: {
                  mimeType: "image/jpeg",
                  data: screenshotBase64,
                },
              },
              {
                text: `الرابط الحالي: ${currentUrl}
${historyText}

المهمة: ${JSON.stringify(task)}

انظر للسكرين شوت وقرر الخطوة القادمة. أجب بـ JSON فقط.`,
              },
            ],
          },
        ],
        config: {
          systemInstruction: systemPrompt,
          maxOutputTokens: 1024,
          responseMimeType: "application/json",
        },
      });

      let parsed: GeminiAction;
      try {
        const raw = response.text ?? "{}";
        parsed = JSON.parse(raw.replace(/```json\n?|\n?```/g, "").trim()) as GeminiAction;
      } catch {
        onEvent({ type: "log", message: "خطأ في تحليل رد الـ AI، إعادة المحاولة...", level: "warn" });
        continue;
      }

      onEvent({
        type: "action",
        action: parsed.action,
        detail: parsed.selector ?? parsed.url ?? parsed.text ?? parsed.message,
      });

      history.push(`الخطوة ${steps}: ${parsed.action} - ${parsed.selector ?? parsed.url ?? parsed.text ?? parsed.message ?? ""}`);

      if (parsed.action === "done") {
        onEvent({
          type: "log",
          message: parsed.done_message ?? "اكتملت المهمة بنجاح!",
          level: "success",
        });
        onEvent({ type: "done", success: parsed.success !== false, message: parsed.done_message ?? "تم" });
        break;
      }

      if (parsed.action === "captcha") {
        onEvent({ type: "log", message: "تم اكتشاف كابتشا — يرجى حلها", level: "warn" });
        onEvent({ type: "captcha", message: parsed.message ?? "يرجى حل الكابتشا في النافذة أدناه" });
        await captchaResolver();
        onEvent({ type: "captcha_solved" });
        onEvent({ type: "log", message: "تم حل الكابتشا، استمرار...", level: "info" });
        continue;
      }

      try {
        await executeAction(page, parsed, onEvent);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        onEvent({ type: "log", message: `فشل تنفيذ الإجراء: ${msg}`, level: "warn" });
      }
    }

    if (steps >= maxSteps) {
      onEvent({ type: "log", message: "وصل للحد الأقصى من الخطوات", level: "error" });
      onEvent({ type: "done", success: false, message: "انتهت المهلة" });
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    onEvent({ type: "error", message: msg });
    onEvent({ type: "done", success: false, message: msg });
  } finally {
    await browser.close().catch(() => {});
    activeBrowser = null;
  }
}

async function executeAction(page: Page, action: GeminiAction, onEvent: (e: AgentEvent) => void) {
  switch (action.action) {
    case "navigate":
      if (action.url) {
        onEvent({ type: "log", message: `التنقل إلى: ${action.url}`, level: "info" });
        await page.goto(action.url, { waitUntil: "domcontentloaded", timeout: 30000 });
      }
      break;

    case "click":
      if (action.selector) {
        onEvent({ type: "log", message: `النقر على: ${action.selector}`, level: "info" });
        try {
          await page.click(action.selector, { timeout: 8000 });
        } catch {
          const el = page.locator(action.selector).first();
          await el.click({ timeout: 8000 });
        }
      }
      break;

    case "type":
      if (action.selector && action.text !== undefined) {
        onEvent({ type: "log", message: `الكتابة في: ${action.selector}`, level: "info" });
        try {
          await page.click(action.selector, { timeout: 5000 });
        } catch {}
        await page.fill(action.selector, action.text, { timeout: 8000 });
      }
      break;

    case "press_key":
      if (action.key) {
        onEvent({ type: "log", message: `ضغط مفتاح: ${action.key}`, level: "info" });
        await page.keyboard.press(action.key);
      }
      break;

    case "scroll":
      onEvent({ type: "log", message: "تمرير الصفحة...", level: "info" });
      await page.evaluate(() => window.scrollBy(0, 400));
      break;

    case "hover":
      if (action.selector) {
        await page.hover(action.selector, { timeout: 5000 });
      }
      break;

    case "wait":
      onEvent({ type: "log", message: "الانتظار قليلاً...", level: "info" });
      await page.waitForTimeout(2000);
      break;
  }
}

function buildSystemPrompt(task: AgentTask): string {
  const basePrompt = `أنت مساعد أتمتة ديسكورد. تتحكم بمتصفح لإنجاز مهام على ديسكورد.
تحصل على سكرين شوت للمتصفح وعليك تقرير الخطوة القادمة.

أجب دائماً بـ JSON فقط بهذا الشكل:
{
  "action": "navigate"|"click"|"type"|"wait"|"done"|"captcha"|"scroll"|"press_key"|"hover",
  "selector": "CSS selector أو text selector",
  "text": "النص للكتابة (للـ type فقط)",
  "url": "الرابط (للـ navigate فقط)",
  "key": "اسم المفتاح (للـ press_key فقط)",
  "message": "رسالة للمستخدم (للـ captcha أو done)",
  "done_message": "رسالة الإتمام (للـ done فقط)",
  "success": true|false (للـ done فقط)
}

قواعد مهمة:
- للكابتشا: استخدم action: "captcha"
- عند رؤية reCAPTCHA أو hCaptcha في السكرين شوت: أرجع action: "captcha" فوراً
- استخدم selectors دقيقة مثل: input[name="email"], button[type="submit"], text=Login
- للنصوص: استخدم text=النص أو :text("النص") أو role=button[name="النص"]
- عند اكتمال المهمة: استخدم action: "done" مع success: true
- عند فشل المهمة: استخدم action: "done" مع success: false
- لا تتجاوز الخطوة الواحدة في كل رد
- ديسكورد Developer Portal: https://discord.com/developers/applications`;

  if (task.kind === "login") {
    return `${basePrompt}

المهمة الحالية: تسجيل الدخول إلى حساب ديسكورد
الإيميل: ${task.email}
الباسوورد: ${task.password}
${task.twofaSecret ? `رمز 2FA: استخدم TOTP من السر: ${task.twofaSecret}` : ""}

خطوات تسجيل الدخول:
1. افتح https://discord.com/login
2. ابحث عن حقل الإيميل واكتب الإيميل
3. ابحث عن حقل الباسوورد واكتب الباسوورد
4. انقر زر Log In
5. إذا ظهر 2FA اكتب رمز TOTP
6. إذا ظهرت كابتشا أرجع captcha
7. عند الوصول لصفحة ديسكورد الرئيسية: done بنجاح`;
  }

  if (task.kind === "create_bot") {
    return `${basePrompt}

المهمة الحالية: إنشاء تطبيق بوت جديد على ديسكورد Developer Portal
اسم البوت: ${task.botName}
البادئة: ${task.prefix}
الإيميل: ${task.email}

خطوات إنشاء البوت:
1. افتح https://discord.com/login وسجل دخول بـ ${task.email}
2. بعد الدخول افتح https://discord.com/developers/applications
3. انقر "New Application"
4. اكتب اسم التطبيق: ${task.botName}
5. وافق على الشروط وانقر Create
6. افتح قسم "Bot" من القائمة الجانبية
7. انقر "Add Bot" أو "Reset Token"
8. انسخ التوكن (سيظهر في الصفحة)
9. عند الحصول على التوكن: done مع رسالة تحتوي التوكن`;
  }

  if (task.kind === "reset_token") {
    return `${basePrompt}

المهمة الحالية: إعادة تعيين توكن تطبيق بوت
معرف التطبيق: ${task.appId}
الإيميل: ${task.email}

خطوات إعادة التعيين:
1. افتح https://discord.com/login وسجل دخول
2. افتح https://discord.com/developers/applications/${task.appId}/bot
3. انقر "Reset Token"
4. وافق على التأكيد
5. انسخ التوكن الجديد
6. done مع رسالة تحتوي التوكن الجديد`;
  }

  return basePrompt;
}
