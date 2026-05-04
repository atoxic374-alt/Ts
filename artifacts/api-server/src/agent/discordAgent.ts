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

// Shared map: sessionId → live Page (for interactive control during pauses)
export const activePages = new Map<string, Page>();

export async function getSessionScreenshot(sessionId: string): Promise<string | null> {
  const page = activePages.get(sessionId);
  if (!page) return null;
  try {
    const buf = await page.screenshot({ type: "jpeg", quality: 65, fullPage: false });
    return buf.toString("base64");
  } catch {
    return null;
  }
}

/** Move mouse along a bezier-curve path then click — looks human to CAPTCHA systems */
async function humanClick(page: Page, targetX: number, targetY: number) {
  // Current position (start from somewhere plausible on the page)
  const startX = Math.round(Math.random() * 400 + 200);
  const startY = Math.round(Math.random() * 200 + 200);

  // Two bezier control points with slight randomness
  const cp1x = startX + (targetX - startX) * 0.25 + (Math.random() - 0.5) * 80;
  const cp1y = startY + (targetY - startY) * 0.25 + (Math.random() - 0.5) * 80;
  const cp2x = startX + (targetX - startX) * 0.75 + (Math.random() - 0.5) * 60;
  const cp2y = startY + (targetY - startY) * 0.75 + (Math.random() - 0.5) * 60;

  const steps = 18 + Math.floor(Math.random() * 10); // 18–27 steps
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const mt = 1 - t;
    // Cubic bezier formula
    const x = Math.round(mt * mt * mt * startX + 3 * mt * mt * t * cp1x + 3 * mt * t * t * cp2x + t * t * t * targetX);
    const y = Math.round(mt * mt * mt * startY + 3 * mt * mt * t * cp1y + 3 * mt * t * t * cp2y + t * t * t * targetY);
    await page.mouse.move(x, y);
    // Variable delay — faster in the middle, slower near ends
    const delay = i === 0 || i === steps ? 18 + Math.random() * 15 : 6 + Math.random() * 8;
    await new Promise((r) => setTimeout(r, delay));
  }

  // Small jitter right before click (like real hand tremor)
  const jx = targetX + Math.round((Math.random() - 0.5) * 3);
  const jy = targetY + Math.round((Math.random() - 0.5) * 3);
  await page.mouse.move(jx, jy);
  await new Promise((r) => setTimeout(r, 30 + Math.random() * 40));

  // Press then release (don't use .click() shortcut — more natural)
  await page.mouse.down();
  await new Promise((r) => setTimeout(r, 60 + Math.random() * 80));
  await page.mouse.up();
}

export async function interactWithSession(
  sessionId: string,
  action:
    | { type: "click"; x: number; y: number }
    | { type: "type"; text: string }
    | { type: "key"; key: string }
    | { type: "scroll"; deltaY: number }
): Promise<{ ok: boolean; screenshotAfter?: string }> {
  const page = activePages.get(sessionId);
  if (!page) return { ok: false };
  try {
    if (action.type === "click") {
      await humanClick(page, action.x, action.y);
    } else if (action.type === "type") {
      // Realistic typing speed with variation
      for (const char of action.text) {
        await page.keyboard.type(char);
        await new Promise((r) => setTimeout(r, 40 + Math.random() * 60));
      }
    } else if (action.type === "key") {
      await page.keyboard.press(action.key);
    } else if (action.type === "scroll") {
      await page.mouse.wheel(0, action.deltaY);
    }
    // Wait a little then grab fresh screenshot
    await new Promise((r) => setTimeout(r, 350));
    const buf = await page.screenshot({ type: "jpeg", quality: 70, fullPage: false });
    return { ok: true, screenshotAfter: buf.toString("base64") };
  } catch {
    return { ok: false };
  }
}

export async function stopActiveAgent() {
  if (activeBrowser) {
    await activeBrowser.close().catch(() => {});
    activeBrowser = null;
  }
  activePages.clear();
}

export async function runDiscordAgent(
  sessionId: string,
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
  activePages.set(sessionId, page);

  const systemPrompt = buildSystemPrompt(task);
  const history: string[] = [];

  try {
    onEvent({ type: "log", message: "جاري الاتصال بديسكورد...", level: "info" });

    const maxSteps = 40;
    let steps = 0;

    while (steps < maxSteps) {
      steps++;

      await page.waitForTimeout(900);

      const screenshotBuffer = await page.screenshot({ type: "jpeg", quality: 65, fullPage: false });
      const screenshotBase64 = screenshotBuffer.toString("base64");
      onEvent({ type: "screenshot", data: screenshotBase64 });

      const currentUrl = page.url();
      const historyText = history.length > 0
        ? `\nالخطوات السابقة:\n${history.slice(-8).join("\n")}`
        : "";

      let response;
      try {
        response = await ai.models.generateContent({
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
                  text: `الرابط الحالي: ${currentUrl}\n${historyText}\n\nالمهمة: ${JSON.stringify(task)}\n\nانظر للسكرين شوت وقرر الخطوة القادمة. أجب بـ JSON فقط.`,
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
      } catch (aiErr) {
        onEvent({ type: "log", message: `خطأ Gemini: ${String(aiErr).slice(0, 80)}`, level: "warn" });
        await page.waitForTimeout(2000);
        continue;
      }

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

      history.push(
        `خطوة ${steps}: ${parsed.action} — ${parsed.selector ?? parsed.url ?? parsed.text ?? parsed.message ?? ""}`
      );

      if (parsed.action === "done") {
        const msg = parsed.done_message ?? "اكتملت المهمة بنجاح!";
        onEvent({ type: "log", message: msg, level: parsed.success !== false ? "success" : "error" });
        onEvent({ type: "done", success: parsed.success !== false, message: msg });
        break;
      }

      if (parsed.action === "captcha") {
        onEvent({ type: "log", message: "تم اكتشاف كابتشا — تدخّل وحلّها ثم اضغط متابعة", level: "warn" });
        onEvent({ type: "captcha", message: parsed.message ?? "حل الكابتشا ثم اضغط متابعة" });
        await captchaResolver();
        onEvent({ type: "captcha_solved" });
        onEvent({ type: "log", message: "تم — استمرار التنفيذ...", level: "info" });
        continue;
      }

      try {
        await executeAction(page, parsed, onEvent);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        onEvent({ type: "log", message: `تعذّر تنفيذ الإجراء: ${msg.slice(0, 100)}`, level: "warn" });
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
    activePages.delete(sessionId);
    await browser.close().catch(() => {});
    activeBrowser = null;
  }
}

async function executeAction(page: Page, action: GeminiAction, onEvent: (e: AgentEvent) => void) {
  switch (action.action) {
    case "navigate":
      if (action.url) {
        onEvent({ type: "log", message: `فتح: ${action.url}`, level: "info" });
        await page.goto(action.url, { waitUntil: "domcontentloaded", timeout: 30000 });
      }
      break;

    case "click":
      if (action.selector) {
        onEvent({ type: "log", message: `نقر على: ${action.selector}`, level: "info" });
        try {
          await page.click(action.selector, { timeout: 8000 });
        } catch {
          await page.locator(action.selector).first().click({ timeout: 8000 });
        }
      }
      break;

    case "type":
      if (action.selector && action.text !== undefined) {
        onEvent({ type: "log", message: `كتابة في: ${action.selector}`, level: "info" });
        try { await page.click(action.selector, { timeout: 5000 }); } catch {}
        await page.fill(action.selector, action.text, { timeout: 8000 });
      }
      break;

    case "press_key":
      if (action.key) {
        onEvent({ type: "log", message: `مفتاح: ${action.key}`, level: "info" });
        await page.keyboard.press(action.key);
      }
      break;

    case "scroll":
      await page.mouse.wheel(0, 400);
      break;

    case "hover":
      if (action.selector) {
        await page.hover(action.selector, { timeout: 5000 });
      }
      break;

    case "wait":
      onEvent({ type: "log", message: "انتظار...", level: "info" });
      await page.waitForTimeout(2000);
      break;
  }
}

function buildSystemPrompt(task: AgentTask): string {
  const base = `أنت مساعد أتمتة ديسكورد. تتحكم بمتصفح لإنجاز مهام على ديسكورد وDiscord Developer Portal.
تحصل على سكرين شوت للمتصفح وتقرر الخطوة القادمة.

أجب دائماً بـ JSON فقط بهذا الشكل:
{
  "action": "navigate"|"click"|"type"|"wait"|"done"|"captcha"|"scroll"|"press_key"|"hover",
  "selector": "CSS أو text selector",
  "text": "النص للكتابة",
  "url": "الرابط",
  "key": "اسم المفتاح",
  "message": "رسالة للمستخدم",
  "done_message": "رسالة الإتمام",
  "success": true|false
}

قواعد:
- رCAPTCHA/hCaptcha/reCAPTCHA في الصفحة → أرجع action:"captcha" فوراً
- تحقق بريد إلكتروني أو رمز → أرجع action:"captcha" مع رسالة توضح المطلوب
- استخدم selectors دقيقة: input[name="email"], button[type="submit"], text=Login
- للنصوص استخدم: :text("نص") أو role=button[name="نص"]
- عند اكتمال المهمة → action:"done" مع success:true
- عند فشل → action:"done" مع success:false
- خطوة واحدة في كل رد فقط`;

  if (task.kind === "login") {
    return `${base}

المهمة: تسجيل الدخول إلى حساب ديسكورد
الإيميل: ${task.email}
الباسوورد: ${task.password}
${task.twofaSecret ? `2FA Secret: ${task.twofaSecret}` : "لا يوجد 2FA"}

الخطوات:
1. افتح https://discord.com/login
2. أدخل الإيميل في حقل email
3. أدخل الباسوورد في حقل password
4. اضغط زر Log In
5. إذا طُلب 2FA: أدخل رمز TOTP من السر أعلاه
6. إذا طُلب تحقق بريد أو كابتشا → action:"captcha" مع شرح المطلوب
7. عند الوصول للصفحة الرئيسية لديسكورد → done بنجاح`;
  }

  if (task.kind === "create_bot") {
    return `${base}

المهمة: إنشاء تطبيق بوت في Discord Developer Portal
البوت: ${task.botName} | البادئة: ${task.prefix}
الإيميل: ${task.email}

الخطوات:
1. افتح https://discord.com/login وسجل دخول بـ ${task.email}
2. افتح https://discord.com/developers/applications
3. اضغط "New Application"
4. اكتب اسم التطبيق: ${task.botName}
5. وافق على الشروط واضغط Create
6. اذهب لقسم "Bot" من القائمة الجانبية
7. اضغط "Add Bot" أو "Reset Token"
8. وافق على أي تأكيد
9. انسخ التوكن من الصفحة
10. done مع رسالة تحتوي التوكن كاملاً`;
  }

  if (task.kind === "reset_token") {
    return `${base}

المهمة: إعادة تعيين توكن بوت
معرف التطبيق: ${task.appId}
الإيميل: ${task.email}

الخطوات:
1. افتح https://discord.com/login وسجل دخول
2. افتح https://discord.com/developers/applications/${task.appId}/bot
3. اضغط "Reset Token"
4. وافق على التأكيد
5. انسخ التوكن الجديد
6. done مع التوكن في الرسالة`;
  }

  return base;
}
