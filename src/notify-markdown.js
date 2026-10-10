/**
 * 推送消息的markdown 排版（三家 IM 的方言适配）。
 *
 * ⚠️ 为什么要单独建文件、而不是在 notify.js 里就地拼：
 *   三家的 markdown 支持**互不兼容**，混在一起写必然互相污染：
 *   - 钉钉：`msgtype:"markdown"` + `{title, text}`，支持 1~6 级标题/列表/引用/
 *     加粗/链接/图片。**换行必须用 `\n\n`（官方原文：换行 前后分别加2个空格）**
 *     —— 单个 `\n` 会被折成同一段。这就是「要空行」这条用户要求的来源。
 *   - 企业微信：`msgtype:"markdown"` + `{content}`，除上述外还支持
 *     `<font color="info|comment|warning">` 彩色字体（仅 3 种内置色）。
 *     同样必须空行换行。markdown_v2 支持表格/分割线/代码块但**不支持颜色和 @**。
 *   -飞书：**没有 markdown 消息类型**（只有 text / post / interactive），
 *     所以要用 `interactive` 卡片里的 `markdown` 元素，或 `post` 富文本。
 *     本文件走**卡片**（能显示标题 + markdown 正文，且首屏标题可控）。
 *
 * 三条硬约束（用户 2026-10-08 明确要求）：
 *   1. **要有空行**：段落之间一律 `\n\n`。三家都不能靠单 `\n` 换行，
 *      单 `\n` 会被折成同一段糊成一坨。
 *   2. **钉钉一行最多约 15 个汉字**（移动端窄屏实测值），所以行内不要拼长句，
 *      要拆行；正文里的英文/数字按半宽算，别按字符数硬算。
 *   3. **标题走title 参数**（首屏会话列表透出），不要用 `#` 包在正文里 ——
 *      钉钉/企微的 markdown 消息体里`# 标题` 会和title 重复显示。
 */

/** 单行宽度上限：钉钉移动端约 15 个汉字（用户实测），这里留一点余量 */
const LINE_HINT = 15;

/**
 * 加粗标记（两个星号）。
 * ⚠️ 用字符串常量而不是在代码里直接写：一旦它和紧随其后的斜杠凑成
 *   「星号-斜杠」的连续序列，JS 会当成**块注释结束符**，提前闭合注释并把
 *   后面的代码当注释吃掉，报 `SyntaxError: Unexpected token`。
 *   本项目已踩 4 次（cron.ts / cron.js 注释里的步长表达式、本文件首版两处）。
 *   **注释里提到这个序列时也别直接写出来**，用「星号-斜杠」这种中文说法。
 */
const BOLD = ["*", "*"].join("");
/** 反引号同样用常量拼，避免在正则/注释里凑出会被误解析的序列 */
const TICK = "`";
/** 分割线。放在头部与正文之间，区分「谁发的」和「发了什么」 */
const HR = "---";

/**
 * 去掉正文里的 markdown 标记，得到「纯文本」——用于关键词匹配与长度估算。
 *
 * 钉钉/企微的关键词安全模式是**按纯文本**匹配的（`#`、`**` 之类的标记不算），
 * 所以补关键词前必须先剥标记，否则用户设的关键词如果是正文里带 markdown 的
 * 那个词，永远匹配不上。
 */
/**
 * 剥掉加粗 / 斜体的星号标记（stripMarkdown 与 stripMarksKeepLines 共用）。
 *
 * ⚠️ 必须**迭代到稳定**，单次扫描会漏 —— 这是 CodeQL
 * `js/incomplete-multi-character-sanitization`（告警 #16/#17）指的那类问题：
 *   ① 一轮 replace 之后，剩下的星号会**重新组合**出新的标记
 *      （`**a**` 与 `**b**` 相邻时，移除后中间可能再拼出 `**`）；
 *   ② 纯标记串 `****` 因为 `(.+?)` 至少要吃一个字符，两轮正则都匹配不到
 *      → **完全不会被净化**（实测输入 `****` 原样输出四个星号）。
 * 所以先循环到不再变化，再兜底清掉「只剩星号」的残渣。
 *
 * ⚠️ 所有含星号的正则一律用字符串 + new RegExp 构造，**不要**写字面量：
 *   字面量里「星号紧跟斜杠」那两个字符连在一起会被 JS 当成块注释结束符，
 *   提前闭合注释、后面整段被当代码解析，报 SyntaxError: Unexpected token。
 *   本项目同类坑已踩多次（cron.ts / cron.js 注释里写步长表达式）——
 *   所以本文件里凡是想写出那两个字符的地方，一律用反引号拆开描述。
 *
 * @param {string} s
 * @returns {string}
 */
function stripEmphasis(s) {
  const boldRe = new RegExp("[*]{2}(.+?)[*]{2}", "g"); // 加粗
  const italicRe = new RegExp("[*]([^*\\n]+)[*]", "g"); // 斜体（不用 lookbehind）
  const bareLine = new RegExp("^[*]+$", "gm"); // 整行只剩星号（纯标记，无内容）
  const triple = new RegExp("[*]{3,}", "g"); // 行内 3 个以上连续星号
  let out = String(s == null ? "" : s);
  // 上限兜底：极端输入下避免死循环（每轮至少吃掉一对标记，8 轮足够现实文本）
  for (let i = 0; i < 8; i++) {
    const prev = out;
    out = out.replace(boldRe, "$1").replace(italicRe, "$1");
    if (out === prev) break;
  }
  return out.replace(triple, "").replace(bareLine, "");
}

function stripMarkdown(s) {
  return stripEmphasis(
    String(s == null ? "" : s)
      .replace(/^#{1,6}\s+/gm, "") // 标题
      .replace(/`{1,3}([^`]*)`{1,3}/g, "$1") // 行内/块代码
      .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1") // 链接 [文字](地址)
      .replace(/^>\s?/gm, "") // 引用
      .replace(/^[-*+]\s+/gm, "") // 无序列表
      .replace(/^\d+\.\s+/gm, "") // 有序列表
      .replace(/<[^>]+>/g, "") // HTML 标签（含企微 font color）
  )
    .replace(/\s+/g, " ")
    // ⚠️ 尖括号收尾（CodeQL #18/#19：净化链仍可能残留 `<script`）。
    //    上面那条 `<[^>]+>` 只吃**成对**标签，`<script` 这种没有闭合 `>`
    //    的残缺形态会原样漏过去。这里直接剥掉裸尖括号。
    //    别觉得多余：这两个函数的输入里**确实有外部内容** ——
    //    推送里的「一言」来自 hitokoto 第三方 API，不是我们自己拼的字面量。
    .replace(/[<>]/g, "")
    .trim();
}

/**
 * 段落之间插入空行，并把连续空行压成恰好一个。
 *
 * ⚠️ 这是「要空行」的**唯一实现点**：调用方随便 `\n` 或 `\n\n` 都行，
 * 出口统一是「段与段之间恰好一个空行」。
 */
function toBlocks(body) {
  return String(body == null ? "" : body)
    .split(/\n+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .join("\n\n");
}

/**
 * 把「用户名：值」这类正文行整理成markdown 列表。
 *
 * 为什么：这类推送（区域拦截、签到、汇总）的正文天然是若干个「标签: 值」，
 * 直接裸排一行行贴上去在窄屏会挤成一坨。整理成 `- 标签：值` 后每项自带
 * 缩进，窄屏换行时值不会跑到标签头上方。
 *
 * 只处理形如 `xxx：yyy` / `xxx: yyy` 的行；其它行（标题、空行、列表）原样保留。
 */
/**
 * 判断一行是不是「标签: 值」。
 *
 * 标签限长 16 是为了不把整句误判成标签 —— 如「注意：这个功能需要先在设置里开启」
 * 应该原样输出（它是给用户看的提醒，不是一个字段）。
 *
 * @param {string} line
 * @returns {{k:string,v:string}|null}
 */
function matchKeyValue(line) {
  const s = String(line == null ? "" : line).trim();
  if (!s) return null;
  // 已经是列表项/标题/引用 → 不是标签: 值
  if (/^([-*+]\s|#{1,6}\s|>|\d+\.\s)/.test(s)) return null;
  // **行首带图标/符号的行不转列表**：拦截推送里「🟥 当前 IP：x」「🇨🇳 归属地」
  // 这类行靠图标表达语义，再套列表符会变成「• 🟥 当前 IP」——
  // 图标和圆点挤在一起很脏（用户 2026-10-09 要求「前面不加圆点」）。
  // 判据：首字符不是中英文/数字（emoji、⚠️、🏢 等都落在这里）。
  if (/^[^\w\u4e00-\u9fa5]/.test(s)) return null;
  const m = s.match(/^([^：:]{1,16})[：:]\s*(\S.*)$/);
  return m ? { k: m[1].trim(), v: m[2].trim() } : null;
}

/**
 * 渲染成markdown 列表项。
 *
 * ⚠️ 标签用**反引号等宽**而不是加粗：钉钉/企微的等宽块带淡底色，
 *    一眼能看出「左边是字段名、右边是值」，且不会像 `**加粗**` 那样
 *    在深色主题下抢走正文的注意力（用户 2026-10-09 指名要这个格式：
 *    ``- `ip`：192.168.1.1``）。
 *    反引号标记用常量拼，理由同 BOLD 的注释（星号紧挨斜杠会被当注释结束符）。
 */
function renderKeyValue(pair) {
  return "- " + TICK + pair.k + TICK + "：" + pair.v;
}

/**
 * 长行软折行。
 *
 * 钉钉移动端**一行只显示约 15 个汉字**，超出部分要用户横向拖才能看到 ——
 * 而推送多半是在手机上看（用户 2026-10-08 明确要求按 15 字考虑）。
 * 这里按「显示宽度」折行：一个汉字算 2、ASCII 算 1。
 *
 * ⚠️ 只折「纯散文长句」，**不折列表项**：列表项折行后缩进会乱。
 *
 * @param {string} s
 * @param {number} [width] 显示单位（1 汉字 = 2）。默认 30 = 15 汉字
 * @returns {string}
 */
function wrapLongLine(s, width) {
  const limit = Math.max(8, Number(width) || LINE_HINT * 2);
  const disp = (ch) => (/[\x00-\xff]/.test(ch) ? 1 : 2); // ASCII 1 宽，其余 2 宽
  const out = [];
  for (const line of String(s == null ? "" : s).split("\n")) {
    // 列表项 / 标题 / 引用：整行交给客户端 CSS 折行，不在这里动
    if (/^([-*+]\s|#{1,6}\s|>|\d+\.\s)/.test(line)) {
      out.push(line);
      continue;
    }
    let cur = "";
    let w = 0;
    for (const ch of line) {
      const cw = disp(ch);
      if (w + cw > limit) {
        out.push(cur);
        cur = "";
        w = 0;
      }
      cur += ch;
      w += cw;
    }
    if (cur) out.push(cur);
  }
  return out.join("\n");
}

/**
 * 把正文加工成markdown 文本。
 *
 * @param {string} title    消息标题（各平台单独用title 字段透出，不进正文）
 * @param {string} body     正文（纯文本，允许 \n 单换行）
 * @param {object} [opts]
 * @param {boolean} [opts.color] 企业微信是否允许彩色字体（钉钉/飞书不支持，不传）
 * @returns {string} markdown 文本（段落间恰好一个空行）
 */
function buildMarkdown(title, body, opts = {}) {
  void title; // 标题由各平台的 title / header 字段承载，不进正文（见文件头注释）

  // ⚠️ 「每个渲染单元之间恰好一个空行」是这里**唯一**的换行规则实现点。
  //
  //   三家 markdown 都**不认单个换行符**（会折成同一段糊成一坨），只认空行分段。
  //   所以这里把**每一行都当成独立的渲染单元**，中间一律 `\n\n` ——
  //   早先的写法是「按空行分段、段内用单个 \n 连接」，结果钉钉把同一段的多行
  //   压成了一行：用户名和后面的警示句黏在一起（用户 2026-10-09 实测反馈）。
  //
  //   代价是列表项之间也会各带一个空行（比紧凑列表稍微松一点），但这是
  //   三家 markdown 换行语义要求的，紧凑与不糊只能选一个 —— 选不糊。
  const raw = String(body == null ? "" : body);
  const blocks = [];
  for (const para of raw.split(/\n{2,}/)) {
    for (const l of para.split(/\n/)) {
      const s = String(l).trim();
      if (!s) continue;
      // 用户名行是「这条推送来自哪个账号」的标识，不是数据项：
      //   - 转成列表项会在钉钉渲染成圆点（用户反馈「开头不要有这么多点」）
      //   - 它必须独立成块，否则版本号会被后面的正文挤走
      if (/^用户名[：:]/.test(s)) {
        blocks.push(s);
        continue;
      }
      // 逐行判断：散文行原样保留、标签行转成列表项
      const kv = matchKeyValue(s);
      blocks.push(kv ? renderKeyValue(kv) : s);
    }
  }
  // 头部（用户名+版本号）之后加一条分割线，把「谁发的」和「发了什么」分开。
  // 只在头部后面确有正文时才加 —— 否则末尾会拖一条孤零零的横线。
  if (blocks.length > 1 && /^用户名[：:]/.test(blocks[0])) {
    blocks.splice(1, 0, HR);
  }
  const text = blocks.join("\n\n");
  // 折行默认**关**：三家 markdown 渲染时本来就会自动折行，硬折可能把emoji/链接切断。
  // 需要时按需打开（opts.wrap=true）。
  return opts.wrap ? wrapLongLine(text, opts.wrapWidth) : text;
}

/**
 * 钉钉 markdown 消息体。
 *
 * 官方文档（open.dingtalk.com「消息类型与数据格式」）：
 *   { "msgtype": "markdown", "markdown": { "title": "...", "text": "..." } }
 *   - text建议 500 字符以内
 *   - 换行用 \n\n（官方：「换行 前后分别加2个空格」）
 *   - 关键词安全模式按**纯文本**匹配
 */
function dingdingBody(title, text) {
  return {
    msgtype: "markdown",
    markdown: { title: String(title || "").slice(0, 100), text },
    // at 字段留空：本项目没有「@某人」需求，写死会误触发
    at: { atMobiles: [], isAtAll: false },
  };
}

/**
 * 企业微信 markdown 消息体。
 *
 * 官方文档（developer.work.weixin.qq.com/document/path/91770）：
 *   { "msgtype": "markdown", "markdown": { "content": "...", "mentioned_list": [] } }
 *   - content 最长 4096 **字节**（不是字符），一个中文约 3 字节 → 约 1360 字
 *   - 支持 <font color="info|comment|warning"> 三种内置色
 *   - markdown 类型的 text/markdown 都支持 <@userid> 扩展语法
 */
function weworkBody(title, text) {
  return {
    msgtype: "markdown",
    markdown: {
      // 企微没有 title 字段，标题要自己放进正文首行（加粗，模拟标题层级）
      //
      // 拦截推送的 IP 行在企微 markdown 下**真的上色**：企微是三家（钉钉/企微/飞书）
      // 里唯一支持 <font color> 的，warning = 橙红色，正好用来标「出问题的出口 IP」。
      // 纯文本/钉钉那两个分支走 stripMarksKeepLines，HTML 标签会被剥掉，不会残留。
      content: `**${String(title || "").trim()}**\n\n${colorizeIpLine(text)}`,
    },
  };
}

/**
 * 把正文里的「🟥 当前 IP：x」整行染成 warning 色（仅企微 markdown 支持）。
 * 其它渠道拿到的都是剥过标签的纯文本，所以这里可以放心加。
 */
function colorizeIpLine(text) {
  return String(text == null ? "" : text).replace(
    /^🟥[^\n]*$/gm,
    (line) => `<font color="warning">${line}</font>`
  );
}

/**
 * 企业微信**纯文本**消息体（关掉 markdown 时用）。
 *
 * 为什么要这个：企微群消息可以被转发到**微信客户端**，而微信不支持 markdown ——
 * markdown 消息在微信里会原样显示成「**标题**」「`当前 IP`」这种带标记的裸文本，
 * 读起来很脏。关掉后走 msgtype=text，标记全部剥掉，只留干净的文本与换行。
 *
 * ⚠️ 剥标记必须保留换行（用 stripMarksKeepLines，不是 stripMarkdown）——
 *    stripMarkdown 会把换行也压成空格，正文会糊成一整段。
 *
 * @param {string} title 标题（text 类型没有 title 字段，放正文首行）
 * @param {string} text  已加工好的 markdown 正文
 */
function weworkTextBody(title, text) {
  const plain = stripMarksKeepLines(text);
  return {
    msgtype: "text",
    text: {
      content: `${String(title || "").trim()}\n\n${plain}`,
    },
  };
}

/**
 * 飞书 interactive 卡片消息体。
 *
 * 官方文档（open.feishu.cn「自定义机器人使用指南」）：
 *   飞书**没有** markdown 消息类型，要markdown 就得用 interactive 卡片里的
 *   `markdown` 元素：{ "msg_type": "interactive",
 *                 "card": { "header": {"title": {"tag":"plain_text",...}},
 *                           "elements": [{"tag":"markdown","content":"..."}] } }
 *   - header 可选；不传时整张卡片没有标题
 *   - card 宽默认下是「两栏」布局，内容过多会被折叠（展开后才是完整宽度）
 */
function feishuBody(title, text) {
  const elements = [{ tag: "markdown", content: text }];
  const card = { elements };
  const t = String(title || "").trim();
  if (t) {
    card.header = {
      title: { tag: "plain_text", content: t },
      // 蓝底白字：与其它两家标题的视觉重量一致
      template: "blue",
    };
  }
  return { msg_type: "interactive", card };
}

/**
 * 剥掉 markdown 标记但**保留换行与段落结构**（用于版式断言 / 日志可读性）。
 *
 * ⚠️ 不要用 stripMarkdown 做这件事：它末尾把连续空白压成单个空格
 *    （那是为了关键词匹配与长度估算），会把多行正文压成一行，
 *    版式断言会全部失效。
 *
 * @param {string} s
 * @returns {string}
 */
function stripMarksKeepLines(s) {
  // 与 stripMarkdown 共用 stripEmphasis（同样的迭代到稳定处理），
  // 差别只在保留换行：这里不能把 \s+ 压成空格。
  return stripEmphasis(
    String(s == null ? "" : s)
      .replace(/`{1,3}([^`]*)`{1,3}/g, "$1")
      .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
      .replace(/^#{1,6}\s+/gm, "")
      .replace(/^>\s?/gm, "")
      .replace(/^[-*+]\s+/gm, "")
      .replace(/^\d+\.\s+/gm, "")
      .replace(/<[^>]+>/g, "")
  )
    .replace(/[ \t]+$/gm, "")
    // 同 stripMarkdown：剥掉裸尖括号（CodeQL #18/#19）。
    // 一言来自 hitokoto 第三方 API，净化链不能假设输入里没有标签。
    .replace(/[<>]/g, "")
    .trim();
}

module.exports = {
  LINE_HINT,
  stripMarkdown,
  stripMarksKeepLines,
  toBlocks,
  matchKeyValue,
  renderKeyValue,
  wrapLongLine,
  buildMarkdown,
  dingdingBody,
  weworkBody,
  weworkTextBody,
  feishuBody,
};