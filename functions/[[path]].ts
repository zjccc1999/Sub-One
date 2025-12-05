/// <reference types="@cloudflare/workers-types" />

import yaml from 'js-yaml';

const OLD_KV_KEY = 'sub_one_data_v1';
const KV_KEY_SUBS = 'sub_one_subscriptions_v1';
const KV_KEY_PROFILES = 'sub_one_profiles_v1';
const KV_KEY_SETTINGS = 'worker_settings_v1';
const COOKIE_NAME = 'auth_session';
const SESSION_DURATION = 8 * 60 * 60 * 1000;


interface Env {
    SUB_ONE_KV: KVNamespace;
    ADMIN_PASSWORD?: string;
}

/**
 * 计算数据的简单哈希值，用于检测变更
 * @param {any} data - 要计算哈希的数据
 * @returns {string} - 数据的哈希值
 */
function calculateDataHash(data: any): string {
    const jsonString = JSON.stringify(data, Object.keys(data).sort());
    let hash = 0;
    for (let i = 0; i < jsonString.length; i++) {
        const char = jsonString.charCodeAt(i);
        hash = ((hash << 5) - hash) + char;
        hash = hash & hash; // 转换为32位整数
    }
    return hash.toString();
}

/**
 * 检测数据是否发生变更
 * @param {any} oldData - 旧数据
 * @param {any} newData - 新数据
 * @returns {boolean} - 是否发生变更
 */
function hasDataChanged(oldData: any, newData: any): boolean {
    if (!oldData && !newData) return false;
    if (!oldData || !newData) return true;
    return calculateDataHash(oldData) !== calculateDataHash(newData);
}

/**
 * 条件性写入KV存储，只在数据真正变更时写入
 * @param {Object} env - Cloudflare环境对象
 * @param {string} key - KV键名
 * @param {any} newData - 新数据
 * @param {any} oldData - 旧数据（可选）
 * @returns {Promise<boolean>} - 是否执行了写入操作
 */
async function conditionalKVPut(env: Env, key: string, newData: any, oldData: any = null): Promise<boolean> {
    if (oldData === null) {
        try {
            oldData = await env.SUB_ONE_KV.get(key, 'json');
        } catch (error) {
            await env.SUB_ONE_KV.put(key, JSON.stringify(newData));
            return true;
        }
    }

    if (hasDataChanged(oldData, newData)) {
        await env.SUB_ONE_KV.put(key, JSON.stringify(newData));
        return true;
    }
    return false;
}

// --- [新] 默认设置中增加通知阈值 ---
const defaultSettings = {
    FileName: 'Sub-One',
    mytoken: 'auto',
    manualNodeToken: '', // 默认为空
    profileToken: '',  // 默认为空，用户需主动设置
    subConverter: 'sub.xeton.dev',  // 更可靠的后端，支持 Reality
    subConfig: 'https://raw.githubusercontent.com/cmliu/ACL4SSR/refs/heads/main/Clash/config/ACL4SSR_Online_Full.ini',
    prependSubName: true,
    NotifyThresholdDays: 3,
    NotifyThresholdPercent: 90
};

const formatBytes = (bytes: number, decimals = 2) => {
    if (!+bytes || bytes < 0) return '0 B';
    const k = 1024;
    const dm = decimals < 0 ? 0 : decimals;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
    // toFixed(dm) after dividing by pow(k, i) was producing large decimal numbers
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    if (i < 0) return '0 B'; // Handle log(0) case
    return `${parseFloat((bytes / Math.pow(k, i)).toFixed(dm))} ${sizes[i]}`;
};

// --- TG 通知函式 (无修改) ---
async function sendTgNotification(settings: any, message: string) {
    if (!settings.BotToken || !settings.ChatID) {
        console.log("TG BotToken or ChatID not set, skipping notification.");
        return false;
    }
    // 为所有消息添加时间戳
    const now = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
    const fullMessage = `${message}\n\n*时间:* \`${now} (UTC+8)\``;

    const url = `https://api.telegram.org/bot${settings.BotToken}/sendMessage`;
    const payload = {
        chat_id: settings.ChatID,
        text: fullMessage,
        parse_mode: 'Markdown',
        disable_web_page_preview: true // 禁用链接预览，使消息更紧凑
    };

    try {
        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        if (response.ok) {
            console.log("TG 通知已成功发送。");
            return true;
        } else {
            const errorData = await response.json();
            console.error("发送 TG 通知失败：", response.status, errorData);
            return false;
        }
    } catch (error) {
        console.error("发送 TG 通知时出错：", error);
        return false;
    }
}

async function handleCronTrigger(env: Env) {
    console.log("Cron trigger fired. Checking all subscriptions for traffic and node count...");
    const originalSubs = await env.SUB_ONE_KV.get(KV_KEY_SUBS, 'json') || [];
    const allSubs = JSON.parse(JSON.stringify(originalSubs)); // 深拷贝以便比较
    const settings = await env.SUB_ONE_KV.get(KV_KEY_SETTINGS, 'json') || defaultSettings;

    const nodeRegex = /^(ss|ssr|vmess|vless|trojan|hysteria2?|hy|hy2|tuic|anytls|socks5):\/\//gm;
    let changesMade = false;

    for (const sub of allSubs) {
        if (sub.url.startsWith('http') && sub.enabled) {
            try {
                // --- 並行請求流量和節點內容 ---
                const trafficRequest = fetch(new Request(sub.url, {
                    headers: { 'User-Agent': 'Clash for Windows/0.20.39' },
                    redirect: "follow",
                    cf: { insecureSkipVerify: true }
                } as any));
                const nodeCountRequest = fetch(new Request(sub.url, {
                    headers: { 'User-Agent': 'Sub-One-Cron-Updater/1.0' },
                    redirect: "follow",
                    cf: { insecureSkipVerify: true }
                } as any));
                const [trafficResult, nodeCountResult] = await Promise.allSettled([
                    Promise.race([trafficRequest, new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 8000))]),
                    Promise.race([nodeCountRequest, new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 8000))])
                ]) as [PromiseSettledResult<Response>, PromiseSettledResult<Response>];

                if (trafficResult.status === 'fulfilled' && trafficResult.value.ok) {
                    const userInfoHeader = trafficResult.value.headers.get('subscription-userinfo');
                    if (userInfoHeader) {
                        const info = {};
                        userInfoHeader.split(';').forEach(part => {
                            const [key, value] = part.trim().split('=');
                            if (key && value) info[key] = /^\d+$/.test(value) ? Number(value) : value;
                        });
                        sub.userInfo = info; // 更新流量資訊
                        await checkAndNotify(sub, settings, env); // 檢查並發送通知
                        changesMade = true;
                    }
                } else if (trafficResult.status === 'rejected') {
                    console.error(`Cron: Failed to fetch traffic for ${sub.name}:`, trafficResult.reason.message);
                }

                if (nodeCountResult.status === 'fulfilled' && nodeCountResult.value.ok) {
                    const text = await nodeCountResult.value.text();
                    let nodeCount = 0;

                    // 方法1: 嘗試 Base64 解碼
                    try {
                        const decoded = atob(text.replace(/\s/g, ''));
                        const matches = decoded.match(nodeRegex);
                        if (matches) {
                            nodeCount = matches.length;
                        }
                    } catch (e) {
                        // Base64 解码失败，继续尝试其他方法
                    }

                    // 方法2: 嘗試 YAML 解析 (Clash 配置)
                    if (nodeCount === 0) {
                        try {
                            const yamlContent = yaml.load(text) as any;
                            if (yamlContent && typeof yamlContent === 'object' && yamlContent.proxies && Array.isArray(yamlContent.proxies)) {
                                nodeCount = yamlContent.proxies.length;
                                console.log(`Cron: Parsed Clash config for ${sub.name}, found ${nodeCount} proxies`);
                            }
                        } catch (e) {
                            // YAML 解析失败，继续尝试其他方法
                        }
                    }

                    // 方法3: 直接匹配原始文本
                    if (nodeCount === 0) {
                        const matches = text.match(nodeRegex);
                        if (matches) {
                            nodeCount = matches.length;
                        }
                    }

                    if (nodeCount > 0) {
                        sub.nodeCount = nodeCount;
                        changesMade = true;
                    }
                } else if (nodeCountResult.status === 'rejected') {
                    console.error(`Cron: Failed to fetch node list for ${sub.name}:`, nodeCountResult.reason.message);
                }

            } catch (e: any) {
                console.error(`Cron: Unhandled error while updating ${sub.name}`, e.message);
            }
        }
    }

    if (changesMade) {
        await env.SUB_ONE_KV.put(KV_KEY_SUBS, JSON.stringify(allSubs));
        console.log("Subscriptions updated with new traffic info and node counts.");
    } else {
        console.log("Cron job finished. No changes detected.");
    }
    return new Response("Cron job completed successfully.", { status: 200 });
}

// --- 认证与API处理的核心函数 (无修改) ---
async function authMiddleware(request: Request, env: Env) {
    const cookie = request.headers.get('Cookie');
    const sessionCookie = cookie?.split(';').find(c => c.trim().startsWith(`${COOKIE_NAME}=`));
    if (!sessionCookie) return false;
    const token = sessionCookie.split('=')[1];
    // 简单的token验证，基于时间戳
    try {
        const timestamp = parseInt(token, 10);
        return !isNaN(timestamp) && (Date.now() - timestamp < SESSION_DURATION);
    } catch {
        return false;
    }
}

// sub: 要检查的订阅对象
// settings: 全局设置
// env: Cloudflare 环境
async function checkAndNotify(sub: any, settings: any, env: Env) {
    if (!sub.userInfo) return; // 没有流量信息，无法检查

    const ONE_DAY_MS = 24 * 60 * 60 * 1000;
    const now = Date.now();

    // 1. 检查订阅到期
    if (sub.userInfo.expire) {
        const expiryDate = new Date(sub.userInfo.expire * 1000);
        const daysRemaining = Math.ceil((expiryDate.getTime() - now) / ONE_DAY_MS);

        // 检查是否满足通知条件：剩余天数 <= 阈值
        if (daysRemaining <= (settings.NotifyThresholdDays || 7)) {
            // 检查上次通知时间，防止24小时内重复通知
            if (!sub.lastNotifiedExpire || (now - sub.lastNotifiedExpire > ONE_DAY_MS)) {
                const message = `🗓️ *订阅临期提醒* 🗓️\n\n*订阅名称:* \`${sub.name || '未命名'}\`\n*状态:* \`${daysRemaining < 0 ? '已过期' : `仅剩 ${daysRemaining} 天到期`}\`\n*到期日期:* \`${expiryDate.toLocaleDateString('zh-CN')}\``;
                const sent = await sendTgNotification(settings, message);
                if (sent) {
                    sub.lastNotifiedExpire = now; // 更新通知时间戳
                }
            }
        }
    }

    // 2. 检查流量使用
    const { upload, download, total } = sub.userInfo;
    if (total > 0) {
        const used = upload + download;
        const usagePercent = Math.round((used / total) * 100);

        // 检查是否满足通知条件：已用百分比 >= 阈值
        if (usagePercent >= (settings.NotifyThresholdPercent || 90)) {
            // 检查上次通知时间，防止24小时内重复通知
            if (!sub.lastNotifiedTraffic || (now - sub.lastNotifiedTraffic > ONE_DAY_MS)) {
                const message = `📈 *流量预警提醒* 📈\n\n*订阅名称:* \`${sub.name || '未命名'}\`\n*状态:* \`已使用 ${usagePercent}%\`\n*详情:* \`${formatBytes(used)} / ${formatBytes(total)}\``;
                const sent = await sendTgNotification(settings, message);
                if (sent) {
                    sub.lastNotifiedTraffic = now;
                }
            }
        }
    }
}


// --- 主要 API 請求處理 ---
async function handleApiRequest(request: Request, env: Env) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/^\/api/, '');
    // [新增] 安全的、可重复执行的迁移接口
    if (path === '/migrate') {
        if (!await authMiddleware(request, env)) { return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 }); }
        try {
            const oldData = await env.SUB_ONE_KV.get(OLD_KV_KEY, 'json');
            const newDataExists = await env.SUB_ONE_KV.get(KV_KEY_SUBS) !== null;

            if (newDataExists) {
                return new Response(JSON.stringify({ success: true, message: '无需迁移，数据已是最新结构。' }), { status: 200 });
            }
            if (!oldData) {
                return new Response(JSON.stringify({ success: false, message: '未找到需要迁移的旧数据。' }), { status: 404 });
            }

            await env.SUB_ONE_KV.put(KV_KEY_SUBS, JSON.stringify(oldData));
            await env.SUB_ONE_KV.put(KV_KEY_PROFILES, JSON.stringify([]));
            await env.SUB_ONE_KV.put(OLD_KV_KEY + '_migrated_on_' + new Date().toISOString(), JSON.stringify(oldData));
            await env.SUB_ONE_KV.delete(OLD_KV_KEY);

            return new Response(JSON.stringify({ success: true, message: '数据迁移成功！' }), { status: 200 });
        } catch (e: any) {
            console.error('[API Error /migrate]', e);
            return new Response(JSON.stringify({ success: false, message: `迁移失败: ${e.message}` }), { status: 500 });
        }
    }

    if (path === '/login') {
        if (request.method !== 'POST') return new Response('Method Not Allowed', { status: 405 });
        try {
            const { password } = await request.json() as any;
            if (password === env.ADMIN_PASSWORD) {
                const token = String(Date.now()); // 简单的基于时间戳的token
                const headers = new Headers({ 'Content-Type': 'application/json' });
                headers.append('Set-Cookie', `${COOKIE_NAME}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${SESSION_DURATION / 1000}`);
                return new Response(JSON.stringify({ success: true }), { headers });
            }
            return new Response(JSON.stringify({ error: '密码错误' }), { status: 401 });
        } catch (e: any) {
            console.error('[API Error /login]', e);
            return new Response(JSON.stringify({ error: '请求体解析失败' }), { status: 400 });
        }
    }
    if (!await authMiddleware(request, env)) {
        return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 });
    }

    switch (path) {
        case '/logout': {
            const headers = new Headers({ 'Content-Type': 'application/json' });
            headers.append('Set-Cookie', `${COOKIE_NAME}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`);
            return new Response(JSON.stringify({ success: true }), { headers });
        }

        case '/data': {
            try {
                const [subs, profiles, settings] = await Promise.all([
                    env.SUB_ONE_KV.get(KV_KEY_SUBS, 'json').then(res => res || []),
                    env.SUB_ONE_KV.get(KV_KEY_PROFILES, 'json').then(res => res || []),
                    env.SUB_ONE_KV.get(KV_KEY_SETTINGS, 'json').then(res => res || {} as any)
                ]);
                const config = {
                    FileName: settings.FileName || 'SUB_ONE',
                    mytoken: settings.mytoken || 'auto',
                    profileToken: settings.profileToken || ''  // 默认为空
                };
                return new Response(JSON.stringify({ subs, profiles, config }), { headers: { 'Content-Type': 'application/json' } });
            } catch (e) {
                console.error('[API Error /data]', 'Failed to read from KV:', e);
                return new Response(JSON.stringify({ error: '读取初始数据失败' }), { status: 500 });
            }
        }

        case '/subs': {
            try {
                // 步骤1: 解析请求体
                let requestData;
                try {
                    requestData = await request.json() as any;
                } catch (parseError) {
                    console.error('[API Error /subs] JSON解析失败:', parseError);
                    return new Response(JSON.stringify({
                        success: false,
                        message: '请求数据格式错误，请检查数据格式'
                    }), { status: 400 });
                }

                const { subs, profiles } = requestData;

                // 步骤2: 验证必需字段
                if (typeof subs === 'undefined' || typeof profiles === 'undefined') {
                    return new Response(JSON.stringify({
                        success: false,
                        message: '请求体中缺少 subs 或 profiles 字段'
                    }), { status: 400 });
                }

                // 步骤3: 验证数据类型
                if (!Array.isArray(subs) || !Array.isArray(profiles)) {
                    return new Response(JSON.stringify({
                        success: false,
                        message: 'subs 和 profiles 必须是数组格式'
                    }), { status: 400 });
                }

                // 步骤4: 获取设置（带错误处理）
                let settings;
                try {
                    settings = await env.SUB_ONE_KV.get(KV_KEY_SETTINGS, 'json') || defaultSettings;
                } catch (settingsError) {
                    console.error('[API Error /subs] 获取设置失败:', settingsError);
                    settings = defaultSettings; // 使用默认设置继续
                }

                // 步骤5: 处理通知（非阻塞，错误不影响保存）
                try {
                    const notificationPromises = subs
                        .filter(sub => sub && sub.url && sub.url.startsWith('http'))
                        .map(sub => checkAndNotify(sub, settings, env).catch(notifyError => {
                            console.error(`[API Warning /subs] 通知处理失败 for ${sub.url}:`, notifyError);
                            // 通知失败不影响保存流程
                        }));

                    // 并行处理通知，但不等待完成
                    Promise.all(notificationPromises).catch(e => {
                        console.error('[API Warning /subs] 部分通知处理失败:', e);
                    });
                } catch (notificationError) {
                    console.error('[API Warning /subs] 通知系统错误:', notificationError);
                    // 继续保存流程
                }

                // 步骤6: 保存数据到KV存储（使用条件写入）
                try {
                    await Promise.all([
                        env.SUB_ONE_KV.put(KV_KEY_SUBS, JSON.stringify(subs)),
                        env.SUB_ONE_KV.put(KV_KEY_PROFILES, JSON.stringify(profiles))
                    ]);
                } catch (kvError: any) {
                    console.error('[API Error /subs] KV存储写入失败:', kvError);
                    return new Response(JSON.stringify({
                        success: false,
                        message: `数据保存失败: ${kvError.message || '存储服务暂时不可用，请稍后重试'}`
                    }), { status: 500 });
                }

                return new Response(JSON.stringify({
                    success: true,
                    message: '订阅源及订阅组已保存'
                }));

            } catch (e: any) {
                console.error('[API Error /subs] 未预期的错误:', e);
                return new Response(JSON.stringify({
                    success: false,
                    message: `保存失败: ${e.message || '服务器内部错误，请稍后重试'}`
                }), { status: 500 });
            }
        }

        case '/node_count': {
            if (request.method !== 'POST') return new Response('Method Not Allowed', { status: 405 });
            const { url: subUrl } = await request.json() as any;
            if (!subUrl || typeof subUrl !== 'string' || !/^https?:\/\//.test(subUrl)) {
                return new Response(JSON.stringify({ error: 'Invalid or missing url' }), { status: 400 });
            }

            const result: { count: number; userInfo: any } = { count: 0, userInfo: null };

            try {
                const fetchOptions = {
                    headers: { 'User-Agent': 'Sub-One-Node-Counter/2.0' },
                    redirect: "follow",
                    cf: { insecureSkipVerify: true }
                } as any;
                const trafficFetchOptions = {
                    headers: { 'User-Agent': 'Clash for Windows/0.20.39' },
                    redirect: "follow",
                    cf: { insecureSkipVerify: true }
                } as any;

                const trafficRequest = fetch(new Request(subUrl, trafficFetchOptions));
                const nodeCountRequest = fetch(new Request(subUrl, fetchOptions));

                const responses = await Promise.allSettled([trafficRequest, nodeCountRequest]);

                // 1. 处理流量请求的结果
                if (responses[0].status === 'fulfilled' && responses[0].value.ok) {
                    const trafficResponse = responses[0].value;
                    const userInfoHeader = trafficResponse.headers.get('subscription-userinfo');
                    if (userInfoHeader) {
                        const info = {};
                        userInfoHeader.split(';').forEach(part => {
                            const [key, value] = part.trim().split('=');
                            if (key && value) info[key] = /^\d+$/.test(value) ? Number(value) : value;
                        });
                        result.userInfo = info;
                    }
                } else if (responses[0].status === 'rejected') {
                    console.error(`Traffic request for ${subUrl} rejected:`, responses[0].reason);
                }

                // 2. 处理节点数请求的结果
                if (responses[1].status === 'fulfilled' && responses[1].value.ok) {
                    const nodeCountResponse = responses[1].value;
                    const text = await nodeCountResponse.text();

                    // 尝试多种解析方法
                    let nodeCount = 0;

                    // 方法1: 尝试Base64解码后匹配节点链接
                    try {
                        const decoded = atob(text.replace(/\s/g, ''));
                        const lineMatches = decoded.match(/^(ss|ssr|vmess|vless|trojan|hysteria2?|hy|hy2|tuic|anytls):\/\//gm);
                        if (lineMatches) {
                            nodeCount = lineMatches.length;
                        }
                    } catch (e) {
                        // Base64解码失败，继续尝试其他方法
                    }

                    // 方法2: 如果是YAML格式，解析Clash配置
                    if (nodeCount === 0) {
                        try {
                            const yamlContent = yaml.load(text) as any;
                            if (yamlContent && typeof yamlContent === 'object' && yamlContent.proxies && Array.isArray(yamlContent.proxies)) {
                                nodeCount = yamlContent.proxies.length;
                            } else {
                            }
                        } catch (e: any) {
                            console.error('[YAML Parse] YAML parsing failed:', e.message);
                            // 继续尝试其他方法
                        }
                    }

                    // 方法3: 直接匹配原始文本中的节点链接
                    if (nodeCount === 0) {
                        const lineMatches = text.match(/^(ss|ssr|vmess|vless|trojan|hysteria2?|hy|hy2|tuic|anytls):\/\//gm);
                        if (lineMatches) {
                            nodeCount = lineMatches.length;
                        }
                    }

                    result.count = nodeCount;
                } else if (responses[1].status === 'rejected') {
                    console.error(`Node count request for ${subUrl} rejected:`, responses[1].reason);
                }

                // 只有在至少获取到一个有效信息时，才更新数据库
                if (result.userInfo || result.count > 0) {
                    const originalSubs = await env.SUB_ONE_KV.get(KV_KEY_SUBS, 'json') || [];
                    const allSubs = JSON.parse(JSON.stringify(originalSubs)); // 深拷贝
                    const subToUpdate = allSubs.find(s => s.url === subUrl);

                    if (subToUpdate) {
                        subToUpdate.nodeCount = result.count;
                        subToUpdate.userInfo = result.userInfo;

                        await env.SUB_ONE_KV.put(KV_KEY_SUBS, JSON.stringify(allSubs));
                    }
                }

            } catch (e) {
                console.error(`[API Error /node_count] Unhandled exception for URL: ${subUrl}`, e);
            }

            return new Response(JSON.stringify(result), { headers: { 'Content-Type': 'application/json' } });
        }

        case '/fetch_external_url': { // New case
            if (request.method !== 'POST') return new Response('Method Not Allowed', { status: 405 });
            const { url: externalUrl } = await request.json() as any;
            if (!externalUrl || typeof externalUrl !== 'string' || !/^https?:\/\//.test(externalUrl)) {
                return new Response(JSON.stringify({ error: 'Invalid or missing url' }), { status: 400 });
            }

            try {
                const response = await fetch(new Request(externalUrl, {
                    headers: { 'User-Agent': 'Sub-One-Proxy/1.0' }, // Identify as proxy
                    redirect: "follow",
                    cf: { insecureSkipVerify: true } // Allow insecure SSL for flexibility
                } as any));

                if (!response.ok) {
                    return new Response(JSON.stringify({ error: `Failed to fetch external URL: ${response.status} ${response.statusText}` }), { status: response.status });
                }

                const content = await response.text();
                return new Response(content, { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });

            } catch (e: any) {
                console.error(`[API Error /fetch_external_url] Failed to fetch ${externalUrl}:`, e);
                return new Response(JSON.stringify({ error: `Failed to fetch external URL: ${e.message}` }), { status: 500 });
            }
        }

        case '/batch_update_nodes': {
            if (request.method !== 'POST') return new Response('Method Not Allowed', { status: 405 });
            if (!await authMiddleware(request, env)) {
                return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 });
            }

            try {
                const { subscriptionIds } = await request.json() as any;
                if (!Array.isArray(subscriptionIds)) {
                    return new Response(JSON.stringify({ error: 'subscriptionIds must be an array' }), { status: 400 });
                }

                const allSubs = (await env.SUB_ONE_KV.get(KV_KEY_SUBS, 'json') || []) as any[];
                const subsToUpdate = allSubs.filter(sub => subscriptionIds.includes(sub.id) && sub.url.startsWith('http'));

                console.log(`[Batch Update] Starting batch update for ${subsToUpdate.length} subscriptions`);

                // 并行更新所有订阅的节点信息
                const updatePromises = subsToUpdate.map(async (sub) => {
                    try {
                        const fetchOptions = {
                            headers: { 'User-Agent': 'Sub-One-Batch-Updater/1.0' },
                            redirect: "follow",
                            cf: { insecureSkipVerify: true }
                        } as any;

                        const response = await Promise.race([
                            fetch(sub.url, fetchOptions),
                            new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 10000))
                        ]) as Response;

                        if (response.ok) {
                            // 更新流量信息
                            const userInfoHeader = response.headers.get('subscription-userinfo');
                            if (userInfoHeader) {
                                const info = {};
                                userInfoHeader.split(';').forEach(part => {
                                    const [key, value] = part.trim().split('=');
                                    if (key && value) info[key] = /^\d+$/.test(value) ? Number(value) : value;
                                });
                                sub.userInfo = info;
                            }

                            // 更新节点数量
                            const text = await response.text();

                            // 尝试多种解析方法
                            let nodeCount = 0;

                            // 方法1: 尝试Base64解码后匹配节点链接
                            try {
                                const decoded = atob(text.replace(/\s/g, ''));
                                const lineMatches = decoded.match(/^(ss|ssr|vmess|vless|trojan|hysteria2?|hy|hy2|tuic|anytls|socks5):\/\//gm);
                                if (lineMatches) {
                                    nodeCount = lineMatches.length;
                                }
                            } catch (e) {
                                // Base64解码失败，继续尝试其他方法
                            }

                            // 方法2: 如果是YAML格式，解析Clash配置
                            if (nodeCount === 0) {
                                try {
                                    const yamlContent = yaml.load(text) as any;
                                    if (yamlContent && typeof yamlContent === 'object' && yamlContent.proxies && Array.isArray(yamlContent.proxies)) {
                                        nodeCount = yamlContent.proxies.length;
                                    }
                                } catch (e) {
                                    // YAML解析失败，继续尝试其他方法
                                }
                            }

                            // 方法3: 直接匹配原始文本中的节点链接
                            if (nodeCount === 0) {
                                const lineMatches = text.match(/^(ss|ssr|vmess|vless|trojan|hysteria2?|hy|hy2|tuic|anytls|socks5):\/\//gm);
                                if (lineMatches) {
                                    nodeCount = lineMatches.length;
                                }
                            }

                            sub.nodeCount = nodeCount;

                            return { id: sub.id, success: true, nodeCount: sub.nodeCount, userInfo: sub.userInfo };
                        } else {
                            return { id: sub.id, success: false, error: `HTTP ${response.status}` };
                        }
                    } catch (error: any) {
                        return { id: sub.id, success: false, error: error.message };
                    }
                });

                const results = await Promise.allSettled(updatePromises);
                const updateResults = results.map(result =>
                    result.status === 'fulfilled' ? result.value : { success: false, error: 'Promise rejected' }
                );

                // 使用批量写入管理器保存更新后的数据
                await env.SUB_ONE_KV.put(KV_KEY_SUBS, JSON.stringify(allSubs));

                console.log(`[Batch Update] Completed batch update, ${updateResults.filter(r => r.success).length} successful`);

                return new Response(JSON.stringify({
                    success: true,
                    message: '批量更新完成',
                    results: updateResults
                }), { headers: { 'Content-Type': 'application/json' } });

            } catch (error: any) {
                console.error('[API Error /batch_update_nodes]', error);
                return new Response(JSON.stringify({
                    success: false,
                    message: `批量更新失败: ${error.message}`
                }), { status: 500 });
            }
        }





        case '/settings': {
            if (request.method === 'GET') {
                try {
                    const settings = await env.SUB_ONE_KV.get(KV_KEY_SETTINGS, 'json') || {};
                    return new Response(JSON.stringify({ ...defaultSettings, ...settings }), { headers: { 'Content-Type': 'application/json' } });
                } catch (e) {
                    console.error('[API Error /settings GET]', 'Failed to read settings from KV:', e);
                    return new Response(JSON.stringify({ error: '读取设置失败' }), { status: 500 });
                }
            }
            if (request.method === 'POST') {
                try {
                    const newSettings = await request.json();
                    const oldSettings = await env.SUB_ONE_KV.get(KV_KEY_SETTINGS, 'json') || {};
                    const finalSettings = { ...oldSettings as any, ...newSettings as any };

                    await env.SUB_ONE_KV.put(KV_KEY_SETTINGS, JSON.stringify(finalSettings));

                    const message = `⚙️ *Sub-One 设置更新* ⚙️\n\n您的 Sub-One 应用设置已成功更新。`;
                    await sendTgNotification(finalSettings, message);

                    return new Response(JSON.stringify({ success: true, message: '设置已保存' }));
                } catch (e) {
                    console.error('[API Error /settings POST]', 'Failed to parse request or write settings to KV:', e);
                    return new Response(JSON.stringify({ error: '保存设置失败' }), { status: 500 });
                }
            }
            return new Response('Method Not Allowed', { status: 405 });
        }
        case '/latency_test': {
            if (request.method !== 'POST') return new Response('Method Not Allowed', { status: 405 });
            const { url: testUrl } = await request.json() as any;

            if (!testUrl || typeof testUrl !== 'string' || !/^https?:\/\//.test(testUrl)) {
                return new Response(JSON.stringify({ error: 'Invalid or missing url' }), { status: 400 });
            }

            try {
                const startTime = Date.now();
                const controller = new AbortController();
                const timeoutId = setTimeout(() => controller.abort(), 10000); // 10s timeout

                const response = await fetch(testUrl, {
                    method: 'HEAD', // Try HEAD first for speed
                    headers: { 'User-Agent': 'Sub-One-Latency-Tester/1.0' },
                    redirect: 'follow',
                    signal: controller.signal,
                    cf: { insecureSkipVerify: true }
                } as any);

                clearTimeout(timeoutId);
                const endTime = Date.now();
                const latency = endTime - startTime;

                if (response.ok) {
                    return new Response(JSON.stringify({
                        success: true,
                        latency: latency,
                        status: response.status
                    }), { headers: { 'Content-Type': 'application/json' } });
                } else {
                    // If HEAD fails (some servers block it), try GET
                    const startTimeGet = Date.now();
                    const controllerGet = new AbortController();
                    const timeoutIdGet = setTimeout(() => controllerGet.abort(), 10000);

                    const responseGet = await fetch(testUrl, {
                        method: 'GET',
                        headers: { 'User-Agent': 'Sub-One-Latency-Tester/1.0' },
                        redirect: 'follow',
                        signal: controllerGet.signal,
                        cf: { insecureSkipVerify: true }
                    } as any);

                    clearTimeout(timeoutIdGet);
                    const endTimeGet = Date.now();
                    const latencyGet = endTimeGet - startTimeGet;

                    if (responseGet.ok) {
                        return new Response(JSON.stringify({
                            success: true,
                            latency: latencyGet,
                            status: responseGet.status
                        }), { headers: { 'Content-Type': 'application/json' } });
                    }

                    return new Response(JSON.stringify({
                        success: false,
                        latency: latencyGet,
                        status: responseGet.status,
                        error: `HTTP ${responseGet.status}`
                    }), { headers: { 'Content-Type': 'application/json' } });
                }

            } catch (e: any) {
                return new Response(JSON.stringify({
                    success: false,
                    error: e.message === 'The user aborted a request.' ? 'Timeout' : e.message
                }), { headers: { 'Content-Type': 'application/json' } });
            }
        }

    }

    return new Response('API route not found', { status: 404 });
}

class SubscriptionParser {
    supportedProtocols: string[];
    _base64Regex: RegExp;
    _whitespaceRegex: RegExp;
    _newlineRegex: RegExp;
    _nodeRegex: RegExp | null;
    _protocolRegex: RegExp;

    constructor() {
        this.supportedProtocols = [
            'ss', 'ssr', 'vmess', 'vless', 'trojan',
            'hysteria', 'hysteria2', 'hy', 'hy2',
            'tuic', 'anytls', 'socks5'
        ];
        this._base64Regex = /^[A-Za-z0-9+\/=]+$/;
        this._whitespaceRegex = /\s/g;
        this._newlineRegex = /\r?\n/;
        this._nodeRegex = null; // 延迟初始化
        this._protocolRegex = /^(.*?):\/\//;
    }

    /**
     * 安全解码 Base64 字符串 (支持 UTF-8)
     */
    decodeBase64(str) {
        try {
            const binaryString = atob(str);
            const bytes = Uint8Array.from(binaryString, c => c.charCodeAt(0));
            return new TextDecoder('utf-8').decode(bytes);
        } catch (e: any) {
            console.warn('Base64 decoding failed:', e);
            return atob(str); // Fallback to standard atob
        }
    }

    /**
     * 解析订阅内容 (通用入口)
     */
    parse(content, subscriptionName = '', options = {}) {
        if (!content || typeof content !== 'string') return [];

        // 0. 预处理：去除 BOM 和首尾空白
        let raw = content.trim();
        if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1);

        let nodes = [];

        // 1. 尝试 JSON 解析 (支持 Sing-box, SIP008, Clash JSON)
        if (raw.startsWith('{') || raw.startsWith('[')) {
            try {
                const json = JSON.parse(raw);
                nodes = this.parseJSON(json);
                if (nodes.length > 0) return this.processNodes(nodes, subscriptionName, options);
            } catch (e: any) {
                // JSON 解析失败，继续尝试其他格式
            }
        }

        // 2. 尝试 YAML 解析 (Clash)
        // 简单的关键词检查，避免对普通文本进行昂贵的 YAML 解析
        if (raw.includes('proxies:') || raw.includes('nodes:') || raw.includes('outbounds:')) {
            try {
                const yamlContent = yaml.load(raw);
                nodes = this.parseYAML(yamlContent);
                if (nodes.length > 0) return this.processNodes(nodes, subscriptionName, options);
            } catch (e: any) {
                // YAML 解析失败
            }
        }

        // 3. 尝试 Base64 解码 (递归解析)
        const base64Clean = raw.replace(this._whitespaceRegex, '');
        if (this._base64Regex.test(base64Clean) && base64Clean.length > 20) {
            try {
                // 自动补全 Padding
                const padded = base64Clean.padEnd(base64Clean.length + (4 - base64Clean.length % 4) % 4, '=');
                const decoded = this.decodeBase64(padded);

                // 检查解码后是否包含大量不可见字符 (二进制数据)，如果是则忽略
                let isBinary = false;
                for (let i = 0; i < Math.min(decoded.length, 100); i++) {
                    const code = decoded.charCodeAt(i);
                    if ((code < 32 && code !== 9 && code !== 10 && code !== 13) || code === 127) {
                        isBinary = true;
                        break;
                    }
                }

                if (!isBinary) {
                    // 递归调用 parse
                    const decodedNodes = this.parse(decoded, subscriptionName, options);
                    if (decodedNodes.length > 0) return decodedNodes;
                }
            } catch (e: any) {
                // Base64 解码或递归解析失败
            }
        }

        // 4. 最后尝试作为纯文本/列表解析
        nodes = this.parsePlainText(raw);
        return this.processNodes(nodes, subscriptionName, options);
    }

    parseJSON(json) {
        let nodes = [];
        if (json.proxies && Array.isArray(json.proxies)) {
            nodes = this.parseClashProxies(json.proxies);
        } else if (json.outbounds && Array.isArray(json.outbounds)) {
            const proxies = json.outbounds.filter(o => o.server && o.server_port);
            nodes = proxies.map(p => this.convertSingBoxToUrl(p)).filter(u => u);
        } else if (Array.isArray(json)) {
            nodes = this.parseClashProxies(json);
        }
        return nodes;
    }

    parseYAML(yamlContent) {
        if (!yamlContent) return [];
        if (yamlContent && typeof yamlContent === 'object' && yamlContent.proxies && Array.isArray(yamlContent.proxies)) {
            return this.parseClashProxies(yamlContent.proxies);
        }
        return [];
    }

    parsePlainText(content) {
        const lines = content.split(this._newlineRegex).map(l => l.trim()).filter(l => l);
        return this.parseNodeLines(lines);
    }

    parseNodeLines(lines: any) {
        if (!this._nodeRegex) {
            this._nodeRegex = new RegExp(`^(${this.supportedProtocols.join('|')}):\/\/`);
        }
        return lines
            .map(l => l.trim())
            .filter(line => this._nodeRegex!.test(line));
    }

    parseClashProxies(proxies: any) {
        return proxies.map(proxy => this.convertClashProxyToUrl(proxy)).filter(url => url);
    }

    convertSingBoxToUrl(proxy: any) {
        try {
            const clashProxy = {
                name: proxy.tag || 'SingBox-Node',
                type: proxy.type,
                server: proxy.server,
                port: proxy.server_port,
                password: proxy.password,
                uuid: proxy.uuid,
                cipher: proxy.method,
            };
            return this.convertClashProxyToUrl(clashProxy);
        } catch (e: any) {
            return null;
        }
    }

    convertClashProxyToUrl(proxy: any) {
        if (!proxy || !proxy.server || !proxy.port) return null;
        const type = proxy.type?.toLowerCase();

        try {
            switch (type) {
                case 'vmess': return this.buildVmessUrl(proxy);
                case 'vless': return this.buildVlessUrl(proxy);
                case 'trojan': return this.buildTrojanUrl(proxy);
                case 'ss': return this.buildShadowsocksUrl(proxy);
                case 'ssr': return this.buildShadowsocksRUrl(proxy);
                case 'hysteria':
                case 'hysteria2': return this.buildHysteriaUrl(proxy);
                case 'tuic': return this.buildTUICUrl(proxy);
                case 'anytls': return this.buildAnytlsUrl(proxy);
                case 'socks5': return this.buildSocks5Url(proxy);
                default: return null;
            }
        } catch (e: any) {
            console.warn(`Failed to convert proxy ${proxy.name}:`, e);
            return null;
        }
    }

    // --- URL 构建辅助函数 ---
    buildVmessUrl(proxy: any) {
        // 1. 提取 WebSocket 相关参数 (兼容 ws-opts, ws-path, ws-headers)
        const wsPath = proxy['ws-opts']?.path || proxy['ws-path'] || proxy.path || '';
        const wsHeaders = proxy['ws-opts']?.headers || proxy['ws-headers'] || {};
        const wsHost = wsHeaders.Host || proxy.host || '';

        // 2. 智能判断网络类型 (net): tcp, ws, h2, http2, kcp, quic, grpc
        let net = proxy.network || 'tcp';
        if (net === 'tcp' && (proxy['ws-opts'] || proxy['ws-path'] || wsPath)) {
            net = 'ws';
        }
        // http2 和 h2 都映射为 h2
        if (net === 'http2') net = 'h2';

        // 3. 智能判断伪装类型 (type)
        let type = 'none';
        if (net === 'tcp' && (proxy['http-opts'] || proxy.obfs === 'http')) {
            type = 'http';
        } else if (net === 'kcp' && proxy['kcp-opts']?.header?.type) {
            type = proxy['kcp-opts'].header.type;
        } else if (net === 'quic' && proxy['quic-opts']?.header?.type) {
            type = proxy['quic-opts'].header.type;
        } else if (proxy.type && proxy.type !== 'vmess') {
            // 如果源数据中有明确的非 vmess type (如 http, srtp, utp, wechat-video, dtls, wireguard)，则保留
            type = proxy.type;
        }

        // 4. 处理不同传输的 path 和 host
        let path = wsPath;
        let host = wsHost;

        // h2/http2 需要特殊处理
        if (net === 'h2') {
            path = proxy['h2-opts']?.path || proxy.path || '/';
            host = (proxy['h2-opts']?.host && Array.isArray(proxy['h2-opts'].host))
                ? proxy['h2-opts'].host[0]
                : proxy.host || '';
        }
        // gRPC 处理
        if (net === 'grpc') {
            path = proxy['grpc-opts']?.['grpc-service-name'] || proxy.serviceName || '';
        }
        // QUIC 处理
        if (net === 'quic' && proxy['quic-opts']) {
            if (proxy['quic-opts'].security) {
                // QUIC 加密类型：none, aes-128-gcm, chacha20-poly1305
                host = proxy['quic-opts'].security;
            }
            if (proxy['quic-opts'].key) {
                path = proxy['quic-opts'].key;
            }
        }

        // 5. 智能处理 SNI
        let sni = proxy.servername || proxy.sni || '';
        if (!sni && host) sni = host;
        if (!host && sni) host = sni;

        const config = {
            v: '2',
            ps: proxy.name || 'VMess',
            add: proxy.server,
            port: proxy.port,
            id: proxy.uuid,
            aid: proxy.alterId || 0,
            scy: proxy.cipher || 'auto',
            net: net,
            type: type,
            host: host,
            path: path,
            tls: (proxy.tls === true || proxy.tls === 'true' || proxy.tls === 'tls') ? 'tls' : 'none',
            sni: sni,
            fp: proxy['client-fingerprint'] || '',
            alpn: proxy.alpn ? (Array.isArray(proxy.alpn) ? proxy.alpn.join(',') : proxy.alpn) : '',
            // 补充关键参数，Subconverter 可识别 (尝试多种命名和类型)
            udp: proxy.udp,
            "skip-cert-verify": proxy['skip-cert-verify'],
            allowInsecure: proxy['skip-cert-verify'],
            insecure: proxy['skip-cert-verify']
        };
        return 'vmess://' + btoa(unescape(encodeURIComponent(JSON.stringify(config))));
    }

    buildVlessUrl(proxy: any) {
        let url = `vless://${proxy.uuid}@${proxy.server}:${proxy.port}`;
        const params: string[] = [];

        // 0. Encryption (v2rayN 必须, 固定为 none)
        params.push('encryption=none');

        // 1. Transport & Network: tcp, ws, grpc, http, h2, quic, httpupgrade, splithttp
        let type = proxy.type || 'tcp';
        if (proxy.network) type = proxy.network;
        if (type && type !== 'tcp') params.push(`type=${type}`);


        // 2. WebSocket
        if (type === 'ws') {
            let wsPath = proxy['ws-opts']?.path || proxy.path || '/';
            let earlyData = proxy['ws-opts']?.['max-early-data'] || proxy['max-early-data'];

            // 从path中提取early data参数（如：/?ed=2560 或 /%3Fed%3D2560）
            if (wsPath.includes('?ed=') || wsPath.includes('%3Fed%3D')) {
                // 先解码查找
                const decodedPath = decodeURIComponent(wsPath);
                const edMatch = decodedPath.match(/[?&]ed=(\d+)/);
                if (edMatch) {
                    earlyData = edMatch[1];
                    // 从原始path中移除ed参数（支持编码和未编码）
                    wsPath = wsPath
                        .replace(/\?ed=\d+/, '')
                        .replace(/%3Fed%3D\d+/i, '')
                        .replace(/&ed=\d+/, '')
                        .replace(/%26ed%3D\d+/i, '');

                    // 如果移除后只剩 / 或 %2F，规范化为 /
                    if (wsPath === '%2F' || wsPath === '') wsPath = '/';
                }
            }

            // 改进编码检测：检查是否包含URL编码字符
            const isAlreadyEncoded = wsPath.includes('%2F') || wsPath.includes('%3F') || /%.{2}/.test(wsPath);
            params.push(`path=${isAlreadyEncoded ? wsPath : encodeURIComponent(wsPath)}`);

            if (proxy['ws-opts']?.headers?.Host || proxy.host) {
                params.push(`host=${encodeURIComponent(proxy['ws-opts']?.headers?.Host || proxy.host)}`);
            }

            if (earlyData) {
                params.push(`ed=${earlyData}`);
            }
        }


        // 3. gRPC
        if (type === 'grpc') {
            const serviceName = proxy['grpc-opts']?.['grpc-service-name'] || proxy.serviceName;
            if (serviceName) params.push(`serviceName=${encodeURIComponent(serviceName)}`);
            if (proxy['grpc-opts']?.mode || proxy.mode) params.push(`mode=${proxy['grpc-opts']?.mode || proxy.mode}`);
        }

        // 4. HTTP/2
        if (type === 'h2' || type === 'http') {
            if (proxy['h2-opts']?.path || proxy.path) params.push(`path=${encodeURIComponent(proxy['h2-opts']?.path || proxy.path)}`);
            if (proxy['h2-opts']?.host || proxy.host) {
                const h2Host = Array.isArray(proxy['h2-opts']?.host) ? proxy['h2-opts'].host[0] : (proxy['h2-opts']?.host || proxy.host);
                params.push(`host=${encodeURIComponent(h2Host)}`);
            }
        }

        // 5. HTTPUpgrade
        if (type === 'httpupgrade') {
            if (proxy['httpupgrade-opts']?.path || proxy.path) params.push(`path=${encodeURIComponent(proxy['httpupgrade-opts']?.path || proxy.path)}`);
            if (proxy['httpupgrade-opts']?.host || proxy.host) params.push(`host=${encodeURIComponent(proxy['httpupgrade-opts']?.host || proxy.host)}`);
        }

        // 6. SplitHTTP
        if (type === 'splithttp') {
            if (proxy['splithttp-opts']?.path || proxy.path) params.push(`path=${encodeURIComponent(proxy['splithttp-opts']?.path || proxy.path)}`);
            if (proxy['splithttp-opts']?.host || proxy.host) params.push(`host=${encodeURIComponent(proxy['splithttp-opts']?.host || proxy.host)}`);
        }

        // 7. Security (TLS / Reality)
        // 支持 reality-opts (Clash Meta) 和 reality_opts (备用)
        const realityOpts = proxy['reality-opts'] || proxy.reality_opts;

        if (proxy.tls || realityOpts) {
            const security = realityOpts ? 'reality' : 'tls';
            params.push(`security=${security}`);

            const sni = proxy.servername || proxy.sni;
            if (sni) params.push(`sni=${sni}`);

            if (proxy['client-fingerprint']) params.push(`fp=${proxy['client-fingerprint']}`);

            if (proxy.alpn && Array.isArray(proxy.alpn) && proxy.alpn.length > 0) {
                params.push(`alpn=${encodeURIComponent(proxy.alpn.join(','))}`);
            }

            // Reality specific
            if (security === 'reality' && realityOpts) {
                if (realityOpts['public-key']) params.push(`pbk=${realityOpts['public-key']}`);
                if (realityOpts['short-id']) params.push(`sid=${realityOpts['short-id']}`);
                if (realityOpts.spider) params.push(`spider=${encodeURIComponent(realityOpts.spider)}`);
            }
        }

        // 8. Flow (XTLS)
        if (proxy.flow) params.push(`flow=${proxy.flow}`);

        // 9. Insecure / Skip Cert Verify
        if (proxy['skip-cert-verify'] === true) params.push('allowInsecure=1');

        if (params.length) url += '?' + params.join('&');
        if (proxy.name) url += '#' + encodeURIComponent(proxy.name);
        return url;
    }

    buildTrojanUrl(proxy: any) {
        let url = `trojan://${proxy.password}@${proxy.server}:${proxy.port}`;
        const params: string[] = [];

        const sni = proxy.sni || proxy.servername;
        if (sni) params.push(`sni=${sni}`);

        if (proxy.alpn && Array.isArray(proxy.alpn) && proxy.alpn.length > 0) {
            params.push(`alpn=${encodeURIComponent(proxy.alpn.join(','))}`);
        }

        // Transport (WS / gRPC)
        if (proxy.network === 'ws') {
            params.push('type=ws');
            if (proxy['ws-opts']?.path || proxy.path) params.push(`path=${encodeURIComponent(proxy['ws-opts']?.path || proxy.path)}`);
            if (proxy['ws-opts']?.headers?.Host || proxy.host) params.push(`host=${encodeURIComponent(proxy['ws-opts']?.headers?.Host || proxy.host)}`);
        } else if (proxy.network === 'grpc') {
            params.push('type=grpc');
            const serviceName = proxy['grpc-opts']?.['grpc-service-name'] || proxy.serviceName;
            if (serviceName) params.push(`serviceName=${encodeURIComponent(serviceName)}`);
        }

        // Shadow-TLS (Trojan-Go / Sing-box)
        if (proxy['shadow-tls-password']) {
            params.push(`shadow-tls-password=${proxy['shadow-tls-password']}`);
            if (proxy['shadow-tls-sni']) params.push(`shadow-tls-sni=${proxy['shadow-tls-sni']}`);
        }

        if (proxy['skip-cert-verify'] === true) params.push('allowInsecure=1');

        if (params.length) url += '?' + params.join('&');
        if (proxy.name) url += '#' + encodeURIComponent(proxy.name);
        return url;
    }

    buildShadowsocksUrl(proxy: any) {
        // Standard SS: ss://user:pass@host:port
        // SIP002: ss://base64(method:password)@host:port
        const auth = `${proxy.cipher}:${proxy.password}`;
        // 使用安全的Base64编码，支持特殊字符和Unicode
        const safeBase64 = btoa(unescape(encodeURIComponent(auth)));
        let url = `ss://${safeBase64}@${proxy.server}:${proxy.port}`;


        // Plugin Support (SIP003)
        if (proxy.plugin) {
            let pluginName = proxy.plugin;
            let pluginArgs: string[] = [];

            // Map 'obfs' to 'obfs-local' (common convention for simple-obfs)
            if (pluginName === 'obfs') pluginName = 'obfs-local';

            if (proxy['plugin-opts']) {
                const opts = proxy['plugin-opts'];

                // Handle specific plugin mappings
                if (pluginName === 'obfs-local' || pluginName === 'simple-obfs') {
                    if (opts.mode) pluginArgs.push(`obfs=${opts.mode}`);
                    if (opts.host) pluginArgs.push(`obfs-host=${opts.host}`);
                    if (opts.uri) pluginArgs.push(`obfs-uri=${opts.uri}`);
                } else if (pluginName === 'v2ray-plugin') {
                    if (opts.mode) pluginArgs.push(`mode=${opts.mode}`);
                    if (opts.host) pluginArgs.push(`host=${opts.host}`);
                    if (opts.path) pluginArgs.push(`path=${opts.path}`);
                    if (opts.tls === true) pluginArgs.push('tls');
                    if (opts.mux === true) pluginArgs.push('mux');
                } else if (pluginName === 'shadow-tls') {
                    if (opts.host) pluginArgs.push(`host=${opts.host}`);
                    if (opts.password) pluginArgs.push(`password=${opts.password}`);
                } else {
                    // Generic fallback for other plugins
                    for (const [key, value] of Object.entries(opts)) {
                        if (value === true) pluginArgs.push(key);
                        else if (value !== false && value !== undefined) pluginArgs.push(`${key}=${value}`);
                    }
                }
            }

            let pluginStr = pluginName;
            if (pluginArgs.length > 0) {
                pluginStr += `;${pluginArgs.join(';')}`;
            }
            url += `/?plugin=${encodeURIComponent(pluginStr)}`;
        }

        if (proxy.name) url += '#' + encodeURIComponent(proxy.name);
        return url;
    }

    buildShadowsocksRUrl(proxy: any) {
        const config = [
            proxy.server, proxy.port, proxy.protocol || 'origin',
            proxy.cipher, proxy.obfs || 'plain',
            btoa(unescape(encodeURIComponent(proxy.password)))  // 安全编码支持特殊字符
        ].join(':');
        const params: string[] = [];
        if (proxy['protocol-param']) params.push(`protoparam=${btoa(proxy['protocol-param'])}`);
        if (proxy['obfs-param']) params.push(`obfsparam=${btoa(proxy['obfs-param'])}`);
        if (proxy.name) params.push(`remarks=${btoa(unescape(encodeURIComponent(proxy.name)))}`);

        let url = `ssr://${btoa(config)}`;
        if (params.length) url += '/?' + params.join('&');
        return url;
    }

    buildHysteriaUrl(proxy: any) {
        // Hysteria 2: hysteria2://[auth@]hostname[:port]/?[key=value]&[key=value]...
        let url = `hysteria2://${proxy.auth || ''}@${proxy.server}:${proxy.port}`;
        const params: string[] = [];

        const sni = proxy.sni || proxy.servername;
        if (sni) params.push(`sni=${sni}`);

        if (proxy.obfs) {
            params.push(`obfs=${proxy.obfs}`);
            if (proxy['obfs-password']) params.push(`obfs-password=${proxy['obfs-password']}`);
        }

        if (proxy.alpn && Array.isArray(proxy.alpn) && proxy.alpn.length > 0) {
            params.push(`alpn=${encodeURIComponent(proxy.alpn.join(','))}`);
        }

        if (proxy['skip-cert-verify'] === true) params.push('insecure=1');

        if (params.length) url += '?' + params.join('&');
        if (proxy.name) url += '#' + encodeURIComponent(proxy.name);
        return url;
    }

    buildTUICUrl(proxy: any) {
        // TUIC v5: tuic://UUID:PASSWORD@SERVER_ADDRESS:PORT/?congestion_control=bbr
        let url = `tuic://${proxy.uuid}:${proxy.password}@${proxy.server}:${proxy.port}`;
        const params: string[] = [];

        const sni = proxy.sni || proxy.servername;
        if (sni) params.push(`sni=${sni}`);

        if (proxy.alpn && Array.isArray(proxy.alpn) && proxy.alpn.length > 0) {
            params.push(`alpn=${encodeURIComponent(proxy.alpn[0])}`); // TUIC URL usually takes one ALPN or comma separated
        }

        if (proxy.congestion_controller) params.push(`congestion_control=${proxy.congestion_controller}`);
        if (proxy.udp_relay_mode) params.push(`udp_relay_mode=${proxy.udp_relay_mode}`);
        if (proxy['skip-cert-verify'] === true) params.push('allow_insecure=1');
        if (proxy.disable_sni === true) params.push('disable_sni=1');

        if (params.length) url += '?' + params.join('&');
        if (proxy.name) url += '#' + encodeURIComponent(proxy.name);
        return url;
    }

    buildAnytlsUrl(proxy: any) {
        let url = `anytls://${proxy.password}@${proxy.server}:${proxy.port}`;
        const params: string[] = [];

        const sni = proxy.sni || proxy.servername;
        if (sni) params.push(`sni=${sni}`);

        if (proxy['client-fingerprint']) params.push(`fp=${proxy['client-fingerprint']}`);
        if (proxy['idle-session-check-interval']) params.push(`idle_session_check_interval=${proxy['idle-session-check-interval']}`);
        if (proxy['idle-session-timeout']) params.push(`idle_session_timeout=${proxy['idle-session-timeout']}`);
        if (proxy['min-idle-session']) params.push(`min_idle_session=${proxy['min-idle-session']}`);
        if (proxy['skip-cert-verify'] === true) params.push('insecure=1');

        if (params.length) url += '?' + params.join('&');
        if (proxy.name) url += '#' + encodeURIComponent(proxy.name);
        return url;
    }

    buildSocks5Url(proxy: any) {
        let url = 'socks5://';
        if (proxy.username && proxy.password) url += `${proxy.username}:${proxy.password}@`;
        url += `${proxy.server}:${proxy.port}`;
        if (proxy.name) url += '#' + encodeURIComponent(proxy.name);
        return url;
    }

    processNodes(nodes: any, subName: any, options: any) {
        let processed = nodes;

        // 1. 处理 Include/Exclude 规则
        if (options.exclude && options.exclude.trim()) {
            const rules = options.exclude.trim().split('\n').map(r => r.trim()).filter(Boolean);
            const keepRules = rules.filter(r => r.toLowerCase().startsWith('keep:'));

            if (keepRules.length > 0) {
                // 白名单模式
                const nameRegexParts: string[] = [];
                const protocolsToKeep = new Set<string>();
                keepRules.forEach(rule => {
                    const content = rule.substring(5).trim(); // 'keep:'.length
                    if (content.toLowerCase().startsWith('proto:')) {
                        content.substring(6).split(',').forEach(p => protocolsToKeep.add(p.trim().toLowerCase()));
                    } else {
                        nameRegexParts.push(content);
                    }
                });
                const nameRegex = nameRegexParts.length ? new RegExp(nameRegexParts.join('|'), 'i') : null;

                processed = processed.filter(link => {
                    const proto = link.split(':')[0].toLowerCase();
                    if (protocolsToKeep.has(proto)) return true;
                    if (nameRegex) {
                        const name = this.extractName(link);
                        if (nameRegex.test(name)) return true;
                    }
                    return false;
                });
            } else {
                // 黑名单模式
                const protocolsToExclude = new Set<string>();
                const nameRegexParts: string[] = [];
                rules.forEach(rule => {
                    if (rule.toLowerCase().startsWith('proto:')) {
                        rule.substring(6).split(',').forEach(p => protocolsToExclude.add(p.trim().toLowerCase()));
                    } else {
                        nameRegexParts.push(rule);
                    }
                });
                const nameRegex = nameRegexParts.length ? new RegExp(nameRegexParts.join('|'), 'i') : null;

                processed = processed.filter(link => {
                    const proto = link.split(':')[0].toLowerCase();
                    if (protocolsToExclude.has(proto)) return false;
                    if (nameRegex) {
                        const name = this.extractName(link);
                        if (nameRegex.test(name)) return false;
                    }
                    return true;
                });
            }
        }

        // 2. 添加前缀
        if (options.prependSubName && subName) {
            processed = processed.map(link => this.prependName(link, subName));
        }

        return processed;
    }

    extractName(link: any) {
        try {
            const hashIndex = link.lastIndexOf('#');
            if (hashIndex !== -1) return decodeURIComponent(link.substring(hashIndex + 1));
            // 特殊处理 vmess
            if (link.startsWith('vmess://')) {
                const config = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(link.substring(8)), c => c.charCodeAt(0))));
                return config.ps || '';
            }
        } catch (e) { }
        return '';
    }

    prependName(link: any, prefix: any) {
        const appendToFragment = (baseLink, p) => {
            const hashIndex = baseLink.lastIndexOf('#');
            const originalName = hashIndex !== -1 ? decodeURIComponent(baseLink.substring(hashIndex + 1)) : '';
            const base = hashIndex !== -1 ? baseLink.substring(0, hashIndex) : baseLink;
            if (originalName.startsWith(p)) return baseLink;
            const newName = originalName ? `${p} - ${originalName}` : p;
            return `${base}#${encodeURIComponent(newName)}`;
        };

        if (link.startsWith('vmess://')) {
            try {
                const base64 = link.substring(8);
                const json = new TextDecoder().decode(Uint8Array.from(atob(base64), c => c.charCodeAt(0)));
                const config = JSON.parse(json);
                if (!config.ps?.startsWith(prefix)) {
                    config.ps = config.ps ? `${prefix} - ${config.ps}` : prefix;
                    return 'vmess://' + btoa(unescape(encodeURIComponent(JSON.stringify(config))));
                }
                return link;
            } catch (e) {
                return appendToFragment(link, prefix);
            }
        }
        return appendToFragment(link, prefix);
    }
}

const subscriptionParser = new SubscriptionParser();

async function generateCombinedNodeList(context, config, userAgent, subs, prependedContent = '') {
    // 1. 处理手动节点
    const manualNodes = subs.filter(sub => !sub.url.toLowerCase().startsWith('http'));
    const processedManualNodes = subscriptionParser.processNodes(
        manualNodes.map(n => n.url),
        '手动节点',
        { prependSubName: config.prependSubName }
    );

    // 2. 处理 HTTP 订阅
    const httpSubs = subs.filter(sub => sub.url.toLowerCase().startsWith('http'));
    const subPromises = httpSubs.map(async (sub) => {
        try {
            const response = await Promise.race([
                fetch(new Request(sub.url, {
                    headers: { 'User-Agent': userAgent },
                    redirect: "follow",
                    cf: { insecureSkipVerify: true }
                } as any)),
                new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 10000))
            ]) as Response;

            if (!response.ok) return [];
            const text = await response.text();

            return subscriptionParser.parse(text, sub.name, {
                exclude: sub.exclude,
                prependSubName: config.prependSubName
            });
        } catch (e) {
            console.error(`Failed to fetch/parse sub ${sub.name}:`, e);
            return [];
        }
    });

    const processedSubResults = await Promise.all(subPromises);
    const allNodes = [...processedManualNodes, ...processedSubResults.flat()];

    // 3. 去重
    const uniqueNodes = [...new Set(allNodes)];

    let finalContent = uniqueNodes.join('\n');
    if (finalContent.length > 0 && !finalContent.endsWith('\n')) finalContent += '\n';

    if (prependedContent) {
        return `${finalContent}${prependedContent}`;
    }
    return finalContent;
}

// --- [核心修改] 订阅处理函数 ---
// --- [最終修正版 - 變量名校對] 訂閱處理函數 ---
async function handleSubRequest(context: EventContext<Env, any, any>) {
    const { request, env } = context;
    const url = new URL(request.url);
    const userAgentHeader = request.headers.get('User-Agent') || "Unknown";

    const [settingsData, subsData, profilesData] = await Promise.all([
        env.SUB_ONE_KV.get(KV_KEY_SETTINGS, 'json'),
        env.SUB_ONE_KV.get(KV_KEY_SUBS, 'json'),
        env.SUB_ONE_KV.get(KV_KEY_PROFILES, 'json')
    ]);
    const settings = settingsData || {};
    const allSubs = (subsData || []) as any[];
    const allProfiles = (profilesData || []) as any[];
    // 關鍵：我們在這裡定義了 `config`，後續都應該使用它
    const config = { ...defaultSettings, ...settings };

    let token: string | null = '';
    let profileIdentifier: string | null = null;
    const pathSegments = url.pathname.replace(/^\/sub\//, '/').split('/').filter(Boolean);

    if (pathSegments.length > 0) {
        token = pathSegments[0];
        if (pathSegments.length > 1) {
            profileIdentifier = pathSegments[1] || null;
        }
    } else {
        token = url.searchParams.get('token');
    }

    let targetSubs;
    let subName = config.FileName;
    let effectiveSubConverter;
    let effectiveSubConfig;
    let isProfileExpired = false; // Moved declaration here

    const DEFAULT_EXPIRED_NODE = `trojan://00000000-0000-0000-0000-000000000000@127.0.0.1:443#${encodeURIComponent('您的订阅已失效')}`;

    if (profileIdentifier) {

        // [修正] 使用 config 變量
        if (!token || token !== config.profileToken) {
            return new Response('Invalid Profile Token', { status: 403 });
        }
        const profile = allProfiles.find(p => (p.customId && p.customId === profileIdentifier) || p.id === profileIdentifier);
        if (profile && profile.enabled) {
            // Check if the profile has an expiration date and if it's expired

            if (profile.expiresAt) {
                const expiryDate = new Date(profile.expiresAt);
                const now = new Date();
                if (now > expiryDate) {
                    console.log(`Profile ${profile.name} (ID: ${profile.id}) has expired.`);
                    isProfileExpired = true;
                }
            }

            if (isProfileExpired) {
                subName = profile.name; // Still use profile name for filename
                targetSubs = [{ id: 'expired-node', url: DEFAULT_EXPIRED_NODE, name: '您的订阅已到期', isExpiredNode: true }]; // Set expired node as the only targetSub
            } else {
                subName = profile.name;
                const profileSubIds = new Set(profile.subscriptions);
                const profileNodeIds = new Set(profile.manualNodes);
                targetSubs = allSubs.filter(item => {
                    const isSubscription = item.url.startsWith('http');
                    const isManualNode = !isSubscription;

                    // Check if the item belongs to the current profile and is enabled
                    const belongsToProfile = (isSubscription && profileSubIds.has(item.id)) || (isManualNode && profileNodeIds.has(item.id));
                    if (!item.enabled || !belongsToProfile) {
                        return false;
                    }
                    return true;
                });
            }
            effectiveSubConverter = profile.subConverter && profile.subConverter.trim() !== '' ? profile.subConverter : config.subConverter;
            effectiveSubConfig = profile.subConfig && profile.subConfig.trim() !== '' ? profile.subConfig : config.subConfig;
        } else {
            return new Response('Profile not found or disabled', { status: 404 });
        }
    } else {
        if (token === config.mytoken) {
            targetSubs = allSubs.filter(s => s.enabled);
        } else if (config.manualNodeToken && token === config.manualNodeToken) {
            // 仅返回手动节点
            targetSubs = allSubs.filter(s => s.enabled && !s.url.toLowerCase().startsWith('http'));
        } else {
            return new Response('Invalid Token', { status: 403 });
        }
        effectiveSubConverter = config.subConverter;
        effectiveSubConfig = config.subConfig;
    }

    // 如果 subConverter 为空或只有空白字符，使用默认值
    if (!effectiveSubConverter || effectiveSubConverter.trim() === '') {
        effectiveSubConverter = defaultSettings.subConverter;
    }
    if (!effectiveSubConfig || effectiveSubConfig.trim() === '') {
        effectiveSubConfig = defaultSettings.subConfig;
    }

    let targetFormat = url.searchParams.get('target');
    if (!targetFormat) {
        const supportedFormats = ['clash', 'singbox', 'surge', 'loon', 'base64', 'v2ray', 'trojan'];
        for (const format of supportedFormats) {
            if (url.searchParams.has(format)) {
                if (format === 'v2ray' || format === 'trojan') { targetFormat = 'base64'; } else { targetFormat = format; }
                break;
            }
        }
    }
    if (!targetFormat) {
        const ua = userAgentHeader.toLowerCase();
        // 使用陣列來保證比對的優先順序
        const uaMapping = [
            // 優先匹配 Mihomo/Meta 核心的客戶端
            ['flyclash', 'clash'],
            ['mihomo', 'clash'],
            ['clash.meta', 'clash'],
            ['clash-verge', 'clash'],
            ['meta', 'clash'],

            // 其他客戶端
            ['stash', 'clash'],
            ['nekoray', 'clash'],
            ['sing-box', 'singbox'],
            ['shadowrocket', 'base64'],
            ['v2rayn', 'base64'],
            ['v2rayng', 'base64'],
            ['surge', 'surge'],
            ['loon', 'loon'],
            ['quantumult%20x', 'quanx'],
            ['quantumult', 'quanx'],

            // 最後才匹配通用的 clash，作為向下相容
            ['clash', 'clash']
        ];

        for (const [keyword, format] of uaMapping) {
            if (ua.includes(keyword)) {
                targetFormat = format;
                break; // 找到第一個符合的就停止
            }
        }
    }
    if (!targetFormat) { targetFormat = 'base64'; }

    if (!url.searchParams.has('callback_token')) {
        const clientIp = request.headers.get('CF-Connecting-IP') || 'N/A';
        const country = request.headers.get('CF-IPCountry') || 'N/A';
        const domain = url.hostname;
        let message = `🛰️ *订阅被访问* 🛰️\n\n*域名:* \`${domain}\`\n*客户端:* \`${userAgentHeader}\`\n*IP 地址:* \`${clientIp} (${country})\`\n*请求格式:* \`${targetFormat}\``;

        if (profileIdentifier) {
            message += `\n*订阅组:* \`${subName}\``;
            const profile = allProfiles.find(p => (p.customId && p.customId === profileIdentifier) || p.id === profileIdentifier);
            if (profile && profile.expiresAt) {
                const expiryDateStr = new Date(profile.expiresAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
                message += `\n*到期时间:* \`${expiryDateStr}\``;
            }
        }

        context.waitUntil(sendTgNotification(config, message));
    }

    let prependedContentForSubconverter = '';

    if (isProfileExpired) { // Use the flag set earlier
        prependedContentForSubconverter = ''; // Expired node is now in targetSubs
    } else {
        // Otherwise, add traffic remaining info if applicable
        const totalRemainingBytes = targetSubs.reduce((acc, sub) => {
            if (sub.enabled && sub.userInfo && sub.userInfo.total > 0) {
                const used = (sub.userInfo.upload || 0) + (sub.userInfo.download || 0);
                const remaining = sub.userInfo.total - used;
                return acc + Math.max(0, remaining);
            }
            return acc;
        }, 0);
        if (totalRemainingBytes > 0) {
            const formattedTraffic = formatBytes(totalRemainingBytes);
            const fakeNodeName = `流量剩余 ≫ ${formattedTraffic}`;
            prependedContentForSubconverter = `trojan://00000000-0000-0000-0000-000000000000@127.0.0.1:443#${encodeURIComponent(fakeNodeName)}`;
        }
    }

    // 使用固定的 User-Agent 请求上游订阅，避免因客户端 UA 导致被屏蔽或返回错误格式
    const upstreamUserAgent = 'Clash for Windows/0.20.39';
    const combinedNodeList = await generateCombinedNodeList(context, config, upstreamUserAgent, targetSubs, prependedContentForSubconverter);

    if (targetFormat === 'base64') {
        let contentToEncode;
        if (isProfileExpired) {
            contentToEncode = DEFAULT_EXPIRED_NODE + '\n'; // Return the expired node link for base64 clients
        } else {
            contentToEncode = combinedNodeList;
        }
        const headers = { "Content-Type": "text/plain; charset=utf-8", 'Cache-Control': 'no-store, no-cache' };
        return new Response(btoa(unescape(encodeURIComponent(contentToEncode))), { headers });
    }

    const base64Content = btoa(unescape(encodeURIComponent(combinedNodeList)));

    const callbackToken = await getCallbackToken(env);
    const callbackPath = profileIdentifier ? `/${token}/${profileIdentifier}` : `/${token}`;
    const callbackUrl = `${url.protocol}//${url.host}${callbackPath}?target=base64&callback_token=${callbackToken}`;
    if (url.searchParams.get('callback_token') === callbackToken) {
        const headers = { "Content-Type": "text/plain; charset=utf-8", 'Cache-Control': 'no-store, no-cache' };
        return new Response(base64Content, { headers });
    }

    // 智能处理：如果用户填入了 http:// 或 https:// 前缀，自动去除，防止 URL 拼接错误
    let cleanSubConverter = effectiveSubConverter.replace(/^https?:\/\//, '').replace(/\/$/, '');
    const subconverterUrl = new URL(`https://${cleanSubConverter}/sub`);
    subconverterUrl.searchParams.set('target', targetFormat);

    // 针对 Clash Meta / Mihomo / Clash Verge 内核，添加 ver=meta 参数
    // 这能确保 Subconverter 输出兼容 Meta 内核的配置 (保留更多字段如 udp, skip-cert-verify, vless 等)
    const uaLow = userAgentHeader.toLowerCase();
    if (targetFormat === 'clash' && (
        uaLow.includes('mihomo') ||
        uaLow.includes('clash-verge') ||
        uaLow.includes('meta') ||
        uaLow.includes('flyclash')
    )) {
        subconverterUrl.searchParams.set('ver', 'meta');
    }

    subconverterUrl.searchParams.set('url', callbackUrl);
    if ((targetFormat === 'clash' || targetFormat === 'loon' || targetFormat === 'surge') && effectiveSubConfig && effectiveSubConfig.trim() !== '') {
        subconverterUrl.searchParams.set('config', effectiveSubConfig);
    }
    subconverterUrl.searchParams.set('new_name', 'true');

    try {
        const subconverterResponse = await fetch(subconverterUrl.toString(), {
            method: 'GET',
            headers: { 'User-Agent': 'Mozilla/5.0' },
        });
        if (!subconverterResponse.ok) {
            const errorBody = await subconverterResponse.text();
            throw new Error(`Subconverter service returned status: ${subconverterResponse.status}. Body: ${errorBody}`);
        }
        const responseText = await subconverterResponse.text();
        const responseHeaders = new Headers(subconverterResponse.headers);
        responseHeaders.set("Content-Disposition", `attachment; filename*=utf-8''${encodeURIComponent(subName)}`);

        // 优化：根据目标格式设置正确的Content-Type，确保客户端能正确识别和导入
        let contentType = 'text/plain; charset=utf-8';
        if (targetFormat === 'clash' || targetFormat === 'singbox' || targetFormat === 'surge' || targetFormat === 'loon') {
            // YAML格式使用application/x-yaml，确保客户端能正确识别
            contentType = 'application/x-yaml; charset=utf-8';
        } else if (targetFormat === 'base64') {
            contentType = 'text/plain; charset=utf-8';
        }
        responseHeaders.set('Content-Type', contentType);
        responseHeaders.set('Cache-Control', 'no-store, no-cache');

        return new Response(responseText, { status: subconverterResponse.status, statusText: subconverterResponse.statusText, headers: responseHeaders });
    } catch (error: any) {
        console.error(`[Sub-One Final Error] ${error.message}`);
        return new Response(`Error connecting to subconverter: ${error.message}`, { status: 502 });
    }
}

async function getCallbackToken(env) {
    const secret = env.ADMIN_PASSWORD || 'default-callback-secret';
    const encoder = new TextEncoder();
    const keyData = encoder.encode(secret);
    const cryptoKey = await crypto.subtle.importKey('raw', keyData, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const signature = await crypto.subtle.sign('HMAC', cryptoKey, encoder.encode('callback-static-data'));
    return Array.from(new Uint8Array(signature)).map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 16);
}


// --- [核心修改] Cloudflare Pages Functions 主入口 ---
export async function onRequest(context: EventContext<Env, any, any>) {
    const { request, env, next } = context;
    const url = new URL(request.url);

    // **核心修改：判斷是否為定時觸發**
    if (request.headers.get("cf-cron")) {
        return handleCronTrigger(env);
    }

    if (url.pathname.startsWith('/api/')) {
        const response = await handleApiRequest(request, env);
        return response;
    }
    const isStaticAsset = /^\/(assets|@vite|src)\/./.test(url.pathname) || /\.\w+$/.test(url.pathname);
    if (!isStaticAsset && url.pathname !== '/') {
        return handleSubRequest(context);
    }
    return next();
}
