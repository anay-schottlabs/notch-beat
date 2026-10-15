/** True inside the Tauri shell; false in a plain browser tab (`npm run dev`). */
export const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
