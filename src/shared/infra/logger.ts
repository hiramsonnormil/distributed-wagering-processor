/** Log estruturado em JSON. Nunca logar payload financeiro completo. */
type Fields = {
  correlationId?: string;
  messageId?: string;
  transactionId?: string;
  walletId?: string;
  providerId?: string;
  [k: string]: unknown;
};

function write(level: string, msg: string, fields: Fields = {}) {
  process.stdout.write(JSON.stringify({ level, msg, time: new Date().toISOString(), ...fields }) + "\n");
}

export const log = {
  info: (msg: string, f?: Fields) => write("info", msg, f),
  warn: (msg: string, f?: Fields) => write("warn", msg, f),
  error: (msg: string, f?: Fields) => write("error", msg, f),
};
