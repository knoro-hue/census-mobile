// 交通量・駅乗降・周辺人口データを公開元から取得し、スマホ版ページ用の静的JSONに変換する。
// GitHub Actions（.github/workflows/build-data.yml）から実行する想定。手元でも `node scripts/build.mjs stations pop traffic` で動く。
//
// 出力（すべて data/ 以下、GitHub Pagesでそのまま配信）
//   data/meta.json                     作成日時・件数・出典
//   data/stations/{gy}_{gx}.json       駅別乗降客数（0.25度グリッド）
//   data/pop/{1次メッシュ}.json         250mメッシュ人口（1次メッシュ単位）
//   data/roads/{x}_{y}.json            交通量調査区間＋箇所別基本表の値（ズーム12タイル単位）
//
// 計算方法・項目は Chrome拡張「店舗開発マップ支援」の background.js と同じ。

import fs from "node:fs/promises";
import path from "node:path";
import zlib from "node:zlib";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const OUT = path.join(ROOT, "data");
const CACHE = path.join(ROOT, "build-cache");
const FORCE = process.env.FORCE === "true";
const TIME_BUDGET_MS = Number(process.env.TIME_BUDGET_MIN || 300) * 60_000;
const STARTED = Date.now();
const UA = "census-mobile data build (+https://github.com/knoro-hue/census-mobile)";

const MLIT_GEOJSON_BASE = process.env.MLIT_GEOJSON_BASE || "https://www.mlit.go.jp/road/ir/ir-data/census_visualizationR3";
const MLIT_KASHO_BASE = process.env.MLIT_KASHO_BASE || "https://www.mlit.go.jp/road/census/r3/data/csv";
const ROAD_TYPES = ["drm10", "drm20", "drm31", "drm32", "drm40_50", "drm60_70"];
const TILE_ZOOM = 12;
const STATION_DATA_URL = process.env.STATION_DATA_URL || "https://raw.githubusercontent.com/shiwaku/ksj-station-homedoor/d18f9c31b077a4d030b7d75461ac68b0dae7885f/output/S12-25_NumberOfPassengers_points.geojson";
const STATION_GRID_DEG = 0.25;
const POP_STATS_ID = "T001142";
const ESTAT_BASE = process.env.ESTAT_BASE || "https://www.e-stat.go.jp/gis/statmap-search/data";

// ---------------- 共通 ----------------
const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const overBudget = () => Date.now() - STARTED > TIME_BUDGET_MS;

async function fetchRetry(url, { tries = 5, minGapMs = 0 } = {}) {
  let wait = 2000;
  for (let i = 1; i <= tries; i++) {
    try {
      const r = await fetch(url, { headers: { "User-Agent": UA } });
      if (r.status === 404) return null;
      if (r.ok) { const b = Buffer.from(await r.arrayBuffer()); if (minGapMs) await sleep(minGapMs); return b; }
      if (r.status !== 429 && r.status < 500) throw new Error(`HTTP ${r.status}`);
      log(`  ${url} → HTTP ${r.status}、${wait / 1000}秒後に再試行 (${i}/${tries})`);
    } catch (e) {
      if (i === tries) throw new Error(`${url}: ${e.message}`);
      log(`  ${url} → ${e.message}、${wait / 1000}秒後に再試行 (${i}/${tries})`);
    }
    await sleep(wait); wait = Math.min(wait * 2, 60000);
  }
  throw new Error(`${url}: 再試行上限`);
}

async function pool(items, concurrency, fn) {
  let idx = 0;
  const workers = Array.from({ length: concurrency }, async () => {
    while (idx < items.length) { const i = idx++; await fn(items[i], i); }
  });
  await Promise.all(workers);
}

async function writeJson(file, obj) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(obj));
}
async function exists(file) { try { await fs.access(file); return true; } catch { return false; } }
async function readJson(file, fallback) { try { return JSON.parse(await fs.readFile(file, "utf8")); } catch { return fallback; } }

async function updateMeta(key, info) {
  const file = path.join(OUT, "meta.json");
  const meta = await readJson(file, {});
  // 中身が前回と同じなら日時も変えない（無駄なコミット＝Pagesの再公開を起こさない）
  const prev = meta[key] || {}, { builtAt: _, ...prevInfo } = prev;
  if (JSON.stringify(prevInfo) === JSON.stringify(info)) return;
  meta[key] = { ...info, builtAt: new Date().toISOString() };
  await writeJson(file, meta);
}

function parseCsv(text, onRow) {
  let row = [], field = "", q = false;
  for (let i = 0; i <= text.length; i++) {
    const ch = i < text.length ? text[i] : "\n";
    if (q) {
      if (ch === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else q = false; }
      else field += ch;
      continue;
    }
    if (ch === '"') q = true;
    else if (ch === ",") { row.push(field); field = ""; }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(field); field = "";
      if (row.length > 1 || row[0] !== "") onRow(row);
      row = [];
    } else field += ch;
  }
}

function tileOf(lat, lng, z = TILE_ZOOM) {
  const n = 2 ** z, r = lat * Math.PI / 180;
  return { x: Math.floor((lng + 180) / 360 * n), y: Math.floor((1 - Math.asinh(Math.tan(r)) / Math.PI) / 2 * n) };
}

// ---------------- 駅別乗降客数 ----------------
function firstNonEmpty(...v) { for (const x of v) { const s = String(x ?? "").trim(); if (s) return s; } return null; }
function finiteNumber(...v) { for (const x of v) { if (x == null || x === "") continue; const n = Number(String(x).replace(/,/g, "")); if (Number.isFinite(n)) return n; } return null; }

async function buildStations() {
  log("駅別乗降客数：取得開始");
  const buf = await fetchRetry(STATION_DATA_URL);
  if (!buf) throw new Error("駅データが見つかりません");
  const gj = JSON.parse(buf.toString("utf8"));
  const groups = new Map();
  for (const f of gj.features || []) {
    const g = f?.geometry; if (g?.type !== "Point") continue;
    const lng = Number(g.coordinates[0]), lat = Number(g.coordinates[1]);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    const p = f.properties || {};
    const name = firstNonEmpty(p.S12_001, p.S12_001_ja, p.station_name); if (!name) continue;
    const grp = firstNonEmpty(p.S12_001g, p.S12_001G, p.S12_001c, p.S12_001C);
    const key = grp ? `g:${grp}` : `n:${name}:${lat.toFixed(3)}:${lng.toFixed(3)}`;
    let s = groups.get(key);
    if (!s) groups.set(key, s = { name, latSum: 0, lngSum: 0, n: 0, pax: null, ops: new Set(), lines: new Set() });
    s.latSum += lat; s.lngSum += lng; s.n++;
    const pax = finiteNumber(p.S12_061, p.S12_057);
    if (pax !== null && (s.pax === null || pax > s.pax)) s.pax = pax;
    const op = firstNonEmpty(p.S12_002, p.S12_002_ja, p.operator); if (op) s.ops.add(op);
    const ln = firstNonEmpty(p.S12_003, p.S12_003_ja, p.line); if (ln) s.lines.add(ln);
  }
  const cells = new Map();
  for (const s of groups.values()) {
    const lat = s.latSum / s.n, lng = s.lngSum / s.n;
    const key = `${Math.floor((lat + 90) / STATION_GRID_DEG)}_${Math.floor((lng + 180) / STATION_GRID_DEG)}`;
    if (!cells.has(key)) cells.set(key, []);
    cells.get(key).push([s.name, +lat.toFixed(6), +lng.toFixed(6), s.pax, [...s.ops].slice(0, 8), [...s.lines].slice(0, 12)]);
  }
  await fs.rm(path.join(OUT, "stations"), { recursive: true, force: true });
  for (const [key, list] of cells) await writeJson(path.join(OUT, "stations", `${key}.json`), list);
  // 検索用の駅名一覧 [駅名, 緯度, 経度, 事業者, 乗降客数]
  const index = [...groups.values()].map(s => [s.name, +(s.latSum / s.n).toFixed(6), +(s.lngSum / s.n).toFixed(6), [...s.ops].slice(0, 3).join("・"), s.pax]);
  await writeJson(path.join(OUT, "stations-index.json"), index);
  await updateMeta("stations", { count: groups.size, cells: cells.size, gridDeg: STATION_GRID_DEG, source: "国土数値情報 駅別乗降客数 S12-25（2024年度）国土交通省 CC BY 4.0" });
  log(`駅別乗降客数：${groups.size}駅 / ${cells.size}セル`);
}

// ---------------- 周辺人口（250mメッシュ） ----------------
function extractTxtFromZip(buf) {
  const eocdSig = 0x06054b50;
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) if (buf.readUInt32LE(i) === eocdSig) { eocd = i; break; }
  if (eocd < 0) throw new Error("ZIP終端なし");
  const entries = buf.readUInt16LE(eocd + 10);
  let pos = buf.readUInt32LE(eocd + 16);
  for (let i = 0; i < entries; i++) {
    const method = buf.readUInt16LE(pos + 10), csize = buf.readUInt32LE(pos + 20);
    const nl = buf.readUInt16LE(pos + 28), el = buf.readUInt16LE(pos + 30), cl = buf.readUInt16LE(pos + 32);
    const off = buf.readUInt32LE(pos + 42);
    const name = buf.subarray(pos + 46, pos + 46 + nl).toString("utf8");
    if (/\.txt$/i.test(name)) {
      const start = off + 30 + buf.readUInt16LE(off + 26) + buf.readUInt16LE(off + 28);
      const data = buf.subarray(start, start + csize);
      if (method === 0) return data;
      if (method === 8) return zlib.inflateRawSync(data);
      throw new Error("未対応の圧縮方式 " + method);
    }
    pos += 46 + nl + el + cl;
  }
  throw new Error("ZIP内にTXTなし");
}
function statNumber(v) { const s = String(v ?? "").trim().replaceAll(",", ""); if (!s || s === "*" || s === "-" || s === "X") return null; const n = Number(s); return Number.isFinite(n) ? n : null; }

async function buildPopulation() {
  // 日本全域の1次メッシュ候補（緯度24〜46度・経度122〜149度）。存在しないコードは e-Stat が空/エラーを返すので飛ばす。
  const codes = [];
  for (let a = 36; a <= 68; a++) for (let b = 22; b <= 48; b++) codes.push(`${a}${String(b).padStart(2, "0")}`);
  const doneFile = path.join(CACHE, "pop-checked.json");
  const checked = FORCE ? {} : await readJson(doneFile, {});
  const todo = codes.filter(c => !(c in checked));
  log(`周辺人口：1次メッシュ ${codes.length}候補中 ${todo.length}件を確認`);
  const dec = new TextDecoder("shift_jis");
  let n = 0;
  await pool(todo, 3, async code => {
    if (overBudget()) return;
    const url = `${ESTAT_BASE}?statsId=${POP_STATS_ID}&code=${code}&downloadType=2`;
    try {
      const buf = await fetchRetry(url, { minGapMs: 300 });
      if (!buf || buf.length < 4 || buf[0] !== 0x50 || buf[1] !== 0x4b) { checked[code] = 0; return; }
      const text = dec.decode(extractTxtFromZip(buf)).replace(/^﻿/, "");
      const lines = text.split(/\r?\n/).filter(Boolean);
      let head = null; const rows = [];
      parseCsv(lines[0] + "\n", r => { head = r.map(v => v.trim()); });
      const c = k => head.indexOf(k);
      const I = { key: c("KEY_CODE"), ht: c("HTKSYORI"), pop: c("T001142001"), a0: c("T001142004"), a15: c("T001142010"), a65: c("T001142019"), hh: c("T001142034") };
      if (I.key < 0 || I.pop < 0 || I.hh < 0) throw new Error("列定義を認識できません");
      parseCsv(lines.slice(1).join("\n") + "\n", f => {
        const k = String(f[I.key] ?? "").trim(); if (!/^\d{10}$/.test(k)) return;
        const pop = statNumber(f[I.pop]), hh = statNumber(f[I.hh]);
        if (pop == null && hh == null) return;
        const g = i => (i >= 0 ? statNumber(f[i]) : null);
        // [下6桁, 秘匿処理, 人口, 世帯, 0-14歳, 15-64歳, 65歳以上]
        rows.push([k.slice(4), I.ht >= 0 ? Number(f[I.ht] || 0) : 0, pop ?? 0, hh ?? 0, g(I.a0), g(I.a15), g(I.a65)]);
      });
      if (!rows.length) { checked[code] = 0; return; }
      await writeJson(path.join(OUT, "pop", `${code}.json`), rows);
      checked[code] = rows.length;
      if (++n % 20 === 0) { log(`  人口メッシュ ${n}件作成`); await writeJson(doneFile, checked); }
    } catch (e) { log(`  人口 M${code} 失敗: ${e.message}`); }
  });
  await writeJson(doneFile, checked);
  const avail = Object.entries(checked).filter(([, v]) => v > 0).map(([k]) => k).sort();
  await updateMeta("pop", { primaryMeshes: avail.length, complete: codes.every(c => c in checked), source: "e-Stat 令和2年国勢調査 250mメッシュ T001142" });
  log(`周辺人口：${avail.length}メッシュ（今回作成 ${n}件）`);
}

// ---------------- 交通量 ----------------
const num = v => { const s = String(v ?? "").trim().replace(/,/g, ""); if (!s) return null; const n = Number(s); return Number.isFinite(n) ? n : null; };
const str = v => { const s = String(v ?? "").trim(); return s || null; };
const ROAD_KIND = { 1: "高速自動車国道", 2: "都市高速道路", 3: "一般国道", 4: "主要地方道（都道府県道）", 5: "主要地方道（指定市市道）", 6: "一般都道府県道", 7: "指定市の一般市道" };
function obsLabel(r) {
  const v = [str(r["上り／令和３年度調査交通量観測・非観測の別"]), str(r["下り／令和３年度調査交通量観測・非観測の別"])].filter(Boolean);
  if (!v.length) return null; if (v.some(x => x === "2")) return "推定値を含む"; if (v.every(x => x === "1")) return "観測値"; return "観測条件混在";
}
function obsHours(r) {
  const v = [str(r["上り／１２時間・２４時間観測の別"]), str(r["下り／１２時間・２４時間観測の別"])].filter(Boolean);
  if (!v.length) return null; if (v.every(x => x === "2")) return "24時間観測地点"; if (v.every(x => x === "1")) return "12時間観測地点";
  if (v.includes("1") && v.includes("2")) return "12/24時間観測混在"; return null;
}
// 箇所別基本表の1行 → 表示用の値（拡張機能 buildTrafficCandidate と同じ項目）
function trafficAttrs(r) {
  const kc = str(r["道路種別"]);
  return {
    route: str(r["路線名"]), routeNo: num(r["路線番号"]), kind: ROAD_KIND[kc] || kc,
    obs: obsLabel(r), hours: obsHours(r),
    t12: num(r["昼間１２時間自動車類交通量（上下合計）／合計（台）"]),
    t24: num(r["２４時間自動車類交通量（上下合計）／合計（台）"]),
    s12: num(r["昼間１２時間自動車類交通量（上下合計）／小型車（台）"]),
    l12: num(r["昼間１２時間自動車類交通量（上下合計）／大型車（台）"]),
    lr: num(r["昼間１２時間大型車混入率（％）"]),
    cong: num(r["混雑度"]), lanes: num(r["車線数"]), width: num(r["幅員構成／車道幅員（ｍ）"]),
    spUp: num(r["朝夕（混雑時）／上り／旅行速度／合計（ｋｍ／ｈ）"]), spDn: num(r["朝夕（混雑時）／下り／旅行速度／合計（ｋｍ／ｈ）"]),
    up12: num(r["上り／昼間１２時間自動車類交通量／合計（台）"]), dn12: num(r["下り／昼間１２時間自動車類交通量／合計（台）"]),
    side: str(r["代表沿道状況"])
  };
}
function decodeKasho(buf) {
  const utf = new TextDecoder("utf-8").decode(buf);
  if (utf.includes("交通調査基本区間番号") && !utf.includes("�")) return utf;
  return new TextDecoder("shift_jis").decode(buf);
}

async function loadKashoAll() {
  const attrs = new Map();
  await pool(Array.from({ length: 47 }, (_, i) => String(i + 1).padStart(2, "0")), 2, async pref => {
    const buf = await fetchRetry(`${MLIT_KASHO_BASE}/kasyo${pref}.csv`, { minGapMs: 500 });
    if (!buf) { log(`  箇所別基本表 kasyo${pref}.csv なし`); return; }
    let head = null, n = 0;
    parseCsv(decodeKasho(buf), row => {
      if (!head) { head = row.map((v, i) => (i === 0 ? v.replace(/^﻿/, "") : v).trim()); return; }
      const id = String(row[0] ?? "").replace(/^﻿/, "").trim(); if (!/^\d{11}$/.test(id)) return;
      const o = {}; for (let i = 0; i < head.length; i++) o[head[i]] = row[i] ?? "";
      attrs.set(id, trafficAttrs(o)); n++;
    });
    log(`  箇所別基本表 ${pref}：${n}区間`);
  });
  return attrs;
}

async function seedTiles() {
  const seeds = new Set();
  // 人口がある250mメッシュの中心を含むタイル
  const popDir = path.join(OUT, "pop");
  for (const f of await fs.readdir(popDir).catch(() => [])) {
    const code = f.replace(".json", ""); const rows = await readJson(path.join(popDir, f), []);
    const p = Number(code.slice(0, 2)), q = Number(code.slice(2, 4));
    for (const r of rows) {
      if (!(r[2] > 0)) continue;
      const s = r[0]; // 6桁: 2次(緯,経) 3次(緯,経) 4分の1 8分の1
      const lat = p / 1.5 + Number(s[0]) / 12 + Number(s[2]) / 120 + 1 / 240;
      const lng = q + 100 + Number(s[1]) / 8 + Number(s[3]) / 80 + 1 / 160;
      const t = tileOf(lat, lng); seeds.add(`${t.x}_${t.y}`);
    }
  }
  // 駅
  const stDir = path.join(OUT, "stations");
  for (const f of await fs.readdir(stDir).catch(() => [])) for (const s of await readJson(path.join(stDir, f), [])) { const t = tileOf(s[1], s[2]); seeds.add(`${t.x}_${t.y}`); }
  return seeds;
}

function quantLine(coords) {
  const out = [];
  for (const c of coords) { const lng = Number(c[0]), lat = Number(c[1]); if (Number.isFinite(lng) && Number.isFinite(lat)) out.push(Math.round(lng * 1e5), Math.round(lat * 1e5)); }
  return out;
}

async function buildTraffic() {
  log("交通量：箇所別基本表CSVを取得");
  const attrs = await loadKashoAll();
  if (!attrs.size) throw new Error("箇所別基本表を1件も取得できませんでした");
  const seeds = await seedTiles();
  log(`交通量：起点タイル ${seeds.size}枚`);
  const emptyFile = path.join(CACHE, "roads-empty.json");
  const empty = new Set(FORCE ? [] : await readJson(emptyFile, []));
  const visited = new Set(), queue = [...seeds];
  for (const k of queue) visited.add(k);
  let fetched = 0, written = 0, stopped = false;
  const inJapan = (x, y) => { const n = 2 ** TILE_ZOOM; const lng = x / n * 360 - 180; const lat = Math.atan(Math.sinh(Math.PI * (1 - 2 * y / n))) * 180 / Math.PI; return lng > 122 && lng < 154.5 && lat > 20 && lat < 46; };
  const expand = key => {
    const [x, y] = key.split("_").map(Number);
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
      const k = `${x + dx}_${y + dy}`; if (!visited.has(k) && inJapan(x + dx, y + dy)) { visited.add(k); queue.push(k); }
    }
  };
  while (queue.length && !stopped) {
    const batch = queue.splice(0, 400);
    await pool(batch, 4, async key => {
      if (stopped) return;
      if (overBudget()) { stopped = true; queue.unshift(key); return; }
      const file = path.join(OUT, "roads", `${key}.json`);
      if (!FORCE && empty.has(key)) return;
      if (!FORCE && await exists(file)) { expand(key); return; }
      const [x, y] = key.split("_");
      const roads = new Map();
      for (const rt of ROAD_TYPES) {
        const buf = await fetchRetry(`${MLIT_GEOJSON_BASE}/${rt}/${TILE_ZOOM}/${x}/${y}.geojson`, { minGapMs: 120 });
        fetched++;
        if (!buf) continue;
        let gj; try { gj = JSON.parse(buf.toString("utf8")); } catch { continue; }
        for (const f of gj.features || []) {
          const census = String(f?.properties?.census ?? "").trim(); if (!/^\d{11}$/.test(census)) continue;
          const g = f.geometry; const lines = g?.type === "LineString" ? [g.coordinates] : g?.type === "MultiLineString" ? g.coordinates : [];
          let r = roads.get(census);
          if (!r) roads.set(census, r = { c: census, rt, g: [], a: attrs.get(census) || null });
          for (const ln of lines) { const q = quantLine(ln || []); if (q.length >= 4) r.g.push(q); }
        }
      }
      const list = [...roads.values()].filter(r => r.g.length);
      if (!list.length) { empty.add(key); return; }
      await writeJson(file, list); written++; expand(key);
      if (written % 200 === 0) { log(`  道路タイル ${written}枚作成（取得 ${fetched}件・残り ${queue.length}枚）`); await writeJson(emptyFile, [...empty]); }
    });
  }
  await writeJson(emptyFile, [...empty]);
  const total = (await fs.readdir(path.join(OUT, "roads")).catch(() => [])).length;
  await updateMeta("traffic", { tiles: total, tileZoom: TILE_ZOOM, sections: attrs.size, complete: !stopped && !queue.length, source: "令和3年度 全国道路・街路交通情勢調査 一般交通量調査（国土交通省）" });
  log(`交通量：道路タイル 計${total}枚（今回 ${written}枚）${stopped ? "／時間切れのため次回続きから" : "／完了"}`);
}

// ---------------- 市区町村名（検索結果の住所表示用） ----------------
async function buildMuni() {
  const buf = await fetchRetry("https://maps.gsi.go.jp/js/muni.js");
  if (!buf) throw new Error("muni.js が見つかりません");
  const text = buf.toString("utf8"), map = {};
  const re = /GSI\.MUNI_ARRAY\["(\d{4,5})"\]\s*=\s*['"]([^'"]+)['"]/g;
  let m;
  while ((m = re.exec(text))) {
    const parts = m[2].split(","), pref = parts[1] || "", muni = (parts[3] || "").replace(/[\s\u3000]+/g, "");
    if (pref) map[m[1].padStart(5, "0")] = pref + muni;
  }
  if (Object.keys(map).length < 1000) throw new Error("市区町村辞書の件数が少なすぎます: " + Object.keys(map).length);
  await writeJson(path.join(OUT, "muni.json"), map);
  log(`市区町村名：${Object.keys(map).length}件`);
}

// ---------------- 実行 ----------------
const steps = (process.argv.slice(2).join(",") || "muni,stations,pop,traffic").split(",").map(s => s.trim()).filter(Boolean);
await fs.mkdir(OUT, { recursive: true }); await fs.mkdir(CACHE, { recursive: true });
for (const s of steps) {
  if (s === "muni") await buildMuni();
  else if (s === "stations") await buildStations();
  else if (s === "pop") await buildPopulation();
  else if (s === "traffic") await buildTraffic();
  else throw new Error("不明なステップ: " + s);
}
