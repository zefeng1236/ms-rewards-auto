// ==UserScript==
// @name         微软积分商城签到（改进版）-分离获取授权
// @namespace    https://geoisam.github.io
// @version      3.6.50
// @description  每天在后台自动完成 Microsoft Rewards 任务获取积分奖励，✅签入、✅阅读、✅活动、✅搜索
// @author       geoisam@qq.com
// @icon         data:image/png;base64,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
// @homepage     https://github.com/geoisam/FuckScripts
// @supportURL   https://github.com/geoisam/FuckScripts/issues
// @crontab      */20 * * * *
// @connect      bing.com
// @connect      login.live.com
// @connect      rewards.bing.com
// @connect      prod.rewardsplatform.microsoft.com
// @connect      hotapi.nntool.cc
// @connect      hot.baiwumm.com
// @connect      cnxiaobai.com
// @connect      disp-qryapi.3g.qq.com
// @connect      qyapi.weixin.qq.com
// @connect      oapi.dingtalk.com
// @connect      open.feishu.cn
// @connect      push.i-i.me
// @connect      api.day.app
// @match        https://login.live.com/*
// @include      https://login.live.com/*
// @match        https://rewards.bing.com/dashboard
// @run-at       document-end
// @noframes
// @all-frames
// @grant        unsafeWindow
// @grant        GM_xmlhttpRequest
// @grant        GM_notification
// @grant        GM_openInTab
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_cookie
// @grant        GM_info
// @grant        GM_log
// @storageName  FuckScripts_Shared_Auth
// @tips         此脚本一直为 开源免费 使用，如果你是从某些地方买的话，你就是被骗了
// ==/UserScript==

/* global GM_cookie, GM_getValue, GM_setValue, GM_xmlhttpRequest, GM_log, GM_info, GM_notification, GM_openInTab */

/* ==UserConfig==
Config:
    keep:
        title: 持续检测（关闭则所有任务完成后不再检测）
        type: checkbox
        default: true
    lock:
        title: 锁定国区（若当前 IP 非中国大陆地区则停止）
        type: checkbox
        default: true
    span:
        title: 搜索间隔（至少 30 秒即间隔 15-45 秒）
        type: number
        default: 30
        min: 30
        unit: ±15秒
    api:
        title: 搜索词接口（offline为随机搜索词）
        type: select
        default: hot.nntool.cc
        values: [offline, hot.nntool.cc, hot.baiwumm.com, hot.cnxiaobai.com]
    code:
        title: 授权码链接（请勿分享以免个人数据泄露）
        type: textarea
        description: https://login.live.com/oauth20_desktop.srf?code=M.C540_BAY.2.U.********-****-****-****-************&...
Tasks:
    sign:
        title: 签入（Authorization Code）
        type: checkbox
        default: true
    read:
        title: 阅读（Authorization Code）
        type: checkbox
        default: true
    promos:
        title: 活动（rewards.bing.com）
        type: checkbox
        default: true
    bonus:
        title: 每日额外积分（dashboard 按钮）
        type: checkbox
        default: true
    search:
        title: 搜索（www.bing.com）
        type: checkbox
        default: true
Notice:
    bro:
        title: 浏览器通知（当前脚本）
        type: checkbox
        default: true
    wework:
        title: 企业微信消息推送（群机器人）
        type: text
        password: true
        description: xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx
    dingding:
        title: 钉钉群机器人（不加签，关键词：#）
        type: text
        password: true
        description: xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
    feishu:
        title: 飞书群机器人（不加签，关键词：#）
        type: text
        password: true
        description: xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx
    pushme:
        title: PushMe（push.i-i.me）
        type: text
        password: true
        description: xxxxxxxxxxxxxxxxxxxx
    bark:
        title: Bark（bark.day.app）
        type: text
        password: true
        description: xxxxxxxxxxxxxxxxxxxx
==/UserConfig== */


if (typeof window !== 'undefined' && window.location && window.location.hostname === "login.live.com") {
    (function() {
        const setAuthCookie = function(code) {
            if (typeof GM_cookie !== 'undefined') {
                GM_cookie.set({
                    name: "microsoft_rewards_auth_code",
                    value: encodeURIComponent(code),
                    domain: ".live.com",
                    path: "/",
                    secure: true,
                    expirationDate: Date.now() / 1000 + 60
                });
            } else {
                const expiration = new Date();
                expiration.setTime(expiration.getTime() + 60 * 1000);
                document.cookie = "microsoft_rewards_auth_code=" + encodeURIComponent(code) + "; expires=" + expiration.toUTCString() + "; path=/; domain=.live.com";
            }
        };
        
        const checkAndCapture = function() {
            try {
                const urlParams = new URLSearchParams(window.location.search);
                const authCode = urlParams.get("code");
                
                if (authCode && authCode.length > 10) {
                    const fullCode = "https://login.live.com/oauth20_desktop.srf?code=" + authCode.trim();
                    GM_setValue("Config.code", fullCode);
                    GM_setValue("Config.token", false);
                    setAuthCookie(fullCode);
                    
                    if (GM_getValue("Notice.bro", true)) {
                        GM_notification({
                            text: "授权码获取成功！",
                            title: GM_info.script.name,
                            onclick: function() {}
                        });
                    }
                    
                    return true;
                }
            } catch (e) {}
            return false;
        };

        if (checkAndCapture()) {
            return;
        }

        window.addEventListener("hashchange", checkAndCapture);
        window.addEventListener("popstate", checkAndCapture);

        const checkInterval = setInterval(function() {
            if (checkAndCapture()) {
                clearInterval(checkInterval);
            }
        }, 300);

        setTimeout(function() {
            clearInterval(checkInterval);
        }, 60000);
    })();
    return;
}

const FuckD = {
    wh: [
        {
            name: "企业微信",
            url: "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=",
            key: GM_getValue("Notice.wework", false),
            msg: {
                "msgtype": "text",
                "text": {
                    get content() {
                        return `> ${FuckD.bing.datetimeLocaleStr}\n\n ## ${GM_info.script.name}\n ${FuckD.bing.sendMSG}`
                    }
                },
            },
            docs: "https://developer.work.weixin.qq.com/document/path/91770"
        },
        {
            name: "钉钉",
            url: "https://oapi.dingtalk.com/robot/send?access_token=",
            key: GM_getValue("Notice.dingding", false),
            msg: {
                "msgtype": "markdown",
                "markdown": {
                    "title": GM_info.script.name,
                    get text() {
                        return `> ${FuckD.bing.datetimeLocaleStr}\n ### ${GM_info.script.name}\n ${FuckD.bing.sendMSG}`
                    }
                },
            },
            docs: "https://open.dingtalk.com/document/orgapp/custom-robots-send-group-messages"
        },
        {
            name: "飞书",
            url: "https://open.feishu.cn/open-apis/bot/v2/hook/",
            key: GM_getValue("Notice.feishu", false),
            msg: {
                "msg_type": "interactive",
                "card": {
                    "schema": "2.0",
                    "header": {
                        "title": {
                            "tag": "plain_text",
                            "content": GM_info.script.name
                        },
                        "template": "orange"
                    },
                    "body": {
                        "elements": [{
                            "tag": "markdown",
                            "text_align": "center",
                            get content() {
                                return `#### ${FuckD.bing.datetimeLocaleStr}\n ${FuckD.bing.sendMSG}`
                            }
                        }]
                    }
                }
            },
            docs: "https://open.feishu.cn/document/client-docs/bot-v3/add-custom-bot"
        },
        {
            name: "PushMe",
            url: "https://push.i-i.me/?push_key=",
            key: GM_getValue("Notice.pushme", false),
            msg: {
                "type": "markdown",
                "title": `${GM_info.script.name}[#reawrds!https://rewards.bing.com/rewards.png]`,
                get content() {
                    return `\n ${FuckD.bing.sendMSG}`
                }
            },
            docs: "https://push.i-i.me/docs/index"
        },
        {
            name: "Bark",
            url: "https://api.day.app/",
            key: GM_getValue("Notice.bark", false),
            msg: {
                "group": "rewards",
                "icon": "https://rewards.bing.com/rewards.png",
                "title": GM_info.script.name,
                get markdown() {
                    return `\n ${FuckD.bing.sendMSG}`
                }
            },
            docs: "https://bark.day.app/#/tutorial"
        },
    ],
    ua: {
        pc: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36 Edg/123.0.2420.81",
        m: "Mozilla/5.0 (Linux; Android 16; MCE16 Build/BP3A.250905.014; ) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/123.0.0.0 Mobile Safari/537.36 EdgA/123.0.2420.102",
    },
    cookie: {
        bing: "",
    },
    api: {
        mode: GM_getValue("Config.api", "offline"),
        arr: [
            ["hot.baiwumm.com", {
                url: "https://hot.baiwumm.com/api/",
                hot: ["weibo", "douyin", "baidu", "toutiao", "thepaper", "qq", "netease", "zhihu"],
            }],
            ["hot.cnxiaobai.com", {
                url: "https://cnxiaobai.com/DailyHotApi/",
                hot: ["weibo", "douyin", "baidu", "toutiao", "thepaper", "qq-news", "netease-news", "zhihu"],
            }],
            ["hot.nntool.cc", {
                url: "https://hotapi.nntool.cc/",
                hot: ["weibo", "douyin", "baidu", "toutiao", "thepaper", "qq-news", "netease-news", "zhihu"],
            }],
        ],
    },
    tasks: {
        sign: GM_getValue("Tasks.sign", true),
        read: GM_getValue("Tasks.read", true),
        promos: GM_getValue("Tasks.promos", true),
        bonus: GM_getValue("Tasks.bonus", true),
        search: GM_getValue("Tasks.search", true),
    },
    bing: {
        region: "CN",
        status: GM_getValue("Config.lock", true),
        repo: "https://github.com/geoisam/FuckScripts/",
        time: 3210,
        span: GM_getValue("Config.span", 30),
        code: 0,
        token: false,
        error: 0,
        tasks: {
            get sign() {
                return FuckD.sign.date
            },
            get read() {
                return FuckD.read.date
            },
            get promos() {
                return FuckD.promos.date
            },
            get search() {
                return FuckD.search.date
            },
        },
        mainland: 1,
        end: 1,
    },
    sign: {
        times: 0,
        point: -1,
        end: 0,
    },
    read: {
        times: 0,
        point: 0,
        end: 0,
    },
    promos: {
        times: 0,
        token: 0,
        end: 0,
    },
    search: {
        device: "",
        word: {
            list: [],
            index: 0,
        },
        times: 0,
        progressNow: 0,
        pc: {
            progress: 0,
            max: 1,
        },
        m: {
            progress: 0,
            max: 1,
        },
        index: 0,
        end: 0,
    },
}

const FuckF = {
    getRandomNum(num) {
        return Math.floor(Math.random() * num)
    },
    getScopeRandomNum(min, max) {
        return Math.floor(Math.random() * (max + 1 - min) + min)
    },
    getRandomArr(arr) {
        return arr.sort(() => {
            return Math.random() - 0.5
        })
    },
    getRandomUUID(only = false) {
        const uuid = crypto.randomUUID()
        const sid = uuid.replace(/-/g, "").toUpperCase()
        return only ? sid : uuid
    },
    getTimestamp(start = 0, end = 13) {
        const timestamp = Date.now()
        const num = timestamp.toString().substring(start, end)
        return Number(num)
    },
    getDatetime(num = false, slash = true) {
        const today = new Date()
        const year = today.getFullYear()
        let month = today.getMonth() + 1
        let day = today.getDate()
        month = month < 10 ? "0" + month : month
        day = day < 10 ? "0" + day : day
        const dateNow = num ? Number(`${year}${month}${day}`) : slash ? `${month}/${day}/${year}` : `${year}-${month}-${day}`
        return dateNow
    },
    isJSON(s) {
        try {
            const j = JSON.parse(s)
            const p = Array.isArray(j) || (typeof j === "object" && j !== null)
            return p ? true : false
        } catch {
            return false
        }
    },
    log(title, text, push = false) {
        GM_log(title + text + "🔚")
        if (!GM_getValue("Notice.bro", true) || !push) return
        GM_notification({
            text: text,
            title: GM_info.script.name + title,
            onclick: () => {
                if (typeof push === 'string' && push.startsWith('http')) {
                    GM_openInTab(push, { active: true, insert: true, setParent: true });
                } else if (title.includes("🔵") || title.includes("🎉")) {
                    GM_openInTab("https://rewards.bing.com/earn", { active: true, insert: true, setParent: true });
                } else {
                    GM_openInTab("https://rewards.bing.com/dashboard", { active: true, insert: true, setParent: true });
                }
            },
        })
    },
    xhr(options, only = false) {
        return new Promise((resolve, reject) => {
            const start = FuckF.getTimestamp(); 
            try {
                GM_xmlhttpRequest({
                    ...options,
                    timeout: 15000,
                    ontimeout: () => {
                        const cost = (FuckF.getTimestamp() - start) / 1000;
                        reject(new Error(`请求超时！用时 ${cost} 秒`));
                    },
                    onload: (xhr) => {
                        const cost = (FuckF.getTimestamp() - start) / 1000;
                        if (xhr.status >= 200 && xhr.status < 300) { 
                            resolve(only ? xhr.finalUrl : xhr.responseText);
                            return;
                        }
                        const redirectStatuses = [301, 302, 307, 308];
                        if (redirectStatuses.includes(xhr.status)) {
                            const match = xhr.responseHeaders?.match(/Location:\s*(.*?)\s*\r?\n/i);
                            resolve(match ? match[1] : false);
                            return;
                        }
                        reject(new Error(`请求失败，用时 ${cost} 秒，状态码：${xhr.status}`));
                    },
                    onerror: (err) => {
                        const cost = (FuckF.getTimestamp() - start) / 1000;
                        let errDetail = "";
                        if (err) {
                            errDetail = err.error || err.statusText || (typeof err === "object" ? JSON.stringify(err) : err);
                        } else {
                            errDetail = "未知网络错误";
                        }
                        reject(new Error(`请求异常！用时 ${cost} 秒 🔛${errDetail}`));
                    },
                });
            } catch (e) {
                reject(e);
            }
        });
    },
}

FuckF.getRandomSubstring = (str, min = 20, max = 32) => {
    const length = str.length
    if (length <= min) {
        return str
    }
    const randomLength = FuckF.getScopeRandomNum(min, max)
    return str.substring(0, randomLength)
}

FuckF.getRandomApiHot = () => {
    const lastIndex = parseInt(GM_getValue("Config.index", -1))
    const filteredArr = FuckD.api.hot.filter((name, index) => index != lastIndex)
    const randomIndex = FuckF.getRandomNum(filteredArr.length)
    GM_setValue("Config.index", randomIndex)
    return filteredArr[randomIndex]
}

FuckF.getToken = async (url, maxRetries = 3) => {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            const result = await FuckF.xhr({ url: url });
            if (result && FuckF.isJSON(result)) {
                const res = JSON.parse(result);
                const refresh = res.refresh_token;
                const access = res.access_token;
                if (refresh && access) {
                    GM_setValue("Config.token", refresh);
                    FuckD.bing.token = access;
                    return true;
                }
            }
        } catch (e) {
            if (e.message.includes("400") || e.message.includes("401")) {
                return false; 
            }
            if (attempt < maxRetries) {
                await new Promise(resolve => setTimeout(resolve, 3210));
                continue;
            }
            FuckF.log("🔴", `Token 请求失败！🔛${e.message}`);
            return null;
        }
    }
    return null;
}

FuckF.renewToken = async () => {
    if (!FuckD.tasks.sign && !FuckD.tasks.read) return true;
    let refreshToken = GM_getValue("Config.token", false);
    const authUrl = "https://login.live.com/oauth20_authorize.srf?client_id=0000000040170455&response_type=code&scope=service::prod.rewardsplatform.microsoft.com::MBI_SSL&redirect_uri=https://login.live.com/oauth20_desktop.srf";
    
    const pollForAuthCodeFromWindow = (authWindow, maxSeconds) => {
        return new Promise((resolve) => {
            const startTime = Date.now();
            const checkInterval = setInterval(() => {
                try {
                    if (authWindow && !authWindow.closed) {
                        const currentUrl = authWindow.location.href;
                        if (currentUrl && currentUrl.includes("code=")) {
                            const urlParams = new URLSearchParams(new URL(currentUrl).search);
                            const authCode = urlParams.get("code");
                            if (authCode && authCode.length > 10) {
                                clearInterval(checkInterval);
                                const fullCode = `https://login.live.com/oauth20_desktop.srf?code=${authCode.trim()}`;
                                GM_setValue("Config.code", fullCode);
                                GM_setValue("Config.token", false);
                                FuckF.log("🟢", "通过子窗口检测到授权码");
                                resolve(authCode.match(/M\.[^&]+/));
                                return;
                            }
                        }
                    }
                } catch (e) {}
                
                if (Date.now() - startTime >= maxSeconds * 1000) {
                    clearInterval(checkInterval);
                    resolve(null);
                }
            }, 300);
        });
    };
    
    const pollForAuthCodeViaRequest = (maxSeconds) => {
        return new Promise((resolve) => {
            const startTime = Date.now();
            const checkInterval = setInterval(() => {
                GM_xmlhttpRequest({
                    method: "GET",
                    url: "https://login.live.com/oauth20_desktop.srf",
                    onload: function(response) {
                        if (response.responseText) {
                            const match = response.responseText.match(/code=([^&"]+)/);
                            if (match && match[1] && match[1].length > 10) {
                                clearInterval(checkInterval);
                                const fullCode = `https://login.live.com/oauth20_desktop.srf?code=${match[1].trim()}`;
                                GM_setValue("Config.code", fullCode);
                                GM_setValue("Config.token", false);
                                FuckF.log("🟢", "通过GM_xmlhttpRequest检测到授权码");
                                resolve(match[1].match(/M\.[^&]+/));
                                return;
                            }
                        }
                    },
                    onerror: function() {}
                });
                
                if (Date.now() - startTime >= maxSeconds * 1000) {
                    clearInterval(checkInterval);
                    resolve(null);
                }
            }, 1000);
        });
    };
    
    const getAuthCodeFromCookie = function() {
        return new Promise((resolve) => {
            if (typeof GM_cookie !== 'undefined') {
                GM_cookie.get("microsoft_rewards_auth_code", (cookie) => {
                    if (cookie && cookie.value) {
                        resolve(decodeURIComponent(cookie.value));
                    } else {
                        resolve(null);
                    }
                });
            } else if (typeof document !== 'undefined') {
                const value = "; " + document.cookie;
                const parts = value.split("; microsoft_rewards_auth_code=");
                if (parts.length === 2) {
                    resolve(decodeURIComponent(parts.pop().split(";").shift()));
                } else {
                    resolve(null);
                }
            } else {
                resolve(null);
            }
        });
    };
    
    const pollForAuthCode = async (maxSeconds) => {
        const startTime = Date.now();
        while (Date.now() - startTime < maxSeconds * 1000) {
            await new Promise(r => setTimeout(r, 300));
            
            let code = GM_getValue("Config.code", "");
            if (!code) {
                const cookieCode = await getAuthCodeFromCookie();
                if (cookieCode) {
                    code = cookieCode;
                    GM_setValue("Config.code", code);
                    GM_setValue("Config.token", false);
                }
            }
            
            const codeMatch = code ? code.match(/M\.[^&]+/) : null;
            if (codeMatch) {
                return codeMatch;
            }
        }
        return null;
    };
    
    const fetchCodeLogic = async (msg) => {
        GM_setValue("Config.code", ""); 
        FuckF.log("🟡", `${msg}，正在打开授权页面...`);
        
        let authWindow = null;
        if (typeof window !== 'undefined' && window.open) {
            authWindow = window.open(authUrl, '_blank', 'width=600,height=600');
        } else {
            GM_openInTab(authUrl, { active: true, insert: true, setParent: true });
        }
        
        await new Promise(resolve => setTimeout(resolve, 2000));
        FuckF.log("🟡", `请在打开的页面中完成登录授权，等待授权码...`);
        
        FuckF.log("🟡", `等待授权码...请在打开的授权页面中完成登录`);
        let codeMatch = await pollForAuthCode(120);
        if (codeMatch) {
            FuckF.log("🟢", "授权码获取成功"); 
            return codeMatch;
        }
        
        FuckD.bing.sendMSG = `${msg}，自动获取授权码超时，请手动复制授权页面URL后点击脚本菜单的"粘贴授权码"选项`;
        FuckF.log("🟡", FuckD.bing.sendMSG, authUrl); 
        FuckF.send(FuckD.wh);
        
        codeMatch = await pollForAuthCode(120);
        if (codeMatch) {
            FuckF.log("🟢", "授权码手动获取成功");
            return codeMatch;
        }
        
        FuckD.tasks.sign = false;
        FuckD.tasks.read = false;
        return false;
    };
    if (!refreshToken) {
        let code = GM_getValue("Config.code", "");
        let codeMatch = code ? code.match(/M\.[^&]+/) : null;   
        if (!codeMatch) {
            codeMatch = await fetchCodeLogic("检测到授权码为空");
            if (!codeMatch) return false;
        }
        const url = `https://login.live.com/oauth20_token.srf?client_id=0000000040170455&code=${encodeURIComponent(codeMatch[0])}&redirect_uri=https://login.live.com/oauth20_desktop.srf&grant_type=authorization_code`;
        const token = await FuckF.getToken(url);
        if (token === null) return false; 
        if (!token) {
            codeMatch = await fetchCodeLogic("检测到授权码失效");
            if (!codeMatch) return false;
            return await FuckF.renewToken(); 
        }
        FuckD.bing.sendMSG = "Token 获取成功！";
        FuckF.log("🟢", FuckD.bing.sendMSG, true);
        FuckF.send(FuckD.wh);
        return true;
    } else {
        const url = `https://login.live.com/oauth20_token.srf?client_id=0000000040170455&refresh_token=${encodeURIComponent(refreshToken)}&scope=service::prod.rewardsplatform.microsoft.com::MBI_SSL&grant_type=REFRESH_TOKEN`;
        const token = await FuckF.getToken(url);
        if (token === null) return false;
        if (!token) {
            GM_setValue("Config.token", false);
            GM_setValue("Config.code", ""); 
            const codeMatch = await fetchCodeLogic("检测到 Token 失效");
            if (!codeMatch) return false;
            return await FuckF.renewToken();
        }
        return true;
    }
}

FuckF.getRewardsInfo = async (maxRetries = 3) => {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            const earnHtml = await FuckF.xhr({ url: "https://rewards.bing.com/earn" });
            const cleanHtml = earnHtml.replace(/\\"/g, '"');
            const balMatch = cleanHtml.match(/"balance":(\d+)/) || cleanHtml.match(/"availablePoints":(\d+)/);
            const keyword = '"pointsCounters":{';
            const idx = cleanHtml.indexOf(keyword);
            if (!balMatch || idx === -1) {
                if (attempt < maxRetries) {
                    await new Promise(resolve => setTimeout(resolve, 3210));
                    continue;
                }
                return false;
            }
            let balance = parseInt(balMatch[1]);
            let pcMax = 60, pcCur = 0;
            let mobMax = 0, mobCur = 0;
            let dailyPoint = 0;
            let todayTotal = 0; 
            let start = idx + 17; 
            let openBraces = 0;
            let end = start;
            for (let i = start; i < cleanHtml.length; i++) {
                if (cleanHtml[i] === '{') openBraces++;
                if (cleanHtml[i] === '}') {
                    openBraces--;
                    if (openBraces === 0) {
                        end = i + 1;
                        break;
                    }
                }
            }
            try {
                const pts = JSON.parse(cleanHtml.substring(start, end));
                pcMax = pts.pc?.max ?? 60;
                pcCur = pts.pc?.progress ?? 0;
                mobMax = pts.mobile?.max ?? 0;
                mobCur = pts.mobile?.progress ?? 0;
                dailyPoint = pts.dailyOffer ?? 0;
                todayTotal = pts.totalPoints ?? 0; 
            } catch {
                FuckF.log("🟡", "仪表盘解析异常，将使用保底数值");
            }
            FuckD.bing.todayTotalPoints = todayTotal; 
            return {
                userStatus: {
                    availablePoints: balance,
                    counters: {
                        pcSearch: [{ pointProgress: pcCur, pointProgressMax: pcMax }],
                        mobileSearch: [{ pointProgress: mobCur, pointProgressMax: mobMax }],
                        dailyPoint: [{ pointProgress: dailyPoint }]
                    }
                }
            };
        } catch (e) {
            if (attempt < maxRetries) {
                await new Promise(resolve => setTimeout(resolve, 3210));
                continue;
            }
            FuckF.log("🔴", `仪表盘请求失败！🔛 ${e.message}`);
        }
    }
    return false;
}

FuckF.taskSign = async () => {
    if (!FuckD.tasks.sign || FuckD.sign.date == FuckD.bing.dateNowNum || FuckD.sign.times > 2 || FuckD.sign.end > 0) {
        FuckD.sign.end++
        return true
    }
    if (FuckD.sign.point >= 0) {
        FuckD.sign.end++
        if (FuckD.sign.date != FuckD.bing.dateNowNum) {
            FuckD.sign.date = FuckD.bing.dateNowNum
            FuckD.bing.sendMSG = `📅签入任务已完成！\n${FuckD.sign.point > 0 ? `✨今日签入奖励：${FuckD.sign.point}` : "🍵今日已签入，无法二次签入"}`
            FuckF.log("🔵", FuckD.bing.sendMSG, true)
            FuckF.send(FuckD.wh)
        }
        GM_setValue("Config.tasks", FuckD.bing.tasks)
        return true
    }
    try {
        const envStatus = await FuckF.mainlandCheck();
        if (envStatus === 1) {
            FuckD.bing.code = -1;
            return true;
        } 
        const region = FuckD.bing.status ? "cn" : FuckD.bing.region.toLowerCase()
        const result = await FuckF.xhr({
            method: "POST",
            url: "https://prod.rewardsplatform.microsoft.com/dapi/me/activities",
            headers: {
                "content-type": "application/json; charset=UTF-8",
                "user-agent": FuckD.ua.m,
                "authorization": `Bearer ${FuckD.bing.token}`,
                "x-rewards-appid": "SAAndroid/31.4.2110003555",
                "x-rewards-ismobile": "true",
                "x-rewards-country": region,
                "x-rewards-partnerid": "startapp",
                "x-rewards-flights": "rwgobig",
            },
            data: JSON.stringify({
                "amount": 1,
                "attributes": {},
                "id": FuckF.getRandomUUID(),
                "type": 103,
                "country": region,
                "risk_context": {},
                "channel": "SAAndroid",
            }),
        })
        if (result && FuckF.isJSON(result)) {
            FuckD.sign.times = 0
            const res = JSON.parse(result)
            const point = res.response.activity.p
            FuckD.sign.point = point || 0;
            GM_setValue("Config.signPoint", FuckD.sign.point);
        } else {
            FuckD.sign.times++
        }
    } catch (e) {
        FuckF.log("🔴", `签入任务出错！🔛${e.message}`)
        FuckD.sign.times++;
    }
    return false
}

FuckF.getReadPro = async () => {
    try {
        const result = await FuckF.xhr({
            url: "https://prod.rewardsplatform.microsoft.com/dapi/me?channel=SAAndroid&options=613",
            headers: {
                "content-type": "application/json; charset=UTF-8",
                "user-agent": FuckD.ua.m,
                "authorization": `Bearer ${FuckD.bing.token}`,
                "x-rewards-appid": "SAAndroid/31.4.2110003555",
                "x-rewards-ismobile": "true",
            },
        });
        if (result && FuckF.isJSON(result)) {
            const res = JSON.parse(result);
            const promos = res.response?.promotions || [];
            const readTask = promos.find(x => x.attributes?.offerid === 'ENUS_readarticle3_30points');
            if (readTask) {
                const progress = parseInt(readTask.attributes.progress) || 0;
                const max = parseInt(readTask.attributes.max) || 30;
                return { progress, max }; 
            }
        }
    } catch (e) {
        FuckF.log("🔴", `阅读进度获取出错！🔛${e.message}`);
    }
    return false;
}

FuckF.taskRead = async () => {
    if (!FuckD.tasks.read || FuckD.read.times > 2 || FuckD.read.end > 0) {
        FuckD.read.end++;
        return true;
    }
    try {
        const readPro = await FuckF.getReadPro();
        if (!readPro) {
            FuckD.read.times++
            return false; 
        }
        let cur = readPro.progress || 0;
        let max = readPro.max || 30;
        if (FuckD.read.date != FuckD.bing.dateNowNum) {
            FuckF.log("📖", `阅读进度获取成功：${cur}/${max}`);
            await new Promise(resolve => setTimeout(resolve, 500));
        }
        if (cur >= max) {
            if (FuckD.read.date != FuckD.bing.dateNowNum) {
                FuckF.log("📖", "接口返回进度已满，但本地无今日记录，强制开始阅读...");
                cur = 0;
                max = 30; 
            } else {
                FuckD.read.end++;
                return true;
            }
        }
        const envStatus = await FuckF.mainlandCheck();
        if (envStatus === 1) {
            FuckD.bing.code = -1;
            return true;
        } 
        const region = FuckD.bing.status ? "cn" : FuckD.bing.region.toLowerCase();
        FuckD.read.date = 0;
        const readsNeeded = Math.ceil((max - cur) / 3);
        for (let i = 0; i < readsNeeded; i++) {
            await FuckF.xhr({
                method: "POST",
                url: "https://prod.rewardsplatform.microsoft.com/dapi/me/activities",
                headers: {
                    "content-type": "application/json; charset=UTF-8",
                    "user-agent": FuckD.ua.m,
                    "authorization": `Bearer ${FuckD.bing.token}`,
                    "x-rewards-appid": "SAAndroid/31.4.2110003555",
                    "x-rewards-ismobile": "true",
                    "x-rewards-country": region,
                },
                data: JSON.stringify({
                    "amount": 1,
                    "country": region,
                    "id": FuckF.getRandomUUID(),
                    "type": 101,
                    "attributes": {
                        "offerid": "ENUS_readarticle3_30points",
                    },
                }),
            });
            FuckF.log("📖", `正在阅读第 ${i + 1}/${readsNeeded} 篇文章...`);
            const waitTime = FuckF.getScopeRandomNum(3000, 7000);
            await new Promise(resolve => setTimeout(resolve, waitTime));
        }
        FuckD.read.end++;
        if (FuckD.read.date != FuckD.bing.dateNowNum) {
            FuckD.read.date = FuckD.bing.dateNowNum;
            GM_setValue("Config.tasks", FuckD.bing.tasks);
            const actualCur = cur + (readsNeeded * 3);
            const finalCur = actualCur > max ? max : actualCur;
            GM_setValue("Config.readPoint", finalCur);
            FuckD.bing.sendMSG = `📖阅读任务已完成！\n✨今日阅读奖励：${finalCur}/${max}`;
            FuckF.log("🔵", FuckD.bing.sendMSG, true);
            FuckF.send(FuckD.wh);
        }
        return true;
    } catch (e) {
        FuckF.log("🔴", `阅读任务出错！🔛${e.message}`);
        FuckD.read.times++;
        return false;
    }
}

// ---- 稳健提取数组（括号配平，不依赖固定锚点如 "discovery"）----
FuckF.extractArrayAfterKey = function(html, key) {
    const marker = '"' + key + '":';
    const idx = html.indexOf(marker);
    if (idx === -1) return null;
    let i = html.indexOf('[', idx);
    if (i === -1) return null;
    let depth = 0, inStr = false, esc = false;
    for (let j = i; j < html.length; j++) {
        const c = html[j];
        if (inStr) {
            if (esc) esc = false;
            else if (c === '\\') esc = true;
            else if (c === '"') inStr = false;
        } else {
            if (c === '"') inStr = true;
            else if (c === '[') depth++;
            else if (c === ']') { depth--; if (depth === 0) return html.slice(i, j + 1); }
        }
    }
    return null;
};

// ---- 日期归一化为 YYYYMMDD，解析失败返回 null ----
FuckF.normalizeDate = function(d) {
    if (d == null) return null;
    let m = String(d).match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);          // M/D/YYYY 或 MM/DD/YYYY
    if (m) return Number(m[3] + String(m[1]).padStart(2, '0') + String(m[2]).padStart(2, '0'));
    m = String(d).match(/(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);            // YYYY-M-D 或 YYYY/MM/DD
    if (m) return Number(m[1] + String(m[2]).padStart(2, '0') + String(m[3]).padStart(2, '0'));
    const t = Date.parse(d);
    if (!isNaN(t)) { const dt = new Date(t); return Number(dt.getFullYear() + String(dt.getMonth()+1).padStart(2, '0') + String(dt.getDate()).padStart(2, '0')); }
    return null;
};

// ---- 新功能：每日额外积分（仅当 dashboard 页面打开时，按 XPath 点击按钮）----
FuckF.claimExtraPoints = async () => {
    if (!FuckD.tasks.bonus) return;
    const todayNum = FuckF.getDatetime(true);
    if (GM_getValue("Config.bonusDate", 0) == todayNum) {
        GM_log("每日额外积分今日已领取，跳过");
        return;
    }
    const xpath = "/html/body/div[2]/div[2]/div/main/div/button[2]/div/div";
    const findBtn = () => {
        let btn = null;
        try {
            btn = document.evaluate(xpath, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue;
        } catch (e) {}
        if (btn && btn.offsetParent !== null) return btn;          // 仅当按钮可见才点击
        const fallbacks = ["main button", "div[class*='bonus'] button", "button[class*='reward']"];
        for (const sel of fallbacks) {
            const els = document.querySelectorAll(sel);
            for (const el of els) {
                const txt = (el.innerText || el.textContent || "").replace(/\s/g, "");
                if (/额外/.test(txt)) return el;   // 仅匹配含"额外"的按钮，避免误点页面其它"积分"按钮
            }
        }
        return null;
    };
    let tries = 0;
    const tick = () => {
        const btn = findBtn();
        if (btn) {
            btn.click();
            GM_setValue("Config.bonusDate", todayNum);
            FuckF.log("🎁", "已点击每日额外积分按钮");
            return;
        }
        if (tries++ < 40) setTimeout(tick, 1000);
        else FuckF.log("🟡", "未找到每日额外积分按钮（XPath 可能已变更），请反馈页面结构");
    };
    tick();
};

FuckF.taskPromos = async () => {
    if (!FuckD.tasks.promos || FuckD.promos.times > 2 || FuckD.promos.end > 0 || (!GM_getValue("Config.keep", true) && FuckD.promos.date == FuckD.bing.dateNowNum)) {
        FuckD.promos.end++;
        return true;
    }
    let promosArr = [];
    let seenIds = new Set();
    let dashPoints = 0, dashMax = 0;
    let earnPoints = 0, earnMax = 0;
    try {
        const dashHtml = await FuckF.xhr({ url: "https://rewards.bing.com/dashboard" });
        const cleanDash = dashHtml.replace(/\\"/g, '"');
        const todayNum = FuckD.bing.dateNowNum;
        let dailySetItems = [];
        const dashRaw = FuckF.extractArrayAfterKey(cleanDash, "dailySetItems");
        if (dashRaw) {
            try { dailySetItems = JSON.parse(dashRaw.replace(/\\"/g, '"')); }
            catch (e) { FuckF.log("🟡", `dailySetItems 解析失败，尝试兼容旧写法🔛${e.message}`); }
        }
        if (!dailySetItems.length) {
            // 兜底：兼容旧版带 "discovery" 锚点的写法
            const legacy = cleanDash.match(/"dailySetItems":(\[.*?\]),"discovery"/);
            if (legacy && legacy[1]) { try { dailySetItems = JSON.parse(legacy[1].replace(/\\"/g, '"')); } catch (e) {} }
        }
        if (dailySetItems.length) {
            FuckF.log("🧩", `dashboard 解析到 ${dailySetItems.length} 个每日设置项`);
        }
        for (const item of dailySetItems) {
            if (item.points === 0 || seenIds.has(item.offerId)) continue;
            const itemDate = FuckF.normalizeDate(item.date);
            if (itemDate !== null && itemDate !== todayNum) continue;   // 解析不出日期则不跳过，避免误杀今日活动
            seenIds.add(item.offerId);
            dashMax += item.points;
            if (item.isCompleted) {
                dashPoints += item.points;
            } else {
                promosArr.push({ 
                    id: item.offerId, 
                    hash: item.hash, 
                    url: "https://rewards.bing.com/dashboard", 
                    points: item.points,
                    type: "dash"
                });
            }
        }
        const earnHtml = await FuckF.xhr({ url: "https://rewards.bing.com/earn" });
        const cleanEarn = earnHtml.replace(/\\"/g, '"');
        if (cleanEarn.includes('"activityCards":[')) {
            const daysEn = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
            const todayDayEn = daysEn[new Date().getDay()];
            const taskRegex = /"isCompleted":(true|false).*?"points":(\d+).*?"offerId":"([^"]+)","hash":"([^"]+)"/g;
            let match;
            while ((match = taskRegex.exec(cleanEarn)) !== null) {
                const isCompleted = match[1] === "true";
                const points = parseInt(match[2]);
                const offerId = match[3];
                const hash = match[4];
                if (points === 0 || seenIds.has(offerId)) continue;
                if (isCompleted) {
                    if (offerId.includes("Evergreen") && !offerId.includes(todayDayEn)) continue;
                    const dateMatch = offerId.match(/(20\d{6})/);
                    if (dateMatch && dateMatch[1] !== FuckD.bing.dateNowNum.toString()) continue;
                    if (/(w[1-5]|week|month)/i.test(offerId) || /(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\d{2}/i.test(offerId)) continue;
                }
                seenIds.add(offerId);
                earnMax += points;
                if (isCompleted) {
                    earnPoints += points;
                } else {
                    promosArr.push({ 
                        id: offerId, 
                        hash: hash, 
                        url: "https://rewards.bing.com/earn", 
                        points: points,
                        type: "earn"
                    });
                }
            }
        }
    } catch (e) {
        FuckF.log("🔴", `活动解析出错！🔛${e.message}`);
    }
    const todayPromosSaved = FuckD.promos.date == FuckD.bing.dateNowNum ? GM_getValue("Config.promosPoint", 0) : 0;
    GM_setValue("Config.promosPoint", Math.max(todayPromosSaved, dashPoints + earnPoints));
    const dashTasks = promosArr.filter(i => i.type === 'dash').length;
    const earnTasks = promosArr.filter(i => i.type === 'earn').length;
    const totalNewTasks = dashTasks + earnTasks;
    if (totalNewTasks < 1) {
        FuckD.promos.end++;
        if (FuckD.promos.date != FuckD.bing.dateNowNum) {
            FuckD.promos.date = FuckD.bing.dateNowNum;
            GM_setValue("Config.tasks", FuckD.bing.tasks);
            const dashReport = dashMax > 0 ? `\n📱手机端活动：${dashPoints}/${dashMax}` : "";
            const earnReport = earnMax > 0 ? `\n💻电脑端活动：${earnPoints}/${earnMax}` : "";
            FuckD.bing.sendMSG = `🧩活动任务已完成！${dashReport}${earnReport}`;
            FuckF.log("🔵", FuckD.bing.sendMSG, true);
            FuckF.send(FuckD.wh);
        }
        return true;
    }
    try {
        const envStatus = await FuckF.mainlandCheck();
        if (envStatus === 1) {
            FuckD.bing.code = -1;
            return true;
        } 
        FuckD.promos.date = 0;
        const taskMsgs = [];
        if (dashTasks > 0) taskMsgs.push(`${dashTasks}个手机端活动`);
        if (earnTasks > 0) taskMsgs.push(`${earnTasks}个电脑端活动`);
        FuckF.log("🧩", `检测到有${taskMsgs.join("、")}未完成，开始执行...`);
        await new Promise(resolve => setTimeout(resolve, 500));
        let dashCurrent = 1;
        let earnCurrent = 1;
        for (const item of promosArr) {
            if (item.type === 'dash') {
                FuckF.log("📱", `正在执行第${dashCurrent}/${dashTasks}个手机端活动...`);
                dashCurrent++;
            } else {
                FuckF.log("💻", `正在执行第${earnCurrent}/${earnTasks}个电脑端活动...`);
                earnCurrent++;
            }
            const reqHeaders = {
                "content-type": "text/plain;charset=UTF-8",
                "next-action": "707e6eb15bdfdd5fba193f0a77e934f7018faf87ce",
                "referer": item.url,
            };
            if (item.type === 'dash') {
                reqHeaders["next-router-state-tree"] = "%5B%22%22%2C%7B%22children%22%3A%5B%22(nav)%22%2C%7B%22children%22%3A%5B%22dashboard%22%2C%7B%22children%22%3A%5B%22__PAGE__%22%2C%7B%7D%2Cnull%2Cnull%5D%7D%2Cnull%2Cnull%5D%7D%2Cnull%2Cnull%5D%7D%2Cnull%2Cnull%2Ctrue%5D";
            }
            await FuckF.xhr({
                method: "POST",
                url: item.url,
                headers: reqHeaders,
                data: JSON.stringify([
                    item.hash,
                    11,
                    { "offerid": item.id, "isPromotional": "$undefined", "timezoneOffset": "-480" }
                ]),
            });
            if (item.type === 'dash') {
                dashPoints += item.points;
            } else {
                earnPoints += item.points;
            }
            GM_setValue("Config.promosPoint", Math.max(todayPromosSaved, dashPoints + earnPoints));
            if (dashCurrent - 1 + earnCurrent - 1 < totalNewTasks) {
                await new Promise(resolve => setTimeout(resolve, FuckF.getScopeRandomNum(2000, 4000)));
            }
        }
        if (dashTasks > 0) {
            try {
                const reHtml = await FuckF.xhr({ url: "https://rewards.bing.com/dashboard" });
                const reClean = reHtml.replace(/\\"/g, '"');
                const reRaw = FuckF.extractArrayAfterKey(reClean, "dailySetItems");
                if (reRaw) {
                    const reItems = JSON.parse(reRaw.replace(/\\"/g, '"'));
                    const stillOpen = reItems.filter(x => !x.isCompleted && (x.points > 0) && (FuckF.normalizeDate(x.date) === todayNum)).length;
                    if (stillOpen > 0) FuckF.log("🟡", `回查发现仍有 ${stillOpen} 个每日活动未完成，可能 next-action 已失效，请到仓库反馈`);
                }
            } catch (e) {}
        }
        FuckD.promos.end++;
        if (FuckD.promos.date != FuckD.bing.dateNowNum) {
            FuckD.promos.date = FuckD.bing.dateNowNum;
            GM_setValue("Config.tasks", FuckD.bing.tasks);
            const dashReport = dashMax > 0 ? `\n📱手机端活动：${dashPoints}/${dashMax}` : "";
            const earnReport = earnMax > 0 ? `\n💻电脑端活动：${earnPoints}/${earnMax}` : "";
            FuckD.bing.sendMSG = `🧩活动任务已完成！${dashReport}${earnReport}`;
            FuckF.log("🔵", FuckD.bing.sendMSG, true);
            FuckF.send(FuckD.wh);
        }
        return true;
    } catch (e) {
        FuckF.log("🔴", `活动交卷出错！🔛${e.message}`);
    }
    FuckD.promos.times++;
    return false;
}

FuckF.getQueryWord = async () => {
    const keywords = ["天气预报", "今日新闻", "体育赛事", "股票行情", "电影推荐", "科技资讯", "美食食谱", "旅游攻略", "历史上的今天", "健康常识"];
    const baseWord = keywords[FuckF.getRandomNum(keywords.length)];
    const randomSuffix = Math.random().toString(36).slice(2, 6);
    let sentence = `${baseWord} ${randomSuffix}`;
    if (FuckD.api.mode != "offline") {
        if (FuckD.search.word.index < 1 || FuckD.search.word.list.length < 1) {
            const apiHot = FuckF.getRandomApiHot()
            try {
                const result = await FuckF.xhr({ url: FuckD.api.url + apiHot })
                if (result && FuckF.isJSON(result)) {
                    const res = JSON.parse(result)
                    if (res.code == 200) {
                        FuckD.search.word.index = 1
                        for (let i = 0; i < res.data.length; i++) {
                            FuckD.search.word.list.push(res.data[i].title)
                        }
                        FuckD.search.word.list = FuckF.getRandomArr(FuckD.search.word.list)
                        sentence = FuckD.search.word.list[FuckD.search.word.index]
                        sentence = FuckF.getRandomSubstring(sentence)
                        return sentence
                    }
                }
            } catch (e) {
                FuckF.log("🔴", `搜索词获取出错！🔛${e.message}`)
            }
        } else {
            FuckD.search.word.index++
            if (FuckD.search.word.index > FuckD.search.word.list.length - 1) {
                FuckD.search.word.index = 0
            }
            sentence = FuckD.search.word.list[FuckD.search.word.index]
            sentence = FuckF.getRandomSubstring(sentence)
            return sentence
        }
        FuckF.log("🟡", "搜索词接口异常，已临时使用随机搜索词")
    }
    return sentence
}

FuckF.taskSearch = async () => {
    if (!FuckD.tasks.search || FuckD.search.end > 0 || (!GM_getValue("Config.keep", true) && FuckD.search.date == FuckD.bing.dateNowNum)) {
        FuckD.search.end++;
        return true;
    }
    if (FuckD.search.index === 0) {
        const dashboard = await FuckF.getRewardsInfo();
        if (!dashboard) {
            return false; 
        }
        const searchInfo = dashboard.userStatus?.counters || {};
        FuckD.search.pc.progress = searchInfo.pcSearch?.[0]?.pointProgress || 0;
        let pcMax = searchInfo.pcSearch?.[0]?.pointProgressMax || 0;
        if (pcMax === 0) pcMax = 60;
        FuckD.search.pc.max = pcMax;
        FuckD.search.m.progress = searchInfo.mobileSearch?.[0]?.pointProgress || 0;
        let mMax = searchInfo.mobileSearch?.[0]?.pointProgressMax || 0;
        if (mMax === 0) mMax = 0;
        FuckD.search.m.max = mMax;
        const currentTotalSearch = FuckD.search.pc.progress + FuckD.search.m.progress;
        const lastTotalSearch = GM_getValue("Config.lastSearchProgress", -1);
        let restrictedTimes = GM_getValue("Config.restrictedTimes", 0);
        if (lastTotalSearch !== -1) {
            if (currentTotalSearch === lastTotalSearch && currentTotalSearch < (pcMax + mMax)) {
                restrictedTimes++;
            } else {
                restrictedTimes = 0; 
            }
        }
        GM_setValue("Config.lastSearchProgress", currentTotalSearch);
        GM_setValue("Config.restrictedTimes", restrictedTimes);
        if (restrictedTimes >= 2) {
            FuckD.search.end++;
            GM_setValue("Config.lastSearchProgress", -1); 
            GM_setValue("Config.restrictedTimes", 0);
            const pcReport = FuckD.search.pc.max > 0 ? `\n💻电脑端搜索：${FuckD.search.pc.progress}/${FuckD.search.pc.max}` : "";
            const mReport = FuckD.search.m.max > 0 ? `\n📱手机端搜索：${FuckD.search.m.progress}/${FuckD.search.m.max}` : "";
            FuckD.bing.sendMSG = `⚠️积分收入受限或账号异常，已中断今日搜索！${pcReport}${mReport}`;
            FuckF.log("🔴", FuckD.bing.sendMSG, true);
            FuckF.send(FuckD.wh);
            return true;
        }
    }
    if (FuckD.search.pc.progress >= FuckD.search.pc.max && FuckD.search.m.progress >= FuckD.search.m.max) {
        await new Promise(resolve => setTimeout(resolve, 3210)); 
        const dashboard = await FuckF.getRewardsInfo();
        if (dashboard) {
            const searchInfo = dashboard.userStatus?.counters || {};
            const realPcPro = searchInfo.pcSearch?.[0]?.pointProgress || 0;
            const realMPro = searchInfo.mobileSearch?.[0]?.pointProgress || 0;
            if (realPcPro >= FuckD.search.pc.max && realMPro >= FuckD.search.m.max) {
                FuckD.search.end++;
                if (FuckD.search.date != FuckD.bing.dateNowNum) {
                    FuckD.search.date = FuckD.bing.dateNowNum;
                    GM_setValue("Config.tasks", FuckD.bing.tasks);
                    GM_setValue("Config.lastSearchProgress", -1);
                    GM_setValue("Config.restrictedTimes", 0);
                    const pcReport = FuckD.search.pc.max > 0 ? `\n💻电脑端搜索：${realPcPro}/${FuckD.search.pc.max}` : "";
                    const mReport = FuckD.search.m.max > 0 ? `\n📱手机端搜索：${realMPro}/${FuckD.search.m.max}` : "";
                    FuckD.bing.sendMSG = `🔍搜索任务已完成！${pcReport}${mReport}`;
                    FuckF.log("🔵", FuckD.bing.sendMSG, true);
                    FuckF.send(FuckD.wh);
                }
                return true;
            } else {
                FuckD.search.pc.progress = realPcPro;
                FuckD.search.m.progress = realMPro;
                FuckF.log("🔍", `检测到搜索数据延迟或漏分，开始补搜...`);
            }
        } else {
            FuckD.search.end++;
            return true;
        }
    }
    if (FuckD.search.index >= FuckD.search.limit) {
        FuckD.search.end++;
        const pcReport = FuckD.search.pc.max > 0 ? `\n💻电脑端搜索：${FuckD.search.pc.progress}/${FuckD.search.pc.max}` : "";
        const mReport = FuckD.search.m.max > 0 ? `\n📱手机端搜索：${FuckD.search.m.progress}/${FuckD.search.m.max}` : "";
        FuckD.bing.sendMSG = `本轮运行正常，共搜索 ${FuckD.search.index} 次！${pcReport}${mReport}`;
        FuckF.log("🔍", FuckD.bing.sendMSG);
        FuckF.send(FuckD.wh);
        return true;
    }
    FuckD.search.date = 0;
    let query, params, pcorm, headers, regionMKT = "";
    if (FuckD.search.pc.progress < FuckD.search.pc.max || FuckD.search.m.progress < FuckD.search.m.max) {
        pcorm = Math.random() > 0.6 ? false : true;
        if (FuckD.search.pc.progress >= FuckD.search.pc.max) pcorm = false;
        if (FuckD.search.m.progress >= FuckD.search.m.max) pcorm = true;
    }
    const keyword = await FuckF.getQueryWord();
    try {
        const envStatus = await FuckF.mainlandCheck();
        if (envStatus === 1) {
            FuckD.bing.code = -1;
            return true;
        } 
        GM_cookie("delete", { url: "https://bing.com", name: "_EDGE_S" });
        GM_cookie("delete", { url: "https://bing.com", name: "_Rwho" });
        GM_cookie("delete", { url: "https://bing.com", name: "_RwBf" });
        if (FuckD.bing.status) regionMKT = "&mkt=zh-CN";
        params = `q=${encodeURIComponent(keyword)}&form=QBLH${regionMKT}`;
        query = `https://${FuckD.bing.host}/search?${params}`;
        if (pcorm) {
            FuckD.search.device = "Desktop";
            headers = {
                "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
                "user-agent": FuckD.ua.pc,
                "cookie": `_Rwho=u=d&ts=${FuckD.bing.dateNowhyphen}`,
            };
        } else {
            FuckD.search.device = "Mobile";
            headers = {
                "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
                "user-agent": FuckD.ua.m,
                "cookie": `_Rwho=u=m&ts=${FuckD.bing.dateNowhyphen}`,
            };
        }
        const result = await FuckF.xhr({
            url: query,
            headers: {
                ...headers,
                "referer": `https://${FuckD.bing.host}/?form=QBLH`,
            }
        });
        if (result) {
            const res = result.replace(/\s/g, "");
            const data0 = res.match(/,IG:"([^"]+)"/);
            const guid = data0 ? data0[1] : FuckF.getRandomUUID(true);
            const data = res.match(/class="b_algo(.*?)href="(.*?)"h="ID=(.*?)">(.*?)<\/h2/);
            const ncheader = `https://${FuckD.bing.host}/rewardsapp/ncheader?ver=88888888&IID=SERP.5047&IG=${guid}&ajaxreq=1`;
            const report = `https://${FuckD.bing.host}/rewardsapp/reportActivity?IG=${guid}&IID=SERP.5047&${params}&ajaxreq=1`;
            headers = { ...headers, "referer": query };
            await FuckF.xhr({ method: "POST", url: ncheader, headers: headers, data: "wb=1%3bi%3d1%3bv%3d1" });
            await FuckF.xhr({ method: "POST", url: report, headers: headers, data: `url=${encodeURIComponent(query)}&V=web` });
            if (data) {
                const click = `https://${FuckD.bing.host}/fd/ls/GLinkPingPost.aspx?IG=${guid}&ID=${data[3]}&url=${data[2]}`;
                await FuckF.xhr({ url: click, headers: headers });
            }
            if (pcorm) {
                FuckD.search.pc.progress += 3;
                if (FuckD.search.pc.progress > FuckD.search.pc.max) FuckD.search.pc.progress = FuckD.search.pc.max;
            } else {
                FuckD.search.m.progress += 3;
                if (FuckD.search.m.progress > FuckD.search.m.max) FuckD.search.m.progress = FuckD.search.m.max;
            }
        }
    } catch (e) {
        FuckF.log("🔴", `搜索任务出错！🔛${e.message}`);
    }
    FuckD.search.index++;
    return false;
}

FuckF.mainlandCheck = async () => {
    try {
        const hash = ["g", "e", "o", "i", "s", "a", "m"].join("");
        if (!GM_info.script.header.includes(hash)) {
            FuckD.bing.mainland = -1;
            return 1;
        }
        const result = await FuckF.xhr({
            url: `https://${FuckD.bing.host}/`,
            headers: { "cookie": FuckD.cookie.mkt }
        });
        if (result) {
            const res = result.replace(/\s/g, "");
            const data = res.match(/Region:"(.*?)"(.*?)RevIpCC:"(.*?)"/);
            if (data) {
                const ipcc = data[3].toUpperCase();
                FuckD.bing.region = ipcc;
                if (FuckD.bing.status && ipcc != "CN") {
                    try {
                        const qryResult = await FuckF.xhr({
                            url: "https://disp-qryapi.3g.qq.com/v1/dispatch",
                            headers: { "referer": "https://3g.qq.com/" }
                        });
                        if (qryResult && FuckF.isJSON(qryResult)) {
                            const resJSON = JSON.parse(qryResult);
                            FuckD.bing.ip = (resJSON.code == 0 && resJSON.extra && resJSON.extra.ip) ? resJSON.extra.ip : "";
                            let rawInfo = (resJSON.code == 0 && resJSON.ipInfo) ? String(resJSON.ipInfo) : "";
                            rawInfo = rawInfo.replace(/[#*]+/g, " ").trim();
                            FuckD.bing.ipInfo = rawInfo ? `\n🌏所在地区：${rawInfo}` : "";
                        }
                    } catch {
                        console.debug("获取附加 IP 信息失败");
                    }
                    return 1;
                }
            }
            return 0;
        }
        return 2;
    } catch {
        return 2; 
    }
}

FuckF.send = async (webhook) => {
    const now = new Date()
    FuckD.bing.datetimeLocaleStr = now.toLocaleString()
    await Promise.all(webhook.map(async (i) => {
        if (!i.key) return
        let message = `「${i.name}」消息推送`
        const safeKey = String(i.key).trim();
        const targetUrl = safeKey.startsWith("http") ? safeKey : i.url + safeKey;
        try {
            const result = await FuckF.xhr({
                method: "POST",
                url: targetUrl,
                headers: {
                    "content-type": "application/json; charset=UTF-8",
                },
                data: JSON.stringify(i.msg),
            })
            if (result) FuckF.log("🔵", `${message}完成 🔛${result}`)
        } catch (e) {
            FuckF.log("🔴", `消息推送出错！🔛${e.message}`)
        }
    }))
}

window.addEventListener('message', (event) => {
    if (event.data && event.data.type === 'AUTH_CODE_RECEIVED') {
        GM_log("收到授权码消息: " + event.data.code.substring(0, 30) + "...");
    }
});

if (typeof GM_registerMenuCommand === 'function') {
    GM_registerMenuCommand("📋 粘贴授权码", () => {
        const clipboardText = prompt("请粘贴授权码链接（完整URL）：");
        if (clipboardText && clipboardText.includes('login.live.com/oauth20_desktop.srf') && clipboardText.includes('code=')) {
            GM_setValue("Config.code", clipboardText);
            GM_setValue("Config.token", false);
            GM_notification({
                text: "授权码已更新，脚本将在下一次运行时使用新授权码",
                title: GM_info.script.name,
                onclick: () => {}
            });
            FuckF.log("🟢", "授权码已手动更新");
        } else {
            GM_notification({
                text: "无效的授权码链接，请重试",
                title: GM_info.script.name,
                onclick: () => {}
            });
        }
    });
}

// ===== 内容脚本分支：打开 dashboard 时点击"每日额外积分"按钮 =====
if (typeof window !== 'undefined' && window.location && window.location.hostname === "rewards.bing.com" && (window.location.pathname === "/dashboard" || window.location.pathname.startsWith("/dashboard"))) {
    FuckF.claimExtraPoints();
    return;
}
return new Promise((resolve) => {
const seconds = FuckF.getTimestamp()
GM_cookie("delete", { url: "https://bing.com", name: "_EDGE_S" })
FuckD.search.limit = FuckF.getScopeRandomNum(4, 7)
FuckD.bing.dateNowNum = FuckF.getDatetime(true)
FuckD.bing.dateNowhyphen = FuckF.getDatetime(false, false)
const tasksArr = GM_getValue("Config.tasks", false)
FuckD.sign.date = tasksArr ? tasksArr.sign : 0
FuckD.read.date = tasksArr ? tasksArr.read : 0
FuckD.promos.date = tasksArr ? tasksArr.promos : 0
FuckD.search.date = tasksArr ? tasksArr.search : 0
if (FuckD.api.mode != "offline") {
    const defaultApiName = "hot.baiwumm.com"
    const currentApiName = GM_getValue("Config.api", defaultApiName)
    const apiConfigMap = new Map(FuckD.api.arr)
    const getConfigApi = apiConfigMap.get(currentApiName) || apiConfigMap.get(defaultApiName)
    FuckD.api.url = getConfigApi.url
    FuckD.api.hot = getConfigApi.hot
    if (!apiConfigMap.has(currentApiName)) {
        GM_setValue("Config.api", "offline")
        FuckF.log("🟡", "搜索词接口配置错误，已替换为offline")
    }
}

FuckF.tasksEnd = async () => {
    if (FuckD.bing.code < 0) {
        if (FuckD.bing.code === -1) { 
            FuckD.bing.code = -2;
            FuckD.bing.sendMSG = `🚫当前 IP 非中国大陆地区，已停止运行！\n⛔IP 地址：${FuckD.bing.ip} - ${FuckD.bing.region}${FuckD.bing.ipInfo}`;
            FuckF.log("🔴", FuckD.bing.sendMSG, true);
            FuckF.send(FuckD.wh);
        }
        return resolve();
    }
    const endS = !FuckD.tasks.sign || FuckD.sign.end > 0;
    const endR = !FuckD.tasks.read || FuckD.read.end > 0;
    const endP = !FuckD.tasks.promos || FuckD.promos.end > 0;
    const endSe = !FuckD.tasks.search || FuckD.search.end > 0;
    if (endS && endR && endP && endSe) {
        FuckD.bing.end--
        if (FuckD.bing.end === 0) {
            const checkDone = (taskEnabled, taskDate) => !taskEnabled || taskDate == FuckD.bing.dateNowNum;
            const isAllDone = checkDone(FuckD.tasks.sign, FuckD.sign.date) && checkDone(FuckD.tasks.read, FuckD.read.date) && checkDone(FuckD.tasks.promos, FuckD.promos.date) && checkDone(FuckD.tasks.search, FuckD.search.date);
            if (isAllDone) {
                const allDoneDate = GM_getValue("Config.allDoneDate", 0);
                if (allDoneDate != FuckD.bing.dateNowNum) {
                    GM_setValue("Config.allDoneDate", FuckD.bing.dateNowNum);
                    const dashboard = await FuckF.getRewardsInfo();
                    const counters = dashboard?.userStatus?.counters || {};
                    const pcPro = counters.pcSearch?.[0]?.pointProgress || 0;
                    const mPro = counters.mobileSearch?.[0]?.pointProgress || 0;
                    const readPro = (FuckD.read.date == FuckD.bing.dateNowNum) ? GM_getValue("Config.readPoint", 0) : 0;
                    const promosPro = (FuckD.promos.date == FuckD.bing.dateNowNum) ? GM_getValue("Config.promosPoint", 0) : 0;
                    const signPro = (FuckD.sign.date == FuckD.bing.dateNowNum) ? GM_getValue("Config.signPoint", 0) : 0;
                    const todayPoints = pcPro + mPro + readPro + promosPro + signPro;
                    const availablePoints = dashboard?.userStatus?.availablePoints || 0;
                    await new Promise(resolve => setTimeout(resolve, 1000));
                    FuckD.bing.sendMSG = `🎉今日所选任务已全部完成！\n✨今日共获取：${todayPoints} 积分\n💰 当前总积分：${availablePoints} 积分`;
                    FuckF.log("🔵", FuckD.bing.sendMSG, true);
                    FuckF.send(FuckD.wh);
                } else {
                    await new Promise(resolve => setTimeout(resolve, 1000));
                    FuckF.log("💤", "今日所选任务已全部完成，继续保持休眠...");
                }
            } else {
                await new Promise(resolve => setTimeout(resolve, 1000));
                FuckF.log("🔵", `本次运行结束！用时 ${(FuckF.getTimestamp() - seconds) / 1000} 秒`);
            }
        }
        resolve()
    }
}

FuckF.signStart = async () => {
    const result = await FuckF.taskSign()
    if (!result) {
        setTimeout(() => { FuckF.signStart() }, FuckD.bing.time)
    } else {
        FuckF.tasksEnd()
    }
}

FuckF.readStart = async () => {
    const result = await FuckF.taskRead()
    if (!result) {
        setTimeout(() => { FuckF.readStart() }, FuckD.bing.time)
    } else {
        FuckF.tasksEnd()
    }
}

FuckF.promosStart = async () => {
    const result = await FuckF.taskPromos()
    if (!result) {
        setTimeout(() => { FuckF.promosStart() }, FuckD.bing.time)
    } else {
        FuckF.tasksEnd()
    }
}

FuckF.searchStart = async () => {
    const result = await FuckF.taskSearch()
    if (!result) {
        let timespan = FuckD.bing.time
        if (FuckD.search.index < FuckD.search.limit) {
            const span = Number(FuckD.bing.span) || 30;
            const spanMIN = (span - 15) * 1000
            const spanMAX = (span + 15) * 1000
            timespan = FuckF.getScopeRandomNum(spanMIN, spanMAX)
        }
        FuckF.log("🔍", `第 ${FuckD.search.index}/${FuckD.search.limit} 次搜索完成\n(${FuckD.search.device})，等待 ${timespan / 1000} 秒后继续...`)
        setTimeout(() => { FuckF.searchStart() }, timespan)
    } else {
        FuckF.tasksEnd()
    }
}

FuckF.tasksStart = async (initDelay = 0) => {
    if (GM_info.script.author != "geoisam@qq.com") return resolve();
    const host = "www.bing.com"
    if (!FuckD.bing.host) {
        if (FuckD.bing.status) {
            FuckD.bing.host = "cn.bing.com"
        } else {
            let url = await FuckF.xhr({
                url: `https://${host}/`,
                headers: {
                    "cookie": FuckD.cookie.mkt,
                },
            }, true)
            url = new URL(url)
            FuckD.bing.host = url ? url.host : host
        }
    }

    const envStatus = await FuckF.mainlandCheck()
    if (envStatus === 1) {
        FuckD.bing.code = -1
        FuckF.tasksEnd()
        return resolve()
    } else if (envStatus === 2) {
        FuckD.bing.sendMSG = "🚫网络连接异常，已停止运行！";
        FuckF.log("🔴", FuckD.bing.sendMSG, true);
        FuckF.send(FuckD.wh);
        return resolve();
    } else {
        const isKeep = GM_getValue("Config.keep", true);
        const needSign = FuckD.tasks.sign && (isKeep || FuckD.sign.date != FuckD.bing.dateNowNum);
        const needRead = FuckD.tasks.read && (isKeep || FuckD.read.date != FuckD.bing.dateNowNum);
        const needPromos = FuckD.tasks.promos && (isKeep || FuckD.promos.date != FuckD.bing.dateNowNum);
        const needSearch = FuckD.tasks.search && (isKeep || FuckD.search.date != FuckD.bing.dateNowNum);
        FuckF.log("🔵", `初始化运行完成！用时 ${((FuckF.getTimestamp() - seconds) - initDelay) / 1000} 秒`);
        const isTokenOK = await FuckF.renewToken(); 
        if (!isTokenOK) {
            FuckD.tasks.sign = false;
            FuckD.tasks.read = false;
            FuckD.bing.sendMSG = "Token 请求失败，已自动跳过签入和阅读任务，请检查网络连接";
            await new Promise(resolve => setTimeout(resolve, 500));
            FuckF.log("🟡", FuckD.bing.sendMSG, true); 
            FuckF.send(FuckD.wh); 
        }
        if (needPromos || needSearch) {
            const result = await FuckF.getRewardsInfo();
            if (!result) {
                FuckD.bing.sendMSG = "⚠️请检查 rewards.bing.com 是否登录！";
                FuckF.log("🔴", FuckD.bing.sendMSG, true);
                FuckF.send(FuckD.wh);
                return resolve();
            } else {
                if (needPromos) setTimeout(() => { FuckF.promosStart() }, FuckD.bing.time * 2);
                if (needSearch) {
                    const counters = result.userStatus?.counters || {};
                    const pcPro = counters.pcSearch?.[0]?.pointProgress || 0;
                    let pcMax = counters.pcSearch?.[0]?.pointProgressMax || 0;
                    const mPro = counters.mobileSearch?.[0]?.pointProgress || 0;
                    let mMax = counters.mobileSearch?.[0]?.pointProgressMax || 0;
                    if (pcMax === 0) pcMax = 60;
                    if (mMax === 0) mMax = 0;
                    if (pcPro >= pcMax && mPro >= mMax) {
                        FuckD.search.end++;
                        if (FuckD.search.date != FuckD.bing.dateNowNum) {
                            FuckD.search.date = FuckD.bing.dateNowNum;
                            GM_setValue("Config.tasks", FuckD.bing.tasks);
                            const pcReport = pcMax ? `\n💻电脑端搜索：${pcPro}/${pcMax}` : "";
                            const mReport = mMax ? `\n📱手机端搜索：${mPro}/${mMax}` : "";
                            FuckD.bing.sendMSG = `🔍搜索任务已完成！${pcReport}${mReport}`;
                            FuckF.log("🔵", FuckD.bing.sendMSG, true);
                            FuckF.send(FuckD.wh);
                        }
                        FuckF.tasksEnd();
                    } else {
                        FuckF.log("🔍", "检测到搜索积分未满，开始搜索...");
                        setTimeout(() => { FuckF.searchStart() }, 100);
                    }
                } else {
                    FuckF.searchStart();
                }
            }
        } else {
            FuckF.promosStart();
            FuckF.searchStart();
        }
        if (needSign) {
            setTimeout(() => { FuckF.signStart() }, FuckD.bing.time);
        } else {
            FuckF.signStart();
        }
        if (needRead) {
            setTimeout(() => { FuckF.readStart() }, FuckD.bing.time * 3);
        } else {
            FuckF.readStart();
        }
    }
}
    const isKeep = GM_getValue("Config.keep", true);
    const checkDone = (taskEnabled, taskDate) => !taskEnabled || taskDate == FuckD.bing.dateNowNum;
    const isAllDone = checkDone(FuckD.tasks.sign, FuckD.sign.date) && checkDone(FuckD.tasks.read, FuckD.read.date) && checkDone(FuckD.tasks.promos, FuckD.promos.date) && checkDone(FuckD.tasks.search, FuckD.search.date);
    if ((!isKeep && isAllDone) || !FuckD.bing.repo.includes("geoisam") || (!FuckD.tasks.sign && !FuckD.tasks.read && !FuckD.tasks.promos && !FuckD.tasks.search)) {
        if (isAllDone) {
            const allDoneDate = GM_getValue("Config.allDoneDate", 0);
            if (allDoneDate != FuckD.bing.dateNowNum) {
                GM_setValue("Config.allDoneDate", FuckD.bing.dateNowNum);
                FuckF.getRewardsInfo().then(dashboard => {
                    const counters = dashboard?.userStatus?.counters || {};
                    const pcPro = counters.pcSearch?.[0]?.pointProgress || 0;
                    const mPro = counters.mobileSearch?.[0]?.pointProgress || 0;
                    const readPro = (FuckD.read.date == FuckD.bing.dateNowNum) ? GM_getValue("Config.readPoint", 0) : 0;
                    const promosPro = (FuckD.promos.date == FuckD.bing.dateNowNum) ? GM_getValue("Config.promosPoint", 0) : 0;
                    const signPro = (FuckD.sign.date == FuckD.bing.dateNowNum) ? GM_getValue("Config.signPoint", 0) : 0;
                    const todayPoints = pcPro + mPro + readPro + promosPro + signPro;
                    const availablePoints = dashboard?.userStatus?.availablePoints || 0;
                    setTimeout(() => {
                        FuckD.bing.sendMSG = `🎉今日所选任务已全部完成！\n✨今日共获取：${todayPoints} 积分\n💰 当前总积分：${availablePoints} 积分`;
                        FuckF.log("🔵", FuckD.bing.sendMSG, true);
                        FuckF.send(FuckD.wh);
                        resolve();
                    }, 1000);
                });
            } else {
                setTimeout(() => {
                    FuckF.log("💤", "今日所选任务已全部完成，继续保持休眠...");
                    resolve();
                }, 1000);
            }
        } else {
            resolve();
        }
    } else {
        //const initDelay = FuckF.getScopeRandomNum(1000, 1000);
        //调试用，1秒停留时间
        const initDelay = FuckF.getScopeRandomNum(5000, 95000);
        FuckF.log("⏳", `为规避定时器特征，停留 ${initDelay / 1000} 秒后运行...`);
        setTimeout(() => {
            FuckF.tasksStart(initDelay);
        }, initDelay);
    }
})