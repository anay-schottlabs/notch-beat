import { useSyncExternalStore } from "react";
import type { GameEngine, GameSnapshot } from "../game/engine";

/** Re-renders only when the engine publishes a change (phase or score), never per frame. */
export function useGameSnapshot(engine: GameEngine): GameSnapshot {
  return useSyncExternalStore(engine.subscribeSnapshot, engine.getSnapshot);
}
