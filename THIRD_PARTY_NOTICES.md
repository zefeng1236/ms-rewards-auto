# 第三方声明（Third Party Notices）

本文件列出 MS Rewards Auto（以下简称「本软件」）在构建与分发过程中使用或随安装包分发的第三方组件及其许可。

本软件自身代码按 **MIT License** 分发（见根目录 `LICENSE`）。

## 运行时依赖（随应用分发）

### @ttqtt/liquid-glass-react — 0.0.2
- **许可**：MIT（Copyright (c) 2026 Liquid Glass UI contributors）
- **仓库**：https://github.com/Tsdsj/liquid-glass-react
- **用途**：玻璃质感 UI 组件库（按钮 / 开关 / 滑块 / 分段控件 / GlassSurface 等）。
- **上游声明**：该库自带 `THIRD_PARTY_NOTICES.md`，说明其曾参考 `rdev/liquid-glass-react`、`shuding/liquid-glass`、`leefanv/liqui-design` 与 Apple 文档作为调研 / 概念参照，且不交付字体文件、不从图片服务 / 字体 CDN / 追踪服务加载资源。本软件未直接引入上述上游源码；如后续复用，应固定具体版本 / 提交并保留对应许可。

### React / ReactDOM — 19.3.0
- **许可**：MIT
- **仓库**：https://github.com/facebook/react
- **用途**：前端 UI 框架。

### Electron — 31.7.7
- **许可**：MIT；发行包内嵌 Chromium 与 Node.js 运行时，其各自的第三方许可随 Electron 发行包分发（见 Electron 包内 `LICENSE` 与 `LICENSES.chromium.html`）。
- **仓库**：https://github.com/electron/electron
- **用途**：桌面应用运行时。

### Playwright / Playwright-Core — 1.62.1
- **许可**：Apache-2.0（Copyright (c) Microsoft Corporation；含派生自 Puppeteer 的代码，Apache-2.0）。
- **仓库**：https://github.com/microsoft/playwright
- **用途**：驱动 Chromium 浏览器执行自动任务；Chromium 内核按需下载，其许可随 Playwright / Chromium 分发（见 `playwright-core` 包内 `LICENSE` 与 `NOTICE`）。

### fingerprint-chromium — 154.0.8037.57
- **许可**：BSD 3-Clause（基于 Ungoogled Chromium；Copyright (c) The ungoogled-chromium Authors 及 patch 原作者 xiaozhou26）
- **仓库**：https://github.com/xiaozhou26/Chromix （上游：https://github.com/ungoogled-software/ungoogled-chromium ）
- **更换说明**：2026-10-05 从 adryfish/fingerprint-chromium 150.0.7871.186 换为 Chromix。原上游 150 存在未修复缺陷（issue #94：开启 canvas 伪装时页面读取像素会导致渲染进程崩溃），且之后无新版本发布。两者同为基于 Ungoogled Chromium 的 BSD-3 定制发行版，本软件的许可状况不变。
- **用途**：可选的「环境拟真增强浏览器」，运行时按需下载（约 212MB，解压后 536MB+，不随安装包分发）。它对 UA / userAgentData / Client Hints 三者做源码层的同源生成，并支持 `--fingerprint=<seed>` 种子化环境特征，用于把应用层改不动的那部分环境一致性在源码层补齐。本软件未修改其二进制，仅下载、解压并以命令行为其传入启动参数。

### fingerprint-chromium — 150.0.7871.186（备用内核，当前不可选）
- **许可**：BSD 3-Clause（基于 Ungoogled Chromium；Copyright (c) The ungoogled-chromium Authors 及 patch 原作者 adryfish）
- **仓库**：https://github.com/adryfish/fingerprint-chromium （上游：https://github.com/ungoogled-software/ungoogled-chromium ）
- **状态**：**保留为备用内核，代码路径完整但当前不开放选择**（设置页可见但置灰）。启用后页面读取像素会触发渲染进程崩溃（上游 issue #94，暂无补丁）；本项目默认使用 Chromix 154。待上游修复后开放选择。
- **并列声明的原因**：软件在设置页提供内核自选（`chromix` / `fp150`），两个内核都可能随用户选择被下载并在本机运行，故**两者都在分发范围内**，一并声明。
- **用途**：同「Chromix 154」条目（可选的「环境拟真增强浏览器」，运行时按需下载，不随安装包分发）。本软件未修改其二进制。
- **许可文本（BSD 3-Clause）**：
  ```
  Redistribution and use in source and binary forms, with or without
  modification, are permitted provided that the following conditions are met:

  1. Redistributions of source code must retain the above copyright notice,
     this list of conditions and the following disclaimer.
  2. Redistributions in binary form must reproduce the above copyright notice,
     this list of conditions and the following disclaimer in the documentation
     and/or other materials provided with the distribution.
  3. Neither the name of the copyright holder nor the names of its contributors
     may be used to endorse or promote products derived from this software
     without specific prior written permission.

  THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
  AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
  IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
  DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
  FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
  DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
  SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
  CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
  OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
  OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
  ```

## 构建期依赖（仅参与构建，不随运行时分发）

| 组件 | 版本 | 许可 |
| --- | --- | --- |
| Vite | 5.4.21 | MIT |
| TypeScript | 5.9.3 | Apache-2.0 |
| electron-builder | 25.1.8 | MIT |
| @vitejs/plugin-react | 4.7.0 | MIT |
| rcedit | 5.0.2 | MIT |

## 字体与网络素材

- 仅使用系统字体栈，不交付任何 `.woff / .woff2 / .ttf / .otf` 字体文件。
- 本软件不依赖图片服务、字体 CDN 或追踪服务加载运行时资源；界面壁纸、图标为项目内原创或系统资源。

---

本文件所列第三方组件、字体与素材**均不适用本仓库根目录 [LICENSE](LICENSE) 的 MIT 许可**，各自遵循其原始许可条款。上表已列明每个组件的许可标识；如某项未列明，请以其上游仓库的许可文件为准。

