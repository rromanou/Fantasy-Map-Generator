// Turn-based strategy mode: territories, troops, wars and bot realms. Session-only, never touches the map data

export interface Territory {
  id: number;
  owner: number; // realm id, the state id it started with
  pop: number;
  defense: number; // terrain, walls and capital bonus, 0..0.8
  capital: boolean;
  links: { to: number; sea: boolean }[];
}

export interface Realm {
  id: number;
  name: string;
  human: boolean;
  aggression: number; // 0.3..1.3, how readily a bot starts a war
  might: number; // starting military weight, 0.5..2
  gold: number;
  alive: boolean;
}

export interface StrategyInput {
  territories: Territory[];
  realms: Omit<Realm, "gold" | "alive">[];
  relations: Record<number, Record<number, string>>; // realm -> realm -> Ally, Friendly, Neutral, Suspicion, Enemy…
  humans: number[];
  seed: string;
}

interface War {
  a: number; // attacker
  b: number;
  since: number;
  lost: Record<number, number>; // territories lost by each side
}

export interface Battle {
  from: number;
  to: number;
  sent: number;
  won: boolean;
  attackerLoss: number;
  defenderLoss: number;
}

export const RECRUIT_COST = 6;
export const RECRUIT_BATCH = 3;
const GRACE_TURNS = 3;
const WIN_SHARE = 0.55;
const SEA_PENALTY = 0.7;
const RELATION_HEAT: Record<string, number> = {
  Enemy: 0.9,
  Rival: 0.5,
  Suspicion: 0.25,
  Unknown: 0,
  Neutral: 0,
  Friendly: -0.4
};
const BOUND_RELATIONS = ["Ally", "Vassal", "Suzerain"];

const warKey = (a: number, b: number) => (a < b ? `${a}-${b}` : `${b}-${a}`);

function seeded(seed: string): () => number {
  let state = 2166136261;
  for (const char of seed) state = Math.imul(state ^ char.charCodeAt(0), 16777619);
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

export class StrategyGame {
  turn = 1;
  readonly territories: Territory[];
  readonly realms = new Map<number, Realm>();
  readonly troops: number[];
  readonly moved: number[]; // troops that already acted in each territory this turn
  readonly wars = new Map<string, War>();
  readonly offers = new Set<string>(); // "from>to" peace offers waiting for a human
  readonly log: string[] = [];
  readonly humans: number[];
  current = 0; // index in humans
  winner = 0;
  private readonly relations: StrategyInput["relations"];
  private readonly rng: () => number;

  constructor(input: StrategyInput) {
    this.territories = input.territories;
    this.relations = input.relations;
    this.humans = [...input.humans];
    this.rng = seeded(input.seed);
    const meanPop = this.territories.reduce((sum, territory) => sum + territory.pop, 0) / this.territories.length || 1;
    for (const realm of input.realms) this.realms.set(realm.id, { ...realm, gold: 20, alive: true });
    this.troops = this.territories.map(({ pop, owner }) => {
      const might = this.realms.get(owner)?.might ?? 1;
      return Math.max(2, Math.round((2 + (pop / meanPop) * 6) * might));
    });
    this.moved = this.territories.map(() => 0);
    for (const a of this.realms.keys())
      for (const b of this.realms.keys()) if (a < b && this.relation(a, b) === "Enemy") this.openWar(a, b);
    this.refreshAlive();
  }

  get player(): number {
    return this.humans[this.current] ?? 0;
  }

  get over(): boolean {
    return this.winner > 0 || !this.humans.length;
  }

  relation(a: number, b: number): string {
    return this.relations[a]?.[b] ?? "Neutral";
  }

  atWar(a: number, b: number): boolean {
    return this.wars.has(warKey(a, b));
  }

  enemiesOf(realm: number): number[] {
    return [...this.realms.keys()].filter(other => other !== realm && this.atWar(realm, other));
  }

  ownedBy(realm: number): number[] {
    return this.territories.filter(territory => territory.owner === realm).map(territory => territory.id);
  }

  strength(realm: number): number {
    return this.ownedBy(realm).reduce((sum, id) => sum + this.troops[id], 0);
  }

  income(realm: number): number {
    const meanPop = this.territories.reduce((sum, territory) => sum + territory.pop, 0) / this.territories.length || 1;
    return Math.round(this.ownedBy(realm).reduce((sum, id) => sum + 2 + (this.territories[id].pop / meanPop) * 3, 0));
  }

  movable(id: number): number {
    return this.troops[id] - this.moved[id];
  }

  neighborRealms(realm: number): number[] {
    const found = new Set<number>();
    for (const id of this.ownedBy(realm))
      for (const { to } of this.territories[id].links) {
        const owner = this.territories[to].owner;
        if (owner !== realm) found.add(owner);
      }
    return [...found];
  }

  /** Why a move cannot be made, or an empty string when it can */
  checkMove(from: number, to: number, realm: number): string {
    const origin = this.territories[from];
    const link = origin?.links.find(item => item.to === to);
    if (!link) return "not adjacent";
    if (origin.owner !== realm) return "not yours";
    if (this.movable(from) < 1) return "no troops left to move";
    const owner = this.territories[to].owner;
    if (owner !== realm && !this.atWar(realm, owner)) return "no war";
    return "";
  }

  /** Send troops to a neighbor: merge into an own territory or attack an enemy one */
  move(from: number, to: number, count: number): Battle | null {
    const origin = this.territories[from];
    const target = this.territories[to];
    const sent = Math.min(Math.max(1, Math.floor(count)), this.movable(from));
    this.troops[from] -= sent;
    if (target.owner === origin.owner) {
      this.troops[to] += sent;
      this.moved[to] += sent;
      return null;
    }
    const sea = origin.links.find(link => link.to === to)?.sea;
    const rolled = () => 0.85 + this.rng() * 0.3;
    const attackPower = sent * rolled() * (sea ? SEA_PENALTY : 1);
    const defenders = this.troops[to];
    const defensePower = defenders * (1 + target.defense) * rolled();
    const defenderLoss = Math.min(defenders, Math.round(attackPower * 0.6));
    const attackerLoss = defenders ? Math.min(sent, Math.round(defensePower * 0.6)) : 0;
    const won = defenderLoss >= defenders && sent - attackerLoss > 0;
    this.troops[to] = defenders - defenderLoss;
    const battle: Battle = { from, to, sent, won, attackerLoss, defenderLoss };
    if (won) this.conquer(origin.owner, to, sent - attackerLoss);
    else this.troops[from] += sent - attackerLoss; // the survivors fall back
    this.refreshAlive();
    return battle;
  }

  declareWar(a: number, b: number, join = false): void {
    if (a === b || this.atWar(a, b) || !this.realms.get(a)?.alive || !this.realms.get(b)?.alive) return;
    this.openWar(a, b);
    this.say(`${this.name(a)} ${join ? "joins the war against" : "declares war on"} ${this.name(b)}`);
    if (join) return;
    for (const realm of this.realms.values()) {
      if (realm.human || !realm.alive || realm.id === a || realm.id === b) continue;
      const defends = BOUND_RELATIONS.includes(this.relation(realm.id, b)) && !this.bound(realm.id, a);
      const supports = BOUND_RELATIONS.includes(this.relation(realm.id, a)) && !this.bound(realm.id, b);
      if ((defends && this.rng() < 0.6) || (supports && this.rng() < 0.5))
        this.declareWar(realm.id, defends ? a : b, true);
    }
  }

  recruit(id: number): boolean {
    const realm = this.realms.get(this.territories[id].owner);
    if (!realm || realm.gold < RECRUIT_COST * RECRUIT_BATCH) return false;
    realm.gold -= RECRUIT_COST * RECRUIT_BATCH;
    this.troops[id] += RECRUIT_BATCH;
    this.moved[id] += RECRUIT_BATCH;
    return true;
  }

  /** Ask for peace: a bot answers at once, a human sees the offer on its turn */
  proposePeace(from: number, to: number): boolean {
    if (!this.atWar(from, to)) return false;
    if (this.realms.get(to)?.human) {
      this.offers.add(`${from}>${to}`);
      return false;
    }
    const war = this.wars.get(warKey(from, to))!;
    const weaker = this.strength(to) < this.strength(from) ? 0.3 : 0;
    if (this.rng() >= Math.min(0.9, 0.2 + (this.turn - war.since) * 0.06 + weaker)) return false;
    this.makePeace(from, to);
    return true;
  }

  acceptPeace(from: number, to: number): void {
    if (this.offers.delete(`${from}>${to}`)) this.makePeace(from, to);
  }

  /** Income and fresh orders for everyone, then the first human plays */
  startTurn(): void {
    for (const realm of this.realms.values()) if (realm.alive) realm.gold += this.income(realm.id);
    this.moved.fill(0);
    this.current = 0;
    this.skipDead();
  }

  /** Ends the current human's turn; after the last human the bots play and a new round starts */
  endTurn(): void {
    this.current++;
    this.skipDead();
    if (this.current < this.humans.length) {
      this.moved.fill(0);
      return;
    }
    for (const realm of this.realms.values()) if (realm.alive && !realm.human) this.playBot(realm);
    this.turn++;
    this.startTurn();
    this.checkVictory();
  }

  private skipDead(): void {
    while (this.current < this.humans.length && !this.realms.get(this.humans[this.current])?.alive) this.current++;
  }

  private bound(a: number, b: number): boolean {
    return BOUND_RELATIONS.includes(this.relation(a, b));
  }

  private name(id: number): string {
    return this.realms.get(id)?.name ?? "?";
  }

  private say(text: string): void {
    this.log.push(`${this.turn}: ${text}`);
    if (this.log.length > 60) this.log.shift();
  }

  private openWar(a: number, b: number): void {
    this.wars.set(warKey(a, b), { a, b, since: this.turn, lost: { [a]: 0, [b]: 0 } });
  }

  private makePeace(a: number, b: number): void {
    this.wars.delete(warKey(a, b));
    this.offers.delete(`${a}>${b}`);
    this.offers.delete(`${b}>${a}`);
    this.say(`${this.name(a)} and ${this.name(b)} make peace`);
  }

  private conquer(realm: number, id: number, troops: number): void {
    const territory = this.territories[id];
    const loser = territory.owner;
    const war = this.wars.get(warKey(realm, loser));
    if (war) war.lost[loser]++;
    if (territory.capital) {
      const loot = Math.floor((this.realms.get(loser)?.gold ?? 0) / 2);
      this.realms.get(loser)!.gold -= loot;
      this.realms.get(realm)!.gold += loot;
    }
    territory.owner = realm;
    this.troops[id] = troops;
    this.moved[id] = troops;
    this.say(`${this.name(realm)} takes territory ${id} from ${this.name(loser)}`);
  }

  private refreshAlive(): void {
    for (const realm of this.realms.values()) {
      if (!realm.alive || this.ownedBy(realm.id).length) continue;
      realm.alive = false;
      for (const key of [...this.wars.keys()]) if (key.split("-").includes(String(realm.id))) this.wars.delete(key);
      this.say(`${realm.name} is destroyed`);
    }
    this.checkVictory();
  }

  private checkVictory(): void {
    const alive = [...this.realms.values()].filter(realm => realm.alive);
    const lead = alive.find(realm => this.ownedBy(realm.id).length >= this.territories.length * WIN_SHARE);
    const lastHuman = alive.filter(realm => realm.human);
    if (!lastHuman.length) this.humans.length = 0;
    else if (alive.length === 1) this.winner = alive[0].id;
    else if (lead?.human) this.winner = lead.id;
  }

  /** Bot turn: peace pressure, a possible war, recruiting, then moves */
  private playBot(realm: Realm): void {
    this.moved.fill(0);
    this.considerPeace(realm);
    if (this.turn > GRACE_TURNS) this.considerWar(realm);
    this.botRecruit(realm);
    this.botMoves(realm);
  }

  private considerPeace(realm: Realm): void {
    for (const enemy of this.enemiesOf(realm.id)) {
      const war = this.wars.get(warKey(realm.id, enemy))!;
      const pressure = (this.turn - war.since) * 0.04 + war.lost[realm.id] * 0.15 - war.lost[enemy] * 0.05;
      if (this.turn - war.since < 3 || this.rng() >= pressure) continue;
      if (this.realms.get(enemy)?.human) this.offers.add(`${realm.id}>${enemy}`);
      else if (this.rng() < 0.5) this.makePeace(realm.id, enemy);
    }
  }

  /** War desire from temperament, relation, relative strength, threats on the border and war weariness */
  private considerWar(realm: Realm): void {
    const mine = this.strength(realm.id) || 1;
    const weary = this.enemiesOf(realm.id).length * 0.3;
    let best = { id: 0, desire: 0 };
    for (const other of this.neighborRealms(realm.id)) {
      const target = this.realms.get(other);
      const heat = RELATION_HEAT[this.relation(realm.id, other)];
      if (!target?.alive || this.atWar(realm.id, other) || heat === undefined) continue;
      const ratio = Math.log2(mine / (this.strength(other) || 1));
      const distracted = this.enemiesOf(other).length ? 0.2 : 0;
      const desire =
        realm.aggression * 0.6 +
        heat +
        Math.max(-1.5, Math.min(1.5, ratio)) * 0.5 +
        distracted -
        weary +
        this.threat(realm.id, other);
      if (desire > best.desire) best = { id: other, desire };
    }
    const chance = Math.max(0, Math.min(0.35, (best.desire - 0.6) * 0.35));
    if (best.id && this.rng() < chance) this.declareWar(realm.id, best.id);
  }

  /** Enemy stacks massed against our border territories provoke us */
  private threat(realm: number, other: number): number {
    let massed = 0;
    for (const id of this.ownedBy(other))
      for (const { to } of this.territories[id].links)
        if (this.territories[to].owner === realm && this.troops[id] > this.troops[to] * 1.5) massed++;
    return Math.min(0.5, massed * 0.15);
  }

  private frontline(realm: number): number[] {
    return this.ownedBy(realm).filter(id =>
      this.territories[id].links.some(({ to }) => this.atWar(realm, this.territories[to].owner))
    );
  }

  private botRecruit(realm: Realm): void {
    const front = this.frontline(realm.id);
    const spots = front.length ? front : this.ownedBy(realm.id);
    const reserve = front.length ? 0 : realm.gold * 0.5;
    for (let i = 0; spots.length && realm.gold - reserve >= RECRUIT_COST * RECRUIT_BATCH && i < 12; i++)
      this.recruit(spots[i % spots.length]);
  }

  private botMoves(realm: Realm): void {
    const toFront = this.distanceToEnemy(realm.id);
    const ratio = 1.1 + (1.3 - realm.aggression) * 0.4;
    for (const id of this.ownedBy(realm.id)) {
      if (this.movable(id) < 2) continue;
      const attacks = this.territories[id].links
        .filter(({ to }) => this.atWar(realm.id, this.territories[to].owner))
        .map(({ to, sea }) => ({
          to,
          score: this.troops[to] * (1 + this.territories[to].defense) * (sea ? 1 / SEA_PENALTY : 1)
        }))
        .sort((x, y) => x.score - y.score);
      const army = this.movable(id);
      const weakest = attacks[0];
      if (weakest && army > weakest.score * ratio) {
        this.move(id, weakest.to, army);
      } else if (!weakest) {
        const next = this.territories[id].links
          .filter(({ to }) => this.territories[to].owner === realm.id)
          .sort((x, y) => (toFront[x.to] ?? 99) - (toFront[y.to] ?? 99))[0];
        if (next && (toFront[next.to] ?? 99) < (toFront[id] ?? 99)) this.move(id, next.to, army);
      }
    }
  }

  /** Steps from each own territory to the nearest territory of a realm at war with us */
  private distanceToEnemy(realm: number): Record<number, number> {
    const distance: Record<number, number> = {};
    const queue: number[] = [];
    for (const id of this.frontline(realm)) {
      distance[id] = 0;
      queue.push(id);
    }
    for (let head = 0; head < queue.length; head++)
      for (const { to } of this.territories[queue[head]].links)
        if (this.territories[to].owner === realm && distance[to] === undefined) {
          distance[to] = distance[queue[head]] + 1;
          queue.push(to);
        }
    return distance;
  }
}
