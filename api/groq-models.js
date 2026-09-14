// Temporary diagnostic endpoint: lists the models actually available to this
// Groq account/key, so we can see which vision-capable model to use instead
// of guessing at candidate IDs that keep getting deprecated.

export default async function handler(req, res) {
  const keys = [
    process.env.GROQ_API_KEY,
    process.env.GROQ_API_KEY_1,
    process.env.GROQ_API_KEY_2,
    process.env.GROQ_API_KEY_3,
    process.env.GROQ_API_KEY_4,
  ].filter(Boolean);
  const key = keys[0];
  if (!key) return res.status(500).json({ error: "No API keys configured" });

  try {
    const r = await fetch("https://api.groq.com/openai/v1/models", {
      headers: { Authorization: "Bearer " + key },
    });
    const data = await r.json();
    if (!r.ok) return res.status(502).json(data);
    const ids = (data.data || []).map((m) => m.id).sort();
    return res.status(200).json({ count: ids.length, ids });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
