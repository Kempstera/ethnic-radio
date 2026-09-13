#!/usr/bin/env node
/*
 * build-data.js — 把电台数据「烤」进站点
 *
 * 为什么需要它：
 *   radio-browser.info 的三个镜像全在欧洲（de1/nl1/at1）。中国用户每次打开页面
 *   都要跨海拉取 2.5MB 全量数据，经常超时 → 页面只剩骨架屏（"六个空框"）。
 *   本脚本在构建期拉一次数据，按 index.html 里的同款规则筛选出民族语言电台，
 *   写成 stations.json 随站点一起部署。浏览器因此只读自己域名下的静态文件，
 *   必然成功；在线数据仅用于后台静默补齐新增电台。
 *
 * 用法：node build-data.js
 *
 * 关键点：分类规则直接从 index.html 里抽取，不重复维护，避免两边漂移。
 */
"use strict";

const fs = require("fs");
const path = require("path");

const DIR = __dirname;
const HTML = path.join(DIR, "index.html");
const OUT = path.join(DIR, "stations.json");

const MIRRORS = [
  "https://de1.api.radio-browser.info",
  "https://nl1.api.radio-browser.info",
  "https://at1.api.radio-browser.info",
];
// 注意：不带 limit 时该接口只返回 1000 条，中国实际有 ~2500 个台
const QUERY = "/json/stations/bycountry/china?hidebroken=true&limit=20000";

/* ---------- 1. 从 index.html 抽取配置与规则（单一事实来源） ---------- */
const html = fs.readFileSync(HTML, "utf8");

function sliceBlock(startMarker, endMarker) {
  const a = html.indexOf(startMarker);
  if (a < 0) throw new Error("找不到起点: " + startMarker);
  const b = html.indexOf(endMarker, a);
  if (b < 0) throw new Error("找不到终点: " + endMarker);
  return html.slice(a, b);
}

const configSrc = sliceBlock("var LANGS = [", "\n  /* ==");
const helperSrc = sliceBlock("var BLOCK_NAME", "\n  /*");

// 在沙箱里求值这两段，拿到 LANGS / REGIONS / BLOCK_NAME
const factory = new Function(
  configSrc + "\n" + helperSrc + "\nreturn { LANGS: LANGS, REGIONS: REGIONS, BLOCK_NAME: BLOCK_NAME };"
);
const CFG = factory();

/* ---------- 2. 与页面同款的归一化/分类/合并逻辑 ---------- */
function strip(u) { return (u || "").replace(/\s+/g, ""); }

function classify(name, tags) {
  const blob = name + " " + tags;
  for (const c of CFG.LANGS) {
    if (c.re.test(blob)) {
      return { key: c.key, label: c.label, icon: c.icon, tier: "lang", region: "" };
    }
  }
  for (const r of CFG.REGIONS) {
    if (r.re.test(blob)) {
      return { key: "region", label: "民族地区", icon: "fa-location-dot", tier: "region", region: r.label };
    }
  }
  return null;
}

function nameKey(n) {
  return n
    .replace(/[（(][^）)]*[）)]/g, "")
    .replace(/(FM|AM)\s*\d+(\.\d+)?/gi, "")
    .replace(/[^0-9A-Za-z\u4e00-\u9fff\uac00-\ud7af\u3040-\u30ff]/g, "")
    .toLowerCase();
}

function build(raw) {
  const seenUrl = Object.create(null);
  const seenName = Object.create(null);
  const out = [];

  for (const s of raw) {
    if (!s) continue;
    const name = (s.name || "").replace(/\s+/g, " ").trim();
    const tags = (s.tags || "").trim();
    if (!name || CFG.BLOCK_NAME.test(name)) continue;

    const cat = classify(name, tags);
    if (!cat) continue;

    const url = strip(s.url_resolved || s.url || "");
    if (!url || !/^https?:\/\//i.test(url)) continue;
    if (seenUrl[url]) continue;

    const nk = nameKey(name);
    if (nk && seenName[nk]) {
      const prev = seenName[nk];
      const better =
        (url.indexOf("https://") === 0 && prev.url.indexOf("https://") !== 0) ||
        ((url.indexOf("https://") === 0) === (prev.url.indexOf("https://") === 0) &&
          (s.bitrate || 0) > (prev.bitrate || 0));
      if (!better) continue;
      out.splice(out.indexOf(prev), 1);
    }

    const item = {
      id: s.stationuuid || name + url,
      name: name,
      tags: tags ? tags.split(",").map((t) => t.trim()).filter(Boolean).slice(0, 4) : [],
      url: url,
      cat: cat.key,
      catLabel: cat.tier === "region" ? "民族地区 · " + cat.region : cat.label,
      catIcon: cat.icon,
      codec: (s.codec || "").toUpperCase(),
      bitrate: s.bitrate || 0,
      home: s.homepage || "",
    };
    seenUrl[url] = true;
    if (nk) seenName[nk] = item;
    out.push(item);
  }

  const order = { region: CFG.LANGS.length };
  CFG.LANGS.forEach((c, i) => { order[c.key] = i; });
  out.sort((a, b) => {
    const d = (order[a.cat] === undefined ? 99 : order[a.cat]) - (order[b.cat] === undefined ? 99 : order[b.cat]);
    return d !== 0 ? d : a.name.localeCompare(b.name, "zh-Hans-CN");
  });
  return out;
}

/* ---------- 3. 拉取（多镜像 + 重试） ---------- */
async function fetchRaw() {
  let lastErr;
  for (const base of MIRRORS) {
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const res = await fetch(base + QUERY, { headers: { Accept: "application/json" } });
        if (!res.ok) throw new Error("HTTP " + res.status);
        const d = await res.json();
        if (!Array.isArray(d) || !d.length) throw new Error("empty payload");
        return { base, data: d };
      } catch (e) {
        lastErr = e;
        console.error(`  ✗ ${base} (第${attempt}次): ${e.message}`);
      }
    }
  }
  throw lastErr || new Error("all mirrors failed");
}

(async function main() {
  const allowLocal = process.argv.includes("--from-cache");
  let raw;
  let source;

  if (allowLocal) {
    const cache = "/tmp/cn2.json";
    if (!fs.existsSync(cache)) throw new Error("缓存不存在: " + cache);
    raw = JSON.parse(fs.readFileSync(cache, "utf8"));
    source = "cache:" + cache;
    console.log(`使用本地缓存 ${cache}（${raw.length} 条）`);
  } else {
    console.log("拉取 radio-browser（de1 → nl1 → at1）…");
    const r = await fetchRaw();
    raw = r.data;
    source = r.base;
    console.log(`  ✓ ${r.base} → ${raw.length} 条原始数据`);
  }

  const list = build(raw);
  const payload = {
    generated: new Date().toISOString(),
    source: source,
    total: list.length,
    stations: list,
  };
  fs.writeFileSync(OUT, JSON.stringify(payload));
  const kb = (fs.statSync(OUT).size / 1024).toFixed(1);
  console.log(`  ✓ 写入 ${path.relative(process.cwd(), OUT)} — ${list.length} 个台 / ${kb}KB`);

  const counts = {};
  list.forEach((s) => { counts[s.catLabel] = (counts[s.catLabel] || 0) + 1; });
  Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .forEach(([k, v]) => console.log(`      ${k}: ${v}`));
})().catch((e) => {
  console.error("构建失败:", e.message);
  process.exit(1);
});
