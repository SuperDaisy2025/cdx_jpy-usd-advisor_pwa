import { readFile, writeFile } from "node:fs/promises";

const DATA_PATH = new URL("../data/advisor-state.json", import.meta.url);
const JST = "Asia/Tokyo";
const FRANKFURTER_API = "https://api.frankfurter.dev/v2";
const CFTC_LEGACY_URLS = [
  "https://www.cftc.gov/dea/newcot/deacom.txt",
  "https://www.cftc.gov/dea/newcot/deafut.txt"
];
const NEWS_RSS_URL =
  process.env.NEWS_RSS_URL ||
  "https://news.google.com/rss/search?q=USDJPY%20OR%20yen%20OR%20Bank%20of%20Japan%20OR%20Federal%20Reserve&hl=en-US&gl=US&ceid=US:en";

const baseState = await readJson(DATA_PATH).catch(() => createSeedState());
const live = await collectLiveInputs(baseState);
const nextState = buildNextState(baseState, live);

await writeFile(DATA_PATH, `${JSON.stringify(nextState, null, 2)}\n`);

async function collectLiveInputs(baseState) {
  const fx = await loadFxSeries().catch((error) => ({
    provider: "Frankfurter",
    error: error.message,
    series: Array.isArray(baseState.rates) ? baseState.rates : [],
    sourceUrl: `${FRANKFURTER_API}/rates`
  }));

  const imm = await loadImmSeries().catch((error) => ({
    provider: "CFTC legacy COT",
    error: error.message,
    entry: Array.isArray(baseState.imm) ? baseState.imm.at(-1) : null,
    history: Array.isArray(baseState.imm) ? baseState.imm : [],
    sourceUrl: CFTC_LEGACY_URLS[0]
  }));

  const news = await loadNewsItems().catch((error) => ({
    provider: "Google News RSS",
    error: error.message,
    items: Array.isArray(baseState.news?.items) ? baseState.news.items : [],
    score: 0,
    summary: "ニュース取得は失敗したため、前回の要約を使っています。",
    sourceUrl: NEWS_RSS_URL
  }));

  return { fx, imm, news };
}

function buildNextState(baseState, live) {
  const today = jstDate();
  const generatedAtJst = jstDateTime();
  const startingCapitalJpy = Number(baseState.startingCapitalJpy ?? 1_000_000);
  const policy = {
    basePair: "USD/JPY",
    secondaryPair: "JPY/USD",
    instrument: "JPY cash and USD cash conversion only",
    leverage: 1,
    maxAllocationRatio: 0.5,
    valuationCadence: "daily"
  };

  const fxSeries = normalizeFxSeries(live.fx.series, baseState.rates);
  const immHistory = normalizeImmHistory(baseState.imm, live.imm);
  const newsItems = normalizeNewsItems(live.news.items);

  const latestRate = fxSeries.at(-1) ?? { date: today, close: 157.2 };
  const prevRate = fxSeries.at(-2) ?? latestRate;
  const latestImm = immHistory.at(-1) ?? { week: today, netJpyContracts: 0 };
  const prevImm = immHistory.at(-2) ?? latestImm;

  const fxMomentumScore = clamp(
    ((latestRate.close - prevRate.close) / Math.max(prevRate.close, 1)) * 80,
    -1,
    1
  );
  const immScore = clamp(
    ((prevImm.netJpyContracts ?? 0) - (latestImm.netJpyContracts ?? 0)) / 30000,
    -1,
    1
  );
  const newsScore = live.news.score ?? 0;
  const score = clamp(fxMomentumScore * 0.45 + immScore * 0.35 + newsScore * 0.2, -1, 1);

  const directionLabel =
    score > 0.08 ? "円安寄り" : score < -0.08 ? "円高寄り" : "中立";
  const actionLabel =
    score > 0.08 ? "円からドルへ" : score < -0.08 ? "ドルから円へ" : "様子見";
  const action =
    score > 0.08 ? "JPY_TO_USD" : score < -0.08 ? "USD_TO_JPY" : "HOLD";
  const allocationRatio = Number(
    Math.min(policy.maxAllocationRatio, Math.abs(score) * policy.maxAllocationRatio).toFixed(2)
  );
  const moveAmountJpy = Math.round(startingCapitalJpy * allocationRatio);
  const portfolioStart = normalizePortfolio(baseState.portfolio, startingCapitalJpy);
  const trade = executeDecision(portfolioStart, action, moveAmountJpy, latestRate.close);
  const assetSeries = buildAssetSeries(trade.portfolio, fxSeries);
  const hitRate = computeMomentumHitRate(fxSeries);
  const tradeLog = pushTradeLog(baseState.trades, {
    timeJst: `${latestRate.date} 08:00`,
    action: action === "JPY_TO_USD" ? "円からドルへ" : action === "USD_TO_JPY" ? "ドルから円へ" : "様子見",
    ratio: allocationRatio,
    amountJpy: moveAmountJpy,
    usdJpy: latestRate.close,
    totalJpy: assetSeries.at(-1)?.totalJpy ?? startingCapitalJpy
  });

  const forecastSummary =
    directionLabel === "円安寄り"
      ? `円安寄りを基本シナリオにします。直近のUSD/JPYは上向き、IMM円ショートは拡大、ニュースもややドル高寄りです。最大50%の制約内で${pct(allocationRatio)}を${actionLabel}動かす判断です。`
      : directionLabel === "円高寄り"
        ? `円高寄りを基本シナリオにします。直近のUSD/JPYは下向き、IMMの円売りは縮小、ニュースもやや円高寄りです。最大50%の制約内で${pct(allocationRatio)}を${actionLabel}動かす判断です。`
        : `中立を基本シナリオにします。トレンド、IMM、ニュースが拮抗しているため、最大50%の制約内でも動かす量は抑えています。`;

  const reasons = [
    `直近のUSD/JPYは${latestRate.close.toFixed(3)}で、1つ前の観測値からの勢いを${fxMomentumScore.toFixed(2)}として評価しました。`,
    `IMMの円ポジションは${formatSigned(latestImm.netJpyContracts ?? 0)}で、前週比の変化を${immScore.toFixed(2)}として売買比率に反映しました。`,
    live.news.summary,
    `レバレッジなし、最大移動比率50%のルールにより、今回の推奨比率は${pct(allocationRatio)}です。`
  ];

  return {
    ...baseState,
    generatedAtJst,
    startingCapitalJpy,
    policy,
    forecast: {
      direction: action === "JPY_TO_USD" ? "weaker_jpy" : action === "USD_TO_JPY" ? "stronger_jpy" : "neutral",
      directionLabel,
      confidence: Number((0.5 + Math.min(0.35, Math.abs(score) * 0.35)).toFixed(2)),
      summary: forecastSummary,
      score: Number(score.toFixed(3)),
      reasons
    },
    recommendation: {
      action,
      allocationRatio,
      moveAmountJpy,
      cashJpyAfterTrade: Math.round(trade.portfolio.cashJpy),
      usdAfterTrade: round(trade.portfolio.usd, 4)
    },
    performance: {
      hitRate: round(hitRate, 3),
      sampleSize: Math.max(24, fxSeries.length - 1)
    },
    sources: {
      fx: {
        provider: live.fx.provider,
        sourceUrl: live.fx.sourceUrl,
        latestDate: latestRate.date
      },
      imm: {
        provider: live.imm.provider,
        sourceUrl: live.imm.sourceUrl,
        reportDate: latestImm.week
      },
      news: {
        provider: live.news.provider,
        sourceUrl: live.news.sourceUrl,
        items: newsItems.length
      }
    },
    news: {
      provider: live.news.provider,
      summary: live.news.summary,
      score: round(live.news.score, 3),
      items: newsItems
    },
    rates: fxSeries.map((point) => ({
      timeJst: `${point.date} 08:00`,
      close: round(point.close, 3)
    })),
    imm: immHistory.map((point) => ({
      week: point.week,
      netJpyContracts: Math.round(point.netJpyContracts),
      openInterest: point.openInterest ?? null
    })),
    assets: assetSeries,
    trades: tradeLog,
    portfolio: {
      cashJpy: round(trade.portfolio.cashJpy, 2),
      usd: round(trade.portfolio.usd, 6)
    }
  };
}

async function loadFxSeries() {
  const end = jstDate();
  const start = shiftDate(end, -12);
  const url = new URL(`${FRANKFURTER_API}/rates`);
  url.searchParams.set("base", "USD");
  url.searchParams.set("quotes", "JPY");
  url.searchParams.set("from", start);
  url.searchParams.set("to", end);

  const data = await fetchJson(url);
  const series = normalizeFrankfurterResponse(data, "JPY");
  if (!series.length) {
    throw new Error("Frankfurter returned no FX rows");
  }
  return {
    provider: "Frankfurter",
    sourceUrl: url.toString(),
    series
  };
}

async function loadImmSeries() {
  let lastError = null;
  for (const urlString of CFTC_LEGACY_URLS) {
    const url = new URL(urlString);
    try {
      const text = await fetchText(url);
      const table = parseCsv(text);
      const header = table[0].map(normalizeHeader);
      const rows = table.slice(1).map((cells) => rowToObject(header, cells));
      const yenRow = rows.find((row) =>
        String(row.market_and_exchange_names ?? "").toUpperCase().includes("JAPANESE YEN")
      );
      if (!yenRow) {
        throw new Error("Japanese yen row was not found in the CFTC file");
      }

      const longValue = toNumber(
        yenRow.noncommercial_positions_long_all ??
          yenRow.noncommercial_positions_long ??
          yenRow.noncommercial_long_all ??
          yenRow.noncommercial_long
      );
      const shortValue = toNumber(
        yenRow.noncommercial_positions_short_all ??
          yenRow.noncommercial_positions_short ??
          yenRow.noncommercial_short_all ??
          yenRow.noncommercial_short
      );
      const openInterest = toNumber(
        yenRow.open_interest_all ?? yenRow.open_interest ?? yenRow.open_interest_legacy_all
      );
      const reportDateRaw =
        yenRow.report_date_as_yyyy_mm_dd ??
        yenRow.report_date ??
        yenRow.report_date_as_yyyy_mm_dd_;
      const reportDate = reportDateRaw ? String(reportDateRaw) : jstDate();
      const netJpyContracts = longValue - shortValue;

      return {
        provider: "CFTC legacy COT",
        sourceUrl: url.toString(),
        entry: {
          week: reportDate,
          netJpyContracts,
          openInterest
        },
        history: [
          {
            week: reportDate,
            netJpyContracts,
            openInterest
          }
        ]
      };
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError ?? new Error("Failed to load CFTC data");
}

async function loadNewsItems() {
  const url = new URL(NEWS_RSS_URL);
  const xml = await fetchText(url);
  const items = parseRssItems(xml)
    .map((item) => {
      const fullText = `${item.title} ${item.description}`.trim();
      return {
        title: item.title,
        summary: item.description || item.title,
        publishedAt: item.pubDate,
        source: item.source || "RSS",
        url: item.link,
        score: scoreNewsText(fullText)
      };
    })
    .filter((item) => item.title)
    .slice(0, 5);

  const score = items.length
    ? clamp(items.reduce((sum, item) => sum + item.score, 0) / items.length, -1, 1)
    : 0;
  const summary =
    score > 0.15
      ? "ニュースはややドル高・円安寄りです。"
      : score < -0.15
        ? "ニュースはやや円高寄りです。"
        : "ニュースは中立寄りです。";

  return {
    provider: "Google News RSS",
    sourceUrl: url.toString(),
    items,
    score,
    summary
  };
}

function normalizeFxSeries(series, fallback) {
  const rows = [];
  const raw = Array.isArray(series) && series.length ? series : fallback ?? [];

  for (const item of raw) {
    if (!item) continue;
    const date = String(item.date ?? item.timeJst?.slice(0, 10) ?? item.week ?? "").slice(0, 10);
    const close = toNumber(item.close ?? item.rate ?? item.value ?? item.JPY ?? item.jpy);
    if (date && Number.isFinite(close)) {
      rows.push({ date, close });
    }
  }

  rows.sort((a, b) => a.date.localeCompare(b.date));
  return dedupeByDate(rows);
}

function normalizeFrankfurterResponse(data, quote) {
  const rows = [];
  const rateSeries = data?.rates;
  if (!rateSeries) return rows;

  if (Array.isArray(rateSeries)) {
    for (const item of rateSeries) {
      const date = String(item.date ?? item.start_date ?? item.time ?? "").slice(0, 10);
      const value = item[quote] ?? item[quote.toLowerCase()] ?? item.rate ?? item.value;
      if (date && Number.isFinite(toNumber(value))) {
        rows.push({ date, close: toNumber(value) });
      }
    }
  } else if (typeof rateSeries === "object") {
    for (const [date, values] of Object.entries(rateSeries)) {
      const value =
        values?.[quote] ??
        values?.[quote.toLowerCase()] ??
        values?.rate ??
        values?.value ??
        values;
      if (date && Number.isFinite(toNumber(value))) {
        rows.push({ date: date.slice(0, 10), close: toNumber(value) });
      }
    }
  }

  rows.sort((a, b) => a.date.localeCompare(b.date));
  return dedupeByDate(rows);
}

function normalizeImmHistory(fallbackHistory, liveImm) {
  const history = Array.isArray(fallbackHistory) ? [...fallbackHistory] : [];
  const latest = liveImm.entry;
  if (latest) {
    const index = history.findIndex((item) => item.week === latest.week);
    const normalized = {
      week: latest.week,
      netJpyContracts: latest.netJpyContracts,
      openInterest: latest.openInterest ?? null
    };
    if (index >= 0) history[index] = normalized;
    else history.push(normalized);
  }

  history.sort((a, b) => String(a.week).localeCompare(String(b.week)));
  return history.slice(-24);
}

function normalizeNewsItems(items) {
  return Array.isArray(items) ? items.slice(0, 5) : [];
}

function normalizePortfolio(portfolio, startingCapitalJpy) {
  if (portfolio && Number.isFinite(Number(portfolio.cashJpy)) && Number.isFinite(Number(portfolio.usd))) {
    return {
      cashJpy: Number(portfolio.cashJpy),
      usd: Number(portfolio.usd)
    };
  }
  return {
    cashJpy: startingCapitalJpy,
    usd: 0
  };
}

function executeDecision(portfolio, action, amountJpy, rate) {
  const next = {
    cashJpy: Number(portfolio.cashJpy),
    usd: Number(portfolio.usd)
  };

  if (action === "JPY_TO_USD") {
    const jpyToConvert = Math.min(next.cashJpy, amountJpy);
    next.cashJpy -= jpyToConvert;
    next.usd += jpyToConvert / rate;
  } else if (action === "USD_TO_JPY") {
    const usdValueJpy = next.usd * rate;
    const jpyToConvert = Math.min(usdValueJpy, amountJpy);
    const usdToSell = jpyToConvert / rate;
    next.cashJpy += jpyToConvert;
    next.usd -= usdToSell;
  }

  return {
    portfolio: next
  };
}

function buildAssetSeries(portfolio, fxSeries) {
  return fxSeries.map((point) => ({
    timeJst: `${point.date} 08:00`,
    cashJpy: round(portfolio.cashJpy, 2),
    usd: round(portfolio.usd, 6),
    totalJpy: round(portfolio.cashJpy + portfolio.usd * point.close, 0)
  }));
}

function pushTradeLog(existingTrades, trade) {
  const trades = Array.isArray(existingTrades) ? [...existingTrades] : [];
  const last = trades.at(-1);
  if (last && String(last.timeJst ?? "").slice(0, 10) === String(trade.timeJst).slice(0, 10)) {
    trades[trades.length - 1] = trade;
  } else {
    trades.push(trade);
  }
  return trades.slice(-24);
}

function computeMomentumHitRate(series) {
  if (!Array.isArray(series) || series.length < 4) {
    return 0.5;
  }

  let hits = 0;
  let total = 0;
  for (let i = 2; i < series.length; i += 1) {
    const previousDelta = series[i - 1].close - series[i - 2].close;
    const actualDelta = series[i].close - series[i - 1].close;
    const previousSignal = Math.sign(previousDelta);
    const actualSignal = Math.sign(actualDelta);
    if (!previousSignal || !actualSignal) continue;
    if (previousSignal === actualSignal) hits += 1;
    total += 1;
  }

  return total ? hits / total : 0.5;
}

function scoreNewsText(text) {
  const lower = String(text).toLowerCase();
  const positivePatterns = [
    /yen weak/,
    /yen weaker/,
    /yen falls/,
    /dollar rises/,
    /dollar strength/,
    /hawkish/,
    /higher for longer/,
    /rate hike/,
    /us yields rise/,
    /boj holds/,
    /boj delays/
  ];
  const negativePatterns = [
    /yen strong/,
    /yen strengthens/,
    /yen rallies/,
    /dollar falls/,
    /dollar weak/,
    /dovish/,
    /rate cut/,
    /boj hike/,
    /intervention/,
    /usd\/jpy lower/
  ];

  let score = 0;
  for (const pattern of positivePatterns) {
    if (pattern.test(lower)) score += 0.18;
  }
  for (const pattern of negativePatterns) {
    if (pattern.test(lower)) score -= 0.18;
  }
  return clamp(score, -1, 1);
}

function parseRssItems(xml) {
  const items = [];
  for (const match of String(xml).matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const chunk = match[1];
    items.push({
      title: stripHtml(extractTag(chunk, "title")),
      description: stripHtml(extractTag(chunk, "description")),
      link: extractTag(chunk, "link"),
      pubDate: extractTag(chunk, "pubDate"),
      source: stripHtml(extractTag(chunk, "source"))
    });
  }
  return items;
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = "";
  let inQuotes = false;
  const input = String(text).replace(/^\uFEFF/, "");

  for (let i = 0; i < input.length; i += 1) {
    const char = input[i];
    const next = input[i + 1];

    if (inQuotes) {
      if (char === '"' && next === '"') {
        cell += '"';
        i += 1;
      } else if (char === '"') {
        inQuotes = false;
      } else {
        cell += char;
      }
      continue;
    }

    if (char === '"') {
      inQuotes = true;
    } else if (char === ",") {
      row.push(cell);
      cell = "";
    } else if (char === "\n") {
      row.push(cell);
      if (row.some((value) => String(value).trim() !== "")) {
        rows.push(row);
      }
      row = [];
      cell = "";
    } else if (char !== "\r") {
      cell += char;
    }
  }

  row.push(cell);
  if (row.some((value) => String(value).trim() !== "")) {
    rows.push(row);
  }

  return rows;
}

function rowToObject(header, cells) {
  return header.reduce((acc, key, index) => {
    acc[key] = cells[index];
    return acc;
  }, {});
}

function normalizeHeader(value) {
  return String(value)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function extractTag(xml, tagName) {
  const pattern = new RegExp(`<${tagName}[^>]*>([\\s\\S]*?)<\\/${tagName}>`, "i");
  const match = String(xml).match(pattern);
  if (!match) return "";
  return decodeXml(match[1].replace(/^<!\[CDATA\[/, "").replace(/\]\]>$/, ""));
}

function stripHtml(text) {
  return decodeXml(String(text).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim());
}

function decodeXml(text) {
  return String(text)
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function toNumber(value) {
  if (typeof value === "number") return value;
  if (typeof value !== "string") return Number(value);
  const parsed = Number(value.replace(/,/g, "").trim());
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

function formatSigned(value) {
  const number = Number(value);
  return `${number >= 0 ? "+" : ""}${Math.round(number).toLocaleString("en-US")}`;
}

function dedupeByDate(rows) {
  const map = new Map();
  for (const row of rows) {
    map.set(row.date, row);
  }
  return [...map.values()].sort((a, b) => a.date.localeCompare(b.date));
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function round(value, digits = 2) {
  const factor = 10 ** digits;
  return Math.round(Number(value) * factor) / factor;
}

function pct(value) {
  return `${Math.round(Number(value) * 100)}%`;
}

function jstDate(date = new Date()) {
  return new Intl.DateTimeFormat("sv-SE", {
    timeZone: JST,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(date);
}

function jstDateTime(date = new Date()) {
  return new Intl.DateTimeFormat("sv-SE", {
    timeZone: JST,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  })
    .format(date)
    .replace("T", " ");
}

function shiftDate(dateString, offsetDays) {
  const date = new Date(`${dateString}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + offsetDays);
  return date.toISOString().slice(0, 10);
}

async function readJson(url) {
  const raw = await readFile(url, "utf8");
  return JSON.parse(raw);
}

async function fetchJson(url) {
  const response = await fetchWithTimeout(url);
  const text = await response.text();
  return JSON.parse(text);
}

async function fetchText(url) {
  const response = await fetchWithTimeout(url);
  return response.text();
}

async function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 15000);
  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
      headers: {
        "user-agent": "Mozilla/5.0",
        ...(options.headers ?? {})
      }
    });
    if (!response.ok) {
      throw new Error(`Request failed: ${response.status} ${response.statusText}`);
    }
    return response;
  } finally {
    clearTimeout(timeout);
  }
}

function createSeedState() {
  return {
    generatedAtJst: "2026-06-28 08:00",
    startingCapitalJpy: 1_000_000,
    policy: {
      basePair: "USD/JPY",
      secondaryPair: "JPY/USD",
      instrument: "JPY cash and USD cash conversion only",
      leverage: 1,
      maxAllocationRatio: 0.5,
      valuationCadence: "daily"
    },
    forecast: {
      direction: "neutral",
      directionLabel: "中立",
      confidence: 0.5,
      summary: "初期サンプルです。",
      score: 0,
      reasons: []
    },
    recommendation: {
      action: "HOLD",
      allocationRatio: 0,
      moveAmountJpy: 0,
      cashJpyAfterTrade: 1_000_000,
      usdAfterTrade: 0
    },
    performance: {
      hitRate: 0.5,
      sampleSize: 0
    },
    rates: [],
    imm: [],
    assets: [],
    trades: [],
    portfolio: {
      cashJpy: 1_000_000,
      usd: 0
    }
  };
}
