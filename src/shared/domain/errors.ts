/** Erro de regra de negócio. Nunca deve virar 5xx. */
export class DomainError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class InvalidMoneyError extends DomainError {
  constructor(message: string) {
    super("INVALID_MONEY", message);
  }
}

export class CurrencyMismatchError extends DomainError {
  constructor(expected: string, received: string) {
    super("CURRENCY_MISMATCH", `Moeda esperada ${expected}, recebida ${received}`);
  }
}

export class InsufficientFundsError extends DomainError {
  constructor() {
    super("INSUFFICIENT_FUNDS", "Saldo insuficiente");
  }
}

/** Erro de programação: tentar transicionar algo terminal. */
export class InvalidTransactionStateError extends Error {
  constructor(from: string, to: string) {
    super(`Transição inválida: ${from} -> ${to}`);
    this.name = "InvalidTransactionStateError";
  }
}
