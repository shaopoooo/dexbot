/**
 * Fixed-point BigInt math utility to replace decimal.js
 */

/** Convert a Uniswap V3 tick to a human-readable price ratio, adjusted for token decimals. */
export function tickToPrice(tick: number, dec0: number, dec1: number): number {
    return Math.pow(1.0001, tick) * Math.pow(10, dec0 - dec1);
}

export const Q96 = 2n ** 96n;
export const PRECISION = 10n ** 18n;

export class BigMath {
    /**
     * Multiply x and y where both are precision-scaled BigInts.
     * e.g., (x_prec * y_prec) / PRECISION = (x * y)_prec
     */
    static mulDiv(x: bigint, y: bigint, denominator: bigint): bigint {
        return (x * y) / denominator;
    }

    /**
     * Calculate square root of a BigInt.
     */
    static sqrt(value: bigint): bigint {
        if (value < 0n) throw new Error('Cannot compute square root of a negative BigInt');
        if (value === 0n) return 0n;
        if (value <= 3n) return 1n;

        let x0 = value / 2n;
        let x1 = (x0 + value / x0) / 2n;
        while (x1 < x0) {
            x0 = x1;
            x1 = (x0 + value / x0) / 2n;
        }
        return x0;
    }

    // Common conversions
    static toBigInt(value: string | number, decimals: number = 18): bigint {
        const [intPart, fracPart = ''] = value.toString().split('.');
        let fracStr = fracPart.slice(0, decimals);
        fracStr = fracStr.padEnd(decimals, '0');
        return BigInt(`${intPart}${fracStr}`);
    }

    static formatBigInt(value: bigint, decimals: number = 18): string {
        const isNegative = value < 0n;
        let absStr = (isNegative ? -value : value).toString().padStart(decimals + 1, '0');
        const intPart = absStr.slice(0, absStr.length - decimals);
        let fracPart = absStr.slice(absStr.length - decimals);
        // Remove trailing zeros
        fracPart = fracPart.replace(/0+$/, '');
        return `${isNegative ? '-' : ''}${intPart}${fracPart.length > 0 ? '.' + fracPart : ''}`;
    }
}
