import { describe, expect, it } from "vitest";

import { customerPhoneInputValue, normalizeCustomerPhone } from "./utils";

/**
 * Customer phone fields take an Indian mobile OR an international number
 * (client, 13 Oct — the business has foreign customers). These pin the two
 * rules the forms rely on: an Indian number still normalises to its canonical
 * 10 digits, and an international number must be typed with a leading `+` so a
 * half-typed Indian mobile can never pass as a foreign one.
 */
describe("normalizeCustomerPhone", () => {
  it("keeps the canonical 10-digit form for Indian numbers", () => {
    expect(normalizeCustomerPhone("9876500000")).toBe("9876500000");
    expect(normalizeCustomerPhone("+91 98765-00000")).toBe("9876500000");
  });

  it("accepts an international number and canonicalises to +digits", () => {
    expect(normalizeCustomerPhone("+971 55 123 4567")).toBe("+971551234567");
    expect(normalizeCustomerPhone("+44 (20) 7946-0958")).toBe("+442079460958");
  });

  it("REJECTS a non-Indian number without the +, so a truncated Indian mobile cannot pass", () => {
    expect(normalizeCustomerPhone("98765432")).toBeNull();
    expect(normalizeCustomerPhone("971551234567")).toBeNull();
  });

  it("REJECTS letters, symbols, and out-of-range lengths", () => {
    expect(normalizeCustomerPhone("+971a55123456")).toBeNull();
    expect(normalizeCustomerPhone("+1234567")).toBeNull();
    expect(normalizeCustomerPhone("+1234567890123456")).toBeNull();
    expect(normalizeCustomerPhone("")).toBeNull();
  });
});

describe("customerPhoneInputValue", () => {
  it("behaves like the Indian box until a + is typed", () => {
    expect(customerPhoneInputValue("98765000001")).toBe("9876500000");
    expect(customerPhoneInputValue("098765")).toBe("98765");
  });

  it("keeps the + and caps at the 15-digit E.164 ceiling", () => {
    expect(customerPhoneInputValue("+971 55 123 4567")).toBe("+971551234567");
    expect(customerPhoneInputValue("+1234567890123456789")).toBe("+123456789012345");
  });
});
