require('dotenv').config();
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const pool = require('./db');

const app = express();
const PORT = process.env.PORT || 5000;

// تفعيل برمجيات الوسيط (Middlewares)
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// إنشاء مجلد uploads تلقائياً في حال عدم وجوده
const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

// جعل مجلد uploads متاحاً للوصول العام لعرض الصور
app.use('/uploads', express.static(uploadDir));

// إعداد التخزين باستخدام Multer
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e9);
    const ext = path.extname(file.originalname);
    cb(null, file.fieldname + '-' + uniqueSuffix + ext);
  }
});

const upload = multer({
  storage: storage,
  limits: { fileSize: 10 * 1024 * 1024 }, // حد أقصى 10 ميجابايت للملف
  fileFilter: (req, file, cb) => {
    const allowedTypes = /jpeg|jpg|png|pdf/;
    const extName = allowedTypes.test(path.extname(file.originalname).toLowerCase());
    const mimeType = allowedTypes.test(file.mimetype);

    if (extName && mimeType) {
      return cb(null, true);
    } else {
      cb(new Error('الملف يجب أن يكون صورة (JPEG, PNG) أو مستند PDF'));
    }
  }
});

// ==========================================
// 1. تسجيل مؤمن عليه جديد (مع إجبارية صورة البطاقة)
// ==========================================
app.post('/api/employees', upload.single('national_id_photo'), async (req, res) => {
  try {
    const { company_id, national_id, full_name, gender, basic_salary, hire_date } = req.body;

    // التحقق من رفع صورة البطاقة
    if (!req.file) {
      return res.status(400).json({ error: 'صورة البطاقة الشخصية وثيقة إجبارية لإتمام التسجيل' });
    }

    if (!national_id || !full_name || !gender || !basic_salary) {
      return res.status(400).json({ error: 'جميع البيانات الأساسية مطلوبة' });
    }

    const nationalIdPhotoUrl = `/uploads/${req.file.filename}`;

    const query = `
      INSERT INTO employees (
        company_id, national_id, full_name, gender, basic_salary, hire_date, national_id_photo_url
      ) VALUES ($1, $2, $3, $4, $5, $6, $7)
      RETURNING *;
    `;

    const values = [
      company_id || 1,
      national_id,
      full_name,
      gender.toUpperCase(),
      basic_salary,
      hire_date || new Date(),
      nationalIdPhotoUrl
    ];

    const result = await pool.query(query, values);

    res.status(201).json({
      message: '✅ تم تسجيل المؤمن عليه وحفظ صورة البطاقة بنجاح',
      employee: result.rows[0]
    });
  } catch (error) {
    console.error('خطأ في تسجيل الموظف:', error);
    res.status(500).json({ error: 'فشل في حفظ بيانات الموظف', details: error.message });
  }
});

// ==========================================
// 2. تقديم طلب منحة الزواج (للإناث فقط + عقد الزواج)
// ==========================================
app.post('/api/marriage-grant', upload.single('marriage_contract'), async (req, res) => {
  try {
    const { employee_id, requested_amount } = req.body;

    if (!employee_id || !requested_amount) {
      return res.status(400).json({ error: 'معرف الموظف ومبلغ المنحة مطلوبان' });
    }

    // التحقق من إرفاق وثيقة عقد الزواج
    if (!req.file) {
      return res.status(400).json({ error: 'إرفاق صورة عقد الزواج إجباري للتقديم على المنحة' });
    }

    // جلب بيانات الموظف والتحقق من الجنس
    const empResult = await pool.query('SELECT * FROM employees WHERE id = $1', [employee_id]);
    if (empResult.rows.length === 0) {
      return res.status(404).json({ error: 'الموظف غير مسجل في النظام' });
    }

    const employee = empResult.rows[0];

    // التحقق الصارم من قاعدة العمل: المنحة للإناث فقط
    if (employee.gender !== 'FEMALE') {
      return res.status(400).json({
        error: 'مرفوض برمجياً: منحة الزواج مخصصة قانونياً للإناث المؤمن عليهن فقط'
      });
    }

    const contractDocumentUrl = `/uploads/${req.file.filename}`;

    const insertQuery = `
      INSERT INTO compensation_grants (
        employee_id, grant_type, requested_amount, status, document_url, request_date
      ) VALUES ($1, 'MARRIAGE_GRANT', $2, 'PENDING', $3, CURRENT_DATE)
      RETURNING *;
    `;

    const grantResult = await pool.query(insertQuery, [employee_id, requested_amount, contractDocumentUrl]);

    res.status(201).json({
      message: '✅ تم تسجيل طلب منحة الزواج والتحقق من الأهلية بنجاح',
      grant: grantResult.rows[0]
    });
  } catch (error) {
    console.error('خطأ في تقديم منحة الزواج:', error);
    res.status(500).json({ error: 'فشل في تقديم الطلب', details: error.message });
  }
});

// ==========================================
// 3. اعتماد طلب المنحة وتوليد القيد المحاسبي آلياً
// ==========================================
app.post('/api/marriage-grant/:id/approve', async (req, res) => {
  const grantId = req.params.id;
  const client = await pool.connect();

  try {
    await client.query('BEGIN'); // بدء المعاملة المالية

    // جلب بيانات الطلب والتأكد من وجوده واستحقاقه
    const grantResult = await client.query(
      `SELECT cg.*, e.full_name, e.gender 
       FROM compensation_grants cg 
       JOIN employees e ON cg.employee_id = e.id 
       WHERE cg.id = $1`,
      [grantId]
    );

    if (grantResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'طلب المنحة غير موجود' });
    }

    const grant = grantResult.rows[0];

    if (grant.gender !== 'FEMALE') {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'مخالفة للنظام: المنحة مخصصة للإناث فقط' });
    }

    // تحديث حالة الطلب إلى معتمد
    await client.query(
      `UPDATE compensation_grants SET status = 'APPROVED' WHERE id = $1`,
      [grantId]
    );

    // إنشاء رأس قيد اليومية
    const journalResult = await client.query(
      `INSERT INTO journal_entries (entry_date, description, reference_type, reference_id)
       VALUES (CURRENT_DATE, $1, 'MARRIAGE_GRANT', $2)
       RETURNING id`,
      [`صرف منحة زواج للموظفة: ${grant.full_name}`, grantId]
    );

    const journalEntryId = journalResult.rows[0].id;
    const grantAmount = grant.requested_amount;

    // الطرف المدين: حساب مصروفات منافع التأمين (رقم الحساب الافتراضي 5101)
    await client.query(
      `INSERT INTO journal_entry_lines (journal_entry_id, account_code, debit, credit)
       VALUES ($1, '5101', $2, 0)`,
      [journalEntryId, grantAmount]
    );

    // الطرف الدائن: حساب الصندوق أو البنك (رقم الحساب الافتراضي 1101)
    await client.query(
      `INSERT INTO journal_entry_lines (journal_entry_id, account_code, debit, credit)
       VALUES ($1, '1101', 0, $2)`,
      [journalEntryId, grantAmount]
    );

    await client.query('COMMIT'); // تأكيد حفظ القيد

    res.status(200).json({
      message: '✅ تم اعتماد المنحة وإنشاء القيد المحاسبي المزدوج بنجاح',
      journal_entry_id: journalEntryId,
      amount: grantAmount
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('خطأ أثناء اعتماد القيد المحاسبي:', err);
    res.status(500).json({ error: 'فشل اعتماد القيد المحاسبي', details: err.message });
  } finally {
    client.release();
  }
});

// ==========================================
// 4. استعراض قوائم البيانات (للمراجعة والعرض)
// ==========================================
app.get('/api/employees', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM employees ORDER BY id DESC');
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/marriage-grants', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT cg.*, e.full_name, e.gender 
       FROM compensation_grants cg 
       JOIN employees e ON cg.employee_id = e.id 
       ORDER BY cg.id DESC`
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// تشغيل الخادم
app.listen(PORT, () => {
  console.log(`📡 الخادم يعمل حالياً على المنفذ: http://localhost:${PORT}`);
});
