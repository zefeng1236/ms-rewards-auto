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
