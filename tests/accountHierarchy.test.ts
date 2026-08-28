import { describe, expect, it } from "vitest";
import { parseAccountHierarchy, platformName } from "../client/src/accountHierarchy";

describe("account hierarchy", () => {
  it("groups channels under one stable platform name", () => {
    expect(platformName("支付宝 · 基金")).toBe("支付宝");
    expect(platformName("支付宝 · 余额宝")).toBe("支付宝");
    expect(parseAccountHierarchy("中信银行 · 人民币账户")).toEqual({
      platformName: "中信银行",
      channelName: "人民币账户",
    });
  });

  it("keeps standalone accounts as their own platform", () => {
    expect(parseAccountHierarchy("Trading212")).toEqual({
      platformName: "Trading212",
      channelName: "主账户",
    });
  });
});
