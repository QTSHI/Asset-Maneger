import { describe, expect, it } from "vitest";
import { consolidateInstruments } from "../client/src/instrumentConsolidation";
import type { ValuedAsset } from "../client/src/types";

function asset(overrides: Partial<ValuedAsset>): ValuedAsset {
  return {
    id: 1, code: "LOCAL-1", name: "测试基金", shares: 1, costPrice: 1,
    currentPrice: 1, quantityStatus: "verified", valuationMode: "units",
    valuationBasis: "unit_price", currency: "CNY", marketValueCny: 100,
    costValueCny: 80, profitCny: 20, profitPercent: 25, accountId: 1,
    accountName: "支付宝 · 基金", assetTypeId: 1, assetType: "fund",
    classCode: "fund", classLabel: "基金", subtypeCode: "fund",
    subtypeLabel: "场外基金", quote: { status: "fresh" },
    dataQuality: { status: "ready", label: "完整", issues: [] },
    ...overrides,
  };
}

describe("instrument consolidation", () => {
  it("merges the same fund code across platforms", () => {
    const result = consolidateInstruments([
      asset({ id: 1, quoteCode: "000218", accountName: "支付宝 · 基金" }),
      asset({ id: 2, quoteCode: "000218", accountName: "微信 · 理财通", marketValueCny: 50, costValueCny: 40, profitCny: 10 }),
    ]);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      code: "000218", marketValueCny: 150, costValueCny: 120,
      profitCny: 30, profitPercent: 25,
      platformNames: ["支付宝", "微信"],
    });
    expect(result[0].assets).toHaveLength(2);
  });

  it("falls back to a normalized name when no quote code exists", () => {
    expect(consolidateInstruments([
      asset({ id: 1, name: "测试 基金", quoteCode: null }),
      asset({ id: 2, name: "测试基金", quoteCode: null }),
    ])).toHaveLength(1);
  });
});
