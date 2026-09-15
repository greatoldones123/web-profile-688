-- 访客记录表（D1 / SQLite）
-- 执行：npx wrangler d1 execute web-profile-visitors --remote --file=./schema.sql

CREATE TABLE IF NOT EXISTS visitors (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ip TEXT NOT NULL,
    timestamp TEXT NOT NULL,
    page TEXT NOT NULL,
    browser TEXT NOT NULL,
    os TEXT NOT NULL,
    user_agent TEXT,
    referrer TEXT,
    created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_visitors_timestamp ON visitors (timestamp);
CREATE INDEX IF NOT EXISTS idx_visitors_ip ON visitors (ip);
CREATE INDEX IF NOT EXISTS idx_visitors_page ON visitors (page);

-- 联系表单提交表
CREATE TABLE IF NOT EXISTS contacts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    email TEXT NOT NULL,
    subject TEXT NOT NULL,
    message TEXT NOT NULL,
    ip TEXT,
    created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_contacts_created_at ON contacts (created_at);
CREATE INDEX IF NOT EXISTS idx_contacts_ip ON contacts (ip);
