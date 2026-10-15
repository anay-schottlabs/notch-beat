import { describe, expect, it } from "vitest";
import { InputGate, KEY_LANES, isTextEntryTarget } from "./inputGate";

describe("InputGate", () => {
  it("counts one press per keystroke", () => {
    const g = new InputGate();
    expect(g.down("KeyF")).toBe(true);
    expect(g.down("KeyF")).toBe(false);
    expect(g.down("KeyF", true)).toBe(false);
    g.up("KeyF");
    expect(g.down("KeyF")).toBe(true);
  });

  it("reports which keyups end a counted press", () => {
    const g = new InputGate();
    expect(g.up("KeyF")).toBe(false);
    g.down("KeyF");
    expect(g.up("KeyF")).toBe(true);
    expect(g.up("KeyF")).toBe(false);
  });

  it("ignores OS auto-repeat even for an unseen key", () => {
    expect(new InputGate().down("KeyJ", true)).toBe(false);
  });

  it("tracks keys independently", () => {
    const g = new InputGate();
    expect(g.down("KeyF")).toBe(true);
    expect(g.down("KeyJ")).toBe(true);
    g.up("KeyF");
    expect(g.isHeld("KeyJ")).toBe(true);
  });

  it("releases everything on blur so keys don't stick", () => {
    const g = new InputGate();
    g.down("KeyF");
    g.releaseAll();
    expect(g.down("KeyF")).toBe(true);
  });
});

describe("isTextEntryTarget", () => {
  const el = (tagName: string, extra: Record<string, unknown> = {}) => ({ tagName, isContentEditable: false, ...extra }) as unknown as EventTarget;

  it("detects text fields", () => {
    expect(isTextEntryTarget(el("INPUT", { type: "text" }))).toBe(true);
    expect(isTextEntryTarget(el("TEXTAREA"))).toBe(true);
    expect(isTextEntryTarget(el("DIV", { isContentEditable: true }))).toBe(true);
  });

  it("allows gameplay over buttons and plain elements", () => {
    expect(isTextEntryTarget(el("BUTTON"))).toBe(false);
    expect(isTextEntryTarget(el("INPUT", { type: "checkbox" }))).toBe(false);
    expect(isTextEntryTarget(el("DIV"))).toBe(false);
    expect(isTextEntryTarget(null)).toBe(false);
  });

  it("maps D/F to the top lane and J/K to the bottom, and holds a lane until both its keys are up", () => {
    expect([KEY_LANES.KeyD, KEY_LANES.KeyF, KEY_LANES.KeyJ, KEY_LANES.KeyK]).toEqual(["f", "f", "j", "j"]);
    const g = new InputGate();
    g.down("KeyF");
    g.down("KeyD");
    g.up("KeyD");
    expect(g.laneHeld("f")).toBe(true);
    expect(g.laneHeld("j")).toBe(false);
    g.up("KeyF");
    expect(g.laneHeld("f")).toBe(false);
  });
});
