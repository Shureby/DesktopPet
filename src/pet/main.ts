import { loadBundled, loadUser } from "../characters/registry";
import { backend } from "../platform";
import { startMockScheduler } from "../platform/mock";
import "../styles/pet.css";
import { enableFakeWindowDragging } from "./demo";
import { PetHost } from "./PetHost";

async function main() {
  const registry = loadBundled();
  try {
    loadUser(await backend.listUserCharacters(), backend.assetUrl, registry);
  } catch (e) {
    console.warn("Could not load user characters", e);
  }
  for (const issue of registry.issues) console.warn(`Character not loaded: ${issue.source}\n  ${issue.errors.join("\n  ")}`);

  if (backend.kind === "mock") {
    document.body.classList.add("demo");
    startMockScheduler();
    enableFakeWindowDragging();
  }
  const settings = await backend.getSettings();
  const host = new PetHost(
    backend,
    registry,
    document.getElementById("pet") as HTMLCanvasElement,
    document.getElementById("bubble")!,
    document.getElementById("tomato")!,
    settings,
  );
  await host.start();
  // Handy for poking at the simulation from devtools in the browser mock.
  if (backend.kind === "mock") Object.assign(window, { petHost: host });
}

main().catch((e) => console.error(e));
