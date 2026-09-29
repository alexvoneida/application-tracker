import { z } from "zod";
import type { JobFields } from "./model";

export const discoveryConfigSchema = z.object({
  enabled: z.boolean().default(false),
  notifications: z.boolean().default(true),
  pollMinutes: z.number().int().min(2).max(60).default(5),
  autoWatch: z.boolean().default(true),
  locations: z.string().max(1000).default(""),
  workArrangement: z
    .enum(["Any", "Remote", "Hybrid", "On-site"])
    .default("Any"),
  maxExperience: z.number().int().min(0).max(5).default(2),
  includeUnknownExperience: z.boolean().default(false),
  minSalary: z.number().min(0).max(10000000).default(0),
  currency: z.enum(["USD", "CAD", "EUR", "GBP", "AUD", "INR"]).default("USD"),
  includeUnknownSalary: z.boolean().default(true),
  keywords: z.string().max(1000).default(""),
  excludeKeywords: z.string().max(1000).default(""),
  excludeCompanies: z.string().max(1000).default(""),
});
export type DiscoveryConfig = z.infer<typeof discoveryConfigSchema>;
export const workerConfigSchema = z.object({
  version: z.literal(1),
  config: discoveryConfigSchema,
  githubEnabled: z.boolean().default(true),
  boards: z
    .array(
      z.object({
        url: z.string().max(4000),
        name: z.string().max(200).default(""),
        enabled: z.boolean().default(true),
      }),
    )
    .max(500)
    .default([]),
});
export type BoardKind = "github" | "greenhouse" | "lever" | "ashby";
export interface DiscoverySource {
  id: string;
  kind: BoardKind;
  slug: string;
  name: string;
  url: string;
  enabled: boolean;
  initialized: boolean;
  lastChecked: string;
  lastSuccess: string;
  nextCheck: string;
  failures: number;
  error: string;
  etag: string;
  count: number;
}
export interface DiscoveredJob extends JobFields {
  id: string;
  url: string;
  description: string;
  publishedAt: string;
  firstSeenAt: string;
  lastSeenAt: string;
  baseline: boolean;
  entryEvidence: string;
  requiredYears: number | null;
  annualSalaryMax: number | null;
  sources: Record<string, { present: boolean; lastSeen: string }>;
  closed: boolean;
  disposition: "new" | "saved" | "dismissed";
  seenAt: string;
  alertedAt: string;
  applicationId: string;
}
export type DiscoveryCandidate = Omit<
  DiscoveredJob,
  | "firstSeenAt"
  | "lastSeenAt"
  | "baseline"
  | "sources"
  | "closed"
  | "disposition"
  | "seenAt"
  | "alertedAt"
  | "applicationId"
>;
export interface DiscoveryState {
  config: DiscoveryConfig;
  sources: DiscoverySource[];
  running: boolean;
  jobs: (DiscoveredJob & { matches: boolean; matchReasons: string[] })[];
  total: number;
  matching: number;
  unread: number;
  notificationError: string;
}
