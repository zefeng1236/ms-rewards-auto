import { useEffect, useRef } from "react";

/**
 * 流场粒子背景（登录页 / 初始化向导，authBg = flow）。
 *
 * 视觉取自参考稿 flow-field-art.html：改进版 3D Perlin 噪声场（z 轴随时间演化，
 * 场本身会缓慢流动），6000 个粒子沿场方向漂移，按「颜色 × 生命透明度档」
 * 合批描线，拖出丝绸般的流痕；日落八色 + 行内淡出 + 近黑水洗拖尾。
 *
 * 互动沿用本组件既有的指针尾流（项目自有，参考稿没有）：指针划过会在场中
 * 搅起径向推力 + 旋涡 + 移动方向尾流。纯装饰层：
 *   - canvas 与暗角层都 pointer-events:none，永远垫在最底、不拦截任何交互；
 *   - 不挂键盘快捷键 —— 登录页要输主密码，R/S 会抢输入（参考稿是独立艺术页，
 *     没有这个约束，不能照搬）；
 *   - 页面隐藏时自动节能，切回前台重置时间基准。
 */

// 日落八色（与参考稿一致）：珊瑚 / 琥珀 / 品红 / 靛蓝 / 暖金 / 浅珊瑚 / 深靛蓝 / 亮品红
const PALETTE: readonly (readonly [number, number, number])[] = [
  [255, 107, 107],
  [255, 176, 102],
  [255, 95, 176],
  [112, 96, 255],
  [255, 209, 138],
  [255, 138, 120],
  [72, 64, 214],
  [246, 120, 190],
];
// 生成艺术用背景色（近黑，参考稿同值；深色主题观感最稳）
const BG = "#07070c";
// 拖尾残留：近黑水洗让流痕逐帧累积而不是被秒清
const FADE = "rgba(7,7,12,0.045)";

const COUNT = 6000; // 参考稿同值；typed-array + 合批描线比旧的对象逐粒子画法省得多
const NOISE_SCALE = 0.0026; // 噪声空间频率
const TURB = 2.6; // 噪声 → 角度倍率（弧度）
const TIME_STEP = 0.0014; // 每帧场演化量
const LINE_W = 1.25;
const TIERS = [0.05, 0.1, 0.17]; // 按生命值的三档线透明度（sin 淡入淡出）

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
    let seed = 0;
    let frame = 0;
    let lastFrame = performance.now();
    let raf = 0;

    // 指针尾流状态
    let pointerX = -1000;
    let pointerY = -1000;
    let pointerDirX = 0;
    let pointerDirY = 0;
    let pointerEnergy = 0;
    let pointerInside = false;
    let pointerLast = 0;

    /* ================= seeded RNG（mulberry32） ================= */
    function mulberry32(a: number) {
      return function () {
        let t = (a += 0x6d2b79f5);
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };
    }

    /* ================= improved Perlin（3D，种子化） ================= */
    class Perlin {
      private perm = new Uint8Array(512);
      constructor(s: number) {
        const rnd = mulberry32(s);
        const p = new Uint8Array(256);
        for (let i = 0; i < 256; i++) p[i] = i;
        for (let i = 255; i > 0; i--) {
          const j = (rnd() * (i + 1)) | 0;
          const tmp = p[i];
          p[i] = p[j];
          p[j] = tmp;
        }
        for (let i = 0; i < 512; i++) this.perm[i] = p[i & 255];
      }
      private fade(t: number) {
        return t * t * t * (t * (t * 6 - 15) + 10);
      }
      private lerp(a: number, b: number, t: number) {
        return a + t * (b - a);
      }
      private grad(h: number, x: number, y: number, z: number) {
        h &= 15;
        const u = h < 8 ? x : y;
        const v = h < 4 ? y : h === 12 || h === 14 ? x : z;
        return ((h & 1) === 0 ? u : -u) + ((h & 2) === 0 ? v : -v);
      }
      noise(x: number, y: number, z: number) {
        const perm = this.perm;
        const X = Math.floor(x) & 255;
        const Y = Math.floor(y) & 255;
        const Z = Math.floor(z) & 255;
        const xf = x - Math.floor(x);
        const yf = y - Math.floor(y);
        const zf = z - Math.floor(z);
        const u = this.fade(xf);
        const v = this.fade(yf);
        const w = this.fade(zf);
        const A = perm[X] + Y;
        const AA = perm[A] + Z;
        const AB = perm[A + 1] + Z;
        const B = perm[X + 1] + Y;
        const BA = perm[B] + Z;
        const BB = perm[B + 1] + Z;
        return this.lerp(
          this.lerp(
            this.lerp(this.grad(perm[AA], xf, yf, zf), this.grad(perm[BA], xf - 1, yf, zf), u),
            this.lerp(this.grad(perm[AB], xf, yf - 1, zf), this.grad(perm[BB], xf - 1, yf - 1, zf), u),
            v
          ),
          this.lerp(
            this.lerp(this.grad(perm[AA + 1], xf, yf, zf - 1), this.grad(perm[BA + 1], xf - 1, yf, zf - 1), u),
            this.lerp(this.grad(perm[AB + 1], xf, yf - 1, zf - 1), this.grad(perm[BB + 1], xf - 1, yf - 1, zf - 1), u),
            v
          ),
          w
        );
      }
    }

    /* ================= 粒子系统（typed arrays） ================= */
    const PX = new Float32Array(COUNT);
    const PY = new Float32Array(COUNT);
    const QX = new Float32Array(COUNT); // 上一帧位置（描线起点）
    const QY = new Float32Array(COUNT);
    const LIFE = new Float32Array(COUNT);
    const MAXL = new Float32Array(COUNT);
    const SPD = new Float32Array(COUNT);
    const COL = new Uint8Array(COUNT);
    const PVX = new Float32Array(COUNT); // 指针尾流带来的速度
    const PVY = new Float32Array(COUNT);

    const NB = PALETTE.length * TIERS.length;
    const BDATA: Float32Array[] = [];
    const BCNT = new Int32Array(NB);
    for (let b = 0; b < NB; b++) BDATA.push(new Float32Array(COUNT * 4));

    const styles: string[][] = [];
    for (let c = 0; c < PALETTE.length; c++) {
      styles[c] = [];
      for (let t = 0; t < TIERS.length; t++) {
        styles[c][t] = `rgba(${PALETTE[c][0]},${PALETTE[c][1]},${PALETTE[c][2]},${TIERS[t]})`;
      }
    }

    let noise = new Perlin(1);
    let rng = mulberry32(1);

    function spawn(i: number) {
      PX[i] = rng() * width;
      PY[i] = rng() * height;
      QX[i] = PX[i];
      QY[i] = PY[i];
      SPD[i] = 0.7 + rng() * 1.3;
      LIFE[i] = 0;
      MAXL[i] = 240 + rng() * 560;
      COL[i] = (rng() * PALETTE.length) | 0;
      PVX[i] = 0;
      PVY[i] = 0;
    }

    function init(keepSeed: boolean) {
      if (!keepSeed) seed = crypto.getRandomValues(new Uint32Array(1))[0] >>> 0;
      noise = new Perlin(seed);
      rng = mulberry32((seed ^ 0x5f3759df) >>> 0);
      for (let i = 0; i < COUNT; i++) spawn(i);
      ctx!.globalCompositeOperation = "source-over";
      ctx!.fillStyle = BG;
      ctx!.fillRect(0, 0, width, height);
      frame = 0;
      BCNT.fill(0);
    }

    /* ================= 帧 ================= */
    function step(delta: number) {
      /* 拖尾水洗：近黑半透明覆盖，让流痕保留并逐帧累积 */
      ctx!.globalCompositeOperation = "source-over";
      ctx!.fillStyle = FADE;
      ctx!.fillRect(0, 0, width, height);

      ctx!.globalCompositeOperation = "lighter";
      ctx!.lineWidth = LINE_W;
      ctx!.lineCap = "round";

      const t = frame * TIME_STEP;
      for (let b = 0; b < NB; b++) BCNT[b] = 0;

      const pointerFade = pointerInside ? 1 : 0;
      pointerEnergy *= pointerFade ? 0.975 : 0.982;
      const pointerStrength = pointerEnergy;

      for (let i = 0; i < COUNT; i++) {
        QX[i] = PX[i];
        QY[i] = PY[i];
        const a = noise.noise(PX[i] * NOISE_SCALE, PY[i] * NOISE_SCALE, t) * TURB;
        const baseX = Math.cos(a) * SPD[i];
        const baseY = Math.sin(a) * SPD[i];

        /* 指针尾流：径向推力 + 旋涡 + 移动方向尾流（项目既有互动） */
        let pushX = 0;
        let pushY = 0;
        const dx = PX[i] - pointerX;
        const dy = PY[i] - pointerY;
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
            pointerStrength *
            Math.pow(1 - Math.sqrt(wake2) / 125, 2) *
            Math.exp(-Math.max(0, forward) / WAKE_LENGTH);
          const sideForce = Math.sign(side || 1) * wake * 1.15;
          pushX += pointerDirX * wake * 2.1 + pointerDirY * sideForce;
          pushY += pointerDirY * wake * 2.1 - pointerDirX * sideForce;
        }
        PVX[i] = (PVX[i] + pushX * delta) * 0.88;
        PVY[i] = (PVY[i] + pushY * delta) * 0.88;
        const inertia = Math.hypot(PVX[i], PVY[i]);
        if (inertia > 4.2) {
          PVX[i] *= 4.2 / inertia;
          PVY[i] *= 4.2 / inertia;
        }

        PX[i] += (baseX + PVX[i]) * delta;
        PY[i] += (baseY + PVY[i]) * delta;
        LIFE[i] += delta;
        if (
          PX[i] < -24 ||
          PX[i] > width + 24 ||
          PY[i] < -24 ||
          PY[i] > height + 24 ||
          LIFE[i] > MAXL[i]
        ) {
          spawn(i);
          continue;
        }
        const p = LIFE[i] / MAXL[i];
        const alpha = Math.sin(p * Math.PI);
        const tier = alpha < 0.38 ? 0 : alpha < 0.72 ? 1 : 2;
        const bi = COL[i] * TIERS.length + tier;
        const d = BDATA[bi];
        const o = BCNT[bi] * 4;
        d[o] = QX[i];
        d[o + 1] = QY[i];
        d[o + 2] = PX[i];
        d[o + 3] = PY[i];
        BCNT[bi]++;
      }

      /* 合批描线：每个「颜色 × 透明度档」一条 path，24 次 stroke 画完 6000 段 */
      for (let b = 0; b < NB; b++) {
        const n = BCNT[b];
        if (!n) continue;
        const dd = BDATA[b];
        ctx!.strokeStyle = styles[(b / TIERS.length) | 0][b % TIERS.length];
        ctx!.beginPath();
        for (let k = 0; k < n; k++) {
          const oo = k * 4;
          ctx!.moveTo(dd[oo], dd[oo + 1]);
          ctx!.lineTo(dd[oo + 2], dd[oo + 3]);
        }
        ctx!.stroke();
      }
      frame++;
    }

    function frameLoop(now: number) {
      raf = requestAnimationFrame(frameLoop);
      if (document.hidden) return;
      const delta = Math.min(2, (now - lastFrame) / 16.667 || 1);
      lastFrame = now;
      step(delta);
    }

    /* ================= 布局与输入 ================= */
    function resize() {
      width = window.innerWidth;
      height = window.innerHeight;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      surface.width = Math.round(width * dpr);
      surface.height = Math.round(height * dpr);
      surface.style.width = width + "px";
      surface.style.height = height + "px";
      ctx!.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    // 同种子确定性重播（参考稿行为）：改窗口大小不换画面，只重新铺一遍
    function onResize() {
      resize();
      init(true);
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
          pointerEnergy = Math.min(
            1.35,
            Math.max(pointerEnergy, Math.min(1.2, m / 34 + Math.hypot(dx / elapsed, dy / elapsed) * 2.1))
          );
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
    window.addEventListener("resize", onResize, { passive: true });
    document.addEventListener("visibilitychange", onVisibility);

    /* ================= 启动 ================= */
    resize();
    init(false);
    raf = requestAnimationFrame(frameLoop);

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("pointermove", updatePointer);
      window.removeEventListener("pointerleave", onLeave);
      window.removeEventListener("resize", onResize);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);

  return (
    <>
      <canvas ref={canvasRef} className="flow-bg" aria-hidden="true" />
      {/* 暗角：参考稿自带的 vignette，压边角保证文字可读，同时把视觉焦点收回中心 */}
      <div className="flow-vignette" aria-hidden="true" />
    </>
  );
}
