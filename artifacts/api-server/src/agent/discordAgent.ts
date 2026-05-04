import { chromium, type Browser, type Page, type BrowserContext } from "playwright";
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
  action: "click" | "type" | "navigate" | "wait" | "done" | "captcha" | "scroll" | "press_key" | "hover" | "js_click";
  selector?: string;
  text?: string;
  url?: string;
  key?: string;
  message?: string;
  done_message?: string;
  success?: boolean;
  x?: number;
  y?: number;
}

let activeBrowser: Browser | null = null;

// Shared map: sessionId → live Page
export const activePages = new Map<string, Page>();

// Session cache: email → storage state JSON (cookies + localStorage)
const sessionCache = new Map<string, object>();

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

/** Move mouse along a bezier-curve path then click */
async function humanClick(page: Page, targetX: number, targetY: number) {
  const startX = Math.round(Math.random() * 400 + 200);
  const startY = Math.round(Math.random() * 200 + 200);
  const cp1x = startX + (targetX - startX) * 0.25 + (Math.random() - 0.5) * 80;
  const cp1y = startY + (targetY - startY) * 0.25 + (Math.random() - 0.5) * 80;
  const cp2x = startX + (targetX - startX) * 0.75 + (Math.random() - 0.5) * 60;
  const cp2y = startY + (targetY - startY) * 0.75 + (Math.random() - 0.5) * 60;
  const steps = 18 + Math.floor(Math.random() * 10);
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const mt = 1 - t;
    const x = Math.round(mt * mt * mt * startX + 3 * mt * mt * t * cp1x + 3 * mt * t * t * cp2x + t * t * t * targetX);
    const y = Math.round(mt * mt * mt * startY + 3 * mt * mt * t * cp1y + 3 * mt * t * t * cp2y + t * t * t * targetY);
    await page.mouse.move(x, y);
    const delay = i === 0 || i === steps ? 18 + Math.random() * 15 : 6 + Math.random() * 8;
    await new Promise((r) => setTimeout(r, delay));
  }
  const jx = targetX + Math.round((Math.random() - 0.5) * 3);
  const jy = targetY + Math.round((Math.random() - 0.5) * 3);
  await page.mouse.move(jx, jy);
  await new Promise((r) => setTimeout(r, 30 + Math.random() * 40));
  await page.mouse.down();
  await new Promise((r) => setTimeout(r, 60 + Math.random() * 80));
  await page.mouse.up();
}

export async function interactWithSession(
  sessionId: string,
  action:
    | { type: "click";    x: number; y: number }
    | { type: "mousedown"; x: number; y: number }
    | { type: "mousemove"; x: number; y: number }
    | { type: "mouseup";   x: number; y: number }
    | { type: "type";     text: string }
    | { type: "key";      key: string }
    | { type: "scroll";   deltaY: number }
): Promise<{ ok: boolean; screenshotAfter?: string }> {
  const page = activePages.get(sessionId);
  if (!page) return { ok: false };
  try {
    if (action.type === "click") {
      await page.mouse.move(action.x, action.y);
      await new Promise((r) => setTimeout(r, 30 + Math.random() * 30));
      await page.mouse.down();
      await new Promise((r) => setTimeout(r, 50 + Math.random() * 60));
      await page.mouse.up();
    } else if (action.type === "mousedown") {
      await page.mouse.move(action.x, action.y);
      await page.mouse.down();
    } else if (action.type === "mousemove") {
      await page.mouse.move(action.x, action.y);
    } else if (action.type === "mouseup") {
      await page.mouse.move(action.x, action.y);
      await page.mouse.up();
    } else if (action.type === "type") {
      for (const char of action.text) {
        await page.keyboard.type(char);
        await new Promise((r) => setTimeout(r, 35 + Math.random() * 55));
      }
    } else if (action.type === "key") {
      await page.keyboard.press(action.key);
    } else if (action.type === "scroll") {
      await page.mouse.wheel(0, action.deltaY);
    }
    if (action.type === "mousemove") return { ok: true };
    await new Promise((r) => setTimeout(r, 300));
    const buf = await page.screenshot({ type: "jpeg", quality: 72, fullPage: false });
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

/** Clear cached session for an email (e.g. on login failure) */
export function clearSessionCache(email: string) {
  sessionCache.delete(email);
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

  // Check if we have a cached session for this account
  const cachedState = sessionCache.get(task.email);
  let context: BrowserContext;

  if (cachedState && task.kind !== "login") {
    onEvent({ type: "log", message: "♻️ استخدام جلسة محفوظة — تخطي تسجيل الدخول", level: "success" });
    context = await browser.newContext({
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      viewport: { width: 1280, height: 800 },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      storageState: cachedState as any,
    });
  } else {
    context = await browser.newContext({
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      viewport: { width: 1280, height: 800 },
    });
  }

  const page = await context.newPage();
  activePages.set(sessionId, page);

  const systemPrompt = buildSystemPrompt(task, !!cachedState && task.kind !== "login");
  const history: string[] = [];

  try {
    onEvent({ type: "log", message: "جاري الاتصال بديسكورد...", level: "info" });

    const maxSteps = 50;
    let steps = 0;
    let loginDetected = false;

    while (steps < maxSteps) {
      steps++;

      await page.waitForTimeout(900);

      const screenshotBuffer = await page.screenshot({ type: "jpeg", quality: 65, fullPage: false });
      const screenshotBase64 = screenshotBuffer.toString("base64");
      onEvent({ type: "screenshot", data: screenshotBase64 });

      // Auto-detect successful login and save session
      const currentUrl = page.url();
      if (!loginDetected && (currentUrl.includes("discord.com/channels") || currentUrl.includes("discord.com/@me") || currentUrl.includes("discord.com/developers"))) {
        loginDetected = true;
        try {
          const state = await context.storageState();
          sessionCache.set(task.email, state);
          onEvent({ type: "log", message: "✅ تم حفظ جلسة الدخول — لن تحتاج لتسجيل دخول مجدداً", level: "success" });
        } catch {}
      }

      const historyText = history.length > 0
        ? `\nالخطوات السابقة:\n${history.slice(-10).join("\n")}`
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
                  text: `الرابط الحالي: ${currentUrl}\n${historyText}\n\nالمهمة: ${JSON.stringify(task)}\n\nانظر للسكرين شوت بدقة شديدة وقرر الخطوة القادمة. أجب بـ JSON فقط.`,
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
        // If login failed, clear the cached session
        if (parsed.success === false) {
          sessionCache.delete(task.email);
        }
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

/**
 * Smart click with multiple fallback strategies:
 * 1. Normal Playwright click
 * 2. Force click (bypass visibility checks)
 * 3. JavaScript click via evaluate
 * 4. Coordinate-based click (if x,y provided)
 */
async function smartClick(page: Page, selector: string, x?: number, y?: number): Promise<void> {
  // Strategy 1: Normal click
  try {
    await page.click(selector, { timeout: 5000 });
    return;
  } catch {}

  // Strategy 2: Try first matching locator
  try {
    await page.locator(selector).first().click({ timeout: 5000 });
    return;
  } catch {}

  // Strategy 3: Force click (bypass visibility/pointer-events checks)
  try {
    await page.locator(selector).first().click({ force: true, timeout: 5000 });
    return;
  } catch {}

  // Strategy 4: JavaScript click via evaluate
  try {
    await page.evaluate((sel) => {
      const el = document.querySelector(sel) as HTMLElement;
      if (el) { el.click(); return true; }
      return false;
    }, selector);
    await page.waitForTimeout(300);
    return;
  } catch {}

  // Strategy 5: Coordinate-based click if AI provided coordinates
  if (x !== undefined && y !== undefined) {
    await humanClick(page, x, y);
    return;
  }

  throw new Error(`لم يُعثر على العنصر: ${selector}`);
}

/**
 * Smart type with fallback strategies
 */
async function smartType(page: Page, selector: string, text: string): Promise<void> {
  // Strategy 1: Click then fill
  try {
    await page.click(selector, { timeout: 5000 });
    await page.fill(selector, text, { timeout: 5000 });
    return;
  } catch {}

  // Strategy 2: Locator fill
  try {
    const loc = page.locator(selector).first();
    await loc.fill(text, { timeout: 5000 });
    return;
  } catch {}

  // Strategy 3: Focus + clear + type
  try {
    await page.focus(selector);
    await page.evaluate((sel) => {
      const el = document.querySelector(sel) as HTMLInputElement;
      if (el) el.value = "";
    }, selector);
    await page.keyboard.type(text, { delay: 40 });
    return;
  } catch {}

  throw new Error(`لم يُعثر على حقل الإدخال: ${selector}`);
}

async function executeAction(page: Page, action: GeminiAction, onEvent: (e: AgentEvent) => void) {
  switch (action.action) {
    case "navigate":
      if (action.url) {
        onEvent({ type: "log", message: `فتح: ${action.url}`, level: "info" });
        await page.goto(action.url, { waitUntil: "domcontentloaded", timeout: 30000 });
        await page.waitForTimeout(1500);
      }
      break;

    case "click":
      if (action.selector) {
        onEvent({ type: "log", message: `نقر على: ${action.selector}`, level: "info" });
        await smartClick(page, action.selector, action.x, action.y);
      } else if (action.x !== undefined && action.y !== undefined) {
        onEvent({ type: "log", message: `نقر على إحداثيات: (${action.x}, ${action.y})`, level: "info" });
        await humanClick(page, action.x, action.y);
      }
      break;

    case "js_click":
      // Direct JavaScript click — for elements that resist normal clicking (checkboxes, hidden elements)
      if (action.selector) {
        onEvent({ type: "log", message: `JS نقر: ${action.selector}`, level: "info" });
        const clicked = await page.evaluate((sel) => {
          const el = document.querySelector(sel) as HTMLElement;
          if (el) { el.click(); return true; }
          // Try by text content
          const all = document.querySelectorAll("*");
          for (const node of all) {
            if (node.textContent?.trim() === sel) {
              (node as HTMLElement).click();
              return true;
            }
          }
          return false;
        }, action.selector);
        if (!clicked) {
          onEvent({ type: "log", message: `JS click: عنصر غير موجود، تخطي`, level: "warn" });
        }
      } else if (action.x !== undefined && action.y !== undefined) {
        await humanClick(page, action.x, action.y);
      }
      break;

    case "type":
      if (action.selector && action.text !== undefined) {
        onEvent({ type: "log", message: `كتابة في: ${action.selector}`, level: "info" });
        await smartType(page, action.selector, action.text);
      }
      break;

    case "press_key":
      if (action.key) {
        onEvent({ type: "log", message: `مفتاح: ${action.key}`, level: "info" });
        await page.keyboard.press(action.key);
      }
      break;

    case "scroll":
      await page.mouse.wheel(0, action.y ?? 400);
      break;

    case "hover":
      if (action.selector) {
        try {
          await page.hover(action.selector, { timeout: 5000 });
        } catch {
          onEvent({ type: "log", message: `hover: تخطي (غير مرئي)`, level: "warn" });
        }
      }
      break;

    case "wait":
      onEvent({ type: "log", message: "انتظار...", level: "info" });
      await page.waitForTimeout(2000);
      break;
  }
}

function buildSystemPrompt(task: AgentTask, hasSession: boolean): string {
  const base = `أنت مساعد أتمتة ديسكورد. تتحكم بمتصفح لإنجاز مهام على ديسكورد وDiscord Developer Portal.
تحصل على سكرين شوت للمتصفح وتقرر الخطوة القادمة.

أجب دائماً بـ JSON فقط بهذا الشكل:
{
  "action": "navigate"|"click"|"type"|"wait"|"done"|"captcha"|"scroll"|"press_key"|"hover"|"js_click",
  "selector": "CSS selector",
  "text": "النص للكتابة",
  "url": "الرابط",
  "key": "اسم المفتاح",
  "x": رقم_اختياري_إحداثية_X,
  "y": رقم_اختياري_إحداثية_Y,
  "message": "رسالة للمستخدم",
  "done_message": "رسالة الإتمام",
  "success": true|false
}

قواعد الـ selectors - مهمة جداً:
- انظر للسكرين شوت بدقة قبل اختيار الـ selector
- استخدم selectors بسيطة وموثوقة:
  * للأزرار: button[type="submit"] أو text="اسم الزر" أو role=button[name="نص"]
  * للـ inputs: input[type="email"] أو input[name="email"] أو input[placeholder="..."]
  * للـ checkboxes: استخدم action "js_click" مع selector "input[type=checkbox]" دائماً
  * للروابط: a:has-text("نص") أو text="نص الرابط"
- إذا لم تكن متأكداً من الـ selector، أضف x وy كإحداثيات احتياطية
- لا تستخدم selectors معقدة أو متداخلة
- إذا كان عنصر غير مرئي أو خارج الشاشة: استخدم scroll أولاً

قواعد عامة:
- CAPTCHA/hCaptcha/reCAPTCHA → أرجع action:"captcha" فوراً
- تحقق بريد إلكتروني → أرجع action:"captcha" مع شرح المطلوب
- عند اكتمال المهمة → action:"done" مع success:true
- عند فشل مؤكد → action:"done" مع success:false
- خطوة واحدة في كل رد فقط
- إذا رأيت نفس الصفحة مرتين متتاليتين بدون تغيير → جرب طريقة مختلفة أو استخدم إحداثيات`;

  if (task.kind === "login") {
    return `${base}

المهمة: تسجيل الدخول إلى حساب ديسكورد
الإيميل: ${task.email}
الباسوورد: ${task.password}
${task.twofaSecret ? `2FA Secret: ${task.twofaSecret}` : "لا يوجد 2FA"}

الخطوات المحددة:
1. navigate إلى https://discord.com/login
2. type في input[name="email"] أو input[type="email"] ← الإيميل
3. type في input[name="password"] أو input[type="password"] ← الباسوورد
4. click على button[type="submit"] أو الزر الأزرق "Log In"
5. انتظر تحميل الصفحة
6. إذا طُلب 2FA → أدخل رمز TOTP من السر (احسبه من السر)
7. إذا طُلب تحقق بريد أو كابتشا → action:"captcha"
8. عند الوصول للصفحة الرئيسية → done بنجاح`;
  }

  if (task.kind === "create_bot") {
    const loginSteps = hasSession
      ? `1. navigate مباشرةً إلى https://discord.com/developers/applications (الجلسة محفوظة — لا تسجل دخول)`
      : `1. navigate إلى https://discord.com/login وسجل دخول بـ ${task.email}
2. navigate إلى https://discord.com/developers/applications`;

    return `${base}

المهمة: إنشاء تطبيق بوت في Discord Developer Portal
البوت: ${task.botName} | البادئة: ${task.prefix}
الإيميل: ${task.email}
${hasSession ? "⚡ الجلسة محفوظة — تخطى تسجيل الدخول مباشرةً" : ""}

الخطوات المحددة:
${loginSteps}
- اضغط زر "New Application" (الزر الأزرق في أعلى اليمين)
- في حقل Name اكتب: ${task.botName}
- للـ Checkbox في نموذج الإنشاء: استخدم action "js_click" مع selector "input[type=checkbox]"
  إذا لم ينجح: استخدم إحداثيات تقريبية من السكرين شوت
- اضغط زر "Create" لإنشاء التطبيق
- بعد الإنشاء: اذهب لقسم "Bot" من القائمة الجانبية اليسرى
- اضغط "Add Bot" أو "Reset Token" للحصول على التوكن
- وافق على أي تأكيد
- انسخ التوكن من الصفحة
- done مع رسالة تحتوي التوكن كاملاً

ملاحظة مهمة للـ checkbox في نموذج "Create a new app":
- استخدم action: "js_click" مع selector: "input[type=checkbox]"
- أو استخدم action: "click" مع إضافة x,y من موقع الـ checkbox في السكرين شوت`;
  }

  if (task.kind === "reset_token") {
    const loginSteps = hasSession
      ? `1. navigate مباشرةً إلى https://discord.com/developers/applications/${task.appId}/bot`
      : `1. navigate إلى https://discord.com/login وسجل دخول
2. navigate إلى https://discord.com/developers/applications/${task.appId}/bot`;

    return `${base}

المهمة: إعادة تعيين توكن بوت
معرف التطبيق: ${task.appId}
الإيميل: ${task.email}
${hasSession ? "⚡ الجلسة محفوظة — تخطى تسجيل الدخول" : ""}

الخطوات المحددة:
${loginSteps}
- اضغط "Reset Token"
- وافق على أي تأكيد
- انسخ التوكن الجديد
- done مع التوكن في done_message`;
  }

  return base;
}
