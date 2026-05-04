import { Router, type IRouter } from "express";
import { ai } from "@workspace/integrations-gemini-ai";
import { AiChatBody } from "@workspace/api-zod";

const router: IRouter = Router();

router.post("/ai/chat", async (req, res) => {
  const body = AiChatBody.parse(req.body);

  const systemPrompt = `You are an AI assistant specializing in Discord bot automation and account management. 
You help users with:
- Creating and managing Discord bots (tokens, prefixes, permissions)
- Account management strategies
- Automation workflows and timing
- Troubleshooting captchas and verification challenges
- Best practices for Discord automation

Be concise, practical, and technical. Always provide actionable steps.
${body.context ? `\nCurrent context: ${body.context}` : ""}`;

  const response = await ai.models.generateContent({
    model: "gemini-2.5-flash",
    contents: [
      {
        role: "user",
        parts: [{ text: body.message }],
      },
    ],
    config: {
      systemInstruction: systemPrompt,
      maxOutputTokens: 8192,
    },
  });

  const reply = response.text ?? "Sorry, I could not generate a response.";

  const suggestions: string[] = [];
  if (body.message.toLowerCase().includes("captcha")) {
    suggestions.push("Use a CAPTCHA solving service API");
    suggestions.push("Add longer delays between actions");
    suggestions.push("Use residential proxies to avoid detection");
  }
  if (body.message.toLowerCase().includes("token") || body.message.toLowerCase().includes("bot")) {
    suggestions.push("Rotate tokens regularly to avoid bans");
    suggestions.push("Store tokens securely — never share them");
    suggestions.push("Use the bot prefix for easy identification");
  }
  if (body.message.toLowerCase().includes("account")) {
    suggestions.push("Enable 2FA on all accounts for security");
    suggestions.push("Use unique emails per account");
    suggestions.push("Keep account credentials encrypted");
  }

  res.json({ reply, suggestions: suggestions.slice(0, 3) });
});

export default router;
