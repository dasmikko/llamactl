import { describe, test, expect } from "bun:test";
import { VERSION } from "../src/version.ts";
import { version as pkgVersion } from "../package.json";

describe("VERSION", () => {
  test("matches package.json version", () => {
    expect(VERSION).toBe(pkgVersion);
  });

  test("matches semver format (major.minor.patch)", () => {
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
