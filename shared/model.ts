import { z } from "zod";

export const stages = [
  "Applied",
  "Assessment",
  "Interviewing",
  "Offer",
  "Accepted",
  "Rejected",
  "Withdrawn",
  "Closed",
  "Unknown",
] as const;
export type Stage = (typeof stages)[number];
export const eventTypes = [
  "application_submitted",
  "application_confirmed",
  "assessment_invited",
  "assessment_completed",
  "interview_invited",
  "interview_scheduled",
  "interview_completed",
  "interview_rescheduled",
  "interview_canceled",
  "offer_received",
  "offer_accepted",
  "offer_declined",
  "rejected",
  "withdrawn",
  "role_closed",
  "manual_status",
] as const;
export type EventType = (typeof eventTypes)[number];
export const dateSchema = z.string().refine((v) => {
  if (v === "") return true;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const date = new Date(v + "T12:00:00Z");
  return (
    Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === v
  );
}, "Use a valid YYYY-MM-DD date");
const short = z.string().max(1000);
export const jobSchema = z.object({
  company: short.default(""),
  title: short.default(""),
  postingId: short.default(""),
  location: short.default(""),
  workArrangement: z
    .enum(["Remote", "Hybrid", "On-site", "Unknown"])
    .default("Unknown"),
  salary: short.default(""),
  currency: z.string().max(20).default(""),
  salaryPeriod: short.default(""),
  employmentType: short.default(""),
  seniority: short.default(""),
  responsibilities: z.string().max(15000).default(""),
  requirements: z.string().max(15000).default(""),
  technologies: short.default(""),
});
export type JobFields = z.infer<typeof jobSchema>;
export const applicationInput = jobSchema.extend({
  url: z.string().max(4000).default(""),
  stage: z.enum(stages).default("Applied"),
  appliedAt: dateSchema.default(""),
  notes: z.string().max(30000).default(""),
  description: z.string().max(150000).default(""),
  reapply: z.boolean().default(false),
});
export type Application = JobFields & {
  id: string;
  url: string;
  canonicalUrl: string;
  stage: Stage;
  appliedAt: string;
  dateBasis: "user" | "file default" | "confirmation estimate" | "unknown";
  notes: string;
  createdAt: string;
  updatedAt: string;
  lastActivity: string;
  statusAt: string;
  manualStatusAt: string;
  lockedFields: string[];
  enrichment: "pending" | "ready" | "failed" | "manual";
  enrichmentError: string;
};
export type Event = {
  id: string;
  applicationId: string;
  type: EventType;
  stage: Stage;
  occurredAt: string;
  timeBasis: string;
  createdAt: string;
  sourceId: string;
  label: string;
  confidence: number;
  matchConfidence: number;
};
export type Snapshot = {
  id: string;
  applicationId: string;
  text: string;
  url: string;
  capturedAt: string;
  fields: Partial<JobFields>;
  sourceKind?: "pasted" | "page";
};
export type Action = {
  id: string;
  applicationId: string;
  sourceId: string;
  kind: "assessment" | "interview";
  title: string;
  dueAt: string;
  timeZone: string;
  status: "pending" | "completed" | "dismissed";
  createdAt: string;
};
export const emailSchema = z.object({
  relevant: z.boolean(),
  company: short,
  title: short,
  postingId: short,
  url: z.string().max(4000),
  eventType: z.enum(eventTypes).nullable(),
  confidence: z.number().min(0).max(1),
  occurredAt: z.string().max(80),
  dueAt: z.string().max(100),
  timeZone: z.string().max(100),
  explanation: z.string().max(2000),
  multipleRoles: z.boolean(),
});
export type EmailExtraction = z.infer<typeof emailSchema>;
export type Source = {
  id: string;
  account: string;
  messageId: string;
  threadId: string;
  subject: string;
  from: string;
  excerpt: string;
  receivedAt: string;
  extraction: EmailExtraction;
  method: "rules" | "ai";
  state: "review" | "attached" | "dismissed" | "failed";
  reason: string;
  applicationId: string;
  candidates: string[];
  matchConfidence: number;
};
export type ImportRecord = {
  id: string;
  applicationId: string;
  suppressed: boolean;
  firstSeen: string;
  line: number;
};
export type AiProvider = "openai" | "claude-code";
export type Settings = {
  linksFile: string;
  importAfter: string;
  gmailQuery: string;
  syncMinutes: number;
  aiEnabled: boolean;
  aiProvider: AiProvider;
  aiModel: string;
  aiBaseUrl: string;
  claudeCodePath: string;
  autoApplyAI: boolean;
};
export type SyncState = {
  running: boolean;
  processed: number;
  discovered: number;
  lastSuccess: string;
  error: string;
  fileErrors: string[];
  fileLastScan: string;
};
export type BackfillState = {
  running: boolean;
  processed: number;
  total: number;
  failed: number;
  error: string;
};
export const stageForEvent: Record<EventType, Stage> = {
  application_submitted: "Applied",
  application_confirmed: "Applied",
  assessment_invited: "Assessment",
  assessment_completed: "Assessment",
  interview_invited: "Interviewing",
  interview_scheduled: "Interviewing",
  interview_completed: "Interviewing",
  interview_rescheduled: "Interviewing",
  interview_canceled: "Interviewing",
  offer_received: "Offer",
  offer_accepted: "Accepted",
  offer_declined: "Withdrawn",
  rejected: "Rejected",
  withdrawn: "Withdrawn",
  role_closed: "Closed",
  manual_status: "Unknown",
};
export const terminal = new Set<Stage>([
  "Accepted",
  "Rejected",
  "Withdrawn",
  "Closed",
]);
export const stageRank: Record<Stage, number> = {
  Unknown: 0,
  Applied: 1,
  Assessment: 2,
  Interviewing: 3,
  Offer: 4,
  Accepted: 5,
  Rejected: 5,
  Withdrawn: 5,
  Closed: 5,
};
export function localDate(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
export const eventLabel = (type: string) => type.replaceAll("_", " ");
