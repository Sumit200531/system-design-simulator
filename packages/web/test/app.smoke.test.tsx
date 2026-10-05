// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import { App } from "../src/App.tsx";

// Browser APIs jsdom lacks.
globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
window.matchMedia ??= ((query: string) => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia;
(globalThis as { DOMMatrixReadOnly?: unknown }).DOMMatrixReadOnly ??= class { m22 = 1; constructor() {} };
HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) { this.open = true; };
HTMLDialogElement.prototype.close ??= function (this: HTMLDialogElement) { this.open = false; };
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const byText = (root: HTMLElement, text: string) => [...root.querySelectorAll("button")].find((b) => b.textContent?.trim() === text);
const click = (el: Element | undefined) => {
  if (!el) throw new Error("not found");
  act(() => (el as HTMLButtonElement).click());
};
const wait = (ms: number) => act(() => new Promise((r) => setTimeout(r, ms)));

describe("Simulator UI", () => {
  it("runs, breaks, recovers and compares without errors", async () => {
    localStorage.clear();
    const errors = vi.spyOn(console, "error");
    const container = document.createElement("div");
    container.style.width = "1400px";
    container.style.height = "900px";
    document.body.append(container);
    const root = createRoot(container);
    act(() => root.render(<App />));

    expect(container.querySelectorAll(".component-node").length).toBe(7);
    click(byText(container, "▶ Start simulation"));
    await wait(1_200);
    expect(container.querySelector(".clock")?.textContent).not.toBe("0:00");
    expect(container.querySelector(".metric-value")?.textContent).not.toBe("0.0");

    for (const label of ["Kill server", "Traffic spike ×5", "Network latency", "Cache failure", "Kill database"]) {
      click(byText(container, label));
      await wait(150);
    }
    expect(container.querySelector(".status-down")).not.toBeNull();
    click([...container.querySelectorAll("button")].find((b) => b.textContent === "Events"));
    expect(container.querySelector(".events")?.textContent).toContain("all instances down");
    click(byText(container, "Recover all"));
    click(byText(container, "Analysis"));
    expect(container.querySelector(".insights")).not.toBeNull();

    click(byText(container, "Save as A"));
    const select = container.querySelector<HTMLSelectElement>("select[aria-label='Load a template']")!;
    act(() => {
      select.value = "Starter monolith";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(container.querySelectorAll(".component-node").length).toBe(3);
    click(byText(container, "Save as B"));
    click(byText(container, "Compare A/B"));
    expect(container.querySelector(".compare-dialog .verdict")?.textContent?.length).toBeGreaterThan(20);

    const realErrors = errors.mock.calls.filter((call) => !String(call[0]).includes("[React Flow]"));
    expect(realErrors).toEqual([]);
    act(() => root.unmount());
  });
});
