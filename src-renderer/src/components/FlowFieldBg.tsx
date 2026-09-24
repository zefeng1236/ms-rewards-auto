import { useEffect, useRef } from "react";

/**
 * 流场粒子背景（Afterglow 流场研究）。
 *
 * 从参考稿 flow-field.html 提取：一个基于 Perlin 噪声的流场，
 * 6400 个粒子沿场方向漂移，共同绘出丝绸般的流动线条；指针划过
 * 会在场中搅起尾流。这里做成纯装饰层：
 *   - pointer-events:none，永远垫在最底、不拦截任何交互；
 *   - 颜色收暗、叠一层 project-scrim 保证文字可读；
 *   - 页面隐藏 / 无精度计时时自动节能。
 */

// 珊瑚 / 琥珀 / 品红 / 靛蓝 四色（与参考稿一致）
const COLORS = ["#ff795f", "#ffc16c", "#ec6fa9", "#8989ff"];
// 生成艺术用背景色（深紫黑，深色主题观感最稳）
const BG = "#120e18";

const COUNT = 3800; // 桌面够用，比参考稿 6400 略降以省低端 CPU
const GRID = 24;
const POINTER_RADIUS = 300;
const WAKE_LENGTH = 175;

export function FlowFieldBg() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    // 提升函数（function resize()）里 TS 不继承外层窄化，显式固化成非空引用
    const surface: HTMLCanvasElement = canvas;
    const ctx = canvas.getContext("2d", { alpha: false, desynchronized: true });
    if (!ctx) return;

    let width = 0;
    let height = 0;
    let dpr = 1;
    let seed = 0;
    let perm = new Uint8Array(512);
    let field = new Float32Array(0);
    let fieldCols = 0;
    let fieldRows = 0;
    let particles: any[] = [];
    let random: () => number = Math.random;
    let lastFrame = performance.now();
    let raf = 0;
    let pointerX = -1000;
    let pointerY = -1000;
    let pointerDirX = 0;
    let pointerDirY = 0;
    let pointerEnergy = 0;
    let pointerInside = false;
    let pointerLast = 0;

    function mulberry32(a: number) {
      return function () {
        let t = (a += 0x6d2b79f5);
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };
    }

    function initNoise(s: number) {
      const r = mulberry32(s);
      const p = Array.from({ length: 256 }, (_, i) => i);
      for (let i = 255; i > 0; i--) {
        const j = (r() * (i + 1)) | 0;
        [p[i], p[j]] = [p[j], p[i]];
      }
      for (let i = 0; i < 512; i++) perm[i] = p[i & 255];
    }

    const fade = (t: number) => t * t * t * (t * (t * 6 - 15) + 10);
    const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

    function grad(h: number, x: number, y: number) {
      switch (h & 7) {
        case 0: return x + y;
        case 1: return -x + y;
        case 2: return x - y;
        case 3: return -x - y;
        case 4: return x;
        case 5: return -x;
        case 6: return y;
        default: return -y;
      }
    }

    function noise(x: number, y: number) {
      const X = Math.floor(x) & 255;
      const Y = Math.floor(y) & 255;
      const xf = x - Math.floor(x);
      const yf = y - Math.floor(y);
      const u = fade(xf);
      const v = fade(yf);
      const aa = perm[perm[X] + Y];
      const ab = perm[perm[X] + Y + 1];
      const ba = perm[perm[X + 1] + Y];
      const bb = perm[perm[X + 1] + Y + 1];
      return lerp(
        lerp(grad(aa, xf, yf), grad(ba, xf - 1, yf), u),
        lerp(grad(ab, xf, yf - 1), grad(bb, xf - 1, yf - 1), u),
        v
      );
    }

    function buildField() {
      fieldCols = Math.ceil(width / GRID) + 2;
      fieldRows = Math.ceil(height / GRID) + 2;
      field = new Float32Array(fieldCols * fieldRows);
      const scale = 3.1 / Math.min(width, height);
      const ox = (seed % 997) * 0.013;
      const oy = (seed % 577) * 0.017;
      for (let gy = 0; gy < fieldRows; gy++) {
        for (let gx = 0; gx < fieldCols; gx++) {
          const x = gx * GRID * scale + ox;
          const y = gy * GRID * scale + oy;
          const a = noise(x, y);
          const b = noise(x + 31.7, y + 18.2);
          let dx = b;
          let dy = -a;
          const m = Math.hypot(dx, dy) || 1;
          field[gy * fieldCols + gx] = Math.atan2(dy / m, dx / m);
        }
      }
    }

    function sampleAngle(x: number, y: number) {
      const gx = Math.min(fieldCols - 1, Math.max(0, x / GRID));
      const gy = Math.min(fieldRows - 1, Math.max(0, y / GRID));
      const x0 = Math.floor(gx);
      const y0 = Math.floor(gy);
      const x1 = Math.min(fieldCols - 1, x0 + 1);
      const y1 = Math.min(fieldRows - 1, y0 + 1);
      const tx = gx - x0;
      const ty = gy - y0;
      const a = field[y0 * fieldCols + x0];
      const b = field[y0 * fieldCols + x1];
      const c = field[y1 * fieldCols + x0];
      const d = field[y1 * fieldCols + x1];
      const vx = lerp(lerp(Math.cos(a), Math.cos(b), tx), lerp(Math.cos(c), Math.cos(d), tx), ty);
      const vy = lerp(lerp(Math.sin(a), Math.sin(b), tx), lerp(Math.sin(c), Math.sin(d), tx), ty);
      return Math.atan2(vy, vx);
    }

    function spawn(p: any, initial: boolean) {
      p.x = random() * width;
      p.y = random() * height;
      p.life = 130 + random() * 410;
      p.age = initial ? random() * p.life : 0;
      p.speed = 0.6 + random() * 1.1;
      p.vx = 0;
      p.vy = 0;
      p.hue = (random() * 4) | 0;
      p.prevX = p.x;
      p.prevY = p.y;
    }

    function initParticles() {
      particles = new Array(COUNT);
      for (let i = 0; i < COUNT; i++) {
        const p: any = {};
        spawn(p, true);
        particles[i] = p;
      }
    }

    function resize() {
      const oldW = width || window.innerWidth;
      const oldH = height || window.innerHeight;
      width = window.innerWidth;
      height = window.innerHeight;
      dpr = Math.min(window.devicePixelRatio || 1, 1.6);
      surface.width = Math.round(width * dpr);
      surface.height = Math.round(height * dpr);
      surface.style.width = width + "px";
      surface.style.height = height + "px";
      ctx!.setTransform(dpr, 0, 0, dpr, 0, 0);
      if (particles.length) {
        for (const p of particles) {
          p.x *= width / oldW;
          p.y *= height / oldH;
          p.prevX = p.x;
          p.prevY = p.y;
        }
      }
      buildField();
      ctx!.fillStyle = BG;
      ctx!.fillRect(0, 0, width, height);
    }

    function frame(now: number) {
      raf = requestAnimationFrame(frame);
      if (document.hidden) return;
      const delta = Math.min(2, (now - lastFrame) / 16.667 || 1);
      lastFrame = now;

      const pointerFade = pointerInside ? 1 : 0;
      pointerEnergy *= pointerFade ? 0.975 : 0.982;
      const pointerStrength = pointerEnergy;

      ctx!.globalCompositeOperation = "source-over";
      ctx!.fillStyle = "rgba(18,14,24,0.04)";
      ctx!.fillRect(0, 0, width, height);
      ctx!.globalCompositeOperation = "lighter";

      const paths: number[][] = [[], [], [], []];
      for (const p of particles) {
        p.prevX = p.x;
        p.prevY = p.y;
        const angle = sampleAngle(p.x, p.y);
        const baseX = Math.cos(angle) * p.speed;
        const baseY = Math.sin(angle) * p.speed;
        let pushX = 0;
        let pushY = 0;
        const dx = p.x - pointerX;
        const dy = p.y - pointerY;
        const forward = dx * pointerDirX + dy * pointerDirY;
        const side = dx * pointerDirY - dy * pointerDirX;
        const radial2 = dx * dx + dy * dy;
        const wakeSide = side - (forward > 0 ? 0 : forward * 0.18);
        const wake2 =
          forward < WAKE_LENGTH && forward > -150
            ? (wakeSide * wakeSide) / (1 + Math.max(0, -forward) * 0.004) +
              Math.max(0, forward) * Math.max(0, forward) * 0.16
            : Infinity;
        if (pointerStrength > 0.003 && radial2 < POINTER_RADIUS * POINTER_RADIUS) {
          const dist = Math.sqrt(radial2);
          const falloff = 1 - dist / POINTER_RADIUS;
          const weight = pointerStrength * falloff * falloff;
          const inverse = 1 / (dist || 1);
          const radial = weight * 0.22;
          const swirl = weight * 0.34;
          pushX += dx * inverse * radial - dy * inverse * swirl;
          pushY += dy * inverse * radial + dx * inverse * swirl;
        }
        if (pointerStrength > 0.003 && wake2 < 125 * 125) {
          const wake =
            pointerStrength * Math.pow(1 - Math.sqrt(wake2) / 125, 2) * Math.exp(-Math.max(0, forward) / WAKE_LENGTH);
          const sideForce = Math.sign(side || 1) * wake * 1.15;
          pushX += pointerDirX * wake * 2.1 + pointerDirY * sideForce;
          pushY += pointerDirY * wake * 2.1 - pointerDirX * sideForce;
        }
        p.vx = (p.vx + pushX * delta) * 0.88;
        p.vy = (p.vy + pushY * delta) * 0.88;
        const inertia = Math.hypot(p.vx, p.vy);
        if (inertia > 4.2) {
          p.vx *= 4.2 / inertia;
          p.vy *= 4.2 / inertia;
        }
        const vx = (baseX + p.vx) * delta;
        const vy = (baseY + p.vy) * delta;
        p.x += vx;
        p.y += vy;
        p.age += delta;
        if (p.x < 0 || p.x > width || p.y < 0 || p.y > height || p.age > p.life) {
          spawn(p, false);
          continue;
        }
        paths[p.hue].push(p.prevX, p.prevY, p.x, p.y);
      }

      for (let c = 0; c < 4; c++) {
        const a = paths[c];
        if (!a.length) continue;
        ctx!.beginPath();
        for (let i = 0; i < a.length; i += 4) {
          ctx!.moveTo(a[i], a[i + 1]);
          ctx!.lineTo(a[i + 2], a[i + 3]);
        }
        ctx!.strokeStyle = COLORS[c];
        // 收暗线条：作为 UI 底衬，不能抢界面焦点
        ctx!.globalAlpha = (c === 0 ? 0.36 : c === 1 ? 0.32 : c === 2 ? 0.28 : 0.25);
        ctx!.lineWidth = c === 3 ? 0.8 : 0.9;
        ctx!.stroke();
      }
      ctx!.globalAlpha = 1;
      ctx!.globalCompositeOperation = "source-over";
    }

    function updatePointer(event: PointerEvent) {
      const now = performance.now();
      const x = event.clientX;
      const y = event.clientY;
      const elapsed = Math.max(8, now - pointerLast);
      if (pointerLast) {
        const dx = x - pointerX;
        const dy = y - pointerY;
        const m = Math.hypot(dx, dy);
        if (m > 0.5 && m < POINTER_RADIUS * 1.25) {
          pointerDirX = dx / m;
          pointerDirY = dy / m;
          pointerEnergy = Math.min(1.35, Math.max(pointerEnergy, Math.min(1.2, m / 34 + Math.hypot(dx / elapsed, dy / elapsed) * 2.1)));
        }
      }
      pointerX = x;
      pointerY = y;
      pointerLast = now;
      pointerInside = true;
    }

    // 具名处理器：卸载时必须能真正 removeEventListener（匿名函数等于没解绑）
    const onLeave = () => {
      pointerInside = false;
      pointerEnergy *= 0.55;
    };
    const onVisibility = () => {
      // 页面切回前台时重置时间基准，避免 delta 累积成一大跳
      lastFrame = performance.now();
    };
    window.addEventListener("pointermove", updatePointer, { passive: true });
    window.addEventListener("pointerleave", onLeave, { passive: true });
    window.addEventListener("resize", resize, { passive: true });
    document.addEventListener("visibilitychange", onVisibility);

    resize();
    seed = (crypto.getRandomValues(new Uint32Array(1))[0] >>> 0);
    random = mulberry32(seed);
    initNoise(seed);
    buildField();
    initParticles();
    raf = requestAnimationFrame(frame);

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("pointermove", updatePointer);
      window.removeEventListener("pointerleave", onLeave);
      window.removeEventListener("resize", resize);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);

  return <canvas ref={canvasRef} className="flow-bg" aria-hidden="true" />;
}