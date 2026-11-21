# Strategy game

A turn-based mode, opened from Tools > Play > Strategy game. It reads the map and never writes to it: the game lives in `StrategyGame` (`src/model/political/strategy-game.ts`) for the session only, and is lost on quit or reload.

- **Territories**: provinces, plus one extra per state for cells outside any province. Land neighbors are linked; separate landmasses are linked by sea to their nearest neighbors, with an attack penalty.
- **Start**: troops from population and the state's military power; terrain, walls and capital set defense. States at war (`Enemy`) in the diplomacy matrix start at war.
- **Players**: solo against bots, or several players one after another (hot-seat); every other state is a bot. `options.app.mode` is `strategy` meanwhile, so editing, saving and regeneration stay off.
- **Turn**: income, then each human moves, recruits, declares war or proposes peace, then the bots play.
- **Bots** declare war from temperament (expansionism), relation, relative strength, troops massed on their border and war weariness; allies may join. They never attack at peace without those factors, and they seek peace as wars drag on.
- **Win**: hold 55% of the territories, or be the last realm standing.
