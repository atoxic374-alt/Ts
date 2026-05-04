import { chromium, type Browser, type Page, type BrowserContext } from "playwright";
import { ai } from "@workspace/integrations-gemini-ai";

export type AgentEvent =
  | { type: "log"; message: string; level: "info" | "warn" | "error" | "success" }
  | { type: "screenshot"; data: string }
  | { type: "captcha"; message: string }
  | { type: "captcha_solved" }
  | { type: "action"; action: string; detail?: string }
  | { type: "done"; success: boolean; message: string }
  | { type: "error"; message: string }
  | { type: "paused" }
  | { type: "resumed" };

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

// ── Pause / Resume support ────────────────────────────────────────────────────
interface PauseState { paused: boolean; resumeResolve: (() => void) | null }
const pauseStates = new Map<string, PauseState>();

export function pauseSession(sessionId: string) {
  pauseStates.set(sessionId, { paused: true, resumeResolve: null });
}

export function resumeSession(sessionId: string) {
  const s = pauseStates.get(sessionId);
  if (s) { s.paused = false; s.resumeResolve?.(); s.resumeResolve = null; }
}

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
  // Resume any paused sessions so they can exit cleanly
  for (const [, ps] of pauseStates) { ps.paused = false; ps.resumeResolve?.(); }
  pauseStates.clear();
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

      // ── 0. Pause check ────────────────────────────────────────────────────
      if (pauseStates.get(sessionId)?.paused) {
        onEvent({ type: "paused" });
        await new Promise<void>((resolve) => {
          const ps = pauseStates.get(sessionId);
          if (ps) ps.resumeResolve = resolve;
          else resolve();
        });
        onEvent({ type: "resumed" });
        onEvent({ type: "log", message: "▶ استؤنف التنفيذ التلقائي", level: "success" });
        lastHash = 0;
        consecutiveNoChange = 0;
      }

      steps++;

      // ── 1. Wait for page to settle ────────────────────────────────────────
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

      // ── 3b. Auto-detect "Missing Access" / Discord error pages ──────────────
      try {
        const pageText = await page.evaluate(() => document.body?.innerText?.slice(0, 2000) ?? "");
        const missingAccess =
          pageText.includes("Missing Access") ||
          pageText.includes("50001") ||
          pageText.includes("missing access");

        if (missingAccess && currentUrl.includes("discord.com/developers")) {
          sessionCache.delete(task.email); // invalidate stale session
          onEvent({
            type: "log",
            message: "⛔ Missing Access (50001) — الحساب لا يملك صلاحية Developer Portal. تحقق من: (1) الهاتف مرتبط بالحساب، (2) الحساب ليس جديداً، (3) لم تتجاوز حد التطبيقات",
            level: "error",
          });
          onEvent({
            type: "captcha",
            message: "⛔ Missing Access — Discord يرفض الوصول لهذا الحساب.\n\nالأسباب الشائعة:\n• الحساب جديد (أقل من أسبوع)\n• لا يوجد هاتف مرتبط بالحساب\n• تجاوزت حد 25 تطبيق على الحساب\n• الحساب محظور من Developer Portal\n\nيمكنك تسجيل الدخول يدوياً والتحقق، أو اضغط إيقاف.",
          });
          await captchaResolver();
          onEvent({ type: "captcha_solved" });
          lastHash = 0;
          consecutiveNoChange = 0;
          continue;
        }
      } catch {}

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

// ── Discord-specific: click the terms/agreement checkbox ─────────────────────
// Discord Developer Portal uses a visually-hidden checkbox inside a label.
// The real input has opacity:0; the visible element is a sibling div.
// We must click the LABEL (or the visual div), not the input directly.
async function clickDiscordCheckbox(page: Page): Promise<boolean> {
  const result = await page.evaluate(() => {
    // Strategy A: click the label wrapping the checkbox
    const label = document.querySelector('label:has(input[type="checkbox"])') as HTMLElement | null;
    if (label) { label.click(); return "label"; }

    // Strategy B: click any visible checkbox-like div (Discord's custom UI)
    const checkboxDiv = document.querySelector('input[type="checkbox"] + div, input[type="checkbox"] ~ div') as HTMLElement | null;
    if (checkboxDiv) { checkboxDiv.click(); return "sibling-div"; }

    // Strategy C: force-check the input via JS property + dispatch events
    const input = document.querySelector('input[type="checkbox"]') as HTMLInputElement | null;
    if (input) {
      input.checked = true;
      input.dispatchEvent(new Event("change", { bubbles: true }));
      input.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      return "input-forced";
    }

    // Strategy D: click any element containing "agree" or "terms" text nearby
    const allEls = document.querySelectorAll('div, span, label');
    for (const el of allEls) {
      const txt = (el as HTMLElement).textContent?.toLowerCase() ?? "";
      if ((txt.includes("agree") || txt.includes("terms")) && (el as HTMLElement).offsetWidth < 60) {
        (el as HTMLElement).click();
        return "text-match";
      }
    }

    return null;
  });

  if (result) {
    await page.waitForTimeout(300);
    return true;
  }
  return false;
}

// ── Click element by visible text content (most reliable for Discord UI) ──────
async function clickByText(page: Page, text: string, x?: number, y?: number): Promise<boolean> {
  const t = text.trim();

  // Strategy A: Playwright getByText — picks nearest to provided coords
  try {
    const loc = page.getByText(t, { exact: false });
    const count = await loc.count();
    if (count > 0) {
      if (count > 1 && x !== undefined && y !== undefined) {
        let best = 0, minDist = Infinity;
        for (let i = 0; i < count; i++) {
          const box = await loc.nth(i).boundingBox();
          if (box) {
            const d = Math.hypot(box.x + box.width / 2 - x, box.y + box.height / 2 - y);
            if (d < minDist) { minDist = d; best = i; }
          }
        }
        await loc.nth(best).click({ timeout: 3000 });
      } else {
        await loc.first().click({ timeout: 3000 });
      }
      await page.waitForTimeout(200);
      return true;
    }
  } catch {}

  // Strategy B: getByRole button
  try {
    const loc = page.getByRole("button", { name: t, exact: false });
    if (await loc.count() > 0) { await loc.first().click({ timeout: 3000 }); await page.waitForTimeout(200); return true; }
  } catch {}

  // Strategy C: getByRole link
  try {
    const loc = page.getByRole("link", { name: t, exact: false });
    if (await loc.count() > 0) { await loc.first().click({ timeout: 3000 }); await page.waitForTimeout(200); return true; }
  } catch {}

  // Strategy D: full DOM scan — find clickable with matching text, pick closest to coords
  try {
    const pos = await page.evaluate(({ txt, px, py }: { txt: string; px: number; py: number }) => {
      const candidates = document.querySelectorAll(
        'button, a, [role="button"], [role="link"], [role="menuitem"], [role="option"], [class*="btn"], [class*="Btn"], div[tabindex], span[tabindex]'
      );
      let best: { x: number; y: number } | null = null;
      let bestScore = Infinity;
      for (const el of candidates) {
        const elTxt = (el as HTMLElement).innerText?.trim().toLowerCase() ?? "";
        if (!elTxt.includes(txt.toLowerCase())) continue;
        (el as HTMLElement).scrollIntoView({ behavior: "instant", block: "center" });
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) continue;
        const cx = r.left + r.width / 2;
        const cy = r.top + r.height / 2;
        const dist = px >= 0 ? Math.hypot(cx - px, cy - py) : 0;
        if (dist < bestScore) { bestScore = dist; best = { x: Math.round(cx), y: Math.round(cy) }; }
      }
      return best;
    }, { txt: t, px: x ?? -1, py: y ?? -1 });

    if (pos) {
      await page.mouse.move(pos.x, pos.y);
      await page.waitForTimeout(60);
      await page.mouse.click(pos.x, pos.y);
      await page.waitForTimeout(200);
      return true;
    }
  } catch {}

  return false;
}

// ── Extract text from a selector that embeds text patterns ───────────────────
function extractTextFromSelector(selector: string): string | null {
  const m =
    selector.match(/:text\("([^"]+)"\)/) ||
    selector.match(/:text\('([^']+)'\)/) ||
    selector.match(/text="([^"]+)"/) ||
    selector.match(/text='([^']+)'/) ||
    selector.match(/:has-text\("([^"]+)"\)/) ||
    selector.match(/:has-text\('([^']+)'\)/);
  return m ? m[1] : null;
}

// ── Smart click: coordinate-first when available, then text, then selector ────
async function smartClick(page: Page, selector: string, x?: number, y?: number): Promise<void> {
  // Special case: checkbox — dedicated handler
  if (selector.includes("checkbox")) {
    const handled = await clickDiscordCheckbox(page);
    if (handled) return;
    if (x !== undefined && y !== undefined) { await humanClick(page, x, y); return; }
  }

  // ── PRIORITY 1: Coordinate click — trust the AI's eyes first ─────────────
  // When AI provides x,y from the screenshot, it SAW the element there.
  // Click those coordinates immediately without wasting time on selector guessing.
  if (x !== undefined && y !== undefined) {
    try {
      await page.mouse.move(x, y);
      await page.waitForTimeout(60);
      await page.mouse.click(x, y);
      await page.waitForTimeout(250);
      return;
    } catch {}
  }

  // ── PRIORITY 2: Text-based click ─────────────────────────────────────────
  // If selector contains text patterns, or looks like a label, find it by text
  const embeddedText = extractTextFromSelector(selector);
  if (embeddedText) {
    const done = await clickByText(page, embeddedText, x, y);
    if (done) return;
  }

  // ── PRIORITY 3: Scroll into view then normal Playwright locator ───────────
  try {
    await page.evaluate((sel) => {
      const el = document.querySelector(sel);
      if (el) el.scrollIntoView({ behavior: "instant", block: "center" });
    }, selector);
    await page.waitForTimeout(120);
  } catch {}

  try {
    await page.locator(selector).first().waitFor({ state: "visible", timeout: 1500 });
    await page.locator(selector).first().click({ timeout: 2500 });
    return;
  } catch {}

  // Force click
  try { await page.locator(selector).first().click({ force: true, timeout: 2000 }); return; } catch {}

  // ── PRIORITY 4: JS MouseEvent dispatch ───────────────────────────────────
  try {
    const clicked = await page.evaluate((sel) => {
      const el = document.querySelector(sel) as HTMLElement | null;
      if (!el) return false;
      el.scrollIntoView({ behavior: "instant", block: "center" });
      const r = el.getBoundingClientRect();
      const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
      ["mouseover", "mouseenter", "mousedown", "mouseup", "click"].forEach((e) =>
        el.dispatchEvent(new MouseEvent(e, { bubbles: true, cancelable: true, clientX: cx, clientY: cy }))
      );
      return true;
    }, selector);
    if (clicked) { await page.waitForTimeout(200); return; }
  } catch {}

  // ── PRIORITY 5: getBoundingClientRect → mouse.click ──────────────────────
  try {
    const pos = await page.evaluate((sel) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      el.scrollIntoView({ behavior: "instant", block: "center" });
      const r = el.getBoundingClientRect();
      if (r.width === 0) return null;
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
    }, selector);
    if (pos) { await page.mouse.click(pos.x, pos.y); await page.waitForTimeout(200); return; }
  } catch {}

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

    case "click": {
      const hasCoords = action.x !== undefined && action.y !== undefined;
      const hasSelector = !!action.selector;

      if (hasCoords && !hasSelector) {
        // Pure coordinate click — fastest path
        onEvent({ type: "log", message: `نقر إحداثيات: (${action.x}, ${action.y})`, level: "info" });
        await humanClick(page, action.x!, action.y!);
      } else if (hasSelector) {
        onEvent({ type: "log", message: `نقر: ${action.selector}${hasCoords ? ` @ (${action.x},${action.y})` : ""}`, level: "info" });
        // If message contains text hint, try clickByText first as extra help
        const msgText = action.message?.trim();
        if (msgText && msgText.length < 60 && !msgText.includes("http")) {
          const byText = await clickByText(page, msgText, action.x, action.y).catch(() => false);
          if (byText) break;
        }
        await smartClick(page, action.selector!, action.x, action.y);
      }
      break;
    }

    case "js_click": {
      if (action.selector) {
        onEvent({ type: "log", message: `JS نقر: ${action.selector}${action.x !== undefined ? ` @ (${action.x},${action.y})` : ""}`, level: "info" });

        // Checkbox — dedicated handler
        if (action.selector.includes("checkbox")) {
          const handled = await clickDiscordCheckbox(page);
          if (handled) {
            onEvent({ type: "log", message: `✓ تم الضغط على الـ checkbox`, level: "success" });
          } else if (action.x !== undefined && action.y !== undefined) {
            await humanClick(page, action.x, action.y);
          }
          break;
        }

        // Coordinates first
        if (action.x !== undefined && action.y !== undefined) {
          await page.mouse.click(action.x, action.y);
          await page.waitForTimeout(200);
          break;
        }

        // JS evaluate click
        const clicked = await page.evaluate((sel) => {
          const el = document.querySelector(sel) as HTMLElement | null;
          if (el) { el.scrollIntoView({ behavior: "instant", block: "center" }); el.click(); return true; }
          return false;
        }, action.selector);
        if (!clicked) {
          // Try by text if we have message
          const msgText = action.message?.trim();
          if (msgText) await clickByText(page, msgText, action.x, action.y);
        }
      } else if (action.x !== undefined && action.y !== undefined) {
        await humanClick(page, action.x, action.y);
      }
      break;
    }

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

السكرين شوت المُرسل دقيق ويعكس الحالة الفعلية الآن. انظر إليه بعناية شديدة قبل كل قرار.

أجب بـ JSON فقط (لا نص خارج JSON):
{
  "action": "navigate"|"click"|"type"|"wait"|"done"|"captcha"|"scroll"|"press_key"|"hover"|"js_click",
  "selector": "CSS selector أو نص",
  "text": "النص للكتابة",
  "url": "الرابط",
  "key": "المفتاح",
  "x": رقم_إلزامي_للنقر,
  "y": رقم_إلزامي_للنقر,
  "message": "نص الزر أو العنصر المراد الضغط عليه",
  "done_message": "رسالة النهاية",
  "success": true|false
}

══════ قاعدة النقر الأهم ══════
عند أي action:"click" أو "js_click":
• x و y إلزاميان دائماً — انظر للسكرين شوت وحدد الإحداثيات الدقيقة للعنصر
• النظام سيضغط الإحداثيات أولاً فوراً (أسرع وأدق من الـ selector)
• ضع نص الزر/العنصر في حقل "message" (مثال: "message": "New Application")
• إذا كانت الصورة 1280×800، الإحداثيات هي الموضع الفعلي بالبيكسل

مثال صحيح للضغط على زر "New Application" في أعلى اليمين:
{"action":"click","selector":"button","message":"New Application","x":543,"y":52}

══════ قواعد المحددات (selector) ══════
• input[type="email"] — حقل البريد
• input[type="password"] — حقل الباسوورد  
• button[type="submit"] — زر إرسال
• للـ checkboxes: action:"js_click" + selector:"input[type=checkbox]" + x,y من موقعه

══════ قواعد Checkbox ديسكورد ══════
• Discord يخفي الـ checkbox — الشكل المرئي div أو svg
• الحل: action:"js_click" + selector:"input[type=checkbox]" + x,y إلزامي

══════ قواعد عامة ══════
• السجل "لا تغيير" مرتين → جرّب x,y مختلفة أو selector مختلف
• CAPTCHA/hCaptcha → action:"captcha" فوراً
• تحقق بريد إلكتروني → action:"captcha"
• الإتمام → done:true | فشل مؤكد → done:false
• خطوة واحدة فقط في كل رد`;

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
• اضغط "New Application" — الزر الأزرق في أعلى يمين الصفحة. أعطِ x,y من موقعه في الصورة
• في حقل Name: اكتب "${task.botName}"
• للـ Checkbox (الموافقة على الشروط): js_click + selector:"input[type=checkbox]" + x,y من موقعه
• اضغط "Create"
• بعد الإنشاء: اذهب لـ "Bot" من القائمة اليسرى
• اضغط "Reset Token" ثم وافق
• انسخ التوكن → done:true مع التوكن في done_message

تحذيرات:
• إذا رأيت "Missing Access" أو "50001" → action:"captcha" مع شرح المشكلة
• إذا طُلب تحقق إضافي → action:"captcha"
• إذا رأيت نافذة "Add Bot" بدل "Reset Token" → اضغطها أيضاً`;
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
