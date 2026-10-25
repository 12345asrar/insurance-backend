require('dotenv').config();
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const pool = require('./db');

const app = express();
const PORT = process.env.PORT || 5000;
const JWT_SECRET = process.env.JWT_SECRET || 'insurance_secret_jwt_key_2026';

app.use(cors());
app.use(express.json({ limit: '25mb' }));
app.use(express.urlencoded({ extended: true, limit: '25mb' }));

// إعداد Multer للاحتفاظ بالملفات في الذاكرة المؤقتة للتحويل إلى Base64
const storage = multer.memoryStorage();
const upload = multer({
  storage: storage,
  limits: { fileSize: 8 * 1024 * 1024 }
});

// دالة تحويل الملفات إلى نصوص Base64 للتخزين الدائم داخل Neon
function fileToBase64(file) {
  if (!file || !file.buffer) return null;
  const mimeType = file.mimetype || 'image/jpeg';
  return `data:${mimeType};base64,${file.buffer.toString('base64')}`;
}

// دالة مساعدة لتسجيل الحركات الرقابية في جدول audit_logs
async function logAudit(req, action, details) {
  try {
    const userId = req.user ? req.user.id : null;
    const username = req.user ? req.user.username : (req.body.username || 'System/Guest');
    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || '127.0.0.1';

    await pool.query(
      `INSERT INTO audit_logs (user_id, username, action, details, ip_address)
       VALUES ($1, $2, $3, $4, $5)`,
      [userId, username, action, details, ip]
    );
  } catch (err) {
    console.error('فشل توثيق العملية في سجل التدقيق:', err.message);
  }
}

// برمجيات التحقق الوسيطة (Auth & RBAC Middlewares)
function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) return res.status(401).json({ error: 'غير مصرح: يجب تسجيل الدخول للوصول لهذه العملية' });

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return res.status(403).json({ error: 'انتهت صلاحية الجلسة أو الرمز غير صالح' });
    req.user = user;
    next();
  });
}

function requireRoles(...allowedRoles) {
  return (req, res, next) => {
    if (!req.user || !allowedRoles.includes(req.user.role)) {
      return res.status(403).json({ error: 'عذراً: ليس لديك الصلاحية الأمنية للقيام بهذا الإجراء' });
    }
    next();
  };
}

// ========================================================
// 1. تسجيل الدخول والمصادقة (Authentication)
// ========================================================
app.post('/api/auth/login', async (req, res) => {
  const { username, password } = req.body;
  try {
    const userRes = await pool.query('SELECT * FROM users WHERE TRIM(username) = TRIM($1)', [username]);
    if (userRes.rows.length === 0) {
      await logAudit(req, 'LOGIN_FAILED', `محاولة فاشلة باسم مستخدم غير مسجل: ${username}`);
      return res.status(401).json({ error: 'اسم المستخدم أو كلمة المرور غير صحيحة' });
    }

    const user = userRes.rows[0];
    const cleanInputPass = String(password).trim();
    const cleanDbPass = String(user.password).trim();

    let isMatch = (cleanDbPass === cleanInputPass);
    if (!isMatch && (cleanDbPass.startsWith('$2a$') || cleanDbPass.startsWith('$2b$'))) {
      isMatch = await bcrypt.compare(cleanInputPass, cleanDbPass);
    }

    if (!isMatch) {
      await logAudit(req, 'LOGIN_FAILED', `محاولة دخول بكلمة مرور خاطئة للحساب: ${username}`);
      return res.status(401).json({ error: 'اسم المستخدم أو كلمة المرور غير صحيحة' });
    }

    const token = jwt.sign(
      { id: user.id, username: user.username, role: user.role, full_name: user.full_name },
      JWT_SECRET,
      { expiresIn: '8h' }
    );

    req.user = user;
    await logAudit(req, 'LOGIN_SUCCESS', `تم تسجيل الدخول بنجاح للمستخدم: ${user.username} بدور ${user.role}`);

    res.json({
      message: 'تم تسجيل الدخول بنجاح',
      token,
      user: { id: user.id, username: user.username, role: user.role, full_name: user.full_name }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ========================================================
// 2. جهات العمل والمنشآت (Companies)
// ========================================================
app.get('/api/companies', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM companies ORDER BY id ASC');
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/companies', authenticateToken, requireRoles('ADMIN', 'REGISTRATION_OFFICER'), async (req, res) => {
  try {
    const { company_name, commercial_register, tax_number, insurance_number, phone, address } = req.body;
    const query = `
      INSERT INTO companies (company_name, commercial_register, tax_number, insurance_number, phone, address)
      VALUES ($1, $2, $3, $4, $5, $6) RETURNING *;
    `;
    const result = await pool.query(query, [company_name, commercial_register, tax_number, insurance_number, phone, address]);
    const company = result.rows[0];

    await logAudit(req, 'CREATE_COMPANY', `تسجيل منشأة جديدة: ${company.company_name} (رقم تأميني: ${company.insurance_number})`);

    res.status(201).json({ message: 'تم تسجيل جهة العمل بنجاح', company });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ========================================================
// 3. إدارة المؤمن عليهم (Employees)
// ========================================================
app.get('/api/employees', async (req, res) => {
  try {
    const query = `
      SELECT e.*, c.company_name 
      FROM employees e
      LEFT JOIN companies c ON e.company_id = c.id
      ORDER BY e.id DESC;
    `;
    const result = await pool.query(query);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/employees', upload.single('national_id_photo'), async (req, res) => {
  try {
    const { company_id, national_id, full_name, gender, basic_salary, hire_date } = req.body;

    if (!req.file) {
      return res.status(400).json({ error: 'صورة الهوية الوطنية وثيقة إجبارية' });
    }
    if (!national_id || !full_name || !gender || !basic_salary) {
      return res.status(400).json({ error: 'جميع الحقول الأساسية مطلوبة' });
    }

    const insuranceNumber = 'SSN-' + Math.floor(100000 + Math.random() * 900000);
    const photoBase64 = fileToBase64(req.file);

    const query = `
      INSERT INTO employees (
        company_id, national_id, full_name, gender, basic_salary, hire_date, national_id_photo_url, insurance_number
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      RETURNING *;
    `;

    const result = await pool.query(query, [
      company_id || 1,
      national_id,
      full_name,
      gender.toUpperCase(),
      basic_salary,
      hire_date || new Date(),
      photoBase64,
      insuranceNumber
    ]);

    const employee = result.rows[0];
    await logAudit(req, 'REGISTER_EMPLOYEE', `تسجيل مؤمن عليه: ${employee.full_name} برقم تأميني ${employee.insurance_number} في منشأة ${company_id}`);

    res.status(201).json({ message: 'تم تسجيل المؤمن عليه بنجاح وتخزين هويته دائمياً', employee });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ========================================================
// 4. الاشتراكات والتحصيل المحاسبي
// ========================================================
app.get('/api/contributions', async (req, res) => {
  try {
    const query = `
      SELECT mc.*, c.company_name, c.insurance_number AS company_ins_no
      FROM monthly_contributions mc
      JOIN companies c ON mc.company_id = c.id
      ORDER BY mc.id DESC;
    `;
    const result = await pool.query(query);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/contributions/generate', authenticateToken, requireRoles('ADMIN', 'FINANCIAL_AUDITOR'), async (req, res) => {
  const { company_id, billing_month } = req.body;
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const salRes = await client.query(
      `SELECT COALESCE(SUM(basic_salary), 0) AS total_salaries FROM employees WHERE company_id = $1`,
      [company_id]
    );

    const totalSalaries = parseFloat(salRes.rows[0].total_salaries);
    if (totalSalaries <= 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'لا يوجد موظفون برواتب مسجلين في هذه المنشأة' });
    }

    const employeeShare = parseFloat((totalSalaries * 0.06).toFixed(2));
    const employerShare = parseFloat((totalSalaries * 0.09).toFixed(2));
    const totalContribution = parseFloat((employeeShare + employerShare).toFixed(2));

    const billInsert = `
      INSERT INTO monthly_contributions (company_id, billing_month, total_salaries, employee_share, employer_share, total_contribution, status)
      VALUES ($1, $2, $3, $4, $5, $6, 'UNPAID')
      ON CONFLICT (company_id, billing_month) 
      DO UPDATE SET total_salaries = EXCLUDED.total_salaries, employee_share = EXCLUDED.employee_share, employer_share = EXCLUDED.employer_share, total_contribution = EXCLUDED.total_contribution
      RETURNING *;
    `;
    const billResult = await client.query(billInsert, [company_id, billing_month, totalSalaries, employeeShare, employerShare, totalContribution]);
    const bill = billResult.rows[0];

    const journalRes = await client.query(
      `INSERT INTO journal_entries (entry_date, description, reference_type, reference_id)
       VALUES (CURRENT_DATE, $1, 'MONTHLY_CONTRIBUTION', $2) RETURNING id`,
      [`استحقاق اشتراكات التأمين لشهر ${billing_month} - منشأة رقم ${company_id}`, bill.id]
    );
    const jId = journalRes.rows[0].id;

    await client.query(`INSERT INTO journal_entry_lines (journal_entry_id, account_code, debit, credit) VALUES ($1, '1201', $2, 0)`, [jId, totalContribution]);
    await client.query(`INSERT INTO journal_entry_lines (journal_entry_id, account_code, debit, credit) VALUES ($1, '4101', 0, $2)`, [jId, totalContribution]);

    await client.query('COMMIT');

    await logAudit(req, 'GENERATE_CONTRIBUTION', `احتساب اشتراك شهر ${billing_month} للمنشأة ${company_id} بإجمالي ${totalContribution}`);

    res.status(201).json({ message: 'تم احتساب الاشتراكات وتوليد القيد المحاسبي بنجاح', contribution: bill });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

app.post('/api/contributions/:id/pay', authenticateToken, requireRoles('ADMIN', 'FINANCIAL_AUDITOR'), async (req, res) => {
  const billId = req.params.id;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const billRes = await client.query('SELECT * FROM monthly_contributions WHERE id = $1', [billId]);
    if (billRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'الفاتورة غير موجودة' });
    }
    const bill = billRes.rows[0];
    if (bill.status === 'PAID') {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'الفاتورة مسددة مسبقاً' });
    }

    await client.query("UPDATE monthly_contributions SET status = 'PAID' WHERE id = $1", [billId]);

    const jRes = await client.query(
      `INSERT INTO journal_entries (entry_date, description, reference_type, reference_id)
       VALUES (CURRENT_DATE, $1, 'CONTRIBUTION_PAYMENT', $2) RETURNING id`,
      [`سداد اشتراكات شهر ${bill.billing_month} - منشأة رقم ${bill.company_id}`, billId]
    );
    const jId = jRes.rows[0].id;
    await client.query(`INSERT INTO journal_entry_lines (journal_entry_id, account_code, debit, credit) VALUES ($1, '1101', $2, 0)`, [jId, bill.total_contribution]);
    await client.query(`INSERT INTO journal_entry_lines (journal_entry_id, account_code, debit, credit) VALUES ($1, '1201', 0, $2)`, [jId, bill.total_contribution]);

    await client.query('COMMIT');

    await logAudit(req, 'PAY_CONTRIBUTION', `سداد فاتورة اشتراك رقم ${billId} للمنشأة ${bill.company_id} بمبلغ ${bill.total_contribution}`);

    res.json({ message: 'تم سداد الفاتورة وتوليد قيد التحصيل المالي بنجاح' });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// ========================================================
// 5. منح ومنافع التأمين
// ========================================================
app.get('/api/marriage-grants', async (req, res) => {
  try {
    const query = `
      SELECT cg.*, e.full_name, e.gender, e.insurance_number 
      FROM compensation_grants cg 
      JOIN employees e ON cg.employee_id = e.id 
      ORDER BY cg.id DESC;
    `;
    const result = await pool.query(query);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/marriage-grant', upload.single('marriage_contract'), async (req, res) => {
  try {
    const { employee_id, requested_amount } = req.body;
    if (!employee_id || !requested_amount || !req.file) {
      return res.status(400).json({ error: 'جميع البيانات والوثيقة الرسمية مطلوبة' });
    }

    const empRes = await pool.query('SELECT * FROM employees WHERE id = $1', [employee_id]);
    if (empRes.rows.length === 0) return res.status(404).json({ error: 'المؤمن عليه غير مسجل' });

    const employee = empRes.rows[0];
    if (employee.gender !== 'FEMALE') {
      return res.status(400).json({ error: 'قانونياً: منحة الزواج مخصصة للإناث فقط' });
    }

    const docBase64 = fileToBase64(req.file);
    const insertRes = await pool.query(
      `INSERT INTO compensation_grants (employee_id, grant_type, requested_amount, status, document_url, request_date)
       VALUES ($1, 'MARRIAGE_GRANT', $2, 'PENDING', $3, CURRENT_DATE) RETURNING *;`,
      [employee_id, requested_amount, docBase64]
    );

    const grant = insertRes.rows[0];
    await logAudit(req, 'REQUEST_GRANT', `طلب منحة زواج للمؤمن عليها ${employee.full_name} بمبلغ ${requested_amount}`);

    res.status(201).json({ message: 'تم تقديم الطلب وحفظ الوثيقة دائمياً', grant });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/marriage-grant/:id/approve', authenticateToken, requireRoles('ADMIN', 'FINANCIAL_AUDITOR'), async (req, res) => {
  const grantId = req.params.id;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const grantRes = await client.query(
      `SELECT cg.*, e.full_name FROM compensation_grants cg JOIN employees e ON cg.employee_id = e.id WHERE cg.id = $1`,
      [grantId]
    );
    if (grantRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'الطلب غير موجود' });
    }
    const grant = grantRes.rows[0];

    await client.query(`UPDATE compensation_grants SET status = 'APPROVED' WHERE id = $1`, [grantId]);

    const jRes = await client.query(
      `INSERT INTO journal_entries (entry_date, description, reference_type, reference_id)
       VALUES (CURRENT_DATE, $1, 'MARRIAGE_GRANT', $2) RETURNING id`,
      [`صرف منحة زواج للمؤمن عليها: ${grant.full_name}`, grantId]
    );
    const jId = jRes.rows[0].id;
    await client.query(`INSERT INTO journal_entry_lines (journal_entry_id, account_code, debit, credit) VALUES ($1, '5101', $2, 0)`, [jId, grant.requested_amount]);
    await client.query(`INSERT INTO journal_entry_lines (journal_entry_id, account_code, debit, credit) VALUES ($1, '1101', 0, $2)`, [jId, grant.requested_amount]);

    await client.query('COMMIT');

    await logAudit(req, 'APPROVE_GRANT', `اعتماد صرف منحة زواج للمؤمن عليها ${grant.full_name} بمبلغ ${grant.requested_amount}`);

    res.json({ message: 'تم اعتماد المنحة وتوليد القيد بنجاح' });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// ========================================================
// 6. استعراض دفتر اليومية العامة
// ========================================================
app.get('/api/journal-entries', async (req, res) => {
  try {
    const query = `
      SELECT 
        je.id AS entry_id,
        je.entry_date,
        je.description,
        jel.account_code,
        CASE 
          WHEN jel.account_code = '5101' THEN 'حـ/ مصروفات منافع التأمين'
          WHEN jel.account_code = '1101' THEN 'حـ/ البنك والصندوق'
          WHEN jel.account_code = '1201' THEN 'حـ/ مدينو الاشتراكات التأمينية'
          WHEN jel.account_code = '4101' THEN 'حـ/ إيرادات الاشتراكات التأمينية'
          ELSE jel.account_code
        END AS account_name,
        jel.debit,
        jel.credit
      FROM journal_entries je
      JOIN journal_entry_lines jel ON je.id = jel.journal_entry_id
      ORDER BY je.id DESC, jel.id ASC;
    `;
    const result = await pool.query(query);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ========================================================
// 7. استعراض سجل الرقابة الأمنية (Audit Logs)
// ========================================================
app.get('/api/audit-logs', authenticateToken, requireRoles('ADMIN'), async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM audit_logs ORDER BY id DESC LIMIT 100');
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`📡 الخادم يعمل بكامل معايير الأمان وسجل الرقابة: http://localhost:${PORT}`);
});
