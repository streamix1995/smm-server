require('dotenv').config();
const express = require('express');
const app = express();
const path = require('path');
const multer = require('multer');
const cors = require('cors'); 
const { Pool } = require('pg'); 
const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));

app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '10mb' })); // زودنا الليميت عشان صور Base64
app.use(express.urlencoded({ limit: '10mb', extended: true }));
app.use(express.static(path.join(__dirname)));
// مبقناش محتاجين مجلد uploads لأن الصور هتتحفظ في الداتابيز، بس هنسيب السطر ده احتياطي
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function initDb() {
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS smm_orders (
                id VARCHAR(50) PRIMARY KEY,
                full_name VARCHAR(255),
                service VARCHAR(50),
                link TEXT,
                quantity INTEGER,
                receipt_image TEXT,
                paid_amount NUMERIC,
                actual_cost NUMERIC,
                profit NUMERIC,
                currency VARCHAR(10),
                status VARCHAR(255),
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);
        console.log('✅ [DB READY] Neon database initialized for SMM Orders');
    } catch (err) {
        console.error('❌ [INIT DB ERROR]', err.message);
    }
}
initDb();

// 💡 التعديل الأول: استخدام الميموري بدل المجلد عشان الصورة متتمسحش أبداً
const storage = multer.memoryStorage();
const upload = multer({ storage: storage });

const apiKey = '9aa5c38e80647507e652757543d475c9'; 
const apiUrl = 'https://justanotherpanel.com/api/v2';

const exchangeRates = { USD: 1, EGP: 50, SAR: 3.75, AED: 3.67, KWD: 0.31, QAR: 3.64 };

const baseCostPricesUSD = {
    '10380': 3.00, 
    '10023': 0.60, 
    '8526': 0.03   
};

app.get('/api/services', async (req, res) => {
    try {
        const params = new URLSearchParams();
        params.append('key', apiKey);
        params.append('action', 'services');

        const japRes = await fetch(apiUrl, { method: 'POST', body: params });
        const japServices = await japRes.json();

        if (Array.isArray(japServices)) {
            const myServices = japServices.filter(s => ['10380', '10023', '8526'].includes(s.service));
            const markedUpServices = myServices.map(s => {
                let originalRateUSD = parseFloat(s.rate);
                let profitRateUSD = originalRateUSD * 1.50; 
                let ratesInCurrencies = {};
                for (let curr in exchangeRates) {
                    ratesInCurrencies[curr] = (profitRateUSD * exchangeRates[curr]).toFixed(4);
                }
                return { service: s.service, name: s.name, rates: ratesInCurrencies, originalRateUSD: originalRateUSD };
            });
            return res.json(markedUpServices);
        }
        res.json([]);
    } catch (err) {
        res.status(500).json({ message: 'خطأ في جلب الأسعار' });
    }
});

// 💡 التعديل التاني: تحويل الصورة لـ Base64 وحفظها كنص في الداتابيز
app.post('/api/order', upload.single('receiptImage'), async (req, res) => {
    const { fullName, service, link, quantity, totalPrice, currency = 'EGP' } = req.body;
    
    let qty = parseInt(quantity) || 0;
    let paidAmount = parseFloat(totalPrice) || 0;
    
    let receiptImage = '';
    if (req.file) {
        // تحويل الصورة لنص Base64
        const base64Image = req.file.buffer.toString('base64');
        const mimeType = req.file.mimetype;
        receiptImage = `data:${mimeType};base64,${base64Image}`;
    }

    let ratePerThousandUSD = baseCostPricesUSD[service] || 3.00;
    let actualCostUSD = (qty * ratePerThousandUSD) / 1000;

    let rateToCurr = exchangeRates[currency] || 50;
    let actualCost = parseFloat((actualCostUSD * rateToCurr).toFixed(2));
    let profit = parseFloat((paidAmount - actualCost).toFixed(2));

    const orderId = Date.now().toString();
    const status = 'معلق (في انتظار الموافقة)';

    try {
        await pool.query(
            `INSERT INTO smm_orders 
            (id, full_name, service, link, quantity, receipt_image, paid_amount, actual_cost, profit, currency, status) 
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
            [orderId, fullName, service, link, qty, receiptImage, paidAmount, actualCost, profit, currency, status]
        );
        res.json({ success: true, message: 'تم إرسال طلبك بنجاح وسيتم تنفيذه قريباً بعد مراجعة الإيصال!' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false, message: 'حدث خطأ أثناء حفظ الطلب في قاعدة البيانات' });
    }
});

app.post('/api/admin/approve-order', async (req, res) => {
    const { orderId } = req.body;
    
    try {
        const orderRes = await pool.query('SELECT * FROM smm_orders WHERE id = $1', [String(orderId)]);
        if (orderRes.rows.length === 0) {
            return res.status(400).json({ message: 'الطلب غير موجود' });
        }
        
        const order = orderRes.rows[0];
        if (!order.status.includes('معلق')) {
            return res.status(400).json({ message: 'تم تنفيذ هذا الطلب مسبقاً' });
        }

        const params = new URLSearchParams();
        params.append('key', apiKey);
        params.append('action', 'add');
        params.append('service', order.service);
        params.append('link', order.link);
        params.append('quantity', order.quantity);

        const japRes = await fetch(apiUrl, { method: 'POST', body: params });
        const japData = await japRes.json();

        if (japData.order) {
            const newStatus = 'تم التنفيذ أوتوماتيك عبر JAP (رقم: ' + japData.order + ')';
            await pool.query('UPDATE smm_orders SET status = $1 WHERE id = $2', [newStatus, String(orderId)]);
            res.json({ message: 'تمت الموافقة وإرسال الطلب لـ JAP بنجاح!' });
        } else {
            const errorStatus = 'فشل: ' + (japData.error || 'خطأ');
            await pool.query('UPDATE smm_orders SET status = $1 WHERE id = $2', [errorStatus, String(orderId)]);
            res.json({ message: 'فشل الإرسال لـ JAP' });
        }
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'خطأ في الاتصال' });
    }
});

app.get('/api/admin/data', async (req, res) => {
    try {
        const dbRes = await pool.query('SELECT * FROM smm_orders ORDER BY created_at DESC');
        const orders = dbRes.rows.map(r => ({
            id: r.id,
            fullName: r.full_name,
            service: r.service,
            link: r.link,
            quantity: r.quantity,
            receiptImage: r.receipt_image,
            paidAmount: r.paid_amount,
            actualCost: r.actual_cost,
            profit: r.profit,
            currency: r.currency,
            status: r.status,
            createdAt: r.created_at
        }));
        res.json({ orders });
    } catch (err) {
        res.status(500).json({ message: 'خطأ في جلب البيانات' });
    }
});

// 💡 التعديل التالت: برمجة مسار الحذف المربوط بلوحة التحكم
app.delete('/api/admin/order/:id', async (req, res) => {
    // حماية إضافية: التأكد إن الطلب جاي من لوحة التحكم بمفتاح الإدارة
    const adminKey = req.headers['x-admin-key'];
    if (adminKey !== 'streamix_admin') {
        return res.status(401).json({ message: 'غير مصرح بحذف الطلبات' });
    }

    const orderId = String(req.params.id);
    try {
        const deleteRes = await pool.query('DELETE FROM smm_orders WHERE id = $1', [orderId]);
        if (deleteRes.rowCount === 0) {
            return res.status(404).json({ message: 'الطلب غير موجود أو تم حذفه مسبقاً' });
        }
        res.json({ success: true, message: 'تم حذف الطلب نهائياً 🗑️' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'خطأ في حذف الطلب من قاعدة البيانات' });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`SMM Server is running on: http://localhost:${PORT}`);
});