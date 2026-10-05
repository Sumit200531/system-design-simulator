import { useSyncExternalStore } from "react";
import { Simulation, topologicalOrder, type Architecture, type ChaosAction, type Snapshot } from "@sds/engine";

export const SPEEDS = [1, 2, 5, 10] as const;
export type Speed = (typeof SPEEDS)[number];

/** Snapshots are published to React at most this often; the engine ticks at its own rate. */
const PUBLISH_INTERVAL_MS = 80;
/** Bound on catch-up work after a long frame (tab in background, debugger). */
const MAX_TICKS_PER_FRAME = 400;

export interface ControllerState {
  readonly running: boolean;
  readonly speed: Speed;
  readonly snapshot: Snapshot;
}

/**
 * Drives the engine from requestAnimationFrame. The engine stays pure and
 * synchronous; this class owns wall-clock time and publishes snapshots.
 */
export class SimController {
  private simulation: Simulation;
  private architecture: Architecture;
  private state: ControllerState;
  private listeners = new Set<() => void>();
  private frame = 0;
  private lastFrame = 0;
  private lastPublish = 0;
  private carry = 0;

  constructor(architecture: Architecture) {
    this.architecture = architecture;
    this.simulation = new Simulation(architecture);
    this.state = { running: false, speed: 1, snapshot: this.simulation.snapshot() };
  }

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getState = () => this.state;

  /** Apply design edits live; designs with cycles are ignored until fixed. */
  setArchitecture(architecture: Architecture): void {
    if (!topologicalOrder(architecture)) return;
    this.architecture = architecture;
    this.simulation.setArchitecture(architecture);
    this.publish();
  }

  start(): void {
    if (this.state.running) return;
    this.lastFrame = performance.now();
    this.update({ running: true });
    this.frame = requestAnimationFrame(this.loop);
  }

  pause(): void {
    cancelAnimationFrame(this.frame);
    this.update({ running: false });
  }

  reset(): void {
    this.pause();
    this.simulation = new Simulation(this.architecture);
    this.carry = 0;
    this.publish();
  }

  setSpeed(speed: Speed): void {
    this.update({ speed });
  }

  apply(action: ChaosAction): void {
    this.simulation.apply(action);
    this.publish();
  }

  dispose(): void {
    cancelAnimationFrame(this.frame);
    this.listeners.clear();
  }

  private loop = () => {
    // Measure with one clock; rAF timestamps can use a different origin than performance.now().
    const now = performance.now();
    const elapsed = Math.min(1, Math.max(0, (now - this.lastFrame) / 1000));
    this.lastFrame = now;
    this.carry += elapsed * this.state.speed;
    let ticks = 0;
    while (this.carry >= this.simulation.tickSeconds && ticks < MAX_TICKS_PER_FRAME) {
      this.simulation.step();
      this.carry -= this.simulation.tickSeconds;
      ticks += 1;
    }
    if (ticks === MAX_TICKS_PER_FRAME) this.carry = 0;
    if (now - this.lastPublish >= PUBLISH_INTERVAL_MS) {
      this.lastPublish = now;
      this.publish();
    }
    this.frame = requestAnimationFrame(this.loop);
  };

  private publish(): void {
    this.update({ snapshot: this.simulation.snapshot() });
  }

  private update(patch: Partial<ControllerState>): void {
    this.state = { ...this.state, ...patch };
    this.listeners.forEach((listener) => listener());
  }
}

export function useController<T>(controller: SimController, select: (state: ControllerState) => T): T {
  return useSyncExternalStore(controller.subscribe, () => select(controller.getState()));
}
