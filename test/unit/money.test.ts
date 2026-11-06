import { describe, expect, it } from "bun:test";
import { CurrencyMismatchError, InvalidMoneyError } from "../../src/shared/domain/errors";
import { Money } from "../../src/shared/domain/money";

const brl = (amount: string) => Money.from({ amount, currency: "BRL" });

describe("Money", () => {
  it("serializa sempre com 2 casas", () => {
    expect(brl("25").toString()).toBe("25.00");
    expect(brl("25.5").toJSON()).toEqual({ amount: "25.50", currency: "BRL" });
  });

  it("é exato (sem erro de ponto flutuante)", () => {
    expect(brl("0.10").add(brl("0.20")).toString()).toBe("0.30");
    expect(brl("100.00").subtract(brl("80.00")).toString()).toBe("20.00");
  });

  it("é imutável", () => {
    const a = brl("10.00");
    a.add(brl("5.00"));
    expect(a.toString()).toBe("10.00");
  });

  it.each(["NaN", "Infinity", "1e3", "", "1.234", "-5.00", " 1.00", "1,00", "abc"])(
    "rejeita entrada inválida %p",
    (amount) => {
      expect(() => brl(amount)).toThrow(InvalidMoneyError);
    },
  );

  it("rejeita amount que não é string", () => {
    expect(() => Money.from({ amount: 10 as unknown as string, currency: "BRL" })).toThrow(InvalidMoneyError);
  });

  it("rejeita moeda inválida", () => {
    expect(() => Money.from({ amount: "1.00", currency: "real" })).toThrow(InvalidMoneyError);
  });

  it("lança erro em operações entre moedas diferentes", () => {
    const usd = Money.from({ amount: "1.00", currency: "USD" });
    expect(() => brl("1.00").add(usd)).toThrow(CurrencyMismatchError);
    expect(() => brl("1.00").isLessThan(usd)).toThrow(CurrencyMismatchError);
  });

  it("negate e comparações", () => {
    expect(brl("5.00").negate().isNegative()).toBe(true);
    expect(Money.zero("BRL").isZero()).toBe(true);
    expect(brl("0.00").negate().toString()).toBe("0.00");
    expect(brl("1.00").isLessThan(brl("2.00"))).toBe(true);
    expect(brl("1.0").equals(brl("1.00"))).toBe(true);
  });
});
