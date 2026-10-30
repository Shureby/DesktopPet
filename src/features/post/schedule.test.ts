import { describe, expect, it } from "vitest";
import { postConfig, postSettings, withPaired, withoutPaired } from "./post";
import { answerTone, deviceName, nickOf, rulesOf, sentAnswers, shiftHm, withNick, withRule, zoneNote, type InboxItem, type SharedItem } from "./schedule";

const DAD = "AB12";
const paired = () => withPaired(postSettings({}), { fingerprint: DAD, alias: "Will's Rooster" }, 1);

describe("paired ePets: nickname and rules", () => {
  it("are kept in the settings, and through pairing again", () => {
    let s = withRule(withNick(paired(), "ab12", "  Dad  "), DAD, "alarm", "auto");
    expect(nickOf(s, DAD)).toBe("Dad");
    expect(deviceName(s, DAD, "other")).toBe("Dad");
    expect(rulesOf(s, DAD)).toEqual({ alarm: "auto", todo: "ask", anniversary: "ask" });
    // Saved and read back.
    s = postSettings(JSON.parse(JSON.stringify(s)));
    expect(nickOf(s, DAD)).toBe("Dad");
    expect(rulesOf(s, DAD).alarm).toBe("auto");
    // Paired again (a new code): still Dad.
    s = withPaired(s, { fingerprint: DAD, alias: "Rooster" }, 2);
    expect(deviceName(s, DAD)).toBe("Dad");
    expect(rulesOf(s, DAD).alarm).toBe("auto");
    // No nickname: its name.
    expect(deviceName(withNick(s, DAD, ""), DAD, "")).toBe("Rooster");
    // Unpaired: gone.
    expect(deviceName(withoutPaired(s, DAD), DAD, "x")).toBe("x");
  });

  it("only rules that aren't all \"ask\" go to the app", () => {
    const s = withRule(paired(), DAD, "anniversary", "refuse");
    expect(postConfig(s, "me").shareRules).toEqual([{ fingerprint: DAD, alarm: "ask", todo: "ask", anniversary: "refuse" }]);
    expect(postConfig(paired(), "me").shareRules).toEqual([]);
  });

  it("anything odd in the settings is asked about", () => {
    const s = postSettings({ paired: [{ fingerprint: DAD, alias: "x", at: 1, rules: { alarm: "always", todo: "auto" }, nick: 5 }] } as never);
    expect(rulesOf(s, DAD)).toEqual({ alarm: "ask", todo: "auto", anniversary: "ask" });
    expect(nickOf(s, DAD)).toBe("");
  });
});

describe("time zones", () => {
  const alarm = (time: string | null, at: number | null): SharedItem => ({ type: "alarm", label: "x", repeat: time ? "daily" : "none", days: 0, time, at, important: false, autoSnooze: false });
  const entry = (item: SharedItem, offset: number | null, hereOffset: number): Pick<InboxItem, "shared" | "offset" | "hereOffset" | "tz"> => ({
    shared: { uid: "u", item },
    offset,
    hereOffset,
    tz: "Asia/Shanghai",
  });

  it("the same zone says nothing", () => {
    expect(zoneNote(entry(alarm("08:00", null), 480, 480))).toBeNull();
    expect(zoneNote(entry(alarm("08:00", null), null, 540))).toBeNull();
  });

  it("a moment shows the sender's clock then", () => {
    const n = zoneNote(entry(alarm(null, 1_000_000), 480, 540));
    expect(n).toEqual({ kind: "moment", theirs: 1_000_000 - 3_600_000, place: "Shanghai" });
  });

  it("a clock time: theirs is an hour later here (Shanghai to Tokyo)", () => {
    const n = zoneNote(entry(alarm("08:00", null), 480, 540), "Asia/Tokyo");
    expect(n).toEqual({ kind: "clock", mine: "08:00", theirsHere: "09:00", place: "Shanghai", herePlace: "Tokyo" });
  });

  it("an anniversary is a day: nothing", () => {
    const ann: SharedItem = { type: "anniversary", kind: "birthday", icon: "🎂", name: "Mum", month: 3, day: 12, since: null, preps: [], effect: true, music: null, calendar: "solar", leap: false, nth: null, weekday: null };
    expect(zoneNote(entry(ann, 480, 0))).toBeNull();
  });

  it("clock times wrap around midnight", () => {
    expect(shiftHm("23:30", 60)).toBe("00:30");
    expect(shiftHm("00:15", -30)).toBe("23:45");
  });
});

it("the latest answer of each device counts", () => {
  const list = [
    { fingerprint: "A", kind: "alarm" as const, id: 1, uid: "u", answer: "asked", at: 1 },
    { fingerprint: "A", kind: "alarm" as const, id: 1, uid: "u", answer: "added", at: 2 },
    { fingerprint: "B", kind: "alarm" as const, id: 1, uid: "u", answer: "unreachable", at: 3 },
    { fingerprint: "A", kind: "todo" as const, id: 1, uid: "v", answer: "declined", at: 4 },
  ];
  expect([...sentAnswers(list, "alarm", 1)]).toEqual([
    ["A", "added"],
    ["B", "unreachable"],
  ]);
  expect([answerTone("added"), answerTone("asked"), answerTone("declined")]).toEqual(["ok", "wait", "no"]);
});
