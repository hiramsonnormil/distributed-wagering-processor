import Decimal from "decimal.js";
import { CurrencyMismatchError, InvalidMoneyError } from "./errors";

export interface MoneyProps {
  amount: string; // decimal string, ex.: "25.00"
  currency: string; // ISO-4217
}

const SCALE = 2;
// Apenas dígitos, com no máximo 2 casas decimais. Rejeita sinal, notação científica, NaN, Infinity.
const AMOUNT_INPUT = /^\d+(\.\d{1,2})?$/;
const CURRENCY = /^[A-Z]{3}$/;

/** Valor monetário imutável. Nunca usa number/float internamente. */
export class Money {
  private constructor(
    private readonly value: Decimal,
    public readonly currency: string,
  ) {}

  /** Entrada de contrato (API/fila): só aceita valores não negativos e bem formados. */
  static from(props: MoneyProps): Money {
    if (typeof props?.amount !== "string" || !AMOUNT_INPUT.test(props.amount)) {
      throw new InvalidMoneyError(`amount inválido: ${String(props?.amount)}`);
    }
    return new Money(new Decimal(props.amount), Money.assertCurrency(props.currency));
  }

  /** Reidratação a partir do banco (NUMERIC(20,2)); aceita qualquer decimal exato. */
  static fromPersistence(amount: string, currency: string): Money {
    const value = new Decimal(amount);
    if (!value.isFinite() || value.decimalPlaces() > SCALE) {
      throw new InvalidMoneyError(`valor persistido inválido: ${amount}`);
    }
    return new Money(value, Money.assertCurrency(currency));
  }

  static zero(currency: string): Money {
    return new Money(new Decimal(0), Money.assertCurrency(currency));
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.value.plus(other.value), this.currency);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.value.minus(other.value), this.currency);
  }

  negate(): Money {
    return new Money(this.value.negated(), this.currency);
  }

  isZero(): boolean {
    return this.value.isZero();
  }
  isPositive(): boolean {
    return this.value.greaterThan(0);
  }
  isNegative(): boolean {
    return this.value.lessThan(0);
  }
  isLessThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.value.lessThan(other.value);
  }
  equals(other: Money): boolean {
    return this.currency === other.currency && this.value.equals(other.value);
  }

  toJSON(): MoneyProps {
    return { amount: this.toString(), currency: this.currency };
  }

  /** Sempre com escala fixa de 2 casas. "-0.00" nunca é emitido. */
  toString(): string {
    const fixed = this.value.toFixed(SCALE);
    return fixed === "-0.00" ? "0.00" : fixed;
  }

  private assertSameCurrency(other: Money): void {
    if (other.currency !== this.currency) {
      throw new CurrencyMismatchError(this.currency, other.currency);
    }
  }

  private static assertCurrency(currency: string): string {
    if (typeof currency !== "string" || !CURRENCY.test(currency)) {
      throw new InvalidMoneyError(`currency inválida: ${String(currency)}`);
    }
    return currency;
  }
}
