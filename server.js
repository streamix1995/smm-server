require('dotenv').config();
const express = require('express');
const app = express();
const path = require('path');
const multer = require('multer');
const cors = require('cors'); // إضافة الربط مع الموقع الأساسي
const { Pool } = require('pg'); // إضافة قاعدة البيانات
const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));

// السماح باستقبال الطلبات من أي دومين (عشان اللاندنج بيج الأساسية تعرف تكلمه)
app.use(cors({ origin: '*' }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname)));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// إعداد اتصال قاعدة بيانات Neon (نفس قاعدة مشروعك الأساسي)
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// إنشاء جدول طلبات SMM لو مش موجود
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

const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        const uploadDir = path.join(__dirname, 'uploads');
        const fs = require('fs');
        if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir);
        cb(null, uploadDir);
    },
    filename: (req, file, cb) => {
        cb(null, Date.now() + path.extname(file.originalname));
    }
});
const upload = multer({ storage: storage });

const apiKey = '9aa5c38e80647507e652757543d475c9'; 
const apiUrl = 'https://justanotherpanel.com/api/v2';

// أسعار الصرف الدقيقة مقابل الدولار
const exchangeRates = { USD: 1, EGP: 50, SAR: 3.75, AED: 3.67, KWD: 0.31, QAR: 3.64 };

// أسعار التكلفة الفعلية الثابتة لكل 1000 وحدة (لمنع أخطاء الصفر والتأخير)
const baseCostPricesUSD = {
    '10380': 3.00, // متابعين
    '10023': 0.60, // لايكات
    '8526': 0.03   // مشاهدات
};

// سحب الأسعار وإضافة 50% ربح
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

// استقبال الطلب وحفظه في قاعدة البيانات
app.post('/api/order', upload.single('receiptImage'), async (req, res) => {
    const { fullName, service, link, quantity, totalPrice, currency = 'EGP' } = req.body;
    
    let qty = parseInt(quantity) || 0;
    let paidAmount = parseFloat(totalPrice) || 0;
    let receiptImage = req.file ? `/uploads/${req.file.filename}` : '';

    // حساب التكلفة والربح بشكل ثابت ودقيق
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

// الموافقة على الطلب وتحديث حالته في قاعدة البيانات
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

// جلب الطلبات للوحة التحكم من قاعدة البيانات
app.get('/api/admin/data', async (req, res) => {
    try {
        const dbRes = await pool.query('SELECT * FROM smm_orders ORDER BY created_at DESC');
        // تحويل أسماء الأعمدة للصيغة اللي واجهة الأدمن القديمة بتاعتك فاهماها
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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`SMM Server is running on: http://localhost:${PORT}`);
});