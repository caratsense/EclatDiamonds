import { describe, expect, it } from "vitest";

import { departmentsIn, guessStore, parseCsv } from "./ezattendance-import-dialog";

describe("EzAttendance import helpers", () => {
  it("parses quoted CSV cells", () => {
    expect(parseCsv('a,"b, c","d ""x"""\r\n1,2,3')).toEqual([
      ["a", "b, c", 'd "x"'],
      ["1", "2", "3"],
    ]);
  });

  it("finds departments below title rows, case-insensitively grouped", () => {
    const csv = "﻿Employee Master\nCODE,NAME,DEPARTMENT\nED1,A,BANDRA\nED2,B,Bandra\nED3,C,Kala Ghoda\nED4,D,\n";
    expect(departmentsIn(csv)).toEqual(["BANDRA", "Kala Ghoda"]);
  });

  it("guesses the store by name, else none", () => {
    const stores = [
      { id: "s1", name: "Eclat Bandra", city: "Mumbai" },
      { id: "s2", name: "Kala Ghoda Flagship", city: "Mumbai" },
    ];
    expect(guessStore("BANDRA", stores)).toBe("s1");
    expect(guessStore("Kala Ghoda", stores)).toBe("s2");
    expect(guessStore("Accounts", stores)).toBe("");
  });
});
