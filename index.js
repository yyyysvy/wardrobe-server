require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const cloudinary = require('cloudinary').v2;
const multer = require('multer');
const { Telegraf, Markup } = require('telegraf');

const app = express();
const port = process.env.PORT || 3001;

// Cloudinary config
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

// Database
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

// Middleware
const allowedOrigins = [process.env.FRONTEND_URL, 'http://localhost:3000'];
app.use(cors({
  origin: function (origin, callback) {
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  }
}));
app.use(express.json({ limit: '10mb' }));

const upload = multer({ storage: multer.memoryStorage() });

// Init database tables
async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS items (
      id BIGINT PRIMARY KEY,
      user_id TEXT NOT NULL,
      name TEXT NOT NULL,
      category TEXT,
      seasons TEXT[],
      wash_after INTEGER DEFAULT 2,
      wear_count INTEGER DEFAULT 0,
      in_laundry BOOLEAN DEFAULT FALSE,
      manual_wash BOOLEAN DEFAULT FALSE,
      last_worn TEXT,
      photo_url TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS outfits (
      id BIGINT PRIMARY KEY,
      user_id TEXT NOT NULL,
      name TEXT NOT NULL,
      item_ids BIGINT[],
      seasons TEXT[],
      weather TEXT[],
      occasions TEXT[],
      wear_count INTEGER DEFAULT 0,
      last_worn TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS wear_log (
      id BIGINT PRIMARY KEY,
      user_id TEXT NOT NULL,
      outfit_id BIGINT,
      outfit_name TEXT,
      item_ids BIGINT[],
      worn_date TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT NOW()
    );
    ALTER TABLE items ADD COLUMN IF NOT EXISTS photo_public_id TEXT;
    ALTER TABLE outfits ADD COLUMN IF NOT EXISTS temp_min INTEGER;
    ALTER TABLE outfits ADD COLUMN IF NOT EXISTS temp_max INTEGER;
    ALTER TABLE outfits ADD COLUMN IF NOT EXISTS rain_ok BOOLEAN DEFAULT TRUE;
    ALTER TABLE outfits ADD COLUMN IF NOT EXISTS snow_ok BOOLEAN DEFAULT TRUE;
  `);
  console.log('Database initialized!');
}

// Health check
app.get('/', (req, res) => res.json({ status: 'ok' }));

// === ITEMS ===

app.get('/items/:userId', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM items WHERE user_id = $1 ORDER BY created_at DESC',
      [req.params.userId]
    );
    res.json(result.rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/items', async (req, res) => {
  try {
    const { id, userId, name, category, seasons, washAfter, photo } = req.body;
    let photoUrl = null;
    let photoPublicId = null;

    if (photo) {
      const uploaded = await cloudinary.uploader.upload(photo, {
        folder: 'wardrobe',
        transformation: [{ width: 600, height: 800, crop: 'limit', quality: 70 }]
      });
      photoUrl = uploaded.secure_url;
      photoPublicId = uploaded.public_id;
    }

    await pool.query(
      `INSERT INTO items (id, user_id, name, category, seasons, wash_after, photo_url, photo_public_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [id, userId, name, category, seasons, washAfter, photoUrl, photoPublicId]
    );
    res.json({ success: true, photoUrl });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.put('/items/:id', async (req, res) => {
  try {
    const { wearCount, inLaundry, manualWash, lastWorn } = req.body;
    await pool.query(
      `UPDATE items SET wear_count=$1, in_laundry=$2, manual_wash=$3, last_worn=$4 WHERE id=$5`,
      [wearCount, inLaundry, manualWash, lastWorn, req.params.id]
    );
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/items/:id', async (req, res) => {
  try {
    const existing = await pool.query('SELECT photo_public_id FROM items WHERE id = $1', [req.params.id]);
    const publicId = existing.rows[0]?.photo_public_id;

    if (publicId) {
      try {
        await cloudinary.uploader.destroy(publicId);
      } catch (cloudErr) {
        console.error('Failed to delete photo from Cloudinary:', cloudErr.message);
      }
    }

    await pool.query('DELETE FROM items WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// === OUTFITS ===

app.post('/outfits/analyze', async (req, res) => {
  try {
    const { items } = req.body;
    const itemsDescription = items.map(i => `${i.name} (${i.category})`).join(', ');
    const prompt = `You are an expert stylist and meteorologist. Analyze this complete outfit worn together as one combination: ${itemsDescription}.

Think about the outfit as a whole (layering, coverage, materials implied by the item types), not each item in isolation.
Estimate a realistic outdoor temperature comfort range in Celsius — typically an 8-12°C span, not wider unless the outfit is genuinely versatile (e.g. includes a removable layer like a jacket).
Also decide if this outfit is practical to wear in rain (rainOk) and in snow (snowOk) — consider footwear and outer layers specifically. An outfit with open shoes or no jacket should have rainOk/snowOk as false. An outfit with boots and a coat can have them true.

Respond ONLY with valid JSON in this exact format, with no other text, no markdown formatting, no code fences, no explanation:
{"tempMin": <integer>, "tempMax": <integer>, "rainOk": <true or false>, "snowOk": <true or false>}`;

    const response = await fetch(
     `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent?key=${process.env.GEMINI_API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] })
      }
    );
    const data = await response.json();
    console.log('Gemini raw response:', JSON.stringify(data));
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
    const cleaned = text.replace(/```json|```/g, '').trim();

    // Вытаскиваем именно JSON-объект из текста, даже если вокруг есть лишние слова
    const jsonMatch = cleaned.match(/\{[\s\S]*\}/);

    let parsed;
    try {
      if (!jsonMatch) throw new Error('No JSON object found in response');
      parsed = JSON.parse(jsonMatch[0]);
    } catch (parseErr) {
      console.error('Gemini returned non-JSON response. Full text was:', text);
      return res.status(500).json({ error: 'AI returned an unexpected response, please try again' });
    }

        res.json(parsed);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/outfits/generate', async (req, res) => {
  try {
    const { items, temperature, season, excludeCombos } = req.body;

    const itemsList = items.map(i => `id:${i.id} — ${i.name} (${i.category})`).join('\n');
    const excludeText = excludeCombos && excludeCombos.length > 0
      ? `\n\nDo NOT repeat these exact combinations of item ids already suggested: ${JSON.stringify(excludeCombos)}. Come up with a different combination.`
      : '';

    const prompt = `You are an expert stylist. Here is a list of clothing items available in a wardrobe, each with a unique id:
${itemsList}

Current outdoor temperature: ${temperature}°C. Current season: ${season}.

Create ONE stylish, coherent outfit combination using 2 to 5 of these items (by their id) that would be comfortable and appropriate for this temperature and season. Only use item ids from the list above — never invent new ones. Also give the outfit a short creative name (2-4 words), and pick the single most fitting occasion from this exact list: Beach, Casual, City break, Cycling, Dinner, Evening out, Flight, Formal, Friends, Gym, Hiking, Loungewear, Party, Smart casual, Sport, Travel, Walk, Weekend, Work, Work from home, Yoga.${excludeText}

Respond ONLY with valid JSON in this exact format, with no other text, no markdown, no code fences:
{"name": "<outfit name>", "itemIds": [<id>, <id>, ...], "occasion": "<one occasion from the list>"}`;

    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent?key=${process.env.GEMINI_API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] })
      }
    );
    const data = await response.json();
    console.log('Gemini generate raw response:', JSON.stringify(data));
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
    const cleaned = text.replace(/```json|```/g, '').trim();
    const jsonMatch = cleaned.match(/\{[\s\S]*\}/);

    let parsed;
    try {
      if (!jsonMatch) throw new Error('No JSON object found in response');
      parsed = JSON.parse(jsonMatch[0]);
    } catch (parseErr) {
      console.error('Gemini returned non-JSON response for generate. Full text was:', text);
      return res.status(500).json({ error: 'AI returned an unexpected response, please try again' });
    }

    // Проверяем, что все ID вещей реально существуют в списке, который мы отправляли
    const validIds = new Set(items.map(i => Number(i.id)));
    const filteredIds = (parsed.itemIds || []).map(Number).filter(id => validIds.has(id));

    if (filteredIds.length < 2) {
      return res.status(500).json({ error: 'AI could not form a valid outfit, please try again' });
    }

    res.json({ name: parsed.name, itemIds: filteredIds, occasion: parsed.occasion });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/outfits/:userId', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM outfits WHERE user_id = $1 ORDER BY created_at DESC',
      [req.params.userId]
    );
    res.json(result.rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/outfits', async (req, res) => {
  try {
    const { id, userId, name, itemIds, seasons, occasions, tempMin, tempMax, rainOk, snowOk } = req.body;
    await pool.query(
      `INSERT INTO outfits (id, user_id, name, item_ids, seasons, occasions, temp_min, temp_max, rain_ok, snow_ok)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [id, userId, name, itemIds, seasons, occasions, tempMin, tempMax, rainOk, snowOk]
    );
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.put('/outfits/:id', async (req, res) => {
  try {
    const { wearCount, lastWorn } = req.body;
    await pool.query(
      `UPDATE outfits SET wear_count=$1, last_worn=$2 WHERE id=$3`,
      [wearCount, lastWorn, req.params.id]
    );
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/outfits/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM outfits WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// === WEAR LOG ===

app.get('/wear-log/:userId', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM wear_log WHERE user_id = $1 ORDER BY worn_date DESC',
      [req.params.userId]
    );
    res.json(result.rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/wear-log', async (req, res) => {
  try {
    const { id, userId, outfitId, outfitName, itemIds, wornDate } = req.body;
    await pool.query(
      `INSERT INTO wear_log (id, user_id, outfit_id, outfit_name, item_ids, worn_date)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [id, userId, outfitId, outfitName, itemIds, wornDate]
    );
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// === TELEGRAM BOT ===

const bot = new Telegraf(process.env.BOT_TOKEN);

bot.start((ctx) => {
  ctx.reply(
    '🌸 Hi! I am your digital wardrobe.\n\n✨ Tap the button below to open your wardrobe! ✨',
    Markup.inlineKeyboard([
      Markup.button.webApp('👗 Open Wardrobe', process.env.MINIAPP_URL)
    ])
  );
});

bot.help((ctx) => {
  ctx.reply('✨ I am your digital wardrobe. Tap /start to open the app! ✨');
});

// Start everything
initDB().then(() => {
  app.listen(port, () => console.log(`Server running on port ${port}`));
  bot.launch();
  console.log('Telegram bot started!');
});

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));