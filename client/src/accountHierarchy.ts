export interface AccountHierarchy {
  platformName: string;
  channelName: string;
}

export function parseAccountHierarchy(accountName: string): AccountHierarchy {
  const parts = String(accountName || "")
    .split("·")
    .map((part) => part.trim())
    .filter(Boolean);
  const platformName = parts[0] || "未命名平台";
  return {
    platformName,
    channelName: parts.length > 1 ? parts.slice(1).join(" · ") : "主账户",
  };
}

export function platformName(accountName: string) {
  return parseAccountHierarchy(accountName).platformName;
}
