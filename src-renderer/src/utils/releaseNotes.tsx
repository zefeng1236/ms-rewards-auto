import type { ReactNode } from "react";

/**
 * 更新日志的 Markdown-lite 渲染（纯 React 节点，不走 innerHTML）
 *
 * ## 为什么不自己写而不用现成的库
 *
 * 更新日志的内容**完全由我们自己写**（CHANGELOG.md → GitHub Release 正文），
 * 不是用户输入，也不是第三方内容。真正的 XSS 面只有「上游仓库被投毒 / 镜像被劫持」
 * 这一条，而那条一旦成立，攻击者本来就能改二进制包，注入 HTML 并不扩大影响面。
 * 为了显示几百字更新日志引入 marked + DOMPurify（约 200KB）不划算。
 *
 * 关键约束：**绝不 innerHTML / dangerouslySetInnerHTML** —— 全部转成 React 节点，
 * 这样即便内容里有 `<script>` 也只会当文本显示。
 *
 * ## 支持的语法（够用即止，够写更新日志就行）
 *
 *   # ~ ####  标题（带 `####标题` 无空格的粘连写法，这是 Release 正文最常见的形态）
 *   - * •     无序列表（支持缩进嵌套）
 *   1. 2.     有序列表（编号不必连续）
 *   >         引用块（可含粗体 / 行内代码 / 链接）
 *   ```       围栏代码块（内部一律原样，绝不解析）
 *   | a | b | 表格（自动跳过 |---|---| 分隔行）
 *   ---        分隔线
 *
 *   行内：`code`  **bold**  [text](url)  *italic*  ~~deleted~~
 *
 * 行内链接的 href 会被过滤：**只放行 http/https**，挡掉 `javascript:` / `data:`。
 */

/** href 安全过滤：只允许 http/https，挡掉 javascript: / data: / vbscript: 等 */
function safeHref(url: string): string | null {
  const u = String(url || "").trim();
  if (!u) return null;
  // 相对链接在 Electron 里没意义（不走web 服务器），直接当普通文本处理
  if (!/^https?:\/\//i.test(u)) return null;
  return u;
}

/** 把 `[text](url)` 里的 url 拆出来，处理带括号的 URL 与 title */
function parseLinkTarget(raw: string): { text: string; url: string } | null {
  // 末尾的 "title" 或 'title' 去掉
  const body = raw.replace(/\s+["'][^"']*["']\s*$/, "").trim();
  const m = /^(.*)\(([^)\s]+)\)$/.exec(body);
  if (!m) return null;
  return { text: m[1], url: m[2] };
}

/**
 * 行内解析：`` `code` `` / `**bold**` / `*italic*` / `~~del~~` / `[text](url)`
 *
 * 单趟扫描 + 递归处理链接文字，所以 `**[链接](url)**` 这类嵌套也能正确渲染。
 */
export function renderInline(text: string, keyBase: string): ReactNode[] {
  const src = String(text ?? "");
  const out: ReactNode[] = [];
  // 顺序很重要：代码优先，避免 `**` 出现在代码里被误当粗体
  const re = /(`[^`]+`)|(\*\*[^*]+\*\*)|(~~[^~]+~~)|(\[[^\]]+\]\([^)]+\))|(\*[^*\n]+\*)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;

  const pushPlain = (s: string) => {
    if (s) out.push(s);
  };

  while ((m = re.exec(src))) {
    pushPlain(src.slice(last, m.index));
    const tok = m[0];
    if (tok.startsWith("`")) {
      out.push(<code key={`${keyBase}-c${i++}`}>{tok.slice(1, -1)}</code>);
    } else if (tok.startsWith("**")) {
      // ⚠️ 必须递归解析内部：`**[name](url)**` 这种「链接套粗体」在更新日志里很常见
      //（致谢段全是这个形态）。若直接把内层当纯文本，整块会变成
      //「粗体里显示着 [name](url) 的原始语法」，链接直接消失。
      out.push(<strong key={`${keyBase}-b${i++}`}>{renderInline(tok.slice(2, -2), `${keyBase}-b${i}`)}</strong>);
    } else if (tok.startsWith("~~")) {
      out.push(<del key={`${keyBase}-d${i++}`}>{renderInline(tok.slice(2, -2), `${keyBase}-d${i}`)}</del>);
    } else if (tok.startsWith("[")) {
      // ⚠️ 去掉首 `[` 与**末尾的 `)`** —— 末尾切掉的是链接 URL 的右括号，
      // 所以剩下的串是以 `(` 结尾的（`text(url)`），不是以 `)` 结尾。
      // 写成 slice(1,-1) 再按 `(...)` 匹配会永远匹配不上（实测 `[^)\s]+` 取不到 URL）。
      const parsed = parseLinkTarget(tok.slice(1, -1) + ")");
      const href = parsed && safeHref(parsed.url);
      if (parsed && href) {
        out.push(
          <a key={`${keyBase}-a${i++}`} href={href} target="_blank" rel="noreferrer">
            {/* 链接文字本身可能含 **bold**，递归解析 */}
            {renderInline(parsed.text, `${keyBase}-a${i}`)}
          </a>
        );
      } else {
        // 危险协议或解析失败 → 当普通文本，绝不渲染成可点链接
        pushPlain(tok);
      }
    } else {
      out.push(<em key={`${keyBase}-i${i++}`}>{tok.slice(1, -1)}</em>);
    }
    last = m.index + tok.length;
  }
  pushPlain(src.slice(last));
  return out;
}

/** 表格单元格：转义竖线（`\|`）后按 `|` 切分 */
function splitTableRow(line: string): string[] {
  let s = line.trim();
  s = s.replace(/^\|/, "").replace(/\|$/, "");
  const cells: string[] = [];
  let cur = "";
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === "\\" && s[i + 1] === "|") {
      cur += "|";
      i++;
      continue;
    }
    if (ch === "|") {
      cells.push(cur.trim());
      cur = "";
      continue;
    }
    cur += ch;
  }
  cells.push(cur.trim());
  return cells;
}

/** `|---|---|` 这类分隔行 */
function isTableDivider(line: string): boolean {
  const s = line.trim();
  if (!/^\|?[\s:|-]+\|[\s:|-]*$/.test(s)) return false;
  return s.includes("-");
}

/** 超出两层的一律压到最深一层 */
type ListItem = { depth: number; text: string };

export function renderNotes(md: string): ReactNode {
  const lines = String(md ?? "").replace(/\r/g, "").split("\n");
  const blocks: ReactNode[] = [];
  let key = 0;

  let ul: ListItem[] = [];
  let ol: ListItem[] = [];
  /** 引用块缓存：连续 `>` 行合并成一个块 */
  let quote: string[] = [];

  const flushUl = () => {
    if (!ul.length) return;
    const items = ul;
    ul = [];
    blocks.push(renderList(items, "ul", key++));
  };
  const flushOl = () => {
    if (!ol.length) return;
    const items = ol;
    ol = [];
    blocks.push(renderList(items, "ol", key++));
  };
  const flushQuote = () => {
    if (!quote.length) return;
    const src = quote.join("\n");
    quote = [];
    blocks.push(
      <blockquote key={`q${key++}`} className="upd-note-q">
        {renderNotes(src)}
      </blockquote>
    );
  };
  const flushAll = () => {
    flushUl();
    flushOl();
    flushQuote();
  };

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const line = raw.replace(/\s+$/, "");
    const t = line.trim();

    // 围栏代码块：内部原样，绝不解析任何 Markdown
    const fence = /^```+\s*([\w+-]*)\s*$/.exec(t);
    if (fence) {
      flushAll();
      const lang = fence[1];
      const buf: string[] = [];
      i++;
      for (; i < lines.length; i++) {
        if (/^```+\s*$/.test(lines[i].trim())) break;
        buf.push(lines[i]);
      }
      blocks.push(
        <pre key={`pre${key++}`} className="upd-note-pre" data-lang={lang || undefined}>
          <code>{buf.join("\n")}</code>
        </pre>
      );
      continue;
    }

    if (!t) {
      flushAll();
      continue;
    }

    // 表格：当前行是 `|`，则向下收集到非表格行为止
    if (t.startsWith("|")) {
      flushAll();
      const rows: string[][] = [splitTableRow(t)];
      let j = i + 1;
      // 表头
      if (j < lines.length && isTableDivider(lines[j])) {
        j++;
        for (; j < lines.length && lines[j].trim().startsWith("|"); j++) {
          rows.push(splitTableRow(lines[j]));
        }
        const head = rows[0];
        const body = rows.slice(1);
        blocks.push(
          <table key={`tb${key++}`} className="upd-note-table">
            <thead>
              <tr>
                {head.map((c, ci) => (
                  <th key={ci}>{renderInline(c, `th${key}-${ci}`)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {body.map((r, ri) => (
                <tr key={ri}>
                  {r.map((c, ci) => (
                    <td key={ci}>{renderInline(c, `td${key}-${ri}-${ci}`)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        );
        i = j - 1;
        continue;
      }
      // 没有分隔行 → 当普通段落（避免把非表格的竖线文本误判成表格）
      blocks.push(
        <p key={`p${key++}`} className="upd-note-p">
          {renderInline(t, `p${key}`)}
        </p>
      );
      continue;
    }

    // 分隔线
    if (/^(-\s*){3,}$/.test(t) || /^(\*\s*){3,}$/.test(t) || /^(_\s*){3,}$/.test(t)) {
      flushAll();
      blocks.push(<hr key={`hr${key++}`} className="upd-note-hr" />);
      continue;
    }

    // 标题：容忍 Release 正文里常见的 `####标题`（# 与文字之间没空格）
    const h = /^(#{1,6})\s*(.+)$/.exec(t);
    if (h) {
      flushAll();
      const level = Math.min(h[1].length, 4);
      const Tag = (["", "h2", "h3", "h4", "h4"] as const)[level] || "h4";
      blocks.push(
        <Tag key={`h${key++}`} className={`upd-note-h upd-note-h${level}`}>
          {renderInline(h[2].replace(/\s*#+\s*$/, ""), `h${key}`)}
        </Tag>
      );
      continue;
    }

    // 引用块
    const q = /^>\s?(.*)$/.exec(t);
    if (q) {
      flushUl();
      flushOl();
      quote.push(q[1]);
      continue;
    }

    // 无序列表：`-` / `*` / `•`，缩进即层级
    const uli = /^([-*•])\s+(.*)$/.exec(t);
    if (uli) {
      flushOl();
      flushQuote();
      const depth = Math.min(Math.floor((raw.match(/^\s*/)?.[0].length || 0) / 2), 2);
      ul.push({ depth, text: uli[2] });
      continue;
    }

    // 有序列表：`1.` / `1)`
    const oli = /^(\d+)[.)]\s+(.*)$/.exec(t);
    if (oli) {
      flushUl();
      flushQuote();
      const depth = Math.min(Math.floor((raw.match(/^\s*/)?.[0].length || 0) / 3), 2);
      ol.push({ depth, text: oli[2] });
      continue;
    }

    // 普通段落
    flushAll();
    blocks.push(
      <p key={`p${key++}`} className="upd-note-p">
        {renderInline(t, `p${key}`)}
      </p>
    );
  }
  flushAll();
  return blocks;
}

/** 按 depth 分层渲染列表；超出两层的一律压到最深一层 */
function renderList(items: ListItem[], tag: "ul" | "ol", key: number): ReactNode {
  // 先按 depth 切段
  const segs: { depth: number; items: ListItem[] }[] = [];
  for (const it of items) {
    const lastSeg = segs[segs.length - 1];
    if (lastSeg && lastSeg.depth === it.depth) lastSeg.items.push(it);
    else segs.push({ depth: it.depth, items: [it] });
  }
  if (!segs.length) return null;

  const build = (segIdx: number): ReactNode => {
    const seg = segs[segIdx];
    const Tag = tag;
    return (
      <Tag key={`${tag}${key}-${segIdx}`} className={seg.depth > 0 ? `upd-note-list-nested d${seg.depth}` : undefined}>
        {seg.items.map((it, i) => (
          <li key={`${tag}${key}-${segIdx}-${i}`}>
            {renderInline(it.text, `li${key}-${segIdx}-${i}`)}
            {/* 下一段缩进更深 → 作为本项的子列表 */}
            {segIdx + 1 < segs.length && segs[segIdx + 1].depth > seg.depth ? (
              <>{build(segIdx + 1)}</>
            ) : null}
          </li>
        ))}
      </Tag>
    );
  };

  return build(0);
}

/**
 * 白盒测试出口：把内部纯函数导出，供 selfcheck / 验证脚本直接断言。
 *
 * 这些函数本身是正确的实现主体、无 React 依赖（只有 renderNotes/renderInline 依赖），
 * 导出它们让「href 是否拦得住 javascript:」这类安全断言能直接跑真实代码，
 * 而不是在测试脚本里**手抄一份副本**—— 上一版测试就是这么翻车的：
 * 副本与实现漂移，5 项失败里 4 项其实是测试自己写错。
 */
export const __test = { safeHref, parseLinkTarget, splitTableRow, isTableDivider };