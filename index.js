// functions/index.js
// Firebase Cloud Function that proxies chat requests to Claude (Anthropic),
// and handles WhatsApp webhooks for Duka on WhatsApp.
//
// Deploy with: firebase deploy --only functions
//
// Required secrets (set once):
//   firebase functions:secrets:set ANTHROPIC_API_KEY
//   firebase functions:secrets:set WHATSAPP_ACCESS_TOKEN
//   firebase functions:secrets:set WHATSAPP_VERIFY_TOKEN
//   firebase functions:secrets:set OPENAI_API_KEY   (for voice transcription)

// ============================================================
// 1. Imports
// ============================================================
const { onRequest } = require('firebase-functions/v2/https');
const { onSchedule } = require('firebase-functions/v2/scheduler');
const { onDocumentCreated } = require('firebase-functions/v2/firestore');
const { defineSecret } = require('firebase-functions/params');
const admin = require('firebase-admin');
const { getFirestore } = require('firebase-admin/firestore');
const { getStorage } = require('firebase-admin/storage');
const { OpenAI } = require('openai');
const pdfParse = require('pdf-parse');
const axios = require('axios');

// Initialize Firebase Admin (if not already)
if (!admin.apps.length) {
  admin.initializeApp();
}
const db = getFirestore();
const bucket = getStorage().bucket();

// ============================================================
// 2. Secrets
// ============================================================
const ANTHROPIC_API_KEY = defineSecret('ANTHROPIC_API_KEY');
const WHATSAPP_ACCESS_TOKEN = defineSecret('WHATSAPP_ACCESS_TOKEN');
const WHATSAPP_VERIFY_TOKEN = defineSecret('WHATSAPP_VERIFY_TOKEN');
const OPENAI_API_KEY = defineSecret('OPENAI_API_KEY');

// ============================================================
// 3. Constants
// ============================================================
const CLAUDE_MODEL = 'claude-haiku-4-5-20251001';
const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';

// Replace with your actual Meta Phone Number ID from the API Setup
const WHATSAPP_PHONE_NUMBER_ID = '1287940777727630'; // <-- Update this!

// Allowed categories and regions (for shop builder mode)
const CATEGORIES = [
  'Fashion & Clothing', 'Food & Drinks', 'Electronics', 'Beauty & Cosmetics',
  'Furniture & Home', 'Phones & Accessories', 'Groceries', 'Pharmacy & Health',
  'Hardware & Building', 'Agriculture', 'Stationery & Books', 'Other'
];
const REGIONS = [
  'Kampala', 'Wakiso', 'Mukono', 'Jinja', 'Mbarara', 'Gulu', 'Lira',
  'Fort Portal', 'Masaka', 'Mbale', 'Soroti', 'Arua', 'Kabale', 'Entebbe', 'Hoima', 'Other'
];

// ============================================================
// 4. Helper Functions
// ============================================================

// Send a WhatsApp text message
async function sendWhatsAppMessage(toNumber, text, accessToken) {
  const url = `https://graph.facebook.com/v18.0/${WHATSAPP_PHONE_NUMBER_ID}/messages`;
  try {
    const response = await axios.post(url, {
      messaging_product: 'whatsapp',
      to: toNumber,
      type: 'text',
      text: { body: text.substring(0, 4096) } // Meta limit
    }, {
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      }
    });
    return response.data;
  } catch (error) {
    console.error('WhatsApp send error:', error.response?.data || error.message);
    throw new Error('Failed to send WhatsApp message');
  }
}

// Download media from Meta using media ID
async function downloadMedia(mediaId, accessToken) {
  // Get the media URL
  const url = `https://graph.facebook.com/v18.0/${mediaId}`;
  const resp = await axios.get(url, {
    headers: { Authorization: `Bearer ${accessToken}` }
  });
  const mediaUrl = resp.data.url;
  // Download the actual file
  const mediaResp = await axios.get(mediaUrl, {
    headers: { Authorization: `Bearer ${accessToken}` },
    responseType: 'arraybuffer'
  });
  return mediaResp.data;
}

// Transcribe voice note using OpenAI Whisper
async function processVoiceNote(audioBuffer) {
  const openai = new OpenAI({ apiKey: OPENAI_API_KEY.value() });
  const blob = new Blob([audioBuffer], { type: 'audio/ogg' });
  const file = new File([blob], 'voice.ogg', { type: 'audio/ogg' });
  const transcription = await openai.audio.transcriptions.create({
    file: file,
    model: 'whisper-1',
  });
  return transcription.text;
}

// Extract text from a PDF buffer
async function processPDF(pdfBuffer) {
  const data = await pdfParse(pdfBuffer);
  return data.text;
}

// Call Claude (used by both dukaAi and whatsappWebhook)
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
      max_tokens: 500,
      system: systemPrompt,
      messages
    })
  });
}

// ============================================================
// 5. System Prompts for Duka (business & shop modes)
// ============================================================
const SYSTEM_PROMPTS = {
  business: `You are Duka, a sharp, friendly business advisor built into DukaFlyer, Uganda's online marketplace platform. You help with anything related to making money or running a business in Uganda — not just shop/e-commerce topics. This includes: pricing, marketing, customer acquisition, operations, sourcing suppliers, importing goods, real estate for business premises, procurement, logistics, financing, product ideas, and general entrepreneurship. Ground your advice in the Uganda context: mobile money (MTN MoMo/Airtel Money), WhatsApp-based selling, UGX pricing, regional markets across Uganda (Kampala, Gulu, Mbarara, Jinja, Mbale, and beyond), and local competition and suppliers wherever the person is based. Keep replies SHORT — 2 to 4 sentences, conversational, no long bullet lists unless the user asks for one. Never invent specific statistics or financial figures you don't actually know.

If the user writes to you in Luganda or Swahili, respond naturally in that same language — you can do this accurately. If the user writes in another Ugandan language (e.g. Acholi, Ateso, Runyankole, Rutooro, Runyoro, Lugisu, Lusamia), do your best to understand their meaning, but be honest that you're not fully confident writing fluently in that language — reply in a warm mix of English with a few words of their language if you're sure of them, and say plainly you want to avoid getting the grammar wrong rather than guessing. Never produce a full confident reply in a language you're not actually reliable in.

If the user directly asks what DukaFlyer is, what it does, how much it costs, or how it works, answer clearly and confidently using these real facts — this is a direct question, not being salesy, so don't hedge or dodge it: DukaFlyer lets anyone build their own online shop in Uganda in a few minutes, for free to start (7-day free trial), then a one-time setup fee plus a small monthly hosting fee. Shops get a shareable link, and buyers order directly via WhatsApp — no separate app needed for buyers or sellers. Beyond that direct-question case, you may mention DukaFlyer naturally where genuinely relevant to what the person is asking, but don't force it into unrelated advice.

If the user asks about taxes, licensing fees, duty rates, or other government charges, help with the general, legitimate side (e.g. keeping good records, understanding what obligations exist, common legal deductions, why proper registration matters) — but never state specific rates, percentages, or thresholds, since these change and you could be wrong. For any exact figure, tell them to check directly with Uganda Revenue Authority (URA) or a licensed accountant. If a question is clearly fishing for ways to evade or hide income from tax authorities rather than legitimate tax planning, don't help — say plainly that you can't help with evading taxes, and redirect to legitimate options like proper deductions or consulting a licensed accountant about lawful tax planning.

If the user asks something unrealistic or impossible (e.g. "how do I make 5 million USD overnight", "how do I get rich by next week"), don't play along or give a fake plan. Call it out directly and warmly, Ugandan style — e.g. "Boss man, you know that's not realistic 😄" — then pivot immediately to genuinely useful, realistic advice related to what they're actually trying to achieve (e.g. faster revenue growth, a real path to more income). Keep the callout brief, don't lecture.

If the user asks something with NO connection to business or making money (e.g. relationships, entertainment, random trivia, personal life advice), do not attempt to answer it. Instead give a brief, warm, distinctly Ugandan redirect back to business, for example: "Owaye, that one's not my department — talk to me about your business instead 😄" (vary the phrasing naturally, keep the Ugandan warmth, keep it short). Never suggest the user try another AI assistant by name.`,

  shop: `You are Duka, helping a visitor set up their shop on DukaFlyer through natural conversation. Collect these fields ONE at a time, conversationally, never more than one question per reply: shop name, category (must be one of: ${CATEGORIES.join(', ')}), region (must be one of: ${REGIONS.join(', ')} — if they name a town not on this list, use "Other"), WhatsApp number for orders (Uganda number), and optionally 1-3 starter products with rough UGX prices. Be warm and quick, not formal. Once you have shop name + category + region + WhatsApp number (products are a nice-to-have, not required), give a short friendly confirmation summarizing what you collected, and then on a NEW LINE append exactly this, filled in with real collected values and nothing invented: SHOP_JSON:{"shopName":"...","category":"...","region":"...","whatsapp":"...","products":[{"name":"...","price":"..."}]} — valid JSON only, no markdown fences. The category and region values in SHOP_JSON must be copied EXACTLY (same spelling/casing) from the allowed lists above. Do not include SHOP_JSON until you actually have the required fields.`
};

// ============================================================
// 6. Existing dukaAi function (unchanged)
// ============================================================
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

// ============================================================
// 7. WhatsApp Webhook (Verification + Incoming Messages)
// ============================================================
exports.whatsappWebhook = onRequest(
  {
    secrets: [
      WHATSAPP_VERIFY_TOKEN,
      WHATSAPP_ACCESS_TOKEN,
      OPENAI_API_KEY,
      ANTHROPIC_API_KEY
    ],
    cors: true,
    region: 'us-central1',
    timeoutSeconds: 60, // media processing may take time
    memory: '1GiB'
  },
  async (req, res) => {
    // --- GET: Webhook verification ---
    if (req.method === 'GET') {
      const mode = req.query['hub.mode'];
      const token = req.query['hub.verify_token'];
      const challenge = req.query['hub.challenge'];
      if (mode === 'subscribe' && token === WHATSAPP_VERIFY_TOKEN.value()) {
        console.log('Webhook verified successfully!');
        return res.status(200).send(challenge);
      }
      console.warn('Webhook verification failed - token mismatch');
      return res.sendStatus(403);
    }

    // --- POST: Incoming messages ---
    if (req.method !== 'POST') {
      return res.sendStatus(405);
    }

    try {
      const body = req.body;
      const entry = body.entry?.[0];
      const changes = entry?.changes?.[0];
      const value = changes?.value;
      const message = value?.messages?.[0];

      if (!message) {
        // Acknowledge non-message events (like status updates)
        return res.sendStatus(200);
      }

      const fromNumber = message.from; // e.g., "2567XXXXXXXX"
      const type = message.type;

      // 1. VERIFY USER: check if this number is linked to a Dukaflyer account
      const shopsSnapshot = await db.collection('shops')
        .where('whatsappNumber', '==', fromNumber)
        .limit(1)
        .get();

      if (shopsSnapshot.empty) {
        // Unrecognized number – send a friendly instruction
        await sendWhatsAppMessage(
          fromNumber,
          "⚠️ Hello! I don't recognize this number. Please link it in your Dukaflyer dashboard first to use Duka on WhatsApp.",
          WHATSAPP_ACCESS_TOKEN.value()
        );
        return res.sendStatus(200);
      }

      const shopDoc = shopsSnapshot.docs[0];
      const shopData = shopDoc.data();
      const userId = shopDoc.id;

      // 2. EXTRACT USER CONTENT
      let userText = message.text?.body || '';
      let mediaContext = '';

      // Handle images
      if (type === 'image') {
        const mediaId = message.image.id;
        const buffer = await downloadMedia(mediaId, WHATSAPP_ACCESS_TOKEN.value());
        // Upload to Firebase Storage for later reference
        const filePath = `whatsapp_images/${userId}/${Date.now()}.jpg`;
        await bucket.file(filePath).save(buffer);
        mediaContext += `[User sent an image. URL: https://storage.googleapis.com/${bucket.name}/${filePath}] `;
      }

      // Handle voice notes
      if (type === 'audio') {
        const mediaId = message.audio.id;
        const buffer = await downloadMedia(mediaId, WHATSAPP_ACCESS_TOKEN.value());
        try {
          const transcript = await processVoiceNote(buffer);
          userText = `[Voice note transcribed]: ${transcript}`;
        } catch (err) {
          console.error('Voice transcription failed:', err);
          userText = '[Voice note could not be transcribed]';
        }
      }

      // Handle PDF documents
      if (type === 'document') {
        const mediaId = message.document.id;
        const buffer = await downloadMedia(mediaId, WHATSAPP_ACCESS_TOKEN.value());
        try {
          const pdfText = await processPDF(buffer);
          mediaContext += `[User sent a PDF with contents]: ${pdfText.substring(0, 2000)} `;
        } catch (err) {
          console.error('PDF processing failed:', err);
          mediaContext += '[User sent a PDF that could not be read] ';
        }
      }

      // 3. FETCH MEMORY (for personalised advice)
      const memorySnapshot = await db.collection('shops').doc(userId).collection('memory').get();
      let memoryText = '';
      memorySnapshot.forEach(doc => {
        memoryText += `${doc.id}: ${doc.data().value}. `;
      });

      // Build the system prompt with full context
      const systemPrompt = `You are Duka, the business assistant for ${shopData.shopName} in Uganda.
Business context:
- Shop: ${shopData.shopName}
- Category: ${shopData.category || 'not set'}
- Region: ${shopData.region || 'not set'}
- Memory: ${memoryText || 'No memory set yet.'}
${mediaContext}

The user asks: "${userText}"
Give short, actionable, Uganda-focused business advice. Reference their products or memory if relevant.
Keep replies very concise (2–4 sentences).`;

      // 4. CALL CLAUDE
      const claudeRes = await callClaude(
        systemPrompt,
        [{ role: 'user', content: userText }],
        ANTHROPIC_API_KEY.value()
      );

      if (!claudeRes.ok) {
        const errText = await claudeRes.text();
        console.error('Claude API error:', claudeRes.status, errText);
        await sendWhatsAppMessage(
          fromNumber,
          "Sorry, I'm having trouble generating a response right now. Please try again in a moment.",
          WHATSAPP_ACCESS_TOKEN.value()
        );
        return res.sendStatus(200);
      }

      const data = await claudeRes.json();
      const rawReply = data.content?.[0]?.text || "I couldn't think of anything helpful right now. Try again!";
      const reply = rawReply.trim();

      // 5. SEND REPLY BACK
      await sendWhatsAppMessage(fromNumber, reply, WHATSAPP_ACCESS_TOKEN.value());

      // 6. SAVE CONVERSATION TO FIRESTORE (for web sync)
      await db.collection('shops').doc(userId).collection('whatsapp_logs').add({
        from: fromNumber,
        userText: userText,
        reply: reply,
        timestamp: admin.firestore.FieldValue.serverTimestamp()
      });

      res.sendStatus(200);
    } catch (error) {
      console.error('Webhook error:', error);
      // Attempt to send a fallback message to the user
      try {
        const from = req.body?.entry?.[0]?.changes?.[0]?.value?.messages?.[0]?.from;
        if (from) {
          await sendWhatsAppMessage(
            from,
            "Oops! Something went wrong. Try again in a moment.",
            WHATSAPP_ACCESS_TOKEN.value()
          );
        }
      } catch (e) {}
      res.sendStatus(500);
    }
  }
);

// ============================================================
// 8. Event Checker (Proactive Notifications)
// ============================================================
exports.eventChecker = onSchedule(
  {
    schedule: '0 */4 * * *', // every 4 hours
    secrets: [WHATSAPP_ACCESS_TOKEN],
    region: 'us-central1',
    timeZone: 'Africa/Kampala'
  },
  async () => {
    const now = new Date();
    const fiveDaysAgo = new Date(now - 5 * 24 * 60 * 60 * 1000);

    // 1. Check "no orders" for opted-in shops
    const snapshot = await db.collection('shops')
      .where('whatsappOptIn', '==', true)
      .where('lastOrderDate', '<', fiveDaysAgo)
      .get();

    for (const doc of snapshot.docs) {
      const shop = doc.data();
      // User must have low-order notifications enabled
      if (!shop.notificationPreferences?.lowOrders) continue;

      // Avoid spamming: only send once every 3 days
      const lastAlert = shop.lastLowOrderAlert?.toDate() || new Date(0);
      if ((now - lastAlert) < 3 * 24 * 60 * 60 * 1000) continue;

      // Send the alert
      await sendWhatsAppMessage(
        shop.whatsappNumber,
        `📢 Hey ${shop.shopName}! It's been 5 days since your last order. Want me to draft a "We miss you" WhatsApp broadcast to your previous customers? Reply "YES" and I'll write it up.`,
        WHATSAPP_ACCESS_TOKEN.value()
      );

      // Update the alert timestamp
      await doc.ref.update({
        lastLowOrderAlert: admin.firestore.FieldValue.serverTimestamp()
      });
    }

    // 2. (Future) Add more triggers: payday, holidays, stock alerts...
    console.log('Event checker completed.');
  }
);

// ============================================================
// 9. Live Shop Activity Notifications (batched)
// ============================================================
exports.onNewShopView = onDocumentCreated(
  { document: 'views/{viewId}', region: 'us-central1' },
  async (event) => {
    const view = event.data.data();
    const { slug, page } = view;
    if (!slug) return;

    const shopSnap = await db.collection('shops').where('slug', '==', slug).limit(1).get();
    if (shopSnap.empty) return;
    const shopDoc = shopSnap.docs[0];
    const shop = shopDoc.data();

    if (!shop.liveActivityEnabled || !shop.fcmToken) return;

    const now = Date.now();
    const windowMs = 5 * 60 * 1000; // 5-minute batching window
    const lastNotifiedAt = shop.lastViewNotifiedAt?.toMillis?.() || 0;
    const pendingCount = (shop.pendingViewCount || 0) + 1;

    if (shop.lastViewNotifiedAt && (now - lastNotifiedAt) < windowMs) {
      await shopDoc.ref.update({ pendingViewCount: pendingCount });
      return;
    }

    const pageLabel = (page && page !== 'Shop Home') ? page : null;
    const title = pendingCount === 1 ? '👀 1 new viewer' : `👀 ${pendingCount} new viewers`;
    const body = pendingCount === 1
      ? (pageLabel ? `Someone is checking out ${pageLabel}.` : 'Someone just opened your shop.')
      : (pageLabel ? `${pendingCount} people viewed your shop — most recently ${pageLabel}.` : `${pendingCount} people viewed your shop recently.`);

    try {
      await admin.messaging().send({
        token: shop.fcmToken,
        notification: { title, body },
        webpush: { fcmOptions: { link: 'https://dukaflyer.com/dashboard.html' } }
      });
    } catch (err) {
      console.error('FCM send failed:', err);
      // Token likely stale/expired — clear it so we stop trying
      if (err.code === 'messaging/registration-token-not-registered') {
        await shopDoc.ref.update({ fcmToken: admin.firestore.FieldValue.delete(), liveActivityEnabled: false });
      }
    }

    await shopDoc.ref.update({
      lastViewNotifiedAt: admin.firestore.FieldValue.serverTimestamp(),
      pendingViewCount: 0
    });
  }
);