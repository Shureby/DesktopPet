import { loadAll } from "../characters/registry";
import { backend } from "../platform";
import { startMockScheduler } from "../platform/mock";
import "../styles/pet.css";
import { enableFakeWindowDragging } from "./demo";
import { PetHost } from "./PetHost";

async function main() {
  const registry = await loadAll(() => backend.listUserCharacters(), backend.assetUrl);
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
    document.getElementById("badges")!,
    document.getElementById("mood")!,
    settings,
  );
  await host.start();
  // Handy for poking at the simulation from devtools in the browser mock.
  if (backend.kind === "mock") Object.assign(window, { petHost: host });
  if (await backend.e2eEnabled()) {
    // Script errors are collected for the tests to check.
    const errors: string[] = [];
    window.addEventListener("error", (e) => errors.push(String(e.message)));
    window.addEventListener("unhandledrejection", (e) => errors.push(String(e.reason)));
    Object.assign(window, { __epet: { ...host.testHooks(), errors } });
  }
}

main().catch((e) => console.error(e));
