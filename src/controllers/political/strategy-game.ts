// Strategy game mode: play one or several states against bot states on the current map. Nothing is written to the map
import { select } from "d3";
import { Pack } from "@/model/graph/pack-generator";
import { Military } from "@/model/political/military-generator";
import {
  type Battle,
  RECRUIT_BATCH,
  RECRUIT_COST,
  StrategyGame,
  type Territory
} from "@/model/political/strategy-game";
import { drawStrategy, removeStrategy } from "@/renderers/overlays/strategy";
import type { Point } from "@/types/global";
import { Dialog } from "@/ui/dialog/dialog";
import { applyDefaultViewboxEvents } from "@/ui/map/viewbox-events";
import { clearMainTip, tip } from "@/ui/tooltips";
import { t } from "@/utils/i18n";
import { ensureEl, getPointer } from "@/utils/node-utils";
import { rn } from "@/utils/number-utils";
import { generateSeed } from "@/utils/probability-utils";
import { escapeHtml } from "@/utils/string-utils";

const SETUP_ID = "strategySetup";
const HUD_ID = "strategyHud";
const NEUTRAL_COLOR = "#999999";

interface World {
  game: StrategyGame;
  cellTerritory: Int32Array;
  anchors: Point[];
  colors: Record<number, string>;
}

let world: World | null = null;
let selected = -1;
let share = 1;

const STYLE = /* html */ `<style>
  .strategyDialog > div { width: auto }
  .strategyDialog h4 { margin: 0.5em 0 0.3em; border-bottom: 1px solid var(--dark-solid) }
  .strategyDialog .row { display: flex; align-items: center; gap: 0.5em; line-height: 1.7 }
  .strategyDialog .row > .grow { flex: 1 }
  .strategyDialog .swatch { width: 0.9em; height: 0.9em; border: 1px solid #000; display: inline-block }
  .strategyDialog .list { max-height: 20em; overflow-y: auto; margin-top: 0.4em }
  .strategyDialog .log { max-height: 8em; overflow-y: auto; font-size: 0.9em; color: #444 }
  .strategyDialog .muted { color: #666 }
</style>`;

function open(): void {
  if (options.app.mode) return void tip(t("Exit customization mode first"), false, "error");
  if (world) return void Dialog.open(HUD_ID);
  const states = pack.states.filter(state => state.i && !state.removed && state.cells);
  if (states.length < 3) return void tip(t("The map needs at least three states to play"), false, "error");

  Dialog.destroy(SETUP_ID);
  const rows = states
    .map(
      state => /* html */ `<label class="row"><input type="checkbox" data-id="${state.i}">
        <span class="swatch" style="background: ${state.color}"></span>
        <span class="grow">${escapeHtml(state.fullName || state.name)}</span>
        <span class="muted">${state.cells} ${t("cells")}</span></label>`
    )
    .join("");
  ensureEl("dialogs").insertAdjacentHTML(
    "beforeend",
    /* html */ `<div id="${SETUP_ID}" class="dialog stable strategyDialog">${STYLE}
      <div class="row">
        <label><input type="radio" name="strategyMode" value="solo" checked> ${t("Solo against bots")}</label>
        <label><input type="radio" name="strategyMode" value="hotseat"> ${t("Several players, one after another")}</label>
      </div>
      <p class="muted">${t("Pick the states you play. All other states are played by bots")}</p>
      <div class="list">${rows}</div></div>`
  );
  const setup = ensureEl(SETUP_ID);
  setup.addEventListener("change", event => {
    const input = event.target as HTMLInputElement;
    if (input.type !== "checkbox" || !input.checked || mode() !== "solo") return;
    for (const other of setup.querySelectorAll<HTMLInputElement>("input[type=checkbox]"))
      other.checked = other === input;
  });
  setup.addEventListener("change", event => {
    if ((event.target as HTMLInputElement).name !== "strategyMode" || mode() !== "solo") return;
    const checked = [...setup.querySelectorAll<HTMLInputElement>("input[type=checkbox]:checked")];
    for (const input of checked.slice(1)) input.checked = false;
  });

  Dialog.open(SETUP_ID, {
    title: t("Strategy game"),
    width: "28em",
    position: { my: "center", at: "center", of: "svg" },
    onClose: () => Dialog.destroy(SETUP_ID),
    buttons: [
      { label: t("Start"), onClick: start },
      { label: t("Cancel"), onClick: () => Dialog.destroy(SETUP_ID) }
    ]
  });
}

const mode = () => ensureEl(SETUP_ID).querySelector<HTMLInputElement>("input[name=strategyMode]:checked")?.value;

function start(): void {
  const chosen = [...ensureEl(SETUP_ID).querySelectorAll<HTMLInputElement>("input[type=checkbox]:checked")].map(
    input => +input.dataset.id!
  );
  if (!chosen.length) return void tip(t("Pick at least one state to play"), false, "error");
  if (mode() === "hotseat" && chosen.length < 2)
    return void tip(t("Pick at least two states for several players"), false, "error");
  Dialog.destroy(SETUP_ID);

  const built = buildWorld(chosen);
  if (!built) return void tip(t("The map has no territories to play on"), false, "error");
  world = built;
  selected = -1;
  share = 1;
  options.app.mode = "strategy";
  built.game.startTurn();
  select<SVGElement, unknown>("#viewbox").style("cursor", "pointer").on("click", onMapClick);
  openHud();
  redraw();
  announceTurn();
}

/** Territories are provinces, plus one extra for the cells of a state outside any province */
function buildWorld(humans: number[]): World | null {
  const { cells, states, provinces, burgs } = pack;
  const index = new Map<string, number>();
  const cellTerritory = new Int32Array(cells.i.length).fill(-1);
  const members: number[][] = [];
  const owners: number[] = [];

  for (const cell of cells.i) {
    const state = cells.state[cell];
    if (cells.h[cell] < 20 || !state || states[state]?.removed) continue;
    const province = cells.province[cell];
    const key = province && !provinces[province]?.removed ? `p${province}` : `s${state}`;
    let id = index.get(key);
    if (id === undefined) {
      id = members.length;
      index.set(key, id);
      members.push([]);
      owners.push(state);
    }
    cellTerritory[cell] = id;
    members[id].push(cell);
  }
  if (members.length < 2) return null;

  const anchors: Point[] = [];
  const features: number[] = [];
  const territories: Territory[] = members.map((list, id) => {
    let pop = 0;
    let height = 0;
    let walls = false;
    let capital = false;
    let cx = 0;
    let cy = 0;
    for (const cell of list) {
      pop += cells.pop[cell];
      height += cells.h[cell];
      cx += cells.p[cell][0];
      cy += cells.p[cell][1];
      const burg = burgs[cells.burg[cell]];
      if (burg && !burg.removed) {
        walls ||= Boolean(burg.walls);
        capital ||= Boolean(burg.capital);
      }
    }
    cx /= list.length;
    cy /= list.length;
    const near = list.reduce((best, cell) => {
      const [x, y] = cells.p[cell];
      const [bx, by] = cells.p[best];
      return (x - cx) ** 2 + (y - cy) ** 2 < (bx - cx) ** 2 + (by - cy) ** 2 ? cell : best;
    }, list[0]);
    anchors.push([rn(cells.p[near][0], 1), rn(cells.p[near][1], 1)]);
    features.push(cells.f[near]);
    const lift = Math.max(0, Math.min(1, (height / list.length - 20) / 60));
    const defense = Math.min(0.8, 0.1 + lift * 0.3 + (walls ? 0.15 : 0) + (capital ? 0.25 : 0));
    return { id, owner: owners[id], pop, defense, capital, links: [] };
  });

  const linked = territories.map(() => new Map<number, boolean>());
  for (const cell of cells.i) {
    const a = cellTerritory[cell];
    if (a < 0) continue;
    for (const next of cells.c[cell]) {
      const b = cellTerritory[next];
      if (b >= 0 && b !== a) linked[a].set(b, false);
    }
  }
  linkIslands(territories, anchors, features, linked);
  territories.forEach((territory, id) => {
    territory.links = [...linked[id]].map(([to, sea]) => ({ to, sea }));
  });

  const powers = states.map(state => (state.i ? Military.getPower(state.i) : 0));
  const present = new Set(owners);
  const meanPower = [...present].reduce((sum, id) => sum + powers[id], 0) / present.size || 0;
  const meanExpansion = [...present].reduce((sum, id) => sum + (states[id].expansionism || 1), 0) / present.size || 1;
  const realms = [...present].map(id => {
    const state = states[id];
    const aggression = Math.max(0.3, Math.min(1.3, 0.3 + (0.35 * (state.expansionism || 1)) / meanExpansion));
    const might = meanPower ? Math.max(0.5, Math.min(2, Math.sqrt(powers[id] / meanPower))) : 1;
    return { id, name: state.fullName || state.name, human: humans.includes(id), aggression, might };
  });
  const relations: Record<number, Record<number, string>> = {};
  for (const id of present) {
    relations[id] = {};
    for (const other of present) if (other !== id) relations[id][other] = states[id].diplomacy?.[other] ?? "Neutral";
  }

  const colors: Record<number, string> = {};
  for (const id of present) colors[id] = states[id].color?.startsWith("#") ? states[id].color! : NEUTRAL_COLOR;
  const seed = `${options.map.seed}-${generateSeed()}`;
  const game = new StrategyGame({
    territories,
    realms,
    relations,
    humans: humans.filter(id => present.has(id)),
    seed
  });
  return { game, cellTerritory, anchors, colors };
}

/** Separate landmasses connect by sea to their nearest neighbors, so no island is cut off */
function linkIslands(
  territories: Territory[],
  anchors: Point[],
  features: number[],
  linked: Map<number, boolean>[]
): void {
  const { width, height } = options.map.graph;
  const reach = Math.max(width, height) * 0.15;
  const distance = (a: number, b: number) => Math.hypot(anchors[a][0] - anchors[b][0], anchors[a][1] - anchors[b][1]);
  for (const { id } of territories) {
    const others = territories
      .filter(other => other.id !== id && features[other.id] !== features[id] && !linked[id].has(other.id))
      .map(other => ({ id: other.id, d: distance(id, other.id) }))
      .sort((a, b) => a.d - b.d);
    const near = others.filter(other => other.d < reach).slice(0, 2);
    for (const other of near.length || linked[id].size ? near : others.slice(0, 1)) {
      linked[id].set(other.id, true);
      linked[other.id].set(id, true);
    }
  }
}

function targetsOf(game: StrategyGame): Map<number, "own" | "enemy" | "peace"> {
  const targets = new Map<number, "own" | "enemy" | "peace">();
  if (selected < 0 || game.territories[selected].owner !== game.player) return targets;
  for (const { to } of game.territories[selected].links) {
    const owner = game.territories[to].owner;
    targets.set(to, owner === game.player ? "own" : game.atWar(game.player, owner) ? "enemy" : "peace");
  }
  return targets;
}

function redraw(): void {
  if (!world) return;
  const { game, cellTerritory, anchors, colors } = world;
  drawStrategy({
    cellTerritory,
    owner: game.territories.map(territory => territory.owner),
    troops: game.troops,
    anchors,
    colors,
    selected,
    targets: targetsOf(game)
  });
  renderHud();
}

function onMapClick(this: SVGElement, event: MouseEvent): void {
  if (!world || world.game.over) return;
  const [x, y] = getPointer(event, this);
  const cell = Pack.findCell(x, y);
  const id = cell === undefined ? -1 : world.cellTerritory[cell];
  if (id < 0) return;

  const { game } = world;
  const player = game.player;
  const owner = game.territories[id].owner;
  if (selected < 0 || (owner === player && game.checkMove(selected, id, player) !== "")) {
    if (owner !== player) return void tip(t("Select one of your territories first"), false, "error");
    selected = id;
    return void redraw();
  }

  const reason = game.checkMove(selected, id, player);
  if (reason === "no war") {
    const name = escapeHtml(game.realms.get(owner)?.name ?? "");
    return void Dialog.confirm({
      title: t("Declare war"),
      message: t("Declare war on {{name}} and attack?", { name }),
      confirm: t("Declare war"),
      onConfirm: () => {
        game.declareWar(player, owner);
        sendTroops(selected, id);
      }
    });
  }
  if (reason) return void tip(reasonText(reason), false, "error");
  sendTroops(selected, id);
}

function reasonText(reason: string): string {
  if (reason === "not adjacent") return t("Only neighboring territories can be reached");
  if (reason === "no troops left to move") return t("These troops have already acted this turn");
  return t("You can't do that");
}

function sendTroops(from: number, to: number): void {
  if (!world) return;
  const { game } = world;
  const count = Math.max(1, Math.ceil(game.movable(from) * share));
  const battle = game.move(from, to, count);
  if (battle) tip(battleText(battle), false, battle.won ? "success" : "warn", 6000);
  selected = battle?.won || !game.movable(from) ? to : from;
  if (game.territories[selected].owner !== game.player) selected = -1;
  redraw();
  checkEnd();
}

function battleText(battle: Battle): string {
  const losses = { lost: battle.attackerLoss, enemy: battle.defenderLoss };
  return battle.won
    ? t("Territory taken: lost {{lost}}, enemy lost {{enemy}}", losses)
    : t("Attack repelled: lost {{lost}}, enemy lost {{enemy}}", losses);
}

function endTurn(): void {
  if (!world) return;
  world.game.endTurn();
  selected = -1;
  redraw();
  if (!checkEnd()) announceTurn();
}

function announceTurn(): void {
  if (!world || world.game.over) return;
  const { game } = world;
  const name = game.realms.get(game.player)?.name ?? "";
  tip(t("{{name}}, it is your turn", { name: escapeHtml(name) }), true);
  if (game.humans.length > 1)
    Dialog.message({ title: t("Next player"), message: t("{{name}}, it is your turn", { name: escapeHtml(name) }) });
}

function checkEnd(): boolean {
  if (!world?.game.over) return false;
  const { game } = world;
  const winner = game.realms.get(game.winner);
  Dialog.message({
    title: t("Game over"),
    message: winner ? t("{{name}} wins", { name: escapeHtml(winner.name) }) : t("All players have been defeated")
  });
  return true;
}

function openHud(): void {
  Dialog.destroy(HUD_ID);
  ensureEl("dialogs").insertAdjacentHTML(
    "beforeend",
    `<div id="${HUD_ID}" class="dialog stable strategyDialog"></div>`
  );
  const hud = ensureEl(HUD_ID);
  hud.addEventListener("click", onHudClick);
  hud.addEventListener("change", event => {
    const input = event.target as HTMLSelectElement;
    if (input.id === "strategyShare") share = +input.value;
  });
  Dialog.open(HUD_ID, {
    title: t("Strategy game"),
    width: "22em",
    position: { my: "right top", at: "right-10 top+10", of: "svg" },
    onClose: exit
  });
}

function onHudClick(event: MouseEvent): void {
  const button = (event.target as HTMLElement).closest<HTMLElement>("[data-action]");
  if (!button || !world) return;
  const { game } = world;
  const id = +(button.dataset.id ?? 0);
  const player = game.player;
  switch (button.dataset.action) {
    case "end":
      return void endTurn();
    case "quit":
      return void Dialog.confirm({ title: t("Quit the game"), message: t("The game will be lost"), onConfirm: exit });
    case "recruit":
      if (!game.recruit(selected)) tip(t("Not enough gold"), false, "error");
      return void redraw();
    case "war":
      game.declareWar(player, id);
      return void redraw();
    case "peace":
      tip(game.proposePeace(player, id) ? t("Peace made") : t("Peace proposal sent"), false, "info", 4000);
      return void redraw();
    case "accept":
      game.acceptPeace(id, player);
      return void redraw();
  }
}

function renderHud(): void {
  if (!world) return;
  const { game, colors } = world;
  const hud = ensureEl(HUD_ID);
  const player = game.player;
  const realm = game.realms.get(player);
  if (!realm) {
    hud.innerHTML = `${STYLE}<p>${t("Game over")}</p><div class="row"><button data-action="quit" class="grow">${t("Quit")}</button></div>`;
    return;
  }
  const name = (id: number) => escapeHtml(game.realms.get(id)?.name ?? "");
  const swatch = (id: number) => `<span class="swatch" style="background: ${colors[id]}"></span>`;
  const owned = game.ownedBy(player).length;

  let selection = `<p class="muted">${t("Click one of your territories, then a neighboring one to move or attack")}</p>`;
  if (selected >= 0 && game.territories[selected].owner === player) {
    const territory = game.territories[selected];
    const cost = RECRUIT_COST * RECRUIT_BATCH;
    selection = /* html */ `<div class="row"><span class="grow">${t("Troops")}: <b>${game.troops[selected]}</b>
        (${t("ready")}: ${game.movable(selected)}) · ${t("Defense")} +${rn(territory.defense * 100)}%</span>
        <button data-action="recruit" ${realm.gold < cost ? "disabled" : ""} data-tip="${t("Recruit {{count}} troops for {{cost}} gold", { count: RECRUIT_BATCH, cost })}">${t("Recruit")}</button></div>
      <div class="row"><span class="grow">${t("Send")}</span><select id="strategyShare">${[1, 0.75, 0.5, 0.25]
        .map(value => `<option value="${value}" ${value === share ? "selected" : ""}>${value * 100}%</option>`)
        .join("")}</select></div>`;
  }

  const neighbors = game
    .neighborRealms(player)
    .concat(game.enemiesOf(player).filter(id => !game.neighborRealms(player).includes(id)));
  const diplomacy = neighbors
    .filter(id => game.realms.get(id)?.alive)
    .map(id => {
      const war = game.atWar(player, id);
      const action = war
        ? `<button data-action="peace" data-id="${id}">${t("Propose peace")}</button>`
        : `<button data-action="war" data-id="${id}">${t("Declare war")}</button>`;
      return `<div class="row">${swatch(id)}<span class="grow">${name(id)} <span class="muted">${game.strength(id)} ${t("troops")}</span></span>${action}</div>`;
    })
    .join("");
  const offers = [...game.offers]
    .map(offer => offer.split(">").map(Number))
    .filter(([, to]) => to === player)
    .map(
      ([from]) =>
        `<div class="row"><span class="grow">${t("{{name}} offers peace", { name: name(from) })}</span><button data-action="accept" data-id="${from}">${t("Accept")}</button></div>`
    )
    .join("");

  const log = game.log
    .slice(-8)
    .reverse()
    .map(line => `<div>${escapeHtml(line)}</div>`)
    .join("");

  hud.innerHTML = /* html */ `${STYLE}
    <div class="row">${swatch(player)}<b class="grow">${name(player)}</b><span>${t("Turn {{turn}}", { turn: game.turn })}</span></div>
    <div class="row muted"><span>${t("Gold")}: ${Math.floor(realm.gold)} (+${game.income(player)})</span><span>${t("Troops")}: ${game.strength(player)}</span><span>${t("Territories")}: ${owned}</span></div>
    <h4>${t("Orders")}</h4>${selection}
    <h4>${t("Diplomacy")}</h4>${offers}${diplomacy || `<p class="muted">${t("No neighbors")}</p>`}
    <div class="row"><button data-action="end" class="grow">${t("End turn")}</button><button data-action="quit">${t("Quit")}</button></div>
    <h4>${t("Events")}</h4><div class="log">${log || `<span class="muted">${t("Nothing yet")}</span>`}</div>`;
}

function exit(): void {
  Dialog.destroy(SETUP_ID);
  Dialog.destroy(HUD_ID);
  if (!world) return;
  world = null;
  selected = -1;
  removeStrategy();
  options.app.mode = null;
  applyDefaultViewboxEvents();
  clearMainTip();
}

export const StrategyMode = { open };
