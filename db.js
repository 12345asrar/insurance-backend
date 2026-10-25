const { Pool } = require('pg');
require('dotenv').config();

// إنشاء مجمع اتصالات بقاعدة البيانات
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    // مطلوب لتأمين الاتصال المشفر مع خوادم Neon السحابية
    rejectUnauthorized: false
  },
  max: 20, // أقصى حد لعدد الاتصالات المتزامنة
  idleTimeoutMillis: 30000, // إغلاق الاتصالات الخاملة بعد 30 ثانية
  connectionTimeoutMillis: 10000, // مهلة انتظار الاتصال 10 ثوانٍ قبل إرجاع خطأ
});

// مراقبة نجاح الاتصال
pool.on('connect', () => {
  console.log('✅ تم إنشاء اتصال جديد بقاعدة بيانات Neon بنجاح');
});

// معالجة الأخطاء المفاجئة في الاتصالات الخاملة دون إيقاف السيرفر
pool.on('error', (err) => {
  console.error('❌ خطأ غير متوقع في مجمع اتصالات قاعدة البيانات:', err.message);
});

module.exports = pool;
