export interface GameInfo {
  id: string;
  name: string;
  description: string;
  available: boolean;
}

/** Mini-games shown in the panel. Games read character abilities, so every character can play every game. */
export const GAMES: GameInfo[] = [
  {
    id: "safe-landing",
    name: "Safe Landing",
    description: "Drop from the top of the screen, dodge the spikes, grab umbrellas and land softly on the pad. Gliders get a head start.",
    available: true,
  },
  {
    id: "jump-up",
    name: "Jump Up",
    description: "Bounce from platform to platform as high as you can, avoiding birds and falling sticky notes.",
    available: false,
  },
  {
    id: "stickman-fight",
    name: "Stickman Fight",
    description: "Take on the stickman using your character's own fighting style.",
    available: false,
  },
];
