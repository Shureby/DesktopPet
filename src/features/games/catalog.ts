export interface GameInfo {
  id: string;
  name: string;
  description: string;
  available: boolean;
}

/** Mini-games shown in the panel. Games read character abilities, so every character can play every game. */
import { msg } from "../../i18n";
export const GAMES: GameInfo[] = [
  {
    id: "safe-landing",
    name: msg("Safe Landing"),
    description: msg("Drop from the top of the screen, dodge the spikes, grab umbrellas and land softly on the pad. Gliders get a head start."),
    available: true,
  },
  {
    id: "jump-up",
    name: msg("Jump Up"),
    description: msg("Bounce from platform to platform as high as you can, avoiding birds and falling sticky notes."),
    available: false,
  },
  {
    id: "stickman-fight",
    name: msg("Stickman Fight"),
    description: msg("Take on the stickman using your character's own fighting style."),
    available: false,
  },
];
