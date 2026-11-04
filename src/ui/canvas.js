// Canvas rendering. Pure state lives in core.js; this module only turns state
// into DOM and reports taps back to app.js.
import { MAX_TEXT_BLOCKS, numberLineTicks } from "./core.js";
import { t } from "./locale.js";

function formatNumber(value) {
  return Number.isInteger(value) ? String(value) : String(Math.round(value * 10) / 10);
}

function integerLabel(value) {
  return Number.isInteger(value) ? String(value) : "";
}

/**
 * Create the canvas view. All widget sections are replaced wholesale on every
 * render, which is exactly PROTOCOL §2's "replace, not stack" behavior; text
 * blocks are appended to a rolling list.
 */
export function createCanvasView({
  tenframeWidget,
  tenframeGrid,
  tenframeCaption,
  numberlineWidget,
  numberline,
  choicesWidget,
  choicesGrid,
  textsEl,
  emptyEl,
  onTenFrameTap,
  onChoiceTap,
}) {
  function renderTenFrame(tenframe) {
    tenframeWidget.hidden = tenframe === null;
    tenframeGrid.textContent = "";
    if (tenframe === null) {
      tenframeCaption.textContent = "";
      return;
    }

    const filledCount = tenframe.cells.filter(Boolean).length;
    tenframeCaption.textContent = t("canvas.filled", { filled: filledCount });

    tenframe.cells.forEach((filled, index) => {
      const cell = document.createElement("button");
      cell.type = "button";
      cell.className = filled ? "tenframe-cell filled" : "tenframe-cell";
      cell.setAttribute(
        "aria-label",
        filled
          ? t("canvas.cellFilled", { index: index + 1 })
          : t("canvas.cell", { index: index + 1 }),
      );
      cell.addEventListener("click", () => onTenFrameTap(index));
      tenframeGrid.appendChild(cell);
    });
  }

  function renderNumberLine(numberlineState) {
    numberlineWidget.hidden = numberlineState === null;
    numberline.textContent = "";
    if (numberlineState === null) {
      return;
    }

    const { min, max, marker } = numberlineState;
    numberline.setAttribute(
      "aria-label",
      marker === null
        ? t("canvas.numberlineRange", {
            min: formatNumber(min),
            max: formatNumber(max),
          })
        : t("canvas.numberlineMarker", {
            min: formatNumber(min),
            max: formatNumber(max),
            marker: formatNumber(marker),
          }),
    );

    const axis = document.createElement("div");
    axis.className = "numberline-axis";
    numberline.appendChild(axis);

    const ticks = numberLineTicks(min, max).map((value) => ({
      value,
      position: ((value - min) / (max - min)) * 100,
    }));
    for (const tick of ticks) {
      const tickEl = document.createElement("span");
      tickEl.className = "numberline-tick";
      tickEl.style.left = `${tick.position}%`;
      tickEl.textContent = integerLabel(tick.value);
      numberline.appendChild(tickEl);
    }

    if (marker !== null) {
      const ratio = (marker - min) / (max - min);
      const position = Math.min(100, Math.max(0, ratio * 100));
      const markerEl = document.createElement("span");
      markerEl.className = "numberline-marker";
      markerEl.style.left = `${position}%`;
      markerEl.textContent = integerLabel(marker);
      numberline.appendChild(markerEl);
    }
  }

  function renderChoices(choices) {
    choicesWidget.hidden = choices === null;
    choicesGrid.textContent = "";
    if (choices === null) {
      return;
    }

    for (const card of choices.cards) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = choices.selectedId === card.id ? "choice-card selected" : "choice-card";
      button.textContent = card.label;
      button.addEventListener("click", () => onChoiceTap(card));
      choicesGrid.appendChild(button);
    }
  }

  function renderTexts(texts) {
    textsEl.textContent = "";
    const visible = texts.slice(-MAX_TEXT_BLOCKS);
    for (const entry of visible) {
      const block = document.createElement("p");
      block.className = "text-block";
      block.textContent = entry.text;
      textsEl.appendChild(block);
    }
    if (visible.length > 0) {
      textsEl.scrollTop = textsEl.scrollHeight;
    }
  }

  function render(state) {
    renderTenFrame(state.tenframe);
    renderNumberLine(state.numberline);
    renderChoices(state.choices);
    renderTexts(state.texts);
    emptyEl.hidden =
      state.tenframe !== null ||
      state.numberline !== null ||
      state.choices !== null ||
      state.texts.length > 0;
  }

  return { render };
}
