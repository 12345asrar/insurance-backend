const pool = require('./db');

const createTablesQuery = `
  -- 1. جدول الموظفين
  CREATE TABLE IF NOT EXISTS employees (
      id SERIAL PRIMARY KEY,
      company_id INT DEFAULT 1,
      national_id VARCHAR(50) UNIQUE NOT NULL,
      full_name VARCHAR(150) NOT NULL,
      gender VARCHAR(10) NOT NULL,
      basic_salary NUMERIC(12, 2) NOT NULL,
      hire_date DATE DEFAULT CURRENT_DATE,
      national_id_photo_url TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  );

  -- 2. جدول طلبات منحة الزواج
  CREATE TABLE IF NOT EXISTS compensation_grants (
      id SERIAL PRIMARY KEY,
      employee_id INT REFERENCES employees(id),
      grant_type VARCHAR(50) NOT NULL,
      requested_amount NUMERIC(12, 2) NOT NULL,
      status VARCHAR(20) DEFAULT 'PENDING',
      document_url TEXT NOT NULL,
      request_date DATE DEFAULT CURRENT_DATE,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  );

  -- 3. رؤوس القيود المحاسبية
  CREATE TABLE IF NOT EXISTS journal_entries (
      id SERIAL PRIMARY KEY,
      entry_date DATE DEFAULT CURRENT_DATE,
      description TEXT,
      reference_type VARCHAR(50),
      reference_id INT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  );

  -- 4. تفاصيل أطراف القيد المحاسبي
  CREATE TABLE IF NOT EXISTS journal_entry_lines (
      id SERIAL PRIMARY KEY,
      journal_entry_id INT REFERENCES journal_entries(id) ON DELETE CASCADE,
      account_code VARCHAR(20) NOT NULL,
      debit NUMERIC(12, 2) DEFAULT 0,
      credit NUMERIC(12, 2) DEFAULT 0
  );
`;

async function init() {
  try {
    console.log('⏳ جاري إنشاء الجداول في قاعدة بيانات Neon السحابية...');
    await pool.query(createTablesQuery);
    console.log('✅ تم إنشاء جميع جداول النظام المحاسبي والتأمينات بنجاح على السحابة!');
  } catch (error) {
    console.error('❌ حدث خطأ أثناء إنشاء الجداول:', error);
  } finally {
    pool.end();
  }
}

init();
