import winston from 'winston';
import path from 'path';

const logDir = path.join(__dirname, '../../logs');

// ANSI colour codes for each service name
const SERVICE_COLORS: Record<string, string> = {
    'Main': '\x1b[97m',  // White
    'PoolScanner': '\x1b[36m',  // Cyan
    'PositionScanner': '\x1b[34m',  // Blue
    'BBEngine': '\x1b[35m',  // Magenta
    'RiskManager': '\x1b[33m',  // Yellow
    'TelegramBot': '\x1b[32m',  // Green
    'RPC': '\x1b[90m',  // Grey
};

const LEVEL_COLORS: Record<string, string> = {
    'ERROR': '\x1b[31m', // Red
    'WARN': '\x1b[33m', // Yellow
    'INFO': '\x1b[32m', // Green
    'DEBUG': '\x1b[90m', // Grey
};

const RESET = '\x1b[0m';
const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';

// Plain-text format for log files (no ANSI)
const fileFormat = winston.format.printf(({ level, message, timestamp, service }) => {
    return `${timestamp} [${service || 'App'}] ${level.toUpperCase()}: ${message}`;
});

// Colourised format for console
const consoleFormat = winston.format.printf(({ level, message, timestamp, service }) => {
    const svc = (service as string) || 'App';
    const lvlUp = level.toUpperCase();
    const svcClr = SERVICE_COLORS[svc] ?? '\x1b[37m';
    const lvlClr = LEVEL_COLORS[lvlUp] ?? '\x1b[37m';

    const ts = `${DIM}${timestamp}${RESET}`;
    const tag = `${BOLD}${svcClr}[${svc}]${RESET}`;
    const lv = `${BOLD}${lvlClr}${lvlUp}${RESET}`;
    const msg = lvlUp === 'ERROR' ? `${lvlClr}${message}${RESET}`
        : lvlUp === 'WARN' ? `${LEVEL_COLORS['WARN']}${message}${RESET}`
            : message;

    return `${ts} ${tag} ${lv}: ${msg}`;
});

const logger = winston.createLogger({
    level: 'info',
    format: winston.format.combine(
        winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
        fileFormat
    ),
    defaultMeta: { service: 'DexInfoBot' },
    transports: [
        // Console (colourised)
        new winston.transports.Console({
            format: winston.format.combine(
                winston.format.timestamp({ format: 'HH:mm:ss' }),
                consoleFormat
            )
        }),
        // Combined log file (plain text)
        new winston.transports.File({
            filename: path.join(logDir, 'combined.log'),
            maxsize: 5 * 1024 * 1024,
            maxFiles: 5
        }),
        // Error-only log file
        new winston.transports.File({
            filename: path.join(logDir, 'error.log'),
            level: 'error',
            maxsize: 5 * 1024 * 1024,
            maxFiles: 3
        })
    ]
});

/**
 * Dedicated logger for position snapshots (append-only history)
 */
export const positionLogger = winston.createLogger({
    level: 'info',
    format: winston.format.combine(
        winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
        winston.format.json()
    ),
    defaultMeta: { service: 'PositionSnapshot' },
    transports: [
        new winston.transports.File({
            filename: path.join(logDir, 'positions.log'),
            maxsize: 10 * 1024 * 1024,
            maxFiles: 10
        })
    ]
});

/**
 * Create a child logger with a specific service label
 */
export function createServiceLogger(serviceName: string) {
    const childLogger = logger.child({ service: serviceName });
    const extendedLogger = Object.assign(childLogger, {
        dev: (msg: string) => {
            // Force info level with a distinct DEV prefix so it shows up in console
            childLogger.info(`🛠️ [DEV] ${msg}`);
        }
    });
    return extendedLogger;
}

export default logger;
