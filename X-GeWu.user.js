// ==UserScript==
// @name         X GeWu
// @name:zh-CN   X GeWu
// @namespace    https://x.com/gegewu203
// @version      0.3.14
// @description  Clean your own X posts by date, highlight following relationships and unfollow accounts without a visible follow-back indicator. Dry Run, verified actions and quotas. Visits @gegewu203 on first use, then at most once every 15 days.
// @description:zh-CN  按日期清理本人的 X 帖子；关注列表标注回关关系、记录观察到的互关历史并批量取关未显示回关的账号。默认模拟、保留名单与操作上限；首次使用跳转至 @gegewu203 主页，之后每 15 天最多一次。
// @author       GeWu (@gegewu203)
// @homepageURL  https://x.com/gegewu203
// @license      MIT
// @match        https://x.com/*
// @match        https://twitter.com/*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_addValueChangeListener
// @noframes
// @run-at       document-idle
// ==/UserScript==

/*
 * ============================================================================
 *  X GeWu —— 最高开发原则（需求 42）
 *
 *      安全优先 > 删除速度；宁可漏删，也不能误操作。
 *
 *  硬性行为约定：
 *      - 任何 selector 不确定   -> 跳过该帖子
 *      - 任何帖子归属不确定     -> 跳过该帖子
 *      - 任何菜单类型不确定     -> 跳过该帖子（绝不按菜单位置猜 Delete）
 *      - 任何确认弹窗不确定     -> 停止当前操作（尝试 Cancel / Esc，绝不乱点）
 *
 *  删除动作只允许走这条状态机链路，任何一步失败即放弃：
 *      找到 article -> 归属校验 -> 打开 caret 菜单 -> 精确文本匹配 Delete 菜单项
 *      -> 点击 -> 等待确认弹窗 -> 校验确认按钮 -> 点击确认 -> 等待帖子从 DOM 消失
 * ============================================================================
 */

(function () {
    'use strict';

    // =====================
    // CONFIG（全局常量）
    // =====================

    // 调试总开关（需求 36）。也可在 X 页面控制台执行：
    //   localStorage.setItem('xpc_debug', '1'); location.reload();
    const DEBUG_DEFAULT = false;
    const DEBUG = DEBUG_DEFAULT || (function () {
        try { return localStorage.getItem('xpc_debug') === '1'; } catch (err) { return false; }
    })();

    const VERSION = '0.3.14';
    const SCRIPT_NAME = 'X GeWu';

    const CONFIG = {
        MENU_WAIT_MS: 5000,        // 等待 "..." 下拉菜单出现
        CONFIRM_WAIT_MS: 6000,     // 等待删除确认弹窗出现
        REMOVE_WAIT_MS: 10000,     // 等待帖子从 DOM 中消失
        SCROLL_WAIT_MS: 6000,      // 滚动后等待新内容加载
        SCROLL_REWAIT_MS: 3000,    // 连续第二次"没有新内容"时的等待（加快到底判定）
        SCROLL_SETTLE_MS: 180,     // 滚动已前进时只短暂等待渲染，不空等完整加载超时
        SCROLL_STALL_MS: 45000,    // 持续加载/滚动但没有新增扫描结果时暂停，保留已收集内容
        RETRY_DELAY_MS: 1000,      // 单条失败后、重试前的等待（需求 18）
        MAX_ATTEMPTS: 3,           // 1 次原始尝试 + 最多 2 次重试（需求 18）
        FAILURE_BREAKER: 5,        // 连续失败熔断阈值（需求 29）
        OBSERVER_DEBOUNCE_MS: 400, // MutationObserver 防抖（需求 20）
        ROUTE_CHECK_MS: 1000,      // SPA 路由轮询兜底间隔（需求 21）
        LOG_MAX_LINES: 300,        // 面板日志最多保留行数
        LOG_PREVIEW_LEN: 60,       // 日志中帖子文本预览长度
        STORAGE_KEY: 'xpc.settings.v1',
        PROFILE_VISIT_USER: 'gegewu203',
        PROFILE_VISIT_KEY: 'xpc.profileVisit.v1.gegewu203',
        PROFILE_VISIT_INTERVAL_MS: 15 * 24 * 60 * 60 * 1000,
        PROFILE_VISIT_DELAY_MS: 0,
        PROFILE_VISIT_RETRY_MS: 1000,
        PROFILE_VISIT_PENDING_KEY: 'xpc.profileVisit.pending.v1.gegewu203',
        PROFILE_VISIT_PENDING_MS: 10000,
        PROFILE_VISIT_MAX_ATTEMPTS: 3,
        DAILY_KEY: 'xpc.daily.v1',   // 每日删除量持久化（跨会话/跨标签页）
        QUOTA_KEY: 'xpc.quota.v2.',  // 按账号保存小时/每日计数与批次冷却
        SUCCESS_KEY: 'xpc.success.v1.', // 仅累计页面终验确认成功的操作，不从旧配额推算
        HISTORY_KEY: 'xpc.followHistory.v1.',
        FOLLOW_SETTLE_MS: 900,
        FOLLOW_ROW_WAIT_MS: 5000,
        LOCK_KEY: 'xpc.lock.v1',     // 多标签页互斥锁
        LOCK_STALE_MS: 120000,       // 兼容后台标签页定时器节流
        LOCK_HEARTBEAT_MS: 2000,     // 锁心跳间隔
        BATCH_SIZE: 15,              // 每批次最多提交的操作数
        BATCH_COOLDOWN_MS: 180000,   // 批次休息时长（3 分钟）
    };

    // =====================
    // I18N（需求 8：文本只做辅助判断，主判断是 data-testid / role / DOM 结构）
    // =====================

    // Delete 菜单项 / 确认按钮的精确匹配词表（比较时统一 trim + toLowerCase + 折叠空白）
    // 注意：是「全等匹配」，不是子串匹配 —— "Delete account" 之类永远不会命中。
    const DELETE_TEXTS = [
        'delete', 'delete post', 'delete tweet', '删除', '删除帖子', '删除推文',
        '刪除', '刪除貼文', '削除', '삭제', 'löschen', 'supprimer', 'eliminar',
        'apagar', 'excluir', 'удалить', 'elimina', 'rimuovi', 'verwijderen',
        'usun', 'ta bort', 'poista', 'slet', 'törlés', 'xóa', 'ลบ',
    ];

    // "Undo repost" 菜单项 —— 与 Delete 相同的「精确全等 + 唯一命中」策略。
    // 覆盖现行中文文案（取消转帖）与旧文案（取消转推）及繁体变体。
    const UNDO_REPOST_TEXTS = [
        'undo repost', 'undo retweet', 'unrepost', 'un repost',
        '取消转帖', '取消轉帖', '撤销转帖', '撤銷轉帖',
        '取消转推', '取消轉推',
        'リポストを取り消す', 'リツイートを取り消す', '리포스트 취소', '리트윗 취소',
        'repost rückgängig machen', 'retweet rückgängig machen',
        'annuler le repost', 'annuler le retweet', 'deshacer repost', 'deshacer retweet',
        'desfazer repost', 'desfazer retweet', 'отменить репост', 'отменить ретвит',
    ];

    // 社交上下文行（帖子最上方那行小字）。X 中文 UI 现行文案是「你已转帖」，
    // 旧版是「你转推了」，繁体为「已轉帖/已轉推」——全部覆盖。
    const REPOSTED_PATTERNS = [
        /reposted/i, /转推了/, /已转推/, /转帖了/, /已转帖/,
        /轉推了/, /已轉推/, /轉帖了/, /已轉帖/,
        /リポスト/, /리포스트/,
        /repostet/i, /reposté/i, /repostou/i, /ha republicado/i,
    ];

    // 只检查独立社交上下文和明确广告标记，不把播放器的 placementTracking 当作广告。
    const PROMOTED_PATTERNS = [
        /^promoted\b/i, /^推广/, /^推廣/, /^sponsored\b/i, /^advertisement\b/i, /^ad\b/i, /^广告/, /^廣告/,
    ];
    const PROMOTED_LABELS = new Set(['ad', 'ads', 'promoted', 'sponsored', 'advertisement',
        '广告', '廣告', '推广', '推廣', '推广内容', '推廣內容']);

    // Rate limit / 频率限制提示（出现即自动暂停，绝不尝试绕过 —— 需求 30）
    const RATE_LIMIT_PATTERNS = [
        /rate limit/i, /trying again soon/i, /too many/i,
        /尝试次数过多/, /请求过多/, /稍后再试/, /操作过于频繁/,
    ];

    // URL 第一段是这些词时，一定不是个人主页（保守列表；个别真实用户名撞词时工具会拒绝工作，方向是安全的）
    const RESERVED_PATHS = new Set([
        'home', 'i', 'explore', 'notifications', 'messages', 'bookmarks', 'compose',
        'search', 'settings', 'account', 'welcome', 'login', 'signup', 'register',
        'logout', 'oauth', 'intent', 'hashtag', 'tos', 'privacy', 'help', 'faq',
        'support', 'rules', 'errors', 'flow', 'personalization', 'analytics',
        'monetization', 'premium', 'jobs', 'communities', 'events', 'embed',
        'wizard', 'share', 'directory', 'safety', 'status', 'media', 'likes',
        'highlights', 'articles', 'followers', 'following', 'verified_orgs',
        'verified_follow', 'privacy_dialog',
    ]);

    // =====================
    // SELECTORS（需求 35：集中管理。X 改版时只需要改这里。）
    //
    // 实测说明（2026-09）：未登录状态下 x.com 只渲染登录墙，时间线不渲染，
    // 无法匿名实测时间线内部结构。以下 selector 采用 X 多年保持稳定的
    // data-testid 体系，并在脚本内做了「匹配不到 -> 一律安全跳过」的兜底：
    // 即便 X 某天改版，最坏结果是不删，而不是误删。
    // =====================

    const SELECTORS = {
        // ---- 页面骨架 ----
        primaryColumn: '[data-testid="primaryColumn"]',      // 中央时间线列
        article: 'article[data-testid="tweet"]',             // 单条帖子容器
        userCell: '[data-testid="UserCell"]',
        layers: '#layers',                                   // 弹层/菜单挂载点

        // ---- 帖子内部 ----
        statusTime: 'a[href*="/status/"] time',              // 头部时间戳链接（归属 + id + 真实时间）
        statusLink: 'a[href*="/status/"]',                   // 任意状态链接（用于识别引用卡片）
        tweetText: '[data-testid="tweetText"]',              // 正文文本
        caret: '[data-testid="caret"]',                      // 右上角 "..." 菜单按钮
        userName: '[data-testid="User-Name"]',               // 外层作者与时间戳
        socialContext: '[data-testid="socialContext"]',
        quote: '[data-testid="quoteTweet"], [data-testid="quoteTweet-container"]',
        replyingTo: '[data-testid="replyingTo"]',
        promoted: '[data-testid="promotedIndicator"], svg[data-testid="ad"]',
        media: '[data-testid="tweetPhoto"], [data-testid="videoPlayer"], [data-testid="videoComponent"], video',
        unretweet: '[data-testid="unretweet"]',               // 当前账号已转帖的按钮
        retweet: '[data-testid="retweet"]',                   // 当前账号未转帖的按钮

        // ---- 菜单与确认弹窗 ----
        dropdown: '[data-testid="Dropdown"]',                // 下拉菜单容器（role=menu）
        menuItem: '[role="menuitem"]',                       // 菜单项
        confirmDelete: '[data-testid="confirmationSheetConfirm"]', // 删除确认弹窗的确认按钮
        confirmCancel: '[data-testid="confirmationSheetCancel"]',  // 删除确认弹窗的取消按钮
        unretweetConfirm: '[data-testid="unretweetConfirm"]',      // 取消转推的二次确认按钮（部分版本才出现）
        unretweetCancel: '[data-testid="unretweetCancel"]',        // 取消转推二次确认的取消按钮
        dialog: '[role="dialog"], [role="alertdialog"]',

        // ---- 登录态 / 账号识别 ----
        accountSwitcher: '[data-testid="SideNav_AccountSwitcher_Button"]', // 左下角账号切换器
        profileNav: '[data-testid="AppTabBar_Profile_Link"]',
        editProfileButton: '[data-testid="editProfileButton"]',            // 本人主页才有 "编辑资料"
        loginButton: '[data-testid="loginButton"]',          // 登录按钮（出现即视为未登录信号之一）
        toast: '[data-testid="toast"]',                      // 页面 toast（rate limit 提示）
    };

    // 菜单容器查询（data-testid 失效时退回 role=menu）
    const MENU_QUERY = SELECTORS.dropdown + ', [role="menu"]';

    // =====================
    // STATE（需求 22：统一状态管理）
    // =====================

    const state = {
        // 运行控制
        running: false,          // 是否有任务在跑（扫描或删除）
        starting: false,
        taskSettings: null,      // 启动时的配置快照；任务期间不改变执行模式
        taskContext: null,       // 启动时的账号与完整 URL
        taskTriedIds: new Set(), // 本次任务已处理（允许下一次任务重试未提交的失败）
        unknownElements: new WeakSet(),
        ownedMenu: null,
        ownedDialog: null,
        sessionUser: null,
        paused: false,           // 暂停标记（暂停 = 完成当前原子操作后不再开始下一条）
        stopRequested: false,    // 停止标记（完成当前原子操作后彻底退出）
        phase: 'idle',           // idle | scan | delete
        autoPauseReason: null,   // 自动暂停原因

        // 页面上下文
        currentUser: null,       // 当前登录账号 handle（如 "gegewu203"）
        currentUserSource: '',   // 识别来源（调试用）
        pageTaskReady: false,    // 当前页面是否允许启动任务
        pageTab: '',             // 当前内容标签页 key（posts/replies/highlights/media/articles/reposts）
        pageReason: '',          // 页面状态说明

        // 统计
        stats: { scanned: 0, matched: 0, deleted: 0, wouldDelete: 0, skipped: 0, failed: 0 },
        byType: { post: 0, reply: 0, quote: 0, repost: 0, unknown: 0 },
        eligibleByType: { post: 0, reply: 0, quote: 0, repost: 0 },
        skipReasonCounts: {}, // 跳过原因计数（任务结束汇总；任务外快照统计也需要）
        totalDeleted: 0,
        successAccount: '',

        // 去重（需求 14）
        seenIds: new Set(),        // 本次任务扫描过去重的 id（防重复统计）
        candidateIds: new Set(),   // 本次收集的候选；达到上限后不再扩充，即使有操作失败
        attemptedIds: new Set(),   // 已提交的操作 ID —— 页面会话内不重复提交
        dryRunTriedIds: new Set(), // Dry Run 演练过的 id（每次任务重置，避免演练卡死同一帖）

        // 错误保护
        consecutiveFailures: 0,  // 连续失败计数（熔断用）
        actionBlockReason: '',   // 最近一次点击复验未通过的具体原因

        // 操作配额
        myTabId: null,           // 本标签页随机 id（多标签互斥锁用）
        hourlyCount: 0,          // 本小时已删条数（自然小时 bucket，自动重置）
        hourKey: '',             // 当前小时 bucket 标识
        batchCount: 0,           // 本批次连续删除条数（批次休息用）
        lockTimer: null,         // 锁心跳定时器
        lockHeld: false,
        nativeLockRelease: null,
        quotaAccount: '',
        cooldownUntil: 0,
        logs: [],
        storageError: false,
    };

    // =====================
    // STORAGE / SETTINGS（需求 23：配置持久化，GM_* 优先，localStorage 兜底）
    // =====================

    const DEFAULT_SETTINGS = {
        types: { post: true, reply: true, quote: true, repost: false }, // 需求三的默认勾选
        dryRun: true,          // 需求 37：正式版默认 Dry Run = ON，用户手动关闭才会真删
        maxDelete: 100,        // 最多收集并处理 100 条符合条件的候选；0 = 无限制
        dateFrom: '',          // 浏览器本地日历日期 YYYY-MM-DD；空 = 不限制
        dateTo: '',            // 包含结束日期当天
        intervalMinSec: 3,     // 需求 12：随机间隔下限（秒）
        intervalMaxSec: 7,     // 需求 12：随机间隔上限（秒）
        hourlyLimit: 30,       // 每小时最多操作次数；0 = 不限制
        dailyLimit: 100,       // 每日最多操作次数（跨会话持久化）；0 = 不限制
        allowBackground: false,// 标签页不可见时是否继续运行
        showLog: true,
        panelPos: null,        // {x,y} 面板位置
        followMarkEnabled: true,
        followDryRun: true,
        maxUnfollow: 20,
        followWhitelist: '',
    };

    // 一个会话固定使用同一存储后端，避免 GM 写入失败后本地兜底与 GM 读取出现分叉。
    const USE_GM_STORAGE = typeof GM_getValue === 'function' && typeof GM_setValue === 'function';

    function storageGet(key) {
        try {
            return USE_GM_STORAGE ? GM_getValue(key, null) : localStorage.getItem(key);
        } catch (err) { state.storageError = true; return null; }
    }

    function storageSet(key, value) {
        try {
            if (USE_GM_STORAGE) GM_setValue(key, value);
            else localStorage.setItem(key, value);
            return true;
        } catch (err) { state.storageError = true; return false; }
    }

    function loadSettings() {
        const merged = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
        const raw = storageGet(CONFIG.STORAGE_KEY);
        if (!raw) return merged;
        try {
            const saved = typeof raw === 'string' ? JSON.parse(raw) : raw;
            if (saved && typeof saved === 'object') {
                if (saved.types && typeof saved.types === 'object') {
                    for (const key of Object.keys(merged.types)) {
                        if (typeof saved.types[key] === 'boolean') merged.types[key] = saved.types[key];
                    }
                }
                if (typeof saved.dryRun === 'boolean') merged.dryRun = saved.dryRun;
                if (typeof saved.showLog === 'boolean') merged.showLog = saved.showLog;
                if (typeof saved.allowBackground === 'boolean') merged.allowBackground = saved.allowBackground;
                if (Number.isFinite(saved.maxDelete)) merged.maxDelete = Math.floor(clamp(saved.maxDelete, 0, 100000));
                if (typeof saved.followMarkEnabled === 'boolean') merged.followMarkEnabled = saved.followMarkEnabled;
                if (typeof saved.followDryRun === 'boolean') merged.followDryRun = saved.followDryRun;
                if (Number.isFinite(saved.maxUnfollow)) merged.maxUnfollow = Math.floor(clamp(saved.maxUnfollow, 0, 100000));
                if (typeof saved.followWhitelist === 'string') merged.followWhitelist = saved.followWhitelist.slice(0, 20000);
                for (const key of ['dateFrom', 'dateTo']) {
                    // 无效存储必须显式拒绝，不能悄悄取消过滤而扩大删除范围。
                    if (Object.prototype.hasOwnProperty.call(saved, key)) merged[key] = typeof saved[key] === 'string' ? saved[key] : String(saved[key]);
                }
                if (Number.isFinite(saved.hourlyLimit)) merged.hourlyLimit = Math.floor(clamp(saved.hourlyLimit, 0, 10000));
                if (Number.isFinite(saved.dailyLimit)) merged.dailyLimit = Math.floor(clamp(saved.dailyLimit, 0, 100000));
                if (Number.isFinite(saved.intervalMinSec)) merged.intervalMinSec = Math.floor(clamp(saved.intervalMinSec, 1, 600));
                if (Number.isFinite(saved.intervalMaxSec)) merged.intervalMaxSec = Math.floor(clamp(saved.intervalMaxSec, 1, 600));
                if (merged.intervalMinSec > merged.intervalMaxSec) merged.intervalMaxSec = merged.intervalMinSec;
                if (saved.panelPos && Number.isFinite(saved.panelPos.x) && Number.isFinite(saved.panelPos.y)) {
                    merged.panelPos = { x: saved.panelPos.x, y: saved.panelPos.y };
                }
            }
        } catch (err) { /* 配置损坏 -> 使用默认值 */ }
        return merged;
    }

    function saveSettings() {
        // 用 debounce 包装，见下方 UTILS（函数声明提升，可以安全提前引用）
        debouncedSaveSettings();
    }

    const debouncedSaveSettings = debounce(function () {
        try { storageSet(CONFIG.STORAGE_KEY, JSON.stringify(settings)); } catch (err) { /* 忽略 */ }
    }, 400);

    let settings = loadSettings();

    function activeSettings() {
        return state.taskSettings || settings;
    }

    // =====================
    // LOGGER（需求 17）
    // =====================

    const ui = {}; // 面板 DOM 引用（buildPanel 时填充），日志函数需要提前兼容为空

    function formatTime(d) {
        const p = (x) => String(x).padStart(2, '0');
        return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
    }

    function log(msg, level) {
        level = level || 'info';
        const entry = { ts: formatTime(new Date()), msg: String(msg), level: level };
        state.logs.push(entry);
        if (state.logs.length > CONFIG.LOG_MAX_LINES) state.logs.shift();
        if (DEBUG || level === 'warn' || level === 'error') {
            const fn = level === 'error' ? console.error : (level === 'warn' ? console.warn : console.log);
            fn('[' + SCRIPT_NAME + ']', entry.msg);
        }
        appendLogLine(entry);
        // 错误自动展开日志面板（不改变 showLog 设置本身）：用户关掉日志时，报错也不能无声无息
        if (level === 'error' && ui.logBox && ui.logBox.style.display === 'none') {
            ui.logBox.style.display = 'block';
        }
    }

    function logDev(msg) {
        if (DEBUG) log(msg, 'debug');
    }

    function appendLogLine(entry) {
        if (!ui.logBox) return;
        const line = el('div', 'xpc-log-line xpc-log-' + entry.level);
        line.appendChild(el('span', 'xpc-log-time', entry.ts));
        line.appendChild(el('span', null, entry.msg)); // textContent 插入，天然防注入
        ui.logBox.appendChild(line);
        while (ui.logBox.childNodes.length > CONFIG.LOG_MAX_LINES) {
            ui.logBox.removeChild(ui.logBox.firstChild);
        }
        const nearBottom = ui.logBox.scrollTop + ui.logBox.clientHeight >= ui.logBox.scrollHeight - 60;
        if (nearBottom) ui.logBox.scrollTop = ui.logBox.scrollHeight;
    }

    // =====================
    // UTILS
    // =====================

    function el(tag, className, text) {
        const node = document.createElement(tag);
        if (className) node.className = className;
        if (text != null) node.textContent = text;
        return node;
    }

    function sleep(ms) {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }

    // 可被「停止」打断的 sleep（暂停不打断：剩余时间走完后由 pauseGate 挂起，符合需求 15）
    async function interruptibleSleep(ms) {
        const endAt = Date.now() + ms;
        while (Date.now() < endAt) {
            if (state.stopRequested) return;
            const remain = endAt - Date.now();
            await sleep(Math.min(250, remain));
        }
    }

    function clamp(value, min, max) {
        return Math.min(max, Math.max(min, value));
    }

    function clampNumber(raw, min, max, fallback) {
        const n = parseInt(raw, 10);
        if (isNaN(n)) return fallback;
        return clamp(n, min, max);
    }

    function randomInt(min, max) {
        let lo = Math.ceil(min);
        let hi = Math.floor(max);
        if (hi < lo) { const t = lo; lo = hi; hi = t; }
        return Math.floor(Math.random() * (hi - lo + 1)) + lo;
    }

    function truncate(text, n) {
        const s = String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
        return s.length > n ? s.slice(0, n - 1) + '…' : s;
    }

    function debounce(fn, waitMs) {
        let timer = null;
        return function () {
            const self = this;
            const args = arguments;
            if (timer) clearTimeout(timer);
            timer = setTimeout(() => { timer = null; fn.apply(self, args); }, waitMs);
        };
    }

    // 元素可见性：有布局盒子即认为可见（不依赖 offsetParent，弹层内也适用）
    function isVisible(target) {
        if (!target || !target.isConnected) return false;
        // aria-hidden 只影响辅助技术；X 弹窗会给仍可见的背景账号栏添加它。
        if (target.closest('[hidden]')) return false;
        const style = window.getComputedStyle(target);
        if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse') return false;
        return target.offsetWidth > 0 || target.offsetHeight > 0 || target.getClientRects().length > 0;
    }

    function isClickable(target) {
        return isVisible(target) && !target.disabled && target.getAttribute('aria-disabled') !== 'true'
            && !target.closest('[inert]');
    }

    function visibleElements(selector, root) {
        return Array.from((root || document).querySelectorAll(selector)).filter(isVisible);
    }

    function getItemText(target) {
        return String((target && target.textContent) || '').replace(/\s+/g, ' ').trim();
    }

    // 解析 /{handle}/status/{id} 形式的链接
    function parseStatusHref(href) {
        if (!href) return null;
        try {
            const url = new URL(href, location.origin);
            if (url.protocol !== 'https:' || !/^(?:www\.)?(?:x\.com|twitter\.com)$/.test(url.hostname)) return null;
            const m = url.pathname.match(/^\/([A-Za-z0-9_]{1,15})\/status\/(\d+)(?:\/(?:photo|video)\/\d+)?\/?$/);
            return m ? { username: m[1], id: m[2] } : null;
        } catch (err) { return null; }
    }

    // 等待条件成立（需求 19 的 waitForElement 泛化版）：
    // MutationObserver + 轮询双通道；超时返回 null；isAborted() 返回 true 时立即放弃。
    function waitForCondition(predicate, timeoutMs, desc, isAborted) {
        return new Promise((resolve) => {
            const startedAt = Date.now();
            let settled = false;
            let observer = null;
            let timer = null;
            let lastRun = 0;

            const finish = (value) => {
                if (settled) return;
                settled = true;
                if (observer) { try { observer.disconnect(); } catch (err) { /* noop */ } }
                if (timer) clearInterval(timer);
                resolve(value || null);
            };

            const run = (force) => {
                if (settled) return;
                const now = Date.now();
                if (!force && now - lastRun < 120) return; // 突发 mutation 限频，防止 CPU 空转
                lastRun = now;
                if (isAborted && isAborted()) return finish(null);
                let value = null;
                try { value = predicate(); } catch (err) { logDev('waitForCondition predicate 异常: ' + err.message); }
                if (value) return finish(value);
                if (now - startedAt >= timeoutMs) {
                    logDev('waitForCondition 超时: ' + (desc || 'unnamed'));
                    return finish(null);
                }
            };

            try {
                observer = new MutationObserver(() => run(false));
                observer.observe(document.documentElement, { childList: true, subtree: true });
            } catch (err) { observer = null; }

            timer = setInterval(() => run(true), 150);
            run(true);
        });
    }

    // React 重建节点不等于删除成功；按帖子 ID 与操作后的稳定页面状态终验。
    async function waitForPostOutcome(post, operation) {
        const tracker = { scrollY: operation.scrollY, absentSince: 0 };
        const found = await waitForCondition(() => postOutcomeObserved(post, tracker),
            CONFIG.REMOVE_WAIT_MS, '按 ID 验证操作结果', () => state.stopRequested || !validateTaskContext());
        return found ? { ok: true } : {
            ok: false, uncertain: operation.committed,
            reason: '已提交操作，但无法确认结果；请检查该帖子后再继续（不会自动重复提交）',
        };
    }

    function blockAction(reason) {
        state.actionBlockReason = reason;
        return false;
    }

    function actionAbortReason(fallback) {
        return state.autoPauseReason || state.actionBlockReason || fallback;
    }

    function checkClickTarget(target, guard) {
        if (!target || !target.isConnected) return blockAction('目标按钮已离开页面');
        if (!isVisible(target)) return blockAction('目标按钮已隐藏');
        if (target.closest('[inert]')) return blockAction('目标按钮所在区域不可交互（inert）');
        if (target.disabled || target.getAttribute('aria-disabled') === 'true') return blockAction('目标按钮已禁用');
        if (guard && !guard(target)) return state.actionBlockReason ? false : blockAction('点击前目标复验失败');
        return true;
    }

    // 只调用一次原生 click。菜单/确认框不能滚动、聚焦或派发人工鼠标事件，
    // 否则 X 可能关闭/重建弹层，或在 mouseup 就提前执行动作。
    // resolveTarget 只允许调用方在已取得的同一个弹层容器内找回唯一子项。
    async function realClick(target, guard, beforeCommit, resolveTarget) {
        state.actionBlockReason = '';
        if (!checkClickTarget(target, guard)) return false;
        if (target.closest(SELECTORS.article + ', ' + SELECTORS.userCell) && !target.closest(MENU_QUERY + ', ' + SELECTORS.dialog)) {
            try { target.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' }); } catch (err) { /* noop */ }
        }
        await sleep(randomInt(40, 140));
        if (resolveTarget) {
            target = resolveTarget();
            if (!target) return state.actionBlockReason ? false : blockAction('无法在原弹层中唯一找回目标按钮');
        }
        if (!checkClickTarget(target, guard)) return false;
        if (beforeCommit && !beforeCommit()) return state.actionBlockReason ? false : blockAction('提交前配额或归属复验失败');
        target.click();
        return true;
    }

    // Esc 关闭菜单/弹层
    function pressEscape() {
        try {
            const opts = { key: 'Escape', code: 'Escape', bubbles: true, cancelable: true };
            const target = document.activeElement || document;
            target.dispatchEvent(new KeyboardEvent('keydown', opts));
            target.dispatchEvent(new KeyboardEvent('keyup', opts));
        } catch (err) { /* noop */ }
    }

    // 只关闭本次操作取得的菜单/弹窗；禁止猜测背景节点或点击用户自己打开的弹窗。
    async function closeAllOverlays() {
        const dialog = state.ownedDialog;
        const menu = state.ownedMenu;
        if (dialog && isVisible(dialog)) {
            const cancels = visibleElements(SELECTORS.confirmCancel + ', ' + SELECTORS.unretweetCancel, dialog);
            if (cancels.length === 1) await realClick(cancels[0]);
            else pressEscape();
            await waitForCondition(() => !isVisible(dialog), 1200, '关闭确认弹窗');
        }
        if (menu && isVisible(menu)) {
            pressEscape();
            await waitForCondition(() => !isVisible(menu), 1200, '关闭菜单');
        }
        const closed = (!dialog || !isVisible(dialog)) && (!menu || !isVisible(menu));
        if (closed) { state.ownedMenu = null; state.ownedDialog = null; }
        else autoPause('脚本打开的菜单/确认弹窗未能关闭，请人工关闭后继续');
        return closed;
    }

    function openMenus() {
        const menus = visibleElements(MENU_QUERY);
        return menus.filter((menu) => !menus.some((other) => other !== menu && other.contains(menu)));
    }

    function findConfirmation(confirmSelector, cancelSelector) {
        const confirms = visibleElements(confirmSelector);
        if (confirms.length !== 1) return null;
        const button = confirms[0];
        let container = button.parentElement;
        while (container && container !== document.body) {
            const cancels = visibleElements(cancelSelector, container);
            if (cancels.length === 1 && visibleElements(confirmSelector, container).length === 1) {
                return { button, cancel: cancels[0], container };
            }
            container = container.parentElement;
        }
        return null;
    }

    async function prepareAction() {
        if (!(await closeAllOverlays())) return false;
        const dialogs = visibleElements(SELECTORS.dialog).filter((node) => !node.closest('.xpc-modal-mask'));
        if (openMenus().length || dialogs.length || visibleElements(SELECTORS.confirmDelete).length) {
            autoPause('页面已有菜单或弹窗，请人工关闭后继续');
            return false;
        }
        return canAct();
    }

    // =====================
    // AUTH / PAGE CONTEXT（需求二、七：只在本人主页工作；归属识别）
    // =====================

    function detectCurrentUser() {
        // 账号切换器与个人主页导航均属于登录态 UI；有冲突时拒绝猜测。
        try {
            const login = document.querySelector(SELECTORS.loginButton);
            if (login && isVisible(login)) return null;
            const candidates = [];
            const sw = document.querySelector(SELECTORS.accountSwitcher);
            if (sw && isVisible(sw)) {
                const handles = Array.from(new Set((getItemText(sw).match(/@[A-Za-z0-9_]{1,15}(?![A-Za-z0-9_])/g) || [])
                    .map((name) => name.slice(1).toLowerCase())));
                if (handles.length > 1) return null;
                if (handles.length === 1) candidates.push({ name: handles[0], source: '账号切换器' });
            }
            const nav = document.querySelector(SELECTORS.profileNav);
            if (nav && isVisible(nav)) {
                const url = new URL(nav.getAttribute('href'), location.origin);
                const m = url.origin === location.origin && url.pathname.match(/^\/([A-Za-z0-9_]{1,15})\/?$/);
                if (m && !RESERVED_PATHS.has(m[1].toLowerCase())) {
                    candidates.push({ name: m[1].toLowerCase(), source: '个人主页导航' });
                }
            }
            if (candidates.length) {
                return candidates.every((candidate) => candidate.name === candidates[0].name) ? candidates[0] : null;
            }
            const m = location.pathname.match(/^\/([A-Za-z0-9_]{1,15})(?:\/[A-Za-z0-9_]+)?\/?$/);
            const edit = document.querySelector(SELECTORS.primaryColumn + ' ' + SELECTORS.editProfileButton);
            if (m && !RESERVED_PATHS.has(m[1].toLowerCase()) && edit && isVisible(edit)) {
                return { name: m[1].toLowerCase(), source: 'Edit profile 按钮' };
            }
        } catch (err) { /* noop */ }
        return null;
    }

    // 个人主页内容标签页白名单（需求二扩展：亮点/媒体/文章/转帖同样属于本人内容页）
    const PROFILE_TAB_SEGMENTS = {
        '': 'posts',
        'with_replies': 'replies',
        'highlights': 'highlights',
        'media': 'media',
        'articles': 'articles',
        'reposts': 'reposts',
        'following': 'following',
        'followers': 'followers',
    };

    const TAB_LABELS = {
        posts: 'Posts 标签页',
        replies: 'Replies 标签页',
        highlights: '亮点(Highlights) 标签页',
        media: '媒体(Media) 标签页',
        articles: '文章(Articles) 标签页',
        reposts: '转帖(Reposts) 标签页',
        following: '正在关注(Following) 列表',
        followers: '关注者(Followers) 列表（关系标色）',
    };

    // 只允许在本人主页的内容标签页启动任务
    function evaluatePage() {
        const m = location.pathname.match(/^\/([A-Za-z0-9_]{1,15})(?:\/([A-Za-z0-9_]+))?\/?$/);
        if (!m) return { ok: false, reason: '请打开本人主页的内容标签页' };
        if (RESERVED_PATHS.has(m[1].toLowerCase())) return { ok: false, reason: '当前页面不是个人主页' };
        if (!state.currentUser) return { ok: false, reason: '未检测到登录账号（请先登录 X）' };
        if (m[1].toLowerCase() !== state.currentUser.toLowerCase()) {
            return { ok: false, reason: '该主页(@' + m[1] + ')不属于当前登录账号' };
        }
        const seg = (m[2] || '').toLowerCase();
        const tab = PROFILE_TAB_SEGMENTS[seg];
        if (!tab) {
            return { ok: false, reason: '标签页 /' + seg + ' 暂不支持（支持本人内容页、正在关注及关注者列表）' };
        }
        return { ok: true, tab: tab };
    }

    let lastCtxKey = '';
    let followingMarkTimer = null;
    function refreshContext() {
        const prevUser = state.currentUser;
        const detected = detectCurrentUser();
        state.currentUser = detected ? detected.name : null;
        state.currentUserSource = detected ? detected.source : '';

        const page = evaluatePage();
        state.pageTaskReady = page.ok;
        state.pageTab = page.ok ? page.tab : '';
        state.pageReason = page.reason || (TAB_LABELS[page.tab] || page.tab || '');

        // 账号变更 -> 清空会话去重缓存，避免跨账号脏数据
        if ((state.running || state.starting) && state.taskContext && (!state.currentUser || state.currentUser !== state.taskContext.user)) {
            stopTask('登录账号发生变化或无法确认，任务已停止');
        }
        if (state.sessionUser && state.currentUser && state.sessionUser !== state.currentUser) {
            state.attemptedIds.clear();
            state.seenIds.clear();
            log('登录账号已变更（@' + prevUser + ' -> @' + state.currentUser + '），已清空去重缓存', 'warn');
        }
        if (state.currentUser) state.sessionUser = state.currentUser;
        if (!state.running) {
            if (state.currentUser) syncQuota(state.currentUser);
            syncSuccessCount(state.currentUser);
        }
        if (ui.confirmMask && (ui.confirmContext.user !== state.currentUser || ui.confirmContext.href !== location.href)) {
            ui.closeConfirm();
        }

        const key = [state.currentUser, state.currentUserSource, state.pageTaskReady, state.pageReason].join('|');
        if (key !== lastCtxKey) {
            lastCtxKey = key;
            updatePanel();
        }
        refreshFollowingMarks();
    }

    // =====================
    // POST DETECTION（需求九：帖子内部对象；类型识别）
    // =====================

    const TYPE_LABELS = { post: '普通帖子', reply: '回复', quote: 'Quote', repost: 'Repost', unknown: '未知' };

    // 帖子第一行文本（社交上下文行：转推标记 / 推广标记都在这里）
    function getFirstLine(articleEl) {
        try {
            const text = articleEl.innerText || '';
            const lines = String(text).split('\n');
            for (const line of lines) {
                const t = line.trim();
                if (t) return t;
            }
        } catch (err) { /* noop */ }
        return '';
    }

    function ownElements(articleEl, selector) {
        return Array.from(articleEl.querySelectorAll(selector)).filter((node) => {
            if (node.closest(SELECTORS.article) !== articleEl || node.closest(SELECTORS.quote)) return false;
            const card = node.closest('[role="link"][tabindex="0"]');
            return !card || card === node || !articleEl.contains(card)
                || !(card.querySelector(SELECTORS.userName) && card.querySelector('time'));
        });
    }

    function mainStatus(articleEl) {
        const headers = ownElements(articleEl, SELECTORS.userName)
            .filter((header) => !header.closest('[role="link"][tabindex="0"]'));
        // 没有明确外层作者头部时，不拿引用卡片的时间戳冒充原帖。
        if (!headers.length) return null;
        const time = headers[0].querySelector(SELECTORS.statusTime);
        const link = time && time.closest('a[href*="/status/"]');
        const info = link && parseStatusHref(link.getAttribute('href'));
        return info ? { time, info } : null;
    }

    // 正文中的 status URL 是普通链接；只把独立引用卡片算作 Quote。
    function hasForeignStatusLink(articleEl, mainId) {
        if (articleEl.querySelector(SELECTORS.quote)) return true;
        const links = articleEl.querySelectorAll(SELECTORS.statusLink);
        for (const link of links) {
            if (link.closest(SELECTORS.tweetText) || link.closest(SELECTORS.socialContext)) continue;
            const info = parseStatusHref(link.getAttribute('href'));
            if (info && info.id !== mainId && link.querySelector('time')) return true;
        }
        const quoteCards = ownElements(articleEl, '[role="link"][tabindex="0"]');
        if (quoteCards.some((card) => card.querySelector(SELECTORS.userName) && card.querySelector('time'))) return true;
        return false;
    }

    // 回复识别："Replying to @x" 上下文行在 tweetText 的前一个兄弟节点
    //（没有回复上下文时，前一个兄弟是头部行，头部行必含 /status/ 时间戳链接 -> 排除）
    function isReplyContext(articleEl, textEl) {
        if (ownElements(articleEl, SELECTORS.replyingTo).length) return true;
        let node = textEl;
        while (node && node !== articleEl) {
            let prev = node.previousElementSibling;
            while (prev) {
                if (prev.matches(SELECTORS.userName) || prev.querySelector(SELECTORS.userName)) break;
                const txt = getItemText(prev);
                if (txt && txt.length <= 140 && !prev.matches(SELECTORS.tweetText)
                    && !prev.querySelector(SELECTORS.tweetText)
                    && /^(?:replying to\b|回复|回覆|返信|답글)/i.test(txt)) return true;
                prev = prev.previousElementSibling;
            }
            node = node.parentElement;
        }
        return false;
    }

    function isPromotedArticle(articleEl) {
        // 广告证据必须属于外层帖子；引用卡片、正文和媒体内的文本不能冒充平台广告标签。
        const content = SELECTORS.tweetText + ', ' + SELECTORS.userName + ', ' + SELECTORS.replyingTo
            + ', ' + SELECTORS.media + ', [data-testid="card.wrapper"], [data-testid^="card.layout"]'
            + ', [data-testid^="UserAvatar"], [data-testid="cardPoll"], [data-testid="poll"]';
        const evidence = (node) => !node.closest(content) && isVisible(node);
        if (ownElements(articleEl, SELECTORS.socialContext).some((node) => evidence(node)
            && PROMOTED_PATTERNS.some((pattern) => pattern.test(getItemText(node))))) return true;
        if (ownElements(articleEl, SELECTORS.promoted).some(evidence)) return true;
        if (ownElements(articleEl, 'a[href*="/i/ads"]').some((node) => {
            if (!evidence(node)) return false;
            try {
                const url = new URL(node.getAttribute('href'), location.origin);
                return url.origin === location.origin && /^\/i\/ads(?:\/|$)/.test(url.pathname);
            } catch (err) { return false; }
        })) return true;
        return ownElements(articleEl, 'span, [aria-label]').some((node) => {
            const label = String(node.getAttribute('aria-label') || '').trim().toLowerCase();
            const exact = PROMOTED_LABELS.has(label) || (node.children.length === 0
                && PROMOTED_LABELS.has(getItemText(node).toLowerCase()));
            return exact && evidence(node);
        });
    }

    // 解析一条帖子；任何结构不确定 -> 返回 null（上层直接忽略）
    function parseArticle(articleEl) {
        try {
            if (!articleEl || articleEl.tagName !== 'ARTICLE') return null;

            // 防嵌套：引用卡片理论上不是 <article>，但若 X 改版出现嵌套，只认顶层帖子（需求 27）
            if (articleEl.parentElement && articleEl.parentElement.closest('article')) return null;

            // 归属锚点来自明确的外层作者头部，不使用引用卡片的时间戳兜底。
            const main = mainStatus(articleEl);
            if (!main) return null;
            const timeEl = main.time;
            const info = main.info;

            const textEl = ownElements(articleEl, SELECTORS.tweetText)[0];
            const firstLine = getFirstLine(articleEl);
            const social = ownElements(articleEl, SELECTORS.socialContext)[0];
            const socialText = social ? getItemText(social) : firstLine;
            const activeRepost = ownElements(articleEl, SELECTORS.unretweet).filter(isVisible).length === 1;
            const promoted = isPromotedArticle(articleEl);

            let type = 'post';
            if (promoted) type = 'unknown';
            else if (REPOSTED_PATTERNS.some((p) => p.test(socialText))
                || (activeRepost && state.currentUser && info.username.toLowerCase() !== state.currentUser)) type = 'repost';
            else if (hasForeignStatusLink(articleEl, info.id)) type = 'quote';
            else if (isReplyContext(articleEl, textEl)) type = 'reply';

            return {
                id: info.id,
                url: 'https://x.com/' + info.username + '/status/' + info.id,
                type: type,
                promoted: promoted,
                text: textEl ? String(textEl.textContent || '').trim() : '',
                timestamp: timeEl.getAttribute('datetime') || '', // 外层原帖发布时间，用于日期范围筛选
                username: info.username,
                isOwner: !!state.currentUser && info.username.toLowerCase() === state.currentUser.toLowerCase(),
                deleted: false,
                skipped: false,
                firstLine: firstLine,
                activeRepost: activeRepost,
            };
        } catch (err) {
            logDev('parseArticle 异常: ' + (err && err.message));
            return null;
        }
    }

    // =====================
    // FILTERS（筛选；unknown 一律不删 —— 需求九）
    // =====================

    function validCalendarDate(value) {
        if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
        const [year, month, day] = value.split('-').map(Number);
        if (year < 1 || month < 1 || month > 12 || day < 1) return false;
        const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
        const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
        return day <= days[month - 1];
    }

    function dateRangeError(opts) {
        const from = opts.dateFrom === undefined ? '' : opts.dateFrom;
        const to = opts.dateTo === undefined ? '' : opts.dateTo;
        if (from !== '' && !validCalendarDate(from)) return '开始日期无效，请重新选择';
        if (to !== '' && !validCalendarDate(to)) return '结束日期无效，请重新选择';
        if (from && to && from > to) return '开始日期不能晚于结束日期';
        return '';
    }

    function dateRangeLabel(opts) {
        if (!opts.dateFrom && !opts.dateTo) return '不限日期';
        return (opts.dateFrom || '不限开始') + ' 至 ' + (opts.dateTo || '不限结束') + '（含首尾当天）';
    }

    function dateFilterResult(post, opts) {
        const error = dateRangeError(opts);
        if (error) return { ok: false, reason: error };
        if (!opts.dateFrom && !opts.dateTo) return { ok: true };
        // 只接受带明确时区的 ISO 时间，先校验原日历日期，防止无效日期被 Date 自动归一。
        const raw = typeof post.timestamp === 'string' ? post.timestamp : '';
        const parts = raw.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-](\d{2}):(\d{2}))$/i);
        if (!parts || !validCalendarDate(parts[1]) || Number(parts[2]) > 23 || Number(parts[3]) > 59
            || Number(parts[4]) > 59 || (parts[5] && (Number(parts[5]) > 23 || Number(parts[6]) > 59))) {
            return { ok: false, reason: '发布时间缺失或无效，无法按日期筛选' };
        }
        const time = new Date(raw);
        if (!Number.isFinite(time.getTime())) return { ok: false, reason: '发布时间缺失或无效，无法按日期筛选' };
        const day = String(time.getFullYear()).padStart(4, '0') + '-' + String(time.getMonth() + 1).padStart(2, '0')
            + '-' + String(time.getDate()).padStart(2, '0');
        if (opts.dateFrom && day < opts.dateFrom) return { ok: false, reason: '早于开始日期' };
        if (opts.dateTo && day > opts.dateTo) return { ok: false, reason: '晚于结束日期' };
        return { ok: true };
    }

    function filterResult(post) {
        if (post.promoted) return { ok: false, reason: '推广内容' };
        const opts = activeSettings();

        // 以当前账号的 unretweet 状态作为取消转帖凭据，不依赖不存在的专用标签页。
        if (post.type === 'repost') {
            if (!opts.types.repost) return { ok: false, reason: '类型未勾选(Repost)' };
            if (!post.activeRepost) return { ok: false, reason: '未找到当前账号已转帖的按钮' };
            return dateFilterResult(post, opts);
        }

        if (!post.isOwner) return { ok: false, reason: '不是当前账号的内容(@' + post.username + ')' };
        if (post.type === 'unknown') return { ok: false, reason: '类型无法识别(unknown 不删除)' };
        if (!opts.types[post.type]) return { ok: false, reason: '类型未勾选(' + TYPE_LABELS[post.type] + ')' };
        return dateFilterResult(post, opts);
    }

    // =====================
    // SCANNER（需求十三、十四：无限滚动 + 去重；需求三十一：只扫 primaryColumn）
    // =====================

    function candidateLimitReached() {
        const limit = activeSettings().maxDelete;
        return limit > 0 && state.stats.matched >= limit;
    }

    // 达到上限后只找回已收集的候选，不登记新 ID、统计或补扫失败条目。
    // 返回「符合条件且未尝试过」的帖子列表（DOM 顺序，最上在前）。
    function scanVisible() {
        const root = document.querySelector(SELECTORS.primaryColumn);
        if (!root) return [];
        const eligible = [];
        const articles = root.querySelectorAll(SELECTORS.article);

        for (const articleEl of articles) {
            if (candidateLimitReached()) {
                const main = mainStatus(articleEl);
                if (!main || !state.candidateIds.has(main.info.id)
                    || state.attemptedIds.has(main.info.id) || state.taskTriedIds.has(main.info.id)) continue;
            }
            const post = parseArticle(articleEl);
            if (!post) {
                if (articleEl.parentElement && articleEl.parentElement.closest('article')) continue;
                if (!state.unknownElements.has(articleEl)) {
                    state.unknownElements.add(articleEl);
                    state.stats.scanned++;
                    state.stats.skipped++;
                    state.byType.unknown++;
                    const reason = '无法识别外层作者/时间戳，结构不确定';
                    state.skipReasonCounts[reason] = (state.skipReasonCounts[reason] || 0) + 1;
                    logDev(reason);
                }
                continue;
            }

            if (state.seenIds.has(post.id)) {
                // 找回同一任务已收集、尚未处理且仍符合条件的候选。
                if (state.candidateIds.has(post.id) && !state.attemptedIds.has(post.id)
                    && !state.taskTriedIds.has(post.id) && filterResult(post).ok) {
                    eligible.push(post);
                }
                continue;
            }

            state.seenIds.add(post.id);
            state.stats.scanned += 1;
            state.byType[post.type] = (state.byType[post.type] || 0) + 1;
            logDev('扫描 ' + post.id + ' 类型=' + post.type + ' owner=' + post.isOwner + ' "' + truncate(post.text, 40) + '"');

            const verdict = filterResult(post);
            if (verdict.ok && state.attemptedIds.has(post.id)) {
                verdict.ok = false;
                verdict.reason = '本页面会话已提交过此帖的操作';
            }
            if (verdict.ok) {
                state.candidateIds.add(post.id);
                state.stats.matched += 1;
                state.eligibleByType[post.type] = (state.eligibleByType[post.type] || 0) + 1;
                eligible.push(post);
                if (candidateLimitReached()) break;
            } else {
                state.stats.skipped += 1;
                post.skipped = true;
                state.skipReasonCounts[verdict.reason] = (state.skipReasonCounts[verdict.reason] || 0) + 1;
                logDev('跳过 ' + post.id + ': ' + verdict.reason);
            }
        }
        return eligible;
    }

    function postScrollTarget() {
        const root = document.querySelector(SELECTORS.primaryColumn);
        for (let node = root; node && node !== document.body && node !== document.documentElement; node = node.parentElement) {
            const style = window.getComputedStyle(node);
            if (/(?:auto|scroll)/.test(style.overflowY || style.overflow)
                && node.scrollHeight > node.clientHeight + 2 && isVisible(node)) return node;
        }
        return null; // document scrolling continues to use the window APIs.
    }

    function postScrollPosition(target) {
        return Number(target ? target.scrollTop : window.scrollY) || 0;
    }

    function postTimelineSignals(root) {
        if (!root) return { loading: true, error: '' };
        const outsidePosts = (node) => !node.closest('article, aside, [data-testid="UserCell"]') && isVisible(node);
        const errors = Array.from(root.querySelectorAll('[data-testid="retry"], [data-testid="error-detail"], [data-testid="error-message"]'))
            .filter(outsidePosts);
        const loading = Array.from(root.querySelectorAll('[role="progressbar"], [data-testid="spinner"]')).some(outsidePosts);
        return { loading, error: errors.length ? truncate(getItemText(errors[0]) || '时间线加载失败', 100) : '' };
    }

    function hasUnscannedPosts(root) {
        if (!root) return false;
        for (const article of root.querySelectorAll(SELECTORS.article)) {
            if ((article.parentElement && article.parentElement.closest('article')) || !isVisible(article)) continue;
            const main = mainStatus(article);
            if (main && state.seenIds.has(main.info.id)) continue;
            if (!main) { if (!state.unknownElements.has(article)) return true; continue; }
            const post = parseArticle(article);
            if (post ? !state.seenIds.has(post.id) : !state.unknownElements.has(article)) return true;
        }
        return false;
    }

    function newPostScanProgress() {
        return { scanned: state.stats.scanned, lastProgressAt: Date.now(), emptyRounds: 0 };
    }

    function recordPostScanProgress(progress) {
        if (progress.scanned !== state.stats.scanned) {
            progress.scanned = state.stats.scanned;
            progress.lastProgressAt = Date.now();
            progress.emptyRounds = 0;
        }
    }

    function postScanReachedEnd(progress, result) {
        if (result.error) {
            autoPause('X 时间线加载失败：' + result.error + '。已保留扫描结果，请在页面恢复后点击继续。');
            return false;
        }
        if (result.newPosts) { progress.emptyRounds = 0; return false; }
        if (Date.now() - progress.lastProgressAt >= CONFIG.SCROLL_STALL_MS) {
            autoPause('X 时间线长时间没有加载新帖子。已保留扫描结果，请检查页面，加载恢复后点击继续。');
            return false;
        }
        // Scrolling is useful for reaching the loading sentinel, but is not new-content progress.
        if (result.loading || result.advanced) progress.emptyRounds = 0;
        else progress.emptyRounds++;
        return progress.emptyRounds >= 3;
    }

    // Loading, scrolling and genuinely new posts are separate outcomes.
    async function scrollAndWaitForNew(waitMs) {
        if (candidateLimitReached() || !canAct()) return { newPosts: false, advanced: false };
        const target = postScrollTarget();
        const beforeY = postScrollPosition(target);
        const startedAt = Date.now();
        const limit = activeSettings().maxDelete;
        log('正在加载更多帖子（符合条件 ' + state.stats.matched + (limit > 0 ? '/' + limit : '') + '）');
        // 小步且保留重叠区域，避免跳过虚拟时间线中未扫描的帖子。
        const step = Math.max(240, Math.round((target ? target.clientHeight : window.innerHeight) * 0.65));
        if (target) {
            if (typeof target.scrollBy === 'function') target.scrollBy({ top: step, behavior: 'instant' });
            else target.scrollTop += step;
        } else window.scrollBy({ top: step, behavior: 'instant' });

        const found = await waitForCondition(() => {
            const root = document.querySelector(SELECTORS.primaryColumn);
            if (hasUnscannedPosts(root)) return { newPosts: true, advanced: postScrollPosition(target) > beforeY + 2 };
            const signals = postTimelineSignals(root);
            if (signals.error) return { newPosts: false, advanced: false, ...signals };
            // 时间线已滚动但仍是同一批已加载内容：短暂让出渲染时间后继续前进，
            // 不能每一步都空等 6 秒。到页面底部无法前进时才等待新内容。
            if (postScrollPosition(target) > beforeY + 2 && Date.now() - startedAt >= CONFIG.SCROLL_SETTLE_MS) {
                return { newPosts: false, advanced: true, ...signals };
            }
            return false;
        }, waitMs || CONFIG.SCROLL_WAIT_MS, '等待新帖子加载', () => !canAct());

        // Even an immediately available result must yield to Stop/Pause and rendering.
        await sleep(0);
        return found || { newPosts: false, advanced: postScrollPosition(target) > beforeY + 2,
            ...postTimelineSignals(document.querySelector(SELECTORS.primaryColumn)) };
    }

    // 在当前 DOM 中按 id 找回帖子元素（重试时元素可能已被 React 重建）
    function findArticleElById(id) {
        const root = document.querySelector(SELECTORS.primaryColumn);
        if (!root) return null;
        const articles = root.querySelectorAll(SELECTORS.article);
        for (const articleEl of articles) {
            const main = mainStatus(articleEl);
            if (main && main.info.id === id) return articleEl;
        }
        return null;
    }

    // =====================
    // DELETE ENGINE（需求六、七：状态机 + 五层验证）
    // =====================

    function isDeleteText(rawText) {
        return DELETE_TEXTS.indexOf(String(rawText || '').replace(/\s+/g, ' ').trim().toLowerCase()) !== -1;
    }

    // 在菜单中精确定位 Delete 项：role=menuitem + 文本全等匹配。
    // 0 个或多个命中都放弃 —— 绝不 menuItems[0].click()。
    function findDeleteMenuItem(menu) {
        const items = Array.from(menu.querySelectorAll(SELECTORS.menuItem));
        if (!items.length) return null;
        if (DEBUG) log('菜单项: ' + items.map(getItemText).join(' | '), 'debug');
        const hits = items.filter((item) => isVisible(item) && isDeleteText(getItemText(item)));
        if (hits.length !== 1) return null;
        return isClickable(hits[0]) ? hits[0] : null;
    }

    // Undo repost 菜单项：与 Delete 相同的「精确全等 + 唯一命中」策略，绝不按位置猜
    function isUndoRepostText(rawText) {
        return UNDO_REPOST_TEXTS.indexOf(String(rawText || '').replace(/\s+/g, ' ').trim().toLowerCase()) !== -1;
    }

    function findUndoRepostMenuItem(menu) {
        const items = Array.from(menu.querySelectorAll(SELECTORS.menuItem + ', ' + SELECTORS.unretweetConfirm));
        if (!items.length) return null;
        if (DEBUG) log('转帖菜单项: ' + items.map(getItemText).join(' | '), 'debug');
        const hits = items.filter((item) => isVisible(item) && isUndoRepostText(getItemText(item)));
        if (hits.length !== 1) return null;
        return isClickable(hits[0]) ? hits[0] : null;
    }

    function validateTaskContext() {
        const context = state.taskContext;
        if (!context) return false;
        const detected = detectCurrentUser();
        if (location.href !== context.href || !detected || detected.name !== context.user) {
            stopTask('页面或登录账号已变化，终止当前任务');
            return false;
        }
        return true;
    }

    function canAct() {
        if (!taskActive()) return blockAction('任务已停止');
        if (state.paused && state.autoPauseReason) return blockAction(state.autoPauseReason);
        if (!validateTaskContext()) return blockAction('页面或登录账号已变化');
        if (isMutatingPhase(state.phase) && !ownsLock()) {
            stopTask('运行锁已丢失，停止操作');
            return blockAction('运行锁已丢失');
        }
        return safetyCheck() || blockAction(state.autoPauseReason || '页面安全检查未通过');
    }

    function currentPost(post) {
        const article = findArticleElById(post.id);
        const parsed = article && parseArticle(article);
        return parsed && parsed.id === post.id && parsed.username.toLowerCase() === post.username.toLowerCase()
            && parsed.type === post.type && filterResult(parsed).ok ? article : null;
    }

    function commitAction(post, operation) {
        if (!canAct()) return false;
        if (!currentPost(post)) return blockAction('目标帖子已离开页面或归属/类型发生变化');
        if (operation.committed) return true;
        if (!checkQuotaBeforeAction() || !recordAction()) return false;
        operation.committed = true;
        operation.scrollY = window.scrollY;
        state.attemptedIds.add(post.id);
        return true;
    }

    function postOutcomeObserved(post, tracker) {
        if (!validateTaskContext()) return false;
        const article = findArticleElById(post.id);
        if (post.type === 'repost' && article) {
            const active = ownElements(article, SELECTORS.unretweet).filter(isVisible);
            const inactive = ownElements(article, SELECTORS.retweet).filter(isVisible);
            if (!active.length && inactive.length === 1) return true;
        }
        if (article || Math.abs(window.scrollY - tracker.scrollY) > 2
            || !document.querySelector(SELECTORS.primaryColumn)) {
            tracker.absentSince = 0;
            return false;
        }
        if (!tracker.absentSince) tracker.absentSince = Date.now();
        return Date.now() - tracker.absentSince >= 900;
    }

    async function performAction(post, operation) {
        if (!(await prepareAction())) return { ok: false, aborted: true, reason: '等待页面恢复后继续' };
        const article = currentPost(post);
        if (!article) return { ok: false, skipped: true, reason: '帖子已离开页面或归属/类型复验失败' };
        const repost = post.type === 'repost';
        const buttons = ownElements(article, repost ? SELECTORS.unretweet : SELECTORS.caret).filter(isClickable);
        if (buttons.length !== 1) return {
            ok: false, skipped: true,
            reason: repost ? '无法唯一定位当前账号已转帖的按钮' : '无法唯一定位外层帖子菜单按钮',
        };
        const button = buttons[0];
        const stillCurrent = () => canAct() && (currentPost(post) === button.closest(SELECTORS.article)
            || blockAction('目标帖子节点已变化或无法确认归属'));
        if (!(await realClick(button, stillCurrent))) return { ok: false, aborted: true, reason: actionAbortReason('帖子菜单按钮复验失败') };
        const justOpened = openMenus();
        if (justOpened.length === 1) state.ownedMenu = justOpened[0];

        const menu = await waitForCondition(() => {
            const menus = openMenus();
            return menus.length === 1 ? menus[0] : null;
        }, CONFIG.MENU_WAIT_MS, repost ? '转帖按钮菜单' : '帖子菜单', () => !canAct());
        if (!menu) return {
            ok: false, aborted: !canAct(),
            reason: openMenus().length > 1 ? '出现多个菜单，拒绝猜测目标' : '菜单未出现',
        };
        state.ownedMenu = menu;
        let item = repost ? findUndoRepostMenuItem(menu) : findDeleteMenuItem(menu);
        if (!item) return {
            ok: false, skipped: true,
            reason: repost ? '菜单中没有唯一的取消转帖项' : '菜单中没有唯一的 Delete 项',
        };
        const matchesText = () => repost ? isUndoRepostText(getItemText(item)) : isDeleteText(getItemText(item));
        const menuGuard = () => {
            if (!canAct()) return false;
            if (!currentPost(post)) return blockAction('目标帖子已离开页面或归属/类型复验失败');
            if (state.ownedMenu !== menu || !isVisible(menu)) return blockAction('原帖子菜单已关闭或重建');
            if (!menu.contains(item) || !matchesText()) return blockAction('菜单项已变化或操作文案不匹配');
            const menus = openMenus();
            if (menus.length !== 1 || menus[0] !== menu) return blockAction('页面菜单不再唯一，拒绝猜测目标');
            return true;
        };
        const resolveMenuItem = () => {
            if (state.ownedMenu !== menu || !isVisible(menu)) { blockAction('原帖子菜单已关闭或重建'); return null; }
            item = repost ? findUndoRepostMenuItem(menu) : findDeleteMenuItem(menu);
            if (!item) blockAction('原菜单中没有唯一可点击的操作项');
            return item;
        };
        log('已定位 ' + (repost ? 'Undo repost' : 'Delete') + '（文本: "' + getItemText(item) + '"）');
        if (activeSettings().dryRun) {
            log('[DRY RUN] 将' + (repost ? '取消转帖 ' : '删除 ') + post.id + ' "' + truncate(post.text, 40) + '"');
            return { ok: true, dryRun: true };
        }

        if (!(await realClick(item, menuGuard, repost ? () => commitAction(post, operation) : null, resolveMenuItem))) {
            return { ok: false, aborted: true, reason: actionAbortReason('菜单操作复验失败') };
        }
        if (!repost) {
            const justOpenedSheet = findConfirmation(SELECTORS.confirmDelete, SELECTORS.confirmCancel);
            if (justOpenedSheet) state.ownedDialog = justOpenedSheet.container;
        }

        if (repost) {
            // 现行 X 在菜单项点击后直接取消转帖；也兼容有独立二次确认的界面。
            const tracker = { scrollY: operation.scrollY, absentSince: 0 };
            const result = await waitForCondition(() => {
                let sheet = findConfirmation(SELECTORS.unretweetConfirm, SELECTORS.unretweetCancel);
                if (!sheet) sheet = findConfirmation(SELECTORS.confirmDelete, SELECTORS.confirmCancel);
                if (sheet && sheet.button !== item && !menu.contains(sheet.button)) return { sheet };
                return postOutcomeObserved(post, tracker) ? { done: true } : null;
            }, CONFIG.REMOVE_WAIT_MS, '验证取消转帖结果/二次确认', () => state.stopRequested || !validateTaskContext());
            if (result && result.done) return { ok: true };
            if (result && result.sheet) {
                state.ownedDialog = result.sheet.container;
                const confirm = result.sheet.button;
                if (!isUndoRepostText(getItemText(confirm))) return {
                    ok: false, uncertain: true, reason: '取消转帖确认按钮文案不匹配，拒绝点击',
                };
                if (!(await realClick(confirm, () => canAct() && !!currentPost(post)
                    && isUndoRepostText(getItemText(confirm))))) {
                    return { ok: false, uncertain: true, reason: '取消转帖二次确认前已停止' };
                }
                return waitForPostOutcome(post, operation);
            }
            return { ok: false, uncertain: true, reason: '已提交取消转帖，但结果未确认；请人工检查后继续' };
        }

        const sheet = await waitForCondition(() => findConfirmation(SELECTORS.confirmDelete, SELECTORS.confirmCancel),
            CONFIG.CONFIRM_WAIT_MS, '删除确认弹窗', () => !canAct());
        if (!sheet) return { ok: false, aborted: !canAct(), reason: '未出现能唯一识别的删除确认弹窗' };
        state.ownedDialog = sheet.container;
        let confirm = sheet.button;
        if (!isDeleteText(getItemText(confirm))) return {
            ok: false, skipped: true, reason: '确认按钮文本异常("' + getItemText(confirm) + '")，拒绝点击',
        };
        const confirmGuard = () => {
            if (!canAct()) return false;
            if (!currentPost(post)) return blockAction('确认前目标帖子已离开页面或归属/类型变化');
            if (state.ownedDialog !== sheet.container || !isVisible(sheet.container)) return blockAction('原删除确认框已关闭或重建');
            if (!sheet.container.contains(confirm) || !isDeleteText(getItemText(confirm))) return blockAction('删除确认按钮已变化或文案不匹配');
            const current = findConfirmation(SELECTORS.confirmDelete, SELECTORS.confirmCancel);
            return (current && current.container === sheet.container && current.button === confirm)
                || blockAction('删除确认按钮不再唯一');
        };
        const resolveConfirm = () => {
            if (state.ownedDialog !== sheet.container || !isVisible(sheet.container)) {
                blockAction('原删除确认框已关闭或重建'); return null;
            }
            const current = findConfirmation(SELECTORS.confirmDelete, SELECTORS.confirmCancel);
            if (!current || current.container !== sheet.container) {
                blockAction('无法在原确认框中唯一找回删除按钮'); return null;
            }
            confirm = current.button;
            return confirm;
        };
        if (!(await realClick(confirm, confirmGuard, () => commitAction(post, operation), resolveConfirm))) {
            return { ok: false, aborted: true, reason: actionAbortReason('删除确认复验失败') };
        }
        return waitForPostOutcome(post, operation);
    }

    // 只重试未提交的技术失败；确认操作一旦发出，绝不自动重复提交。
    async function deleteArticleFlow(post) {
        const operation = { committed: false, scrollY: window.scrollY };
        let result = { ok: false, reason: '尚未开始操作' };
        for (let attempt = 1; attempt <= CONFIG.MAX_ATTEMPTS; attempt++) {
            if (!canAct()) return { ok: false, aborted: true, reason: '操作已停止或安全暂停' };
            try {
                result = await performAction(post, operation);
            } catch (err) {
                result = { ok: false, reason: '操作异常：' + (err && err.message ? err.message : err) };
            } finally {
                try {
                    const closed = await closeAllOverlays();
                    if (!closed && !operation.committed) result = { ok: false, aborted: true, reason: '菜单或弹窗未能关闭' };
                } catch (err) {
                    autoPause('清理操作弹窗失败，请人工检查');
                    result = { ok: false, reason: '清理弹窗异常' };
                }
            }
            if (result.ok || result.aborted || result.skipped) return result;
            if (operation.committed) return Object.assign(result, { uncertain: true });
            if (attempt < CONFIG.MAX_ATTEMPTS) {
                log('第 ' + attempt + '/' + CONFIG.MAX_ATTEMPTS + ' 次失败：' + result.reason + '，重试未提交的步骤', 'warn');
                await interruptibleSleep(CONFIG.RETRY_DELAY_MS);
                await pauseGate();
            }
        }
        return result;
    }


    // =====================
    // TASK RUNNERS（需求十五、十六：暂停/停止语义；需求十一：数量上限；需求 29：熔断）
    // =====================

    function taskActive() {
        return state.running && !state.stopRequested;
    }

    function isFollowingPhase(phase) { return phase === 'followScan' || phase === 'unfollow'; }
    function isMutatingPhase(phase) { return phase === 'delete' || phase === 'unfollow'; }

    async function pauseGate() {
        while (taskActive() && state.paused) await sleep(200);
    }

    function safetyCheck() {
        if (state.consecutiveFailures >= CONFIG.FAILURE_BREAKER) return autoPause('连续操作失败 ' + state.consecutiveFailures + ' 次');
        if (location.pathname.indexOf('/i/flow') === 0) return autoPause('出现登录/验证流程页面');
        if (document.hidden && !activeSettings().allowBackground) return autoPause('标签页已切到后台，请回到当前标签页后继续');
        try {
            const login = document.querySelector(SELECTORS.loginButton);
            if (login && isVisible(login)) return autoPause('账号可能已掉线，请重新登录');
            const toasts = visibleElements(SELECTORS.toast);
            if (toasts.some((toast) => RATE_LIMIT_PATTERNS.some((pattern) => pattern.test(getItemText(toast))))) {
                return autoPause('触发频率限制，请等待提示消失后手动继续');
            }
        } catch (err) { /* 巡检不可使任务崩溃 */ }
        return true;
    }

    function resetTaskStats() {
        state.stats = { scanned: 0, matched: 0, deleted: 0, wouldDelete: 0, skipped: 0, failed: 0 };
        state.byType = { post: 0, reply: 0, quote: 0, repost: 0, unknown: 0 };
        state.eligibleByType = { post: 0, reply: 0, quote: 0, repost: 0 };
        state.skipReasonCounts = {};
        state.seenIds = new Set();
        state.candidateIds = new Set();
        state.dryRunTriedIds = new Set();
        state.taskTriedIds = new Set();
        state.unknownElements = new WeakSet();
        state.consecutiveFailures = 0;
        state.actionBlockReason = '';
        // attemptedIds 仅保存实际提交的操作，未提交的失败允许在下次任务重试。
    }

    async function beginTask(phase, approval) {
        if (state.running || state.starting) return;
        if (!['scan', 'delete', 'followScan', 'unfollow'].includes(phase)) { log('无法开始：任务类型无效', 'error'); return; }
        refreshContext();
        if (!state.pageTaskReady) { log('无法开始：' + state.pageReason, 'error'); return; }
        const following = isFollowingPhase(phase);
        if (state.pageTab === 'followers') { log('关注者页仅用于关系标色；取关请打开本人正在关注列表', 'error'); return; }
        if (following !== (state.pageTab === 'following')) {
            log(following ? '请在本人正在关注列表使用关注管理' : '正在关注列表仅支持关注管理；请回到帖子页清理帖子', 'error'); return;
        }
        const context = { user: state.currentUser, href: location.href };
        const opts = JSON.parse(JSON.stringify(approval ? approval.settings : settings));
        if (following) { opts.dryRun = opts.followDryRun; opts.maxDelete = opts.maxUnfollow; }
        const rangeError = following ? '' : dateRangeError(opts);
        if (rangeError) { log('无法开始：' + rangeError, 'error'); updatePanel(); return; }
        if (approval && (approval.user !== context.user || approval.href !== context.href)) {
            log('账号或页面已变化，请重新确认任务', 'error'); return;
        }
        if (isMutatingPhase(phase) && !opts.dryRun && !approval) {
            log('真实操作需要通过面板确认后开始', 'error'); return;
        }
        if (!following && !Object.values(opts.types).some(Boolean)) { log('请至少勾选一种清理类型', 'warn'); return; }
        if (document.hidden && !opts.allowBackground) { log('请在前台标签页启动任务', 'warn'); return; }
        Object.freeze(opts.types);
        state.taskSettings = Object.freeze(opts);
        state.taskContext = context;
        state.starting = true;
        state.stopRequested = false;
        state.paused = false;
        state.autoPauseReason = null;
        state.phase = phase;
        updatePanel();
        let started = false;
        try {
            // 扫描和 Dry Run 不消耗配额；只有提交真实操作时才记账。
            syncQuota(context.user);
            if (isMutatingPhase(phase) && !(await acquireLock())) {
                log('无法开始：另一个标签页正在执行清理，或运行锁无法保存', 'error'); return;
            }
            if (state.stopRequested || !validateTaskContext()) return;
            resetTaskStats();
            if (following) resetFollowingTask();
            state.running = true;
            state.starting = false;
            started = true;
            hideBanner();
            updatePanel();
            log(following ? (phase === 'followScan' ? '任务开始：扫描关注关系（不取关）' : opts.dryRun ? '任务开始：取关模拟' : '任务开始：批量取关')
                : phase === 'scan' ? '任务开始：扫描（不删除）' : opts.dryRun ? '任务开始：Dry Run 演练' : '任务开始：真实清理');
            if (!following) log('帖子日期（本地）：' + dateRangeLabel(opts));
            if (isMutatingPhase(phase)) startLockHeartbeat();
            if (following) await (phase === 'followScan' ? runFollowingScan() : runUnfollowLoop());
            else await (phase === 'scan' ? runScan() : runDeleteLoop());
        } catch (err) {
            log('任务异常终止：' + (err && err.message ? err.message : err), 'error');
        } finally {
            state.starting = false;
            if (started) finishTask();
            else {
                releaseLock();
                state.phase = 'idle';
                state.taskSettings = null;
                state.taskContext = null;
                updatePanel();
            }
        }
    }

    function skipReasonSummary() {
        const counts = state.skipReasonCounts || {};
        const parts = Object.keys(counts).map((key) => key + '×' + counts[key]);
        return parts.length ? '跳过原因：' + parts.join('，') : '';
    }

    function finishTask() {
        const phase = state.phase;
        state.running = false;
        state.paused = false;
        state.phase = 'idle';
        state.taskSettings = null;
        state.taskContext = null;
        state.autoPauseReason = null;
        stopLockHeartbeat();
        releaseLock();
        hideBanner();
        const s = state.stats;
        if (isFollowingPhase(phase)) finishFollowingTask(phase);
        else log(phase === 'delete' ? '清理任务结束：已完成 ' + s.deleted + '，模拟 ' + s.wouldDelete
            + '，失败/待确认 ' + s.failed + '，跳过 ' + s.skipped : '扫描任务结束');
        if (phase === 'scan') log('可删除候选 ' + s.matched + ' 条（仅已扫描内容'
            + (candidateLimitReached() ? '，已达数量上限' : '') + '；计算不会删除）');
        const summary = skipReasonSummary();
        if (summary) log(summary);
        refreshContext();
        updatePanel();
    }

    async function runScan() {
        const initialTarget = postScrollTarget();
        const startScrollY = postScrollPosition(initialTarget);
        let progress = newPostScanProgress();
        while (taskActive()) {
            const wasPaused = state.paused;
            await pauseGate();
            if (!taskActive()) break;
            if (wasPaused) progress = newPostScanProgress();
            if (!canAct()) continue;
            scanVisible();
            recordPostScanProgress(progress);
            updatePanel();
            const limit = activeSettings().maxDelete;
            if (limit > 0 && state.stats.matched >= limit) {
                log('符合条件已达到扫描目标数量（' + limit + '），停止扫描'); break;
            }
            const result = await scrollAndWaitForNew(progress.emptyRounds > 0 ? CONFIG.SCROLL_REWAIT_MS : 0);
            if (!taskActive() || state.paused) continue;
            if (postScanReachedEnd(progress, result)) { log('连续三次未发现新帖子，扫描结束'); break; }
        }
        if (!state.stopRequested && location.href === state.taskContext.href) {
            try {
                if (initialTarget) { if (initialTarget.isConnected) initialTarget.scrollTop = startScrollY; }
                else window.scrollTo(0, startScrollY);
            } catch (err) { /* noop */ }
        }
        const bt = state.byType;
        log('已扫描 ' + state.stats.scanned + ' 条：帖子 ' + bt.post + ' / 回复 ' + bt.reply
            + ' / Quote ' + bt.quote + ' / Repost ' + bt.repost + ' / 未知 ' + bt.unknown
            + '；符合条件 ' + state.stats.matched + ' 条');
    }

    async function runDeleteLoop() {
        const opts = activeSettings();
        const dry = opts.dryRun;
        const enabled = Object.keys(opts.types).filter((type) => opts.types[type]).map((type) => TYPE_LABELS[type]);
        log('类型 [' + enabled.join('/') + '] ｜ 上限 ' + (opts.maxDelete || '无限制')
            + ' ｜ 间隔 ' + opts.intervalMinSec + '~' + opts.intervalMaxSec + ' 秒');
        let progress = newPostScanProgress();
        while (taskActive()) {
            const wasPaused = state.paused;
            await pauseGate();
            if (!taskActive()) break;
            if (wasPaused) progress = newPostScanProgress();
            // 优先结束已达目标的任务，避免卡在配额暂停或最后一批冷却中。
            const done = dry ? state.stats.wouldDelete : state.stats.deleted;
            if (opts.maxDelete > 0 && done >= opts.maxDelete) {
                log('已达到本次清理上限（' + opts.maxDelete + '），任务结束'); break;
            }
            if (candidateLimitReached() && state.taskTriedIds.size >= state.candidateIds.size) {
                log('本次候选已全部处理（' + state.candidateIds.size + '），不再扫描新帖子'); break;
            }
            if (!canAct()) continue;
            if (!dry && !checkQuotaBeforeAction()) continue;
            if (!dry) {
                const cooldownStartedAt = Date.now();
                await batchCooldown();
                progress.lastProgressAt += Date.now() - cooldownStartedAt;
            }
            if (!taskActive() || state.paused || !canAct()) continue;
            const batch = scanVisible();
            recordPostScanProgress(progress);
            updatePanel();
            if (!batch.length) {
                if (candidateLimitReached()) {
                    log('已收集本次上限的候选，没有更多可处理候选，不再扫描新帖子'); break;
                }
                const result = await scrollAndWaitForNew(progress.emptyRounds > 0 ? CONFIG.SCROLL_REWAIT_MS : 0);
                if (!taskActive() || state.paused) continue;
                if (postScanReachedEnd(progress, result)) { log('连续三次未发现新帖子，没有更多可处理内容'); break; }
                continue;
            }
            progress.emptyRounds = 0;
            const target = batch[0];
            state.taskTriedIds.add(target.id);
            if (dry) state.dryRunTriedIds.add(target.id);
            log('开始处理 ' + TYPE_LABELS[target.type] + ' ' + target.id + ' "' + truncate(target.text, CONFIG.LOG_PREVIEW_LEN) + '"');
            const result = await deleteArticleFlow(target);
            if (result.ok) {
                state.consecutiveFailures = 0;
                if (result.dryRun) {
                    state.stats.wouldDelete++;
                    log('[DRY RUN] 模拟成功 ' + target.id + '（累计 ' + state.stats.wouldDelete + '）');
                } else {
                    state.stats.deleted++;
                    recordSuccessCount();
                    log('✅ ' + (target.type === 'repost' ? '已取消转帖 ' : '删除成功 ') + target.id + '（本次 '
                        + state.stats.deleted + '，累计确认成功 ' + state.totalDeleted + '）');
                }
                updatePanel();
                const count = dry ? state.stats.wouldDelete : state.stats.deleted;
                if (opts.maxDelete > 0 && count >= opts.maxDelete) continue;
                if (candidateLimitReached() && state.taskTriedIds.size >= state.candidateIds.size) continue;
                const delay = randomInt(opts.intervalMinSec, opts.intervalMaxSec) * 1000;
                log('等待 ' + delay / 1000 + ' 秒后继续');
                await interruptibleSleep(delay);
            } else if (result.aborted) {
                if (!state.attemptedIds.has(target.id)) state.taskTriedIds.delete(target.id);
                log('当前帖子已中止 ' + target.id + '：' + result.reason, 'warn');
                if (state.stopRequested) break;
                if (!state.paused) autoPause(result.reason || '操作中止，请检查后继续');
            } else if (result.skipped) {
                state.stats.skipped++;
                state.skipReasonCounts[result.reason] = (state.skipReasonCounts[result.reason] || 0) + 1;
                log('跳过 ' + target.id + '：' + result.reason, 'warn');
            } else {
                state.stats.failed++;
                state.consecutiveFailures++;
                log('❌ ' + target.id + '：' + result.reason, 'error');
                if (result.uncertain) autoPause('帖子 ' + target.id + ' 的操作结果待确认；该帖不会自动重试');
                else await interruptibleSleep(800);
            }
            // Active processing and its configured delay are not stalled timeline loading.
            progress.lastProgressAt = Date.now();
            updatePanel();
        }
    }

    function togglePause() {
        if (!state.running || state.stopRequested) return;
        if (state.paused) {
            if (!validateTaskContext()) return;
            if (document.hidden && !activeSettings().allowBackground) return;
            const previousFailures = state.consecutiveFailures;
            state.consecutiveFailures = 0;
            if (!safetyCheck() || (isMutatingPhase(state.phase) && !activeSettings().dryRun && !checkQuotaBeforeAction())) {
                state.consecutiveFailures = previousFailures;
                return;
            }
            state.paused = false;
            state.autoPauseReason = null;
            hideBanner();
            log('已继续');
        } else {
            state.paused = true;
            log('已暂停：当前操作完成后等待继续', 'warn');
        }
        updatePanel();
    }

    function stopTask(reason) {
        if ((!state.running && !state.starting) || state.stopRequested) return;
        state.stopRequested = true;
        log('正在停止：' + (reason || '用户停止'), 'warn');
        updatePanel();
    }

    function autoPause(reason) {
        if (!state.running) return false;
        if (state.paused && state.autoPauseReason === reason) return false;
        state.paused = true;
        state.autoPauseReason = reason;
        showBanner(reason);
        log('任务已自动暂停：' + reason, 'error');
        updatePanel();
        return false;
    }


    // 按账号保存配额；刷新、跨标签和跨日后均重新读取。
    let dailyCount = 0;

    function hourKeyNow() {
        const d = new Date();
        const p = (x) => String(x).padStart(2, '0');
        return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours());
    }

    function dateKeyNow() { return hourKeyNow().split(' ')[0]; }

    function readStoredJSON(key) {
        try {
            const value = storageGet(key);
            return value ? typeof value === 'string' ? JSON.parse(value) : value : null;
        } catch (err) { state.storageError = true; return null; }
    }

    function validCount(value) {
        return Number.isFinite(value) ? Math.floor(clamp(value, 0, 1000000)) : 0;
    }

    function syncSuccessCount(user) {
        if (!user) { state.totalDeleted = 0; state.successAccount = ''; return; }
        const saved = readStoredJSON(CONFIG.SUCCESS_KEY + user.toLowerCase());
        state.totalDeleted = saved && Number.isSafeInteger(saved.count) && saved.count >= 0 ? saved.count : 0;
        state.successAccount = user.toLowerCase();
    }

    function recordSuccessCount() {
        const user = state.taskContext && state.taskContext.user;
        if (!user) return false;
        syncSuccessCount(user);
        if (state.storageError) { log('操作成功，但累计成功数量无法读取', 'error'); return false; }
        const count = state.totalDeleted + 1;
        if (!storageSet(CONFIG.SUCCESS_KEY + user.toLowerCase(), JSON.stringify({ count }))) {
            log('操作成功，但累计成功数量未能保存', 'error'); return false;
        }
        state.totalDeleted = count;
        return true;
    }

    function getDeleteCounts() {
        return {
            candidate: state.stats.matched,
            deleted: state.stats.deleted,
            simulated: state.stats.wouldDelete,
            remaining: Math.max(0, state.candidateIds.size - state.taskTriedIds.size),
            total: state.totalDeleted,
        };
    }

    function syncQuota(user) {
        if (!user) return;
        const key = CONFIG.QUOTA_KEY + user.toLowerCase();
        const saved = readStoredJSON(key);
        const nowHour = hourKeyNow();
        const nowDate = dateKeyNow();
        const quota = {
            date: nowDate, count: saved && saved.date === nowDate ? validCount(saved.count) : 0,
            hour: nowHour, hourCount: saved && saved.hour === nowHour ? validCount(saved.hourCount) : 0,
            batchCount: saved ? validCount(saved.batchCount) : 0,
            cooldownUntil: saved && Number.isFinite(saved.cooldownUntil) ? Math.max(0, saved.cooldownUntil) : 0,
        };
        if (!saved) {
            const legacy = readStoredJSON(CONFIG.DAILY_KEY);
            if (legacy && legacy.date === nowDate && (!legacy.migratedTo || legacy.migratedTo === user)) {
                quota.count = validCount(legacy.count);
                // 旧格式没有账号信息；仅归到首次使用新版的账号，防止重置已有日配额。
                if (storageSet(key, JSON.stringify(quota))) {
                    legacy.migratedTo = user;
                    storageSet(CONFIG.DAILY_KEY, JSON.stringify(legacy));
                }
            }
        }
        state.quotaAccount = user;
        state.quota = quota;
        dailyCount = quota.count;
        state.hourKey = quota.hour;
        state.hourlyCount = quota.hourCount;
        state.batchCount = quota.batchCount;
        state.cooldownUntil = quota.cooldownUntil;
    }

    function loadDailyCount() {
        syncQuota(state.currentUser);
        return dailyCount;
    }

    function saveQuota() {
        return !state.storageError && storageSet(CONFIG.QUOTA_KEY + state.quotaAccount, JSON.stringify(state.quota));
    }

    function checkQuotaBeforeAction() {
        syncQuota(state.taskContext ? state.taskContext.user : state.currentUser);
        if (state.storageError) return autoPause('浏览器存储读取异常，请检查油猴权限并刷新页面后再执行真实操作');
        const opts = activeSettings();
        updateQuotaLine();
        if (opts.hourlyLimit > 0 && state.hourlyCount >= opts.hourlyLimit) {
            return autoPause('达到每小时操作上限（' + opts.hourlyLimit + '），请等下一个整点后继续');
        }
        if (opts.dailyLimit > 0 && dailyCount >= opts.dailyLimit) {
            return autoPause('达到每日操作上限（' + opts.dailyLimit + '），请明天继续');
        }
        return true;
    }

    // 在不可逆点击之前记账：未确认成功的请求也占用配额，避免漏计/重复提交。
    function recordAction() {
        syncQuota(state.taskContext.user);
        if (state.storageError) return autoPause('浏览器存储异常，本次操作未提交');
        const quota = state.quota;
        quota.count++;
        quota.hourCount++;
        quota.batchCount++;
        if (quota.batchCount >= CONFIG.BATCH_SIZE && !quota.cooldownUntil) {
            quota.cooldownUntil = Date.now() + CONFIG.BATCH_COOLDOWN_MS;
        }
        if (!saveQuota()) return autoPause('无法保存操作配额，已取消本次提交；请检查浏览器存储权限');
        dailyCount = quota.count;
        state.hourlyCount = quota.hourCount;
        state.batchCount = quota.batchCount;
        state.cooldownUntil = quota.cooldownUntil;
        updateQuotaLine();
        return true;
    }

    async function batchCooldown() {
        syncQuota(state.taskContext.user);
        if (!state.cooldownUntil) return;
        if (state.cooldownUntil > Date.now()) log('本批次达到 ' + CONFIG.BATCH_SIZE + ' 次操作，等待批次休息结束', 'warn');
        while (taskActive() && Date.now() < state.cooldownUntil) {
            if (!validateTaskContext()) return;
            const remain = Math.max(0, state.cooldownUntil - Date.now());
            if (!state.paused || !state.autoPauseReason) {
                showBannerText('批次休息剩余 ' + Math.ceil(remain / 1000) + ' 秒；暂停/停止仍然有效');
            }
            await interruptibleSleep(Math.min(1000, remain));
        }
        if (!taskActive()) return; // 停止不清除冷却，下一次任务继续遵守。
        syncQuota(state.taskContext.user);
        state.quota.batchCount = 0;
        state.quota.cooldownUntil = 0;
        if (!saveQuota()) { autoPause('无法保存批次冷却状态'); return; }
        state.batchCount = 0;
        state.cooldownUntil = 0;
        if (!state.paused) hideBanner();
        log('批次休息结束');
    }

    // Web Locks 提供同源原子互斥，GM 存储租约覆盖 x.com/twitter.com 两个来源。
    function readLock() { return readStoredJSON(CONFIG.LOCK_KEY); }

    function ownsLock() {
        const lock = readLock();
        return !state.storageError && state.lockHeld && !!lock && lock.tabId === state.myTabId;
    }

    function writeLock() {
        return storageSet(CONFIG.LOCK_KEY, JSON.stringify({ tabId: state.myTabId, ts: Date.now() }));
    }

    async function acquireLock() {
        if (state.storageError) return false;
        if (!state.myTabId) state.myTabId = 'tab-' + (window.crypto && window.crypto.randomUUID
            ? window.crypto.randomUUID() : Date.now() + '-' + Math.random().toString(36).slice(2));
        if (navigator.locks && typeof navigator.locks.request === 'function') {
            const acquired = await new Promise((resolve) => {
                // Keep the existing mutex identifier compatible with tabs that have not refreshed.
                navigator.locks.request('lilith.xpc.task.v1', { ifAvailable: true }, async (lock) => {
                    if (!lock) { resolve(false); return; }
                    const held = new Promise((release) => { state.nativeLockRelease = release; });
                    resolve(true);
                    await held;
                }).catch(() => resolve(false));
            });
            if (!acquired) return false;
        }
        const lock = readLock();
        if (state.storageError) { releaseLock(); return false; }
        if (lock && lock.tabId !== state.myTabId && Number.isFinite(lock.ts)
            && Date.now() - lock.ts < CONFIG.LOCK_STALE_MS) { releaseLock(); return false; }
        if (!writeLock()) { releaseLock(); return false; }
        // 兜底租约无 CAS：取得后读回，并在心跳及每次点击前复核，绝不盲目覆盖对手。
        await sleep(180);
        const verified = readLock();
        if (state.storageError || !verified || verified.tabId !== state.myTabId) { releaseLock(); return false; }
        state.lockHeld = true;
        return true;
    }

    function releaseLock() {
        const lock = readLock();
        if (lock && lock.tabId === state.myTabId) storageSet(CONFIG.LOCK_KEY, '');
        state.lockHeld = false;
        if (state.nativeLockRelease) { state.nativeLockRelease(); state.nativeLockRelease = null; }
    }

    function startLockHeartbeat() {
        stopLockHeartbeat();
        state.lockTimer = setInterval(() => {
            if (!ownsLock()) { stopTask('其他标签页取得了运行锁，当前任务已停止'); return; }
            if (!writeLock()) stopTask('运行锁心跳无法保存，当前任务已停止');
        }, CONFIG.LOCK_HEARTBEAT_MS);
    }

    function stopLockHeartbeat() {
        if (state.lockTimer) { clearInterval(state.lockTimer); state.lockTimer = null; }
    }


    // =====================
    // NAVIGATION（需求二十一：SPA 路由变化 -> 停止任务 + 重新初始化）
    // =====================

    let lastHref = location.href;
    let profileVisitTimer = null;
    let profileVisitNavigate = (url) => location.assign(url);
    const profileVisitState = { status: 'waiting', reason: '等待首次检查', lastVisitAt: null,
        nextVisitAt: null, pendingUntil: null, attempts: 0 };

    function profileVisitStatus(status, reason) {
        const changed = profileVisitState.status !== status || profileVisitState.reason !== reason;
        profileVisitState.status = status; profileVisitState.reason = reason;
        if (changed && ['deferred', 'error', 'cooldown'].includes(status)) {
            log('主页自动跳转：' + reason, status === 'error' ? 'warn' : 'info');
        }
        return false;
    }

    function profileVisitBlockedReason() {
        if (document.hidden) return '窗口在后台，回到前台后自动重试';
        if (state.running || state.starting) return '任务正在执行，结束后自动重试';
        if (ui.confirmMask || visibleElements('[role="dialog"], [data-testid="confirmationSheetDialog"]').length) {
            return '确认框或登录弹窗尚未关闭，关闭后自动重试';
        }
        if (/^(?:\/i\/(?:flow|oauth2?|login|signup)|\/(?:login|logout|signup|oauth2?|account\/access))(?:\/|$)/i.test(location.pathname)) {
            return '正在登录或验证，完成后自动重试';
        }
        return '';
    }

    function clearProfileVisitPending(token) {
        const pending = readStoredJSON(CONFIG.PROFILE_VISIT_PENDING_KEY);
        if (pending && pending.token === token) return storageSet(CONFIG.PROFILE_VISIT_PENDING_KEY, null);
        return true; // Another tab's newer attempt must not be removed.
    }

    function getProfileVisitDiagnostics() {
        return { target: 'https://x.com/' + CONFIG.PROFILE_VISIT_USER, ...profileVisitState };
    }

    // Persist a short attempt before navigating; only arrival at the author root starts the 15-day interval.
    // 配置主页不是登录账号证据，所有清理操作仍使用原有账号与归属校验。
    function maybeVisitProfile(now = Date.now(), navigate = (url) => location.assign(url)) {
        if (location.protocol !== 'https:' || !/^(?:www\.)?(?:x\.com|twitter\.com)$/.test(location.hostname)) {
            return profileVisitStatus('error', '当前不是受支持的 X 页面');
        }
        if (state.storageError) return profileVisitStatus('error', '无法读写访问记录，跳转已停止');
        if (!Number.isFinite(now) || now <= 0) return profileVisitStatus('error', '访问时间无效');
        const saved = Number(storageGet(CONFIG.PROFILE_VISIT_KEY));
        profileVisitState.lastVisitAt = Number.isFinite(saved) && saved > 0 ? saved : null;
        profileVisitState.nextVisitAt = profileVisitState.lastVisitAt === null ? null : saved + CONFIG.PROFILE_VISIT_INTERVAL_MS;
        if (state.storageError) return profileVisitStatus('error', '无法读取访问记录，跳转已停止');
        if (profileVisitState.lastVisitAt !== null && now - saved < CONFIG.PROFILE_VISIT_INTERVAL_MS) {
            profileVisitState.pendingUntil = null;
            return profileVisitStatus('cooldown', '已有访问记录，未满 15 天，不重复跳转');
        }
        const blocked = profileVisitBlockedReason();
        if (blocked) return profileVisitStatus('deferred', blocked);

        const pending = readStoredJSON(CONFIG.PROFILE_VISIT_PENDING_KEY);
        if (state.storageError) return profileVisitStatus('error', '无法读取待跳转记录');
        const validPending = pending && typeof pending.token === 'string' && pending.token
            && Number.isFinite(pending.attemptedAt) && pending.attemptedAt > 0
            && Number.isFinite(pending.expiresAt) && pending.expiresAt > pending.attemptedAt
            && Number.isInteger(pending.attempts) && pending.attempts > 0;
        const authorRoot = new RegExp('^/' + CONFIG.PROFILE_VISIT_USER + '/?$', 'i').test(location.pathname);
        if (authorRoot) {
            if (!storageSet(CONFIG.PROFILE_VISIT_KEY, String(now)) || Number(storageGet(CONFIG.PROFILE_VISIT_KEY)) !== now || state.storageError) {
                return profileVisitStatus('error', '已到作者主页，但访问时间无法保存');
            }
            if (validPending && !clearProfileVisitPending(pending.token)) return profileVisitStatus('error', '无法清理待跳转记录');
            profileVisitState.lastVisitAt = now; profileVisitState.nextVisitAt = now + CONFIG.PROFILE_VISIT_INTERVAL_MS;
            profileVisitState.pendingUntil = null;
            profileVisitStatus('completed', '已到 @' + CONFIG.PROFILE_VISIT_USER + ' 的主页，15 天内不再自动跳转');
            log(profileVisitState.reason);
            return false; // Already at the requested root; do not reload it.
        }
        if (validPending && now < pending.expiresAt) {
            profileVisitState.pendingUntil = pending.expiresAt;
            return profileVisitStatus('pending', '已发起主页跳转，等待到达；尚未计入 15 天间隔');
        }
        const attempts = Math.max(profileVisitState.attempts, validPending ? pending.attempts : 0);
        if (attempts >= CONFIG.PROFILE_VISIT_MAX_ATTEMPTS) {
            if (validPending) clearProfileVisitPending(pending.token);
            profileVisitState.pendingUntil = null;
            return profileVisitStatus('error', '主页跳转连续未到达，本页已停止自动重试；请检查浏览器导航限制');
        }
        const attempt = { token: state.myTabId + ':' + now + ':' + Math.random().toString(36).slice(2),
            attemptedAt: now, expiresAt: now + CONFIG.PROFILE_VISIT_PENDING_MS, attempts: attempts + 1 };
        if (!storageSet(CONFIG.PROFILE_VISIT_PENDING_KEY, JSON.stringify(attempt)) || state.storageError) {
            return profileVisitStatus('error', '无法保存待跳转记录');
        }
        const verified = readStoredJSON(CONFIG.PROFILE_VISIT_PENDING_KEY);
        if (!verified || verified.token !== attempt.token || state.storageError) {
            return profileVisitStatus('error', '待跳转记录读回不一致，未执行导航');
        }
        const finalBlock = profileVisitBlockedReason();
        if (finalBlock) {
            clearProfileVisitPending(attempt.token);
            return profileVisitStatus('deferred', finalBlock);
        }
        profileVisitState.attempts = attempt.attempts;
        profileVisitState.pendingUntil = attempt.expiresAt;
        try {
            if (navigate('https://x.com/' + CONFIG.PROFILE_VISIT_USER) === false) throw new Error('浏览器拒绝导航');
        } catch (err) {
            clearProfileVisitPending(attempt.token);
            profileVisitState.pendingUntil = null;
            return profileVisitStatus('error', '主页导航失败，未计入 15 天间隔：' + String(err.message || err).slice(0, 160));
        }
        profileVisitStatus('pending', '已发起主页跳转，等待到达；尚未计入 15 天间隔');
        log('首次使用或间隔到期，正在打开 @' + CONFIG.PROFILE_VISIT_USER + ' 的主页');

        return true;
    }

    function scheduleProfileVisit(navigate) {
        if (typeof navigate === 'function') profileVisitNavigate = navigate;
        if (profileVisitTimer) return; // Route churn must not postpone the first attempt.
        const attempt = () => {
            profileVisitTimer = null;
            maybeVisitProfile(Date.now(), profileVisitNavigate);
            if (['deferred', 'pending'].includes(profileVisitState.status) && !profileVisitTimer) {
                profileVisitTimer = setTimeout(attempt, CONFIG.PROFILE_VISIT_RETRY_MS);
            }
        };
        profileVisitTimer = setTimeout(attempt, CONFIG.PROFILE_VISIT_DELAY_MS);
    }

    function checkRoute() {
        if (location.href === lastHref) return;
        const prev = lastHref;
        lastHref = location.href;
        log('页面切换：' + location.pathname + '（原 ' + prev.replace(location.origin, '') + '）');
        if (state.running || state.starting) stopTask('页面已切换（SPA 路由变化），任务自动停止');
        if (ui.confirmMask) ui.closeConfirm();
        refreshContext();
        scheduleProfileVisit();
    }

    function startRouteWatch() {
        // history 补丁能即时感知 pushState/replaceState；沙箱环境下可能补不到页面世界，
        // 因此同时保留 ROUTE_CHECK_MS 轮询兜底，双保险。
        try {
            const origPush = history.pushState;
            const origReplace = history.replaceState;
            history.pushState = function () {
                const result = origPush.apply(this, arguments);
                setTimeout(checkRoute, 0);
                return result;
            };
            history.replaceState = function () {
                const result = origReplace.apply(this, arguments);
                setTimeout(checkRoute, 0);
                return result;
            };
        } catch (err) {
            logDev('history 补丁失败: ' + (err && err.message));
        }
        window.addEventListener('popstate', () => setTimeout(checkRoute, 0));
        setInterval(checkRoute, CONFIG.ROUTE_CHECK_MS);
    }

    // =====================
    // OBSERVER（需求二十：MutationObserver + debounce；空闲期只做轻量维护）
    // =====================

    function startObserver() {
        let timer = null;
        const mo = new MutationObserver((records) => {
            if (records.every((record) => {
                const node = record.target.nodeType === 1 ? record.target : record.target.parentElement;
                return node && node.closest('#xpc-root, .xpc-modal-mask, #xpc-style');
            })) return;
            if (timer) return;
            timer = setTimeout(() => {
                timer = null;
                refreshContext();
            }, CONFIG.OBSERVER_DEBOUNCE_MS);
        });
        try {
            mo.observe(document.body, { childList: true, characterData: true, subtree: true });
        } catch (err) {
            logDev('MutationObserver 初始化失败: ' + (err && err.message));
        }
    }

    // =====================
    // UI（需求四、三十二、三十三：右下角面板、深色 X 风格、xpc-* 命名空间、可拖动、可最小化）
    // =====================

    const CSS_TEXT = [
        '#xpc-root{position:fixed;right:8px;bottom:8px;width:330px;max-width:calc(100vw - 16px);z-index:2147483000;color:#e7e9ea;background:#15202b;border:1px solid #38444d;border-radius:14px;box-shadow:0 10px 30px rgba(0,0,0,.6);font:12px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"PingFang SC","Microsoft YaHei",sans-serif;user-select:none}',
        '#xpc-root *{box-sizing:border-box;margin:0;padding:0;font-family:inherit}',
        '#xpc-root.xpc-minimized{width:auto}',
        '#xpc-root.xpc-minimized .xpc-body{display:none}',
        '.xpc-header{display:flex;align-items:center;gap:8px;padding:9px 12px;border-bottom:1px solid #38444d;cursor:move;font-weight:700;font-size:13px}',
        '.xpc-minimized .xpc-header{border-bottom:none}',
        '#xpc-root .xpc-header-copy{display:flex;align-items:baseline;flex-wrap:wrap;gap:0 4px;flex:1 1 auto;min-width:0}',
        '#xpc-root .xpc-title{color:#1d9bf0;text-decoration:none;cursor:pointer;border-radius:4px;max-width:100%;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
        '#xpc-root .xpc-title:hover{color:#8ecdf8;text-decoration:underline}',
        '#xpc-root .xpc-title:focus-visible{outline:2px solid #1d9bf0;outline-offset:3px}',
        '#xpc-root .xpc-follow-note{color:#8ecdf8;font-size:10px;font-weight:400;text-decoration:none;cursor:pointer;max-width:100%;overflow-wrap:anywhere;border-radius:4px}',
        '#xpc-root .xpc-follow-note:hover{text-decoration:underline}',
        '#xpc-root .xpc-follow-note:focus-visible{outline:2px solid #1d9bf0;outline-offset:3px}',
        '.xpc-dot{width:8px;height:8px;border-radius:50%;background:#71767b;flex:0 0 auto}',
        '.xpc-dot-run{background:#00ba7c}',
        '.xpc-dot-pause{background:#ffd400}',
        '#xpc-root .xpc-min{margin-left:auto;flex:0 0 auto;background:transparent;border:none;color:#71767b;font-size:14px;cursor:pointer;padding:0 2px;line-height:1}',
        '#xpc-root .xpc-min:hover{color:#e7e9ea}',
        '.xpc-body{padding:10px 12px;max-height:min(72vh,640px);overflow:auto}',
        '.xpc-context{font-size:11px;color:#71767b;margin-bottom:8px;word-break:break-all}',
        '#xpc-root .xpc-follow-nav{display:block;color:#1d9bf0;font-size:12px;margin:4px 0 8px}',
        '.xpc-ok{color:#00ba7c}',
        '.xpc-bad{color:#f4212e}',
        '.xpc-sec{margin-bottom:9px}',
        '.xpc-sec-title{font-size:10px;letter-spacing:.08em;color:#71767b;margin-bottom:3px;text-transform:uppercase}',
        '.xpc-check{display:flex;align-items:center;gap:7px;padding:1.5px 0;cursor:pointer;font-size:12px}',
        '.xpc-check input{accent-color:#1d9bf0;width:13px;height:13px;cursor:pointer}',
        '.xpc-row{display:flex;align-items:center;gap:8px;margin:4px 0}',
        '.xpc-label{color:#71767b;font-size:11px;white-space:nowrap}',
        '.xpc-input{width:64px;background:#000;border:1px solid #38444d;border-radius:8px;color:#e7e9ea;padding:4px 7px;font-size:12px}',
        '.xpc-input:focus{outline:none;border-color:#1d9bf0}',
        '.xpc-date-input{width:146px;min-width:0;color-scheme:dark}',
        '.xpc-hint{color:#71767b;font-size:10.5px;line-height:1.5;margin:4px 0}',
        '.xpc-hint.xpc-bad{color:#f4212e}',
        '.xpc-count-line{color:#cfd9de;font-size:11px;line-height:1.6;margin:5px 0;white-space:pre-line}',
        '.xpc-clear-dates{flex:none;padding:3px 10px;font-size:11px}',
        '.xpc-stats{display:grid;grid-template-columns:repeat(3,1fr);gap:5px;margin:8px 0}',
        '.xpc-stat{background:#000;border:1px solid #38444d;border-radius:8px;padding:4px 2px;text-align:center}',
        '.xpc-stat b{display:block;font-size:14px;line-height:1.3}',
        '.xpc-stat span{font-size:9.5px;color:#71767b}',
        '.xpc-quota{font-size:10.5px;color:#71767b;margin:2px 0 6px}',
        '.xpc-banner{display:none;background:rgba(244,33,46,.12);border:1px solid #f4212e;color:#ff8186;border-radius:8px;padding:6px 9px;margin-bottom:8px;font-size:11px}',
        '.xpc-btnrow{display:flex;gap:8px;margin-bottom:7px}',
        '.xpc-btnrow:last-child{margin-bottom:0}',
        '.xpc-btn{flex:1;border-radius:9999px;border:1px solid #536471;background:transparent;color:#e7e9ea;padding:6px 0;font-size:12px;font-weight:700;cursor:pointer}',
        '.xpc-btn:hover:not(:disabled){background:rgba(239,243,244,.1)}',
        '.xpc-btn:disabled{opacity:.35;cursor:not-allowed}',
        '.xpc-btn-primary{background:#1d9bf0;border-color:#1d9bf0;color:#fff}',
        '.xpc-btn-primary:hover:not(:disabled){background:#1a8cd8}',
        '.xpc-btn-danger{background:#f4212e;border-color:#f4212e;color:#fff}',
        '.xpc-btn-danger:hover:not(:disabled){background:#dc1e29}',
        '.xpc-log{display:none;background:#000;border:1px solid #38444d;border-radius:8px;height:150px;overflow:auto;padding:6px 8px;margin-top:8px;font-family:Consolas,Menlo,monospace;font-size:11px;user-select:text}',
        '.xpc-log-line{white-space:pre-wrap;word-break:break-all;margin:1px 0;color:#e7e9ea}',
        '.xpc-log-time{color:#71767b;margin-right:6px}',
        '.xpc-log-warn{color:#ffd400}',
        '.xpc-log-error{color:#f4212e}',
        '.xpc-log-debug{color:#71767b}',
        '.xpc-modal-mask{position:fixed;top:0;left:0;right:0;bottom:0;z-index:2147483600;background:rgba(0,0,0,.65);display:flex;align-items:center;justify-content:center}',
        '.xpc-modal{width:360px;max-width:92vw;background:#15202b;border:1px solid #38444d;border-radius:16px;padding:16px;user-select:none}',
        '.xpc-modal h3{font-size:15px;margin-bottom:10px}',
        '.xpc-modal-line{font-size:12px;margin:3px 0;color:#cfd9de}',
        '.xpc-modal-warn{margin-top:10px;font-size:11px;color:#ffd400}',
        '.xpc-modal-actions{margin-top:12px}',
    ].join('\n');

    function injectStyle() {
        if (document.getElementById('xpc-style')) return;
        const style = document.createElement('style');
        style.id = 'xpc-style';
        style.textContent = CSS_TEXT;
        (document.head || document.documentElement).appendChild(style);
    }

    function buildPanel() {
        if (ui.root) return;

        const root = el('div');
        root.id = 'xpc-root';

        // ---- 头部（拖动把手 + 最小化）----
        const header = el('div', 'xpc-header');
        header.title = '按住可拖动';
        const dot = el('span', 'xpc-dot');
        const title = el('a', 'xpc-title', '🗑 ' + SCRIPT_NAME + ' v' + VERSION);
        title.href = 'https://x.com/' + CONFIG.PROFILE_VISIT_USER;
        title.title = '打开作者 @' + CONFIG.PROFILE_VISIT_USER + ' 的主页';
        title.setAttribute('aria-label', title.title);
        title.draggable = false;
        const headerCopy = el('div', 'xpc-header-copy');
        const followNote = el('a', 'xpc-follow-note', '（关注我，及时获取更新）');
        followNote.href = title.href;
        followNote.title = '关注 @' + CONFIG.PROFILE_VISIT_USER + '，获取脚本更新动态';
        followNote.setAttribute('aria-label', followNote.title);
        followNote.draggable = false;
        headerCopy.append(title, followNote);
        const minBtn = el('button', 'xpc-min', '—');
        minBtn.type = 'button';
        minBtn.title = '最小化 / 展开';
        header.append(dot, headerCopy, minBtn);

        // ---- 主体 ----
        const body = el('div', 'xpc-body');

        // 页面上下文行
        const ctx = el('div', 'xpc-context');

        // 删除类型（需求三）
        const secType = el('div', 'xpc-sec');
        secType.appendChild(el('div', 'xpc-sec-title', '删除类型'));
        const typeDefs = [
            ['post', '普通帖子'],
            ['reply', '回复'],
            ['quote', 'Quote 引用'],
            ['repost', 'Repost 转帖（取消当前账号的转帖）'],
        ];
        const typeChecks = {};
        for (const def of typeDefs) {
            const row = el('label', 'xpc-check');
            const input = document.createElement('input');
            input.type = 'checkbox';
            input.dataset.xpcType = def[0];
            row.append(input, el('span', null, def[1]));
            secType.appendChild(row);
            typeChecks[def[0]] = input;
        }

        // 选项
        const secOpt = el('div', 'xpc-sec');
        secOpt.appendChild(el('div', 'xpc-sec-title', '选项'));
        const dryRow = el('label', 'xpc-check');
        const dryInput = document.createElement('input');
        dryInput.type = 'checkbox';
        dryRow.append(dryInput, el('span', null, 'Dry Run 模拟模式（建议保持开启）'));
        const logRow = el('label', 'xpc-check');
        const logInput = document.createElement('input');
        logInput.type = 'checkbox';
        logRow.append(logInput, el('span', null, '显示日志'));
        const bgRow = el('label', 'xpc-check');
        const bgInput = document.createElement('input');
        bgInput.type = 'checkbox';
        bgRow.append(bgInput, el('span', null, '允许后台运行（不推荐）'));
        secOpt.append(dryRow, logRow, bgRow);

        // 参数（需求 11 / 12）
        const secParam = el('div', 'xpc-sec');
        secParam.appendChild(el('div', 'xpc-sec-title', '参数'));
        const rowMax = el('div', 'xpc-row');
        rowMax.append(el('span', 'xpc-label', '最大删除（0=无限制）'));
        const inpMax = el('input', 'xpc-input');
        inpMax.type = 'number';
        inpMax.min = '0';
        inpMax.title = '最多收集此数量的符合条件帖子；达到后停止扫描，失败不补扫。0 表示无限制';
        rowMax.appendChild(inpMax);
        const rowDelay = el('div', 'xpc-row');
        rowDelay.append(el('span', 'xpc-label', '操作间隔（秒）'));
        const inpIntervalMin = el('input', 'xpc-input');
        inpIntervalMin.type = 'number';
        inpIntervalMin.min = '1';
        const inpIntervalMax = el('input', 'xpc-input');
        inpIntervalMax.type = 'number';
        inpIntervalMax.min = '1';
        rowDelay.append(inpIntervalMin, el('span', 'xpc-label', '~'), inpIntervalMax);
        // 操作配额（每小时/每日上限）
        const rowQuota = el('div', 'xpc-row');
        rowQuota.append(el('span', 'xpc-label', '每小时/每日上限'));
        const inpHourly = el('input', 'xpc-input');
        inpHourly.type = 'number';
        inpHourly.min = '0';
        const inpDaily = el('input', 'xpc-input');
        inpDaily.type = 'number';
        inpDaily.min = '0';
        rowQuota.append(inpHourly, el('span', 'xpc-label', '/'), inpDaily);
        secParam.append(rowMax, rowDelay, rowQuota);

        const secDates = el('div', 'xpc-sec');
        secDates.appendChild(el('div', 'xpc-sec-title', '帖子日期范围（本地日期）'));
        const inpDateFrom = el('input', 'xpc-input xpc-date-input');
        const inpDateTo = el('input', 'xpc-input xpc-date-input');
        inpDateFrom.type = inpDateTo.type = 'date';
        inpDateFrom.setAttribute('aria-label', '开始日期');
        inpDateTo.setAttribute('aria-label', '结束日期');
        const rowDateFrom = el('label', 'xpc-row');
        const rowDateTo = el('label', 'xpc-row');
        rowDateFrom.append(el('span', 'xpc-label', '开始日期'), inpDateFrom);
        rowDateTo.append(el('span', 'xpc-label', '结束日期'), inpDateTo);
        const btnClearDates = el('button', 'xpc-btn xpc-clear-dates', '清空日期');
        btnClearDates.type = 'button';
        rowDateTo.appendChild(btnClearDates);
        const dateHint = el('div', 'xpc-hint');
        secDates.append(rowDateFrom, rowDateTo, dateHint);

        // 统计（需求 17 / 面板示例）
        const stats = el('div', 'xpc-stats');
        const statNodes = {};
        const statDefs = [
            ['scanned', '已扫描'], ['matched', '符合条件'], ['deleted', '已完成'],
            ['wouldDelete', '模拟(DRY)'], ['skipped', '跳过'], ['failed', '失败/待确认'],
        ];
        for (const def of statDefs) {
            const cell = el('div', 'xpc-stat');
            const b = el('b', null, '0');
            cell.append(b, el('span', null, def[1]));
            stats.appendChild(cell);
            statNodes[def[0]] = b;
        }

        // 配额行 + 自动暂停横幅（需求 29）
        const quotaLine = el('div', 'xpc-quota');
        const countLine = el('div', 'xpc-count-line');
        countLine.title = '候选只计算已扫描内容，受最大删除限制；累计确认成功按账号保存，含取消转帖';
        const skipLine = el('div', 'xpc-hint');
        skipLine.setAttribute('aria-live', 'polite');
        const banner = el('div', 'xpc-banner');

        // 按钮
        const btnRow1 = el('div', 'xpc-btnrow');
        const btnScan = el('button', 'xpc-btn xpc-btn-primary', '计算删除数');
        btnScan.title = '只扫描并统计符合日期和类型的候选；受最大删除限制，0 表示不限，不执行删除';
        const btnDelete = el('button', 'xpc-btn xpc-btn-danger', '开始删除');
        btnScan.type = 'button';
        btnDelete.type = 'button';
        const btnRow2 = el('div', 'xpc-btnrow');
        const btnPause = el('button', 'xpc-btn', '暂停');
        const btnStop = el('button', 'xpc-btn', '停止');
        btnPause.type = 'button';
        btnStop.type = 'button';
        btnRow1.append(btnScan, btnDelete);
        btnRow2.append(btnPause, btnStop);

        // 日志
        const logBox = el('div', 'xpc-log');
        const btnExport = el('button', 'xpc-btn', '导出诊断日志');
        btnExport.type = 'button';

        body.append(ctx, secType, secOpt, secDates, secParam, stats, countLine, skipLine, quotaLine, banner, btnRow1, btnRow2, btnExport, logBox);
        root.append(header, body);
        document.body.appendChild(root);

        Object.assign(ui, {
            root, dot, minBtn, ctx, dryInput, logInput, bgInput,
            inpMax, inpIntervalMin, inpIntervalMax, inpHourly, inpDaily,
            inpDateFrom, inpDateTo, btnClearDates, dateHint, countLine, skipLine,
            btnScan, btnDelete, btnPause, btnStop,
            banner, quotaLine, logBox, btnExport,
            typeChecks, stats: statNodes,
        });
        ui.postSections = [secType, dryRow, secDates, rowMax, stats, countLine, skipLine, btnRow1];
        ui.followNavigation = el('a', 'xpc-follow-nav', '打开我的关注列表，管理回关与取关');
        body.insertBefore(ui.followNavigation, secType);
        buildFollowingPanel(body);

        bindPanelEvents();
        restorePanelPosition();
    }

    function bindPanelEvents() {
        ui.minBtn.addEventListener('click', () => {
            const minimized = ui.root.classList.toggle('xpc-minimized');
            ui.minBtn.textContent = minimized ? '+' : '—';
        });

        ui.root.querySelector('.xpc-header').addEventListener('pointerdown', onDragStart);

        for (const key of Object.keys(ui.typeChecks)) {
            ui.typeChecks[key].addEventListener('change', () => {
                if (state.running || state.starting || ui.confirmMask) return;
                settings.types[key] = ui.typeChecks[key].checked;
                resetTaskStats();
                saveSettings();
                updatePanel();
                log('删除类型更新：' + TYPE_LABELS[key] + ' = ' + (settings.types[key] ? '开' : '关'));
            });
        }

        ui.dryInput.addEventListener('change', () => {
            settings.dryRun = ui.dryInput.checked;
            saveSettings();
            if (settings.dryRun) {
                log('Dry Run 已开启：删除流程只演练，不会真正删除');
            } else {
                log('Dry Run 已关闭：点击「开始删除」将真实删除内容！', 'warn');
            }
        });

        ui.logInput.addEventListener('change', () => {
            settings.showLog = ui.logInput.checked;
            ui.logBox.style.display = settings.showLog ? 'block' : 'none';
            saveSettings();
        });

        ui.bgInput.addEventListener('change', () => {
            settings.allowBackground = ui.bgInput.checked;
            saveSettings();
            log(settings.allowBackground
                ? '已允许后台运行；浏览器后台定时器节流可能延长等待时间'
                : '已禁止后台运行：标签页切到后台时任务将自动暂停');
        });

        ui.inpHourly.addEventListener('change', () => {
            settings.hourlyLimit = clampNumber(ui.inpHourly.value, 0, 10000, 30);
            ui.inpHourly.value = String(settings.hourlyLimit);
            saveSettings();
            log('每小时删除上限更新为 ' + (settings.hourlyLimit > 0 ? settings.hourlyLimit : '不限制'));
        });

        ui.inpDaily.addEventListener('change', () => {
            settings.dailyLimit = clampNumber(ui.inpDaily.value, 0, 100000, 100);
            ui.inpDaily.value = String(settings.dailyLimit);
            saveSettings();
            log('每日删除上限更新为 ' + (settings.dailyLimit > 0 ? settings.dailyLimit : '不限制'));
        });

        ui.inpMax.addEventListener('change', () => {
            if (state.running || state.starting || ui.confirmMask) return;
            settings.maxDelete = clampNumber(ui.inpMax.value, 0, 100000, 100);
            ui.inpMax.value = String(settings.maxDelete);
            saveSettings();
            resetTaskStats(); updatePanel();
        });

        const changeDates = (key) => {
            if (state.running || state.starting || ui.confirmMask) return;
            if (key === 'dateFrom') settings.dateFrom = ui.inpDateFrom.value;
            else if (key === 'dateTo') settings.dateTo = ui.inpDateTo.value;
            else { settings.dateFrom = ''; settings.dateTo = ''; }
            resetTaskStats();
            saveSettings();
            updatePanel();
        };
        ui.inpDateFrom.addEventListener('change', () => changeDates('dateFrom'));
        ui.inpDateTo.addEventListener('change', () => changeDates('dateTo'));
        ui.btnClearDates.addEventListener('click', () => {
            if (state.running || state.starting || ui.confirmMask) return;
            ui.inpDateFrom.value = ''; ui.inpDateTo.value = '';
            changeDates();
        });

        ui.inpIntervalMin.addEventListener('change', () => {
            settings.intervalMinSec = clampNumber(ui.inpIntervalMin.value, 1, 600, 3);
            if (settings.intervalMinSec > settings.intervalMaxSec) settings.intervalMaxSec = settings.intervalMinSec;
            applyIntervalInputs();
            saveSettings();
        });

        ui.inpIntervalMax.addEventListener('change', () => {
            settings.intervalMaxSec = clampNumber(ui.inpIntervalMax.value, 1, 600, 7);
            if (settings.intervalMaxSec < settings.intervalMinSec) settings.intervalMinSec = settings.intervalMaxSec;
            applyIntervalInputs();
            saveSettings();
        });

        ui.btnScan.addEventListener('click', () => beginTask('scan'));
        ui.btnDelete.addEventListener('click', onStartDeleteClick);
        ui.btnPause.addEventListener('click', togglePause);
        ui.btnStop.addEventListener('click', () => stopTask('用户点击停止'));
        ui.btnExport.addEventListener('click', exportDiagnostics);
    }

    function exportDiagnostics() {
        const report = {
            version: VERSION, exportedAt: new Date().toISOString(), user: state.currentUser,
            page: location.href, settings: activeSettings(), stats: state.stats,
            deleteCounts: getDeleteCounts(),
            profileVisit: getProfileVisitDiagnostics(),
            following: getFollowingDiagnostics(),
            skipReasons: state.skipReasonCounts, autoPauseReason: state.autoPauseReason,
            actionBlockReason: state.actionBlockReason,
            attemptedIds: Array.from(state.attemptedIds), logs: state.logs,
        };
        const url = URL.createObjectURL(new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' }));
        const link = el('a');
        link.href = url;
        link.download = 'xpc-diagnostics-' + dateKeyNow() + '.json';
        document.body.appendChild(link);
        link.click();
        link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 3000);
    }

    function onDragStart(ev) {
        if (ev.button !== 0) return;
        if (ev.target && ev.target.closest && ev.target.closest('a, button')) return;
        ev.preventDefault();
        const root = ui.root;
        const rect = root.getBoundingClientRect();
        const shiftX = ev.clientX - rect.left;
        const shiftY = ev.clientY - rect.top;
        root.style.right = 'auto';
        root.style.bottom = 'auto';
        root.style.left = rect.left + 'px';
        root.style.top = rect.top + 'px';

        const onMove = (e) => {
            root.style.left = clamp(e.clientX - shiftX, 0, Math.max(0, window.innerWidth - rect.width)) + 'px';
            root.style.top = clamp(e.clientY - shiftY, 0, Math.max(0, window.innerHeight - 40)) + 'px';
        };
        const onUp = () => {
            window.removeEventListener('pointermove', onMove);
            window.removeEventListener('pointerup', onUp);
            window.removeEventListener('pointercancel', onUp);
            settings.panelPos = {
                x: parseInt(root.style.left, 10) || 0,
                y: parseInt(root.style.top, 10) || 0,
            };
            saveSettings();
        };
        window.addEventListener('pointermove', onMove);
        window.addEventListener('pointerup', onUp);
        window.addEventListener('pointercancel', onUp);
    }

    function restorePanelPosition() {
        const pos = settings.panelPos;
        if (!pos) return;
        const root = ui.root;
        const rect = root.getBoundingClientRect();
        root.style.right = 'auto';
        root.style.bottom = 'auto';
        root.style.left = clamp(pos.x, 0, Math.max(0, window.innerWidth - rect.width)) + 'px';
        root.style.top = clamp(pos.y, 0, Math.max(0, window.innerHeight - 40)) + 'px';
    }

    function applySettingsToInputs() {
        for (const key of Object.keys(ui.typeChecks)) {
            ui.typeChecks[key].checked = !!settings.types[key];
        }
        ui.dryInput.checked = !!settings.dryRun;
        ui.logInput.checked = !!settings.showLog;
        ui.bgInput.checked = !!settings.allowBackground;
        ui.logBox.style.display = settings.showLog ? 'block' : 'none';
        ui.inpMax.value = String(settings.maxDelete);
        ui.inpDateFrom.value = settings.dateFrom;
        ui.inpDateTo.value = settings.dateTo;
        updateDateHint();
        applyIntervalInputs();
        applyQuotaInputs();
    }

    function applyQuotaInputs() {
        ui.inpHourly.value = String(settings.hourlyLimit);
        ui.inpDaily.value = String(settings.dailyLimit);
    }

    function applyIntervalInputs() {
        ui.inpIntervalMin.value = String(settings.intervalMinSec);
        ui.inpIntervalMax.value = String(settings.intervalMaxSec);
    }

    function updatePanel() {
        if (!ui.root) return;
        updateContextLine();
        updateStats();
        updateDateHint();
        updateQuotaLine();
        updateButtons();
        updateFollowingPanel();
        for (const section of ui.postSections || []) section.style.display = ['following', 'followers'].includes(state.pageTab) ? 'none' : '';
        if (ui.followNavigation) {
            ui.followNavigation.style.display = state.currentUser && state.pageTab !== 'following' ? 'block' : 'none';
            ui.followNavigation.href = state.currentUser ? '/' + state.currentUser + '/following' : '#';
        }
    }

    function updateQuotaLine() {
        if (!ui.quotaLine) return;
        const opts = activeSettings();
        const daily = opts.dailyLimit > 0 ? (dailyCount + '/' + opts.dailyLimit) : String(dailyCount);
        const hourly = opts.hourlyLimit > 0 ? (state.hourlyCount + '/' + opts.hourlyLimit) : String(state.hourlyCount);
        ui.quotaLine.textContent = '今日操作 ' + daily + ' ｜ 本小时 ' + hourly
            + '（上限填 0 = 不限制；每 ' + CONFIG.BATCH_SIZE + ' 条强制休息 '
            + Math.round(CONFIG.BATCH_COOLDOWN_MS / 60000) + ' 分钟）';
    }

    function updateContextLine() {
        const user = state.currentUser ? '@' + state.currentUser : '未检测到登录账号';
        const pageText = state.pageTaskReady ? '✅ ' + state.pageReason : '❌ ' + state.pageReason;
        ui.ctx.textContent = '';
        ui.ctx.appendChild(el('span', null, '当前：' + user
            + (state.currentUserSource ? '（' + state.currentUserSource + '）' : '')));
        ui.ctx.appendChild(el('span', null, ' ｜ 页面：'));
        ui.ctx.appendChild(el('span', state.pageTaskReady ? 'xpc-ok' : 'xpc-bad', pageText));
    }

    function updateStats() {
        for (const key of Object.keys(ui.stats)) {
            ui.stats[key].textContent = String(state.stats[key] || 0);
        }
        if (ui.countLine) {
            const counts = getDeleteCounts();
            ui.countLine.textContent = '候选（已扫描）' + counts.candidate + ' ｜ 本次已删除 ' + counts.deleted
                + ' ｜ 待处理 ' + counts.remaining + '\n模拟 ' + counts.simulated + ' ｜ 累计确认成功 ' + counts.total
                + (candidateLimitReached() ? ' ｜ 已达候选上限' : '');
        }
        if (ui.skipLine) {
            ui.skipLine.textContent = skipReasonSummary();
            ui.skipLine.style.display = ui.skipLine.textContent ? 'block' : 'none';
        }
    }

    function updateDateHint() {
        if (!ui.dateHint) return;
        const error = dateRangeError(activeSettings());
        ui.dateHint.textContent = error || (dateRangeLabel(activeSettings()) + '；留空不限。转帖按原帖发布时间筛选。');
        ui.dateHint.classList.toggle('xpc-bad', !!error);
    }

    function updateButtons() {
        if (!ui.root) return;
        const busy = state.running || state.starting;
        const locked = busy || !!ui.confirmMask;
        ui.btnScan.disabled = locked || !state.pageTaskReady || ['following', 'followers'].includes(state.pageTab);
        ui.btnDelete.disabled = locked || !state.pageTaskReady || ['following', 'followers'].includes(state.pageTab);
        ui.btnPause.disabled = !state.running || state.stopRequested;
        ui.btnStop.disabled = !busy || state.stopRequested;
        const controls = Object.values(ui.typeChecks).concat([
            ui.dryInput, ui.bgInput, ui.inpMax, ui.inpIntervalMin, ui.inpIntervalMax, ui.inpHourly, ui.inpDaily,
            ui.inpDateFrom, ui.inpDateTo, ui.btnClearDates,
        ]);
        controls.forEach((control) => { control.disabled = locked; });
        ui.btnPause.textContent = state.paused ? '继续' : '暂停';
        ui.dot.classList.toggle('xpc-dot-run', state.running && !state.paused);
        ui.dot.classList.toggle('xpc-dot-pause', state.paused);
    }

    function showBannerText(text) {
        if (!ui.banner) return;
        ui.banner.textContent = text;
        ui.banner.style.display = 'block';
    }

    function showBanner(reason) {
        showBannerText('任务已自动暂停。原因：' + reason + '。建议检查页面状态后点击「继续」。');
    }

    function hideBanner() {
        if (ui.banner) ui.banner.style.display = 'none';
    }

    // 需求二十六：正式删除前的一次性确认弹窗
    function onStartDeleteClick() {
        if (state.running || state.starting || ui.confirmMask) return;
        refreshContext();
        if (!state.pageTaskReady) { log('无法开始：' + state.pageReason, 'error'); return; }
        if (['following', 'followers'].includes(state.pageTab)) { log('请回到本人帖子页清理帖子', 'error'); return; }
        if (settings.dryRun) {
            log('Dry Run 开启：将以演练模式运行（不会真正删除）');
            beginTask('delete');
            return;
        }
        try {
            showDeleteConfirmModal();
        } catch (err) {
            // 弹窗路径绝不静默失败：报错会自动展开日志面板
            log('打开删除确认弹窗失败：' + (err && err.message ? err.message : err), 'error');
        }
    }

    function showDeleteConfirmModal() {
        const error = dateRangeError(settings);
        if (error) { log('无法开始：' + error, 'error'); updatePanel(); return; }
        // 用当前可见范围做一次快照统计，让确认框里的数字是真实的
        resetTaskStats();
        scanVisible();
        updatePanel();
        const approval = { user: state.currentUser, href: location.href, settings: JSON.parse(JSON.stringify(settings)) };

        const mask = el('div', 'xpc-modal-mask');
        const modal = el('div', 'xpc-modal');
        modal.setAttribute('role', 'dialog');
        modal.setAttribute('aria-modal', 'true');
        modal.setAttribute('aria-label', '确认开始批量清理');
        modal.appendChild(el('h3', null, '确认开始批量删除？'));

        const ebt = state.eligibleByType;
        const lines = [
            '帖子日期（本地）：' + dateRangeLabel(settings),
            '本次候选（当前已加载内容）：' + state.stats.matched + ' 条',
            '普通帖子 ' + (ebt.post || 0) + ' ｜ 回复 ' + (ebt.reply || 0)
            + ' ｜ Quote ' + (ebt.quote || 0) + ' ｜ Repost ' + (ebt.repost || 0),
            '删除上限：' + (settings.maxDelete > 0 ? settings.maxDelete : '无限制')
            + ' ｜ 间隔：' + settings.intervalMinSec + '~' + settings.intervalMaxSec + ' 秒（随机）',
            '扫描到上限数量的候选即停止加载，处理完这些候选后结束；失败不会补扫新帖子。',
        ];
        for (const line of lines) modal.appendChild(el('div', 'xpc-modal-line', line));
        modal.appendChild(el('div', 'xpc-modal-warn',
            '⚠️ 删除操作无法自动恢复。请确认已在 X 设置中导出数据存档，且当前页面是本人主页。'));

        const actions = el('div', 'xpc-row xpc-modal-actions');
        const btnCancel = el('button', 'xpc-btn', '取消');
        const btnOk = el('button', 'xpc-btn xpc-btn-danger', '确认删除');
        btnCancel.type = 'button';
        btnOk.type = 'button';
        actions.append(btnCancel, btnOk);
        modal.appendChild(actions);
        mask.appendChild(modal);
        // 挂到 body 根节点：与面板的定位/层叠上下文彻底解耦，避免被客户端样式或
        // 面板容器裁剪/变换影响（部分界面扩展会改写容器样式）；类名仍是 xpc-* 命名空间
        document.body.appendChild(mask);
        const onEscape = (ev) => { if (ev.key === 'Escape') { ev.preventDefault(); close(); } };
        const close = () => {
            mask.remove();
            document.removeEventListener('keydown', onEscape);
            if (ui.confirmMask === mask) {
                ui.confirmMask = null;
                ui.confirmContext = null;
                ui.closeConfirm = null;
                updateButtons();
            }
        };
        ui.confirmMask = mask;
        ui.confirmContext = approval;
        ui.closeConfirm = close;
        updateButtons();
        document.addEventListener('keydown', onEscape);
        btnCancel.addEventListener('click', close);
        mask.addEventListener('click', (ev) => { if (ev.target === mask) close(); });
        btnOk.addEventListener('click', () => {
            refreshContext();
            if (ui.confirmMask !== mask || approval.href !== location.href || approval.user !== state.currentUser) {
                close(); log('页面或账号已变化，请重新确认', 'warn'); return;
            }
            close();
            log('用户已确认删除');
            beginTask('delete', approval);
        });
        btnCancel.focus();
    }

    // XGW_FOLLOWING_MODULE_BEGIN
    // Following relationships are UI observations, not proof of a past unfollow.
    const followState = {
        owner: '', history: {}, observations: new WeakMap(), titles: new WeakMap(), refreshTimer: null,
        seen: new Set(), candidates: new Map(), tried: new Set(), attempted: new Set(),
        attemptsByOwner: new Map(), unknownCells: new WeakSet(),
        markStats: { visible: 0, recognized: 0, colored: 0, pending: 0, unrecognized: 0 }, markRows: [],
        stats: { scanned: 0, matched: 0, skipped: 0, unfollowed: 0, wouldUnfollow: 0, failed: 0 },
        approvalKeys: null, approvalOwner: '', approvalHref: '', scanContext: null,
    };
    const FOLLOW_QUERY = '[data-testid="UserCell"]';
    const FOLLOW_BUTTON_QUERY = '[data-testid$="-unfollow"], [data-testid$="-follow"]';
    const UNFOLLOW_LABELS = new Set(['unfollow', '取消关注', '取消關注', 'フォロー解除', 'フォロー解除する',
        '팔로우 취소', '언팔로우', 'dejar de seguir', 'ne plus suivre', 'nicht mehr folgen',
        'smetti di seguire', 'deixar de seguir', 'ontvolgen', 'перестать читать']);

    function followingPageReady() {
        const match = location.pathname.match(/^\/([A-Za-z0-9_]{1,15})\/following\/?$/);
        return !!match && !!state.currentUser && match[1].toLowerCase() === state.currentUser.toLowerCase()
            && state.pageTaskReady && state.pageTab === 'following';
    }

    function relationshipPageReady() {
        const match = location.pathname.match(/^\/([A-Za-z0-9_]{1,15})\/(following|followers)\/?$/);
        return !!match && !!state.currentUser && match[1].toLowerCase() === state.currentUser.toLowerCase()
            && state.pageTaskReady && state.pageTab === match[2];
    }

    function followTaskPhase() { return state.phase === 'followScan' || state.phase === 'unfollow'; }

    function ensureFollowOwner() {
        const owner = String((state.taskContext && followTaskPhase() && state.taskContext.user) || state.currentUser || '').toLowerCase();
        if (owner === followState.owner) return !!owner;
        if (followState.refreshTimer) clearTimeout(followState.refreshTimer);
        followState.refreshTimer = null;
        followState.owner = owner;
        followState.approvalKeys = null; followState.approvalOwner = ''; followState.approvalHref = ''; followState.scanContext = null;
        followState.observations = new WeakMap();
        followState.unknownCells = new WeakSet();
        followState.seen = new Set(); followState.candidates = new Map(); followState.tried = new Set();
        followState.stats = { scanned: 0, matched: 0, skipped: 0, unfollowed: 0, wouldUnfollow: 0, failed: 0 };
        if (!followState.attemptsByOwner.has(owner)) followState.attemptsByOwner.set(owner, new Set());
        followState.attempted = followState.attemptsByOwner.get(owner);
        followState.history = {};
        if (owner) {
            const saved = readStoredJSON(CONFIG.HISTORY_KEY + owner);
            if (saved && saved.owner === owner && saved.users && typeof saved.users === 'object') {
                for (const [uid, row] of Object.entries(saved.users)) {
                    if (/^\d+$/.test(uid) && row && /^[A-Za-z0-9_]{1,15}$/.test(row.username || '')
                        && Number.isFinite(row.firstObservedAt) && row.firstObservedAt > 0) {
                        followState.history[uid] = { username: row.username.toLowerCase(), firstObservedAt: row.firstObservedAt };
                    }
                }
            }
        }
        return !!owner;
    }

    function followWhitelist(opts = activeSettings()) {
        return new Set(String(opts.followWhitelist || '').split(/[\s,，;；]+/)
            .map((name) => name.replace(/^@/, '').toLowerCase()).filter((name) => /^[a-z0-9_]{1,15}$/.test(name)));
    }

    function followingLoading(cell) {
        const root = document.querySelector(SELECTORS.primaryColumn);
        const errors = '[data-testid="retry"], [data-testid="error-detail"], [data-testid="error-message"]';
        const spinners = '[role="progressbar"], [data-testid="spinner"]';
        if (!root) return true;
        if (cell && visibleElements(spinners + ', ' + errors + ', [role="alert"]', cell).length) return true;
        const rootError = !!visibleElements(errors, root).length;
        // parseFollowingCell already verifies this row's rendered button; avoid rescanning every row for each cell.
        if (cell) return rootError;
        const rows = Array.from(root.querySelectorAll(FOLLOW_QUERY)).filter((node) => isVisible(node)
            && !node.closest('aside, article') && visibleElements(FOLLOW_BUTTON_QUERY, node).length === 1);
        // A footer spinner belongs to the next page, not to already rendered account cards.
        return rootError || (!rows.length && !!visibleElements(spinners, root).length);
    }

    function followingIdentity(cell, button) {
        const canonical = (link) => {
            try {
                const url = new URL(link.getAttribute('href'), location.origin);
                const match = url.origin === location.origin && url.pathname.match(/^\/([A-Za-z0-9_]{1,15})\/?$/);
                return match && !RESERVED_PATHS.has(match[1].toLowerCase()) ? match[1].toLowerCase() : null;
            } catch (err) { return null; }
        };
        const linksIn = (scope) => Array.from(scope.querySelectorAll('a[href]')).filter((link) =>
            link.closest(FOLLOW_QUERY) === cell && !link.closest('[data-testid="UserDescription"]') && isVisible(link));
        const namesIn = (scope) => new Set(linksIn(scope).map(canonical).filter(Boolean));
        const hasHandle = (scope, username) => Array.from(scope.querySelectorAll('span, a, [dir="auto"], [dir="ltr"]'))
            .some((node) => node.closest(FOLLOW_QUERY) === cell && isVisible(node)
                // X can render the whole UserCell as a button. Exclude the action, not that outer card.
                && !button.contains(node) && !node.contains(button)
                && (!node.closest('button, [role="button"]') || node.closest('button, [role="button"]') === cell)
                && !node.closest('[data-testid="UserDescription"], [data-xpc-follow-badge]')
                && getItemText(node).toLowerCase() === '@' + username
                && Array.from(node.querySelectorAll('*')).every(isVisible));
        const buttonNames = new Set(Array.from((button.getAttribute('aria-label') || '').matchAll(/@([A-Za-z0-9_]{1,15})(?![A-Za-z0-9_])/g))
            .map((match) => match[1].toLowerCase()));
        if (buttonNames.size > 1) return null;
        const avatarNames = new Set();
        for (const node of cell.querySelectorAll('[data-testid*="UserAvatar"], img[src*="profile_images"], img[src*="default_profile"]')) {
            if (node.closest(FOLLOW_QUERY) !== cell || node.closest('[data-testid="UserDescription"]') || !isVisible(node)) continue;
            const link = node.closest('a[href]');
            if (link && cell.contains(link)) { const name = canonical(link); if (name) avatarNames.add(name); }
        }
        if (avatarNames.size > 1) return null;
        const headers = Array.from(cell.querySelectorAll('[data-testid="User-Name"], [data-testid="UserName"]'))
            .filter((node) => node.closest(FOLLOW_QUERY) === cell && !node.closest('[data-testid="UserDescription"]') && isVisible(node));
        let username = '', headerScope = null;
        if (headers.length) {
            if (headers.length !== 1) return null;
            const names = namesIn(headers[0]);
            if (names.size !== 1) return null;
            username = Array.from(names)[0]; headerScope = headers[0];
            if (!hasHandle(headerScope, username)) return null;
        } else {
            // The first shared name/button row excludes later biography and translated-description siblings.
            for (let scope = button.parentElement; scope && scope !== cell && cell.contains(scope); scope = scope.parentElement) {
                const names = namesIn(scope);
                if (!Array.from(names).some((name) => hasHandle(scope, name))) continue;
                if (names.size !== 1) return null;
                username = Array.from(names)[0]; headerScope = scope; break;
            }
            if (!username) {
                const hint = avatarNames.size === 1 ? Array.from(avatarNames)[0] : buttonNames.size === 1 ? Array.from(buttonNames)[0] : '';
                if (!hint || !namesIn(cell).has(hint) || !hasHandle(cell, hint)) return null;
                username = hint;
            }
        }
        if (buttonNames.size && !buttonNames.has(username)) return null;
        if (avatarNames.size && !avatarNames.has(username)) return null;
        return { username, headerScope };
    }

    function semanticFollowingState(button) {
        const labels = [getItemText(button), button.getAttribute('aria-label') || '']
            .map((text) => text.replace(/\s+/g, ' ').trim().toLowerCase());
        const states = new Set();
        for (const label of labels) {
            if (/^(?:following|正在关注|正在關注|已关注|已關注)(?:\s+@[a-z0-9_]{1,15})?$/.test(label)) states.add(true);
            if (/^(?:follow|关注|關注)(?:\s+@[a-z0-9_]{1,15})?$/.test(label)) states.add(false);
        }
        return states.size > 1 ? 'conflict' : states.size === 1 ? Array.from(states)[0] : null;
    }

    function parseFollowingCell(cell, options = {}) {
        const reject = (reason) => { if (options.diagnostics) options.diagnostics.reason = reason; return null; };
        if (!cell || !cell.matches(FOLLOW_QUERY) || !cell.isConnected) return reject('账号卡片已卸载');
        const root = document.querySelector(SELECTORS.primaryColumn);
        if (!root || !root.contains(cell) || cell.closest('aside, article, [data-testid="whoToFollow"], [data-testid="suggestedUsers"]')
            || (cell.parentElement && cell.parentElement.closest(FOLLOW_QUERY))) return reject('不属于主列表或属于推荐区域');
        for (let group = cell; group && group !== root; group = group.parentElement) {
            if (/^(?:timeline:\s*)?(?:who to follow|you might like|推荐关注|推荐用户|おすすめユーザー|a quién seguir|qui suivre)$/i
                .test(group.getAttribute('aria-label') || '')) return reject('推荐关注区域');
        }
        const buttonQuery = options.forMark ? FOLLOW_BUTTON_QUERY + ', button, [role="button"]' : FOLLOW_BUTTON_QUERY;
        const buttons = Array.from(cell.querySelectorAll(buttonQuery))
            .filter((button) => button.closest(FOLLOW_QUERY) === cell && isVisible(button)
                && !button.closest('[data-testid="UserDescription"], [data-xpc-follow-badge]')
                && (button.matches(FOLLOW_BUTTON_QUERY) || semanticFollowingState(button) !== null));
        if (buttons.length !== 1) return reject('可见关注按钮数量为 ' + buttons.length + '，无法唯一确认');
        const button = buttons[0];
        const identity = followingIdentity(cell, button);
        if (!identity) return reject('姓名、可见 @用户名、主页链接或按钮账号无法交叉确认');
        const username = identity.username;
        const testid = button.getAttribute('data-testid') || '';
        const suffix = testid.match(/^(.+)-(unfollow|follow)$/);
        const semanticState = semanticFollowingState(button);
        if (semanticState === 'conflict') return reject('关注按钮的可见文案和辅助文案状态冲突');
        if (!suffix && (!options.forMark || semanticState === null)) return reject('关注按钮格式无法确认');
        const ids = new Set();
        if (suffix && /^\d+$/.test(suffix[1])) ids.add(suffix[1]);
        for (const node of [cell, button]) {
            const id = node.getAttribute('data-user-id');
            if (id && /^\d+$/.test(id)) ids.add(id);
        }
        // A numeric UID prevents an old handle's history from being inherited by a new account.
        const uid = ids.size === 1 ? Array.from(ids)[0] : null;
        const indicators = Array.from(cell.querySelectorAll('[data-testid="userFollowIndicator"]'))
            .filter((node) => node.closest(FOLLOW_QUERY) === cell && !node.closest('[data-testid="UserDescription"]'));
        let indicator = indicators.length === 1 ? indicators[0] : null;
        // A changed testid must not turn a visible, explicit follow-back label into a negative observation.
        // Existing empty/hidden/ambiguous official indicators remain unknown; fallback only supplies positive evidence.
        if (!indicators.length) {
            const positiveLabels = new Set(['follows you', '关注了你', '關注了你']);
            const fallback = Array.from(cell.querySelectorAll('span, [dir="auto"], [role="status"]')).find((node) =>
                node.children.length === 0 && node.closest(FOLLOW_QUERY) === cell
                && !node.closest('a, [data-testid="UserDescription"], [data-xpc-follow-badge]')
                && ((identity.headerScope && identity.headerScope.contains(node)) || node.parentElement === cell)
                && isVisible(node) && positiveLabels.has(getItemText(node).toLowerCase()));
            if (fallback) indicator = fallback;
        }
        const followerListEvidence = !indicators.length && !indicator && relationshipPageReady() && state.pageTab === 'followers';
        return { uid, key: uid, username, handle: username, cell, button, actionable: !!suffix && !!uid,
            following: suffix ? suffix[2] === 'unfollow' : semanticState, followsYou: indicators.length > 0 || !!indicator || followerListEvidence,
            indicator, followerListEvidence,
            loading: followingLoading(cell), visible: isVisible(cell), ambiguous: ids.size > 1 || indicators.length > 1
                || (semanticState !== null && !!suffix && semanticState !== (suffix[2] === 'unfollow')) };
    }

    function followingObservation(row, now = Date.now()) {
        const fingerprint = [location.pathname, row.uid || '?', row.username, row.actionable, row.button.getAttribute('data-testid'),
            row.following, row.followsYou, row.followerListEvidence,
            row.indicator && isVisible(row.indicator) && !!getItemText(row.indicator), row.loading, row.visible, row.ambiguous].join('|');
        let observation = followState.observations.get(row.cell);
        if (!observation || observation.fingerprint !== fingerprint) {
            observation = { fingerprint, since: now };
            followState.observations.set(row.cell, observation);
        }
        return { stable: now - observation.since >= CONFIG.FOLLOW_SETTLE_MS,
            wait: Math.max(1, CONFIG.FOLLOW_SETTLE_MS - (now - observation.since)) };
    }

    function followingVerdict(row, now = Date.now(), forMark = false) {
        if (!row) return { status: 'unknown', reason: '账号身份或关注按钮无法唯一确认' };
        const observed = followingObservation(row, now);
        if (!row.visible || row.loading || row.ambiguous || !observed.stable) {
            return { status: 'unknown', reason: row.loading ? '账号列表正在加载或出现错误' : '等待账号卡片稳定',
                wait: observed.stable ? undefined : observed.wait };
        }
        if (row.followsYou) return row.followerListEvidence || (row.indicator && isVisible(row.indicator) && getItemText(row.indicator))
            ? { status: row.following ? 'mutual' : 'incoming', reason: '页面显示对方关注了你' }
            : { status: 'unknown', reason: '回关标记隐藏、为空或不唯一，保留该账号' };
        if (!row.following) return { status: 'not-following', reason: '当前已未关注' };
        if (!row.uid || !row.actionable) return forMark
            ? { status: 'display-outgoing', reason: '仅用于关系标色；缺少可靠 UID 或原生按钮标识，不进入自动取关候选' }
            : { status: 'unknown', reason: '无法取得可靠账号 UID 或原生按钮标识，保留该账号' };
        if (followWhitelist().has(row.username)) return { status: 'protected', reason: '保护名单' };
        return { status: 'candidate', reason: '当前页面未显示回关标记' };
    }

    function clearFollowingMark(cell) {
        for (const name of ['status', 'key', 'relation', 'label']) cell.removeAttribute('data-xpc-follow-' + name);
        const title = followState.titles.get(cell);
        if (title) {
            if (cell.getAttribute('title') === title.assigned) {
                if (title.original === null) cell.removeAttribute('title');
                else cell.setAttribute('title', title.original);
            }
            followState.titles.delete(cell);
        }
        for (const badge of cell.querySelectorAll('[data-xpc-follow-badge]')) badge.remove();
    }

    function refreshFollowingMarks() {
        const ownerReady = ensureFollowOwner();
        const root = document.querySelector(SELECTORS.primaryColumn);
        followState.markStats = { visible: 0, recognized: 0, colored: 0, pending: 0, unrecognized: 0 };
        followState.markRows = [];
        if (!root) { updateFollowingMarkStatus(); return; }
        if (!ownerReady || !relationshipPageReady()) {
            for (const cell of root.querySelectorAll('[data-xpc-follow-status]')) clearFollowingMark(cell);
            updateFollowingMarkStatus();
            return;
        }
        let nextWait = Infinity;
        let historyChanged = false;
        const now = Date.now();
        for (const cell of root.querySelectorAll(FOLLOW_QUERY)) {
            const visible = isVisible(cell), diagnostics = {};
            let diagnosticRow = null;
            const row = parseFollowingCell(cell, { forMark: true, diagnostics });
            if (visible) {
                followState.markStats.visible++;
                if (row) followState.markStats.recognized++;
                else followState.markStats.unrecognized++;
            }
            const verdict = followingVerdict(row, now, true);
            if (visible && row && verdict.status === 'unknown') followState.markStats.pending++;
            if (visible && followState.markRows.length < 50) {
                const buttons = Array.from(cell.querySelectorAll(FOLLOW_BUTTON_QUERY + ', button, [role="button"]'))
                    .filter((node) => node.closest(FOLLOW_QUERY) === cell && isVisible(node));
                diagnosticRow = { cardTag: cell.tagName, parsed: !!row, username: row && row.username,
                    uid: row && row.uid, actionable: !!(row && row.actionable), status: verdict.status,
                    reason: diagnostics.reason || verdict.reason,
                    headerCount: cell.querySelectorAll('[data-testid="User-Name"], [data-testid="UserName"]').length,
                    buttons: buttons.slice(0, 4).map((node) => ({ testid: node.getAttribute('data-testid'),
                        role: node.getAttribute('role'), ariaLabel: (node.getAttribute('aria-label') || '').slice(0, 100) })),
                    relation: null };
                followState.markRows.push(diagnosticRow);
            }
            if (!row) { clearFollowingMark(cell); continue; }
            if (verdict.wait && !row.loading) nextWait = Math.min(nextWait, verdict.wait);
            if (verdict.status === 'mutual' && row.uid) {
                const old = followState.history[row.uid];
                if (!old || old.username !== row.username) {
                    followState.history[row.uid] = { username: row.username, firstObservedAt: old ? old.firstObservedAt : now };
                    historyChanged = true;
                }
            }
            if (!activeSettings().followMarkEnabled) { clearFollowingMark(cell); continue; }
            const hadMutual = !!row.uid && !!followState.history[row.uid];
            const relation = verdict.status === 'mutual' ? 'mutual' : verdict.status === 'incoming' ? 'incoming'
                : ['candidate', 'protected', 'display-outgoing'].includes(verdict.status) ? 'outgoing' : '';
            let text = relation === 'mutual' ? '互关' : relation === 'incoming' ? '仅对方关注我'
                : relation === 'outgoing' ? '仅我关注对方（当前未显示回关）' : verdict.status === 'not-following' ? '已未关注' : '关系待确认';
            if (relation === 'outgoing' && hadMutual) text += ' · 曾观察到互关';
            if (verdict.status === 'protected') text += ' · 保护名单';
            if (verdict.status === 'display-outgoing') text += ' · 仅标色，不自动取关';
            const identity = (row.uid || '?') + ':' + row.username;
            if (cell.getAttribute('data-xpc-follow-key') !== identity) clearFollowingMark(cell);
            if (cell.getAttribute('data-xpc-follow-key') !== identity) cell.setAttribute('data-xpc-follow-key', identity);
            if (cell.getAttribute('data-xpc-follow-status') !== verdict.status) cell.setAttribute('data-xpc-follow-status', verdict.status);
            if (relation) {
                if (cell.getAttribute('data-xpc-follow-relation') !== relation) cell.setAttribute('data-xpc-follow-relation', relation);
                if (visible) followState.markStats.colored++;
            } else cell.removeAttribute('data-xpc-follow-relation');
            if (diagnosticRow) diagnosticRow.relation = relation || null;
            if (cell.getAttribute('data-xpc-follow-label') !== text) cell.setAttribute('data-xpc-follow-label', text);
            let title = followState.titles.get(cell);
            if (!title || cell.getAttribute('title') !== title.assigned) {
                title = { original: cell.getAttribute('title'), assigned: '' }; followState.titles.set(cell, title);
            }
            title.assigned = (title.original ? title.original + '\n' : '') + text;
            if (cell.getAttribute('title') !== title.assigned) cell.setAttribute('title', title.assigned);
            for (const badge of cell.querySelectorAll('[data-xpc-follow-badge]')) badge.remove();
        }
        if (historyChanged && !state.storageError) {
            storageSet(CONFIG.HISTORY_KEY + followState.owner, JSON.stringify({ owner: followState.owner, users: followState.history }));
        }
        updateFollowingMarkStatus();
        if (nextWait < Infinity && !followState.refreshTimer) {
            followState.refreshTimer = setTimeout(() => {
                followState.refreshTimer = null; refreshFollowingMarks(); updateFollowingPanel();
            }, Math.max(10, nextWait + 1));
        }
    }

    function followingLimitReached() {
        const limit = activeSettings().maxUnfollow;
        return (limit > 0 && followState.candidates.size >= limit)
            || (followState.approvalKeys !== null && followState.candidates.size >= followState.approvalKeys.size);
    }

    function resetFollowingTask() {
        ensureFollowOwner();
        followState.seen = new Set(); followState.candidates = new Map(); followState.tried = new Set();
        followState.unknownCells = new WeakSet();
        followState.stats = { scanned: 0, matched: 0, skipped: 0, unfollowed: 0, wouldUnfollow: 0, failed: 0 };
        followState.scanContext = { owner: followState.owner, href: location.href };
        updateFollowingPanel();
    }

    function scanFollowingVisible() {
        ensureFollowOwner(); refreshFollowingMarks();
        if (!followState.scanContext) followState.scanContext = { owner: followState.owner, href: location.href };
        const root = document.querySelector(SELECTORS.primaryColumn);
        const available = [];
        if (!root || !followingPageReady()) return available;
        for (const cell of root.querySelectorAll(FOLLOW_QUERY)) {
            const row = parseFollowingCell(cell);
            if (!row) continue;
            const verdict = followingVerdict(row);
            if (verdict.status === 'unknown') continue; // Transient rows are not permanently marked skipped.
            if (!row.uid) continue;
            if (followState.seen.has(row.uid)) {
                const saved = followState.candidates.get(row.uid);
                if (saved && saved.username === row.username && verdict.status === 'candidate'
                    && !followState.tried.has(row.uid) && !followState.attempted.has(row.uid)) available.push(row);
                continue;
            }
            if (followingLimitReached()) continue;
            followState.seen.add(row.uid); followState.stats.scanned++;
            const approved = !followState.approvalKeys || followState.approvalKeys.has(row.uid + ':' + row.username);
            if (verdict.status === 'candidate' && approved && !followState.attempted.has(row.uid)) {
                const candidate = { uid: row.uid, key: row.uid, username: row.username, handle: row.username,
                    observedAt: Date.now(), previouslyMutual: !!followState.history[row.uid] };
                followState.candidates.set(row.uid, candidate); followState.stats.matched++;
                available.push(row);
                if (followingLimitReached()) break;
            } else followState.stats.skipped++;
        }
        updateFollowingPanel();
        return available;
    }

    async function settleFollowingRows() {
        refreshFollowingMarks();
        await waitForCondition(() => {
            refreshFollowingMarks();
            const root = document.querySelector(SELECTORS.primaryColumn);
            if (!root || followingLoading()) return null;
            const rows = Array.from(root.querySelectorAll(FOLLOW_QUERY)).map(parseFollowingCell).filter(Boolean);
            return rows.every((row) => followingObservation(row).stable) ? true : null;
        }, CONFIG.FOLLOW_ROW_WAIT_MS, '等待关注列表卡片稳定', () => !canAct());
    }

    async function scrollFollowingRows() {
        if (!canAct() || followingLimitReached()) return false;
        const root = document.querySelector(SELECTORS.primaryColumn);
        if (!root) return false;
        const before = new Set(Array.from(root.querySelectorAll(FOLLOW_QUERY)).map(parseFollowingCell).filter(Boolean)
            .map((row) => (row.uid || '?') + ':' + row.username));
        const initialY = window.scrollY;
        try { window.scrollBy({ top: Math.max(240, window.innerHeight * 0.8), behavior: 'instant' }); } catch (err) { return false; }
        const found = await waitForCondition(() => {
            if (followingLoading()) return null;
            const rows = Array.from(root.querySelectorAll(FOLLOW_QUERY)).map(parseFollowingCell).filter(Boolean);
            return rows.some((row) => !before.has((row.uid || '?') + ':' + row.username)) ? true : null;
        }, CONFIG.FOLLOW_ROW_WAIT_MS, '等待下一批关注账号', () => !canAct());
        return !!found || window.scrollY > initialY + 2;
    }

    async function runFollowingScan() {
        followState.approvalKeys = null;
        const originalY = window.scrollY;
        let endStreak = 0;
        log('扫描本人关注列表；缺少回关标记只计为当前 UI 候选，不能证明对方曾取关。');
        while (taskActive()) {
            await pauseGate(); if (!taskActive()) break;
            if (!canAct()) continue;
            await settleFollowingRows(); if (!canAct()) continue;
            scanFollowingVisible(); updatePanel();
            if (followingLimitReached()) { log('已收集取关候选上限，不再扫描新账号'); break; }
            if (followingLoading()) { autoPause('关注列表加载失败或一直未完成，请检查页面后继续'); continue; }
            const advanced = await scrollFollowingRows();
            if (!taskActive() || state.paused) continue;
            endStreak = advanced ? 0 : endStreak + 1;
            if (endStreak >= 3) { log('连续三次未发现新关注账号，结束本次扫描（仅统计已加载内容）'); break; }
        }
        if (!state.stopRequested && state.taskContext && location.href === state.taskContext.href) {
            try { window.scrollTo(0, originalY); } catch (err) { /* noop */ }
        }
    }

    function findFollowingRow(candidate) {
        const root = document.querySelector(SELECTORS.primaryColumn);
        if (!root) return null;
        const matches = Array.from(root.querySelectorAll(FOLLOW_QUERY)).map(parseFollowingCell).filter((row) => row
            && row.uid === candidate.uid && row.username === candidate.username);
        return matches.length === 1 ? matches[0] : null;
    }

    function unfollowDialog(target, owned) {
        const dialogs = visibleElements(SELECTORS.dialog).filter((node) => !node.closest('.xpc-modal-mask'));
        const outer = dialogs.filter((node) => !dialogs.some((other) => other !== node && other.contains(node)));
        if (outer.length !== 1 || (owned && outer[0] !== owned)) return null;
        const container = outer[0];
        const confirms = visibleElements(SELECTORS.confirmDelete, container);
        const cancels = visibleElements(SELECTORS.confirmCancel, container);
        if (confirms.length !== 1 || cancels.length !== 1) return null;
        const button = confirms[0];
        if (!UNFOLLOW_LABELS.has(getItemText(button).toLowerCase())) return null;
        const headings = visibleElements('[role="heading"], h1, h2, h3', container);
        const labelled = container.getAttribute('aria-labelledby');
        if (labelled) for (const id of labelled.split(/\s+/)) {
            const node = document.getElementById(id);
            if (node && container.contains(node) && isVisible(node) && !headings.includes(node)) headings.push(node);
        }
        const headingText = headings.map(getItemText).join(' ') + ' ' + (container.getAttribute('aria-label') || '');
        const handles = new Set((headingText.match(/@[A-Za-z0-9_]{1,15}(?![A-Za-z0-9_])/g) || [])
            .map((handle) => handle.slice(1).toLowerCase()));
        if (handles.size !== 1 || !handles.has(target.username)) return null;
        return { container, button, cancel: cancels[0] };
    }

    function currentUnfollowTarget(candidate) {
        if (!canAct() || !followingPageReady()) return null;
        const row = findFollowingRow(candidate);
        if (!row || followingVerdict(row).status !== 'candidate' || followWhitelist().has(row.username)
            || followState.attempted.has(row.uid)) return null;
        return row;
    }

    async function unfollowOne(candidate) {
        let committed = false;
        try {
            if (!(await prepareAction())) return { aborted: true, reason: '请关闭页面已有弹窗后继续' };
            let row = currentUnfollowTarget(candidate);
            if (!row) return { skipped: true, reason: '账号、回关、保护名单或关注状态已变化，保留该账号' };
            if (activeSettings().dryRun) return { ok: true, dryRun: true };
            if (!(await realClick(row.button, () => {
                const current = currentUnfollowTarget(candidate);
                return !!current && current.button === row.button;
            }))) return { aborted: true, reason: state.actionBlockReason || '关注按钮点击前目标复验失败' };
            const justOpened = visibleElements(SELECTORS.dialog).filter((node) => !node.closest('.xpc-modal-mask'));
            if (justOpened.length === 1) state.ownedDialog = justOpened[0];
            const sheet = await waitForCondition(() => unfollowDialog(candidate), CONFIG.CONFIRM_WAIT_MS,
                '等待唯一且属于当前账号的取消关注确认', () => !canAct());
            if (!sheet) return { aborted: true, reason: '取消关注确认框无法唯一识别、文案不匹配或不属于 @' + candidate.username };
            state.ownedDialog = sheet.container;
            const guard = () => !!currentUnfollowTarget(candidate) && !!unfollowDialog(candidate, sheet.container);
            const commit = () => {
                if (!guard() || !checkQuotaBeforeAction() || !recordAction()) return false;
                committed = true; followState.attempted.add(candidate.uid); return true;
            };
            if (!(await realClick(sheet.button, guard, commit,
                () => { const current = unfollowDialog(candidate, sheet.container); return current && current.button; }))) {
                return { aborted: true, reason: state.actionBlockReason || '取消关注确认前已停止或账号状态变化' };
            }
            const outcome = await waitForCondition(() => {
                if (!canAct()) return null;
                const current = findFollowingRow(candidate);
                return current && !current.loading && !current.ambiguous && current.visible && !current.following ? true : null;
            }, CONFIG.FOLLOW_ROW_WAIT_MS, '按同一 UID 验证关注按钮变为未关注', () => state.stopRequested);
            return outcome ? { ok: true } : { uncertain: true, reason: '已提交取消关注，但同一账号的未关注状态未确认；不会自动重复提交' };
        } catch (err) {
            return { uncertain: committed, reason: '取消关注异常：' + (err && err.message ? err.message : err) };
        } finally {
            try { await closeAllOverlays(); } catch (err) { autoPause('取消关注后清理本次弹窗失败，请人工检查'); }
        }
    }

    async function runUnfollowLoop() {
        const opts = activeSettings();
        if (followState.approvalOwner !== followState.owner || followState.approvalHref !== location.href) followState.approvalKeys = null;
        let endStreak = 0;
        while (taskActive()) {
            await pauseGate(); if (!taskActive()) break;
            if (followingLimitReached() && followState.tried.size >= followState.candidates.size) break;
            if (!canAct()) continue;
            if (!opts.dryRun && !checkQuotaBeforeAction()) continue;
            if (!opts.dryRun && typeof batchCooldown === 'function') await batchCooldown();
            if (!canAct()) continue;
            await settleFollowingRows(); if (!canAct()) continue;
            const available = scanFollowingVisible(); updatePanel();
            if (!available.length) {
                if (followingLimitReached()) break;
                if (followingLoading()) { autoPause('关注列表尚未加载完成，请检查后继续'); continue; }
                const advanced = await scrollFollowingRows();
                if (!taskActive() || state.paused) continue;
                endStreak = advanced ? 0 : endStreak + 1;
                if (endStreak >= 3) break;
                continue;
            }
            endStreak = 0;
            const candidate = followState.candidates.get(available[0].uid);
            followState.tried.add(candidate.uid);
            log('开始' + (opts.dryRun ? '演练' : '取消关注') + ' @' + candidate.username + '（UID ' + candidate.uid + '）');
            const result = await unfollowOne(candidate);
            if (result.ok) {
                if (result.dryRun) followState.stats.wouldUnfollow++;
                else followState.stats.unfollowed++;
                state.consecutiveFailures = 0;
                log((result.dryRun ? '[DRY RUN] 取关候选已复验 ' : '已确认取消关注 ') + '@' + candidate.username);
            } else if (result.aborted) {
                if (!followState.attempted.has(candidate.uid)) followState.tried.delete(candidate.uid);
                log('取关中止：' + result.reason, 'warn');
                if (!state.stopRequested && !state.paused) autoPause(result.reason);
            } else if (result.skipped) { followState.stats.skipped++; log(result.reason, 'warn'); }
            else {
                followState.stats.failed++; state.consecutiveFailures++;
                log(result.reason || '取消关注失败', 'error');
                if (result.uncertain) autoPause(result.reason);
            }
            refreshFollowingMarks(); updatePanel(); updateFollowingPanel();
            if (!taskActive()) break;
            if (followingLimitReached() && followState.tried.size >= followState.candidates.size) continue;
            if (result.ok && !state.paused) {
                const lo = Math.max(1, opts.intervalMinSec || 3), hi = Math.max(lo, opts.intervalMaxSec || 7);
                await interruptibleSleep(Math.floor(lo + Math.random() * (hi - lo + 1)) * 1000);
            }
        }
    }

    function finishFollowingTask(phase) {
        const stats = followState.stats;
        log(phase === 'followScan' ? '关注扫描结束：已扫描 ' + stats.scanned + '，当前未显示回关候选 ' + stats.matched
            : '关注任务结束：已确认取关 ' + stats.unfollowed + '，演练 ' + stats.wouldUnfollow + '，失败/待确认 ' + stats.failed);
        followState.approvalKeys = null; followState.approvalOwner = ''; followState.approvalHref = '';
        refreshFollowingMarks(); updateFollowingPanel();
    }

    function renderFollowingCandidateLinks(list, rows, showSubmitted = false) {
        const existing = new Map(Array.from(list.children).map((entry) => [entry.dataset.xpcCandidateKey, entry]));
        const retained = new Set();
        rows.forEach((row, index) => {
            const key = row.uid + ':' + row.username;
            let entry = existing.get(key);
            if (!entry) {
                entry = el('span'); entry.dataset.xpcCandidateKey = key;
                const link = el('a', 'xpc-follow-profile', '@' + row.username);
                link.href = 'https://x.com/' + encodeURIComponent(row.username);
                link.target = '_blank'; link.rel = 'noopener noreferrer'; link.draggable = false;
                link.title = '在新标签页打开 @' + row.username + ' 的主页';
                link.setAttribute('aria-label', link.title);
                entry.append(el('span'), link, el('span'));
            }
            const separator = index ? '、' : '';
            const submitted = showSubmitted && followState.attempted.has(row.uid) ? '（已提交）' : '';
            if (entry.firstChild.textContent !== separator) entry.firstChild.textContent = separator;
            if (entry.lastChild.textContent !== submitted) entry.lastChild.textContent = submitted;
            if (list.children[index] !== entry) list.insertBefore(entry, list.children[index] || null);
            retained.add(entry);
        });
        for (const entry of Array.from(list.children)) if (!retained.has(entry)) entry.remove();
    }

    function showUnfollowConfirmModal() {
        if (state.running || state.starting || ui.confirmMask || !followingPageReady()) return;
        ensureFollowOwner(); refreshFollowingMarks();
        const limit = settings.maxUnfollow;
        const root = document.querySelector(SELECTORS.primaryColumn);
        // Previously scanned virtual rows can be approved, but are revalidated when brought back into view.
        const prior = followState.scanContext && followState.scanContext.owner === followState.owner
            && followState.scanContext.href === location.href ? Array.from(followState.candidates.values()) : [];
        const candidatesById = new Map(prior
            .filter((row) => !followWhitelist(settings).has(row.username) && !followState.attempted.has(row.uid))
            .map((row) => [row.uid, row]));
        if (root) for (const cell of root.querySelectorAll(FOLLOW_QUERY)) {
            const row = parseFollowingCell(cell);
            if (!row) continue;
            if (followingVerdict(row).status === 'candidate' && !followState.attempted.has(row.uid)) candidatesById.set(row.uid, row);
            else if (row.followsYou || !row.following || followWhitelist(settings).has(row.username)) candidatesById.delete(row.uid);
        }
        const candidates = Array.from(candidatesById.values());
        const shown = limit > 0 ? candidates.slice(0, limit) : candidates;
        if (!shown.length) { log('当前没有已稳定且可复验的取关候选，请先扫描关注列表', 'warn'); return; }
        const approval = { user: state.currentUser, href: location.href, settings: JSON.parse(JSON.stringify(settings)) };
        approval.settings.dryRun = false;
        const mask = el('div', 'xpc-modal-mask'), modal = el('div', 'xpc-modal');
        modal.setAttribute('role', 'dialog'); modal.setAttribute('aria-modal', 'true'); modal.setAttribute('aria-label', '确认取消关注候选账号');
        modal.append(el('h3', null, '确认取消关注这些账号？'), el('div', 'xpc-modal-line',
            '本次只处理以下已确认候选；上限 ' + (limit || '不限') + ' 人，失败不会补扫描新账号。'),
            el('div', 'xpc-modal-warn', '没有回关标记不能证明对方曾取关你；未观察到的互关历史不会推断。'));
        const list = el('div', 'xpc-modal-line xpc-follow-preview'); list.style.maxHeight = '180px'; list.style.overflow = 'auto';
        renderFollowingCandidateLinks(list, shown); modal.appendChild(list);
        const actions = el('div', 'xpc-row xpc-modal-actions'), cancel = el('button', 'xpc-btn', '取消'), ok = el('button', 'xpc-btn xpc-btn-danger', '确认取消关注');
        cancel.type = ok.type = 'button'; actions.append(cancel, ok); modal.appendChild(actions); mask.appendChild(modal);
        const escape = (event) => { if (event.key === 'Escape') { event.preventDefault(); close(); } };
        const close = () => {
            mask.remove(); document.removeEventListener('keydown', escape);
            if (ui.confirmMask === mask) { ui.confirmMask = null; ui.confirmContext = null; ui.closeConfirm = null; updatePanel(); }
        };
        ui.confirmMask = mask; ui.confirmContext = approval; ui.closeConfirm = close;
        document.body.appendChild(mask); document.addEventListener('keydown', escape); updatePanel();
        cancel.addEventListener('click', close); mask.addEventListener('click', (event) => { if (event.target === mask) close(); });
        ok.addEventListener('click', () => {
            if (ui.confirmMask !== mask || state.currentUser !== approval.user || location.href !== approval.href) { close(); return; }
            followState.approvalKeys = new Set(shown.map((row) => row.uid + ':' + row.username));
            followState.approvalOwner = approval.user.toLowerCase(); followState.approvalHref = approval.href;
            close(); beginTask('unfollow', approval);
        });
    }

    function buildFollowingPanel(body) {
        if (ui.follow) return;
        const style = el('style'); style.id = 'xpc-follow-style'; style.textContent =
            '[data-testid="UserCell"][data-xpc-follow-relation]{position:relative!important;isolation:isolate}'
            + '[data-testid="UserCell"][data-xpc-follow-relation]::after{content:""!important;display:block!important;position:absolute!important;inset:0!important;width:auto!important;height:auto!important;margin:0!important;z-index:1!important;border-radius:inherit;pointer-events:none!important;background:var(--xpc-follow-tint)!important;box-shadow:inset 0 0 0 1px var(--xpc-follow-edge)!important}'
            + '[data-xpc-follow-relation="mutual"]{--xpc-follow-tint:rgba(29,155,240,.12);--xpc-follow-edge:rgba(29,155,240,.6)}'
            + '[data-xpc-follow-relation="incoming"]{--xpc-follow-tint:rgba(0,186,124,.12);--xpc-follow-edge:rgba(0,186,124,.6)}'
            + '[data-xpc-follow-relation="outgoing"]{--xpc-follow-tint:rgba(244,33,46,.10);--xpc-follow-edge:rgba(244,33,46,.6)}'
            + '.xpc-follow-candidates{max-height:90px;overflow:auto;word-break:break-word;user-select:text}'
            + '#xpc-root .xpc-follow-profile,.xpc-modal-mask .xpc-follow-profile{color:#1d9bf0;text-decoration:underline;cursor:pointer;overflow-wrap:anywhere}'
            + '#xpc-root .xpc-follow-profile:hover,.xpc-modal-mask .xpc-follow-profile:hover{color:#8ecdf8}'
            + '#xpc-root .xpc-follow-profile:focus-visible,.xpc-modal-mask .xpc-follow-profile:focus-visible{outline:2px solid #1d9bf0;outline-offset:2px;border-radius:2px}'
            + '.xpc-follow-section textarea{box-sizing:border-box;width:100%;min-height:42px;background:#15202b;color:#e7e9ea;border:1px solid #38444d;border-radius:5px}';
        (document.head || document.documentElement).appendChild(style);
        const section = el('div', 'xpc-sec xpc-follow-section');
        section.append(el('div', 'xpc-sec-title', '关注关系'), el('div', null, '蓝：互关　绿：仅对方关注我　红：仅我关注对方'));
        const links = el('div', 'xpc-row'), followingLink = el('a', 'xpc-follow-nav', '正在关注'), followersLink = el('a', 'xpc-follow-nav', '关注者');
        links.append(followingLink, followersLink); section.appendChild(links);
        const checkbox = (text) => { const label = el('label', 'xpc-check'), input = el('input'); input.type = 'checkbox'; label.append(input, el('span', null, text)); section.appendChild(label); return input; };
        const mark = checkbox('标出当前关注关系'), dry = checkbox('取关模拟（不点击关注按钮）');
        const markStatus = el('div', 'xpc-follow-mark-status'); markStatus.setAttribute('role', 'status'); section.appendChild(markStatus);
        const maxRow = el('label', 'xpc-row'), max = el('input', 'xpc-input'); max.type = 'number'; max.min = '0'; max.step = '1';
        max.title = '找到上限数量候选立即停止；0 表示不限制'; maxRow.append(el('span', null, '本次取关上限'), max); section.appendChild(maxRow);
        section.appendChild(el('div', null, '保护名单（@用户名，空格或逗号分隔）'));
        const whitelist = el('textarea'); whitelist.setAttribute('aria-label', '取关保护名单'); section.appendChild(whitelist);
        const actions = el('div', 'xpc-row'), scan = el('button', 'xpc-btn', '扫描关注'), cancelScan = el('button', 'xpc-btn', '取消扫描'), unfollow = el('button', 'xpc-btn xpc-btn-danger', '处理未回关候选');
        scan.type = cancelScan.type = unfollow.type = 'button'; actions.append(scan, cancelScan, unfollow); section.appendChild(actions);
        const stats = el('div'), status = el('div', 'xpc-context'), candidates = el('div', 'xpc-follow-candidates');
        section.append(stats, status, candidates);
        const context = body.querySelector('.xpc-context'); body.insertBefore(section, context ? context.nextSibling : body.firstChild);
        ui.follow = { section, mark, markStatus, dry, max, whitelist, scan, cancelScan, unfollow, stats, status, candidates, followingLink, followersLink };
        const editable = () => !state.running && !state.starting && !ui.confirmMask;
        mark.addEventListener('change', () => { if (!editable()) return; settings.followMarkEnabled = mark.checked; saveSettings(); refreshFollowingMarks(); updateFollowingPanel(); });
        dry.addEventListener('change', () => { if (!editable()) return; settings.followDryRun = dry.checked; saveSettings(); updateFollowingPanel(); });
        max.addEventListener('change', () => { if (!editable()) return; const number = Number(max.value); settings.maxUnfollow = Number.isFinite(number) ? Math.min(100000, Math.max(0, Math.floor(number))) : 20; resetFollowingTask(); saveSettings(); updateFollowingPanel(); });
        whitelist.addEventListener('change', () => { if (!editable()) return; settings.followWhitelist = Array.from(followWhitelist({ followWhitelist: whitelist.value })).map((name) => '@' + name).join(' '); resetFollowingTask(); saveSettings(); refreshFollowingMarks(); updateFollowingPanel(); });
        scan.addEventListener('click', () => { if (editable() && followingPageReady()) { followState.approvalKeys = null; beginTask('followScan'); } });
        cancelScan.addEventListener('click', () => {
            if (state.phase !== 'followScan' || (!state.running && !state.starting) || state.stopRequested) return;
            stopTask('用户取消关注扫描');
        });
        unfollow.addEventListener('click', () => {
            if (!editable() || !followingPageReady()) return;
            if (settings.followDryRun) { followState.approvalKeys = null; beginTask('unfollow'); }
            else showUnfollowConfirmModal();
        });
        updateFollowingPanel();
    }

    function getFollowingDiagnostics() {
        return {
            owner: followState.owner, scanContext: followState.scanContext && { ...followState.scanContext },
            stats: { ...followState.stats }, candidateCount: followState.candidates.size,
            marking: { enabled: !!activeSettings().followMarkEnabled, ...followState.markStats },
            visibleCells: followState.markRows.map((row) => ({ ...row, buttons: row.buttons.map((button) => ({ ...button })) })),
            candidates: Array.from(followState.candidates.values()).map((row) => ({ uid: row.uid, username: row.username,
                previouslyMutual: !!row.previouslyMutual, tried: followState.tried.has(row.uid), submitted: followState.attempted.has(row.uid) })),
            historyPositiveCount: Object.keys(followState.history).length,
            protectedCount: followWhitelist().size, submittedCount: followState.attempted.size,
            note: 'Missing follow-back badges describe the currently rendered UI; historical mutual follows are only observed positive records.',
        };
    }

    function updateFollowingMarkStatus() {
        if (!ui.follow) return;
        const stats = followState.markStats;
        let text = !activeSettings().followMarkEnabled ? '标色已关闭'
            : !relationshipPageReady() ? '标色等待确认本人关注列表'
            : '标色已开启 ｜ 可见 ' + stats.visible + ' ｜ 已识别 ' + stats.recognized + ' ｜ 已着色 ' + stats.colored
                + ' ｜ 待确认 ' + stats.pending + ' ｜ 未识别 ' + stats.unrecognized;
        if (activeSettings().followMarkEnabled && relationshipPageReady() && stats.unrecognized) text += '（可导出诊断日志查看原因）';
        if (ui.follow.markStatus.textContent !== text) ui.follow.markStatus.textContent = text;
    }

    function updateFollowingPanel() {
        if (!ui.follow) return;
        const panel = ui.follow, opts = activeSettings(), locked = state.running || state.starting || !!ui.confirmMask;
        const display = ['following', 'followers'].includes(state.pageTab) ? '' : 'none';
        if (panel.section.style.display !== display) panel.section.style.display = display;
        panel.mark.checked = !!opts.followMarkEnabled; panel.dry.checked = !!opts.followDryRun;
        updateFollowingMarkStatus();
        panel.max.value = String(opts.maxUnfollow === undefined ? 20 : opts.maxUnfollow);
        if (document.activeElement !== panel.whitelist) panel.whitelist.value = opts.followWhitelist || '';
        for (const control of [panel.mark, panel.dry, panel.max, panel.whitelist]) control.disabled = locked;
        panel.scan.disabled = panel.unfollow.disabled = locked || !followingPageReady();
        panel.cancelScan.disabled = state.phase !== 'followScan' || (!state.running && !state.starting) || state.stopRequested;
        panel.followingLink.href = '/' + (state.currentUser || '') + '/following';
        panel.followersLink.href = '/' + (state.currentUser || '') + '/followers';
        const stats = followState.stats;
        const text = '已扫描 ' + stats.scanned + ' ｜ 候选 ' + stats.matched + ' ｜ 已取关 ' + stats.unfollowed
            + ' ｜ 演练 ' + stats.wouldUnfollow + ' ｜ 失败/待确认 ' + stats.failed;
        if (panel.stats.textContent !== text) panel.stats.textContent = text;
        const status = state.pageTab === 'followers' ? '关注者页只显示关系颜色；取关请切换到自己的正在关注列表。'
            : '互关历史只含脚本实际观察到的记录；保护名单和关系待确认的账号不会自动取关。';
        if (panel.status.textContent !== status) panel.status.textContent = status;
        renderFollowingCandidateLinks(panel.candidates, Array.from(followState.candidates.values()).slice(0, 100), true);
    }
    // XGW_FOLLOWING_MODULE_END

    // =====================
    // BOOT
    // =====================

    function boot() {
        if (window.top !== window.self) return; // @noframes 双保险
        if (document.getElementById('xpc-root')) return; // 避免重复注入面板/观察器/history 补丁
        const host = location.hostname;
        if (!/(^|\.)x\.com$/.test(host) && !/(^|\.)twitter\.com$/.test(host)) return;

        injectStyle();
        buildPanel();
        applySettingsToInputs();
        dailyCount = loadDailyCount();
        updateQuotaLine();
        refreshContext();
        startRouteWatch();
        startObserver();
        followingMarkTimer = setInterval(() => { if (!document.hidden) refreshFollowingMarks(); }, 1000);

        // 多标签互斥锁的遗留清理 + 后台可见性检测
        window.addEventListener('beforeunload', () => {
            if (profileVisitTimer) clearTimeout(profileVisitTimer);
            profileVisitTimer = null;
            if (followingMarkTimer) clearInterval(followingMarkTimer);
            state.stopRequested = true;
            stopLockHeartbeat();
            releaseLock();
            storageSet(CONFIG.STORAGE_KEY, JSON.stringify(settings));
        });
        document.addEventListener('visibilitychange', () => {
            if (document.hidden && state.running && !state.paused && !activeSettings().allowBackground) {
                autoPause('标签页切到了后台，请回到当前标签页后继续');
            }
            if (!document.hidden) scheduleProfileVisit();
        });
        window.addEventListener('resize', debounce(restorePanelPosition, 100));
        if (typeof GM_addValueChangeListener === 'function') {
            try {
                GM_addValueChangeListener(CONFIG.LOCK_KEY, () => {
                    if (state.running && isMutatingPhase(state.phase) && !ownsLock()) stopTask('运行锁发生变化，任务已停止');
                });
            } catch (err) { /* 老版本油猴使用心跳/点击前复核 */ }
        }

        // 调试句柄（需求 36）：控制台可用 __XPC.state 查看内部状态
        try {
            window.__XPC = Object.freeze({
                version: VERSION,
                state: state,
                settings: () => settings,
                CONFIG: CONFIG,
                SELECTORS: SELECTORS,
            });
        } catch (err) { /* noop */ }

        log(SCRIPT_NAME + ' v' + VERSION + ' 已加载。请先扫描/演练，确认无误后再关闭模拟执行真实清理。');
        log('安全提示：请先在 X「设置 → 你的账号 → 下载数据存档」导出备份；批量删除无法撤销。', 'warn');
        scheduleProfileVisit();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', boot, { once: true });
    } else {
        boot();
    }
})();
