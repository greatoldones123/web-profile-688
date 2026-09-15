/**
 * 访客记录 API —— Cloudflare Workers + D1
 *
 * 接口与原有 FastAPI 后端保持完全一致，前端无需改动调用方式：
 *   POST /api/visit                      记录访问
 *   GET  /api/visitors?page&pageSize&search   分页列表
 *   GET  /api/stats                      总数 / 今日
 *   GET  /api/stats/pages?limit          页面访问排行
 *   GET  /health                         健康检查
 */

const MAX_PAGE_SIZE = 100;
const MAX_PAGE_LIMIT = 50;

// 联系表单
const NOTIFY_EMAIL = 'dz372@cornell.edu';   // 接收表单通知的邮箱
const RESEND_ENDPOINT = 'https://api.resend.com/emails';
const CONTACT_WINDOW_SECONDS = 60;          // 防刷时间窗
const CONTACT_MAX_PER_WINDOW = 3;           // 同一 IP 在窗口内最多提交次数

const CORS_HEADERS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Token',
    'Access-Control-Max-Age': '86400'
};

function json(data, status = 200) {
    return new Response(JSON.stringify(data), {
        status,
        headers: {
            'Content-Type': 'application/json; charset=utf-8',
            ...CORS_HEADERS
        }
    });
}

// ---------------- 工具函数 ----------------

// 北京时间（东八区），格式 YYYY-MM-DD HH:MM:SS，与旧后端 datetime.now() 一致
function beijingNow(offsetDays = 0) {
    const t = Date.now() + 8 * 3600 * 1000 + offsetDays * 86400 * 1000;
    return new Date(t).toISOString().slice(0, 19).replace('T', ' ');
}

// 北京时间的日期部分
function beijingDate(offsetDays = 0) {
    return beijingNow(offsetDays).slice(0, 10);
}

// 北京时间，按秒偏移（负数表示过去），用于防刷时间窗计算
function beijingTimeOffset(offsetSeconds = 0) {
    const t = Date.now() + 8 * 3600 * 1000 + offsetSeconds * 1000;
    return new Date(t).toISOString().slice(0, 19).replace('T', ' ');
}

/**
 * 时间周期 → 起始时间（北京时间字符串）
 * all / 未指定 返回 null，表示不限时间
 */
function rangeStart(range) {
    switch (range) {
        case 'today':
            return `${beijingDate(0)} 00:00:00`;
        case '7d':
            // 含今天在内的 7 天
            return `${beijingDate(-6)} 00:00:00`;
        case '30d':
            return `${beijingDate(-29)} 00:00:00`;
        default:
            return null;
    }
}

function isPrivateIp(ip) {
    if (!ip) return true;
    if (ip.startsWith('10.') || ip.startsWith('127.') || ip.startsWith('192.168.')) return true;
    if (/^172\.(1[6-9]|2\d|3[01])\./.test(ip)) return true;
    if (ip === '::1' || /^f[cd]/i.test(ip) || /^fe80/i.test(ip)) return true;
    return false;
}

/**
 * 获取访客真实 IP
 * 经过 Netlify 代理时，真实访客 IP 在 X-Forwarded-For 的第一段
 * 直连 Workers 时，Cloudflare 会填充 CF-Connecting-IP
 */
function getClientIp(request) {
    const xff = request.headers.get('x-forwarded-for');
    if (xff) {
        const candidates = xff.split(',').map(s => s.trim()).filter(Boolean);
        for (const ip of candidates) {
            if (!isPrivateIp(ip)) return ip;
        }
        if (candidates.length > 0) return candidates[0];
    }
    return request.headers.get('cf-connecting-ip') || 'Unknown';
}

// ---------------- 业务处理 ----------------

// 记录访客访问
async function handleVisit(request, env) {
    let body = {};
    try {
        body = await request.json();
    } catch (e) {
        body = {};
    }

    const ip = getClientIp(request);
    const now = beijingNow();

    const result = await env.DB.prepare(
        `INSERT INTO visitors (ip, timestamp, page, browser, os, user_agent, referrer, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
        ip,
        now,
        String(body.page || 'unknown'),
        String(body.browser || 'Unknown'),
        String(body.os || 'Unknown'),
        String(body.user_agent || ''),
        String(body.referrer || ''),
        now
    ).run();

    return json({
        success: true,
        message: '访问记录成功',
        visitor_id: result.meta ? result.meta.last_row_id : null,
        ip: ip
    });
}

// 联系表单提交：写入 D1 + 发送邮件通知
async function handleContact(request, env) {
    let body = {};
    try {
        body = await request.json();
    } catch (e) {
        return json({ success: false, message: '请求格式不正确' }, 400);
    }

    const name = String(body.name || '').trim().slice(0, 100);
    const email = String(body.email || '').trim().slice(0, 200);
    const subject = String(body.subject || '').trim().slice(0, 200);
    const message = String(body.message || '').trim().slice(0, 5000);

    if (!name || !email || !subject || !message) {
        return json({ success: false, message: '请填写所有必填字段' }, 400);
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return json({ success: false, message: '邮箱格式不正确' }, 400);
    }

    const ip = getClientIp(request);
    const now = beijingNow();

    // 防刷：同一 IP 在时间窗内提交超过上限则拒绝
    const windowStart = beijingTimeOffset(-CONTACT_WINDOW_SECONDS);
    const recent = await env.DB.prepare(
        'SELECT COUNT(*) as count FROM contacts WHERE ip = ? AND created_at >= ?'
    ).bind(ip, windowStart).first();

    if (recent && recent.count >= CONTACT_MAX_PER_WINDOW) {
        return json({ success: false, message: '提交过于频繁，请稍后再试' }, 429);
    }

    // 先落库 —— 这是主流程，必须成功
    const result = await env.DB.prepare(
        `INSERT INTO contacts (name, email, subject, message, ip, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`
    ).bind(name, email, subject, message, ip, now).run();

    const contactId = result.meta ? result.meta.last_row_id : null;

    // 邮件只是通知，失败不影响提交结果；未配置密钥时自动跳过
    // 失败详情只写日志，不返回给前端，避免泄露 Resend 报错信息
    let mailSent = false;
    if (getResendKey(env)) {
        try {
            mailSent = await sendContactNotification(env, { name, email, subject, message, ip, now });
        } catch (e) {
            console.error('通知邮件发送失败:', e);
        }
    }

    return json({
        success: true,
        message: '提交成功',
        id: contactId,
        mailSent: mailSent
    });
}

// 联系表单提交列表（分页 / 搜索 / 时间筛选）
async function handleContacts(url, env) {
    let page = parseInt(url.searchParams.get('page') || '1', 10);
    let pageSize = parseInt(url.searchParams.get('pageSize') || '10', 10);
    const search = (url.searchParams.get('search') || '').trim();

    if (!Number.isFinite(page) || page < 1) page = 1;
    if (!Number.isFinite(pageSize) || pageSize < 1) pageSize = 10;
    if (pageSize > MAX_PAGE_SIZE) pageSize = MAX_PAGE_SIZE;

    const offset = (page - 1) * pageSize;

    const conditions = [];
    const params = [];

    if (search) {
        conditions.push('(name LIKE ? OR email LIKE ? OR subject LIKE ? OR message LIKE ?)');
        const like = `%${search}%`;
        params.push(like, like, like, like);
    }

    const start = rangeStart(url.searchParams.get('range'));
    if (start) {
        conditions.push('created_at >= ?');
        params.push(start);
    }

    const where = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';

    const countRow = await env.DB.prepare(
        `SELECT COUNT(*) as count FROM contacts ${where}`
    ).bind(...params).first();

    const total = countRow ? countRow.count : 0;

    const rows = await env.DB.prepare(
        `SELECT id, name, email, subject, message, ip, created_at
         FROM contacts ${where}
         ORDER BY created_at DESC, id DESC
         LIMIT ? OFFSET ?`
    ).bind(...params, pageSize, offset).all();

    return json({
        success: true,
        data: rows.results || [],
        pagination: {
            page,
            pageSize,
            total,
            totalPages: Math.ceil(total / pageSize)
        }
    });
}

// 读取并规范化 Resend 密钥
// 通过管道/重定向写入 secret 时容易带入换行或空格，这里统一 trim，
// 否则 Authorization 头会变成 "Bearer re_xxx\r\n" 而认证失败
function getResendKey(env) {
    return String(env.RESEND_API_KEY || '').trim();
}

// 通过 Resend 发送通知邮件
async function sendContactNotification(env, data) {
    const from = String(env.RESEND_FROM || 'Portfolio <onboarding@resend.dev>').trim();
    const to = String(env.NOTIFY_EMAIL || NOTIFY_EMAIL).trim();

    const escapeHtml = function (value) {
        return String(value).replace(/[&<>"']/g, function (ch) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch];
        });
    };

    const html = `
        <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:14px;color:#111;line-height:1.7">
            <h2 style="margin:0 0 16px;font-size:16px">收到新的联系表单提交</h2>
            <table style="border-collapse:collapse">
                <tr><td style="padding:4px 12px 4px 0;color:#888">姓名</td><td>${escapeHtml(data.name)}</td></tr>
                <tr><td style="padding:4px 12px 4px 0;color:#888">邮箱</td><td>${escapeHtml(data.email)}</td></tr>
                <tr><td style="padding:4px 12px 4px 0;color:#888">主题</td><td>${escapeHtml(data.subject)}</td></tr>
                <tr><td style="padding:4px 12px 4px 0;color:#888">时间</td><td>${escapeHtml(data.now)}</td></tr>
                <tr><td style="padding:4px 12px 4px 0;color:#888">IP</td><td>${escapeHtml(data.ip)}</td></tr>
            </table>
            <div style="margin-top:16px;padding-top:16px;border-top:1px solid #eee;white-space:pre-wrap">${escapeHtml(data.message)}</div>
        </div>
    `;

    const response = await fetch(RESEND_ENDPOINT, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${getResendKey(env)}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            from: from,
            to: [to],
            reply_to: data.email,
            subject: `[联系表单] ${data.subject}`,
            html: html
        }),
        signal: AbortSignal.timeout(8000)
    });

    if (!response.ok) {
        const text = await response.text();
        throw new Error(`Resend ${response.status}: ${text}`);
    }

    return true;
}

// 分页 / 搜索访客列表
async function handleVisitors(url, env) {
    let page = parseInt(url.searchParams.get('page') || '1', 10);
    let pageSize = parseInt(url.searchParams.get('pageSize') || '10', 10);
    const search = (url.searchParams.get('search') || '').trim();

    if (!Number.isFinite(page) || page < 1) page = 1;
    if (!Number.isFinite(pageSize) || pageSize < 1) pageSize = 10;
    if (pageSize > MAX_PAGE_SIZE) pageSize = MAX_PAGE_SIZE;

    const offset = (page - 1) * pageSize;

    const conditions = [];
    const params = [];

    if (search) {
        conditions.push('(ip LIKE ? OR page LIKE ? OR browser LIKE ? OR os LIKE ?)');
        const like = `%${search}%`;
        params.push(like, like, like, like);
    }

    // 时间周期过滤
    const start = rangeStart(url.searchParams.get('range'));
    if (start) {
        conditions.push('timestamp >= ?');
        params.push(start);
    }

    const where = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';

    const countRow = await env.DB.prepare(
        `SELECT COUNT(*) as count FROM visitors ${where}`
    ).bind(...params).first();

    const total = countRow ? countRow.count : 0;

    const rows = await env.DB.prepare(
        `SELECT id, ip, timestamp, page, browser, os, user_agent, referrer
         FROM visitors ${where}
         ORDER BY timestamp DESC, id DESC
         LIMIT ? OFFSET ?`
    ).bind(...params, pageSize, offset).all();

    return json({
        success: true,
        data: rows.results || [],
        pagination: {
            page,
            pageSize,
            total,
            totalPages: Math.ceil(total / pageSize)
        }
    });
}

// 统计数据（周期内总量 / 今日）
async function handleStats(url, env) {
    const start = rangeStart(url.searchParams.get('range'));

    // total 跟随所选时间周期；today 始终是今天，不受周期影响
    const totalRow = start
        ? await env.DB.prepare(
            'SELECT COUNT(*) as count FROM visitors WHERE timestamp >= ?'
        ).bind(start).first()
        : await env.DB.prepare(
            'SELECT COUNT(*) as count FROM visitors'
        ).first();

    const todayRow = await env.DB.prepare(
        'SELECT COUNT(*) as count FROM visitors WHERE timestamp >= ? AND timestamp < ?'
    ).bind(`${beijingDate(0)} 00:00:00`, `${beijingDate(1)} 00:00:00`).first();

    return json({
        success: true,
        stats: {
            total: totalRow ? totalRow.count : 0,
            today: todayRow ? todayRow.count : 0
        }
    });
}

// 页面访问排行（支持时间周期过滤）
async function handlePageStats(url, env) {
    let limit = parseInt(url.searchParams.get('limit') || '10', 10);
    if (!Number.isFinite(limit) || limit < 1) limit = 10;
    if (limit > MAX_PAGE_LIMIT) limit = MAX_PAGE_LIMIT;

    const start = rangeStart(url.searchParams.get('range'));
    const where = start ? 'WHERE timestamp >= ?' : '';
    const params = start ? [start, limit] : [limit];

    const rows = await env.DB.prepare(
        `SELECT page, COUNT(*) as count
         FROM visitors
         ${where}
         GROUP BY page
         ORDER BY count DESC, page ASC
         LIMIT ?`
    ).bind(...params).all();

    return json({
        success: true,
        data: rows.results || []
    });
}

// ---------------- 路由 ----------------

export default {
    async fetch(request, env) {
        const url = new URL(request.url);
        const path = url.pathname.replace(/\/+$/, '') || '/';

        // 浏览器跨域预检
        if (request.method === 'OPTIONS') {
            return new Response(null, { status: 204, headers: CORS_HEADERS });
        }

        try {
            if (path === '/api/visit' && request.method === 'POST') {
                return await handleVisit(request, env);
            }
            if (path === '/api/contact' && request.method === 'POST') {
                return await handleContact(request, env);
            }
            if (path === '/api/contacts' && request.method === 'GET') {
                return await handleContacts(url, env);
            }
            if (path === '/api/visitors' && request.method === 'GET') {
                return await handleVisitors(url, env);
            }
            if (path === '/api/stats' && request.method === 'GET') {
                return await handleStats(url, env);
            }
            if (path === '/api/stats/pages' && request.method === 'GET') {
                return await handlePageStats(url, env);
            }
            if (path === '/health') {
                return json({ status: 'healthy', timestamp: new Date().toISOString() });
            }
            if (path === '/') {
                return json({ message: '访客记录管理系统 API', runtime: 'cloudflare-workers' });
            }
            return json({ success: false, message: 'Not Found' }, 404);
        } catch (error) {
            return json({
                success: false,
                message: '服务器内部错误',
                error: String(error)
            }, 500);
        }
    }
};
