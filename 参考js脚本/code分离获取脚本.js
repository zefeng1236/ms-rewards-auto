// ==UserScript==
// @name         Microsoft Rewards Auth Code Capture
// @namespace    https://github.com/geoisam/FuckScripts
// @version      1.0.0
// @description  捕获微软授权码
// @author       geoisam@qq.com
// @match        https://login.live.com/*
// @run-at       document-end
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_notification
// @grant        GM_log
// @storageName  FuckScripts_Shared_Auth
// ==/UserScript==

(function() {
    'use strict';

    const captureAuthCode = () => {
        try {
            const urlParams = new URLSearchParams(window.location.search);
            const authCode = urlParams.get("code");
            
            if (authCode && authCode.length > 10) {
                GM_log("✅ 检测到授权码: " + authCode.substring(0, 20) + "...");
                const fullCode = "https://login.live.com/oauth20_desktop.srf?code=" + authCode.trim();
                GM_setValue("Config.code", fullCode);
                GM_setValue("Config.token", false);
                
                GM_notification({
                    text: "授权码获取成功！",
                    title: "Microsoft Rewards Auth",
                    onclick: function() {}
                });
                
                return true;
            }
        } catch (e) {
            GM_log("捕获授权码异常: " + e.message);
        }
        return false;
    };

    const scheduleCapture = () => {
        GM_log("🔍 授权页面检测到，开始监听授权码...");
        
        if (captureAuthCode()) {
            GM_log("✅ 立即捕获成功");
            return;
        }

        const tryAgain = () => {
            if (captureAuthCode()) {
                GM_log("✅ 延迟捕获成功");
            }
        };

        if (document.readyState === 'complete') {
            tryAgain();
        } else {
            document.addEventListener('DOMContentLoaded', tryAgain);
            window.addEventListener('load', tryAgain);
        }

        let attempt = 0;
        const maxAttempts = 120;
        const checkInterval = setInterval(() => {
            attempt++;
            GM_log("🔍 第 " + attempt + " 次检查...");
            
            if (captureAuthCode()) {
                clearInterval(checkInterval);
                GM_log("✅ 定时检查捕获成功");
                return;
            }
            
            if (attempt >= maxAttempts) {
                clearInterval(checkInterval);
                GM_log("⏰ 授权码捕获超时");
            }
        }, 500);

        window.addEventListener('hashchange', () => {
            GM_log("🔍 hashchange 事件触发");
            captureAuthCode();
        });
        
        window.addEventListener('popstate', () => {
            GM_log("🔍 popstate 事件触发");
            captureAuthCode();
        });
    };

    scheduleCapture();
})();