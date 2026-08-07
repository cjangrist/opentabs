/**
 * DeepSeek's "DeepSeekHashV1" proof-of-work hash.
 *
 * chat.deepseek.com gates POST /api/v0/chat/completion and /api/v0/file/upload_file
 * behind a proof of work: the server hands out a target digest and the client must
 * find the integer whose hash matches it.
 *
 * The hash is *almost* SHA3-256 — same rate, same 0x06 padding, same round
 * constants — except the Keccak-f permutation runs rounds 1..23 instead of 0..23.
 * Skipping round zero makes every digest differ from stock SHA3-256, so a standard
 * crypto library cannot be substituted here. This port mirrors the arithmetic of
 * DeepSeek's own worker bundle (static/76608.*.js) word for word, including its
 * reliance on JavaScript's mod-32 shift semantics for rotations of 32 or more.
 *
 * State layout matches that bundle: 25 lanes stored as [high, low] 32-bit pairs.
 *
 * `noUncheckedIndexedAccess` types every typed-array read as possibly undefined,
 * which it never is for the fixed in-range indices used here, so biome.json turns
 * off `noNonNullAssertion` for this file rather than adding branches to a hot loop.
 */

const RATE_BYTES = 136;
const DIGEST_BYTES = 32;
const FIRST_ROUND = 1;

/** Standard Keccak round constants, stored as [high, low] 32-bit pairs. */
const ROUND_CONSTANTS = new Uint32Array([
  0x00000000, 0x00000001, 0x00000000, 0x00008082, 0x80000000, 0x0000808a, 0x80000000, 0x80008000, 0x00000000,
  0x0000808b, 0x00000000, 0x80000001, 0x80000000, 0x80008081, 0x80000000, 0x00008009, 0x00000000, 0x0000008a,
  0x00000000, 0x00000088, 0x00000000, 0x80008009, 0x00000000, 0x8000000a, 0x00000000, 0x8000808b, 0x80000000,
  0x0000008b, 0x80000000, 0x00008089, 0x80000000, 0x00008003, 0x80000000, 0x00008002, 0x80000000, 0x00000080,
  0x00000000, 0x0000800a, 0x80000000, 0x8000000a, 0x80000000, 0x80008081, 0x80000000, 0x00008080, 0x00000000,
  0x80000001, 0x80000000, 0x80008008,
]);

const ROTATION_OFFSETS = [1, 3, 6, 10, 15, 21, 28, 36, 45, 55, 2, 14, 27, 41, 56, 8, 25, 43, 62, 18, 39, 61, 20, 44];
const PI_LANES = [10, 7, 11, 17, 18, 3, 5, 16, 8, 21, 24, 4, 15, 23, 19, 13, 12, 2, 20, 14, 22, 9, 6, 1];

const HEX_DIGITS = '0123456789abcdef';

const permute = (state: Uint32Array, parity: Uint32Array, delta: Uint32Array, work: Uint32Array): void => {
  for (let round = FIRST_ROUND; round < 24; round++) {
    // Theta.
    for (let x = 0; x < 5; x++) {
      const base = 2 * x;
      parity[base] =
        state[base]! ^ state[(x + 5) * 2]! ^ state[(x + 10) * 2]! ^ state[(x + 15) * 2]! ^ state[(x + 20) * 2]!;
      parity[base + 1] =
        state[base + 1]! ^
        state[(x + 5) * 2 + 1]! ^
        state[(x + 10) * 2 + 1]! ^
        state[(x + 15) * 2 + 1]! ^
        state[(x + 20) * 2 + 1]!;
    }
    for (let x = 0; x < 5; x++) {
      const next = ((x + 1) % 5) * 2;
      const high = parity[next]!;
      const low = parity[next + 1]!;
      const rotatedHigh = ((high << 1) | (low >>> 31)) >>> 0;
      const rotatedLow = ((low << 1) | (high >>> 31)) >>> 0;
      const previous = ((x + 4) % 5) * 2;
      delta[2 * x] = parity[previous]! ^ rotatedHigh;
      delta[2 * x + 1] = parity[previous + 1]! ^ rotatedLow;
      for (let y = 0; y < 25; y += 5) {
        state[(y + x) * 2] = state[(y + x) * 2]! ^ delta[2 * x]!;
        state[(y + x) * 2 + 1] = state[(y + x) * 2 + 1]! ^ delta[2 * x + 1]!;
      }
    }

    // Rho and pi, carried through a single lane register.
    work[0] = state[2]!;
    work[1] = state[3]!;
    for (let step = 0; step < 24; step++) {
      const lane = PI_LANES[step]!;
      const shift = ROTATION_OFFSETS[step]!;
      const savedHigh = state[2 * lane]!;
      const savedLow = state[2 * lane + 1]!;
      const high = work[0]!;
      const low = work[1]!;
      // JavaScript reduces shift counts mod 32, which is exactly how the reference
      // bundle handles rotations of 32 or more — the lane halves swap instead.
      const counter = 32 - shift;
      const target = shift < 32 ? 0 : 1;
      work[target] = ((high << shift) | (low >>> counter)) >>> 0;
      work[(target + 1) % 2] = ((low << shift) | (high >>> counter)) >>> 0;
      state[2 * lane] = work[0]!;
      state[2 * lane + 1] = work[1]!;
      work[0] = savedHigh;
      work[1] = savedLow;
    }

    // Chi.
    for (let y = 0; y < 25; y += 5) {
      for (let x = 0; x < 5; x++) {
        parity[2 * x] = state[(y + x) * 2]!;
        parity[2 * x + 1] = state[(y + x) * 2 + 1]!;
      }
      for (let x = 0; x < 5; x++) {
        const index = (y + x) * 2;
        const first = ((x + 1) % 5) * 2;
        const second = ((x + 2) % 5) * 2;
        state[index] = state[index]! ^ (~parity[first]! & parity[second]!);
        state[index + 1] = state[index + 1]! ^ (~parity[first + 1]! & parity[second + 1]!);
      }
    }

    // Iota.
    state[0] = state[0]! ^ ROUND_CONSTANTS[2 * round]!;
    state[1] = state[1]! ^ ROUND_CONSTANTS[2 * round + 1]!;
  }
};

const absorbBlock = (block: Uint8Array, state: Uint32Array): void => {
  for (let offset = 0; offset < RATE_BYTES; offset += 8) {
    const lane = offset / 4;
    state[lane] =
      state[lane]! ^
      ((block[offset + 7]! << 24) | (block[offset + 6]! << 16) | (block[offset + 5]! << 8) | block[offset + 4]!);
    state[lane + 1] =
      state[lane + 1]! ^
      ((block[offset + 3]! << 24) | (block[offset + 2]! << 16) | (block[offset + 1]! << 8) | block[offset]!);
  }
};

const digestToHex = (state: Uint32Array): string => {
  let hex = '';
  for (let byteIndex = 0; byteIndex < DIGEST_BYTES; byteIndex += 8) {
    const lane = byteIndex / 4;
    const low = state[lane + 1]!;
    const high = state[lane]!;
    for (const word of [low, high]) {
      for (let shift = 0; shift < 32; shift += 8) {
        const byte = (word >>> shift) & 0xff;
        hex += HEX_DIGITS[byte >>> 4]! + HEX_DIGITS[byte & 0x0f]!;
      }
    }
  }
  return hex;
};

/**
 * Hashes a message that fits in a single Keccak block. Every proof-of-work probe
 * is well under the 136-byte rate, so the multi-block absorb path is unnecessary.
 */
const hashSingleBlock = (
  message: Uint8Array,
  block: Uint8Array,
  state: Uint32Array,
  parity: Uint32Array,
  delta: Uint32Array,
  work: Uint32Array,
): string => {
  block.fill(0);
  block.set(message);
  block[message.length] = 0x06;
  block[RATE_BYTES - 1] = block[RATE_BYTES - 1]! | 0x80;

  state.fill(0);
  absorbBlock(block, state);
  permute(state, parity, delta, work);
  return digestToHex(state);
};

export interface PowChallenge {
  algorithm: string;
  challenge: string;
  salt: string;
  signature: string;
  difficulty: number;
  expire_at: number;
  target_path: string;
}

/** Digest of an arbitrary short string under DeepSeek's hash — exported for self-tests. */
export const deepSeekHash = (message: string): string => {
  const encoded = new TextEncoder().encode(message);
  if (encoded.length > RATE_BYTES - 1) throw new Error('deepSeekHash: message exceeds one Keccak block');
  return hashSingleBlock(
    encoded,
    new Uint8Array(RATE_BYTES),
    new Uint32Array(50),
    new Uint32Array(10),
    new Uint32Array(10),
    new Uint32Array(2),
  );
};

/**
 * Finds the smallest integer whose hash of `"<salt>_<expire_at>_<n>"` equals the
 * server's target digest. Returns null when no answer exists below `difficulty`.
 */
export const solvePowChallenge = (challenge: PowChallenge): number | null => {
  if (challenge.algorithm !== 'DeepSeekHashV1') {
    throw new Error(`Unsupported DeepSeek PoW algorithm: ${challenge.algorithm}`);
  }

  const prefix = `${challenge.salt}_${challenge.expire_at}_`;
  const prefixBytes = new TextEncoder().encode(prefix);

  const block = new Uint8Array(RATE_BYTES);
  const message = new Uint8Array(RATE_BYTES);
  const state = new Uint32Array(50);
  const parity = new Uint32Array(10);
  const delta = new Uint32Array(10);
  const work = new Uint32Array(2);
  const digits = new Uint8Array(12);

  message.set(prefixBytes);

  for (let candidate = 0; candidate < challenge.difficulty; candidate++) {
    // Writing the decimal digits straight into the probe buffer keeps the hot loop
    // allocation-free; the candidate is always a non-negative integer.
    let digitCount = 0;
    let remaining = candidate;
    do {
      digits[digitCount++] = 0x30 + (remaining % 10);
      remaining = Math.floor(remaining / 10);
    } while (remaining > 0);
    for (let index = 0; index < digitCount; index++) {
      message[prefixBytes.length + index] = digits[digitCount - 1 - index]!;
    }

    const length = prefixBytes.length + digitCount;
    if (hashSingleBlock(message.subarray(0, length), block, state, parity, delta, work) === challenge.challenge) {
      return candidate;
    }
  }

  return null;
};

/** Builds the `X-DS-PoW-Response` header value: base64 of the solved challenge. */
export const encodePowHeader = (challenge: PowChallenge, answer: number): string =>
  btoa(
    JSON.stringify({
      algorithm: challenge.algorithm,
      challenge: challenge.challenge,
      salt: challenge.salt,
      answer,
      signature: challenge.signature,
      target_path: challenge.target_path,
    }),
  );
