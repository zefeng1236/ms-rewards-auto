# 安全策略（Security Policy）

## 支持范围

| 版本 | 状态 |
|---|---|
| 最新正式版（见 [Releases](https://github.com/zefeng1236/ms-rewards-auto/releases)） | ✅ 接受漏洞报告 |
| 之前的预览版（Pre-release） | ❌ 不单独维护，请先升级到最新版 |

本项目按「现状」提供，不承诺更新频率与修复时限（见 README 免责声明第 6 条）。但**安全问题我们确实在意**，收到报告后会评估处理。

## 报告方式

**请不要用 GitHub Issue 公开报告安全问题。**

请通过 GitHub 仓库的 **Security → Report a vulnerability**（[私密报告](https://github.com/zefeng1236/ms-rewards-auto/security/advisories/new)）提交。

如果该入口不可用，请开一个**不含技术细节**的 Issue 描述问题存在，我们会私下联系你获取详情。

## 报告内容建议

请尽量包含：

- 受影响版本（安装包文件名 / tag）
- 问题类型（本地凭据泄露、加密实现缺陷、权限越界、注入……）
- **复现步骤**或最小复现代码
- 影响范围与危害评估
- 你已知的缓解方式（如有）

## 我们会做什么

1. 确认收到并复现问题
2. 评估影响与修复优先级
3. 修复并发布新版本
4. 如有必要，在 CHANGELOG 与 Release 说明中致谢报告者（**默认征求你的同意后才署名**）

## 涉及加密的部分

本软件的登录态使用 **scrypt 派生密钥 + AES-256-GCM** 加密落盘（见 `src/vault/`），Windows 下额外用系统钥匙串（DPAPI）实现日常免密解锁。以下属于**预期行为而非漏洞**：

- 忘记加密密码只能靠 44 位恢复密钥重置 —— 密码不落盘是设计使然
- 卸载默认保留 `%APPDATA%\ms-rewards-auto` 用户数据
- Docker/Web 版启用自动解锁时，恢复密钥文件写在 `storage/vault-autounlock.key`（权限 0600）

若你发现的是**上述设计之外**的凭据泄露路径，请务必报告。
