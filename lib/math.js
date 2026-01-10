exports.clamp = function clamp (min, x, max) {
  return Math.max(min, Math.min(x, max))
}

const f32 = Math.fround

// f32 binary statement ops: assume a, b are f32
function f32add (a, b) {
  return Math.fround(a + b)
}

function f32mul (a, b) {
  return Math.fround(a * b)
}

// Java Minecraft uses these exact constants for sin/cos lookup
const SIN_SCALE = 10430.378350470453
const COS_OFFSET = 16384.0

const SIN_TABLE = new Float32Array(65536)

for (let i = 0; i < 65536; i++) {
  // Java: SIN[i] = (float)Math.sin((double)i / 10430.378350470453)
  SIN_TABLE[i] = Math.fround(Math.sin(i / SIN_SCALE))
}

function f32sin (x) {
  // Java: return SIN[(int)((long)(var0 * 10430.378350470453) & 65535L)]
  return SIN_TABLE[(x * SIN_SCALE | 0) & 65535]
}

function f32cos (x) {
  // Java: return SIN[(int)((long)(var0 * 10430.378350470453 + 16384.0) & 65535L)]
  return SIN_TABLE[(x * SIN_SCALE + COS_OFFSET | 0) & 65535]
}

exports.f32 = f32
exports.f32add = f32add
exports.f32mul = f32mul
exports.f32sin = f32sin
exports.f32cos = f32cos
