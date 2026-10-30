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
function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
}
async function sendOrderNotification(order) {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.RESEND_FROM_EMAIL;
  const to = process.env.ORDER_NOTIFICATION_EMAIL || 'crafiabd@gmail.com';
  if (!apiKey || !from) { console.warn('Order email not sent: configure RESEND_API_KEY and RESEND_FROM_EMAIL.'); return; }
  const rows = order.items.map(item => '<tr><td style="padding:8px;border-bottom:1px solid #eee">' + escapeHtml(item.name) + '</td><td style="padding:8px;border-bottom:1px solid #eee">' + item.qty + '</td><td style="padding:8px;border-bottom:1px solid #eee">৳' + (item.price * item.qty).toFixed(2) + '</td></tr>').join('');
  const html = '<div style="font-family:Arial,sans-serif;color:#333;max-width:640px;margin:auto"><h2 style="color:#b34d83">🌸 New CRAFIA order!</h2><p>A customer has placed a new order.</p><p><b>Order ID:</b> ' + escapeHtml(order.id) + '<br><b>Customer:</b> ' + escapeHtml(order.name) + '<br><b>Phone:</b> ' + escapeHtml(order.phone) + '<br><b>Address:</b> ' + escapeHtml(order.address) + ', ' + escapeHtml(order.district) + '<br><b>Payment:</b> ' + escapeHtml(order.payment) + '<br><b>Transaction ID:</b> ' + escapeHtml(order.transactionRef || 'Not provided') + '<br><b>Note:</b> ' + escapeHtml(order.note || '—') + '</p><table style="border-collapse:collapse;width:100%;text-align:left"><thead><tr><th style="padding:8px">Product</th><th style="padding:8px">Qty</th><th style="padding:8px">Subtotal</th></tr></thead><tbody>' + rows + '</tbody></table><h3>Total: ৳' + Number(order.total).toFixed(2) + '</h3><p>Status: Pending</p></div>';
  const response = await fetch('https://api.resend.com/emails', { method: 'POST', headers: { Authorization: 'Bearer ' + apiKey, 'Content-Type': 'application/json' }, body: JSON.stringify({ from, to: [to], subject: 'New CRAFIA order ' + order.id, html }) });
  if (!response.ok) throw new Error('Resend email error: ' + response.status + ' ' + await response.text());
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
      transaction_ref TEXT NOT NULL DEFAULT '',
      items JSONB NOT NULL,
      total_bdt NUMERIC(12,2) NOT NULL,
      status TEXT NOT NULL DEFAULT 'Pending',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`ALTER TABLE crafia_orders ADD COLUMN IF NOT EXISTS transaction_ref TEXT NOT NULL DEFAULT ''`);
  await pool.query(`CREATE TABLE IF NOT EXISTS crafia_store_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL DEFAULT '')`);
  await pool.query(`CREATE TABLE IF NOT EXISTS crafia_inventory (product_id TEXT PRIMARY KEY, quantity INTEGER NOT NULL DEFAULT 0 CHECK (quantity >= 0), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
  await pool.query(`CREATE TABLE IF NOT EXISTS crafia_coupons (code TEXT PRIMARY KEY, discount_type TEXT NOT NULL CHECK (discount_type IN ('percent','fixed')), discount_value NUMERIC(12,2) NOT NULL CHECK (discount_value > 0), min_order NUMERIC(12,2) NOT NULL DEFAULT 0, active BOOLEAN NOT NULL DEFAULT TRUE, expires_at TIMESTAMPTZ)`);
  await pool.query(`CREATE TABLE IF NOT EXISTS crafia_reviews (id BIGSERIAL PRIMARY KEY, order_id TEXT NOT NULL, product_id TEXT NOT NULL, customer_name TEXT NOT NULL, customer_email TEXT NOT NULL DEFAULT '', rating INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5), review_text TEXT NOT NULL, photo_url TEXT NOT NULL DEFAULT '', approved BOOLEAN NOT NULL DEFAULT FALSE, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), UNIQUE(order_id, product_id))`);

}
app.get('/api/health', async (req, res) => {
  try { await pool.query('SELECT 1'); res.json({ status: 'ok', database: 'connected' }); }
  catch (e) { res.status(503).json({ status: 'error', database: 'disconnected' }); }
});
app.get('/api/store-config', async (req, res) => {
  try {
    const result = await pool.query("SELECT key, value FROM crafia_store_settings WHERE key IN ('payment_number','bkash_number','nagad_number')");
    const settings = Object.fromEntries(result.rows.map(row => [row.key, row.value]));
    res.json({ whatsappNumber: WHATSAPP_NUMBER, paymentNumber: settings.payment_number || '', bkashNumber: settings.bkash_number || '', nagadNumber: settings.nagad_number || '' });
  } catch (e) { res.status(500).json({ error: 'Could not load store settings.' }); }
});

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
app.get('/api/admin/settings', requireAdmin, async (req, res) => {
  try {
    const result = await pool.query("SELECT key, value FROM crafia_store_settings");
    const settings = Object.fromEntries(result.rows.map(row => [row.key, row.value]));
    res.json({ paymentNumber: settings.payment_number || '', bkashNumber: settings.bkash_number || '', nagadNumber: settings.nagad_number || '' });
  } catch (e) { res.status(500).json({ error: 'Could not load store settings.' }); }
});
app.put('/api/admin/settings', requireAdmin, async (req, res) => {
  const body = req.body || {};
  const cleanNumber = value => String(value || '').replace(/[^0-9+]/g, '').slice(0, 20);
  const paymentNumber = cleanNumber(body.paymentNumber);
  const bkashNumber = cleanNumber(body.bkashNumber);
  const nagadNumber = cleanNumber(body.nagadNumber);
  for (const [label, value] of [['Cash on delivery',paymentNumber],['bKash',bkashNumber],['Nagad',nagadNumber]]) {
    if (value && value.replace(/\D/g, '').length < 10) return res.status(400).json({ error: 'Please enter a valid '+label+' number.' });
  }
  try {
    for (const [key, value] of [['payment_number',paymentNumber],['bkash_number',bkashNumber],['nagad_number',nagadNumber]]) {
      await pool.query("INSERT INTO crafia_store_settings (key, value) VALUES ($1,$2) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value", [key,value]);
    }
    res.json({ saved: true, paymentNumber, bkashNumber, nagadNumber });
  } catch (e) { console.error('Save store settings failed:', e.message); res.status(500).json({ error: 'Could not save store settings.' }); }
});
app.get('/api/admin/orders', requireAdmin, async (req, res) => {
  try {
    const result = await pool.query(`SELECT public_id AS id, customer_name AS name,
      customer_phone AS phone, customer_address AS address, customer_district AS district,
      payment_method AS payment, customer_note AS note, transaction_ref AS "transactionRef", items, total_bdt AS total,
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

app.get('/api/inventory', async (req,res) => {
  try { const q=await pool.query('SELECT product_id AS "productId", quantity FROM crafia_inventory'); res.json({inventory:q.rows}); }
  catch(e){res.status(500).json({error:'Could not load stock.'});}
});
app.put('/api/admin/inventory/:productId', requireAdmin, async (req,res) => {
  const quantity=Number((req.body||{}).quantity);
  if(!Number.isInteger(quantity)||quantity<0||quantity>100000) return res.status(400).json({error:'Enter a valid stock quantity.'});
  try { const q=await pool.query('INSERT INTO crafia_inventory(product_id,quantity) VALUES($1,$2) ON CONFLICT(product_id) DO UPDATE SET quantity=EXCLUDED.quantity,updated_at=NOW() RETURNING product_id AS "productId",quantity',[String(req.params.productId).slice(0,100),quantity]); res.json({stock:q.rows[0]}); }
  catch(e){res.status(500).json({error:'Could not update stock.'});}
});
app.get('/api/admin/inventory', requireAdmin, async (req,res) => {
  try { const q=await pool.query('SELECT product_id AS "productId",quantity,updated_at AS "updatedAt" FROM crafia_inventory ORDER BY product_id'); res.json({inventory:q.rows}); }
  catch(e){res.status(500).json({error:'Could not load inventory.'});}
});
app.post('/api/admin/coupons', requireAdmin, async (req,res) => {
  const b=req.body||{}, code=String(b.code||'').trim().toUpperCase().replace(/[^A-Z0-9_-]/g,'').slice(0,40), type=b.discountType;
  const value=Number(b.discountValue), min=Number(b.minOrder||0);
  if(!code||!['percent','fixed'].includes(type)||!Number.isFinite(value)||value<=0||(type==='percent'&&value>100)||!Number.isFinite(min)||min<0) return res.status(400).json({error:'Check coupon code and discount values.'});
  try { const q=await pool.query('INSERT INTO crafia_coupons(code,discount_type,discount_value,min_order,expires_at) VALUES($1,$2,$3,$4,$5) ON CONFLICT(code) DO UPDATE SET discount_type=EXCLUDED.discount_type,discount_value=EXCLUDED.discount_value,min_order=EXCLUDED.min_order,expires_at=EXCLUDED.expires_at,active=TRUE RETURNING *',[code,type,value,min,b.expiresAt||null]); res.json({coupon:q.rows[0]}); }
  catch(e){res.status(500).json({error:'Could not save coupon.'});}
});
app.get('/api/admin/coupons', requireAdmin, async (req,res) => {
  try { const q=await pool.query('SELECT code,discount_type AS "discountType",discount_value AS "discountValue",min_order AS "minOrder",active,expires_at AS "expiresAt" FROM crafia_coupons ORDER BY code'); res.json({coupons:q.rows}); }
  catch(e){res.status(500).json({error:'Could not load coupons.'});}
});
app.post('/api/coupons/validate', async (req,res) => {
  const code=String((req.body||{}).code||'').trim().toUpperCase(), subtotal=Number((req.body||{}).subtotal);
  if(!code||!Number.isFinite(subtotal)||subtotal<0) return res.status(400).json({error:'Enter a valid coupon and order subtotal.'});
  try { const q=await pool.query('SELECT * FROM crafia_coupons WHERE code=$1 AND active=TRUE AND (expires_at IS NULL OR expires_at>NOW())',[code]); if(!q.rowCount) return res.status(404).json({error:'Coupon is invalid or expired.'}); const c=q.rows[0]; if(subtotal<Number(c.min_order)) return res.status(400).json({error:'Minimum order for this coupon is ৳'+Number(c.min_order).toFixed(0)}); const discount=Math.min(subtotal,c.discount_type==='percent'?subtotal*Number(c.discount_value)/100:Number(c.discount_value)); res.json({valid:true,code,discount:Number(discount.toFixed(2)),total:Number((subtotal-discount).toFixed(2))}); }
  catch(e){res.status(500).json({error:'Could not validate coupon.'});}
});
app.get('/api/admin/reviews', requireAdmin, async (req,res) => {
  try { const q=await pool.query('SELECT id,order_id AS "orderId",product_id AS "productId",customer_name AS "customerName",customer_email AS "customerEmail",rating,review_text AS review,"photo_url" AS "photoUrl",approved,created_at AS "createdAt" FROM crafia_reviews ORDER BY created_at DESC'); res.json({reviews:q.rows}); }
  catch(e){res.status(500).json({error:'Could not load reviews.'});}
});
app.patch('/api/admin/reviews/:id', requireAdmin, async (req,res) => {
  const approved=(req.body||{}).approved; if(typeof approved!=='boolean') return res.status(400).json({error:'Choose approve or reject.'});
  try { const q=await pool.query('UPDATE crafia_reviews SET approved=$1 WHERE id=$2 RETURNING id,approved',[approved,req.params.id]); if(!q.rowCount)return res.status(404).json({error:'Review not found.'}); res.json({review:q.rows[0]}); }
  catch(e){res.status(500).json({error:'Could not update review.'});}
});
app.get('/api/reviews/:productId', async (req,res) => {
  try { const q=await pool.query('SELECT customer_name AS "customerName",rating,review_text AS review,photo_url AS "photoUrl",created_at AS "createdAt" FROM crafia_reviews WHERE product_id=$1 AND approved=TRUE ORDER BY created_at DESC',[req.params.productId]); res.json({reviews:q.rows}); }
  catch(e){res.status(500).json({error:'Could not load reviews.'});}
});
app.post('/api/reviews', async (req,res) => {
  const b=req.body||{}, orderId=String(b.orderId||'').trim(), productId=String(b.productId||'').trim(), rating=Number(b.rating), review=String(b.review||'').trim().slice(0,3000), email=String(b.email||'').trim().slice(0,200), photoUrl=String(b.photoUrl||'').trim().slice(0,1000);
  if(!orderId||!productId||!Number.isInteger(rating)||rating<1||rating>5||!review) return res.status(400).json({error:'Complete the review details.'});
  try { const order=await pool.query("SELECT customer_name,items FROM crafia_orders WHERE public_id=$1 AND status='Delivered'",[orderId]); if(!order.rowCount)return res.status(403).json({error:'Reviews are available only after an order is marked Delivered.'}); if(!(order.rows[0].items||[]).some(i=>String(i.id)===productId))return res.status(403).json({error:'This product is not part of that order.'}); const q=await pool.query('INSERT INTO crafia_reviews(order_id,product_id,customer_name,customer_email,rating,review_text,photo_url) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id',[orderId,productId,order.rows[0].customer_name,email,rating,review,photoUrl]); res.status(201).json({submitted:true,reviewId:q.rows[0].id,message:'Review submitted for approval.'}); }
  catch(e){ if(e.code==='23505')return res.status(409).json({error:'A review for this product and order has already been submitted.'}); res.status(500).json({error:'Could not submit review.'});}
});

app.post('/api/orders', async (req, res) => {
  const body = req.body || {};
  const name = String(body.name || '').trim().slice(0, 120);
  const phone = String(body.phone || '').trim().slice(0, 40);
  const address = String(body.address || '').trim().slice(0, 500);
  const district = String(body.district || '').trim().slice(0, 100);
  const payment = String(body.payment || '').trim().slice(0, 80);
  const note = String(body.note || '').trim().slice(0, 1000);
  const transactionRef = String(body.transactionRef || '').trim().slice(0, 100);
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
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const item of cleanItems) {
      const stock = await client.query('SELECT quantity FROM crafia_inventory WHERE product_id=$1 FOR UPDATE', [item.id]);
      if (stock.rowCount) {
        if (Number(stock.rows[0].quantity) < item.qty) {
          await client.query('ROLLBACK');
          return res.status(409).json({ error: item.name + ' has only ' + stock.rows[0].quantity + ' left in stock.' });
        }
        await client.query('UPDATE crafia_inventory SET quantity=quantity-$1,updated_at=NOW() WHERE product_id=$2', [item.qty,item.id]);
      }
    }
    await client.query(
      `INSERT INTO crafia_orders (public_id, customer_name, customer_phone, customer_address, customer_district, payment_method, customer_note, transaction_ref, items, total_bdt)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [publicId, name, phone, address, district, payment, note, transactionRef, JSON.stringify(cleanItems), total]
    );
    await client.query('COMMIT');
    const order = { id: publicId, name, phone, address, district, payment, note, transactionRef, items: cleanItems, total, status: 'Pending' };
    sendOrderNotification(order).catch(err => console.error('Order notification email failed:', err.message));
    res.status(201).json({ order, whatsappNumber: WHATSAPP_NUMBER });
  } catch (e) {
    await client.query('ROLLBACK').catch(()=>{});
    console.error('Create order failed:', e.message);
    res.status(500).json({ error: 'Your order could not be saved. Please try again or contact us on WhatsApp.' });
  } finally { client.release(); }
});

app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
initDb().then(() => app.listen(PORT, () => console.log('CRAFIA server listening on ' + PORT)))
  .catch(err => { console.error('Startup failed:', err.message); process.exit(1); });
