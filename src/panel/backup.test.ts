import { describe, expect, it } from "vitest";
import { backupContents, backupFrom } from "./backup";

const summary = {
  appVersion: "0.35.0",
  madeAt: new Date(2026, 9, 8, 9, 41).getTime(),
  device: { name: "HOME-PC", os: "windows" },
  alarms: 1,
  timers: 2,
  todos: 12,
  anniversaries: 3,
  characters: 0,
};

describe("backup text", () => {
  it("says where and when a backup was made", () => {
    expect(backupFrom(summary, new Date(2026, 9, 8, 12).getTime())).toMatch(/^HOME-PC · Windows · Today 9:41/);
    expect(backupFrom({ ...summary, device: { name: "Mac", os: "macos" } })).toContain("macOS");
  });
  it("counts what would be restored, without timers", () => {
    expect(backupContents(summary)).toBe("1 alarm · 12 to-dos · 3 anniversaries");
    expect(backupContents({ ...summary, anniversaries: 1, characters: 2 })).toBe("1 alarm · 12 to-dos · 1 anniversary · 2 characters");
  });
});
