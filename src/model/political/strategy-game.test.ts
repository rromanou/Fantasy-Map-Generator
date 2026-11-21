import { describe, expect, it } from "vitest";
import { StrategyGame, type StrategyInput, type Territory } from "./strategy-game";

// a line of territories 0-1-2-3, realms 1 (0,1) and 2 (2,3)
function line(relation = "Neutral", humans = [1]): StrategyGame {
  const territories: Territory[] = [1, 1, 2, 2].map((owner, id) => ({
    id,
    owner,
    pop: 10,
    defense: 0.2,
    capital: id === 0 || id === 3,
    links: [id - 1, id + 1].filter(to => to >= 0 && to < 4).map(to => ({ to, sea: false }))
  }));
  const input: StrategyInput = {
    territories,
    realms: [1, 2].map(id => ({ id, name: `R${id}`, human: humans.includes(id), aggression: 1, might: 1 })),
    relations: { 1: { 2: relation }, 2: { 1: relation } },
    humans,
    seed: "test"
  };
  return new StrategyGame(input);
}

describe("StrategyGame", () => {
  it("starts wars between enemies only", () => {
    expect(line("Enemy").atWar(1, 2)).toBe(true);
    expect(line("Neutral").atWar(1, 2)).toBe(false);
  });

  it("refuses to attack without a war and allows it after a declaration", () => {
    const game = line();
    expect(game.checkMove(1, 2, 1)).toBe("no war");
    game.declareWar(1, 2);
    expect(game.checkMove(1, 2, 1)).toBe("");
  });

  it("merges troops into an own territory without a battle", () => {
    const game = line();
    const before = game.troops[0] + game.troops[1];
    expect(game.move(0, 1, 100)).toBeNull();
    expect(game.troops[0] + game.troops[1]).toBe(before);
    expect(game.movable(1)).toBe(game.troops[1] - game.moved[1]);
  });

  it("conquers a territory with overwhelming force and ends the game on dominance", () => {
    const game = line("Enemy");
    game.troops[1] = 200;
    expect(game.move(1, 2, 200)?.won).toBe(true);
    expect(game.territories[2].owner).toBe(1);
    game.troops[2] = 200;
    game.moved[2] = 0;
    game.move(2, 3, 200);
    expect(game.ownedBy(2)).toHaveLength(0);
    expect(game.realms.get(2)?.alive).toBe(false);
    expect(game.winner).toBe(1);
  });

  it("repels a weak attack and costs both sides troops", () => {
    const game = line("Enemy");
    game.troops[1] = 3;
    game.troops[2] = 30;
    const battle = game.move(1, 2, 3)!;
    expect(battle.won).toBe(false);
    expect(game.territories[2].owner).toBe(2);
  });

  it("pays income at the start of a turn and spends gold on recruits", () => {
    const game = line();
    const gold = game.realms.get(1)!.gold;
    game.startTurn();
    expect(game.realms.get(1)!.gold).toBe(gold + game.income(1));
    const troops = game.troops[0];
    expect(game.recruit(0)).toBe(true);
    expect(game.troops[0]).toBe(troops + 3);
  });

  it("lets bots play a full round without breaking", () => {
    const game = line("Enemy");
    game.startTurn();
    for (let i = 0; i < 40 && !game.over; i++) game.endTurn();
    expect(game.turn).toBeGreaterThan(1);
    const owned = game.territories.reduce((sum, territory) => sum + (territory.owner > 0 ? 1 : 0), 0);
    expect(owned).toBe(4);
  });

  it("is deterministic for a seed", () => {
    const run = () => {
      const game = line("Enemy", []);
      for (let i = 0; i < 10; i++) game.endTurn();
      return game.territories.map(territory => territory.owner).join("");
    };
    expect(run()).toBe(run());
  });
});
