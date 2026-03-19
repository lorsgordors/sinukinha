const canvas = document.getElementById("c");
const ctx = canvas.getContext("2d");

// HUD elements
const shotsEl = document.getElementById("shots");
const remainingEl = document.getElementById("remaining");
const resetBtn = document.getElementById("resetBtn");
const currentPlayerEl = document.getElementById("currentPlayer");
const currentGroupEl = document.getElementById("currentGroup");
const statusMsgEl = document.getElementById("statusMsg");

const W = canvas.width;
const H = canvas.height;

const balls = [];
let cue;

let shotCount = 0;
const frictionRoll = 0.9894; // atrito rodando
const frictionSlide = 0.978;  // atrito alto (logo após impacto)
const restitution = 0.975;
const wallRestitution = 0.72; // energia perdida ao bater na tabela
const get_friction = (speed) => speed > 4 ? frictionSlide : frictionRoll;

let aiming = false, aimX = 0, aimY = 0;
let rawAimX = 0, rawAimY = 0;  // posição real do mouse (alvo do lerp)
const AIM_LERP = 0.13;          // velocidade de suavização (0=parado, 1=instantâneo)
let power = 0;

// ===== EFEITO (SPIN) =====
let cueHitX = 0; // -1 (esquerda) a +1 (direita)
let cueHitY = 0; // -1 (cima/topspin) a +1 (baixo/backspin)
let spinDragging = false;

// posição e tamanho do widget de efeito
const SW = { x: W - 80, y: H - 75, r: 32 };

// estado do jogo 8-ball
let currentPlayer = 1;
const playerGroup = { 1: null, 2: null }; // 'solid' | 'stripe' | null
let gameOver = false;
let shotInProgress = false;
let firstHitBall = null;
let shotPocketedBalls = [];

// cor auxiliar: clareia uma cor hex
function lightenColor(hex, factor) {
  let r = parseInt(hex.slice(1,3),16);
  let g = parseInt(hex.slice(3,5),16);
  let b = parseInt(hex.slice(5,7),16);
  r = Math.min(255, Math.round(r + (255 - r) * factor));
  g = Math.min(255, Math.round(g + (255 - g) * factor));
  b = Math.min(255, Math.round(b + (255 - b) * factor));
  return `rgb(${r},${g},${b})`;
}
function darkenColor(hex, factor) {
  let r = parseInt(hex.slice(1,3),16);
  let g = parseInt(hex.slice(3,5),16);
  let b = parseInt(hex.slice(5,7),16);
  r = Math.round(r * (1 - factor));
  g = Math.round(g * (1 - factor));
  b = Math.round(b * (1 - factor));
  return `rgb(${r},${g},${b})`;
}

// AUDIO
let audioCtx = null;

function ensureAudioContext() {
  if (!audioCtx) {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (AudioCtx) {
      audioCtx = new AudioCtx();
    }
  }
}

function playTone(freq, duration, volume) {
  if (!audioCtx) return;
  const osc = audioCtx.createOscillator();
  const gain = audioCtx.createGain();
  osc.frequency.value = freq;
  gain.gain.value = volume;
  osc.connect(gain);
  gain.connect(audioCtx.destination);
  const now = audioCtx.currentTime;
  osc.start(now);
  osc.stop(now + duration);
}

function playCollisionSound(intensity) {
  if (!audioCtx) return;
  const i = Math.min(Math.max(intensity, 0), 1);
  const freq = 200 + 600 * i;
  const vol = 0.03 + 0.12 * i;
  playTone(freq, 0.06 + 0.04 * i, vol);
}

function playPocketSound() {
  if (!audioCtx) return;
  playTone(180, 0.09, 0.18);
  setTimeout(() => playTone(140, 0.06, 0.16), 40);
}

// ===== MESA =====
const rX = 60, rY = 60;          // posição interior do feltro
const rW = W - rX * 2, rH = H - rY * 2; // dimensões do feltro
const pocketR = 22;  // raio de detecção (pouco maior que a bola r=18)
const TABLE_CUSHION = 8;
const TABLE_CORNER_GAP = 32;
const TABLE_MIDDLE_GAP = 22;

// caçapas — posicionadas no encaixe das quinas/bordas
const pockets = [
  [rX - 2,  rY - 2],              // canto superior-esquerdo
  [W / 2,   rY - 6],              // lateral superior
  [W - rX + 2, rY - 2],           // canto superior-direito
  [rX - 2,  H - rY + 2],          // canto inferior-esquerdo
  [W / 2,   H - rY + 6],          // lateral inferior
  [W - rX + 2, H - rY + 2]        // canto inferior-direito
];

function drawTable() {
  // === fundo de madeira (borda externa) ===
  let wood = ctx.createLinearGradient(0, 0, W, H);
  wood.addColorStop(0,   "#7a4f28");
  wood.addColorStop(0.3, "#5c3515");
  wood.addColorStop(1,   "#2e1a08");
  ctx.fillStyle = wood;
  ctx.fillRect(0, 0, W, H);

  // veios de madeira
  ctx.strokeStyle = "rgba(0,0,0,0.08)";
  ctx.lineWidth = 1;
  for (let i = 0; i < W; i += 28) {
    ctx.beginPath();
    ctx.moveTo(i, 0);
    ctx.lineTo(i + 14, H);
    ctx.stroke();
  }

  // === feltro verde ===
  let cloth = ctx.createRadialGradient(W/2, H/2, 80, W/2, H/2, 580);
  cloth.addColorStop(0,   "#27a045");
  cloth.addColorStop(0.6, "#1a7a35");
  cloth.addColorStop(1,   "#0d4d21");
  ctx.fillStyle = cloth;
  ctx.fillRect(rX, rY, rW, rH);

  // textura de pano
  ctx.strokeStyle = "rgba(255,255,255,0.02)";
  ctx.lineWidth = 1;
  for (let yy = rY; yy < rY + rH; yy += 4) {
    ctx.beginPath();
    ctx.moveTo(rX, yy);
    ctx.lineTo(rX + rW, yy);
    ctx.stroke();
  }

  // === caçapas profissionais ===
  const pocketRadius = 15;
  const leatherColor = "#4a2811";
  const leatherEdge = "#241208";

  function drawPocketCore(px, py, radiusX, radiusY) {
    const hole = ctx.createRadialGradient(px, py, 0, px, py, Math.max(radiusX, radiusY));
    hole.addColorStop(0, "#000000");
    hole.addColorStop(0.55, "#050505");
    hole.addColorStop(1, "#1a1008");

    ctx.save();
    ctx.beginPath();
    ctx.ellipse(px, py, radiusX, radiusY, 0, 0, Math.PI * 2);
    ctx.fillStyle = hole;
    ctx.fill();
    ctx.strokeStyle = "rgba(0,0,0,0.7)";
    ctx.lineWidth = 1.8;
    ctx.stroke();
    ctx.restore();
  }

  function drawCornerPocket(px, py, sx, sy) {
    // garganta preta da caçapa saindo em diagonal da quina
    ctx.beginPath();
    ctx.moveTo(px, py);
    ctx.lineTo(px + sx * 28, py);
    ctx.lineTo(px, py + sy * 28);
    ctx.closePath();
    ctx.fillStyle = "#050505";
    ctx.fill();

    // jaws de couro nas duas faces da quina
    ctx.fillStyle = leatherColor;
    ctx.beginPath();
    ctx.arc(px + sx * 13, py + sy * 5, 7, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.arc(px + sx * 5, py + sy * 13, 7, 0, Math.PI * 2);
    ctx.fill();

    ctx.strokeStyle = leatherEdge;
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.arc(px + sx * 13, py + sy * 5, 7, 0, Math.PI * 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(px + sx * 5, py + sy * 13, 7, 0, Math.PI * 2);
    ctx.stroke();

    drawPocketCore(px + sx * 8, py + sy * 8, pocketRadius, pocketRadius);
  }

  function drawSidePocket(px, py, isTop) {
    const sy = isTop ? -1 : 1;

    // garganta da caçapa lateral com boca mais larga e interior oval
    ctx.beginPath();
    ctx.moveTo(px - 26, py);
    ctx.lineTo(px - 15, py + sy * 10);
    ctx.lineTo(px + 15, py + sy * 10);
    ctx.lineTo(px + 26, py);
    ctx.closePath();
    ctx.fillStyle = "#050505";
    ctx.fill();

    // jaws de couro dos dois lados
    ctx.fillStyle = leatherColor;
    ctx.beginPath();
    ctx.arc(px - 18, py + sy * 3, 7, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.arc(px + 18, py + sy * 3, 7, 0, Math.PI * 2);
    ctx.fill();

    ctx.strokeStyle = leatherEdge;
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.arc(px - 18, py + sy * 3, 7, 0, Math.PI * 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(px + 18, py + sy * 3, 7, 0, Math.PI * 2);
    ctx.stroke();

    drawPocketCore(px, py + sy * 7, 17, 12);
  }

  drawCornerPocket(pockets[0][0], pockets[0][1], 1, 1);
  drawSidePocket(pockets[1][0], pockets[1][1], true);
  drawCornerPocket(pockets[2][0], pockets[2][1], -1, 1);
  drawCornerPocket(pockets[3][0], pockets[3][1], 1, -1);
  drawSidePocket(pockets[4][0], pockets[4][1], false);
  drawCornerPocket(pockets[5][0], pockets[5][1], -1, -1);

  // === borracha dos trilhos (uma faixa verde-escura sólida) ===
  const bT = TABLE_CUSHION;
  const ch = TABLE_CORNER_GAP;
  const mg = TABLE_MIDDLE_GAP;

  ctx.fillStyle = "#1e5c1a";

  // topo-esquerdo
  ctx.fillRect(rX + ch, rY, W/2 - mg - rX - ch, bT);
  // topo-direito
  ctx.fillRect(W/2 + mg, rY, rX + rW - ch - W/2 - mg, bT);
  // base-esquerda
  ctx.fillRect(rX + ch, rY + rH - bT, W/2 - mg - rX - ch, bT);
  // base-direita
  ctx.fillRect(W/2 + mg, rY + rH - bT, rX + rW - ch - W/2 - mg, bT);
  // lateral esquerda
  ctx.fillRect(rX, rY + ch, bT, rH - ch * 2);
  // lateral direita
  ctx.fillRect(rX + rW - bT, rY + ch, bT, rH - ch * 2);

  // pequeno chanfro arredondado nas pontas da borracha
  const dots = [
    // topo-esquerdo
    [rX + ch, rY + bT/2], [W/2 - mg, rY + bT/2],
    // topo-direito
    [W/2 + mg, rY + bT/2], [rX + rW - ch, rY + bT/2],
    // base-esquerda
    [rX + ch, rY + rH - bT/2], [W/2 - mg, rY + rH - bT/2],
    // base-direita
    [W/2 + mg, rY + rH - bT/2], [rX + rW - ch, rY + rH - bT/2],
    // laterais
    [rX + bT/2, rY + ch], [rX + bT/2, rY + rH - ch],
    [rX + rW - bT/2, rY + ch], [rX + rW - bT/2, rY + rH - ch],
  ];
  ctx.fillStyle = "#1e5c1a";
  dots.forEach(d => {
    ctx.beginPath();
    ctx.arc(d[0], d[1], bT/2, 0, Math.PI * 2);
    ctx.fill();
  });

  // linha interna da face do trilho para definir melhor o limite jogável
  ctx.strokeStyle = "rgba(0,0,0,0.22)";
  ctx.lineWidth = 1.5;
  ctx.strokeRect(rX + bT, rY + bT, rW - bT * 2, rH - bT * 2);

  // === marcas de referência ===
  ctx.strokeStyle = "rgba(255,255,255,0.12)";
  ctx.lineWidth = 1.5;
  ctx.setLineDash([]);
  const headX = rX + rW * 0.27;
  ctx.beginPath();
  ctx.moveTo(headX, rY);
  ctx.lineTo(headX, rY + rH);
  ctx.stroke();

  ctx.beginPath();
  ctx.arc(rX + rW * 0.75, H / 2, 3, 0, Math.PI * 2);
  ctx.fillStyle = "rgba(255,255,255,0.15)";
  ctx.fill();

  ctx.beginPath();
  ctx.arc(W / 2, H / 2, 3, 0, Math.PI * 2);
  ctx.fillStyle = "rgba(255,255,255,0.15)";
  ctx.fill();

  // === borda da madeira (única, limpa) ===
  ctx.strokeStyle = "rgba(0,0,0,0.55)";
  ctx.lineWidth = 2.5;
  ctx.strokeRect(rX - 1, rY - 1, rW + 2, rH + 2);
}

// ===== BOLA =====
class Ball {
  constructor(x, y, color, number = null, type = "other") {
    this.x = x;
    this.y = y;
    this.vx = 0;
    this.vy = 0;
    this.r = 18; // raio da bola
    this.color = color;
    this.active = true;
    this.falling = false;
    this.pocketed = false;
    this.number = number;
    this.type = type; // 'solid' | 'stripe' | 'eight' | 'cue' | 'other'
    this.rollAngle = 0;
    this.rollDirX = 1;
    this.rollDirY = 0;
    // spin física
    this.topspin  = 0; // positivo = topspin, negativo = backspin
    this.sidespin = 0; // positivo = direita, negativo = esquerda
    this.trail = [];
    this.pocketX = 0;
    this.pocketY = 0;
    this.fallAlpha = 1;
  }

  draw() {
    if (!this.active) return;

    // trilha de velocidade (rastro)
    for (let i = 0; i < this.trail.length; i++) {
      const frac = i / this.trail.length;
      const t = this.trail[i];
      ctx.beginPath();
      ctx.arc(t.x, t.y, this.r * (0.25 + 0.7 * frac), 0, Math.PI * 2);
      ctx.fillStyle = `rgba(255,255,255,${(frac * 0.22).toFixed(2)})`;
      ctx.fill();
    }

    const _prevAlpha = ctx.globalAlpha;
    if (this.falling) ctx.globalAlpha = this.fallAlpha;

    // sombra elíptica dinâmica
    const shadowScale = 0.38;
    ctx.save();
    ctx.translate(this.x + 5, this.y + this.r * 0.55);
    ctx.scale(1, shadowScale);
    ctx.beginPath();
    ctx.arc(0, 0, this.r * 1.1, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(0,0,0,0.45)";
    ctx.fill();
    ctx.restore();

    // base da bola
    if (this.type === "cue") {
      // esfera branca com iluminação lateral
      let grad = ctx.createRadialGradient(this.x - this.r * 0.3, this.y - this.r * 0.3, 1, this.x + this.r * 0.1, this.y + this.r * 0.1, this.r * 1.1);
      grad.addColorStop(0,   "#ffffff");
      grad.addColorStop(0.5, "#e8e8e8");
      grad.addColorStop(1,   "#b0b0b0");
      ctx.beginPath();
      ctx.arc(this.x, this.y, this.r, 0, Math.PI * 2);
      ctx.fillStyle = grad;
      ctx.fill();
      // leve contorno escuro
      ctx.strokeStyle = "rgba(0,0,0,0.18)";
      ctx.lineWidth = 1;
      ctx.stroke();
    } else if (this.type === "stripe") {
      // base branca
      ctx.beginPath();
      ctx.arc(this.x, this.y, this.r, 0, Math.PI * 2);
      ctx.fillStyle = "#fefefe";
      ctx.fill();

      // faixa colorida oscila perpendicular ao movimento — efeito de rolamento 3D
      const perpX = -this.rollDirY;
      const perpY = this.rollDirX;
      const bandShift = Math.sin(this.rollAngle) * this.r * 0.5;
      const motAngle = Math.atan2(this.rollDirY, this.rollDirX);

      ctx.save();
      ctx.beginPath();
      ctx.arc(this.x, this.y, this.r, 0, Math.PI * 2);
      ctx.clip();
      ctx.translate(this.x + perpX * bandShift, this.y + perpY * bandShift);
      ctx.rotate(motAngle);
      ctx.fillStyle = this.color;
      ctx.fillRect(-this.r * 1.1, -this.r * 0.48, this.r * 2.2, this.r * 0.96);
      ctx.restore();
    } else {
      // sólida ou 8 — gradiente lateral para profundidade
      let grad = ctx.createRadialGradient(
        this.x - this.r * 0.35, this.y - this.r * 0.35, 1,
        this.x + this.r * 0.1,  this.y + this.r * 0.1,  this.r * 1.15
      );
      // cor mais clara no topo, cor base no meio, sombra embaixo
      grad.addColorStop(0,    lightenColor(this.color, 0.7));
      grad.addColorStop(0.35, this.color);
      grad.addColorStop(1,    darkenColor(this.color, 0.82));
      ctx.beginPath();
      ctx.arc(this.x, this.y, this.r, 0, Math.PI * 2);
      ctx.fillStyle = grad;
      ctx.fill();
      // contorno
      ctx.strokeStyle = "rgba(0,0,0,0.3)";
      ctx.lineWidth = 1.2;
      ctx.stroke();
    }

    // efeito 3D de rolamento: marca/número oscila e achata ao rolar
    if (this.type !== "cue") {
      const innerR = this.type === "eight" ? this.r * 0.5 : this.r * 0.55;
      const sinR = Math.sin(this.rollAngle);
      const cosR = Math.cos(this.rollAngle);
      // achata na direção do movimento (projeção de esfera girando)
      const foreshorten = Math.max(0.12, Math.abs(cosR));
      const motAngle = Math.atan2(this.rollDirY, this.rollDirX);
      // centro da marca desloca para frente/trás ao rolar
      const cx = this.x + this.rollDirX * sinR * innerR * 0.6;
      const cy = this.y + this.rollDirY * sinR * innerR * 0.6;

      ctx.save();
      ctx.globalAlpha = cosR >= 0 ? 1 : 0.15; // some quando vai para o lado de baixo
      ctx.translate(cx, cy);
      ctx.rotate(motAngle);
      ctx.scale(foreshorten, 1);
      ctx.beginPath();
      ctx.arc(0, 0, innerR, 0, Math.PI * 2);
      ctx.fillStyle = "#fdfdfd";
      ctx.fill();
      if (this.number !== null) {
        ctx.scale(1 / foreshorten, 1); // desfaz achatamento para o número não distorcer
        ctx.fillStyle = "#000";
        ctx.font = `${this.number >= 10 ? 11 : 13}px Arial`;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(String(this.number), 0, 0);
      }
      ctx.restore();
    } else {
      // marca cinza girando na bola branca (efeito 3D)
      const sinR = Math.sin(this.rollAngle);
      const cosR = Math.cos(this.rollAngle);
      const foreshorten = Math.max(0.1, Math.abs(cosR));
      const motAngle = Math.atan2(this.rollDirY, this.rollDirX);
      const cx = this.x + this.rollDirX * sinR * this.r * 0.55;
      const cy = this.y + this.rollDirY * sinR * this.r * 0.55;

      ctx.save();
      ctx.globalAlpha = cosR >= 0 ? 0.65 : 0.08;
      ctx.translate(cx, cy);
      ctx.rotate(motAngle);
      ctx.scale(foreshorten, 1);
      ctx.beginPath();
      ctx.arc(0, 0, this.r * 0.22, 0, Math.PI * 2);
      ctx.fillStyle = "rgba(110,110,110,1)";
      ctx.fill();
      ctx.restore();
    }

    // brilho principal
    ctx.beginPath();
    ctx.arc(this.x - this.r * 0.28, this.y - this.r * 0.28, this.r * 0.28, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(255,255,255,0.72)";
    ctx.fill();
    // segundo brilho menor
    ctx.beginPath();
    ctx.arc(this.x - this.r * 0.42, this.y - this.r * 0.42, this.r * 0.1, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(255,255,255,0.9)";
    ctx.fill();

    if (this.falling) ctx.globalAlpha = _prevAlpha;
  }

  update() {
    if (!this.active) return;

    if (this.falling) {
      // puxa a bola para o centro da caçapa enquanto encolhe
      this.x += (this.pocketX - this.x) * 0.18;
      this.y += (this.pocketY - this.y) * 0.18;
      this.fallAlpha *= 0.88;
      this.r *= 0.90;
      if (this.r < 1) this.active = false;
      return;
    }

    // registra trilha se em movimento rápido
    const trailSpd = Math.sqrt(this.vx * this.vx + this.vy * this.vy);
    if (trailSpd > 3) {
      this.trail.push({ x: this.x, y: this.y });
      if (this.trail.length > 8) this.trail.shift();
    } else if (this.trail.length > 0) {
      this.trail.shift();
    }

    this.x += this.vx;
    this.y += this.vy;

    // física real de rolamento
    const speed = Math.sqrt(this.vx * this.vx + this.vy * this.vy);
    if (speed > 0.05) {
      this.rollAngle += speed / this.r;
      this.rollDirX = this.vx / speed;
      this.rollDirY = this.vy / speed;
    }

    // atrito dependente de velocidade: rápida=deslize, lenta=rolamento
    const fr = get_friction(speed);
    this.vx *= fr;
    this.vy *= fr;

    // ===== física de efeito na branca =====
    if (this.type === "cue") {
      const spd = Math.sqrt(this.vx * this.vx + this.vy * this.vy);

      // topspin (positivo) → empurra na direção do movimento (vai mais longe)
      // backspin (negativo) → empurra contra o movimento (freia / retorna)
      if (Math.abs(this.topspin) > 0.01 && spd > 0.3) {
        const force = this.topspin * 0.055;
        this.vx += this.rollDirX * force;
        this.vy += this.rollDirY * force;
        this.topspin *= 0.965;
      } else if (spd < 0.3) {
        this.topspin = 0;
      }

      // sidespin → empurra perpendicularmente (curva lateral)
      if (Math.abs(this.sidespin) > 0.01 && spd > 0.4) {
        const perpX = -this.rollDirY;
        const perpY =  this.rollDirX;
        const force = this.sidespin * 0.038;
        this.vx += perpX * force;
        this.vy += perpY * force;
        this.sidespin *= 0.972;
      } else if (spd < 0.4) {
        this.sidespin = 0;
      }
    }

    if (Math.abs(this.vx) < 0.01) this.vx = 0;
    if (Math.abs(this.vy) < 0.01) this.vy = 0;

    // função auxiliar: perto de uma caçapa?
    const nearPocket = (x, y, threshold) => {
      return pockets.some(p => {
        const dx = x - p[0], dy = y - p[1];
        return Math.sqrt(dx * dx + dy * dy) < threshold;
      });
    };

    const playLeft = rX + TABLE_CUSHION + this.r;
    const playRight = W - rX - TABLE_CUSHION - this.r;
    const playTop = rY + TABLE_CUSHION + this.r;
    const playBottom = H - rY - TABLE_CUSHION - this.r;

    // só quica nas paredes se NÃO estiver perto de uma caçapa
    if (!nearPocket(this.x, this.y, pocketR + this.r + 10)) {
      if (this.x < playLeft) { this.x = playLeft; this.vx = Math.abs(this.vx) * wallRestitution; }
      if (this.x > playRight) { this.x = playRight; this.vx = -Math.abs(this.vx) * wallRestitution; }
      if (this.y < playTop) { this.y = playTop; this.vy = Math.abs(this.vy) * wallRestitution; }
      if (this.y > playBottom) { this.y = playBottom; this.vy = -Math.abs(this.vy) * wallRestitution; }
    }

    pockets.forEach(p => {
      let dx = this.x - p[0];
      let dy = this.y - p[1];
    if (!this.pocketed && Math.sqrt(dx * dx + dy * dy) < pocketR) {
        this.pocketX = p[0];
        this.pocketY = p[1];
        this.falling = true;
        this.vx = 0;
        this.vy = 0;
        this.pocketed = true;
        if (shotInProgress) {
          shotPocketedBalls.push(this);
        }
        playPocketSound();
      }
    });
  }
}

// colisão
function collide(b1, b2) {
  if (!b1.active || !b2.active || b1.falling || b2.falling) return;

  let dx = b2.x - b1.x;
  let dy = b2.y - b1.y;
  let dist = Math.sqrt(dx * dx + dy * dy);

  if (dist < b1.r + b2.r) {
    if (dist === 0) {
      dist = b1.r + b2.r;
      dx = b1.r + b2.r;
      dy = 0;
    }

    let nx = dx / dist;
    let ny = dy / dist;

    // separa as bolas para evitar que "grudem"
    const overlap = (b1.r + b2.r) - dist;
    const correction = overlap / 2;
    b1.x -= nx * correction;
    b1.y -= ny * correction;
    b2.x += nx * correction;
    b2.y += ny * correction;

    let tx = -ny;
    let ty = nx;

    let dpTan1 = b1.vx * tx + b1.vy * ty;
    let dpTan2 = b2.vx * tx + b2.vy * ty;

    let dpNorm1 = b1.vx * nx + b1.vy * ny;
    let dpNorm2 = b2.vx * nx + b2.vy * ny;

    b1.vx = tx * dpTan1 + nx * dpNorm2 * restitution;
    b1.vy = ty * dpTan1 + ny * dpNorm2 * restitution;
    b2.vx = tx * dpTan2 + nx * dpNorm1 * restitution;
    b2.vy = ty * dpTan2 + ny * dpNorm1 * restitution;

    // som de colisão
    const relVx = b1.vx - b2.vx;
    const relVy = b1.vy - b2.vy;
    const relSpeed = Math.sqrt(relVx * relVx + relVy * relVy);
    const intensity = Math.min(relSpeed / 18, 1);
    playCollisionSound(intensity);

    // primeira bola tocada pela branca
    if (shotInProgress && !firstHitBall && (b1 === cue || b2 === cue)) {
      const other = b1 === cue ? b2 : b1;
      if (other.type !== "cue") {
        firstHitBall = other;
      }
    }
  }
}

// separa posições sobrepostas sem alterar velocidades (para resolver clusters)
function separateBalls(b1, b2) {
  if (!b1.active || !b2.active || b1.falling || b2.falling) return;
  const dx = b2.x - b1.x;
  const dy = b2.y - b1.y;
  const dist = Math.sqrt(dx * dx + dy * dy);
  if (dist < b1.r + b2.r && dist > 0) {
    const overlap = (b1.r + b2.r) - dist;
    const nx = dx / dist, ny = dy / dist;
    b1.x -= nx * overlap * 0.5;
    b1.y -= ny * overlap * 0.5;
    b2.x += nx * overlap * 0.5;
    b2.y += ny * overlap * 0.5;
  }
}

function setupBalls() {
  balls.length = 0;

  cue = new Ball(330, H / 2, "#ffffff", null, "cue");
  balls.push(cue);

  // definição das bolas 1-15 (cheias/listradas/8)
  const ballDefs = {
    1: { color: "#f1c40f", type: "solid" },
    2: { color: "#3498db", type: "solid" },
    3: { color: "#e74c3c", type: "solid" },
    4: { color: "#9b59b6", type: "solid" },
    5: { color: "#e67e22", type: "solid" },
    6: { color: "#16a085", type: "solid" },
    7: { color: "#c0392b", type: "solid" },
    8: { color: "#000000", type: "eight" },
    9: { color: "#f1c40f", type: "stripe" },
    10: { color: "#3498db", type: "stripe" },
    11: { color: "#e74c3c", type: "stripe" },
    12: { color: "#9b59b6", type: "stripe" },
    13: { color: "#e67e22", type: "stripe" },
    14: { color: "#16a085", type: "stripe" },
    15: { color: "#c0392b", type: "stripe" }
  };

  // arranjo em triângulo com a 8 no centro
  const rackNumbers = [
    [1],
    [2, 3],
    [4, 8, 5],
    [9, 10, 11, 12],
    [13, 14, 6, 7, 15]
  ];

  const startX = 1020;
  const gap = 38;

  for (let row = 0; row < rackNumbers.length; row++) {
    const cols = rackNumbers[row];
    for (let col = 0; col < cols.length; col++) {
      const num = cols[col];
      const def = ballDefs[num];
      const x = startX + row * gap;
      const y = H / 2 + (col * gap - (cols.length - 1) * gap / 2);
      balls.push(new Ball(x, y, def.color, num, def.type));
    }
  }

  gameOver = false;
  currentPlayer = 1;
  playerGroup[1] = null;
  playerGroup[2] = null;
  firstHitBall = null;
  shotPocketedBalls = [];
}

function getRemainingColoredBalls() {
  return balls.filter(b => b !== cue && b.active && !b.pocketed && (b.type === "solid" || b.type === "stripe" || b.type === "eight")).length;
}

function updateHUD() {
  if (shotsEl) shotsEl.textContent = String(shotCount);
  if (remainingEl) remainingEl.textContent = String(getRemainingColoredBalls());
  if (currentPlayerEl) currentPlayerEl.textContent = String(currentPlayer);
  const group = playerGroup[currentPlayer];
  if (currentGroupEl) {
    currentGroupEl.textContent = group === "solid" ? "Cheias" : group === "stripe" ? "Listradas" : "Indefinido";
  }
}

function ballsAreMoving() {
  return balls.some(b => Math.abs(b.vx) > 0.05 || Math.abs(b.vy) > 0.05);
}

function hasRemainingGroupBalls(player) {
  const g = playerGroup[player];
  if (!g) return true;
  return balls.some(b => b.type === g && b.active && !b.pocketed);
}

function otherPlayer() {
  return currentPlayer === 1 ? 2 : 1;
}

function setStatusMessage(msg) {
  if (statusMsgEl) statusMsgEl.textContent = msg;
}

function respawnCueBall() {
  cue.x = 330;
  cue.y = H / 2;
  cue.vx = 0;
  cue.vy = 0;
  cue.r = 18;
  cue.pocketed = false;
  cue.falling = false;
  cue.active = true;
  cue.spinX = 0;
  cue.spinY = 0;
}

function resolveShot() {
  if (!shotInProgress) return;
  shotInProgress = false;

  let foul = false;
  const cuePocketed = shotPocketedBalls.some(b => b.type === "cue");
  const eightPocketed = shotPocketedBalls.some(b => b.type === "eight");
  const solidsPocketed = shotPocketedBalls.filter(b => b.type === "solid");
  const stripesPocketed = shotPocketedBalls.filter(b => b.type === "stripe");

  if (!firstHitBall) {
    foul = true;
    setStatusMessage("Falta: não acertou nenhuma bola.");
  }

  if (!foul && playerGroup[1] && playerGroup[2] && firstHitBall && firstHitBall.type !== "eight") {
    const wanted = playerGroup[currentPlayer];
    if (firstHitBall.type !== wanted) {
      foul = true;
      setStatusMessage("Falta: primeiro contato na bola errada.");
    }
  }

  if (!foul && firstHitBall && firstHitBall.type === "eight" && hasRemainingGroupBalls(currentPlayer)) {
    foul = true;
    setStatusMessage("Falta: tocou na 8 antes do tempo.");
  }

  if (cuePocketed) {
    foul = true;
    setStatusMessage("Falta: afundou a branca.");
  }

  // definir grupos se ainda não definidos e houve bolas só de uma categoria
  if (!playerGroup[1] && !playerGroup[2]) {
    const solids = solidsPocketed.length;
    const stripes = stripesPocketed.length;
    if (solids > 0 && stripes === 0) {
      playerGroup[currentPlayer] = "solid";
      playerGroup[otherPlayer()] = "stripe";
      setStatusMessage(`Jogador ${currentPlayer} é Cheias, Jogador ${otherPlayer()} é Listradas.`);
    } else if (stripes > 0 && solids === 0) {
      playerGroup[currentPlayer] = "stripe";
      playerGroup[otherPlayer()] = "solid";
      setStatusMessage(`Jogador ${currentPlayer} é Listradas, Jogador ${otherPlayer()} é Cheias.`);
    }
  }

  // checar 8-ball
  if (eightPocketed) {
    const other = otherPlayer();
    const stillHasGroup = hasRemainingGroupBalls(currentPlayer);
    if (!playerGroup[currentPlayer]) {
      gameOver = true;
      setStatusMessage(`Jogador ${other} vence (8 afundada antes da definição).`);
    } else if (foul || cuePocketed) {
      gameOver = true;
      setStatusMessage(`Jogador ${other} vence (falta na bola 8).`);
    } else if (stillHasGroup) {
      gameOver = true;
      setStatusMessage(`Jogador ${other} vence (8 antes de limpar o grupo).`);
    } else {
      gameOver = true;
      setStatusMessage(`Jogador ${currentPlayer} vence!`);
    }
  }

  if (cuePocketed) {
    respawnCueBall();
  }

  let keepsTurn = false;
  if (!gameOver && !foul) {
    if (!playerGroup[currentPlayer]) {
      keepsTurn = solidsPocketed.length + stripesPocketed.length > 0;
    } else {
      const wanted = playerGroup[currentPlayer];
      keepsTurn = shotPocketedBalls.some(b => b.type === wanted);
    }
  }

  if (!gameOver) {
    if (!keepsTurn) {
      currentPlayer = otherPlayer();
      if (!foul && !eightPocketed) {
        setStatusMessage(`Vez do Jogador ${currentPlayer}.`);
      }
    } else if (!eightPocketed && !foul) {
      setStatusMessage(`Jogador ${currentPlayer} continua na vez.`);
    }
  }

  firstHitBall = null;
  shotPocketedBalls = [];
  updateHUD();
}

// ===== TACO ESTILO 8 BALL POOL + PULL BACK =====
function drawCue() {
  if (!aiming) return;

  // aimX/aimY é onde o jogador puxou o taco para trás,
  // então a direção de tiro real é o vetor INVERSO
  let ax = cue.x - aimX;
  let ay = cue.y - aimY;
  let distAim = Math.sqrt(ax * ax + ay * ay) || 1;
  let shotDirX = ax / distAim;
  let shotDirY = ay / distAim;
  let angle = Math.atan2(shotDirY, shotDirX);

  // ===== linhas de mira estilo 8 Ball Pool =====
  let hitBall = null;
  let hitDist = Infinity;

  balls.forEach(b => {
    if (b === cue || !b.active || b.falling || b.pocketed) return;
    const bx = b.x - cue.x;
    const by = b.y - cue.y;
    const t = bx * shotDirX + by * shotDirY;
    if (t <= 0) return; // atrás da branca
    const closestX = cue.x + shotDirX * t;
    const closestY = cue.y + shotDirY * t;
    const dxC = b.x - closestX;
    const dyC = b.y - closestY;
    const distSq = dxC * dxC + dyC * dyC;
    const r = b.r + cue.r; // raio combinado: ghost ball toca a bola alvo por fora
    if (distSq <= r * r) {
      const offset = Math.sqrt(r * r - distSq);
      const d = t - offset;
      if (d > 0 && d < hitDist) {
        hitDist = d;
        hitBall = b;
      }
    }
  });

  // ponto final da linha principal (centro da branca no momento do impacto)
  const maxGuide = 900;
  let ghostX, ghostY;
  if (hitBall) {
    ghostX = cue.x + shotDirX * hitDist;
    ghostY = cue.y + shotDirY * hitDist;
  } else {
    ghostX = cue.x + shotDirX * maxGuide;
    ghostY = cue.y + shotDirY * maxGuide;
  }

  // halo escuro da linha principal
  ctx.strokeStyle = "rgba(0,0,0,0.5)";
  ctx.lineWidth = 4.5;
  ctx.setLineDash([]);
  ctx.beginPath();
  ctx.moveTo(cue.x, cue.y);
  ctx.lineTo(ghostX, ghostY);
  ctx.stroke();

  // linha sólida branca: branca → ghost ball
  ctx.strokeStyle = "rgba(255,255,255,0.92)";
  ctx.lineWidth = 2;
  ctx.setLineDash([]);
  ctx.beginPath();
  ctx.moveTo(cue.x, cue.y);
  ctx.lineTo(ghostX, ghostY);
  ctx.stroke();

  if (hitBall) {
    // direção da bola alvo após colisão = normal = de ghostBall → hitBall
    const nDist = Math.sqrt((hitBall.x - ghostX) ** 2 + (hitBall.y - ghostY) ** 2) || 1;
    const tDirX = (hitBall.x - ghostX) / nDist;
    const tDirY = (hitBall.y - ghostY) / nDist;

    // direção da branca após colisão = perpendicular à normal (colisão elástica igual massa)
    // sinal: escolhe a metade que está do lado do vetor original
    let cDirX = -tDirY, cDirY = tDirX;
    if (cDirX * shotDirX + cDirY * shotDirY < 0) { cDirX = -cDirX; cDirY = -cDirY; }

    const guideLen = 280;
    const shortLen = 180;

    // linha da bola alvo (amarela/laranja pontilhada)
    ctx.strokeStyle = "rgba(255,210,60,0.85)";
    ctx.lineWidth = 2;
    ctx.setLineDash([12, 7]);
    ctx.beginPath();
    ctx.moveTo(hitBall.x, hitBall.y);
    ctx.lineTo(hitBall.x + tDirX * guideLen, hitBall.y + tDirY * guideLen);
    ctx.stroke();

    // linha da branca após colisão (azul claro pontilhada, mais curta)
    ctx.strokeStyle = "rgba(100,200,255,0.70)";
    ctx.lineWidth = 1.8;
    ctx.setLineDash([8, 6]);
    ctx.beginPath();
    ctx.moveTo(ghostX, ghostY);
    ctx.lineTo(ghostX + cDirX * shortLen, ghostY + cDirY * shortLen);
    ctx.stroke();

    ctx.setLineDash([]);

    // ghost ball: círculo translúcido onde a branca bate
    ctx.beginPath();
    ctx.arc(ghostX, ghostY, cue.r, 0, Math.PI * 2);
    ctx.strokeStyle = "rgba(255,255,255,0.75)";
    ctx.lineWidth = 1.8;
    ctx.stroke();
    ctx.fillStyle = "rgba(255,255,255,0.18)";
    ctx.fill();

    // ponto de contato entre ghost ball e bola alvo
    const contactX = ghostX + tDirX * cue.r;
    const contactY = ghostY + tDirY * cue.r;
    ctx.beginPath();
    ctx.arc(contactX, contactY, 4, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(255,255,255,0.95)";
    ctx.fill();
  }

  // calcula retrocesso do taco
  let maxPull = 80;
  let pull = Math.min(distAim, maxPull);
  let powerNorm = pull / maxPull;

  // ===== TACO REDESENHADO =====
  ctx.save();
  ctx.translate(cue.x, cue.y);
  ctx.rotate(angle);

  const cueLength = 420;
  const gapFromBall = cue.r + 7;
  const offset = gapFromBall + pull;

  const tipX    = -offset;           // ponta (giz)
  const buttX   = -offset - cueLength; // cabo

  // --- sombra do taco ---
  ctx.save();
  ctx.shadowColor = "rgba(0,0,0,0.55)";
  ctx.shadowBlur  = 8;
  ctx.shadowOffsetX = 3;
  ctx.shadowOffsetY = 3;
  ctx.beginPath();
  ctx.moveTo(buttX,  -9);
  ctx.lineTo(tipX,   -2);
  ctx.lineTo(tipX,    2);
  ctx.lineTo(buttX,   9);
  ctx.closePath();
  ctx.fillStyle = "#000";
  ctx.fill();
  ctx.restore();

  // --- madeira principal: gradiente multi-stop radial por segmento ---
  // segmento frontal (fino, 65% do comprimento) — tons de madeira clara
  const seg1Start = tipX;
  const seg1End   = buttX + cueLength * 0.65;
  let woodGrad = ctx.createLinearGradient(0, -2, 0, 2);
  woodGrad.addColorStop(0,   "#f2d9a2");
  woodGrad.addColorStop(0.3, "#e0b96a");
  woodGrad.addColorStop(0.7, "#c69040");
  woodGrad.addColorStop(1,   "#9a5c20");
  ctx.fillStyle = woodGrad;
  ctx.beginPath();
  ctx.moveTo(seg1End,   -6.5);
  ctx.lineTo(seg1Start, -2);
  ctx.lineTo(seg1Start,  2);
  ctx.lineTo(seg1End,    6.5);
  ctx.closePath();
  ctx.fill();

  // veio de madeira (linhas sutis longitudinais)
  ctx.save();
  ctx.beginPath();
  ctx.moveTo(seg1End,   -6.5);
  ctx.lineTo(seg1Start, -2);
  ctx.lineTo(seg1Start,  2);
  ctx.lineTo(seg1End,    6.5);
  ctx.closePath();
  ctx.clip();
  ctx.strokeStyle = "rgba(255,255,255,0.10)";
  ctx.lineWidth = 1;
  for (let v = 0; v < 3; v++) {
    const yv = -2.5 + v * 2.5;
    ctx.beginPath();
    ctx.moveTo(seg1Start, yv);
    ctx.lineTo(seg1End,   yv * 2.2);
    ctx.stroke();
  }
  ctx.restore();

  // segmento traseiro (cabo, 35%) — madeira escura + anel metálico
  const cabX = seg1End;
  let cabGrad = ctx.createLinearGradient(0, -9, 0, 9);
  cabGrad.addColorStop(0,   "#5a2d0c");
  cabGrad.addColorStop(0.35, "#8b4513");
  cabGrad.addColorStop(0.65, "#6b320e");
  cabGrad.addColorStop(1,   "#3d1a06");
  ctx.fillStyle = cabGrad;
  ctx.beginPath();
  ctx.moveTo(buttX, -9);
  ctx.lineTo(cabX,  -6.5);
  ctx.lineTo(cabX,   6.5);
  ctx.lineTo(buttX,  9);
  ctx.closePath();
  ctx.fill();

  // faixa decorativa de wrapped grip (linhas diagonais)
  ctx.save();
  ctx.beginPath();
  ctx.moveTo(buttX, -9);
  ctx.lineTo(cabX,  -6.5);
  ctx.lineTo(cabX,   6.5);
  ctx.lineTo(buttX,  9);
  ctx.closePath();
  ctx.clip();
  ctx.strokeStyle = "rgba(0,0,0,0.28)";
  ctx.lineWidth = 3.5;
  for (let g = 0; g < 18; g++) {
    const gx = buttX + g * 13;
    ctx.beginPath();
    ctx.moveTo(gx, -10);
    ctx.lineTo(gx + 8, 10);
    ctx.stroke();
  }
  ctx.restore();

  // anel metálico separador (entre cabo e haste)
  const ringX = cabX;
  let ringGrad = ctx.createLinearGradient(0, -8, 0, 8);
  ringGrad.addColorStop(0,   "#ffffff");
  ringGrad.addColorStop(0.3, "#d4af37");
  ringGrad.addColorStop(0.7, "#a07830");
  ringGrad.addColorStop(1,   "#5a3a10");
  ctx.fillStyle = ringGrad;
  ctx.fillRect(ringX - 5, -8, 10, 16);
  // reflexo no anel
  ctx.fillStyle = "rgba(255,255,255,0.45)";
  ctx.fillRect(ringX - 4, -7, 4, 4);

  // segundo anel mais fino (decorativo, 1/3 do cabo)
  const ring2X = buttX + cueLength * 0.12;
  let ring2Grad = ctx.createLinearGradient(0, -8, 0, 8);
  ring2Grad.addColorStop(0, "#c8c8c8");
  ring2Grad.addColorStop(1, "#606060");
  ctx.fillStyle = ring2Grad;
  ctx.fillRect(ring2X - 3, -9, 6, 18);

  // ponteira de giz (azul-acinzentado)
  const chalkLen = 18;
  let chalkGrad = ctx.createLinearGradient(tipX, 0, tipX + chalkLen, 0);
  chalkGrad.addColorStop(0,   "#7ec8e3");
  chalkGrad.addColorStop(0.5, "#5b9eb8");
  chalkGrad.addColorStop(1,   "#3a7a96");
  ctx.fillStyle = chalkGrad;
  ctx.beginPath();
  ctx.moveTo(tipX,            -1.5);
  ctx.lineTo(tipX + chalkLen, -2.2);
  ctx.lineTo(tipX + chalkLen,  2.2);
  ctx.lineTo(tipX,             1.5);
  ctx.closePath();
  ctx.fill();
  // brilho na ponta
  ctx.fillStyle = "rgba(255,255,255,0.45)";
  ctx.beginPath();
  ctx.moveTo(tipX,            -0.5);
  ctx.lineTo(tipX + chalkLen * 0.6, -0.8);
  ctx.lineTo(tipX + chalkLen * 0.6,  0.3);
  ctx.lineTo(tipX,             0.3);
  ctx.closePath();
  ctx.fill();

  // contorno final do taco inteiro
  ctx.strokeStyle = "rgba(0,0,0,0.5)";
  ctx.lineWidth = 0.8;
  ctx.beginPath();
  ctx.moveTo(buttX,  -9);
  ctx.lineTo(tipX,   -1.5);
  ctx.lineTo(tipX,    1.5);
  ctx.lineTo(buttX,   9);
  ctx.closePath();
  ctx.stroke();

  ctx.restore();

  // barra de power
  const barWidth = 260;
  const barHeight = 12;
  const barX = W / 2 - barWidth / 2;
  const barY = H - 30;

  ctx.fillStyle = "rgba(0,0,0,0.5)";
  ctx.fillRect(barX, barY, barWidth, barHeight);

  let powerGrad = ctx.createLinearGradient(barX, 0, barX + barWidth, 0);
  powerGrad.addColorStop(0, "#2ecc71");
  powerGrad.addColorStop(1, "#e74c3c");
  ctx.fillStyle = powerGrad;
  ctx.fillRect(barX, barY, barWidth * powerNorm, barHeight);

  ctx.strokeStyle = "rgba(255,255,255,0.4)";
  ctx.strokeRect(barX, barY, barWidth, barHeight);

  ctx.fillStyle = "rgba(255,255,255,0.8)";
  ctx.font = "11px Arial";
  ctx.textAlign = "center";
  ctx.fillText("POWER", W / 2, barY - 4);

}

function drawSpinWidget() {
  const { x, y, r } = SW;

  // fundo escuro
  ctx.save();
  ctx.globalAlpha = 0.82;
  ctx.beginPath();
  ctx.arc(x, y, r + 8, 0, Math.PI * 2);
  ctx.fillStyle = "#111";
  ctx.fill();
  ctx.globalAlpha = 1;

  // mini bola (base branca)
  let bg = ctx.createRadialGradient(x - r * 0.25, y - r * 0.25, 1, x, y, r);
  bg.addColorStop(0, "#ffffff");
  bg.addColorStop(0.6, "#cccccc");
  bg.addColorStop(1, "#888888");
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fillStyle = bg;
  ctx.fill();

  // linhas de referência
  ctx.strokeStyle = "rgba(0,0,0,0.2)";
  ctx.lineWidth = 1;
  ctx.setLineDash([3, 3]);
  ctx.beginPath(); ctx.moveTo(x - r, y); ctx.lineTo(x + r, y); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(x, y - r); ctx.lineTo(x, y + r); ctx.stroke();
  ctx.setLineDash([]);

  // borda da bola
  ctx.strokeStyle = "rgba(0,0,0,0.3)";
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.stroke();

  // ponto de contato (clamp dentro da bola)
  const dotX = x + cueHitX * r * 0.85;
  const dotY = y + cueHitY * r * 0.85;

  // cor do ponto de acordo com o efeito
  let dotColor;
  if (Math.abs(cueHitX) < 0.2 && Math.abs(cueHitY) < 0.2) {
    dotColor = "#ffffff"; // centro = sem efeito
  } else if (cueHitY < -0.3) {
    dotColor = "#2ecc71"; // topspin = verde
  } else if (cueHitY > 0.3) {
    dotColor = "#e74c3c"; // backspin = vermelho
  } else {
    dotColor = "#f1c40f"; // sidespin = amarelo
  }

  ctx.beginPath();
  ctx.arc(dotX, dotY, 6, 0, Math.PI * 2);
  ctx.fillStyle = "rgba(0,0,0,0.4)";
  ctx.fill();
  ctx.beginPath();
  ctx.arc(dotX, dotY, 5, 0, Math.PI * 2);
  ctx.fillStyle = dotColor;
  ctx.fill();

  // label
  let label = "Centro";
  if (cueHitY < -0.35) label = "Topspin";
  else if (cueHitY > 0.35) label = "Backspin";
  else if (cueHitX < -0.35) label = "Esquerda";
  else if (cueHitX > 0.35) label = "Direita";

  ctx.fillStyle = "rgba(255,255,255,0.85)";
  ctx.font = "bold 10px Arial";
  ctx.textAlign = "center";
  ctx.fillText(label, x, y + r + 18);
  ctx.fillStyle = "rgba(255,255,255,0.5)";
  ctx.font = "10px Arial";
  ctx.fillText("EFEITO", x, y - r - 8);
  ctx.restore();
}

// controles
function isOverSpinWidget(ex, ey) {
  const dx = ex - SW.x, dy = ey - SW.y;
  return Math.sqrt(dx*dx + dy*dy) <= SW.r + 8;
}

canvas.addEventListener("mousedown", e => {
  if (ballsAreMoving() || gameOver) return;
  ensureAudioContext();
  if (audioCtx && audioCtx.state === "suspended") audioCtx.resume();

  // clicou no widget de efeito?
  if (isOverSpinWidget(e.offsetX, e.offsetY)) {
    spinDragging = true;
    const dx = e.offsetX - SW.x;
    const dy = e.offsetY - SW.y;
    const dist = Math.sqrt(dx*dx + dy*dy);
    const clamped = Math.min(dist, SW.r) / SW.r;
    const ratio = clamped;
    cueHitX = dist > 0 ? (dx / Math.sqrt(dx*dx + dy*dy)) * ratio : 0;
    cueHitY = dist > 0 ? (dy / Math.sqrt(dx*dx + dy*dy)) * ratio : 0;
    return;
  }

  aiming = true;
  rawAimX = e.offsetX;
  rawAimY = e.offsetY;
  aimX = e.offsetX;
  aimY = e.offsetY;
  power = 0;
});

canvas.addEventListener("mousemove", e => {
  if (spinDragging) {
    const dx = e.offsetX - SW.x;
    const dy = e.offsetY - SW.y;
    const dist = Math.sqrt(dx*dx + dy*dy);
    const ratio = Math.min(dist, SW.r) / SW.r;
    cueHitX = dist > 0 ? (dx / dist) * ratio : 0;
    cueHitY = dist > 0 ? (dy / dist) * ratio : 0;
    return;
  }
  if (aiming) {
    rawAimX = e.offsetX;
    rawAimY = e.offsetY;
  }
});

canvas.addEventListener("mouseup", e => {
  if (spinDragging) {
    spinDragging = false;
    return;
  }
  if (aiming) {
    let dx = cue.x - e.offsetX;
    let dy = cue.y - e.offsetY;
    let dist = Math.sqrt(dx * dx + dy * dy);

    if (dist > 0.5) {
      let nx = dx / dist;
      let ny = dy / dist;

      let maxForce = 38;
      let force = Math.min(dist * 0.18, maxForce);
      force = Math.pow(force, 0.9);

      cue.vx = nx * force;
      cue.vy = ny * force;

      // aplica spin na branca com base no ponto selecionado
      cue.topspin  = -cueHitY * force * 0.55; // cima = topspin positivo
      cue.sidespin =  cueHitX * force * 0.45; // direita = sidespin positivo

      shotCount++;
      shotInProgress = true;
      firstHitBall = null;
      shotPocketedBalls = [];
      setStatusMessage("");
    }
  }
  aiming = false;
  power = 0;
});

// loop
function loop() {
  // suaviza a mira com lerp
  if (aiming) {
    aimX += (rawAimX - aimX) * AIM_LERP;
    aimY += (rawAimY - aimY) * AIM_LERP;
  }
  drawTable();
  balls.forEach(b => b.update());
  for (let i = 0; i < balls.length; i++) {
    for (let j = i + 1; j < balls.length; j++) {
      collide(balls[i], balls[j]);
    }
  }
  // passagens extras para resolver bolas presas em cluster
  for (let pass = 0; pass < 2; pass++) {
    for (let i = 0; i < balls.length; i++) {
      for (let j = i + 1; j < balls.length; j++) {
        separateBalls(balls[i], balls[j]);
      }
    }
  }
  balls.forEach(b => b.draw());
  drawCue();
  drawSpinWidget();
  if (shotInProgress && !ballsAreMoving()) {
    resolveShot();
  }
  updateHUD();
  requestAnimationFrame(loop);
}
setupBalls();
setStatusMessage("Quebre para começar (Jogador 1).");
updateHUD();

if (resetBtn) {
  resetBtn.addEventListener("click", () => {
    shotCount = 0;
    setupBalls();
    setStatusMessage("Nova partida: Jogador 1 começa.");
    updateHUD();
  });
}

loop();
