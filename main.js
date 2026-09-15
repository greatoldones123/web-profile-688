// Theme Management with LocalStorage
const lightModeButton = document.querySelector(".theme-toggle-light");
const darkModeButton = document.querySelector(".theme-toggle-dark");

// Load saved theme from localStorage
function loadSavedTheme() {
    const savedTheme = localStorage.getItem('theme');

    if (savedTheme === 'dark') {
        document.body.classList.add('dark');
        lightModeButton.style.display = "none";
        darkModeButton.style.display = "block";
    } else {
        document.body.classList.remove('dark');
        lightModeButton.style.display = "block";
        darkModeButton.style.display = "none";
    }
}

// Save theme to localStorage
function saveTheme(theme) {
    localStorage.setItem('theme', theme);
}

// Theme Toggle Functionality
lightModeButton.addEventListener("click", () => {
    document.body.classList.add("dark");
    lightModeButton.style.display = "none";
    darkModeButton.style.display = "block";
    saveTheme('dark');
});

darkModeButton.addEventListener("click", () => {
    document.body.classList.remove("dark");
    darkModeButton.style.display = "none";
    lightModeButton.style.display = "block";
    saveTheme('light');
});

// Load theme on page load
loadSavedTheme();
// 预加载器已移除：不再在脚本中控制 `.pre-loader` 或在加载期间禁止滚动。

// Mobile Menu Toggle
const mobileMenuButton = document.querySelector(".mobile-menu-toggle");
const navigationMenu = document.querySelector(".navigation-menu");

mobileMenuButton.addEventListener("click", () => {
    navigationMenu.classList.toggle("dis");
    document.body.classList.toggle("overflow");
});

// Page Transition Handler
function setupPageTransitions() {
    // Check if browser supports View Transitions API
    const supportsViewTransitions = 'startViewTransition' in document;

    // Get all navigation links
    const links = document.querySelectorAll('a[href^="index.html"], a[href^="cv.html"], a[href^="research.html"], a[href^="design.html"], a[href^="contact.html"]');

    links.forEach(link => {
        link.addEventListener('click', function (e) {
            const targetUrl = this.href;
            const currentUrl = window.location.href;

            // Don't transition if clicking current page
            if (targetUrl === currentUrl) {
                e.preventDefault();
                return;
            }

            // Modern browsers: Use View Transitions API
            if (supportsViewTransitions) {
                e.preventDefault();

                document.startViewTransition(() => {
                    window.location.href = targetUrl;
                });
            }
            // Fallback: CSS animation
            else {
                e.preventDefault();

                // Add exit animation
                document.body.classList.add('page-exit');

                // Navigate after animation completes
                setTimeout(() => {
                    window.location.href = targetUrl;
                }, 300); // Match fadeOut duration
            }
        });
    });
}

// Initialize page transitions after DOM is ready
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', setupPageTransitions);
} else {
    setupPageTransitions();
}

// ==================== 访客埋点功能 ====================

// API 配置
// 同域相对路径，由 Netlify 边缘转发到 Cloudflare Workers（见根目录 _redirects）
// 这样浏览器看到的是 https://diyuzhou.com/api/visit，不触发 Mixed Content，也不产生跨域
const VISITOR_API_URL = '/api/visit';

// 获取浏览器信息
function getBrowserInfo() {
    const userAgent = navigator.userAgent;
    let browser = 'Unknown';

    if (userAgent.indexOf('Firefox') > -1) {
        browser = 'Firefox';
    } else if (userAgent.indexOf('Chrome') > -1) {
        browser = 'Chrome';
    } else if (userAgent.indexOf('Safari') > -1) {
        browser = 'Safari';
    } else if (userAgent.indexOf('Edge') > -1) {
        browser = 'Edge';
    } else if (userAgent.indexOf('Opera') > -1 || userAgent.indexOf('OPR') > -1) {
        browser = 'Opera';
    } else if (userAgent.indexOf('Trident') > -1) {
        browser = 'Internet Explorer';
    }

    return browser;
}

// 获取操作系统信息
function getOSInfo() {
    const userAgent = navigator.userAgent;
    let os = 'Unknown';

    if (userAgent.indexOf('Win') > -1) {
        os = 'Windows';
    } else if (userAgent.indexOf('Mac') > -1) {
        os = 'macOS';
    } else if (userAgent.indexOf('Linux') > -1) {
        os = 'Linux';
    } else if (userAgent.indexOf('Android') > -1) {
        os = 'Android';
    } else if (userAgent.indexOf('iOS') > -1 || userAgent.indexOf('iPhone') > -1 || userAgent.indexOf('iPad') > -1) {
        os = 'iOS';
    }

    return os;
}

// 获取当前页面路径
function getCurrentPage() {
    const path = window.location.pathname;
    const page = path.split('/').pop() || 'index.html';
    return page;
}

// 记录访客访问
async function recordVisit() {
    try {
        // 获取访客信息
        // 访客 IP 由后端从请求头（X-Forwarded-For / CF-Connecting-IP）读取，
        // 前端不再调用第三方 IP 接口，既避免了被墙，也防止 IP 被伪造
        const visitorData = {
            ip: '',
            page: getCurrentPage(),
            browser: getBrowserInfo(),
            os: getOSInfo(),
            user_agent: navigator.userAgent,
            referrer: document.referrer || '直接访问'
        };

        // 发送访客数据到后端
        const response = await fetch(VISITOR_API_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(visitorData)
        });

        if (response.ok) {
            const result = await response.json();
            console.log('访客记录成功:', result);
        } else {
            console.error('访客记录失败:', response.status);
        }
    } catch (error) {
        console.error('访客埋点错误:', error);
        // 埋点失败不影响页面正常使用，静默处理
    }
}

// 页面加载完成后记录访客
window.addEventListener('load', () => {
    // 延迟执行，避免阻塞页面加载
    setTimeout(() => {
        recordVisit();
    }, 1000);
});

// ==================== 联系表单逻辑 ====================

// 获取联系表单与提示节点，后续逻辑都以存在性为前提，避免在非 contact 页报错
const contactForm = document.querySelector('.form');
const notificationElement = document.getElementById('notification');

/**
 * 统一的轻量通知方法
 * @param {string} message 需要展示的中文提示
 * @param {'success'|'error'} type 控制样式的类型
 */
function showNotification(message, type = 'success') {
    if (!notificationElement) return; // 没有容器时直接返回，保证函数可重复调用

    // 先重置状态再写入内容，保证多次调用时不会叠加旧样式
    notificationElement.className = `notification ${type}`;
    notificationElement.textContent = message;
    notificationElement.classList.add('show');

    // 3 秒后自动隐藏，保持页面简洁
    setTimeout(() => {
        notificationElement.classList.remove('show');
    }, 3000);
}

// 仅当页面存在表单时才挂载提交事件
if (contactForm) {
    contactForm.addEventListener('submit', async function (e) {
        e.preventDefault();

        // ====== 数据收集与验证 ======
        const inputs = this.querySelectorAll('input, textarea, select');
        const formData = {};
        let isValid = true;

        inputs.forEach((input) => {
            const value = input.value.trim();

            if (input.hasAttribute('required') && !value) {
                // 必填校验失败时给出醒目边框提示
                isValid = false;
                input.style.borderColor = '#FF6B35';
                setTimeout(() => {
                    input.style.borderColor = '';
                }, 3000);
                return;
            }

            // 利用 data-i18n-placeholder 作为唯一键，确保字段映射稳定
            const i18nKey = input.getAttribute('data-i18n-placeholder');
            switch (i18nKey) {
                case 'contact.form.name':
                    formData.name = value;
                    break;
                case 'contact.form.email':
                    formData.email = value;
                    break;
                case 'contact.form.subject':
                    formData.subject = value;
                    break;
                case 'contact.form.message':
                    formData.message = value;
                    break;
                default:
                    break;
            }

            if (input.tagName === 'SELECT') {
                formData.companyType = input.options[input.selectedIndex].text;
            }
        });

        if (!isValid) {
            showNotification('请填写所有必填字段', 'error');
            return;
        }

        // ====== 提交控制（按钮状态 + fetch） ======
        const submitBtn = this.querySelector('button[type="submit"]');
        const textWrapper = submitBtn ? submitBtn.querySelector('span') : null;
        const originalText = textWrapper ? textWrapper.textContent : 'Send';

        if (textWrapper) {
            textWrapper.textContent = '发送中...';
        }
        submitBtn.disabled = true;

        try {
            // 提交到自有后端（同域，由 Netlify 转发到 Cloudflare Workers）
            const response = await fetch('/api/contact', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify(formData),
            });

            // 读取后端返回的真实结果，避免“其实没成功却提示成功”
            const result = await response.json().catch(function () { return {}; });

            if (response.ok && result.success) {
                showNotification('您的消息已发送！我们会尽快与您联系。', 'success');
                this.reset();
            } else {
                showNotification(result.message || '发送失败，请稍后重试。', 'error');
            }
        } catch (error) {
            console.error('发送失败:', error);
            showNotification('发送失败，请检查网络后重试。', 'error');
        } finally {
            // 无论成功失败都恢复按钮
            if (textWrapper) {
                textWrapper.textContent = originalText;
            }
            submitBtn.disabled = false;
        }
    });
}
