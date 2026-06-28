import { readFile, writeFile } from "node:fs/promises";

const DATA_PATH = new URL("../data/advisor-state.json", import.meta.url);
const state = JSON.parse(await readFile(DATA_PATH, "utf8"));

const nowJst = new Intl.DateTimeFormat("sv-SE", {
  timeZone: "Asia/Tokyo",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false
}).format(new Date());

const latestRate = state.rates.at(-1)?.close ?? 157.2;
const prevRate = state.rates.at(-2)?.close ?? latestRate;
const latestImm = state.imm.at(-1)?.netJpyContracts ?? 0;
const prevImm = state.imm.at(-2)?.netJpyContracts ?? latestImm;

const momentumScore = clamp((latestRate - prevRate) / 0.5, -1, 1);
const immScore = clamp((prevImm - latestImm) / 30000, -1, 1);
const newsScore = 0;
const score = clamp(momentumScore * 0.45 + immScore * 0.35 + newsScore * 0.2, -1, 1);

const rawRatio = Math.abs(score) * state.policy.maxAllocationRatio;
const allocationRatio = Number(Math.min(state.policy.maxAllocationRatio, rawRatio).toFixed(2));
const moveAmountJpy = Math.round(state.startingCapitalJpy * allocationRatio);
const directionLabel = score > 0.08 ? "円安寄り" : score < -0.08 ? "円高寄り" : "中立";
const actionLabel = score > 0.08 ? "円からドルへ" : score < -0.08 ? "ドルから円へ" : "様子見";

state.generatedAtJst = nowJst.replace("T", " ");
state.forecast.score = Number(score.toFixed(3));
state.forecast.direction = score > 0.08 ? "weaker_jpy" : score < -0.08 ? "stronger_jpy" : "neutral";
state.forecast.directionLabel = directionLabel;
state.forecast.confidence = Number((0.5 + Math.min(0.35, Math.abs(score) * 0.35)).toFixed(2));
state.forecast.summary = `${directionLabel}を基本シナリオにします。短期モメンタム、IMM円ポジション、ニュース要因を合成したスコアは${state.forecast.score}で、最大50%の制約内で${pct(allocationRatio)}を${actionLabel}動かす判断です。`;
state.forecast.reasons = [
  `直近レート変化のスコアは${momentumScore.toFixed(2)}で、短期モメンタムを45%の重みで反映しました。`,
  `IMM円ポジション変化のスコアは${immScore.toFixed(2)}で、投機筋の円買い/円売り傾向を35%の重みで反映しました。`,
  "ニュース要因は初期版では0点の中立入力です。API接続後は米金利、日銀、地政学、重要指標の見出しを要約して20%の重みで反映します。",
  `レバレッジなし、最大移動比率50%のルールにより、今回の推奨比率は${pct(allocationRatio)}に制限されています。`
];
state.recommendation.action = score > 0.08 ? "JPY_TO_USD" : score < -0.08 ? "USD_TO_JPY" : "HOLD";
state.recommendation.allocationRatio = allocationRatio;
state.recommendation.moveAmountJpy = moveAmountJpy;

await writeFile(DATA_PATH, `${JSON.stringify(state, null, 2)}\n`);

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function pct(value) {
  return `${Math.round(value * 100)}%`;
}
