import { createContext, useContext } from "react";
import type { ComponentConfig } from "@sds/engine";
import type { SimController } from "../lib/sim-controller.ts";

export interface EditorApi {
  readonly controller: SimController;
  readonly select: (id: string | null) => void;
  readonly updateConfig: (id: string, patch: Partial<ComponentConfig>) => void;
  readonly rename: (id: string, label: string) => void;
  readonly remove: (id: string) => void;
}

export const EditorContext = createContext<EditorApi | null>(null);

export function useEditor(): EditorApi {
  const api = useContext(EditorContext);
  if (!api) throw new Error("EditorContext missing");
  return api;
}
