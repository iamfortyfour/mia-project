// scene3d.js — 3D-сцена Nexus: диспетчерская станция (three.js r180 из vendor/, без CDN).
//
// МЕТАФОРА (см. ~/docs/nexus-design.md): ядро Nexus в центре, орбиты — уровни стоимости
// провайдеров (costTier: дешёвые ближе), узлы — модели, дуга на орбите — запас квоты
// провайдера (дуга укорачивается, когда квота тратится), пакет запроса летит от ядра к узлу.
//
// КОНТРАКТ (его ждёт хост ~/.config/nexus/web/app.js):
//   window.NexusScene = { ready, init(canvas), setData(sceneData), pulse(kind, payload), stats(), dispose() }
// Все методы терпимы к мусору на входе и НИКОГДА не бросают исключений.
//
// БЮДЖЕТ: только MeshBasicMaterial/PointsMaterial/LineBasicMaterial, без света, теней,
// постобработки и шейдеров; пакеты берутся из пула (никаких аллокаций на событие);
// пауза при скрытой вкладке, троттлинг в покое, упрощение при fps < 20.

const THREE = await import('./vendor/three.module.js');
const {
  Scene, PerspectiveCamera, WebGLRenderer, Group, Mesh, Points, Line,
  IcosahedronGeometry, OctahedronGeometry, BufferGeometry, InstancedMesh,
  MeshBasicMaterial, PointsMaterial, LineBasicMaterial, BufferAttribute,
  Vector3, Matrix4, Color, CatmullRomCurve3,
} = THREE;

const COLORS = {
  core: 0xcba6f7, packet: 0x89b4fa, ok: 0xa6e3a1, empty: 0xf9e2af, fail: 0xf38ba8,
  orbit: 0x313244, off: 0x45475a, track: 0x2a2a3c, wait: 0xf9e2af, escalate: 0xf9e2af,
};

const PACKET_POOL = 20;        // одновременно летящих пакетов (переиспользуются)
const PACKET_TAIL = 7;         // точек в хвосте пакета
const ARC_POINTS = 24;         // точек в дуге квоты

function sig(data) {
  // структура сцены меняется редко — по этой подписи решаем, перестраивать ли геометрию
  try {
    const ps = (data.providers || []).map((p) => p.id + ':' + (p.costTier || 2) + ':' +
      ((p.models || []).map((m) => m.id).join(',') || '-'));
    return ps.join('|');
  } catch (e) { return 'broken'; }
}

class Scene3D {
  constructor() {
    this.ready = false;
    this.canvas = null;
    this.renderer = null;
    this.scene = null;
    this.camera = null;
    this.group = null;          // всё содержимое сцены, чтобы чистить одной операцией
    this.nodes = null;          // InstancedMesh узлов-моделей
    this.nodeIndex = new Map(); // rung -> {x, y, z} для наведения пакетов
    this.arcs = [];             // дуги квоты провайдеров
    this.packets = [];
    this.data = null;
    this.dataSig = '';
    this.lastActivity = 0;
    this.frames = 0;
    this.fpsAcc = 0;
    this.fps = 0;
    this.lowFpsSince = 0;
    this.degraded = false;
    this.loopId = null;
    this.lastFrame = 0;
    this.clock = 0;
  }

  /* ---------------------------------------------------------------- жизненный цикл */

  init(canvas) {
    try {
      if (!canvas) return false;
      if (this.ready && this.canvas === canvas) return true;
      if (this.ready) this.dispose();

      this.canvas = canvas;
      this.renderer = new WebGLRenderer({ canvas, antialias: false, alpha: true, powerPreference: 'low-power' });
      this.renderer.setClearAlpha(0);                       // фон даёт панель (CSS-градиент)
      this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));

      this.scene = new Scene();
      this.camera = new PerspectiveCamera(48, 1, 0.1, 400);
      this.camera.position.set(0, 17, 21);
      this.camera.lookAt(0, 0, 0);
      this.group = new Group();
      this.scene.add(this.group);

      // ядро: каркасный икосаэдр (каркас читается даже в мелком масштабе, в отличие от сплошного шара)
      const coreGeo = new IcosahedronGeometry(1.7, 1);
      this.core = new Mesh(coreGeo, new MeshBasicMaterial({ color: COLORS.core, wireframe: true, transparent: true, opacity: 0.95 }));
      this.coreInner = new Mesh(new IcosahedronGeometry(0.95, 1), new MeshBasicMaterial({ color: COLORS.core, transparent: true, opacity: 0.22 }));
      this.group.add(this.core, this.coreInner);

      // пул пакетов: у каждого своя геометрия хвоста и материал, больше ничего не создаём
      for (let i = 0; i < PACKET_POOL; i++) {
        const geo = new BufferGeometry();
        geo.setAttribute('position', new BufferAttribute(new Float32Array(PACKET_TAIL * 3), 3));
        const mat = new PointsMaterial({ color: COLORS.packet, size: 0.30, transparent: true, opacity: 0, sizeAttenuation: true });
        const pts = new Points(geo, mat);
        pts.frustumCulled = false;
        pts.visible = false;
        this.group.add(pts);
        this.packets.push({ obj: pts, mat, geo, active: false, t: 0, speed: 1, curve: null, kind: 'request' });
      }

      this.resize();
      this._onResize = () => this.resize();
      window.addEventListener('resize', this._onResize);

      this.lastActivity = performance.now();
      this.lastFrame = this.lastActivity;
      this.ready = true;
      this.loop();
      return true;
    } catch (e) {
      console.warn('[NexusScene] init не удался:', e);
      this.ready = false;
      return false;
    }
  }

  resize() {
    try {
      const c = this.canvas;
      if (!c || !this.renderer) return;
      const r = c.getBoundingClientRect();
      const w = Math.max(1, Math.round(r.width || c.clientWidth || 640));
      const h = Math.max(1, Math.round(r.height || c.clientHeight || 360));
      this.renderer.setSize(w, h, false);
      this.camera.aspect = w / h;
      this.camera.updateProjectionMatrix();
    } catch (e) { /* размеры придут следующим кадром */ }
  }

  dispose() {
    try {
      if (this.loopId) cancelAnimationFrame(this.loopId);
      this.loopId = null;
      if (this._onResize) window.removeEventListener('resize', this._onResize);
      this._clearContent();
      if (this.renderer) { this.renderer.dispose(); this.renderer.forceContextLoss?.(); }
      this.renderer = null; this.scene = null; this.camera = null;
      this.ready = false;
    } catch (e) { console.warn('[NexusScene] dispose:', e); }
  }

  _clearContent() {
    try {
      if (!this.group) return;
      for (const p of this.packets) { p.geo?.dispose(); p.mat?.dispose(); }
      this.packets = [];
      this.group.traverse((o) => {
        if (o.geometry) o.geometry.dispose();
        if (o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => m.dispose());
      });
      this.group.clear();
      this.nodes = null;
      this.arcs = [];
      this.nodeIndex = new Map();
    } catch (e) { /* не критично */ }
  }

  /* ---------------------------------------------------------------- данные сцены */

  setData(data) {
    try {
      if (!data || !this.ready) return;
      this.lastActivity = performance.now();
      this.data = data;
      const s = sig(data);
      if (s !== this.dataSig) {                 // структура изменилась — перестраиваем
        this._build(data);
        this.dataSig = s;
      } else {
        this._updateArcs(data);                 // квоты меняются каждые 5 с: правим дуги на месте
      }
    } catch (e) { console.warn('[NexusScene] setData:', e); }
  }

  _build(data) {
    this._clearContent();
    const providers = Array.isArray(data.providers) ? data.providers : [];

    // группировка по уровню стоимости: чем дешевле, тем ближе к ядру
    const tiers = new Map();
    for (const p of providers) {
      const t = Number(p.costTier) || 2;
      if (!tiers.has(t)) tiers.set(t, []);
      tiers.get(t).push(p);
    }

    // узлы-модели одним InstancedMesh (цвет — на экземпляр, без прозрачности: она дороже)
    const nodePositions = [];
    const nodeColors = [];
    const tmpColor = new Color();

    for (const [tier, list] of [...tiers.entries()].sort((a, b) => a[0] - b[0])) {
      const radius = 4.6 + (tier - 1) * 3.1;
      // кольцо-орбита
      const ringPts = [];
      const SEG = 96;
      for (let i = 0; i <= SEG; i++) {
        const a = (i / SEG) * Math.PI * 2;
        ringPts.push(new Vector3(Math.cos(a) * radius, 0, Math.sin(a) * radius));
      }
      const ring = new Line(new BufferGeometry().setFromPoints(ringPts),
        new LineBasicMaterial({ color: COLORS.orbit, transparent: true, opacity: 0.9 }));
      this.group.add(ring);

      // дуги квоты + узлы: провайдеры делят орбиту на равные секторы
      const slice = (Math.PI * 2) / Math.max(1, list.length);
      list.forEach((p, pi) => {
        const start = pi * slice;
        // дорожка (полная дуга сектора) — видно, сколько квоты потеряно
        const trackPts = [];
        for (let i = 0; i < ARC_POINTS; i++) {
          const a = start + slice * 0.86 * (i / (ARC_POINTS - 1));
          trackPts.push(new Vector3(Math.cos(a) * radius, 0, Math.sin(a) * radius));
        }
        const trackGeo = new BufferGeometry().setFromPoints(trackPts);
        this.group.add(new Line(trackGeo, new LineBasicMaterial({ color: COLORS.track, transparent: true, opacity: 0.85 })));

        // дуга остатка квоты (её длину правим при обновлении данных)
        const arcGeo = new BufferGeometry();
        arcGeo.setAttribute('position', new BufferAttribute(new Float32Array(ARC_POINTS * 3), 3));
        const arcMat = new LineBasicMaterial({ color: 0xa6e3a1, transparent: true, opacity: 0.95 });
        this.group.add(new Line(arcGeo, arcMat));
        this.arcs.push({ id: p.id, geo: arcGeo, mat: arcMat, start, slice, radius, provider: p });

        // модели провайдера — узлы внутри его сектора
        const models = Array.isArray(p.models) ? p.models : [];
        const usable = p.key && p.enabled !== false;
        models.forEach((m, mi) => {
          const a = start + slice * (0.12 + 0.62 * ((mi + 0.5) / Math.max(1, models.length)));
          const pos = new Vector3(Math.cos(a) * radius, 0, Math.sin(a) * radius);
          nodePositions.push(pos);
          // цвет: рабочие модели — голубые, выключенные — серые, с ошибками — краснее
          const fires = Number(m.fires) || 0, fails = Number(m.fails) || 0;
          const okRate = fires ? (Number(m.ok) || 0) / fires : 1;
          if (!usable) tmpColor.setHex(COLORS.off);
          else if (okRate < 0.5 && fires >= 3) tmpColor.setHex(COLORS.fail);
          else tmpColor.setHex(COLORS.packet);
          nodeColors.push(tmpColor.clone());
          const rung = String(m.id || '');
          this.nodeIndex.set(rung, { x: pos.x, y: pos.y, z: pos.z });
          const short = rung.split('/').pop();
          if (short !== rung) this.nodeIndex.set(short, { x: pos.x, y: pos.y, z: pos.z });
        });
      });
    }

    if (nodePositions.length) {
      const geo = new OctahedronGeometry(0.17, 0);
      const mesh = new InstancedMesh(geo, new MeshBasicMaterial({ transparent: true, opacity: 0.96 }), nodePositions.length);
      const m4 = new Matrix4();
      nodePositions.forEach((pos, i) => {
        m4.makeTranslation(pos.x, pos.y, pos.z);
        mesh.setMatrixAt(i, m4);
        mesh.setColorAt(i, nodeColors[i] || new Color(COLORS.packet));
      });
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      this.group.add(mesh);
      this.nodes = mesh;
      this.nodeTotal = nodePositions.length;
    } else {
      this.nodeTotal = 0;
    }

    this._updateArcs(data);
  }

  _updateArcs(data) {
    const byId = new Map((Array.isArray(data.providers) ? data.providers : []).map((p) => [p.id, p]));
    for (const arc of this.arcs) {
      const p = byId.get(arc.id) || arc.provider;
      const daily = Number(p.daily) || 0;
      const left = Number(p.left);
      const pct = daily > 0 && isFinite(left) ? Math.max(0, Math.min(1, left / daily)) : (Number(p.pct) || 0) / 100;
      const cool = Number(p.cooldown_sec) || 0;
      const usable = p.key && p.enabled !== false;

      // длина дуги = остаток квоты: кончается топливо — укорачивается дуга
      const pos = arc.geo.getAttribute('position');
      const span = arc.slice * 0.86 * pct;
      for (let i = 0; i < ARC_POINTS; i++) {
        const a = arc.start + (i / (ARC_POINTS - 1)) * span;
        pos.setXYZ(i, Math.cos(a) * arc.radius, 0, Math.sin(a) * arc.radius);
      }
      pos.needsUpdate = true;
      arc.geo.computeBoundingSphere();

      // цвет: зелёный запас → жёлтый → красный; кулдаун/без ключа — серо-синий
      if (!usable) arc.mat.color.setHex(COLORS.off);
      else if (cool > 0) arc.mat.color.setHex(0x6c7fb8);
      else if (pct > 0.5) arc.mat.color.setHex(COLORS.ok);
      else if (pct > 0.15) arc.mat.color.setHex(COLORS.empty);
      else arc.mat.color.setHex(COLORS.fail);
      arc.mat.opacity = usable && cool === 0 ? 0.95 : 0.55;
    }
  }

  /* ---------------------------------------------------------------- события */

  _target(rung) {
    // ищем узел по полному rung, по короткому имени модели или по провайдеру
    if (rung) {
      const key = String(rung);
      if (this.nodeIndex.has(key)) return this.nodeIndex.get(key);
      const short = key.split('/').pop();
      if (this.nodeIndex.has(short)) return this.nodeIndex.get(short);
      const provider = key.split('/')[0];
      for (const [k, v] of this.nodeIndex) if (k.startsWith(provider + '/')) return v;
    }
    // узел не найден — летим в случайную точку на средней орбите (контракт это разрешает)
    const a = Math.random() * Math.PI * 2, r = 6 + Math.random() * 3;
    return { x: Math.cos(a) * r, y: 0, z: Math.sin(a) * r };
  }

  pulse(kind, payload) {
    try {
      if (!this.ready) return;
      this.lastActivity = performance.now();
      const data = payload || {};
      const p = this.packets.find((x) => !x.active);
      if (!p) return;                                  // пул занят — событие просто пропускаем

      const target = this._target(data.rung || data.to || data.model);
      const from = new Vector3(0, 0, 0);
      const to = new Vector3(target.x, target.y, target.z);
      const mid = new Vector3().addVectors(from, to).multiplyScalar(0.5);
      mid.y += 2.2 + Math.random() * 1.6;               // дуга вверх, а не прямая

      let color = COLORS.packet;
      if (kind === 'ok') color = COLORS.ok;
      else if (kind === 'fail') color = COLORS.fail;
      else if (kind === 'empty') color = COLORS.empty;
      else if (kind === 'wait') color = COLORS.wait;
      else if (kind === 'escalate') color = COLORS.escalate;

      if (kind === 'fail') {
        // отказ: пакет улетает к узлу и возвращается к ядру
        target.y += 0;
        p.curve = new CatmullRomCurve3([from.clone(), mid.clone(), to.clone(),
          new Vector3().addVectors(to, mid).multiplyScalar(0.5).setY(mid.y + 1.2), from.clone()]);
      } else if (kind === 'wait') {
        // ожидание: пакет облетает узел по небольшой петле
        const loopA = new Vector3(to.x + 1.2, to.y + 0.8, to.z);
        const loopB = new Vector3(to.x - 0.6, to.y + 1.1, to.z + 1.1);
        p.curve = new CatmullRomCurve3([from.clone(), mid.clone(), to.clone(), loopA, loopB, to.clone()]);
      } else {
        p.curve = new CatmullRomCurve3([from.clone(), mid.clone(), to.clone()]);
      }

      p.mat.color.setHex(color);
      p.mat.size = kind === 'squeeze' ? 0.24 : 0.30;
      p.obj.visible = true;
      p.active = true;
      p.t = 0;
      p.kind = kind;
      p.speed = kind === 'fail' ? 0.65 : (kind === 'request' ? 1.6 : 1.15);
      p.obj.position.set(0, 0, 0);
    } catch (e) { console.warn('[NexusScene] pulse:', e); }
  }

  _updatePackets(dt) {
    for (const p of this.packets) {
      if (!p.active) continue;
      p.t += dt * p.speed;
      if (p.t >= 1) {
        p.active = false;
        p.obj.visible = false;
        p.mat.opacity = 0;
        continue;
      }
      // хвост: точки вдоль кривой позади головы
      const arr = p.geo.getAttribute('position');
      for (let i = 0; i < PACKET_TAIL; i++) {
        const tt = Math.max(0, Math.min(1, p.t - i * 0.022));
        const v = p.curve.getPoint(tt);
        arr.setXYZ(i, v.x, v.y, v.z);
      }
      arr.needsUpdate = true;
      p.geo.computeBoundingSphere();
      // сжатие контекста видно как уменьшение пакета, обычный пакет не мигает
      p.mat.opacity = p.kind === 'squeeze' ? 0.95 : 0.9;
    }
  }

  /* ---------------------------------------------------------------- цикл отрисовки */

  loop() {
    if (!this.ready) return;
    this.loopId = requestAnimationFrame(() => this.loop());
    const now = performance.now();

    // пауза, когда вкладка не видна (host использует атрибут hidden, а не data-hidden)
    if (document.hidden || !this.canvas || this.canvas.offsetParent === null) return;

    // троттлинг: 30 fps в работе, ~10 fps в покое (10 секунд без событий)
    const idle = now - this.lastActivity;
    const minInterval = idle > 10000 ? 100 : 33;
    if (now - this.lastFrame < minInterval) return;

    const dt = Math.min(0.05, (now - this.lastFrame) / 1000);
    this.lastFrame = now;
    this.clock += dt;

    try {
      // дыхание сцены: ядро пульсирует, камера медленно плывёт ±5°, орбиты вращаются
      const breath = 1 + 0.04 * Math.sin(this.clock * 0.9);
      const reqs = Number(this.data?.centre?.requests) || 0;
      const corePulse = 1 + 0.05 * Math.sin(this.clock * (0.7 + Math.min(reqs / 400, 1.2)));
      if (this.core) {
        this.core.scale.setScalar(breath * corePulse);
        this.core.rotation.y += dt * 0.12;
        this.core.rotation.x += dt * 0.05;
        this.coreInner.scale.setScalar(corePulse * 0.98);
      }
      if (this.group) this.group.rotation.y += dt * 0.035;
      if (this.camera) {
        const a = Math.sin(this.clock * 0.12) * 0.087;   // ±5°
        this.camera.position.set(Math.sin(a) * 21, 17, Math.cos(a) * 21);
        this.camera.lookAt(0, 0, 0);
      }

      this._updatePackets(dt);
      this.renderer.render(this.scene, this.camera);

      // статистика: fps считаем по кадрам за секунду, а не по одному дельта-значению
      this.frames++;
      this.fpsAcc += dt;
      if (this.fpsAcc >= 0.5) {
        this.fps = this.frames / this.fpsAcc;
        this.frames = 0; this.fpsAcc = 0;
        if (this.fps < 20) {
          if (!this.lowFpsSince) this.lowFpsSince = now;
          else if (now - this.lowFpsSince > 3000 && !this.degraded) {
            this.degraded = true;                                  // упрощаем: без хвостов пакетов
            for (const p of this.packets) p.mat.size = 0.34;
          }
        } else {
          this.lowFpsSince = 0;
          if (this.degraded && this.fps >= 24) {
            this.degraded = false;
            for (const p of this.packets) p.mat.size = 0.30;
          }
        }
      }
    } catch (e) {
      console.warn('[NexusScene] кадр пропущен:', e);
    }
  }

  stats() {
    return {
      fps: this.fps || 0,
      drawCalls: this.renderer ? this.renderer.info.render.calls : 0,
      tris: this.renderer ? this.renderer.info.render.triangles : 0,
      instances: this.nodeTotal || 0,
      packets: this.packets.filter((p) => p.active).length,
      degraded: this.degraded,
    };
  }
}

const instance = new Scene3D();
window.NexusScene = {
  ready: false,
  init: (canvas) => { const ok = instance.init(canvas); window.NexusScene.ready = instance.ready; return ok; },
  setData: (d) => instance.setData(d),
  pulse: (k, p) => instance.pulse(k, p),
  stats: () => instance.stats(),
  dispose: () => { instance.dispose(); window.NexusScene.ready = false; },
  _scene: instance,
};
