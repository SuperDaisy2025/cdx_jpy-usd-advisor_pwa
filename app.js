const yen = new Intl.NumberFormat("ja-JP", {
  style: "currency",
  currency: "JPY",
  maximumFractionDigits: 0
});

const pct = new Intl.NumberFormat("ja-JP", {
  style: "percent",
  maximumFractionDigits: 1
});

const state = await fetch("data/advisor-state.json").then((res) => res.json());

const latestAsset = state.assets.at(-1);
const latestRate = state.rates.at(-1);
const pnl = latestAsset.totalJpy - state.startingCapitalJpy;

document.querySelector("#updateStatus").textContent = `${state.generatedAtJst} 更新`;
document.querySelector("#forecastDirection").textContent = state.forecast.directionLabel;
document.querySelector("#forecastSummary").textContent = state.forecast.summary;
document.querySelector("#allocationRatio").textContent = pct.format(state.recommendation.allocationRatio);
document.querySelector("#allocationAmount").textContent = yen.format(state.recommendation.moveAmountJpy);
document.querySelector("#confidence").textContent = pct.format(state.forecast.confidence);
document.querySelector("#totalAsset").textContent = yen.format(latestAsset.totalJpy);
document.querySelector("#pnl").textContent = `${pnl >= 0 ? "+" : ""}${yen.format(pnl)}`;
document.querySelector("#pnl").className = pnl >= 0 ? "positive" : "negative";
document.querySelector("#spotRate").textContent = latestRate.close.toFixed(3);
document.querySelector("#hitRate").textContent = pct.format(state.performance.hitRate);

const reasonList = document.querySelector("#reasonList");
state.forecast.reasons.forEach((reason) => {
  const li = document.createElement("li");
  li.textContent = reason;
  reasonList.append(li);
});

const tradeRows = document.querySelector("#tradeRows");
state.trades.forEach((trade) => {
  const row = document.createElement("tr");
  row.innerHTML = `
    <td>${trade.timeJst}</td>
    <td>${trade.action}</td>
    <td>${pct.format(trade.ratio)}</td>
    <td>${yen.format(trade.amountJpy)}</td>
    <td>${trade.usdJpy.toFixed(3)}</td>
    <td>${yen.format(trade.totalJpy)}</td>
  `;
  tradeRows.append(row);
});

drawLineChart({
  canvas: document.querySelector("#assetChart"),
  values: state.assets.map((point) => point.totalJpy),
  labels: state.assets.map((point) => point.timeJst.slice(11, 16)),
  color: "#1f7a5c",
  fill: "rgba(31, 122, 92, 0.10)",
  formatValue: (value) => `${Math.round(value / 1000)}千円`
});

drawLineChart({
  canvas: document.querySelector("#fxChart"),
  values: state.rates.map((point) => point.close),
  labels: state.rates.map((point) => point.timeJst.slice(11, 16)),
  color: "#1f5f9f",
  fill: "rgba(31, 95, 159, 0.10)",
  formatValue: (value) => value.toFixed(2)
});

drawLineChart({
  canvas: document.querySelector("#immChart"),
  values: state.imm.map((point) => point.netJpyContracts),
  labels: state.imm.map((point) => point.week),
  color: "#9a6a1e",
  fill: "rgba(154, 106, 30, 0.10)",
  formatValue: (value) => `${Math.round(value / 1000)}k`
});

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("sw.js");
}

function drawLineChart({ canvas, values, labels, color, fill, formatValue }) {
  const ctx = canvas.getContext("2d");
  const ratio = window.devicePixelRatio || 1;
  const cssWidth = canvas.clientWidth || canvas.width;
  const cssHeight = Math.max(220, Math.round(cssWidth * 0.38));
  canvas.width = Math.round(cssWidth * ratio);
  canvas.height = Math.round(cssHeight * ratio);
  ctx.scale(ratio, ratio);

  const width = cssWidth;
  const height = cssHeight;
  const pad = { top: 24, right: 18, bottom: 34, left: 58 };
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const yMin = min - span * 0.12;
  const yMax = max + span * 0.12;
  const plotW = width - pad.left - pad.right;
  const plotH = height - pad.top - pad.bottom;

  ctx.clearRect(0, 0, width, height);
  ctx.font = "12px system-ui, sans-serif";
  ctx.lineWidth = 1;
  ctx.strokeStyle = "#d9e0e8";
  ctx.fillStyle = "#5e6b7d";

  for (let i = 0; i <= 4; i++) {
    const y = pad.top + (plotH / 4) * i;
    const value = yMax - ((yMax - yMin) / 4) * i;
    ctx.beginPath();
    ctx.moveTo(pad.left, y);
    ctx.lineTo(width - pad.right, y);
    ctx.stroke();
    ctx.fillText(formatValue(value), 8, y + 4);
  }

  const points = values.map((value, index) => {
    const x = pad.left + (plotW * index) / Math.max(1, values.length - 1);
    const y = pad.top + ((yMax - value) / (yMax - yMin)) * plotH;
    return { x, y };
  });

  ctx.beginPath();
  points.forEach((point, index) => {
    if (index === 0) ctx.moveTo(point.x, point.y);
    else ctx.lineTo(point.x, point.y);
  });
  ctx.lineTo(points.at(-1).x, height - pad.bottom);
  ctx.lineTo(points[0].x, height - pad.bottom);
  ctx.closePath();
  ctx.fillStyle = fill;
  ctx.fill();

  ctx.beginPath();
  points.forEach((point, index) => {
    if (index === 0) ctx.moveTo(point.x, point.y);
    else ctx.lineTo(point.x, point.y);
  });
  ctx.strokeStyle = color;
  ctx.lineWidth = 3;
  ctx.stroke();

  ctx.fillStyle = color;
  points.forEach((point) => {
    ctx.beginPath();
    ctx.arc(point.x, point.y, 3, 0, Math.PI * 2);
    ctx.fill();
  });

  ctx.fillStyle = "#5e6b7d";
  const first = labels[0];
  const last = labels.at(-1);
  ctx.fillText(first, pad.left, height - 10);
  ctx.textAlign = "right";
  ctx.fillText(last, width - pad.right, height - 10);
  ctx.textAlign = "left";
}
