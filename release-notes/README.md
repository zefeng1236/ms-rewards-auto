# 发布说明模板

发版流程里，`.github/workflows/ci.yml` 的 `release` job 在检测到 `v*` tag 推送时，
会自动下载 `desktop` job 打好的安装包、算出 SHA256、建一个**草稿 Release** 并挂上产物。

## 怎么用

1. 复制本文件为 `release-notes/<版本号>.md`，比如 `release-notes/0.14.9.md`
2. 把正文写好（支持标题 / 列表 / 表格 / 引用 / 行内链接 / 围栏代码块）
3. `git add release-notes/0.14.9.md`，连同版本号一起提交
4. 打 tag 推上去：`git tag -a v0.14.9 -m "..." && git push origin v0.14.9`
5. 等 Actions 跑完（不必等很久，桌面打包大约 5 分钟）
6. **核对**：在草稿 Release 页面对照下面的 SHA256 / 字节数，确认与本地 `sha256sum dist/*.exe` 一致
7. 点 **Publish release**

## 占位符

写正文时用下面这些占位符，CI 会替换成当次构建的真实值（**不要手写哈希**，会与产物不一致）：

| 占位符 | 替换为 |
|---|---|
| `{{VERSION}}` | 本次版本号（package.json 的 version） |
| `{{EXE_NAME}}` | 安装包文件名 |
| `{{BYTES_EXE}}` | 安装包字节数 |
| `{{SHA256_EXE}}` | 安装包 SHA256（小写十六进制） |
| `{{BLOCKMAP_NAME}}` | blockmap 文件名 |
| `{{BYTES_BLOCKMAP}}` | blockmap 字节数 |
| `{{SHA256_BLOCKMAP}}` | blockmap SHA256 |

## 骨架长什么样（供参考）

```markdown
# {{VERSION}}：一句话概括本版

> 一段话概述，值得用户点进来读。

## 改了什么

- **要点一**：解释为什么这么改
- **要点二**：解释用户能感知到什么

## 验证

- npm run typecheck
- npm test

## 升级

直接覆盖安装即可，配置与账号数据不受影响。

| 文件 | 字节数 | SHA256 |
|---|---|---|
| {{EXE_NAME}} | {{BYTES_EXE}} | {{SHA256_EXE}} |
```

> 注：上面的骨架是「模板里的示例」，正文里如果要放真正的代码块，用三个反引号
> 包起来并确保没有嵌套。

---

## 发版收尾核对（必做，2026-11-06 定案）

离线的 `selfcheck` 看不到 GitHub 上那份正文，**代码全绿不等于客户端能装**。
0.15.9 就是漏跑签名、门禁全绿、Release 也建好了，用户一点「检查更新」直接被拒。

### 固定顺序

```
bump --build 0 → 门禁 → pack → sha256/字节数 → sign-release
→ commit + push → tag → gh release create → npm run verify:release
```

- 正式版用 `node scripts/bump-version.js <版本> --build 0`（不带 `--build` 会保留内部交付号）。
- `sign-release.js` 的 `keyid` 必须与内置公钥一致；签名块由 `gh release create --notes-file <签名后的正文>` 带上去。
- **发布后正文若被改动，要重新签名并 `gh release edit`**，否则 `verify:release` 会红。

### `npm run verify:release` 核什么（16 项）

| 组 | 检查项 |
|---|---|
| Release 状态 | 存在 / 非草稿 / **非预发布** / **是 Latest**（直接查客户端用的 `releases/latest` 端点） |
| 附件 | exe 存在 / **blockmap 存在** / 两者都可下载 / 字节数与本地一致 |
| 签名 | 正文可验签 / version / file / sha256 与本地产物一致 |
| 展示一致性 | **正文校验表的 SHA256 与签名一致**、**正文校验表的字节数与本地一致** |

> 加粗项是 2026-11-06 补的。其中「正文校验表」对应 2026-10-02 的事故：
> exe 被覆盖重传但说明还写旧哈希，签名没问题，用户一校验却失败。

`--skip-download` 会把两项可达性标成 **SKIP**，并在结论里明确「不能断定客户端能装」——
跳过不会被伪装成通过。

### 反例自测

```
npm run verify:release:selftest
```

用桩替换 `gh` / `curl` / 验签模块，拿本地 `dist` 的真实安装包构造一份「全绿」假 Release，
再逐项注入坏输入（草稿、预发布、latest 指错、漏传 blockmap、正文哈希写成旧值、
签名 version/file 错、404、302 未跟完等），断言对应项真的变红。
**不联网、不碰线上 Release、不需要私钥。**

新增检查项时必须同时加一组反例 —— 0.16.0 发版时发现旧的「附件可下载」只 catch
curl 异常、不看 HTTP 状态码，404 也判通过，等于摆设。

### 失败时怎么办

脚本会按失败项给可执行的修复命令（签名 / 正文校验表 / 附件 / 发布状态四类）。
附件被覆盖重传后务必**重新签名**：签名里的 `sha256` 必须等于新资产的真实哈希。
