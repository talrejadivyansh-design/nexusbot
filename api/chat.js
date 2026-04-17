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

// Check if message needs real time search
const lastMessage = messages[messages.length - 1].content.toLowerCase();
const needsCricket = ['cricket', 'ipl', 'score', 'match', 'wicket', 'run', 'batting', 'bowling', 'mi', 'csk', 'rcb', 'kkr', 'srh', 'dc', 'pbks', 'rr', 'lsg', 'gt'].some(w => lastMessage.includes(w));
const needsSearch = ['news', 'latest', 'today', 'current', 'recent', 'weather', 'price', '2026', 'अभी', 'आज', 'ताजा', 'खबर'].some(word => lastMessage.includes(word));

  let searchContext = '';

  if (needsCricket && process.env.CRIC_API_KEY) {
  try {
    const cricRes = await fetch(`https://api.cricapi.com/v1/cricScore?apikey=${process.env.CRIC_API_KEY}`);
    const cricData = await cricRes.json();
    if (cricData.data) {
      const relevantMatches = cricData.data.slice(0, 5);
      searchContext = '\n\nLIVE CRICKET SCORES:\n' +
        relevantMatches.map(m => `${m.t1} vs ${m.t2}: ${m.t1s || 'Yet to bat'} vs ${m.t2s || 'Yet to bat'} - ${m.status}`).join('\n') +
        '\n\nUse ONLY above live scores. Do not use training data for scores.';
    }
  } catch(e) { console.log('Cricket API failed:', e.message); }
}

if (!searchContext && needsSearch && process.env.TAVILY_API_KEY) {
    try {
      const searchRes = await fetch('https://api.tavily.com/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          api_key: process.env.TAVILY_API_KEY,
          query: messages[messages.length - 1].content + ' 2026 scorecard result highlights',
          search_depth: 'basic',
          max_results: 5
        })
      });
      const searchData = await searchRes.json();
      if (searchData.results) {
        searchContext = '\n\nREAL TIME SEARCH RESULTS:\n' +
          searchData.results.map(r => `- ${r.title}: ${r.content}`).join('\n') +
          '\n\nCRITICAL INSTRUCTION: Use ONLY the above real time search results to answer. Do NOT use your training data for any facts, scores, or news. If search results do not contain the answer, say "I could not find current information about this." Never make up or guess any scores, player names or match results.'
      }
    } catch(e) {
      console.log('Search failed:', e.message);
    }
  }

  const messagesWithContext = [...messages];
  if (searchContext) {
    messagesWithContext[messagesWithContext.length - 1] = {
      role: 'user',
      content: messages[messages.length - 1].content + searchContext
    };
  }

  const r = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": "Bearer " + key
    },
    body: JSON.stringify({
      model: model || "llama-3.3-70b-versatile",
      messages: messagesWithContext,
      max_tokens: 900,
      temperature: 0.8
    })
  });

  const data = await r.json();
  const reply = data.choices?.[0]?.message?.content || data.error?.message || "No reply";
  return res.status(200).json({ reply });
}
