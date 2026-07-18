import { parseAdminEmails } from "./router.js";

describe("parseAdminEmails", () => {
  it("returns an empty set when unset", () => {
    expect(parseAdminEmails(undefined)).toEqual(new Set());
  });

  it("lowercases, trims, and drops empty entries", () => {
    expect(parseAdminEmails("A@X.com, b@y.com ,,")).toEqual(
      new Set(["a@x.com", "b@y.com"]),
    );
  });

  it("returns an empty set for a whitespace-only value", () => {
    expect(parseAdminEmails("   ")).toEqual(new Set());
  });
});
