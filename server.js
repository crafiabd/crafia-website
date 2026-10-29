const express = require('express');
const { Pool } = require('pg');
const crypto = require('crypto');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const WHATSAPP_NUMBER = (process.env.WHATSAPP_NUMBER || '8801348037627').replace(/\D/g, '');
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && !/localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL)
    ? { rejectUnauthorized: false } : false
});
const sessions = new Map();
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname)));

function tokenFrom(req) {
  const h = req.headers.authorization || '';
  return h.startsWith('Bearer ') ? h.slice(7) : '';
}
function requireAdmin(req, res, next) {
  const token = tokenFrom(req);
  const session = sessions.get(token);
  if (!session || session.expires < Date.now()) {
    if (token) sessions.delete(token);
    return res.status(401).json({ error: 'Please sign in to the admin panel again.' });
  }
  next();
}
async function initDb() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  await pool.query(`
    CREATE TABLE IF NOT EXISTS crafia_orders (
      id BIGSERIAL PRIMARY KEY,
      public_id TEXT UNIQUE NOT NULL,
      customer_name TEXT NOT NULL,
      customer_phone TEXT NOT NULL,
      customer_address TEXT NOT NULL,
      customer_district TEXT NOT NULL,
      payment_method TEXT NOT NULL,
      customer_note TEXT NOT NULL DEFAULT '',
      items JSONB NOT NULL,
      total_bdt NUMERIC(12,2) NOT NULL,
      status TEXT NOT NULL DEFAULT 'Pending',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}
app.get('/api/health', async (req, res) => {
  try { await pool.query('SELECT 1'); res.json({ status: 'ok', database: 'connected' }); }
  catch (e) { res.status(503).json({ status: 'error', database: 'disconnected' }); }
});
app.get('/api/store-config', (req, res) => res.json({ whatsappNumber: WHATSAPP_NUMBER }));

app.post('/api/admin/login', (req, res) => {
  if (!ADMIN_PASSWORD) return res.status(503).json({ error: 'Admin login is not configured on the server yet.' });
  const supplied = String((req.body || {}).password || '');
  const a = Buffer.from(supplied);
  const b = Buffer.from(ADMIN_PASSWORD);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return res.status(401).json({ error: 'Incorrect password. Please try again.' });
  }
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, { expires: Date.now() + 8 * 60 * 60 * 1000 });
  res.json({ token, expiresIn: 28800 });
});
app.get('/api/admin/orders', requireAdmin, async (req, res) => {
  try {
    const result = await pool.query(`SELECT public_id AS id, customer_name AS name,
      customer_phone AS phone, customer_address AS address, customer_district AS district,
      payment_method AS payment, customer_note AS note, items, total_bdt AS total,
      status, created_at AS "createdAt" FROM crafia_orders ORDER BY created_at DESC LIMIT 500`);
    res.json({ orders: result.rows });
  } catch (e) { console.error('List orders failed:', e.message); res.status(500).json({ error: 'Could not load orders.' }); }
});
app.delete('/api/admin/orders/:id', requireAdmin, async (req, res) => {
  try {
    const result = await pool.query('DELETE FROM crafia_orders WHERE public_id=$1 RETURNING public_id AS id', [req.params.id]);
    if (!result.rowCount) return res.status(404).json({ error: 'Order not found.' });
    res.json({ deleted: true, id: result.rows[0].id });
  } catch (e) {
    console.error('Delete order failed:', e.message);
    res.status(500).json({ error: 'Could not delete order.' });
  }
});
app.patch('/api/admin/orders/:id/status', requireAdmin, async (req, res) => {
  const allowed = ['Pending', 'Confirmed', 'Preparing', 'Shipped', 'Delivered', 'Cancelled'];
  const status = String((req.body || {}).status || '');
  if (!allowed.includes(status)) return res.status(400).json({ error: 'Invalid order status.' });
  try {
    const result = await pool.query('UPDATE crafia_orders SET status=$1, updated_at=NOW() WHERE public_id=$2 RETURNING public_id AS id, status', [status, req.params.id]);
    if (!result.rowCount) return res.status(404).json({ error: 'Order not found.' });
    res.json({ order: result.rows[0] });
  } catch (e) { console.error('Update order failed:', e.message); res.status(500).json({ error: 'Could not update order.' }); }
});
app.post('/api/orders', async (req, res) => {
  const body = req.body || {};
  const name = String(body.name || '').trim().slice(0, 120);
  const phone = String(body.phone || '').trim().slice(0, 40);
  const address = String(body.address || '').trim().slice(0, 500);
  const district = String(body.district || '').trim().slice(0, 100);
  const payment = String(body.payment || '').trim().slice(0, 80);
  const note = String(body.note || '').trim().slice(0, 1000);
  const items = Array.isArray(body.items) ? body.items : [];
  if (!name || !phone || !address || !district || !payment || !items.length || items.length > 50) {
    return res.status(400).json({ error: 'Please complete all required fields and add at least one item.' });
  }
  let total = 0;
  const cleanItems = [];
  for (const item of items) {
    const itemName = String(item.name || '').trim().slice(0, 160);
    const qty = Number(item.qty);
    const price = Number(item.price);
    if (!itemName || !Number.isInteger(qty) || qty < 1 || qty > 99 || !Number.isFinite(price) || price < 0 || price > 10000000) {
      return res.status(400).json({ error: 'One of the items is invalid. Please refresh the page and try again.' });
    }
    const line = Math.round(price * 100) / 100;
    total += line * qty;
    cleanItems.push({ id: String(item.id || '').slice(0, 100), name: itemName, price: line, qty, customization: String(item.customization || '').trim().slice(0, 1000) });
  }
  total = Math.round(total * 100) / 100;
  if (total <= 0 || total > 100000000) return res.status(400).json({ error: 'Order total is invalid.' });
  const publicId = 'CF-' + crypto.randomBytes(4).toString('hex').toUpperCase();
  try {
    await pool.query(
      `INSERT INTO crafia_orders (public_id, customer_name, customer_phone, customer_address, customer_district, payment_method, customer_note, items, total_bdt)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [publicId, name, phone, address, district, payment, note, JSON.stringify(cleanItems), total]
    );
    res.status(201).json({ order: { id: publicId, name, phone, address, district, payment, note, items: cleanItems, total, status: 'Pending' }, whatsappNumber: WHATSAPP_NUMBER });
  } catch (e) { console.error('Create order failed:', e.message); res.status(500).json({ error: 'Your order could not be saved. Please try again or contact us on WhatsApp.' }); }
});

app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
initDb().then(() => app.listen(PORT, () => console.log('CRAFIA server listening on ' + PORT)))
  .catch(err => { console.error('Startup failed:', err.message); process.exit(1); });
