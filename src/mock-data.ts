// Mock "internal admin" data the agent's tools read from. In a real support
// platform these would be calls to account, zone and analytics services.

export type Account = {
  email: string;
  company: string;
  plan: "Free" | "Pro" | "Business" | "Enterprise";
  accountId: string;
  zones: string[];
  createdAt: string;
};

export type ZoneHealth = {
  zone: string;
  sslMode: "off" | "flexible" | "full" | "full_strict";
  edgeCertExpiresInDays: number;
  originCertValid: boolean;
  proxiedRecords: number;
  dnsOnlyRecords: number;
  errorRate5xxLastHour: number;
  topErrorCode: number | null;
  wafBlocksLastHour: number;
  topWafRule: string | null;
};

const accounts: Account[] = [
  {
    email: "ops@acme.dev",
    company: "Acme Dev Tools",
    plan: "Pro",
    accountId: "acc_7f21",
    zones: ["acme.dev", "status.acme.dev"],
    createdAt: "2023-03-14"
  },
  {
    email: "owner@pixelbakery.co",
    company: "Pixel Bakery",
    plan: "Free",
    accountId: "acc_19c4",
    zones: ["pixelbakery.co"],
    createdAt: "2025-11-02"
  },
  {
    email: "secops@northwind.io",
    company: "Northwind Logistics",
    plan: "Enterprise",
    accountId: "acc_0b88",
    zones: ["northwind.io", "api.northwind.io"],
    createdAt: "2021-06-30"
  }
];

const zones: Record<string, ZoneHealth> = {
  "acme.dev": {
    zone: "acme.dev",
    sslMode: "full_strict",
    edgeCertExpiresInDays: 64,
    originCertValid: false,
    proxiedRecords: 6,
    dnsOnlyRecords: 1,
    errorRate5xxLastHour: 0.31,
    topErrorCode: 526,
    wafBlocksLastHour: 12,
    topWafRule: null
  },
  "status.acme.dev": {
    zone: "status.acme.dev",
    sslMode: "full",
    edgeCertExpiresInDays: 64,
    originCertValid: true,
    proxiedRecords: 1,
    dnsOnlyRecords: 0,
    errorRate5xxLastHour: 0,
    topErrorCode: null,
    wafBlocksLastHour: 0,
    topWafRule: null
  },
  "pixelbakery.co": {
    zone: "pixelbakery.co",
    sslMode: "flexible",
    edgeCertExpiresInDays: 80,
    originCertValid: true,
    proxiedRecords: 3,
    dnsOnlyRecords: 0,
    errorRate5xxLastHour: 0.42,
    topErrorCode: 522,
    wafBlocksLastHour: 0,
    topWafRule: null
  },
  "northwind.io": {
    zone: "northwind.io",
    sslMode: "full_strict",
    edgeCertExpiresInDays: 12,
    originCertValid: true,
    proxiedRecords: 14,
    dnsOnlyRecords: 2,
    errorRate5xxLastHour: 0.01,
    topErrorCode: null,
    wafBlocksLastHour: 4810,
    topWafRule: "Managed rule 100015 (SQLi: union-based)"
  },
  "api.northwind.io": {
    zone: "api.northwind.io",
    sslMode: "full_strict",
    edgeCertExpiresInDays: 12,
    originCertValid: true,
    proxiedRecords: 3,
    dnsOnlyRecords: 0,
    errorRate5xxLastHour: 0.02,
    topErrorCode: null,
    wafBlocksLastHour: 2240,
    topWafRule: "Managed rule 100015 (SQLi: union-based)"
  }
};

export function findAccount(email: string): Account | undefined {
  return accounts.find((a) => a.email.toLowerCase() === email.toLowerCase());
}

export function findAccountByZone(zone: string): Account | undefined {
  return accounts.find((a) => a.zones.includes(zone.toLowerCase()));
}

export function getZoneHealth(zone: string): ZoneHealth | undefined {
  return zones[zone.toLowerCase()];
}

export const sampleCustomers = accounts.map((a) => a.email);
