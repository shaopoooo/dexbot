import winston from 'winston';
import path from 'path';

const logDir = path.join(__dirname, '../../logs');

// ANSI colour codes for each service name
const SERVICE_COLORS: Record<string, string> = {
    'Main':            '\x1b[97m',  // White
    'PoolScanner':     '\x1b[36m',  // Cyan
    'BBEngine':        '\x1b[35m',  // Magenta
    'PositionScanner': '\x1b[34m',  // Blue
    'RiskManager':     '\x1b[33m',  // Yellow
    'TelegramBot':     '\x1b[32m',  // Green
    'RPC':             '\x1b[90m',  // Grey
};

const LEVEL_COLORS: Record<string, string> = {
    'ERROR': '\x1b[31m', // Red
    'WARN':  '\x1b[33m', // Yellow
    'INFO':  '\x1b[32m', // Green
    'DEBUG': '\x1b[90m', // Grey
};

const LEVEL_ICONS: Record<string, string> = {
    'ERROR': '✖',
    'WARN':  '!',
    'INFO':  '·',
    'DEBUG': '…',
};

const RESET = '\x1b[0m';
const DIM   = '\x1b[2m';
const BOLD  = '\x1b[1m';

// Plain-text format for log files (no ANSI)
const fileFormat = winston.format.printf(({ level, message, timestamp, service }) => {
    return `${timestamp} [${service || 'App'}] ${level.toUpperCase()}: ${message}`;
});

// Colourised format for console
const consoleFormat = winston.format.printf(({ level, message, timestamp, service }) => {
    const svc   = (service as string) || 'App';
    const lvlUp = level.toUpperCase();
    const svcClr = SERVICE_COLORS[svc] ?? '\x1b[37m';
    const lvlClr = LEVEL_COLORS[lvlUp] ?? '\x1b[37m';
    const icon   = LEVEL_ICONS[lvlUp]  ?? '·';

    const ts  = `${DIM}${timestamp}${RESET}`;
    const tag = `${BOLD}${svcClr}[${svc}]${RESET}`;
    const lv  = `${lvlClr}${icon}${RESET}`;

    // ERROR / WARN: colour entire message; INFO: apply service colour; DEBUG: dim
    const msg = lvlUp === 'ERROR' ? `${BOLD}${lvlClr}${message}${RESET}`
              : lvlUp === 'WARN'  ? `${lvlClr}${message}${RESET}`
              : lvlUp === 'DEBUG' ? `${DIM}${message}${RESET}`
              :                     `${svcClr}${message}${RESET}`;

    return `${ts} ${tag} ${lv} ${msg}`;
});

const logger = winston.createLogger({
    level: 'info',
    format: winston.format.combine(
        winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
        fileFormat
    ),
    defaultMeta: { service: 'DexInfoBot' },
    transports: [
        new winston.transports.Console({
            format: winston.format.combine(
                winston.format.timestamp({ format: 'HH:mm:ss' }),
                consoleFormat
            )
        }),
        new winston.transports.File({
            filename: path.join(logDir, 'combined.log'),
            maxsize: 5 * 1024 * 1024,
            maxFiles: 5
        }),
        new winston.transports.File({
            filename: path.join(logDir, 'error.log'),
            level: 'error',
            maxsize: 5 * 1024 * 1024,
            maxFiles: 3
        })
    ]
});

/**
 * Dedicated logger for position snapshots (append-only history).
 * Outputs raw pre-formatted text — no timestamp prefix added here.
 */
export const positionLogger = winston.createLogger({
    level: 'info',
    format: winston.format.printf(({ message }) => String(message)),
    transports: [
        new winston.transports.File({
            filename: path.join(logDir, 'positions.log'),
            maxsize: 10 * 1024 * 1024,
            maxFiles: 10
        })
    ]
});

/**
 * Create a child logger with a specific service label.
 * Extra methods:
 *   .section(title) — prints a visual separator line
 *   .dev(msg)       — force-info with [DEV] prefix
 */
export function createServiceLogger(serviceName: string) {
    const child = logger.child({ service: serviceName });
    return Object.assign(child, {
        dev: (msg: string) => child.info(`[DEV] ${msg}`),
        section: (title: string) => {
            const line = '─'.repeat(Math.max(0, 42 - title.length));
            child.info(`${line} ${title} ${line}`);
        },
    });
}

export default logger;
