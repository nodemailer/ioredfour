// Seeded randomness for the fuzz and stress tests. FUZZ_SEED picks the seed and FUZZ_ITERATIONS
// scales the number of generated cases. The default seed is fixed so that CI runs are
// reproducible; a failing assertion names the seed, so `FUZZ_SEED=<seed> npm test` replays a run.

export const FUZZ_SEED = Number(process.env.FUZZ_SEED) || 20261019;
export const FUZZ_ITERATIONS = Number(process.env.FUZZ_ITERATIONS) || 300;

export interface Random {
    /** integer in [min, max] */
    int(min: number, max: number): number;
    pick<T>(items: readonly T[]): T;
    chance(probability: number): boolean;
}

// mulberry32, a small seeded PRNG. Not for anything but reproducible test input.
export function createRandom(seed: number = FUZZ_SEED): Random {
    let state = seed >>> 0; // eslint-disable-line no-bitwise
    /* eslint-disable no-bitwise */
    const next = () => {
        state = (state + 0x6d2b79f5) >>> 0;
        let t = state;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    /* eslint-enable no-bitwise */
    const int = (min: number, max: number) => min + Math.floor(next() * (max - min + 1));
    return {
        int,
        pick: items => items[int(0, items.length - 1)] as (typeof items)[number],
        chance: probability => next() < probability
    };
}
