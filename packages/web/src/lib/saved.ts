import type { Design } from "./design.ts";

/** Saved designs live in this browser only. Storage can be unavailable, so every access is guarded. */
const KEY = "sds:designs:v1";
export type Slot = "A" | "B";

export function loadSlots(): Partial<Record<Slot, Design>> {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as Partial<Record<Slot, Design>>) : {};
  } catch {
    return {};
  }
}

export function saveSlot(slot: Slot, design: Design, slots: Partial<Record<Slot, Design>>): Partial<Record<Slot, Design>> {
  const next = { ...slots, [slot]: design };
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    // Not persisted; still available for this session.
  }
  return next;
}
