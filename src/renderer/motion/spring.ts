/**
 * The one spring engine.
 *
 * A damped harmonic oscillator solved analytically each frame (exact for any frame time, so a slow frame never
 * makes a spring explode). Parameters follow vide.spring: `period` (seconds per oscillation) and `damping` ratio.
 *
 * Interruptible by design: `set(target)` keeps the current value AND velocity and only moves the goal, so a
 * spring redirected mid-flight curves smoothly toward the new target. Nothing ever restarts from a fixed start.
 *
 * All live springs share one requestAnimationFrame loop that stops when every spring is at rest.
 */
import { resolveToken, type SpringToken, type SpringTokenName } from './tokens';

const restDistance = 0.001;
const restVelocity = 0.01;

const activeSprings = new Set<Spring>();
let frameHandle = 0;
let fallbackHandle = 0;
let lastFrameTime = 0;

/**
 * Hidden windows and headless screenshots stop delivering animation frames. A slow timer backs every frame up,
 * so springs still reach their targets there (a pane opened while the window was hidden is in place when shown).
 */
const fallbackDelay = 100;

function requestFrame(): void {
  frameHandle = requestAnimationFrame(tick);
  fallbackHandle = window.setTimeout(() => tick(performance.now()), fallbackDelay);
}

function tick(now: number): void {
  cancelAnimationFrame(frameHandle);
  window.clearTimeout(fallbackHandle);
  const seconds = Math.min(0.064, Math.max(0, (now - lastFrameTime) / 1000));
  lastFrameTime = now;
  for (const spring of [...activeSprings]) spring.advance(seconds);
  if (activeSprings.size) {
    requestFrame();
  } else {
    frameHandle = 0;
    fallbackHandle = 0;
  }
}

function schedule(spring: Spring): void {
  activeSprings.add(spring);
  if (!frameHandle) {
    lastFrameTime = performance.now();
    requestFrame();
  }
}

type Listener = (value: number, spring: Spring) => void;

export class Spring {
  private current: number;
  private speed = 0;
  private goal: number;
  private token: SpringToken;
  private readonly changeListeners = new Set<Listener>();
  private readonly restListeners = new Set<Listener>();
  /** Distance scale for the rest test, so a spring over pixels and one over 0..1 both settle sensibly. */
  private precision: number;

  constructor(initial: number, token: SpringToken | SpringTokenName = 'panel', precision = 1) {
    this.current = initial;
    this.goal = initial;
    this.token = resolveToken(token);
    this.precision = precision;
  }

  get value(): number {
    return this.current;
  }

  get velocity(): number {
    return this.speed;
  }

  get target(): number {
    return this.goal;
  }

  get moving(): boolean {
    return activeSprings.has(this);
  }

  /** Changes how the spring feels from now on; the motion in flight continues from its current state. */
  setToken(token: SpringToken | SpringTokenName): this {
    this.token = resolveToken(token);
    return this;
  }

  /** Moves the goal; keeps value and velocity (interruptible retarget). */
  set(target: number, token?: SpringToken | SpringTokenName): this {
    if (token) this.setToken(token);
    this.goal = target;
    if (this.current !== target || this.speed !== 0) schedule(this);
    return this;
  }

  /** Teleports to a value with no motion (initial placement, reduced motion). */
  jump(value: number): this {
    this.current = value;
    this.goal = value;
    this.speed = 0;
    activeSprings.delete(this);
    this.emit(this.changeListeners);
    this.emit(this.restListeners);
    return this;
  }

  /** Shifts value and goal together (FLIP: layout moved, keep the visual position). */
  offset(delta: number): this {
    this.current += delta;
    this.emit(this.changeListeners);
    schedule(this);
    return this;
  }

  /** Adds velocity (flings, nudges). */
  impulse(velocity: number): this {
    this.speed += velocity;
    schedule(this);
    return this;
  }

  onChange(listener: Listener): () => void {
    this.changeListeners.add(listener);
    return () => this.changeListeners.delete(listener);
  }

  onRest(listener: Listener): () => void {
    this.restListeners.add(listener);
    return () => this.restListeners.delete(listener);
  }

  stop(): void {
    activeSprings.delete(this);
  }

  /** Called by the shared frame loop. */
  advance(seconds: number): void {
    const { period, damping } = this.token;
    const omega = (2 * Math.PI) / Math.max(0.001, period);
    const displacement = this.current - this.goal;
    const [nextDisplacement, nextVelocity] = solve(displacement, this.speed, omega, damping, seconds);
    this.current = this.goal + nextDisplacement;
    this.speed = nextVelocity;
    const settled = Math.abs(nextDisplacement) < restDistance * this.precision && Math.abs(nextVelocity) < restVelocity * this.precision;
    if (settled) {
      this.current = this.goal;
      this.speed = 0;
      activeSprings.delete(this);
    }
    this.emit(this.changeListeners);
    if (settled) this.emit(this.restListeners);
  }

  private emit(listeners: Set<Listener>): void {
    for (const listener of listeners) listener(this.current, this);
  }
}

/** Exact damped-oscillator step: returns displacement and velocity after `time` seconds. */
function solve(displacement: number, velocity: number, omega: number, damping: number, time: number): [number, number] {
  if (damping < 1) {
    const dampedOmega = omega * Math.sqrt(1 - damping * damping);
    const decay = Math.exp(-damping * omega * time);
    const cosine = Math.cos(dampedOmega * time);
    const sine = Math.sin(dampedOmega * time);
    const first = displacement;
    const second = (velocity + damping * omega * displacement) / dampedOmega;
    const nextDisplacement = decay * (first * cosine + second * sine);
    const nextVelocity = decay * ((second * dampedOmega - damping * omega * first) * cosine - (first * dampedOmega + damping * omega * second) * sine);
    return [nextDisplacement, nextVelocity];
  }
  if (damping === 1) {
    const decay = Math.exp(-omega * time);
    const slope = velocity + omega * displacement;
    return [(displacement + slope * time) * decay, (velocity - omega * slope * time) * decay];
  }
  const root = omega * Math.sqrt(damping * damping - 1);
  const fast = -damping * omega - root;
  const slow = -damping * omega + root;
  const second = (velocity - fast * displacement) / (slow - fast);
  const first = displacement - second;
  const fastDecay = Math.exp(fast * time);
  const slowDecay = Math.exp(slow * time);
  return [first * fastDecay + second * slowDecay, first * fast * fastDecay + second * slow * slowDecay];
}
