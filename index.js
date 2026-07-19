require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const cloudinary = require('cloudinary').v2;
const multer = require('multer');

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

    if (photo) {
      const uploaded = await cloudinary.uploader.upload(photo, {
        folder: 'wardrobe',
        transformation: [{ width: 600, height: 800, crop: 'limit', quality: 70 }]
      });
      photoUrl = uploaded.secure_url;
    }

    await pool.query(
      `INSERT INTO items (id, user_id, name, category, seasons, wash_after, photo_url)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [id, userId, name, category, seasons, washAfter, photoUrl]
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
    await pool.query('DELETE FROM items WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// === OUTFITS ===

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
    const { id, userId, name, itemIds, seasons, weather, occasions } = req.body;
    await pool.query(
      `INSERT INTO outfits (id, user_id, name, item_ids, seasons, weather, occasions)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [id, userId, name, itemIds, seasons, weather, occasions]
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

// Start
initDB().then(() => {
  app.listen(port, () => console.log(`Server running on port ${port}`));
});