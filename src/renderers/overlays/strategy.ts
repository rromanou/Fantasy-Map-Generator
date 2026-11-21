// Strategy mode view: territories colored by owner, borders, selection and army boxes. Removes itself on exit
import type { Point } from "@/types/global";
import { findEl } from "@/utils/node-utils";
import { rn } from "@/utils/number-utils";
import { getIsolines } from "@/utils/path-utils";

const GROUP_ID = "strategyView";

export interface StrategyView {
  cellTerritory: ArrayLike<number>; // territory of each cell, -1 for none
  owner: number[];
  troops: number[];
  anchors: Point[];
  colors: Record<number, string>;
  selected: number;
  targets: Map<number, "own" | "enemy" | "peace">;
}

const TARGET_COLORS = { own: "#2e9d4f", enemy: "#d62828", peace: "#e0a100" };

export function drawStrategy(view: StrategyView): void {
  const { cellTerritory, owner, troops, anchors, colors, selected, targets } = view;
  const owners = getIsolines(pack, cell => (cellTerritory[cell] >= 0 ? owner[cellTerritory[cell]] : 0), { fill: true });
  const borders = getIsolines(pack, cell => cellTerritory[cell] + 1, { fill: true });

  const fills = Object.entries(owners)
    .map(([id, { fill }]) => (fill ? `<path d="${fill}" fill="${colors[+id] ?? "#999"}" fill-opacity=".55" />` : ""))
    .join("");
  const lines = Object.entries(borders)
    .map(([id, { fill }]) => {
      if (!fill) return "";
      const territory = +id - 1;
      const target = targets.get(territory);
      if (territory === selected)
        return `<path d="${fill}" fill="#fff" fill-opacity=".25" stroke="#fff" stroke-width="2.5" />`;
      if (target)
        return `<path d="${fill}" fill="${TARGET_COLORS[target]}" fill-opacity=".3" stroke="${TARGET_COLORS[target]}" stroke-width="2" />`;
      return `<path d="${fill}" fill="none" stroke="#000" stroke-opacity=".35" stroke-width=".6" />`;
    })
    .join("");

  const size = Math.max(styles.military.options.boxSize, options.map.graph.width / 160);
  const armies = troops
    .map((count, id) => {
      if (count <= 0) return "";
      const [x, y] = anchors[id];
      const width = size * (String(count).length + 1.6);
      return `<g><rect x="${rn(x - width / 2, 1)}" y="${rn(y - size, 1)}" width="${rn(width, 1)}" height="${size * 2}" rx="${size / 2}" fill="${colors[owner[id]] ?? "#999"}" stroke="#000" stroke-width=".6" />
        <text x="${x}" y="${rn(y + size * 0.45, 1)}" text-anchor="middle" font-size="${size * 1.4}" font-weight="bold" fill="#fff" stroke="#000" stroke-width=".3">${count}</text></g>`;
    })
    .join("");

  const markup = `<g id="${GROUP_ID}" data-selected="${selected}"><g pointer-events="none">${fills}${lines}${armies}</g></g>`;
  const group = findEl(GROUP_ID);
  if (group) group.outerHTML = markup;
  else findEl("debug")?.insertAdjacentHTML("beforeend", markup);
}

export function removeStrategy(): void {
  findEl(GROUP_ID)?.remove();
}
