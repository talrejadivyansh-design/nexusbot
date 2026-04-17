export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const keys = [
    process.env.GROQ_API_KEY,
    process.env.GROQ_API_KEY_1,
    process.env.GROQ_API_KEY_2,
    process.env.GROQ_API_KEY_3,
    process.env.GROQ_API_KEY_4,
  ].filter(Boolean);

  const key = keys[Math.floor(Math.random() * keys.length)];
  if (!key) return res.status(500).json({ error: "No API keys configured" });

  const { messages, model } = req.body;

  if (!messages || !Array.isArray(messages)) {
    return res.status(400).json({ error: "Invalid request" });
  }

  const ip = req.headers['x-forwarded-for'] || 'unknown';
  const now = Date.now();
  if (!global.ipRequests) global.ipRequests = {};
  if (!global.ipRequests[ip]) global.ipRequests[ip] = [];
  global.ipRequests[ip] = global.ipRequests[ip].filter(t => now - t < 60000);
  if (global.ipRequests[ip].length >= 15) {
    return res.status(429).json({ error: "Too many requests! Please wait 1 minute." });
  }
  global.ipRequests[ip].push(now);

  const r = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": "Bearer " + key
    },
    body: JSON.stringify({
      model: model || "llama-3.3-70b-versatile",
      messages,
      max_tokens: 900,
      temperature: 0.8
    })
  });

  const data = await r.json();
  const reply = data.choices?.[0]?.message?.content || data.error?.message || "No reply";
  return res.status(200).json({ reply });
}
