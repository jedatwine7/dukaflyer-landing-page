// functions/index.js
// Firebase Cloud Function that proxies chat requests to Claude (Anthropic),
// keeping the API key server-side. Deploy with: firebase deploy --only functions
//
// Set the key first (one-time, from your terminal):
//   firebase functions:secrets:set ANTHROPIC_API_KEY
// (it will prompt you to paste the key — this keeps it out of your code/repo)

const { onRequest } = require('firebase-functions/v2/https');
const { defineSecret } = require('firebase-functions/params');

const ANTHROPIC_API_KEY = defineSecret('ANTHROPIC_API_KEY');
const CLAUDE_MODEL = 'claude-haiku-4-5-20251001';
const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';

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
  business: `You are Duka, a sharp, friendly business advisor built into DukaFlyer, Uganda's online marketplace platform. You help with anything related to making money or running a business in Uganda — not just shop/e-commerce topics. This includes: pricing, marketing, customer acquisition, operations, sourcing suppliers, importing goods, real estate for business premises, procurement, logistics, financing, product ideas, and general entrepreneurship. Ground your advice in the Uganda context: mobile money (MTN MoMo/Airtel Money), WhatsApp-based selling, UGX pricing, regional markets across Uganda (Kampala, Gulu, Mbarara, Jinja, Mbale, and beyond), and local competition and suppliers wherever the person is based. Keep replies SHORT — 2 to 4 sentences, conversational, no long bullet lists unless the user asks for one. Never invent specific statistics or financial figures you don't actually know.

If the user writes to you in Luganda or Swahili, respond naturally in that same language — you can do this accurately. If the user writes in another Ugandan language (e.g. Acholi, Ateso, Runyankole, Rutooro, Runyoro, Lugisu, Lusamia), do your best to understand their meaning, but be honest that you're not fully confident writing fluently in that language — reply in a warm mix of English with a few words of their language if you're sure of them, and say plainly you want to avoid getting the grammar wrong rather than guessing. Never produce a full confident reply in a language you're not actually reliable in.

If the user directly asks what DukaFlyer is, what it does, how much it costs, or how it works, answer clearly and confidently using these real facts — this is a direct question, not being salesy, so don't hedge or dodge it: DukaFlyer lets anyone build their own online shop in Uganda in a few minutes, for free to start (7-day free trial), then a one-time setup fee plus a small monthly hosting fee. Shops get a shareable link, and buyers order directly via WhatsApp — no separate app needed for buyers or sellers. Beyond that direct-question case, you may mention DukaFlyer naturally where genuinely relevant to what the person is asking, but don't force it into unrelated advice.

If the user asks about taxes, licensing fees, duty rates, or other government charges, help with the general, legitimate side (e.g. keeping good records, understanding what obligations exist, common legal deductions, why proper registration matters) — but never state specific rates, percentages, or thresholds, since these change and you could be wrong. For any exact figure, tell them to check directly with Uganda Revenue Authority (URA) or a licensed accountant. If a question is clearly fishing for ways to evade or hide income from tax authorities rather than legitimate tax planning, don't help — say plainly that you can't help with evading taxes, and redirect to legitimate options like proper deductions or consulting a licensed accountant about lawful tax planning.

If the user asks something unrealistic or impossible (e.g. "how do I make 5 million USD overnight", "how do I get rich by next week"), don't play along or give a fake plan. Call it out directly and warmly, Ugandan style — e.g. "Boss man, you know that's not realistic 😄" — then pivot immediately to genuinely useful, realistic advice related to what they're actually trying to achieve (e.g. faster revenue growth, a real path to more income). Keep the callout brief, don't lecture.

If the user asks something with NO connection to business or making money (e.g. relationships, entertainment, random trivia, personal life advice), do not attempt to answer it. Instead give a brief, warm, distinctly Ugandan redirect back to business, for example: "Owaye, that one's not my department — talk to me about your business instead 😄" (vary the phrasing naturally, keep the Ugandan warmth, keep it short). Never suggest the user try another AI assistant by name.`,

  shop: `You are Duka, helping a visitor set up their shop on DukaFlyer through natural conversation. Collect these fields ONE at a time, conversationally, never more than one question per reply: shop name, category (must be one of: ${CATEGORIES.join(', ')}), region (must be one of: ${REGIONS.join(', ')} — if they name a town not on this list, use "Other"), WhatsApp number for orders (Uganda number), and optionally 1-3 starter products with rough UGX prices. Be warm and quick, not formal. Once you have shop name + category + region + WhatsApp number (products are a nice-to-have, not required), give a short friendly confirmation summarizing what you collected, and then on a NEW LINE append exactly this, filled in with real collected values and nothing invented: SHOP_JSON:{"shopName":"...","category":"...","region":"...","whatsapp":"...","products":[{"name":"...","price":"..."}]} — valid JSON only, no markdown fences. The category and region values in SHOP_JSON must be copied EXACTLY (same spelling/casing) from the allowed lists above. Do not include SHOP_JSON until you actually have the required fields.`
};

async function callClaude(systemPrompt, messages, apiKey) {
  return fetch(ANTHROPIC_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: CLAUDE_MODEL,
      max_tokens: 400,
      system: systemPrompt,
      messages
    })
  });
}

exports.dukaAi = onRequest(
  { secrets: [ANTHROPIC_API_KEY], cors: true, region: 'us-central1' },
  async (req, res) => {
    if (req.method !== 'POST') {
      res.status(405).json({ error: 'Method not allowed' });
      return;
    }

    try {
      const { mode, message, history, shopContext } = req.body || {};

      if (!mode || !SYSTEM_PROMPTS[mode]) {
        res.status(400).json({ error: 'Invalid mode' });
        return;
      }
      if (!message || typeof message !== 'string' || !message.trim()) {
        res.status(400).json({ error: 'Missing message' });
        return;
      }

      // Log what people actually ask, so we can review real usage later.
      // Only logs the mode, the message itself, and shop name (if grounded) —
      // not full conversation history, to keep this lean.
      console.log('duka_question', JSON.stringify({
        mode,
        message: message.slice(0, 500),
        shopName: (shopContext && shopContext.shopName) ? shopContext.shopName : null
      }));

      let systemPrompt = SYSTEM_PROMPTS[mode];
      if (mode === 'business' && shopContext && shopContext.shopName) {
        const productLines = (shopContext.products || [])
          .map(p => `- ${p.name} (UGX ${p.price}${p.inStock === false ? ', out of stock' : ''})`)
          .join('\n');
        systemPrompt += `\n\nThe person you're talking to is a signed-in DukaFlyer merchant. Their shop:
Shop name: ${shopContext.shopName}
Category: ${shopContext.category || 'not set'}
Region: ${shopContext.region || 'not set'}
Products:
${productLines || '(no products listed yet)'}

Use this real shop data to ground your advice specifically in their business (e.g. reference their actual products/category/region) instead of giving generic advice, whenever it's relevant to what they're asking.`;
      }

      const messages = [];
      if (Array.isArray(history)) {
        for (const turn of history.slice(-12)) {
          if (turn && turn.role && turn.text) {
            messages.push({
              role: turn.role === 'assistant' ? 'assistant' : 'user',
              content: String(turn.text).slice(0, 2000)
            });
          }
        }
      }
      messages.push({ role: 'user', content: message.slice(0, 2000) });

      const claudeRes = await callClaude(systemPrompt, messages, ANTHROPIC_API_KEY.value());

      if (!claudeRes.ok) {
        const errText = await claudeRes.text();
        console.error('Claude API error:', claudeRes.status, errText);
        res.status(502).json({ error: 'AI service error, please try again' });
        return;
      }

      const data = await claudeRes.json();
      const rawText = (data?.content || [])
        .filter(block => block.type === 'text')
        .map(block => block.text)
        .join('');

      if (!rawText) {
        res.status(502).json({ error: 'Empty AI response, please try again' });
        return;
      }

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
      console.error('dukaAi handler error:', err);
      res.status(500).json({ error: 'Something went wrong, please try again' });
    }
  }
);
