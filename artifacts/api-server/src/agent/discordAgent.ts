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

interface HistoryEntry {
  step: number;
  action: string;
  detail: string;
  pageChanged: boolean;
  url: string;
}

let activeBrowser: Browser | null = null;
export const activePages = new Map<string, Page>();
const sessionCache = new Map<string, object>();

export async function getSessionScreenshot(sessionId: string): Promise<string | null> {
  const page = activePages.get(sessionId);
  if (!page) return null;
  try {
    const buf = await page.screenshot({ type: "jpeg", quality: 55, fullPage: false });
    return buf.toString("base64");
  } catch {
    return null;
  }
}

/**
 * Fast page change detection using a lightweight pixel sample.
 * Returns a simple numeric hash from a few dozen pixels.
 */
function quickHash(buf: Buffer): number {
  let h = 0;
  const step = Math.max(1, Math.floor(buf.length / 64));
  for (let i = 0; i < buf.length; i += step) {
    h = (h * 31 + buf[i]) >>> 0;
  }
  return h;
}

/**
 * Take a fast low-quality screenshot for change detection only.
 */
async function fastShot(page: Page): Promise<{ buf: Buffer; hash: number }> {
  const buf = await page.screenshot({ type: "jpeg", quality: 30, fullPage: false });
  return { buf, hash: quickHash(buf) };
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
    | { type: "click"; x: number; y: number }
    | { type: "mousedown"; x: number; y: number }
    | { type: "mousemove"; x: number; y: number }
    | { type: "mouseup"; x: number; y: number }
    | { type: "type"; text: string }
    | { type: "key"; key: string }
    | { type: "scroll"; deltaY: number }
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

  const cachedState = sessionCache.get(task.email);
  let context: BrowserContext;

  if (cachedState && task.kind !== "login") {
    onEvent({ type: "log", message: "♻️ استخدام جلسة محفوظة — تخطي تسجيل الدخول", level: "success" });
    context = await browser.newContext({
      userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      viewport: { width: 1280, height: 800 },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      storageState: cachedState as any,
    });
  } else {
    context = await browser.newContext({
      userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      viewport: { width: 1280, height: 800 },
    });
  }

  const page = await context.newPage();
  activePages.set(sessionId, page);

  const systemPrompt = buildSystemPrompt(task, !!cachedState && task.kind !== "login");
  const history: HistoryEntry[] = [];

  // Last screenshot hash for change detection
  let lastHash = 0;
  let consecutiveNoChange = 0;

  try {
    onEvent({ type: "log", message: "جاري الاتصال بديسكورد...", level: "info" });

    const maxSteps = 55;
    let steps = 0;
    let loginDetected = false;

    while (steps < maxSteps) {
      steps++;

      // ── 1. Wait for page to settle (shorter than before) ─────────────────
      await page.waitForTimeout(550);

      // ── 2. Take main screenshot (higher quality for AI vision) ────────────
      const screenshotBuffer = await page.screenshot({ type: "jpeg", quality: 60, fullPage: false });
      const screenshotBase64 = screenshotBuffer.toString("base64");
      const currentHash = quickHash(screenshotBuffer);
      onEvent({ type: "screenshot", data: screenshotBase64 });

      const currentUrl = page.url();

      // ── 3. Auto-save session on successful login ──────────────────────────
      if (!loginDetected && (
        currentUrl.includes("discord.com/channels") ||
        currentUrl.includes("discord.com/@me") ||
        currentUrl.includes("discord.com/developers")
      )) {
        loginDetected = true;
        try {
          const state = await context.storageState();
          sessionCache.set(task.email, state);
          onEvent({ type: "log", message: "✅ جلسة محفوظة — لن تحتاج تسجيل دخول مجدداً", level: "success" });
        } catch {}
      }

      // ── 4. Build rich history context ─────────────────────────────────────
      const pageChangedFromLast = lastHash !== 0 && currentHash !== lastHash;
      lastHash = currentHash;

      // Build history summary for AI (last 8 steps)
      const historyLines = history.slice(-8).map((h) =>
        `خطوة ${h.step}: [${h.action}] ${h.detail} — ${h.pageChanged ? "✓ الصفحة تغيرت" : "✗ لا تغيير في الصفحة"} | URL: ${h.url}`
      );
      const historyText = historyLines.length > 0
        ? `\nسجل الخطوات (آخر ${historyLines.length}):\n${historyLines.join("\n")}`
        : "";

      // Warn AI if nothing changed for 2+ steps
      const stuckWarning = consecutiveNoChange >= 2
        ? `\n⚠️ تحذير: آخر ${consecutiveNoChange} خطوات لم تغير الصفحة. جرّب طريقة مختلفة تماماً (selector مختلف أو إحداثيات أو js_click).`
        : "";

      // ── 5. Ask AI for next action ─────────────────────────────────────────
      let response;
      try {
        response = await ai.models.generateContent({
          model: "gemini-2.5-flash",
          contents: [
            {
              role: "user",
              parts: [
                {
                  inlineData: { mimeType: "image/jpeg", data: screenshotBase64 },
                },
                {
                  text: [
                    `الرابط الحالي: ${currentUrl}`,
                    `الخطوة: ${steps}/${maxSteps}`,
                    historyText,
                    stuckWarning,
                    `\nالمهمة: ${JSON.stringify(task)}`,
                    `\nانظر للسكرين شوت بعناية فائقة. هذه الصورة حديثة وتعكس الحالة الفعلية الآن.`,
                    `قرر الخطوة التالية وأجب بـ JSON فقط.`,
                  ].join("\n"),
                },
              ],
            },
          ],
          config: {
            systemInstruction: systemPrompt,
            maxOutputTokens: 512,
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

      const actionDetail = parsed.selector ?? parsed.url ?? parsed.text ?? parsed.message ?? "";
      onEvent({ type: "action", action: parsed.action, detail: actionDetail });

      // ── 6. Handle terminal actions ────────────────────────────────────────
      if (parsed.action === "done") {
        const msg = parsed.done_message ?? "اكتملت المهمة بنجاح!";
        if (parsed.success === false) sessionCache.delete(task.email);
        onEvent({ type: "log", message: msg, level: parsed.success !== false ? "success" : "error" });
        onEvent({ type: "done", success: parsed.success !== false, message: msg });
        break;
      }

      if (parsed.action === "captcha") {
        onEvent({ type: "log", message: "كابتشا مطلوبة — تدخّل وحلّها ثم اضغط متابعة", level: "warn" });
        onEvent({ type: "captcha", message: parsed.message ?? "حل الكابتشا ثم اضغط متابعة" });
        await captchaResolver();
        onEvent({ type: "captcha_solved" });
        onEvent({ type: "log", message: "تم — استمرار التنفيذ...", level: "info" });
        lastHash = 0; // reset change detection after captcha
        consecutiveNoChange = 0;
        continue;
      }

      // ── 7. Execute action + measure page change ───────────────────────────
      const preActionShot = await fastShot(page);

      try {
        await executeAction(page, parsed, onEvent);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        onEvent({ type: "log", message: `تعذّر التنفيذ: ${msg.slice(0, 100)}`, level: "warn" });
      }

      // Wait briefly and check if page changed
      await page.waitForTimeout(380);
      const postActionShot = await fastShot(page);
      const pageChanged = preActionShot.hash !== postActionShot.hash;

      if (pageChanged) {
        consecutiveNoChange = 0;
        // Send the fresh post-action screenshot to UI immediately
        const freshBuf = await page.screenshot({ type: "jpeg", quality: 60, fullPage: false });
        onEvent({ type: "screenshot", data: freshBuf.toString("base64") });
        lastHash = quickHash(freshBuf);
      } else {
        consecutiveNoChange++;
        if (consecutiveNoChange >= 2) {
          onEvent({ type: "log", message: `⚠️ لا تغيير بعد ${consecutiveNoChange} خطوات — الـ AI سيجرب طريقة مختلفة`, level: "warn" });
        }
      }

      // Record history
      history.push({
        step: steps,
        action: parsed.action,
        detail: actionDetail,
        pageChanged,
        url: currentUrl,
      });
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

// ── Smart click with 5-strategy fallback ─────────────────────────────────────
async function smartClick(page: Page, selector: string, x?: number, y?: number): Promise<void> {
  // 1. Normal click
  try { await page.click(selector, { timeout: 4000 }); return; } catch {}
  // 2. First locator
  try { await page.locator(selector).first().click({ timeout: 4000 }); return; } catch {}
  // 3. Force click
  try { await page.locator(selector).first().click({ force: true, timeout: 4000 }); return; } catch {}
  // 4. JS click
  try {
    const clicked = await page.evaluate((sel) => {
      const el = document.querySelector(sel) as HTMLElement | null;
      if (el) { el.click(); return true; }
      return false;
    }, selector);
    if (clicked) { await page.waitForTimeout(200); return; }
  } catch {}
  // 5. Coordinate-based
  if (x !== undefined && y !== undefined) {
    await humanClick(page, x, y); return;
  }
  throw new Error(`لم يُعثر على العنصر: ${selector}`);
}

// ── Smart type with fallback ──────────────────────────────────────────────────
async function smartType(page: Page, selector: string, text: string): Promise<void> {
  // 1. Click + fill
  try {
    await page.click(selector, { timeout: 4000 });
    await page.fill(selector, text, { timeout: 4000 });
    return;
  } catch {}
  // 2. Locator fill
  try { await page.locator(selector).first().fill(text, { timeout: 4000 }); return; } catch {}
  // 3. Focus + keyboard
  try {
    await page.focus(selector);
    await page.evaluate((sel) => { const el = document.querySelector(sel) as HTMLInputElement | null; if (el) el.value = ""; }, selector);
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
        // Extra settle time for navigation
        await page.waitForTimeout(1200);
      }
      break;

    case "click":
      if (action.selector) {
        onEvent({ type: "log", message: `نقر: ${action.selector}`, level: "info" });
        await smartClick(page, action.selector, action.x, action.y);
      } else if (action.x !== undefined && action.y !== undefined) {
        onEvent({ type: "log", message: `نقر إحداثيات: (${action.x}, ${action.y})`, level: "info" });
        await humanClick(page, action.x, action.y);
      }
      break;

    case "js_click":
      if (action.selector) {
        onEvent({ type: "log", message: `JS نقر: ${action.selector}`, level: "info" });
        const clicked = await page.evaluate((sel) => {
          const el = document.querySelector(sel) as HTMLElement | null;
          if (el) { el.click(); return true; }
          return false;
        }, action.selector);
        if (!clicked && action.x !== undefined && action.y !== undefined) {
          await humanClick(page, action.x, action.y);
        } else if (!clicked) {
          onEvent({ type: "log", message: `js_click: العنصر غير موجود، تخطي`, level: "warn" });
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
        try { await page.hover(action.selector, { timeout: 4000 }); }
        catch { onEvent({ type: "log", message: `hover: تخطي`, level: "warn" }); }
      }
      break;

    case "wait":
      onEvent({ type: "log", message: "انتظار...", level: "info" });
      await page.waitForTimeout(1800);
      break;
  }
}

// ── System prompt builder ─────────────────────────────────────────────────────
function buildSystemPrompt(task: AgentTask, hasSession: boolean): string {
  const base = `أنت مساعد أتمتة ديسكورد محترف. تتحكم بمتصفح حقيقي لإنجاز مهام على ديسكورد وDiscord Developer Portal.

السكرين شوت المُرسل إليك حديث جداً ويعكس الحالة الفعلية للمتصفح الآن. لا تفترض أي شيء خارج ما تراه.

أجب بـ JSON فقط:
{
  "action": "navigate"|"click"|"type"|"wait"|"done"|"captcha"|"scroll"|"press_key"|"hover"|"js_click",
  "selector": "CSS selector",
  "text": "النص",
  "url": "الرابط",
  "key": "المفتاح",
  "x": رقم_اختياري,
  "y": رقم_اختياري,
  "message": "رسالة",
  "done_message": "رسالة النهاية",
  "success": true|false
}

قواعد الـ selectors (مهمة جداً):
• انظر للسكرين شوت قبل اختيار أي selector — فقط استخدم عناصر تراها فعلاً
• للأزرار: button[type="submit"] أو :text("نص الزر") أو role=button[name="نص"]
• للـ inputs: input[type="email"] أو input[name="email"]
• للـ checkboxes: استخدم action "js_click" دائماً مع input[type=checkbox]
• أضف x,y من موقع العنصر في الصورة كـ احتياطي دائماً

قواعد عامة:
• إذا كان السجل يقول "لا تغيير" لنفس الخطوة — جرّب selector مختلف أو إحداثيات أو js_click
• CAPTCHA/hCaptcha → action:"captcha" فوراً
• تحقق بريد إلكتروني → action:"captcha" مع شرح
• عند الإتمام → done:true | عند فشل مؤكد → done:false
• خطوة واحدة فقط في كل رد
• لا تكرر نفس الـ action بنفس الـ selector إذا فشل مرتين`;

  if (task.kind === "login") {
    return `${base}

المهمة: تسجيل الدخول إلى ديسكورد
البريد: ${task.email}
الباسوورد: ${task.password}
${task.twofaSecret ? `2FA: ${task.twofaSecret}` : "لا يوجد 2FA"}

الخطوات:
1. navigate → https://discord.com/login
2. type → input[name="email"] ← البريد الإلكتروني
3. type → input[name="password"] ← الباسوورد
4. click → button[type="submit"] أو الزر الأزرق
5. إذا 2FA → أدخل رمز TOTP
6. إذا كابتشا/تحقق بريد → captcha
7. عند الوصول للرئيسية → done:true`;
  }

  if (task.kind === "create_bot") {
    const step1 = hasSession
      ? `1. navigate مباشرةً → https://discord.com/developers/applications`
      : `1. navigate → https://discord.com/login ثم سجّل دخول بـ ${task.email}
2. navigate → https://discord.com/developers/applications`;

    return `${base}

المهمة: إنشاء بوت في Discord Developer Portal
اسم البوت: ${task.botName} | البادئة: ${task.prefix}
${hasSession ? "⚡ جلسة محفوظة — تخطى تسجيل الدخول" : `البريد: ${task.email}`}

الخطوات:
${step1}
• اضغط "New Application" (الزر الأزرق اليمين العلوي)
• في حقل Name: اكتب "${task.botName}"
• للـ Checkbox في نموذج الإنشاء: استخدم js_click مع selector "input[type=checkbox]"
• اضغط "Create"
• بعد الإنشاء: اذهب لـ "Bot" من القائمة اليسرى
• اضغط "Add Bot" أو "Reset Token"
• وافق على التأكيدات
• انسخ التوكن → done:true مع التوكن في done_message`;
  }

  if (task.kind === "reset_token") {
    const step1 = hasSession
      ? `1. navigate → https://discord.com/developers/applications/${task.appId}/bot`
      : `1. navigate → https://discord.com/login ثم سجّل دخول
2. navigate → https://discord.com/developers/applications/${task.appId}/bot`;

    return `${base}

المهمة: إعادة تعيين توكن
التطبيق: ${task.appId}
${hasSession ? "⚡ جلسة محفوظة" : `البريد: ${task.email}`}

الخطوات:
${step1}
• اضغط "Reset Token"
• وافق على التأكيد
• انسخ التوكن الجديد → done:true مع التوكن في done_message`;
  }

  return base;
}
