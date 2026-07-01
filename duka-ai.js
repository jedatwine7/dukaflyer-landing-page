// /api/duka-ai.js
// Server-side proxy to Gemini so the API key never touches the browser.
// Env var needed in Vercel: GEMINI_API_KEY

const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3-flash-preview';
const FALLBACK_MODEL = process.env.GEMINI_FALLBACK_MODEL || 'gemini-flash-latest';

function geminiUrl(model) {
  return `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
}

// Calls Gemini with the primary model; if it 404s (model renamed/retired),
// automatically retries once against the fallback alias so the feature
// doesn't go down while waiting for a manual env var fix.
async function callGemini(body) {
  let res = await fetch(`${geminiUrl(GEMINI_MODEL)}?key=${process.env.GEMINI_API_KEY}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });

  if (res.status === 404) {
    console.error(`Gemini model "${GEMINI_MODEL}" returned 404, retrying with fallback "${FALLBACK_MODEL}"`);
    res = await fetch(`${geminiUrl(FALLBACK_MODEL)}?key=${process.env.GEMINI_API_KEY}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
  }

  return res;
}

const CATEGORIES = [
  'Fashion & Clothing', 'Food & Drinks', 'Electronics', 'Beauty & Cosmetics',
  'Furniture & Home', 'Phones & Accessories', 'Groceries', 'Pharmacy & Health',
  'Hardware & Building', 'Agriculture', 'Stationery & Books', 'Other'
];

const REGIONS = [
  'Kampala', 'Wakiso', 'Mukono', 'Jinja', 'Mbarara', 'Gulu', 'Lira',
  'Fort Portal', 'Masaka', 'Mbale', 'Soroti', 'Arua', 'Kabale', 'Entebbe', 'Hoima', 'Other'
];

const SYSTEM_PROMPTS = {
  business: `You are Duka AI, a sharp, friendly business advisor built into DukaFlyer, Uganda's online marketplace platform. You help small Ugandan business owners with practical advice on pricing, marketing, customer acquisition, and operations. Ground your advice in the Uganda context: mobile money (MTN MoMo/Airtel Money), WhatsApp-based selling, Kampala/Wakiso markets, UGX pricing, local competition. Keep replies SHORT — 2 to 4 sentences, conversational, no long bullet lists unless the user asks for one. You may mention that DukaFlyer can help them sell online if it's genuinely relevant, but never force it in and never be salesy. Never invent specific statistics or financial figures you don't actually know.`,

  shop: `You are Duka AI, helping a visitor set up their shop on DukaFlyer through natural conversation. Collect these fields ONE at a time, conversationally, never more than one question per reply: shop name, category (must be one of: ${CATEGORIES.join(', ')}), region (must be one of: ${REGIONS.join(', ')} — if they name a town not on this list, use "Other"), WhatsApp number for orders (Uganda number), and optionally 1-3 starter products with rough UGX prices. Be warm and quick, not formal. Once you have shop name + category + region + WhatsApp number (products are a nice-to-have, not required), give a short friendly confirmation summarizing what you collected, and then on a NEW LINE append exactly this, filled in with real collected values and nothing invented: SHOP_JSON:{"shopName":"...","category":"...","region":"...","whatsapp":"...","products":[{"name":"...","price":"..."}]} — valid JSON only, no markdown fences. The category and region values in SHOP_JSON must be copied EXACTLY (same spelling/casing) from the allowed lists above. Do not include SHOP_JSON until you actually have the required fields.`
};

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  try {
    const { mode, message, history } = req.body || {};

    if (!mode || !SYSTEM_PROMPTS[mode]) {
      res.status(400).json({ error: 'Invalid mode' });
      return;
    }
    if (!message || typeof message !== 'string' || !message.trim()) {
      res.status(400).json({ error: 'Missing message' });
      return;
    }
    if (!process.env.GEMINI_API_KEY) {
      res.status(500).json({ error: 'Server not configured: missing GEMINI_API_KEY' });
      return;
    }

    // Build conversation for Gemini: system prompt goes in systemInstruction,
    // history + new message go in contents.
    const contents = [];
    if (Array.isArray(history)) {
      for (const turn of history.slice(-12)) { // cap history sent to control cost
        if (turn && turn.role && turn.text) {
          contents.push({
            role: turn.role === 'assistant' ? 'model' : 'user',
            parts: [{ text: String(turn.text).slice(0, 2000) }]
          });
        }
      }
    }
    contents.push({ role: 'user', parts: [{ text: message.slice(0, 2000) }] });

    const body = {
      systemInstruction: { parts: [{ text: SYSTEM_PROMPTS[mode] }] },
      contents,
      generationConfig: {
        maxOutputTokens: 400,
        temperature: 0.7
      }
    };

    const geminiRes = await callGemini(body);

    if (!geminiRes.ok) {
      const errText = await geminiRes.text();
      console.error('Gemini API error:', geminiRes.status, errText);
      res.status(502).json({ error: 'AI service error, please try again' });
      return;
    }

    const data = await geminiRes.json();
    const rawText =
      data?.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('') || '';

    if (!rawText) {
      res.status(502).json({ error: 'Empty AI response, please try again' });
      return;
    }

    // Extract SHOP_JSON marker if present (shop mode only)
    let reply = rawText.trim();
    let shopDraft = null;
    const marker = 'SHOP_JSON:';
    const idx = reply.indexOf(marker);
    if (idx !== -1) {
      const before = reply.slice(0, idx).trim();
      const jsonPart = reply.slice(idx + marker.length).trim();
      try {
        shopDraft = JSON.parse(jsonPart);
      } catch (e) {
        console.error('Failed to parse SHOP_JSON:', e, jsonPart);
      }
      reply = before;
    }

    res.status(200).json({ reply, shopDraft });
  } catch (err) {
    console.error('duka-ai handler error:', err);
    res.status(500).json({ error: 'Something went wrong, please try again' });
  }
};
