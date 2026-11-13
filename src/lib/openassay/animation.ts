type Particle = {
  x: number;
  y: number;
  z: number;
  size: number;
  warm: boolean;
  opacity: number;
  delay: number;
  burstRadius: number;
  swirl: number;
  trail: boolean;
};

export const SNAP_TIME = 1.12;
export const ORBIT_TIME = 3.1;
const TAU = Math.PI * 2;
const clamp = (value: number) => Math.max(0, Math.min(1, value));
const smooth = (value: number) => {
  const t = clamp(value);
  return t * t * (3 - 2 * t);
};

// The three arms meet at exactly the same junction as the original symbol.
const SHARDS = [
  { from: [18, 50], to: [59, 50], offset: [-1.08, 0], rotation: -0.42 },
  { from: [59, 50], to: [81, 12], offset: [0.7, -0.86], rotation: 0.62 },
  { from: [59, 50], to: [81, 88], offset: [0.7, 0.86], rotation: -0.62 },
];

export function createResearchAnimation() {
  let seed = 4127;
  const random = () => {
    seed = (seed * 16807) % 2147483647;
    return (seed - 1) / 2147483646;
  };
  const particles: Particle[] = [];
  for (let index = 0; index < 2200; index++) {
    const theta = random() * TAU;
    const ring = Math.floor(random() * 9);
    const tilt = (ring / 9 - 0.5) * 2.6;
    const radius = 0.64 + random() * 0.28;
    const spread = (random() - 0.5) * 0.028;
    const y = Math.sin(theta) * radius;
    particles.push({
      x: Math.cos(theta) * radius,
      y: y * Math.cos(tilt) + spread,
      z: y * Math.sin(tilt) + spread,
      size: random() < 0.965 ? 0.45 + random() * 0.5 : 1.2,
      warm: random() > 0.28,
      opacity: 0.3 + random() * 0.7,
      delay: random() * 0.12,
      burstRadius: 0.95 + random() * 0.55,
      swirl: (random() - 0.5) * 1.1,
      trail: index % 6 === 0,
    });
  }

  return function draw(
    context: CanvasRenderingContext2D,
    width: number,
    height: number,
    elapsed: number,
    pointerX = 0,
    pointerY = 0
  ) {
    context.clearRect(0, 0, width, height);
    const cx = width / 2;
    const cy = height / 2;
    const scale = Math.min(width * 0.49, height * 0.46);
    const impactTime = elapsed - SNAP_TIME;

    // A single shock wave marks the collision; it does not repeat in orbit.
    if (impactTime >= 0 && impactTime < 0.65) {
      const progress = impactTime / 0.65;
      const radius = 8 + (1 - Math.pow(1 - progress, 3)) * scale * 1.3;
      context.save();
      context.translate(cx, cy);
      context.scale(1, 0.74);
      context.strokeStyle = `rgba(255,140,84,${Math.pow(1 - progress, 2) * 0.45})`;
      context.lineWidth = 1;
      context.beginPath();
      context.arc(0, 0, radius, 0, TAU);
      context.stroke();
      context.restore();
    }

    if (impactTime >= 0) {
      const orbitTime = Math.max(0, elapsed - SNAP_TIME);
      const angle = 0.0325 + orbitTime * 0.035 + pointerX * 0.04;
      const tilt = -0.38 + pointerY * 0.04;
      const rotation = -0.42;
      const projected = particles
        .map((particle) => {
          const x = particle.x * Math.cos(angle) + particle.z * Math.sin(angle);
          const z = -particle.x * Math.sin(angle) + particle.z * Math.cos(angle);
          const y = particle.y * Math.cos(tilt) - z * Math.sin(tilt);
          const depth = particle.y * Math.sin(tilt) + z * Math.cos(tilt);
          const perspective = 2.8 / (2.8 - depth * 0.32);
          return {
            particle,
            x: (x * Math.cos(rotation) - y * Math.sin(rotation)) * scale * perspective,
            y: (x * Math.sin(rotation) + y * Math.cos(rotation)) * scale * perspective,
            depth,
          };
        })
        .sort((a, b) => a.depth - b.depth);

      for (const point of projected) {
        const particle = point.particle;
        const age = impactTime - particle.delay;
        if (age < 0) continue;
        const settle = smooth((age - 0.3) / (ORBIT_TIME - SNAP_TIME - 0.42));
        const expansion = 1 - Math.exp(-age * 8.5);
        const direction = Math.atan2(point.y, point.x) + particle.swirl * (1 - settle);
        const burstRadius = scale * particle.burstRadius * expansion;
        const burstX = Math.cos(direction) * burstRadius;
        const burstY = Math.sin(direction) * burstRadius * 0.74;
        const x = cx + burstX * (1 - settle) + point.x * settle;
        const y = cy + burstY * (1 - settle) + point.y * settle;
        const alpha =
          Math.max(0.08, (0.36 + point.depth * 0.32) * particle.opacity) *
          smooth(age / 0.075) *
          (1 + (1 - settle) * 0.8);
        const color = particle.warm ? `255,${125 + Math.round(point.depth * 24)},64` : '216,216,216';

        if (particle.trail && age < 0.65) {
          const length = (1 - settle) * Math.exp(-age * 2.5) * scale * 0.055;
          context.strokeStyle = `rgba(${color},${alpha * 0.35})`;
          context.lineWidth = 0.7;
          context.beginPath();
          context.moveTo(x - Math.cos(direction) * length, y - Math.sin(direction) * length * 0.74);
          context.lineTo(x, y);
          context.stroke();
        }
        context.fillStyle = `rgba(${color},${alpha * (particle.warm ? 1 : 0.65)})`;
        context.beginPath();
        context.arc(x, y, particle.size * (1 + point.depth * 0.25), 0, TAU);
        context.fill();
      }
    }

    // Three separate pieces accelerate into place, then rebound as one mark.
    const convergence = clamp((elapsed - 0.28) / (SNAP_TIME - 0.28));
    const separation = 1 - Math.pow(convergence, 4);
    const fade = smooth(elapsed / 0.2);
    const rebound =
      impactTime >= 0 && impactTime < 0.6 ? 1 - 0.12 * Math.exp(-impactTime * 9) * Math.cos(impactTime * 24) : 1;
    const logoScale = width < 440 ? 0.54 : 0.64;
    context.save();
    context.translate(cx, cy);
    context.scale(rebound, rebound);
    context.lineCap = 'round';
    context.lineJoin = 'round';
    context.strokeStyle = `rgba(255,122,54,${fade})`;
    context.lineWidth = 8;
    for (const shard of SHARDS) {
      const middleX = (shard.from[0] + shard.to[0]) / 2;
      const middleY = (shard.from[1] + shard.to[1]) / 2;
      context.save();
      context.translate(
        shard.offset[0] * scale * separation + (middleX - 50) * logoScale,
        shard.offset[1] * scale * separation + (middleY - 50) * logoScale
      );
      context.rotate(shard.rotation * separation);
      context.scale(logoScale, logoScale);
      context.beginPath();
      context.moveTo(shard.from[0] - middleX, shard.from[1] - middleY);
      context.lineTo(shard.to[0] - middleX, shard.to[1] - middleY);
      context.stroke();
      context.restore();
    }
    context.restore();
  };
}
