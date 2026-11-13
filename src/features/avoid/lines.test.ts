import { describe, expect, it } from "vitest";
import { ALL_LINES, backLine, CHAT_AFTER_MS, leavingLine } from "./lines";

const MIN = 60_000;

describe("[avoid.goodbye] what the pet says stepping aside and back", () => {
  it("has at least three lines for every case, picked at random", () => {
    for (const lines of Object.values(ALL_LINES.LEAVING)) expect(lines.length).toBeGreaterThanOrEqual(3);
    for (const { short, long } of Object.values(ALL_LINES.BACK)) {
      expect(short.length).toBeGreaterThanOrEqual(3);
      expect(long.length).toBeGreaterThanOrEqual(3);
    }
    expect(ALL_LINES.SHOWN_ANYWAY.length).toBeGreaterThanOrEqual(3);
    expect(leavingLine("presenting", () => 0)).toBe(ALL_LINES.LEAVING.presenting[0]);
    expect(leavingLine("presenting", () => 0.99)).toBe(ALL_LINES.LEAVING.presenting.at(-1));
  });

  it("says why it leaves", () => {
    expect(ALL_LINES.LEAVING.call).toContain(leavingLine("call"));
    expect(ALL_LINES.LEAVING.fullscreen).toContain(leavingLine("fullscreen"));
  });

  it("back after 2 minutes or more it chats about what you did; sooner it says nothing", () => {
    expect(backLine("fullscreen", CHAT_AFTER_MS - 1, false)).toBeNull();
    expect(ALL_LINES.BACK.fullscreen.short).toContain(backLine("fullscreen", 5 * MIN, false));
    expect(ALL_LINES.BACK.fullscreen.long).toContain(backLine("fullscreen", 60 * MIN, false));
    expect(ALL_LINES.BACK.presenting.short).toContain(backLine("presenting", 44 * MIN, false));
    expect(ALL_LINES.BACK.presenting.long).toContain(backLine("presenting", 45 * MIN, false));
    expect(ALL_LINES.BACK.call.long).toContain(backLine("call", 90 * MIN, false));
  });

  it("shown anyway from the tray, it just says it's back", () => {
    expect(ALL_LINES.SHOWN_ANYWAY).toContain(backLine("call", 10_000, true));
  });
});
