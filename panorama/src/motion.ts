// One rAF loop drives every spring in the app. Springs integrate on real elapsed
// time, so motion looks identical at 60, 144 or 240 Hz and retargeting mid-flight
// (holding a direction) stays continuous instead of restarting an easing curve.
import { settings } from "./settings";

export class Spring {
  value: number;
  target: number;
  private v = 0;
  private active = false;

  constructor(
    initial: number,
    private apply: (x: number) => void,
    private stiffness = 260,
    private damping = 30,
  ) {
    this.value = this.target = initial;
    apply(initial);
  }

  to(target: number): void {
    this.target = target;
    if (settings().reducedMotion) {
      this.snap(target);
      return;
    }
    if (!this.active && Math.abs(target - this.value) > 0.01) {
      this.active = true;
      springs.add(this);
      kick();
    }
  }

  snap(x: number): void {
    this.value = this.target = x;
    this.v = 0;
    this.active = false;
    springs.delete(this);
    this.apply(x);
  }

  /** Returns false once settled. */
  step(dt: number): boolean {
    // Semi-implicit Euler in 4 ms sub-steps: stable for any frame time.
    let remaining = dt;
    while (remaining > 0) {
      const h = Math.min(remaining, 0.004);
      const a = this.stiffness * (this.target - this.value) - this.damping * this.v;
      this.v += a * h;
      this.value += this.v * h;
      remaining -= h;
    }
    if (Math.abs(this.v) < 0.5 && Math.abs(this.target - this.value) < 0.25) {
      this.value = this.target;
      this.v = 0;
      this.active = false;
      this.apply(this.value);
      return false;
    }
    this.apply(this.value);
    return true;
  }
}

const springs = new Set<Spring>();
let running = false;
let last = 0;

function kick() {
  if (running) return;
  running = true;
  last = performance.now();
  requestAnimationFrame(frame);
}

function frame(now: number) {
  // Clamp so a stalled tab doesn't fling everything on resume.
  const dt = Math.min((now - last) / 1000, 1 / 20);
  last = now;
  for (const s of springs) if (!s.step(dt)) springs.delete(s);
  if (springs.size) requestAnimationFrame(frame);
  else running = false;
}

/** Runs a FLIP transition: call after the element has moved to its final layout. */
export function flip(el: HTMLElement, from: DOMRect, ms = 420): void {
  if (settings().reducedMotion) return;
  const to = el.getBoundingClientRect();
  if (!to.width || !to.height) return;
  const sx = from.width / to.width;
  const sy = from.height / to.height;
  el.animate(
    [
      { transformOrigin: "0 0", transform: `translate(${from.left - to.left}px, ${from.top - to.top}px) scale(${sx}, ${sy})` },
      { transformOrigin: "0 0", transform: "none" },
    ],
    { duration: ms, easing: "cubic-bezier(.2,.8,.2,1)" },
  );
}
