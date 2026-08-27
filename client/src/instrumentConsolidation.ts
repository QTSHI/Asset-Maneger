import type { ValuedAsset } from "./types";
import { platformName } from "./accountHierarchy";

export interface ConsolidatedInstrument {
  key: string;
  name: string;
  code: string;
  assets: ValuedAsset[];
  platformNames: string[];
  marketValueCny: number;
  costValueCny: number;
  profitCny: number;
  profitPercent: number;
}

function normalizedInstrumentName(name: string) {
  return name.trim().toLocaleLowerCase("zh-CN").replace(/[\s·•]+/g, "");
}

export function instrumentIdentity(asset: ValuedAsset) {
  const quoteCode = asset.quoteCode?.trim().toUpperCase();
  return quoteCode ? `quote:${quoteCode}` : `name:${normalizedInstrumentName(asset.name)}`;
}

export function consolidateInstruments(assets: ValuedAsset[]): ConsolidatedInstrument[] {
  const groups = new Map<string, ConsolidatedInstrument>();
  for (const asset of assets) {
    const key = instrumentIdentity(asset);
    const existing = groups.get(key) || {
      key,
      name: asset.name,
      code: asset.quoteCode || asset.code,
      assets: [],
      platformNames: [],
      marketValueCny: 0,
      costValueCny: 0,
      profitCny: 0,
      profitPercent: 0,
    };
    existing.assets.push(asset);
    existing.marketValueCny += asset.marketValueCny;
    existing.costValueCny += asset.costValueCny;
    existing.profitCny += asset.profitCny;
    existing.platformNames = [
      ...new Set([...existing.platformNames, platformName(asset.accountName)]),
    ];
    existing.profitPercent = existing.costValueCny
      ? (existing.profitCny / existing.costValueCny) * 100
      : 0;
    groups.set(key, existing);
  }
  return [...groups.values()].sort((a, b) => b.marketValueCny - a.marketValueCny);
}
