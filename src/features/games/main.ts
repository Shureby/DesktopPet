import { RulesBrain } from "../../brain/RulesBrain";
import { Pet } from "../../characters/Pet";
import { loadBundled, loadUser } from "../../characters/registry";
import { createRng } from "../../engine/random";
import { SpriteAtlas } from "../../engine/sprites";
import { backend } from "../../platform";
import "../../styles/game.css";
import { GameHost, type MiniGame } from "./GameHost";
import { SafeLandingGame } from "./safe-landing/game";

/** Entry point of the game window: picks the game from the URL hash and the current character. */
async function main() {
  const registry = loadBundled();
  try {
    loadUser(await backend.listUserCharacters(), backend.assetUrl, registry);
  } catch {
    // No user characters.
  }
  const settings = await backend.getSettings();
  const character = registry.pick(settings.character, "cat");
  const atlas = await SpriteAtlas.load(character.def.sprite, character.asset);
  const pet = new Pet(character.def, { brain: new RulesBrain(), rng: createRng(1), unit: 1, x: 0, y: 0 });

  const games: Record<string, () => MiniGame> = {
    "safe-landing": () => new SafeLandingGame(pet, atlas),
  };
  const id = location.hash.slice(1) || "safe-landing";
  const game = (games[id] ?? games["safe-landing"])();
  const canvas = document.getElementById("game") as HTMLCanvasElement;
  await new GameHost(game, canvas, backend, character.def.id).start();
  window.focus();
}

main().catch((e) => console.error(e));
