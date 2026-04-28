import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

dotenv.config();

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();

app.use(cors());
app.use(express.json({ limit: "1mb" }));
app.use(express.static(join(__dirname, "dist")));

app.post("/api/next-action", async (req, res) => {
  try {
    const { system, messages } = req.body;

    if (!system || !messages) {
      return res.status(400).json({ error: "Missing system or messages" });
    }

    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      return res.status(500).json({ error: "ANTHROPIC_API_KEY not set" });
    }

    console.log("[NAO] Calling Anthropic API...");

    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-5",
        max_tokens: 1000,
        system,
        messages,
      }),
    });

    const raw = await response.text();
    console.log("[NAO] Status:", response.status);
    console.log("[NAO] Response (first 300):", raw.slice(0, 300));

    if (!response.ok) {
      return res.status(response.status).json({ error: raw.slice(0, 200) });
    }

    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      return res.status(500).json({ error: "Server returned non-JSON: " + raw.slice(0, 100) });
    }

    const text = data.content?.find(b => b.type === "text")?.text || "";
    console.log("[NAO] Text length:", text.length);

    if (!text) {
      return res.status(500).json({ error: "Empty text in response. Keys: " + Object.keys(data).join(", ") });
    }

    return res.json({ text, usedModel: "claude-sonnet-4-5", upgraded: false });

  } catch (error) {
    console.error("[NAO] Error:", error.message);
    return res.status(500).json({ error: error.message });
  }
});

app.get("*", (req, res) => {
  res.sendFile(join(__dirname, "dist", "index.html"));
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`[NAO] Server running on port ${PORT}`);
});
